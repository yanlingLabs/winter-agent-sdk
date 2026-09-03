// Task 7 (LANE E, WS-06 §3.3 "ExitPlanMode"): open schema (`allowedPrompts?` deprecated+ignored,
// `[key: string]: unknown` stays open -- descriptors/exit-plan-mode.ts already pins this). ExitPlanMode
// IS permission-gated (WS-06 §1.4's `mode`-class note, unlike EnterPlanMode): the call reaches this
// executor only after the STANDING evaluator (WS-07 §2's six-stage pipeline) has already resolved it
// to "allow" -- engine.ts's own dispatch loop computes `decision` via `evaluate()` and only THEN calls
// `tools.execute(executedCall)` (engine.ts, the round loop) -- so **if this executor runs, the exit
// was approved**; this file re-implements NONE of that gating.
//
// P2 ruling 6 (docs/superpowers/plans/2026-09-02-winter-phase-02-permissions-hooks.md line 31/113,
// carried forward by docs/superpowers/plans/2026-09-03-winter-phase-02-completion-report.md line 55):
// "Plan mode in P2 = evaluation semantics only (write-withholding, ...); the ExitPlanMode tool +
// approval-transition lifecycle land in P3 with the tool catalog." The evaluator's own plan-mode
// write-withholding (permissions/evaluator.ts) is UNTOUCHED by this file -- this executor owns only
// the LIFECYCLE half: flipping the live mode back out of plan once an exit has been approved, via the
// SAME `ctx.session.setPermissionMode` seam EnterPlanMode uses (never engine.ts directly).
import "../descriptors/exit-plan-mode.ts"; // self-sufficiency: guarantees the "ExitPlanMode" stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";

export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export const exitPlanModeExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    // The schema is deliberately open ([key: string]: unknown) -- real Claude Code's own ExitPlanMode
    // input commonly carries a `plan` string (the plan text the model is submitting) and sometimes a
    // `planFilePath`, but WS-06 §3.3's pinned code block does NOT list either as a named field (only
    // the deprecated, ignored `allowedPrompts`). Per this file's own "MUST NOT invent, rename, or
    // re-type fields" constraint on the INPUT schema, these are read ONLY as an opportunistic
    // echo-if-present passthrough -- never required, never validated, never used to drive control
    // flow -- exactly the brief's own "plan text if provided via input, plan-file path when one
    // exists" phrasing.
    const record = asRecord(input);
    const plan = optionalString(record.plan);
    const planFilePath = optionalString(record.planFilePath);

    // RULING P3-H (Task 8, P3 close-out): CLOSES the T8 flag this file's header used to carry.
    // Lane E's reviewer found the previous unconditional `setPermissionMode("default")` clobbers a
    // mode the HOST already applied via a canUseTool `updatedPermissions` suggestion — engine.ts
    // applies suggested updates to the LIVE policy BEFORE calling tools.execute() for the now-
    // approved call (engine.ts's own "Task 8 (WS-07 §7.2)" comment: "Applied BEFORE executing this
    // call"), so by the time THIS executor runs, the live mode may already have moved to whatever
    // the plan-approval flow itself chose (e.g. straight to "acceptEdits") — not "plan" anymore.
    // `ctx.session.getPermissionMode()` (registry.ts) is the newly-added getter that lets this
    // executor tell the two cases apart: flip to "default" ONLY when the live mode is STILL
    // literally "plan" (nobody else already moved it); otherwise leave the host's own choice alone.
    // `previousMode` in the result is always the OBSERVED value from the getter — never a hardcoded
    // "plan" literal — so a caller can tell, from the result alone, whether this executor's own flip
    // fired or the mode had already moved before it ran.
    const observedMode = ctx.session.getPermissionMode();
    const stillInPlan = observedMode === "plan";
    const newMode = stillInPlan ? "default" : observedMode;
    if (stillInPlan) {
      try {
        ctx.session.setPermissionMode(newMode);
      } catch (err) {
        // KNOWN FLAG -- see enter-plan-mode.ts's identical comment for the full mechanism
        // (WinterPermissionError from the bypass gate). Unreachable here too: this executor never
        // requests "bypassPermissions". Wrapped defensively for the same reason: a legible tool
        // error, never an uncaught rejection promoted to a whole-round `error_during_execution`.
        return {
          output: `Error: ExitPlanMode failed to restore the session's permission mode: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }

    // Result fields deliberately OMITTED, with reasons (WS-06 §3.3 prose: "Result: plan, plan file
    // path, agent flag, edit state, leader-approval data"):
    //   - "agent flag" / "edit state" / "leader-approval data" are Claude Code's own multi-agent
    //     leader-election / concurrent-edit-tracking concepts. Winter has built NO such subsystem at
    //     P3 (no leader election, no cross-agent edit-state tracking exists anywhere in this runtime
    //     yet) -- inventing placeholder values for concepts with no real backing meaning would be
    //     worse than omitting them outright. This is a deliberate simplification, not an oversight.
    return {
      output: JSON.stringify({
        previousMode: observedMode,
        newMode,
        ...(plan !== undefined ? { plan } : {}),
        ...(planFilePath !== undefined ? { planFilePath } : {}),
        message: stillInPlan
          ? `Plan approved; permission mode restored to "${newMode}".`
          : `Plan approved; permission mode already moved to "${observedMode}" (by a canUseTool/hook updatedPermissions suggestion applied before this executor ran) -- left unchanged.`,
      }),
    };
  },
};

replaceExecutor(EXIT_PLAN_MODE_TOOL_NAME, exitPlanModeExecutor);
