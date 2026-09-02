import { homedir } from "node:os";
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
import { PolicyStateStore, assertKnownPermissionMode, isPermissionMode } from "./permissions/policy-state.ts";
import { emptyRuleSet, buildSdkSourcedEntries } from "./permissions/ruleset.ts";
import {
  evaluate,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  type PermissionCall,
  type EvaluationContext,
} from "./permissions/evaluator.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  // `interrupted`/`error`/`denied` are optional and set ONLY on a synthetic tool_result the engine
  // manufactures instead of actually executing the call — `interrupted` for an abandoned-mid-
  // interrupt call (Ruling P1-G), `error` for a call whose tool executor threw (Ruling P1-H),
  // `denied` for a call the six-stage permission evaluator (Task 6, WS-07 §2) refused to execute at
  // all (cross-task pin: "a normal tool_result ... same provisional-marker class as interrupted/
  // error"). All three are provisional shapes pending official capture. Never set on a real
  // tool_result; never two of the three set on the same block (a single call reaches at most one of
  // denied-before-execution, interrupted-during-execution, or errored-during-execution).
  | { type: "tool_result"; tool_use_id: string; content: string; interrupted?: boolean; error?: boolean; denied?: boolean };

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

  // Task 6 (WS-07 §2/§6.4, Ruling 8): permission startup validation — deliberately the very FIRST
  // thing runEngine does, before any `await` and before the `init` frame is written. A throw here
  // (an unrecognized permissionMode, an invalid allowedTools/disallowedTools/permissions rule, or
  // selecting bypassPermissions without allowDangerouslySkipPermissions/against a managed
  // disableBypassPermissionsMode veto) takes the SAME "exited before init" path a pre-init
  // resolution failure already does (e.g. store/resume.ts's ResumeTargetError, via
  // testing.ts's/main.ts's own pre-runEngine try/catch) — never a parse failure, never a silently
  // wrong default.
  const initialMode = assertKnownPermissionMode(config.permissionMode);
  // Task 5 (WS-07 §3.3 / phase ruling 1) seeding: Options.{allowedTools,disallowedTools,permissions}
  // become source:"sdk" rule entries via T5's own builder — this is the wiring T5's own header
  // called "not wired into the engine by this task (that is a later task's job)". Runs the SAME
  // add-time grammar validation every other rule source gets, so an invalid rule fails loud at
  // startup (PermissionRuleValidationError) rather than being silently inert at match time.
  const initialRules = {
    ...emptyRuleSet(),
    entries: buildSdkSourcedEntries({
      ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
      ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
      ...(config.permissions !== undefined ? { permissions: config.permissions } : {}),
    }),
  };
  const policyStateStore = new PolicyStateStore(
    { mode: initialMode, rules: initialRules },
    {
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions === true,
      disableBypassPermissionsMode: config.permissions?.disableBypassPermissionsMode === true,
    },
  );
  // Task 6: the resolved, fixed-at-startup home directory used for `~`-anchored file rules
  // (WS-07 §3.1). A plain `os.homedir()` read — no WINTER_HOME-style override exists for this at P2
  // (it is the invoking OS user's real home, exactly like every other tool would see it; tests that
  // need a synthetic home construct an EvaluationContext directly against evaluator.ts instead of
  // exercising this real value).
  const permissionHome = homedir();

  // Task 6: builds a FRESH EvaluationContext — always reading policyStateStore.getState() at the
  // moment of the call, never cached — so every evaluate() call sees the live mode/rules/version.
  // `trustedWorkspace: false` (constant, P2-wide): no settings-file loader exists yet to have
  // actually established workspace trust (P5); this is the SAFE direction (WS-07 §3.2's own
  // trust-gate — project/local ALLOW rules and directory grants stay inert; deny/ask are
  // unaffected) and P5 is the one that wires a real trust signal in. All four evaluator seams are
  // the T6 no-opinion stubs (T7/T8/T9/T10/T12 each fill exactly one, per the plan's seam list).
  const makeEvalCtx = (): EvaluationContext => ({
    policy: policyStateStore.getState(),
    cwd: config.cwd,
    home: permissionHome,
    trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
  });

  // WS-07 §2's stale-policy-rejection contract: evaluate() stamps `policyVersion` from the SNAPSHOT
  // it was handed (evaluator.ts's own EvaluationContext.policy comment) — if a mode/rule change
  // lands (via a concurrent set_permission_mode/applyUpdate control request, processed by the pump
  // below WHILE this call's evaluation is in flight) before this decision is actually used, the
  // decision is stale and must be discarded, never executed against a policy that has since moved
  // on. Re-evaluating under the now-current snapshot is the correct recovery (not merely rejecting):
  // the call still needs an answer under WHATEVER policy is active now.
  async function evaluateWithFreshPolicy(call: PermissionCall) {
    let record = await evaluate(call, makeEvalCtx());
    while (record.policyVersion !== policyStateStore.getState().version) {
      record = await evaluate(call, makeEvalCtx());
    }
    return record;
  }

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
    permissionMode: policyStateStore.getState().mode,
    tools: [],
  });
  output.write({
    type: "data",
    message: {
      type: "system",
      subtype: "init",
      session_id: config.sessionId,
      cwd: config.cwd,
      model: config.model,
      permissionMode: policyStateStore.getState().mode,
      tools: [],
    },
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
            // Task 6 (WS-07 §2/§6.4) upgrade over T2's minimal handler: still validates the payload
            // is one of the six public values (unchanged — a wire-level guard against arbitrary
            // strings), then routes the actual switch through PolicyStateStore.setMode, which bumps
            // `policyVersion` on success and applies the SAME bypassPermissions gate startup
            // validation uses (checkBypassGate) — `ok:false` with a typed error code
            // ("bypass_not_allowed" / "bypass_disabled") on a gated rejection, never a silent no-op.
            const mode = cf.payload; // WS-04 §3.1: request payload is the bare PermissionMode value
            if (typeof mode !== "string" || !isPermissionMode(mode)) {
              output.write({
                type: "control_response",
                requestId: cf.requestId,
                ok: false,
                error: { code: "invalid_mode", message: `invalid permission mode: ${JSON.stringify(mode)}` },
              });
              continue;
            }
            const result = policyStateStore.setMode(mode);
            if (!result.ok) {
              output.write({ type: "control_response", requestId: cf.requestId, ok: false, error: result.error });
              continue;
            }
            output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { effectiveMode: result.effectiveMode } });
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
          // Task 6 (WS-07 §2, WS-04 §4 ordering rule 5): the permission gate slots HERE — between
          // this round's tool_use emission (already written/pushed/recorded above) and execution.
          // Calls in one round evaluate SEQUENTIALLY in call order (this `for` loop's own order); a
          // deny produces its synthetic tool_result and the loop CONTINUES to the next call — it
          // does not `break` the round, matching "each-call-independent" semantics (unlike an
          // interrupt or a thrown executor, which legitimately do stop the round early below).
          const permissionCall: PermissionCall = {
            toolName: call.name,
            input: typeof call.input === "object" && call.input !== null ? (call.input as Record<string, unknown>) : {},
            toolUseId: call.id,
          };
          const decisionRaced = await raceInterrupt(evaluateWithFreshPolicy(permissionCall), interruptSignal);
          if (decisionRaced.kind === "interrupted") {
            interrupted = true;
            break;
          }
          const decision = decisionRaced.value;
          if (decision.decision !== "allow") {
            // decision.decision === "deny" at T6 — evaluate() never returns "ask"/"defer" yet (T11
            // wires defer-parking here; a matched ask rule is already resolved to a terminal
            // allow/deny by the prompt stage inside evaluate() itself, never surfaced as its own
            // pending state). Cross-task pin: a denial is a NORMAL tool_result, `denied: true`,
            // flowing through the SAME emit/push/record cluster below as every other result — this
            // is what makes dontAsk's deny-not-hang fall out structurally (WS-07 §6.3).
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: decision.message ?? "Permission denied",
              denied: true,
            });
            continue;
          }
          // WS-07 §7.2: updatedInput/transformedInput sanitizes/narrows/redirects the EXECUTED call
          // — the tool_use block already emitted above keeps the model's ORIGINAL input; only what
          // actually runs (and therefore the tool_result that comes back) reflects the transform.
          const executedCall = decision.transformedInput !== undefined ? { ...call, input: decision.transformedInput } : call;
          const raced = await raceInterrupt(tools.execute(executedCall), interruptSignal);
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
