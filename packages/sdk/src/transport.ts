import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { WinterSDKError } from "./errors.ts";

// The pinned process seam (WS-04 §8, WS-03 §5): byte-level, shape-compatible with the pinned
// spawnClaudeCodeProcess hook. Both the real child transport (defaultSpawn, below) and the
// in-memory test transport (winter-agent-runtime/testing's inMemoryProcess) implement this same
// interface, so the wrapper (query.ts) never branches on topology (WS-04 §1).
//
// Exact upstream member names are verified against the declaration snapshot during implementation
// per the brief; packages/conformance/compat/anthropic/0.3.250/exports.json names the pinned
// return-value interface `SpawnedProcess` (and the options interface `SpawnOptions`), not
// `SpawnedRuntimeProcess`/`SpawnRuntimeOptions`. Per controller ruling, the brief's shape is the
// contract for this task — kept as spelled below rather than silently renamed; the mismatch is
// recorded as an Open question in the Task 2 report (exports.json is names-only, no field lists,
// so the exact upstream member names inside the interface remain unverified either way).
export interface SpawnedRuntimeProcess {
  stdin: { write(chunk: string): void; end(): void };
  stdout: AsyncIterable<string>; // text chunks; framing (NDJSON split/decode) is the wrapper's job
  stderr?: AsyncIterable<string>;
  kill(signal?: string): void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly pid: number | null; // null for virtual handles (WS-04 §1.1)
}

export interface SpawnRuntimeOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export type SpawnClaudeCodeProcess = (opts: SpawnRuntimeOptions) => SpawnedRuntimeProcess;

// The one platform package this arc ships (WS-02 §4); additional platform packages arrive with
// later packaging work, at which point this lookup grows a process.platform/arch switch.
const PLATFORM_PACKAGE = "@yanlinglabs/winter-agent-sdk-darwin-arm64";

