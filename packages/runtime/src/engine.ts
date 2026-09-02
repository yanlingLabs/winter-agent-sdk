import {
  PROTOCOL_VERSION,
  type RuntimeConfig,
  type ControlRequestFrame,
  type ControlResponseFrame,
  type UserFrame,
  type ProtocolSdkMessage as SdkMessage,
} from "@yanlinglabs/winter-agent-sdk";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { Queue } from "./protocol/channel.ts";
import { createRpcBridge } from "./rpc/bridge.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  // `interrupted`/`error` are optional and set ONLY on a synthetic tool_result the engine
  // manufactures when a round is cut short after its tool_use was already pushed into history —
  // `interrupted` for an abandoned-mid-interrupt call (Ruling P1-G), `error` for a call whose tool
  // executor threw (Ruling P1-H). Both are provisional shapes pending official capture. Never set
  // on a real tool_result; never both set on the same block (a single call is either interrupted or
  // errored, never both, since each round's execute loop stops at the first of either).
  | { type: "tool_result"; tool_use_id: string; content: string; interrupted?: boolean; error?: boolean };

// The engine's own turn-history record fed back to Provider.generate() on every call. Distinct
// from the WIRE shape (assistant/user data frames, below): the wire has no "tool" role (tool
// results ride a "user" message, matching WS-03 §8 / the official SDK), but keeping tool results
// on their own role here keeps accumulation/tool-round assertions simple and unambiguous.
export interface ProviderMessage {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
}

export type ProviderTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; calls: Array<{ id: string; name: string; input: unknown }> }
  // Task 2 (WS-04 §3.1): a P1-only test-affordance turn kind (WINTER_TEST_PROVIDER=rpcprobe,
  // provider/mock.ts) that proves the runtime-originated control-RPC bridge round trip end-to-end
  // on every transport leg (the transport-equivalence suite's rpcprobe scenario). The ENGINE
  // performs bridge.request(subtype, payload) on the provider's behalf when it sees this kind
  // (round loop below) — Provider.generate() itself never touches the bridge directly, staying a
  // plain, transport-agnostic function for every other turn kind. REMOVE at P6 alongside
  // provider/mock.ts's whole test-provider family; a real permission/hook RPC (Tasks 8/10) is
  // issued from the evaluator/hook runner, not from this turn kind.
  | { kind: "rpc_probe"; subtype: string; payload: unknown };

export interface Provider {
  generate(input: { messages: ProviderMessage[] }): Promise<ProviderTurn>;
}

export interface ToolExecutor {
  execute(call: { id: string; name: string; input: unknown }): Promise<{ output: string }>;
}

// Ruling P1-B: the minimal, data-shaped interface the engine needs to record a session (blocks/text
// in, void/promise out — no store types). Task 8 implements this over the Claude-dialect
// TranscriptWriter (WS-05 §5.2 / task-8 brief): user envelopes AND tool results both route through
// recordUserEntry (the dialect has only user/assistant roles — the "tool" role above is internal to
// this engine's own history, never persisted as such); assistant text/tool_use both route through
// recordAssistantEntry as content blocks. Entirely optional — the engine runs fine without a store.
export interface SessionPersistence {
  recordUserEntry(content: string | ContentBlock[]): void | Promise<void>;
  recordAssistantEntry(content: ContentBlock[]): void | Promise<void>;
  flush?(): void | Promise<void>;
}

export interface EngineOptions {
  config: RuntimeConfig;
  input: FrameSource;
  output: FrameSink;
  provider: Provider;
  tools: ToolExecutor;
  store?: SessionPersistence;
  // Task 9 (WS-05 §7): the resumed/continued/forked conversation's prior turns, already rebuilt
  // into this engine's own ProviderMessage shapes by the store layer (dialect.ts's
  // resolveEngineSession, via resume.ts's rebuildProviderMessages) — seeded into `messages` before
  // the turn loop starts, so the FIRST provider.generate() call of this run already sees the
  // resumed history exactly as if the conversation had never left memory. Omitted (or empty) for a
  // fresh, non-resumed session — byte-identical to pre-Task-9 behavior.
  //
  // engine.ts cannot resolve this itself: dialect.ts already imports types from this module, so the
  // reverse import (this module reading SessionStore/resume.ts) would be circular. Resolution
  // happens once, before runEngine is even called, at the two call sites that already own store
  // construction (main.ts, testing.ts) — Ruling P1-B's storage-agnostic engine holds exactly as
  // before; it just gains one more plain-data input.
  initialMessages?: ProviderMessage[];
}

