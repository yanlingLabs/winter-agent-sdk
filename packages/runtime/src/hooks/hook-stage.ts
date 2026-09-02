// Task 9: `createHookStage` — the adapter that fills evaluator.ts's stage-1 `HookStage` seam
// (T6-authored, packages/runtime/src/permissions/evaluator.ts) with this phase's real
// registry+reducer+runner, WITHOUT modifying evaluator.ts itself. Its own seam-contract comment
// already anticipates exactly this: "T9's real multi-hook reducer composes several hooks into ONE
// HookDecision before this seam is even called; this interface is the reducer's OUTPUT shape" — the
// seam was designed to be filled, not reshaped, and this file is that fill.
//
// *** THE "ask"/"defer" GAP (read before touching this file) ***
// WS-08 §3 pins FOUR PreToolUse decision values: allow/ask/deny/defer. evaluator.ts's existing
// `HookDecision.decision` (T6) has only THREE: "allow" | "deny" | "no_opinion" — there has never
// been a stage-1 outcome meaning "force the interactive/approval path" the way stage 3's matched-
// ask-rule handling forces `ctx.promptStage.prompt(...)` directly. Extending that contract (and
// evaluate()'s own stage-1 control flow to actually route to promptStage on a hook "ask") is a
// DELIBERATE non-goal of this task:
//   - The task brief's own Step 3 integration list tests only deny/allow/transform-visibility —
//     never "ask" — at the evaluator level.
//   - Every prior task that touched evaluator.ts's seam contracts (T7 filled SpecialChecks, T8
//     filled PromptStage) is EXPLICITLY named in its own brief's Files line ("Modify evaluator.ts...
//     fill the X seam" / "PromptStage filled"); this task's brief names registry.ts/reducer.ts/
//     runner.ts only — evaluator.ts is conspicuously absent, and the sdk barrel precedent (every
//     prior task's own "Task N" banner blocks, added without being individually named either) is the
//     kind of implied-scope addition that's actually expected; a NEW stage-1 branch changing
//     evaluate()'s control flow is not the same kind of addition.
// Given that, `composite.decision === "ask"` (which also covers a `defer` a PreToolUse hook returned
// — runner.ts's own interim ruling already resolves defer to ask, TODO(T11)) maps to seam `"deny"`:
// FAIL CLOSED, never `"no_opinion"` (which would let acceptEdits/bypass/read-only auto-approval
// silently execute a call a hook explicitly asked a human to review — a real under-enforcement bug)
// and never `"allow"` (which would be actively wrong). Deny is the only SAFE terminal answer the
// current 3-value contract can express for "this needs interactive approval" — matching this whole
// phase's "never implicitly allow" posture (Ruling P2-I). This mapping is PRODUCTION-UNREACHABLE at
// P2 (nothing populates `Options.hooks`/`config.hooks` until T10 wires query.ts — see options.ts/
// config.ts's own Task 9 comments), so the cost of this interim choice is zero today; it is
// fixture-pinned here (hook-stage.test.ts) rather than silently assumed, and flagged in the task
// report as a concern for a follow-up task to extend the seam to a real interactive-routing outcome.
import type { PermissionCall, EvaluationContext, HookStage, HookDecision } from "../permissions/evaluator.ts";
import { runHooks, type HookInvoker, type HookAuditRecorder, type HookTimeoutConfig, type ToolInputValidator } from "./runner.ts";
import type { HookRegistry } from "./registry.ts";

export interface HookStageDeps {
  registry: HookRegistry;
  invoker: HookInvoker;
  audit: HookAuditRecorder;
  sessionId: string;
  agentID?: string;
  timeouts?: HookTimeoutConfig;
  validator?: ToolInputValidator;
}

// The lifecycle entry that produced the composite's own WINNING decision, for HookDecision.hookId
// attribution — the earliest `outcome:"decision"` record whose OWN reported decision equals the
// composite's final one (reducer.ts's own "earliest of the final max rank" tie-break, so this is
// exactly the entry that set it).
function winningHookId(composite: { decision?: string; lifecycleMessages: Array<{ hookId: string; outcome: string; decision?: string }> }): string | undefined {
  if (composite.decision === undefined) return undefined;
  return composite.lifecycleMessages.find((m) => m.outcome === "decision" && m.decision === composite.decision)?.hookId;
}

export function createHookStage(deps: HookStageDeps): HookStage {
  return {
    async preToolUse(call: PermissionCall, ctx: EvaluationContext): Promise<HookDecision> {
      const composite = await runHooks(
        "PreToolUse",
        {
          ...(call.toolUseId !== undefined ? { toolUseID: call.toolUseId } : {}),
          toolName: call.toolName,
          input: call.input,
        },
        {
          registry: deps.registry,
          invoker: deps.invoker,
          audit: deps.audit,
          sessionId: deps.sessionId,
          policyVersion: ctx.policy.version,
          ...(deps.agentID !== undefined ? { agentID: deps.agentID } : call.agentId !== undefined ? { agentID: call.agentId } : {}),
          ...(deps.timeouts !== undefined ? { timeouts: deps.timeouts } : {}),
          ...(deps.validator !== undefined ? { validator: deps.validator } : {}),
        },
      );

      const hookId = winningHookId(composite);

      if (composite.decision === "deny") {
        return {
          decision: "deny",
          ...(hookId !== undefined ? { hookId } : {}),
          ...(composite.message !== undefined ? { message: composite.message } : {}),
          ...(composite.interrupt !== undefined ? { interrupt: composite.interrupt } : {}),
          ...(composite.transformedInput !== undefined ? { transformedInput: composite.transformedInput } : {}),
        };
      }

      if (composite.decision === "ask" || composite.decision === "defer") {
        // See this file's own header ("THE ask/defer GAP") for the full rationale.
        return {
          decision: "deny",
          ...(hookId !== undefined ? { hookId } : {}),
          message:
            `Denied: a PreToolUse hook requested interactive approval ("${composite.decision}"), but this phase's ` +
            `HookStage seam cannot yet force stage 1 to the prompt path -- failing closed (WS-07 §6.1: never ` +
            `implicitly allowed) pending a seam extension to a real interactive-routing outcome`,
          ...(composite.transformedInput !== undefined ? { transformedInput: composite.transformedInput } : {}),
        };
      }

      if (composite.decision === "allow") {
        return {
          decision: "allow",
          ...(hookId !== undefined ? { hookId } : {}),
          ...(composite.transformedInput !== undefined ? { transformedInput: composite.transformedInput } : {}),
        };
      }

      // No decision at all (every matched hook returned "none", a gating error/timeout, or nothing
      // matched) -- WS-07 §2.1: "an allow does not override ... " and symmetrically, "no opinion"
      // must never itself deny; the pipeline simply continues. A transform-only contribution still
      // survives (evaluate() applies `transformedInput` regardless of the decision branch it took).
      return {
        decision: "no_opinion",
        ...(composite.transformedInput !== undefined ? { transformedInput: composite.transformedInput } : {}),
      };
    },
  };
}
