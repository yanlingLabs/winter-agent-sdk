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

    // T8 FLAG (task-7 brief, explicit): the semantically correct target is "whatever permission mode
    // was active immediately before EnterPlanMode ran", but ToolExecutionContext (registry.ts) has no
    // mode GETTER at all -- `session` is a write-only posture-mutation seam (setCwd/addBoundedRoot/
    // setPermissionMode), and no other field on ToolExecutionContext records the prior mode either.
    // "default" is used as the documented restoration target until a later phase threads the real
    // prior mode through (e.g. a `session.getPermissionMode()` addition, or a value carried on
    // ToolExecutionContext itself) -- this is a carry, not a guess: "default" is the engine's own
    // documented pre-session-start default (permissions/policy-state.ts's assertKnownPermissionMode),
    // so a plan that was entered from the ordinary starting mode round-trips correctly; a plan entered
    // from `acceptEdits`/`auto`/`dontAsk` does NOT round-trip to its own prior mode at this phase.
    const newMode = "default";
    try {
      ctx.session.setPermissionMode(newMode);
    } catch (err) {
      // KNOWN FLAG -- see enter-plan-mode.ts's identical comment for the full mechanism
      // (WinterPermissionError from the bypass gate). Unreachable here too: this executor never
      // requests "bypassPermissions". Wrapped defensively for the same reason: a legible tool error,
      // never an uncaught rejection promoted to a whole-round `error_during_execution`.
      return {
        output: `Error: ExitPlanMode failed to restore the session's permission mode: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
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
        previousMode: "plan",
        newMode,
        ...(plan !== undefined ? { plan } : {}),
        ...(planFilePath !== undefined ? { planFilePath } : {}),
        message: `Plan approved; permission mode restored to "${newMode}" (Winter does not yet track the pre-plan mode -- see the T8 flag in this file's own header).`,
      }),
    };
  },
};

replaceExecutor(EXIT_PLAN_MODE_TOOL_NAME, exitPlanModeExecutor);
