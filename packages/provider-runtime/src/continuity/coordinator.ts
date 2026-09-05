// Phase 6 Lane C: the SWITCH COORDINATOR -- report §8.2/§8.3, as a policy object with no engine in it.
//
// THE RULE IT EXISTS TO ENFORCE (§8.1): a family switch NEVER splices into a native tool
// continuation. Winter must not send an Anthropic tool_result to OpenAI as the continuation of a
// Claude tool_use, nor hand Claude a `function_call_output` as though Claude had authored the call.
// Tool ids, reasoning items, signatures and block ordering belong to the response that produced them.
// So a switch requested mid-turn is RECORDED, the source keeps its own turn, and the default is
// "finish this turn, then switch" at the quiescent boundary (§2.7: no outstanding request, no
// unresolved tool call, no pending result, no incomplete response).
//
// SWITCHING IS NEVER PROHIBITED. §8.3's immediate path exists and is a first-class outcome: cancel
// through the OWNING runtime, mark the native loop incomplete, never fabricate a tool result or a
// final source message, retain the tool facts that DID complete as ordinary portable text, and report
// the discard. Tool side effects already performed are not rolled back by changing models -- which is
// why the discard report says what was discarded rather than implying anything was undone.
//
// WHY IT HOLDS NO ENGINE STATE. The engine already owns "is a turn running" (`interruptCurrentTurn`)
// and the three call sites this object serves (`set_model` while idle, the quiescent boundary before
// the next envelope's first generation, and `interrupt`). A second turn-state machine in here could
// disagree with that one, and the disagreement would be invisible until a switch landed mid-tool-loop
// -- so `turnActive` is an ARGUMENT, supplied by the engine that already knows the answer, and the
// only state kept here is the pending transition itself.

import { buildPortableHandoff, type PortableHandoff, type PortableHandoffOptions } from "./handoff.ts";
import type { ContinuityEndpoint } from "./domains.ts";
import type { ContinuationChainLike } from "./renderer.ts";
import { classifySwitch, type SwitchClassification, type SwitchFacts } from "./warnings.ts";
import type { ProviderMessageLike } from "../types.ts";

/** How the caller asked for the switch. `at-boundary` is the DEFAULT; `immediate` is an explicit user choice (§8.3). */
export type SwitchMode = "at-boundary" | "immediate";

/** What the caller should do next. Never "refuse": switching is always permitted (§8.2's closing line). */
export type SwitchAction = "apply-now" | "defer-to-boundary" | "cancel-then-switch";

/** The runtime that OWNS the running turn. The coordinator never cancels a request itself -- it asks the owner, which is the only thing that can cancel its own generation and its own tool loop. */
export interface SwitchOwner {
  cancel(reason: string): void;
}

export interface SwitchRequest {
  from: ContinuityEndpoint;
  to: ContinuityEndpoint;
  mode?: SwitchMode;
  facts?: SwitchFacts;
  /** Whether a turn is in flight RIGHT NOW, per the engine's own state. Idle is itself a quiescent boundary. */
  turnActive: boolean;
}

export interface PendingSwitch {
  from: ContinuityEndpoint;
  to: ContinuityEndpoint;
  mode: SwitchMode;
  requestedDuring: "turn" | "idle";
  facts: SwitchFacts;
  classification: SwitchClassification;
}

export interface SwitchDecision {
  action: SwitchAction;
  classification: SwitchClassification;
  pending: PendingSwitch;
}

/** What the immediate path threw away. Counts and identity only -- never a payload, never reasoning text (Global Constraints). */
export interface DiscardReport {
  /** The source's native tool loop was left INCOMPLETE. Nothing was fabricated to close it. */
  incompleteToolLoop: boolean;
  /** In-flight hidden reasoning that had not completed is gone: it was never captured, and it cannot be reconstructed. */
  discardedInFlightReasoning: boolean;
  /** Tool calls that DID complete. Their facts cross as portable text; their side effects are not rolled back. */
  completedToolResultsRetained: number;
  /** Structurally zero, and typed as the literal: this path never manufactures a tool result or a final source message (§8.3). */
  fabricatedToolResults: 0;
  detail: string;
}

export interface AppliedSwitch {
  from: ContinuityEndpoint;
  to: ContinuityEndpoint;
  /** Mirrors the engine's own `system/model_switch` reasons, plus the boundary case it spells `set_model`. */
  reason: "set_model" | "interrupt";
  classification: SwitchClassification;
  handoff?: PortableHandoff;
  discard?: DiscardReport;
}

/** What a switch needs to build the handoff. Absent messages mean "no handoff" -- never an empty one, which would read as "there was nothing to carry". */
export interface ApplyContext {
  messages?: readonly ProviderMessageLike[];
  chain?: ContinuationChainLike;
  handoff?: PortableHandoffOptions;
}

export interface ImmediateContext extends ApplyContext {
  owner: SwitchOwner;
  /** How many tool calls completed before the cancel. Their facts are retained; the count is what the discard report states. */
  completedToolResults?: number;
}

export interface SwitchCoordinator {
  /** Records a requested transition and says what to do about it. Recording is all it does -- it never touches the in-flight request (§8.2's rule 6). */
  request(request: SwitchRequest): SwitchDecision;
  pending(): PendingSwitch | undefined;
  /**
   * Applies a pending switch at a quiescent boundary. `trigger` is the engine's own call site:
   * `"quiescent-boundary"` before the next envelope's first generation, `"idle"` when `set_model`
   * arrived with nothing running, `"interrupt"` when the turn ended early.
   */
  apply(trigger: "quiescent-boundary" | "idle" | "interrupt", ctx?: ApplyContext): AppliedSwitch | undefined;
  /** §8.3: cancel through the owner and switch now. Returns the applied switch WITH its discard report. */
  applyImmediately(ctx: ImmediateContext): AppliedSwitch | undefined;
  /** Drops a pending switch without applying it (the user cancelled the switch, not the turn). */
  cancel(): PendingSwitch | undefined;
}

