// Phase 5 Lane C (task 6) -- the plan-mode body (WS-11 §6.6).
//
// §6.6 decomposes plan mode into three parts and makes exactly one of them customizable: a
// read-only TOOL POLICY (enforced by WS-07, not by prose), the PLAN INSTRUCTIONS, and the
// ExitPlanMode WORKFLOW. The host may replace the instruction body; the surrounding mechanics stay
// fixed. That is the shape rendered here: enforcement preamble, then the body (host's or Winter's),
// then the protocol footer.
//
// WHY THE MECHANICS ARE NOT CUSTOMIZABLE. The preamble describes a restriction the permission
// engine actually applies (`PLAN_WRITE_WITHHELD_MESSAGE`, permissions/evaluator.ts) and the footer
// describes a real tool's real contract. A host that could rewrite either could tell the model
// plan mode means something it does not mean, and the model would then be surprised by every
// denial. Only the middle -- what makes a GOOD plan for this host -- is opinion.
//
// THE WIRE SPELLING IS `planModeInstructions`. derived-shapes-p5 item (c) records the pinned
// control-channel field name (`SDKControlInitializeRequest.planModeInstructions`); the seam calls
// the same value `hostPlanBody` (context/seam.ts). One value, two names, mapped where the two
// layers meet -- T8's wiring, noted in the task-6 report.

/**
 * FIXED. States the restriction the permission engine enforces, so a denial is never a surprise.
 */
export const PLAN_MODE_ENFORCEMENT = [
  "This session is in PLAN MODE. Writes are withheld: file edits, file creation and state-changing shell commands are refused by the permission engine until the plan is approved. This is enforcement, not etiquette — attempting one wastes a turn and changes nothing.",
  "Reading is unrestricted. Investigate as thoroughly as the plan needs: read files, search, run read-only commands, and inspect whatever settles an open question.",
].join("\n\n");

/**
 * REPLACEABLE. Winter's own answer to "what makes a good plan", used when the host supplies none.
 */
export const DEFAULT_PLAN_BODY = [
  "Produce a plan the user can approve or correct without having to guess what you intend.",
  "Ground it in what you actually found. A plan that names the real files, the real functions and the real call sites is reviewable; one written from assumption is a proposal to find out later.",
  "Say what will change and where, in the order it will happen, and name anything you deliberately are NOT changing when a reader might expect otherwise.",
  "Call out the parts that are irreversible, that touch data, or that you are least sure about — those are the parts the user is being asked to approve.",
  "Keep it proportionate. A one-file change needs a short paragraph, not a document; a migration needs the detail.",
  "If investigation shows the request cannot work as stated, say so and propose the alternative instead of planning around the problem.",
].join("\n\n");

/** FIXED. The ExitPlanMode contract, plus where a written plan belongs. */
export const PLAN_MODE_PROTOCOL = [
  "When the plan is ready, present it and call the `ExitPlanMode` tool with it. Do not begin implementing first: leaving plan mode is the user's decision, and the tool call is how you ask for it.",
  "If the user responds with corrections rather than approval, revise the plan and ask again — you are still in plan mode until they say otherwise.",
].join("\n\n");

export interface PlanModeInput {
  /** Where a plan file belongs when one is written. `RuntimeConfig.plansDirectory` / `Settings.plansDirectory`, default `.winter/plans`. */
  plansDirectory: string;
  /** The host's replacement for the middle section (`planModeInstructions` on the wire). Whitespace-only counts as absent. */
  hostPlanBody?: string;
}

export function renderPlanModeBlock(input: PlanModeInput): string {
  const host = input.hostPlanBody?.trim();
  const body = host === undefined || host.length === 0 ? DEFAULT_PLAN_BODY : host;
  return [
    "## Plan mode",
    PLAN_MODE_ENFORCEMENT,
    body,
    PLAN_MODE_PROTOCOL,
    `If the user asks for the plan as a file, write it under ${input.plansDirectory}.`,
  ].join("\n\n");
}
