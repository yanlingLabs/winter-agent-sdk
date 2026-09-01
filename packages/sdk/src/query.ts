import { randomUUID } from "node:crypto";
import type { SdkMessage as RuntimeSdkMessage, WinterFrame, InitFrame } from "./protocol/frames.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import { splitFrames, encodeFrame, ProtocolError } from "./protocol/codec.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import type { Options } from "./options.ts";
import { resolveRuntimeExecutable, defaultSpawn, type SpawnRuntimeOptions, type SpawnedRuntimeProcess } from "./transport.ts";
import { ResultError, CLIConnectionError, ProtocolDecodeError, ProcessError, AbortError } from "./errors.ts";

// The runtime's SdkMessage is deliberately open (a trailing `{ type: string; [k: string]: unknown }`
// catch-all for lossless pass-through of unknown message kinds, Task 5). The SDK's public surface
// must be a CLOSED union — like the official SDK's message union (WS-03 §8) — so that consumers can
// discriminate-narrow on `msg.type` and access variant-specific fields (e.g. `assistant`'s `.message`)
// without the catch-all collapsing the narrowed type to `unknown`. Extract drops it: the catch-all's
// `type: string` isn't assignable to any of the three literal targets below.
export type SdkMessage = Extract<RuntimeSdkMessage, { type: "system" } | { type: "assistant" } | { type: "result" }>;

export interface Query extends AsyncGenerator<SdkMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
}

// Provisional pending packages/conformance/compat/anthropic/0.3.250/defaults.json: that file does
// not exist yet in the snapshot (only exports.json/declaration-digests.json/checksums.json do), so
// there is no pinned maxBufferSize default to read. Chosen generous default; revisit once the
// snapshot carries one (WS-02 §2/§6).
const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;
// Internal-only, no public knob (Task 2 scope): grace window between the wrapper's own SIGTERM-ish
// kill() and its SIGKILL-ish escalation on abort (WS-04 §6). Kept short for a responsive wrapper
// and a fast test suite; a pinned/configurable value is future work.
const KILL_GRACE_MS = 50;