// WS-03 §6's pinned six-value public PermissionMode union. Task 2's set_permission_mode handler
// (below) validates against exactly this set; Task 6 (WS-07) replaces the whole handler with full
// PolicyState semantics (rule re-evaluation, journal, provenance) — this set stays the same, only
// the handler body around it grows.
const PUBLIC_PERMISSION_MODES = new Set(["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"]);

type RaceOutcome<T> = { kind: "ok"; value: T } | { kind: "interrupted" };

// Races `p` against the current turn's interrupt signal. `p` is given a no-op catch so that if it
// is abandoned (interrupted) and later settles anyway, that settlement never surfaces as an
// unhandled rejection — Provider/ToolExecutor take no AbortSignal at P1, so "abort" here means
// "the engine stops waiting," not "the underlying call actually stops" (WS-04 §5).
function raceInterrupt<T>(p: Promise<T>, interrupted: Promise<void>): Promise<RaceOutcome<T>> {
  p.catch(() => {});
  return Promise.race([
    p.then((value): RaceOutcome<T> => ({ kind: "ok", value })),
    interrupted.then((): RaceOutcome<T> => ({ kind: "interrupted" })),
  ]);
}

/**
 * The turn engine (WS-04 §4.1 state machine: `initializing → idle → turn_active → draining →
 * closing`). A "turn" is one user envelope through its terminal result; a "tool round" is one
 * provider tool_use → execute → results-appended → provider-again cycle. Always terminates when
 * input ends (stdin EOF or an explicit `end_input` control request) — the P0 dangling-loop bug
 * class is structurally impossible here: the pump below is the ONLY reader of `input`, and it
 * always reaches its own teardown (`finally`) exactly once, which always ends `userFrames`, which
 * always ends the turn loop below.
 */
