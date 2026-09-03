// WS-06 §3.4 "ReportFindings" -- the real executor (Phase 3, Lane D / Task 6). Registers over the
// stub descriptor descriptors/report-findings.ts already in the registry. "A structured review
// result channel, not a scanner; fully cloneable (local value only)" -- this executor's entire job is
// validating the pinned finding shape and handing the model back exactly what it sent; it never
// inspects `file`/`line` against the real filesystem, never independently verifies a finding, and
// keeps no state across calls (no store module, no session-scoping -- there is nothing to remember).
//
// *** T8 SCHEMA-SWEEP NOTE (report in task-6-report.md) ***
// WS-06 §3.4 pins ReportFindings' INPUT shape verbatim but gives no "Result: ..." field list at all
// (contrast TaskCreate/CronCreate/ScheduleWakeup, which all get one) -- only the lane brief's own
// gloss, "echo-shaped result." Minimal, least-invented reading: the result IS the validated input,
// echoed back verbatim -- `{level?, findings}`, `level` omitted exactly when it was absent (the
// descriptor's own inputSchema marks it optional; no default value is invented here since WS-06
// names none). No added `count`/`accepted`/`receivedAt` field -- anything beyond a literal echo
// would be this file inventing a field WS-06's own top-of-§3 rule ("Winter MUST NOT invent, rename,
// or re-type fields") is written to guard against, even though that rule is phrased for PINNED
// shapes and this one is unpinned; the spirit still argues for restraint over embellishment.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
// Self-sufficiency (Lane A precedent, read.ts): see task-graph.ts's identical comment.
import "../descriptors/index.ts";

const MAX_FINDINGS = 32;
const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LEVELS)[number];
const VERDICTS = ["CONFIRMED", "PLAUSIBLE"] as const;
type Verdict = (typeof VERDICTS)[number];
const OUTCOMES = ["fixed", "skipped", "no_change_needed"] as const;
type Outcome = (typeof OUTCOMES)[number];

interface Finding {
  file: string;
  line?: number;
  summary: string;
  short_summary?: string;
  failure_scenario: string;
  category?: string;
  verdict?: Verdict;
  outcome?: Outcome;
}

interface ReportFindingsInput {
  level?: Level;
  findings: Finding[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseFinding(raw: unknown, index: number): Finding {
  if (!isPlainObject(raw)) throw new Error(`findings[${index}] must be an object`);

  const file = raw["file"];
  if (typeof file !== "string" || file.length === 0) throw new Error(`findings[${index}].file must be a non-empty string`);
  const summary = raw["summary"];
  if (typeof summary !== "string" || summary.length === 0) throw new Error(`findings[${index}].summary must be a non-empty string`);
  const failureScenario = raw["failure_scenario"];
  if (typeof failureScenario !== "string" || failureScenario.length === 0) {
    throw new Error(`findings[${index}].failure_scenario must be a non-empty string`);
  }

  const line = raw["line"];
  if (line !== undefined && typeof line !== "number") throw new Error(`findings[${index}].line must be a number`);
  const shortSummary = raw["short_summary"];
  if (shortSummary !== undefined && typeof shortSummary !== "string") throw new Error(`findings[${index}].short_summary must be a string`);
  const category = raw["category"];
  if (category !== undefined && typeof category !== "string") throw new Error(`findings[${index}].category must be a string`);

  const verdict = raw["verdict"];
  if (verdict !== undefined && (typeof verdict !== "string" || !VERDICTS.includes(verdict as Verdict))) {
    throw new Error(`findings[${index}].verdict must be one of ${VERDICTS.join(", ")} (got ${JSON.stringify(verdict)})`);
  }
  const outcome = raw["outcome"];
  if (outcome !== undefined && (typeof outcome !== "string" || !OUTCOMES.includes(outcome as Outcome))) {
    throw new Error(`findings[${index}].outcome must be one of ${OUTCOMES.join(", ")} (got ${JSON.stringify(outcome)})`);
  }

  return {
    file,
    summary,
    failure_scenario: failureScenario,
    ...(line !== undefined ? { line } : {}),
    ...(shortSummary !== undefined ? { short_summary: shortSummary } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(verdict !== undefined ? { verdict: verdict as Verdict } : {}),
    ...(outcome !== undefined ? { outcome: outcome as Outcome } : {}),
  };
}

function parseInput(raw: unknown): ReportFindingsInput {
  if (!isPlainObject(raw)) throw new Error("input must be an object");

  const level = raw["level"];
  if (level !== undefined && (typeof level !== "string" || !LEVELS.includes(level as Level))) {
    throw new Error(`level must be one of ${LEVELS.join(", ")} (got ${JSON.stringify(level)})`);
  }

  const findingsRaw = raw["findings"];
  if (!Array.isArray(findingsRaw)) throw new Error("findings must be an array");
  if (findingsRaw.length > MAX_FINDINGS) throw new Error(`findings must contain at most ${MAX_FINDINGS} items (got ${findingsRaw.length})`);
  const findings = findingsRaw.map((f, i) => parseFinding(f, i));

  return {
    findings,
    ...(level !== undefined ? { level: level as Level } : {}),
  };
}

async function execute(rawInput: unknown, _ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: ReportFindingsInput;
  try {
    input = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }
  // Echo-shaped: the validated, normalized input handed straight back (T8 note above).
  return {
    output: JSON.stringify({
      findings: input.findings,
      ...(input.level !== undefined ? { level: input.level } : {}),
    }),
  };
}

replaceExecutor("ReportFindings", { execute } satisfies ToolExecutor);
