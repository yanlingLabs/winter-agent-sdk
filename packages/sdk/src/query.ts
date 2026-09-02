import { randomUUID } from "node:crypto";
import type { SdkMessage as RuntimeSdkMessage, WinterFrame, InitFrame, ControlRequestFrame, ControlResponseFrame } from "./protocol/frames.ts";
import { PROTOCOL_VERSION } from "./protocol/frames.ts";
import { splitFrames, encodeFrame, ProtocolError } from "./protocol/codec.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import type { Options } from "./options.ts";
import { resolveRuntimeExecutable, defaultSpawn, type SpawnRuntimeOptions, type SpawnedRuntimeProcess } from "./transport.ts";
import { ResultError, CLIConnectionError, ProtocolDecodeError, ProcessError, AbortError, WinterRpcError } from "./errors.ts";

// The runtime's SdkMessage is deliberately open (a trailing `{ type: string; [k: string]: unknown }`
// catch-all for lossless pass-through of unknown message kinds, Task 5). The SDK's public surface
// must be a CLOSED union — like the official SDK's message union (WS-03 §8) — so that consumers can
// discriminate-narrow on `msg.type` and access variant-specific fields (e.g. `assistant`'s `.message`)
// without the catch-all collapsing the narrowed type to `unknown`. Extract drops it: the catch-all's
// `type: string` isn't assignable to any of the three literal targets below.
export type SdkMessage = Extract<RuntimeSdkMessage, { type: "system" } | { type: "assistant" } | { type: "result" }>;

// Task 2 (WS-04 §3.1): a runtime-originated control_request's handler either answers ok:true with
// an optional payload, or ok:false with a structured error — the SAME shape a control_response
// frame carries (frames.ts), kept as its own type here so query.ts's registry doesn't require
// callers to build a whole WinterFrame just to answer one.
export type ControlRequestHandlerResult = { ok: true; payload?: unknown } | { ok: false; error: { code: string; message: string } };
export type ControlRequestHandler = (payload: unknown) => Promise<ControlRequestHandlerResult>;

// Winter-only extension beyond the WS-03 §4 pinned Query surface — never part of the upstream
// drop-in contract (Level 1 compat is measured against interrupt/setPermissionMode/setModel/etc.,
// not this). Task 8 adds `respondPermission` here for the canUseTool `null` escape; Task 2 ships
// the registry this task's own tests exercise directly (permission/hook handlers register through
// query.ts's own production code in Tasks 8/10, not through this method — this is the seam a test
// double, or a not-yet-built subtype, uses to reach the same registry).
export interface QueryInternal {
  registerControlRequestHandler(subtype: string, handler: ControlRequestHandler): void;
}

