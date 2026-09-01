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
    // Options.env semantics (WS-03 §5, controller Ruling P1-D): an EXPLICITLY supplied env
    // REPLACES the child environment entirely (consumers spread ...process.env themselves if they
    // want to extend it); an OMITTED env means the child INHERITS the wrapper's own process.env —
    // never a silently empty environment (the prior `?? {}` produced exactly that bug).
    env: options.env ?? (process.env as Record<string, string>),
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

      // Task 3: a string prompt sends one `user` frame then `end_input`; an AsyncIterable<string>
      // prompt sends each item as a `user` frame AS IT ARRIVES — not waiting for that turn's
      // result first, true streaming input (WS-04 §3: "stream stays open; end-of-input is
      // explicit") — then `end_input` once the iterable itself completes. Runs concurrently with
      // the read loop below (not awaited before it): sequencing it first would serialize "send one
      // prompt, read its whole response" instead of allowing overlap, defeating streaming input.
      // Replaces the P0 `firstOf` stub, which sent only the iterable's first item and silently
      // discarded the rest.
      //
      // Policy for a throwing iterable / a write after the child has already exited: swallow here,
      // matching the stderr-forwarding task above — this detached task cannot itself correct
      // anything in the read loop, and the ONE place a real failure must surface is the stdout-side
      // WS-04 §6.1 lifecycle mapping (unexpected death / nonzero exit), not a second, competing
      // rejection from this side.
      (async () => {
        try {
          if (typeof prompt === "string") {
            proc.stdin.write(encodeFrame({ type: "user", text: prompt }));
          } else {
            for await (const text of prompt) {
              proc.stdin.write(encodeFrame({ type: "user", text }));
            }
          }
          proc.stdin.write(encodeFrame({ type: "control_request", requestId: randomUUID(), subtype: "end_input", payload: undefined }));
          proc.stdin.end();
        } catch {
          /* see policy note above */
        }
      })();

      let sawInit = false;
      let sawTerminal = false;
      let terminalError: Extract<SdkMessage, { type: "result" }> | null = null;
      let carry = "";

      // Controller Ruling P1-I (Task 4 fix round 1): termination is MODE-AWARE. A single-shot
      // string prompt is exactly one turn — stopping at its one terminal result is correct and
      // UNCHANGED below. A streaming-input (AsyncIterable) prompt can carry MULTIPLE user
      // envelopes, each producing its own terminal result (WS-04 §4.1: idle -> turn_active ->
      // idle, once per envelope) — unconditionally breaking at the FIRST result silently dropped
      // every subsequent turn's frames (confirmed empirically: a real two-turn streaming session
      // through this function yielded only turn 1, with no error, before this fix). In streaming
      // mode the loop instead runs to the transport's own natural end (stdout EOF, which the
      // runtime produces only after `end_input` and its last in-flight turn's result — WS-04 §6),
      // yielding EVERY result along the way.
      const isStreamingInput = typeof prompt !== "string";

      // A plain, unraced drain (review Finding 5): racing `stdout` against an independently
      // resolving `exited` structurally favors `exited` (an already-settled promise's `.then`
      // enqueues before a fresh async-generator resumption), which can cut off frames that are
      // ALREADY available to read — silently losing a backlog on abort. WS-04 §1.1 makes this
      // loop's simplicity safe: a compliant transport (real child or in-memory) MUST end its
      // stdout by the time `exited` resolves, so trusting stdout to end on its own — never bailing
      // out early via a side-channel race — is both simpler and correct. `aborted` still decides
      // WHICH lifecycle error applies once the loop ends; it no longer decides WHEN it ends.
      readLoop: for await (const chunk of proc.stdout) {
        let frames: WinterFrame[];
        try {
          const split = splitFrames(chunk, carry);
          frames = split.frames;
          carry = split.carry;
        } catch (e) {
          throw new ProtocolDecodeError(e instanceof ProtocolError ? e.message : String(e));
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
          yield message; // yield EVERY message, including every terminal result…
          if (message.type === "result") {
            sawTerminal = true;
            // An is_error result still ultimately drives error-result-then-throw below (report
            // §9) — in streaming mode that throw is deferred until the transport's natural EOF
            // (never mid-stream), so it can never silently cut off a later, still-pending turn's
            // frames the way an immediate break would. Overwritten on each error result seen, so
            // with multiple erroring turns the LAST one is what's thrown — a defensible, documented
            // choice where the spec is silent on which of several errors should win.
            if ((message as { is_error?: boolean }).is_error) terminalError = message as Extract<SdkMessage, { type: "result" }>;
            if (!isStreamingInput) break readLoop; // single-shot prompt: exactly one turn, unchanged
          }
        }

        // Bounds the unterminated (no-newline-yet) buffer — the hang vector for a line that never
        // completes or a single already-huge line (WS-04 §2's maxBufferSize option). Checked AFTER
        // yielding this chunk's already-decoded complete frames (review Finding 2): a chunk can
        // legitimately carry complete frames followed by an oversized unterminated tail, and those
        // complete frames must still be delivered before the wrapper surfaces the error.
        if (carry.length > maxBufferSize) {
          throw new ProtocolDecodeError(`protocol line exceeds maxBufferSize (${maxBufferSize} bytes)`);
        }
      }

      // WS-04 §6.1: each row below is one code path. A seen terminal result (success or error)
      // takes priority over `aborted` (review Finding 6) — a turn that genuinely completed must
      // complete cleanly (or via ResultError) even if a cancellation happened to land in the same
      // tick; only the ABSENCE of a terminal result falls through to the abort/death distinction.
      if (terminalError) throw new ResultError(terminalError); // …then throw (error-result-then-throw, report §9)
      if (sawTerminal) return;
      if (aborted) throw new AbortError("query aborted: runtime process killed");
      if (!sawInit) throw new CLIConnectionError("runtime exited before init");
      const exitInfo = await proc.exited;
      throw new ProcessError("unexpected process death: runtime exited without a terminal result", exitInfo.code, exitInfo.signal);
    } finally {
      options.abortController?.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  const gen = iterate() as Query;
  gen.interrupt = async () => {
    proc.stdin.end();
  }; // honest P0 stub still: Task 3 implements interrupt's state machine at the engine level
  // (control_request{subtype:"interrupt"} → ack → abort the in-flight round → provisional
  // interrupted result — see engine.test.ts) and tests it by driving frames directly. Wiring
  // Query.interrupt() itself to send that control frame needs request/response correlation this
  // wrapper doesn't have yet (setModel/setPermissionMode below are the same kind of stub, for the
  // same reason) — left for whichever later task builds that plumbing for the other control RPCs.
  gen.setModel = async () => {};
  gen.setPermissionMode = async () => {};
  return gen;
}
