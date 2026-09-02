// Task 8 (WS-07 §7): the REAL PromptStage — fills the seam T6 stubbed as NO_OPINION_PROMPT_STAGE.
// Bridges evaluate()'s stage-6/mandatory-interaction/mustPrompt call sites to a runtime-originated
// "permission" control_request (WS-04 §3's own row: "the full canUseTool argument set"; "No park
// timeout: a pending permission RPC MAY wait indefinitely") over rpc/bridge.ts's RpcBridge, and maps
// the host's PermissionResult (or a rejected/absent answer) back to this module's own PromptDecision
// seam shape.
//
// What this file builds INTO the wire payload, and why each field lives here rather than in
// evaluator.ts's PromptStageMeta (see that interface's own header for the split):
//   - toolName/input:      straight from `call` — the effective (possibly hook-transformed) call.
//   - decisionReason:      straight from `meta.decisionReason` — evaluator.ts already computed it.
//   - blockedPath:         straight from `meta.blockedPath`, when T7's protected-write check forced
//                          this prompt. Absent for critical-removal (see PromptStageMeta's header)
//                          and for the mandatory-interaction/generic-fallback paths.
//   - matchedAskRule:      straight from `meta.matchedAskRule`, verbatim (bare `RuleSource` widens
//                          fine to CanUseTool's own `source: string` field, WS-07 §7.1).
//   - suggestions:         WINTER-BUILT here (not evaluator.ts's job — it's a wire/UI concern, not a
//                          policy decision) — "a matching ask rule yields an addRules suggestion
//                          shape" (task instruction, verbatim): ONLY when `matchedAskRule` is
//                          present, one `addRules` PermissionUpdate proposing the exact matched rule
//                          as a future allow, `destination: "session"`. Judgment call (flagged in the
//                          report): "session" is the safe default that can never silently write a
//                          settings file — a host that wants a persisted "always allow" echoes this
//                          suggestion back with a different destination via `updatedPermissions`,
//                          which this module applies verbatim (policy-state.ts's own authority gate
//                          decides whether that destination write is actually permitted).
//   - toolUseID:           `call.toolUseId` — always present in production (engine.ts's tool loop
//                          always sets it from the real tool_use call id); the pinned wire shape
//                          requires a non-optional string, so an absent id (unreachable via engine.ts,
//                          only a theoretical direct-evaluate() caller) falls back to "" rather than
//                          widening the wire type to optional.
//   - agentID:             `call.agentId`, when present (absent at P2 — no subagents yet).
//   - requestId:            minted HERE, per request — this is the bridge-correlation id, distinct
//                          from any tool-call id.
//   - policyVersion:       `ctx.policy.version` — the SAME snapshot stamp evaluate() itself uses for
//                          its own stale-policy re-evaluation loop (WS-07 §2); a host may echo it
//                          back for its own staleness checks, though at P2 nothing consumes it
//                          host-side (Winter's own consumer is engine.ts's evaluateWithFreshPolicy).
//   - signal/title/displayName/description: NOT part of this wire payload at all — `signal` is
//                          wrapper-local (query.ts mints its own AbortController per request);
//                          title/displayName/description need a tool registry (WS-06, P3) this
//                          runtime doesn't have yet — see PromptStageMeta's own header.
//
// The `null` "no opinion" contract (evaluate()'s own per-call-site handling, WS-07 §6.1/§7.1): this
// stage returns null whenever `bridge.request` REJECTS, for ANY reason — no handler registered
// host-side (the ordinary "no canUseTool configured" case, WS-04 §3.1's unknown-subtype/unhandled
// fallback), a connection torn down mid-request, or any other transport-level failure. It never
// distinguishes these — evaluate()'s own fail-closed-on-null handling (Ruling P2-I) is what turns
// "no opinion" into a denial, uniformly, regardless of why the opinion was unavailable. A resolved
// (non-rejected) response is ALWAYS a well-formed PermissionResult by the time it reaches here —
// query.ts's own permission handler (sdk/src/query.ts) guarantees this: a throwing/accidentally-null
// callback is converted to a typed deny PermissionResult AT THE WRAPPER, never surfaced as a bridge
// rejection.
import { randomUUID } from "node:crypto";
import type { PermissionRequestPayload, PermissionResult, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import type { RpcBridge } from "../rpc/bridge.ts";
import type { PermissionCall, EvaluationContext, PromptStage, PromptStageMeta, PromptDecision } from "./evaluator.ts";

function buildSuggestions(meta: PromptStageMeta): PermissionUpdate[] | undefined {
  if (!meta.matchedAskRule) return undefined;
  const { toolName, ruleContent } = meta.matchedAskRule;
  return [
    {
      type: "addRules",
      rules: [{ toolName, ...(ruleContent !== undefined ? { ruleContent } : {}) }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

function buildPayload(call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta, requestId: string): PermissionRequestPayload {
  const suggestions = buildSuggestions(meta);
  return {
    toolName: call.toolName,
    input: call.input,
    ...(suggestions !== undefined ? { suggestions } : {}),
    ...(meta.blockedPath !== undefined ? { blockedPath: meta.blockedPath } : {}),
    decisionReason: meta.decisionReason,
    // title/displayName/description omitted: no tool registry at P2 (see this file's own header).
    toolUseID: call.toolUseId ?? "",
    ...(call.agentId !== undefined ? { agentID: call.agentId } : {}),
    requestId,
    ...(meta.matchedAskRule !== undefined ? { matchedAskRule: meta.matchedAskRule } : {}),
    policyVersion: ctx.policy.version,
  };
}

function toPromptDecision(result: PermissionResult): PromptDecision {
  if (result.behavior === "allow") {
    return {
      decision: "allow",
      ...(result.updatedInput !== undefined ? { transformedInput: result.updatedInput } : {}),
      ...(result.updatedPermissions !== undefined ? { updatedPermissions: result.updatedPermissions } : {}),
      ...(result.decisionClassification !== undefined ? { decisionClassification: result.decisionClassification } : {}),
    };
  }
  return {
    decision: "deny",
    message: result.message,
    ...(result.interrupt !== undefined ? { interrupt: result.interrupt } : {}),
    ...(result.decisionClassification !== undefined ? { decisionClassification: result.decisionClassification } : {}),
  };
}

export function createBridgePromptStage(bridge: RpcBridge): PromptStage {
  return {
    async prompt(call: PermissionCall, ctx: EvaluationContext, meta: PromptStageMeta): Promise<PromptDecision | null> {
      const requestId = randomUUID();
      const payload = buildPayload(call, ctx, meta, requestId);
      let result: PermissionResult;
      try {
        // WS-04 §3: NO `opts.timeoutMs` — the permission RPC has no park timeout by design.
        result = await bridge.request<PermissionResult>("permission", payload);
      } catch {
        return null; // genuinely no opinion — see this file's own header for every reason this fires
      }
      return toPromptDecision(result);
    },
  };
}