export async function runEngine(opts: EngineOptions): Promise<number> {
  const { config, input, output, provider, tools, store, initialMessages } = opts;
  // Mutable (Task 2): set_permission_mode's handler below swaps this live; every other read
  // (the init/system-init frames above the pump) still only ever sees whatever value is current
  // at the moment it runs — unchanged for the very first read, since the pump cannot have
  // processed any control_request yet.
  let permissionMode = config.permissionMode ?? "default";

  // Store failures are auxiliary, never turn-fatal (WS-03 §11 — a mirror failure becomes a
  // `mirror_error` event, not a retroactive turn failure). P1 has no such event to emit yet, so
  // this just swallows; a future WS-03 §11/WS-16 mirror-layer task is expected to route the catch
  // body to that event (T8 fix-wave: this comment previously, and now stale-ly, said "Task 8 is
  // expected to" — Task 8 shipped without adding it; re-pointed at its real future owner).
  const recordUser = async (content: string | ContentBlock[]): Promise<void> => {
    if (!store) return;
    try {
      await store.recordUserEntry(content);
    } catch {
      /* auxiliary — see comment above */
    }
  };
  const recordAssistant = async (content: ContentBlock[]): Promise<void> => {
    if (!store) return;
    try {
      await store.recordAssistantEntry(content);
    } catch {
      /* auxiliary — see comment above */
    }
  };
  const flushStore = async (): Promise<void> => {
    if (!store?.flush) return;
    try {
      await store.flush();
    } catch {
      /* auxiliary — see comment above */
    }
  };

  // `init` MUST be the first runtime→host frame (WS-04 §4.1 `initializing`), from resolved runtime
  // state. P1 has no tool catalog yet (WS-06) so the advertised tool list is always empty.
  output.write({
    type: "init",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: config.sessionId,
    cwd: config.cwd,
    model: config.model,
    permissionMode,
    tools: [],
  });
  output.write({
    type: "data",
    message: { type: "system", subtype: "init", session_id: config.sessionId, cwd: config.cwd, model: config.model, permissionMode, tools: [] },
  });

  // Task 2 (WS-04 §3.1, direction inversion): the runtime's own half of the control-RPC envelope —
  // declared here, in runEngine's OUTER scope, so it's reachable by both the pump below (which
  // routes incoming control_response frames to it) and the round loop further down (rpc_probe;
  // Tasks 8/10's permission/hook RPCs will reach it the same way, whether called directly from here
  // or threaded into a helper this function calls). Exactly one bridge instance per run, built from
  // the SAME `output` every other runtime->host frame goes through — there is no second writer to
  // race against.
  const bridge = createRpcBridge(output);

  const userFrames = new Queue<UserFrame>();
  // Non-null exactly while a turn is turn_active; the pump calls it (a no-op while idle) when an
  // `interrupt` control request arrives. Kept as a plain callback rather than an AbortController
  // because Provider/ToolExecutor take no signal at P1 (see raceInterrupt above). A ref OBJECT
  // rather than a bare `let`: TS's control-flow narrowing carries the `null` seen at this
  // declaration into the pump closure below and never widens it back across that closure's
  // internal `await`s (a known CFA limitation with values mutated by a second, concurrently
  // -running closure) — `.current` on an object sidesteps that narrowing.
  const interruptCurrentTurn: { current: (() => void) | null } = { current: null };

  // The ONLY reader of `input` (WS-04 §4.1). Decoupling "read a frame" from "process a turn" is
  // what lets `interrupt`/`end_input` land WHILE a turn is blocked awaiting the provider or a tool
  // — a single sequential `for await` over `input` could never observe a new frame until the
  // blocked call happened to settle on its own, which would make interrupt meaningless.
  const pump = (async () => {
    try {
      for await (const frame of input) {
        if (frame.type === "user") {
          userFrames.write(frame as UserFrame);
          continue;
        }
        if (frame.type === "control_response") {
          // Task 2 direction inversion: this is the ACK for a request the RUNTIME originated
          // (bridge.request() — rpc_probe today, permission/hook RPCs in Tasks 8/10), arriving
          // host->runtime. handleResponse itself never throws and logs+drops an unmatched/stale
          // requestId (WS-04: a stale response must never kill the run) — nothing more to do here.
          bridge.handleResponse(frame as ControlResponseFrame);
          continue;
        }
        if (frame.type === "control_request") {
          const cf = frame as ControlRequestFrame;
          if (cf.subtype === "end_input") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            break; // WS-04 §6: explicit end of streaming input — stop pumping, let the turn loop drain
          }
          if (cf.subtype === "interrupt") {
            output.write({ type: "control_response", requestId: cf.requestId, ok: true });
            interruptCurrentTurn.current?.(); // no-op while idle: nothing active to abort
            continue;
          }
          if (cf.subtype === "set_permission_mode") {
            // Controller resolution (Task 2 scope, WS-04 §3.1): a MINIMAL handler — validate the
            // payload is one of the six public PermissionMode values, swap the engine's live
            // variable, ack with the effective mode. Task 6 (WS-07) replaces this whole handler
            // with full PolicyState semantics (rule re-evaluation, journal, provenance); this is
            // exactly as far as T2 goes, no more.
            const mode = cf.payload; // WS-04 §3.1: request payload is the bare PermissionMode value
            if (typeof mode !== "string" || !PUBLIC_PERMISSION_MODES.has(mode)) {
              output.write({
                type: "control_response",
                requestId: cf.requestId,
                ok: false,
                error: { code: "invalid_mode", message: `invalid permission mode: ${JSON.stringify(mode)}` },
              });
              continue;
            }
            permissionMode = mode;
            output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { effectiveMode: permissionMode } });
            continue;
          }
          // WS-04 §3.1: an unrecognized subtype gets a structured error response, never a dropped
          // request or a process death.
          const resp: ControlResponseFrame = {
            type: "control_response",
            requestId: cf.requestId,
            ok: false,
            error: { code: "unknown_subtype", message: `unrecognized control subtype '${cf.subtype}'` },
          };
          output.write(resp);
          continue;
        }
        // Other/unknown top-level frame types (permission/hook/MCP RPCs, other control subtypes)
        // land in later phases; ignored here, matching the P0 precedent of skipping non-"user"
        // frames rather than erroring.
      }
    } finally {
      userFrames.end();
    }
  })();

  const messages: ProviderMessage[] = initialMessages ? [...initialMessages] : [];
  // Ruling P1-F: maxTurns is the RUN's cumulative agentic tool-use round-trip cap (report §8 /
  // WS-03 §5) — it never resets per user envelope. Declared here, outside the turn loop, so it
  // persists for runEngine's whole lifetime; once spent, EVERY subsequent tool_use attempt in this
  // run fails with error_max_turns (sticky-over-limit — incrementing past the limit is harmless,
  // there's no need to cap the counter itself). A plain-text turn never touches this counter, so a
  // text-only envelope always succeeds regardless of how much of the budget prior turns spent.
  let rounds = 0;

  for await (const userFrame of userFrames) {
    // Set BEFORE any await this turn (including recordUser below) so the entire turn — from the
    // moment its envelope is accepted — is interruptible (WS-04 §5).
    let interruptResolve!: () => void;
    const interruptSignal = new Promise<void>((resolve) => {
      interruptResolve = resolve;
    });
    interruptCurrentTurn.current = interruptResolve;

    const userText = userFrame.text;
    messages.push({ role: "user", content: userText });
    await recordUser(userText);

    let finalResult: Extract<SdkMessage, { type: "result" }> | null = null;
    let interrupted = false;

    roundLoop: while (true) {
      let turn: ProviderTurn;
      try {
        const raced = await raceInterrupt(provider.generate({ messages: [...messages] }), interruptSignal);
        if (raced.kind === "interrupted") {
          interrupted = true;
          break roundLoop;
        }
        turn = raced.value;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
        break roundLoop;
      }

      if (turn.kind === "text") {
        // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await —
        // the terminal result below is the sole durability barrier for this turn; P6 (partial
        // streaming) must revisit this ordering once intermediate frames become resumable state.
        output.write({ type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: turn.text }] } } });
        messages.push({ role: "assistant", content: turn.text });
        await recordAssistant([{ type: "text", text: turn.text }]);
        finalResult = { type: "result", subtype: "success", is_error: false, result: turn.text };
        break roundLoop;
      }

      if (turn.kind === "rpc_probe") {
        // See this type's own comment on ProviderTurn above: P1-only, REMOVE at P6. Every path
        // below ends in `break roundLoop` so TS's narrowing of `turn` to the tool_use variant past
        // this point (via `turn.calls` further down) still holds.
        //
        // Deliberately NOT raced against interruptSignal the way provider.generate()/tools.execute()
        // are above: an interrupt arriving while this await is in flight still gets ACKed by the
        // pump (unconditional), but has no effect on this wait — a known gap acceptable for a
        // P1-only test scaffold that's never itself interrupted, not a spec requirement. A real
        // permission/hook RPC (Tasks 8/10) will need to decide its own interrupt-during-wait
        // semantics (WS-07/WS-08), which may differ from this.
        let replyText: string;
        try {
          const response = await bridge.request<{ text: string }>(turn.subtype, turn.payload);
          replyText = `rpc reply: ${response.text}`;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
          break roundLoop;
        }
        output.write({ type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: replyText }] } } });
        messages.push({ role: "assistant", content: replyText });
        await recordAssistant([{ type: "text", text: replyText }]);
        finalResult = { type: "result", subtype: "success", is_error: false, result: replyText };
        break roundLoop;
      }

      // tool_use: one round trip regardless of how many calls it batches ("a tool round = provider
      // tool_use → execute → results appended → provider again" — counted once per such cycle).
      rounds++;
      if (config.maxTurns !== undefined && rounds > config.maxTurns) {
        finalResult = { type: "result", subtype: "error_max_turns", is_error: true };
        break roundLoop;
      }

      const toolUseBlocks: ContentBlock[] = turn.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }));
      // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await — the
      // terminal result is the sole durability barrier; P6 (partial streaming) must revisit this.
      output.write({ type: "data", message: { type: "assistant", message: { content: toolUseBlocks } } });
      messages.push({ role: "assistant", content: toolUseBlocks });
      await recordAssistant(toolUseBlocks);

      const resultBlocks: ContentBlock[] = [];
      // Set (alongside `finalResult`) exactly when a call in THIS round throws — kept as its own
      // variable, rather than re-deriving from `finalResult`, because `finalResult` can ALSO be set
      // by the provider.generate() catch above, which already does its own `break roundLoop` and
      // never reaches this point in the same iteration; this flag only ever reflects a throw from
      // the loop directly below it.
      let toolThrowText: string | null = null;
      for (const call of turn.calls) {
        try {
          const raced = await raceInterrupt(tools.execute(call), interruptSignal);
          if (raced.kind === "interrupted") {
            interrupted = true;
            break;
          }
          resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: raced.value.output });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          finalResult = { type: "result", subtype: "error_during_execution", is_error: true, result: text };
          toolThrowText = text;
          break;
        }
      }

      if (toolThrowText !== null) {
        // Ruling P1-H: the tool_use/tool_result pairing invariant must hold in ACCUMULATED HISTORY
        // (and on the wire, and in persistence) even when a tool executor THROWS mid-round — the
        // assistant's tool_use was already pushed into `messages` above, so every one of its calls
        // needs a matching tool_result or the history a real provider's next request (and Task 8's
        // persistence) would carry a dangling tool_use, which a real provider rejects outright.
        // Provisional shape pending official capture (same class as the interrupted-result shape
        // below, whose comment this mirrors): content "[error: <thrown>]" + `error: true` marks a
        // call that never got a real result because its round's tool executor threw — covers both
        // the call that threw and any calls after it in this round that never got to run. Uses the
        // SAME Error-message-or-String(err) rendering as `finalResult.result` above (`text`) rather
        // than an unconditional `String(thrown)` — see the task-8 report's deviations for why.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: `[error: ${toolThrowText}]`, error: true });
          }
        }
      }

      if (interrupted) {
        // Ruling P1-G: the tool_use/tool_result pairing invariant must hold in ACCUMULATED HISTORY
        // even when a round is cut short — the assistant's tool_use was already pushed into
        // `messages` above, so every one of its calls needs a matching tool_result or the history
        // Task 8 persists (and any real provider's next request) carries a dangling tool_use, which
        // a real provider rejects outright. Provisional shape pending official capture (same
        // standing pattern as the interrupted-result shape below): content "[interrupted]" +
        // `interrupted: true` marks a call that never got a real result because the turn was
        // interrupted — covers both "never started" and "was mid-execution when interrupted" calls.
        const resultedIds = new Set(resultBlocks.map((b) => (b as { tool_use_id: string }).tool_use_id));
        for (const call of turn.calls) {
          if (!resultedIds.has(call.id)) {
            resultBlocks.push({ type: "tool_result", tool_use_id: call.id, content: "[interrupted]", interrupted: true });
          }
        }
      }

      // Emitted/pushed/recorded unconditionally (normal completion, padded-after-interrupt, OR
      // padded-after-throw) so the wire, the in-memory history, and persistence never disagree about
      // whether this round's tool_result exists — an implementation-shape choice under P1-G (later
      // extended by P1-H to the throw path): previously nothing was emitted here on interrupt (nor,
      // until P1-H, on a throw), which under-delivered relative to WS-04 §5's drain-after-interrupt
      // contract ("buffered data of the interrupted turn, then its terminal result").
      // Sign-off 5 (whole-branch review): this write intentionally precedes its record-await — the
      // terminal result is the sole durability barrier; P6 (partial streaming) must revisit this.
      output.write({ type: "data", message: { type: "user", message: { content: resultBlocks } } });
      messages.push({ role: "tool", content: resultBlocks });
      await recordUser(resultBlocks);

      if (finalResult) break roundLoop; // relocated below the emit/push/record (Ruling P1-H) — see comment above
      if (interrupted) break roundLoop;
      // loop back for the next provider.generate() call
    }

    interruptCurrentTurn.current = null;

    // Terminal-over-abort (WS-04 §5 drain-after-interrupt; the same principle query.ts's wrapper
    // pins for its own abort-vs-terminal race): a turn that genuinely completed wins even if an
    // interrupt landed in the same tick as completion (e.g., during the recordAssistant/recordUser
    // await just before this check). Only the ABSENCE of a terminal result falls through to the
    // provisional interrupted shape.
    if (finalResult) {
      output.write({ type: "data", message: finalResult });
    } else {
      // Provisional shape pending official capture (standing controller ruling) — no `result` text.
      output.write({ type: "data", message: { type: "result", subtype: "success", is_error: false, interrupted: true } });
    }
    await flushStore();
  }

  await pump.catch(() => {}); // the pump only throws on a truly unexpected input-source error; never let that crash teardown
  output.end();
  return 0;
}