export function createSwitchCoordinator(): SwitchCoordinator {
  let pending: PendingSwitch | undefined;

  function classify(from: ContinuityEndpoint, to: ContinuityEndpoint, facts: SwitchFacts, midTurnAbort: boolean): SwitchClassification {
    return classifySwitch(from, to, midTurnAbort ? { ...facts, midTurnAbort: true } : facts);
  }

  function handoffFor(pendingSwitch: PendingSwitch, ctx: ApplyContext | undefined): PortableHandoff | undefined {
    if (ctx?.messages === undefined) return undefined;
    const chain: ContinuationChainLike = ctx.chain ?? new Map();
    return buildPortableHandoff(ctx.messages, chain, pendingSwitch.from, ctx.handoff ?? {});
  }

  return {
    request(request: SwitchRequest): SwitchDecision {
      const mode = request.mode ?? "at-boundary";
      const facts = request.facts ?? {};
      // A switch that will cancel a running turn is classified AS ONE from the moment it is requested:
      // the user is being asked to confirm a discard, and a warning that only appears afterwards is a
      // warning about something they can no longer decline.
      const midTurnAbort = request.turnActive && mode === "immediate";
      const next: PendingSwitch = {
        from: request.from,
        to: request.to,
        mode,
        requestedDuring: request.turnActive ? "turn" : "idle",
        facts,
        classification: classify(request.from, request.to, facts, midTurnAbort),
      };
      pending = next;
      const action: SwitchAction = !request.turnActive ? "apply-now" : mode === "immediate" ? "cancel-then-switch" : "defer-to-boundary";
      return { action, classification: next.classification, pending: next };
    },

    pending(): PendingSwitch | undefined {
      return pending;
    },

    apply(trigger, ctx): AppliedSwitch | undefined {
      const applying = pending;
      if (applying === undefined) return undefined;
      pending = undefined;
      // AN INTERRUPT IS AN EARLY BOUNDARY, and it is also an abort: the turn did not produce its
      // final summary or state, so the transfer is reclassified with §8.4's seventh trigger even
      // though the deferred switch itself asked for nothing of the kind.
      // THE HANDOFF IS BUILT FIRST, and that order is the whole finding of review C1. The handoff is
      // where §9.6's trimming actually HAPPENS -- it bounds every quoted value, so a real exposed
      // trace is elided by default -- and classifying before building it returned
      // `lossless-portable` with zero warnings beside a handoff whose reasoning had been cut to 400
      // characters. That is the verbatim §9.6 violation ("never silently truncate reasoning while
      // still classifying the handoff as lossless"), committed at the one point that composes the
      // two. Only `reasoningTruncated` folds in: a clipped tool-result excerpt is a display bound,
      // not reasoning the target will not receive.
      const handoff = handoffFor(applying, ctx);
      const reasoningTruncated = handoff?.reasoningTruncated === true;
      const midTurnAbort = trigger === "interrupt" && applying.requestedDuring === "turn";
      const facts = reasoningTruncated ? { ...applying.facts, truncated: true } : applying.facts;
      const classification = midTurnAbort || reasoningTruncated ? classify(applying.from, applying.to, facts, midTurnAbort) : applying.classification;
      return {
        from: applying.from,
        to: applying.to,
        reason: trigger === "interrupt" ? "interrupt" : "set_model",
        classification,
        ...(handoff !== undefined ? { handoff } : {}),
      };
    },

    applyImmediately(ctx): AppliedSwitch | undefined {
      const applying = pending;
      if (applying === undefined) return undefined;
      pending = undefined;
      const retained = ctx.completedToolResults ?? 0;
      // STEP 1 OF §8.3, and it goes through the OWNER. The coordinator cannot cancel a generation:
      // only the runtime that issued it can stop its own request and its own tool loop, and a
      // coordinator that tried would leave the real request running behind an abandoned await.
      ctx.owner.cancel(`switching to ${applying.to.modelKey} immediately`);
      // Built BEFORE the classification, for C1's reason (see `apply`).
      const handoff = handoffFor(applying, ctx);
      const classification = classify(
        applying.from,
        applying.to,
        { ...applying.facts, completedToolResults: retained, ...(handoff?.reasoningTruncated === true ? { truncated: true } : {}) },
        true,
      );
      const discard: DiscardReport = {
        incompleteToolLoop: true,
        discardedInFlightReasoning: true,
        completedToolResultsRetained: retained,
        fabricatedToolResults: 0,
        detail:
          `The ${applying.from.modelKey} turn was cancelled before it finished: its in-flight reasoning and its incomplete native tool continuation are discarded, and no tool result or final response was manufactured to close them. ` +
          `${retained} completed tool result${retained === 1 ? "" : "s"} cross as facts; side effects already performed are not undone.`,
      };
      return {
        from: applying.from,
        to: applying.to,
        reason: "interrupt",
        classification,
        ...(handoff !== undefined ? { handoff } : {}),
        discard,
      };
    },

    cancel(): PendingSwitch | undefined {
      const dropped = pending;
      pending = undefined;
      return dropped;
    },
  };
}
