// Task 9: `createHookStage` — the adapter that fills evaluator.ts's stage-1 `HookStage` seam
// (T6-authored, packages/runtime/src/permissions/evaluator.ts) with this phase's real
// registry+reducer+runner, WITHOUT modifying evaluator.ts itself. Its own seam-contract comment
// already anticipates exactly this: "T9's real multi-hook reducer composes several hooks into ONE
// HookDecision before this seam is even called; this interface is the reducer's OUTPUT shape" — the
// seam was designed to be filled, not reshaped, and this file is that fill.
//
// *** T10-CARRY 1 (WS-08 §3): the "ask" gap is CLOSED ***
// T9 left `composite.decision === "ask"` mapped to seam `"deny"` — fail-closed, because
// evaluator.ts's `HookDecision.decision` had no fourth "force the interactive path" outcome. T10
// extends `HookDecision` with a real `"ask"` value (evaluator.ts's own header) and evaluate() now
// routes it into stage 3's prompt path exactly like a matched ask rule — so `composite.decision ===
// "ask"` maps to seam `"ask"` here, genuinely forcing interactive approval instead of silently
// failing the call closed.
//
// *** Task 11 (WS-08 §7): the "defer" gap is CLOSED too ***
// runner.ts no longer resolves a raw PreToolUse `defer` to `ask` (that interim resolution is
// retired — see runner.ts's own updated header). `composite.decision === "defer"` is now genuinely
// REACHABLE via this adapter's real pipeline and maps to seam `"defer"` — evaluator.ts's own
// HookDecision union gained a real "defer" member for exactly this (see that file's own header for
// how evaluate() resolves it: it outranks a matched ask rule, loses to a stage-2 deny rule, and
// dontAsk converts it to an immediate denial before any durable record is created).
import type { PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import type { PermissionCall, EvaluationContext, HookStage, HookDecision, PromptStageMeta, PermissionRequestHookDecision } from "../permissions/evaluator.ts";
import { runHooks, type HookInvoker, type HookAuditRecorder, type HookTimeoutConfig, type ToolInputValidator, type HookLifecycleSink } from "./runner.ts";
import type { HookRegistry } from "./registry.ts";

export interface HookStageDeps {
  registry: HookRegistry;
  invoker: HookInvoker;
  audit: HookAuditRecorder;
  sessionId: string;
  agentID?: string;
  timeouts?: HookTimeoutConfig;
  validator?: ToolInputValidator;
  // T10 (WS-08 §9): forwarded verbatim into every runHooks() call this adapter makes (PreToolUse
  // AND PermissionRequest) — see runner.ts's own HookLifecycleSink header for the gating contract.
  lifecycle?: HookLifecycleSink;
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
          ...(deps.lifecycle !== undefined ? { lifecycle: deps.lifecycle } : {}),
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

      if (composite.decision === "ask") {
        // T10-CARRY 1: genuinely forces stage 3's prompt path now (evaluator.ts's own stage-1
        // comment) — no longer a fail-closed denial.
        return {
          decision: "ask",
          ...(hookId !== undefined ? { hookId } : {}),
          ...(composite.message !== undefined ? { message: composite.message } : {}),
          ...(composite.transformedInput !== undefined ? { transformedInput: composite.transformedInput } : {}),
        };
      }

      if (composite.decision === "defer") {
        // Task 11: genuinely forces the durable-approval park now (evaluator.ts's own stage-1
        // comment) — no longer a fail-closed denial. See this file's own header for the full story.
        return {
          decision: "defer",
          ...(hookId !== undefined ? { hookId } : {}),
          ...(composite.message !== undefined ? { message: composite.message } : {}),
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

    // T10 (WS-08 §6): fires immediately before every promptStage.prompt() call site in
    // evaluator.ts. Reuses the SAME general registry/reducer/runner machinery as preToolUse above,
    // for the "PermissionRequest" event instead of "PreToolUse" -- runner.ts's own dedicated
    // interpretPermissionRequest interpreter is what this event's narrower (allow/deny only, no
    // ask/defer -- T9-CARRY-3) pinned shape needs; without it the generic interpreter would silently
    // read only `additionalContext` and every hook answer would resolve to "no opinion" (the T9
    // review's own under-enforcement trap).
    async permissionRequest(call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta): Promise<PermissionRequestHookDecision | null> {
      // Mirrors prompt-stage.ts's own buildSuggestions exactly (WS-07 §7.1's "a matching ask rule
      // yields an addRules suggestion shape") -- a small, deliberate duplication rather than an
      // export from that module, since PromptStage and HookStage are separate seams with no shared
      // base; `destination: "session"` for the identical reason prompt-stage.ts picks it (never
      // silently writes a settings file — policy-state.ts's own authority gate still governs any
      // `updatedPermissions` a PermissionRequest hook echoes back with a different destination).
      const permissionSuggestions: PermissionUpdate[] | undefined = meta.matchedAskRule
        ? [
            {
              type: "addRules",
              rules: [
                {
                  toolName: meta.matchedAskRule.toolName,
                  ...(meta.matchedAskRule.ruleContent !== undefined ? { ruleContent: meta.matchedAskRule.ruleContent } : {}),
                },
              ],
              behavior: "allow",
              destination: "session",
            },
          ]
        : undefined;

      const composite = await runHooks(
        "PermissionRequest",
        {
          ...(call.toolUseId !== undefined ? { toolUseID: call.toolUseId } : {}),
          toolName: call.toolName,
          input: call.input,
          ...(permissionSuggestions !== undefined ? { payload: { permission_suggestions: permissionSuggestions } } : {}),
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
          ...(deps.lifecycle !== undefined ? { lifecycle: deps.lifecycle } : {}),
        },
      );

      const hookId = winningHookId(composite);
      if (composite.decision === "deny") {
        return {
          decision: "deny",
          ...(hookId !== undefined ? { hookId } : {}),
          ...(composite.message !== undefined ? { message: composite.message } : {}),
          ...(composite.interrupt !== undefined ? { interrupt: composite.interrupt } : {}),
        };
      }
      if (composite.decision === "allow") {
        return {
          decision: "allow",
          ...(hookId !== undefined ? { hookId } : {}),
          ...(composite.transformedInput !== undefined ? { transformedInput: composite.transformedInput } : {}),
          ...(composite.updatedPermissions !== undefined ? { updatedPermissions: composite.updatedPermissions } : {}),
        };
      }
      // No opinion (nothing matched, or every matched hook returned "none"/errored/timed out) --
      // or, defensively, an "ask"/"defer" value that CANNOT actually occur here (runner.ts's
      // interpretPermissionRequest only ever produces "allow"/"deny" decisions, or {kind:"error"}
      // for anything else, per WS-08 §6's own pinned no-ask/no-defer shape, T9-CARRY-3). Either way,
      // null means "evaluate() falls through to the real promptStage/canUseTool" -- never a silent
      // allow or deny.
      return null;
    },
  };
}
