// Task 7 (LANE E, WS-06 §3.3 "EnterPlanMode"): `{}` -- switches the session to plan mode; a posture
// change, not a prompt hint (report §40.10). Unlike its ExitPlanMode sibling, EnterPlanMode carries
// NO permission gate of its own: WS-06 §1.4's `mode`-class note singles out "ExitPlanMode and
// EnterWorktree are permission-gated," conspicuously omitting EnterPlanMode, and WS-07 nowhere
// routes entering plan mode through canUseTool. So nothing upstream of this executor has already
// decided anything -- every call that reaches here performs the mode switch itself, in full.
//
// KNOWN FLAG (task-7 brief, inherited from the T1 fix-round ledger note "session.setPermissionMode
// throws on bypass-gate rejection"): ToolExecutionContext.session.setPermissionMode (engine.ts) can
// re-throw PolicyStateStore#setMode's WinterPermissionError when the bypass gate rejects a switch
// (permissions/policy-state.ts's checkBypassGate). That gate only ever fires for
// `mode === "bypassPermissions"` -- this executor always requests "plan", so the throw is
// UNREACHABLE on every call it will ever make. It is still wrapped in try/catch, on the brief's own
// instruction: an uncaught throw here would reject this tool call's promise and surface at
// engine.ts's round level as `error_during_execution` (Ruling P1-H) -- the wrong severity for what
// would still just be one failed tool call -- instead of a legible, model-visible tool_result error.
// Should a later phase ever widen the bypass gate to cover another mode, this defensive wrap is what
// keeps that a contained tool error instead of a new class of uncaught-exception failure.
import "../descriptors/enter-plan-mode.ts"; // self-sufficiency: guarantees the "EnterPlanMode" stub is registered before replaceExecutor runs below, regardless of what a consumer imports first.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";

export const enterPlanModeExecutor: ToolExecutor = {
  // Input is ignored outright (schema `{}`, task-7 review: "EnterPlanMode stays lenient on input")
  // -- there is nothing to validate, and rejecting an unexpected extra property here would be
  // pedantry the spec never asks for.
  async execute(_input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    try {
      ctx.session.setPermissionMode("plan");
    } catch (err) {
      return {
        output: `Error: EnterPlanMode failed to switch the session's permission mode: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    // "a minimal honest acknowledgment shape" (task-7 brief) -- WS-06 pins no result fields for
    // EnterPlanMode at all (unlike ExitPlanMode, which at least has prose fields to echo), so this
    // shape is a Lane E judgment call, flagged for T8's cross-tool result-shape sweep.
    return { output: JSON.stringify({ mode: "plan", message: "Permission mode switched to plan." }) };
  },
};

replaceExecutor(ENTER_PLAN_MODE_TOOL_NAME, enterPlanModeExecutor);