export function query(args: { prompt: string | AsyncIterable<string>; options: Options }): Query {
  const { prompt, options } = args;

  const config: RuntimeConfig = {
    sessionId: randomUUID(),
    cwd: options.cwd ?? process.cwd(),
    model: options.model ?? "sonnet",
    permissionMode: options.permissionMode ?? "default",
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  };

  // A custom spawnClaudeCodeProcess hook owns process creation entirely (containers, VMs, remote
  // runtimes, a supervising daemon — WS-04 §8): resolving a LOCAL platform binary would be wrong
  // (and often impossible) in those cases, so executable resolution — including its typed throw
  // when nothing is configured — only runs on the defaultSpawn path.
  const command = options.spawnClaudeCodeProcess
    ? (options.pathToClaudeCodeExecutable ?? "winter")
    : resolveRuntimeExecutable(options);
  const spawnOptions: SpawnRuntimeOptions = {
    command,
    args: ["--run", "--config-json", JSON.stringify(config)],
    cwd: config.cwd,
    env: options.env ?? {}, // REPLACES the child env (WS-03 §5) — never spread with process.env here
    ...(options.abortController ? { signal: options.abortController.signal } : {}),
  };
  const proc: SpawnedRuntimeProcess = (options.spawnClaudeCodeProcess ?? defaultSpawn)(spawnOptions);
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

  // Stderr is diagnostics only, never frames (WS-04 §6) — forwarded eagerly, independent of
  // whether/when the consumer iterates the returned Query.
  if (proc.stderr) {
    const stderrIterable = proc.stderr;
    (async () => {
      try {
        for await (const chunk of stderrIterable) options.stderr?.(chunk);
      } catch {
        /* diagnostics only; never fail the query over a stderr read error */
      }
    })();
  }

  async function* iterate(): AsyncGenerator<SdkMessage> {
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      proc.kill();
      killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    options.abortController?.signal.addEventListener("abort", onAbort);

    try {
      if (options.abortController?.signal.aborted) onAbort();

      // P0: single-shot prompt. Streaming input (AsyncIterable) is Task 3 — the wrapper's
      // `prompt: AsyncIterable<string>` sending one `user` envelope per item + `end_input` is
      // explicitly the plan's Task 3 replacement for this firstOf stub.
      const text = typeof prompt === "string" ? prompt : await firstOf(prompt);
      proc.stdin.write(encodeFrame({ type: "user", text }));
      proc.stdin.end();

      let sawInit = false;
      let sawTerminal = false;
      let terminalError: Extract<SdkMessage, { type: "result" }> | null = null;
      let carry = "";
      const it = proc.stdout[Symbol.asyncIterator]();

      readLoop: while (true) {
        const nextP = it.next();
        nextP.catch(() => {}); // avoid an unhandled rejection if the "exited" race branch wins first

        let outcome: { kind: "chunk"; r: IteratorResult<string> } | { kind: "exited"; info: { code: number | null; signal: string | null } };
        if (aborted) {
          outcome = await Promise.race([
            nextP.then((r) => ({ kind: "chunk" as const, r })),
            proc.exited.then((info) => ({ kind: "exited" as const, info })),
          ]);
        } else {
          outcome = { kind: "chunk", r: await nextP };
        }
        if (outcome.kind === "exited") break readLoop;
        if (outcome.r.done) break readLoop;

        let frames: WinterFrame[];
        try {
          const split = splitFrames(outcome.r.value, carry);
          frames = split.frames;
          carry = split.carry;
        } catch (e) {
          throw new ProtocolDecodeError(e instanceof ProtocolError ? e.message : String(e));
        }
        // Bounds the unterminated (no-newline-yet) buffer — the hang vector for a line that never
        // completes or a single already-huge line (WS-04 §2's maxBufferSize option).
        if (carry.length > maxBufferSize) {
          throw new ProtocolDecodeError(`protocol line exceeds maxBufferSize (${maxBufferSize} bytes)`);
        }

        for (const frame of frames) {
          if (!sawInit) {
            if (frame.type !== "init") {
              throw new ProtocolDecodeError(`protocol violation: expected 'init' as the first frame, got '${frame.type}'`);
            }
            const init = frame as InitFrame;
            const runtimeMajor = init.protocolVersion.split(".")[0];
            const sdkMajor = PROTOCOL_VERSION.split(".")[0];
            if (runtimeMajor !== sdkMajor) {
              throw new CLIConnectionError(
                `protocol version mismatch: runtime speaks ${init.protocolVersion}, sdk expects ${PROTOCOL_VERSION}`,
              );
            }
            sawInit = true;
            continue; // internal handshake; the SDK system/init arrives as a data frame
          }
          if (frame.type !== "data") continue; // other control frames handled in later phases
          const message = (frame as { message: SdkMessage }).message;
          yield message; // yield EVERY message, including the terminal result…
          if (message.type === "result") {
            sawTerminal = true;
            if ((message as { is_error?: boolean }).is_error) terminalError = message as Extract<SdkMessage, { type: "result" }>;
            break readLoop;
          }
        }
      }

      // WS-04 §6.1: each row below is one code path.
      if (aborted) throw new AbortError("query aborted: runtime process killed");
      if (!sawInit) throw new CLIConnectionError("runtime exited before init");
      if (terminalError) throw new ResultError(terminalError); // …then throw (error-result-then-throw, report §9)
      if (!sawTerminal) {
        const exitInfo = await proc.exited;
        throw new ProcessError("unexpected process death: runtime exited without a terminal result", exitInfo.code, exitInfo.signal);
      }
    } finally {
      options.abortController?.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  const gen = iterate() as Query;
  gen.interrupt = async () => {
    proc.stdin.end();
  }; // honest P0 stub; real interrupt/drain is Task 3/4
  gen.setModel = async () => {};
  gen.setPermissionMode = async () => {};
  return gen;
}

async function firstOf(it: AsyncIterable<string>): Promise<string> {
  for await (const v of it) return v;
  return "";
}