export interface Query extends AsyncGenerator<SdkMessage> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  // Optional (not every hand-built Query-shaped test double needs to carry it) — query() itself
  // always sets it.
  __internal?: QueryInternal;
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
    // Task 9: a caller-supplied sessionId wins over the default auto-generated uuid — this is what
    // lets a pre-allocated id round-trip into the init frame and the transcript filename (WS-05
    // §7). Resume/continue targets are a SEPARATE concept (config.resume/config.continue below):
    // this field is always "what this RUN's own session id is," which the runtime overrides to the
    // resolved target when continue/resume actually resolves one (dialect.ts's resolveEngineSession).
    sessionId: options.sessionId ?? randomUUID(),
    cwd: options.cwd ?? process.cwd(),
    model: options.model ?? "sonnet",
    permissionMode: options.permissionMode ?? "default",
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.resume !== undefined ? { resume: options.resume } : {}),
    ...(options.continue !== undefined ? { continue: options.continue } : {}),
    ...(options.forkSession !== undefined ? { forkSession: options.forkSession } : {}),
    ...(options.resumeSessionAt !== undefined ? { resumeSessionAt: options.resumeSessionAt } : {}),
    ...(options.resumeDropsTurn !== undefined ? { resumeDropsTurn: options.resumeDropsTurn } : {}),
    ...(options.persistSession !== undefined ? { persistSession: options.persistSession } : {}),
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

  // Task 2 (WS-04 §3.1, direction inversion): HOST-originated control requests (interrupt,
  // setPermissionMode today; setModel/taskStop/mcp_*/rewindFiles in later tasks) awaiting the
  // runtime's ack, correlated by requestId. This is the wrapper's OWN, separate mirror of
  // packages/runtime/src/rpc/bridge.ts's createRpcBridge (same shape, opposite direction) — never
  // imported from the runtime package (WS-02 §3: the sdk never imports the runtime), even though
  // the correlation idea is identical. No timeout support here: nothing in this task's scope needs
  // one (interrupt/setPermissionMode both just await their ack).
  const pendingHostRequests = new Map<string, { resolve(payload: unknown): void; reject(err: unknown): void }>();
  function sendControlRequest(subtype: string, payload: unknown): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      pendingHostRequests.set(requestId, { resolve, reject });
      proc.stdin.write(encodeFrame({ type: "control_request", requestId, subtype, payload }));
    });
  }

  // RUNTIME-originated control requests (permission/hook RPCs in Tasks 8/10; this task ships only
  // the registry + the fallback below) dispatch to a handler registered by subtype. An
  // unrecognized subtype — including every subtype at T2, since nothing registers one in
  // production yet — is auto-answered ok:false so the runtime never parks forever waiting on a
  // host that doesn't understand it (WS-04 §3.1).
  const controlRequestHandlers = new Map<string, ControlRequestHandler>();
  async function handleIncomingControlRequest(cf: ControlRequestFrame): Promise<void> {
    // The whole body is wrapped, not just the handler invocation: every proc.stdin.write below
    // (including the no-handler-registered answer) can throw on a real child whose stdin has
    // already closed (e.g. the process exited while this handler — possibly a slow permission
    // prompt, Tasks 8/10 — was still running). Same swallow policy as the sender IIFE above ("a
    // write after the child has already exited: swallow here... the ONE place a real failure must
    // surface is the stdout-side WS-04 §6.1 lifecycle mapping, not a second, competing rejection
    // from this side") — this function is invoked fire-and-forget (`void handleIncomingControlRequest(...)`
    // in the read loop below), so an uncaught throw here would be an unhandled rejection.
    try {
      const handler = controlRequestHandlers.get(cf.subtype);
      if (!handler) {
        proc.stdin.write(
          encodeFrame({
            type: "control_response",
            requestId: cf.requestId,
            ok: false,
            error: { code: "unhandled_subtype", message: `no handler registered for control subtype '${cf.subtype}'` },
          }),
        );
        return;
      }
      try {
        const result = await handler(cf.payload);
        if (result.ok) {
          proc.stdin.write(
            encodeFrame({
              type: "control_response",
              requestId: cf.requestId,
              ok: true,
              ...(result.payload !== undefined ? { payload: result.payload } : {}),
            }),
          );
        } else {
          proc.stdin.write(encodeFrame({ type: "control_response", requestId: cf.requestId, ok: false, error: result.error }));
        }
      } catch (err) {
        // A throwing handler fails closed — ok:false, never a dropped request or a wrapper crash.
        const message = err instanceof Error ? err.message : String(err);
        proc.stdin.write(encodeFrame({ type: "control_response", requestId: cf.requestId, ok: false, error: { code: "handler_threw", message } }));
      }
    } catch {
      /* see policy note above: a stdin write after the child has already exited is swallowed */
    }
  }

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
          // Task 2: routed through sendControlRequest (rather than a raw encodeFrame write, as
          // before) so its ack is correlated like any other host-originated request instead of
          // arriving as an "unmatched" control_response — the swallowed catch is deliberate: this
          // detached sender task has nowhere useful to surface a rejection (e.g. the connection
          // closing before the ack arrives), matching the policy note above for the writes just above.
          sendControlRequest("end_input", undefined).catch(() => {});
          // Ruling P2-B (T2 review, lands in Task 8): this stdin.end() makes single-shot mode
          // structurally unable to ANSWER a runtime-originated control_request (permission/hook RPC)
          // — the write side is already closed when the request arrives. The pinned fix is two-sided
          // and must land together or the topologies diverge (WS-04 §1): the wrapper keeps stdin
          // open until terminal handling completes, AND the engine pump treats end_input as "no more
          // USER envelopes" (not "stop reading frames") so control_responses still route to the
          // bridge until the turn loop drains. Do not fix one side without the other.
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
          if (frame.type === "control_response") {
            // Task 2 direction inversion: the ACK for a request THIS WRAPPER originated
            // (sendControlRequest — interrupt/setPermissionMode/end_input today), correlated by
            // requestId. Unmatched (stale, or a response for a requestId this process no longer
            // tracks — e.g. after the finally-block teardown below already rejected it) is dropped
            // silently: a response is host-facing library plumbing, not a user-visible diagnostic,
            // and every query() call's own routine end_input ack would otherwise never match
            // anything here worth telling the consumer about.
            const cf = frame as ControlResponseFrame;
            const pendingReq = pendingHostRequests.get(cf.requestId);
            if (pendingReq) {
              pendingHostRequests.delete(cf.requestId);
              if (cf.ok) pendingReq.resolve(cf.payload);
              else pendingReq.reject(new WinterRpcError(cf.error?.code ?? "unknown_error", cf.error?.message ?? "control request failed"));
            }
            continue;
          }
          if (frame.type === "control_request") {
            // Runtime-originated (WS-04 §3.1 direction inversion) — dispatched to the handler
            // registry. Fire-and-forget: answering it (a permission prompt may wait on a human)
            // must never block this loop from continuing to read/yield the turn's other frames.
            void handleIncomingControlRequest(frame as ControlRequestFrame);
            continue;
          }
          if (frame.type !== "data") continue; // other frame kinds: still lossless pass-through, no-op for now
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
            // PROVISIONAL (Ruling P1-J, capture-pending): the whole throw-at-EOF-in-streaming-mode
            // semantic — including last-error-wins — awaits differential capture against the
            // official runtime, which plausibly does NOT throw in streaming mode at all (it may
            // yield erroring results and end cleanly, leaving inspection to the caller). Same
            // pending-capture class as the interrupted-result shape; pinned or revised at the
            // capture phase (P1 T11 carries the check).
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
      // Task 2: a still-pending host-originated request (interrupt/setPermissionMode) whose ack
      // will now never arrive — the connection is torn down — must not hang its caller forever.
      if (pendingHostRequests.size > 0) {
        const err = new WinterRpcError("connection_closed", "runtime connection closed before this control request was acknowledged");
        for (const pendingReq of pendingHostRequests.values()) pendingReq.reject(err);
        pendingHostRequests.clear();
      }
    }
  }

  const gen = iterate() as Query;
  // Task 2: real control requests, replacing the P0/P1 stubs (previously `proc.stdin.end()` for
  // interrupt; both setters were no-ops) — both now send a real control_request and resolve/reject
  // on the runtime's ack via sendControlRequest/pendingHostRequests above. The engine already acks
  // interrupt at P1 (its own state machine — abort the in-flight round, provisional interrupted
  // result — is unchanged, see engine.test.ts); this task only wires the WRAPPER side of that
  // exchange. A consumer must be actively iterating (or have iterated far enough to have read the
  // ack) for either promise to ever settle — true of any control response (WS-03 §4: "control calls
  // during active iteration are legal").
  gen.interrupt = async () => {
    await sendControlRequest("interrupt", { scope: "turn" });
  };
  // Still a stub: no engine-side `set_model` control-request handler exists yet (a future task adds
  // it — the correlation plumbing this stub would need now exists, unlike at P1).
  gen.setModel = async () => {};
  gen.setPermissionMode = async (mode: string) => {
    await sendControlRequest("set_permission_mode", mode); // WS-04 §3.1: bare PermissionMode value
  };
  gen.__internal = {
    registerControlRequestHandler(subtype, handler) {
      controlRequestHandlers.set(subtype, handler);
    },
  };
  return gen;
}