// Resolution order (WS-02 §4): explicit option → platform package's `bin` field → typed throw.
// Never require.resolve from inside a compiled $bunfs — this function only ever runs in the
// wrapper, which is never compiled (WS-02 §3).
export function resolveRuntimeExecutable(opts: { pathToClaudeCodeExecutable?: string }): string {
  if (opts.pathToClaudeCodeExecutable) return opts.pathToClaudeCodeExecutable;

  const require = createRequire(import.meta.url);
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${PLATFORM_PACKAGE}/package.json`);
  } catch (err) {
    throw new WinterSDKError(
      `runtime executable not found — no pathToClaudeCodeExecutable configured and the platform package ${PLATFORM_PACKAGE} is not installed for this platform (${(err as Error).message})`,
    );
  }
  const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
  const binField = pkg.bin;
  const relativeBin = typeof binField === "string" ? binField : binField?.winter;
  if (!relativeBin) {
    throw new WinterSDKError(
      `runtime executable not found — platform package ${PLATFORM_PACKAGE} has no "bin" entry configured yet`,
    );
  }
  return join(dirname(pkgJsonPath), relativeBin);
}

// Wraps a raw Node stream's own async iteration in a try/catch: when the underlying process never
// truly spawned (or died abruptly), consuming its stdio streams can itself throw a raw stream error
// (observed: ERR_STREAM_PREMATURE_CLOSE) — that is NOT a protocol/lifecycle condition, it's just
// "no more data" from the wrapper's perspective. Swallowing it here means query.ts's own EOF-based
// WS-04 §6.1 mapping is what surfaces a typed error, never an unwrapped raw stream exception
// (review Finding 1; message-level/other raw-stream-error nuances stay tracked for Task 4, Finding 8).
function textChunks(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  stream.setEncoding("utf8");
  return (async function* () {
    try {
      for await (const chunk of stream as AsyncIterable<string>) yield chunk;
    } catch {
      return;
    }
  })();
}

// Real child via node:child_process (Node ≥18-safe; no Bun-only APIs — packages/sdk ships to
// consumers running plain Node, WS-02 global constraints).
export function defaultSpawn(opts: SpawnRuntimeOptions): SpawnedRuntimeProcess {
  // opts.signal is intentionally NOT forwarded to node's spawn(): Node/Bun's own signal-triggered
  // kill also emits an "error" event on the child (observed under abort: AbortError from
  // abortChildProcess) — with no listener that is an uncaught exception (review Finding 1a). The
  // wrapper (query.ts) already implements its own explicit SIGTERM→SIGKILL escalation via kill(),
  // so Node's built-in abort-kill path is redundant here and is the crash trigger being removed. A
  // custom spawnClaudeCodeProcess hook still receives the field and may choose to honor it itself.
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let exitedSettled = false;
  let resolveExited!: (v: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExited = resolve;
  });
  child.on("close", (code, signal) => {
    if (exitedSettled) return;
    exitedSettled = true;
    resolveExited({ code, signal });
  });
  // A ChildProcess's "error" event (spawn failure — bad executable, ENOENT/EACCES — or any other
  // spawn/kill/IPC-level failure) has NO default handling: an unlistened "error" event is Node's
  // one EventEmitter special case that throws, crashing the host (review Finding 1b). This listener
  // is the fix; it routes the failure into the existing lifecycle seam rather than rethrowing —
  // settle `exited` (idempotently: "close" may or may not additionally fire per Node's own docs)
  // with a synthetic, clearly-non-clean pair so query.ts's exit-before-init / unexpected-death
  // mapping (WS-04 §6.1) produces the typed error once its stdio streams end (see textChunks above).
  child.on("error", () => {
    if (!exitedSettled) {
      exitedSettled = true;
      resolveExited({ code: null, signal: null });
    }
  });

  // CI fix round (ubuntu-only crash, run 33523165941): `child.stdin`/`child.stdout`/`child.stderr`
  // are each a SEPARATE EventEmitter from `child` itself — listening on `child`'s own "error"
  // above (Finding 1b) does NOT cover any of these. Confirmed root cause: the Finding-7
  // abort-before-query() test kills a still-transpiling `bun main.ts` dev child, then immediately
  // writes+ends its stdin (query.ts's prompt-send IIFE, unconditional and concurrent with the read
  // loop) — a write/end against a pipe whose read side is already gone raises EPIPE on the
  // writable's flush/destroy, asynchronously, with no listener: Node's one EventEmitter special
  // case (an unlistened "error" throws) crashes the host. Same class as Finding 1b, one emitter
  // over. The pipe-write/EPIPE timing itself is linux-specific and does NOT reproduce locally on
  // macOS even via a deterministic (non-racing) construction of the dead-pipe state — see
  // transport.test.ts's repro test and the task report's RED-honesty section; the CI log is the
  // only cross-platform confirmation this bug is real, so this listener's correctness rests on
  // the documented EventEmitter mechanism (an unlistened "error" always throws), not on a local
  // repro proving the crash and then proving it gone.
  //
  // stdout/stderr get the identical treatment after auditing the SAME class of gap on the read
  // side: textChunks' `for await` only attaches Node's internal stream listeners once the
  // WRAPPING async generator is first iterated (`.next()`), which happens whenever query.ts's
  // consumer starts reading — NOT synchronously when defaultSpawn returns. Between those two
  // moments, `child.stdout`/`child.stderr` have ZERO "error" listeners (confirmed empirically:
  // `listenerCount("error")` reads 0 immediately after spawn, and forcing an "error" event on the
  // raw stream in that window reproduces the identical uncaught-exception crash). A permanent,
  // do-nothing listener here closes that window for the streams' entire lifetime without
  // interfering with textChunks' own handling once iteration is under way — EventEmitter supports
  // multiple listeners per event, so the stream's later internal listener (once `for await` starts)
  // still funnels errors into that try/catch exactly as before; this one only ever matters for the
  // otherwise-uncovered pre-iteration gap. query.ts's EOF-based WS-04 §6.1 mapping remains the ONLY
  // place a lifecycle error is surfaced to a consumer — a raw stream error must never escape.
  child.stdin!.on("error", () => {});
  child.stdout!.on("error", () => {});
  child.stderr!.on("error", () => {});

  return {
    stdin: {
      write: (chunk: string) => {
        child.stdin!.write(chunk, "utf8");
      },
      end: () => {
        child.stdin!.end();
      },
    },
    stdout: textChunks(child.stdout!),
    stderr: textChunks(child.stderr!),
    kill: (signal?: string) => {
      child.kill(signal as NodeJS.Signals | undefined);
    },
    exited,
    get pid() {
      return child.pid ?? null;
    },
  };
}
