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

function textChunks(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  stream.setEncoding("utf8");
  return stream as unknown as AsyncIterable<string>;
}

// Real child via node:child_process (Node ≥18-safe; no Bun-only APIs — packages/sdk ships to
// consumers running plain Node, WS-02 global constraints).
export function defaultSpawn(opts: SpawnRuntimeOptions): SpawnedRuntimeProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

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
