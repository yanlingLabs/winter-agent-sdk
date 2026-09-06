// Phase 6 Task 8 (Lane D, R6-14 / WS-07 §10.6-5): the classifier's STRICT result contract.
//
// WS-07 §10.6-5 states the whole of it: `{ verdict: "allow" | "deny" | "no_verdict", category,
// severity, reasonCode, auditReason }`, and "extra/unparseable output, timeout, refusal, transport
// failure → `no_verdict` → fail closed". This file owns the first half of that sentence — the schema
// and the parse — and `model-classifier.ts` owns the second.
//
// THE SCHEMA IS THE TOOL'S INPUT SCHEMA, not a post-hoc validator bolted onto free text. The
// classifier makes exactly ONE forced tool call (`toolChoice: { type: "tool", name:
// "classifier_verdict" }`), and this object is that tool's `inputSchema`, so the strictness is
// asserted at the provider's own structured-output layer AND re-checked here. Re-checking is not
// redundant: `toolChoice` is a request, a family's structured-output enforcement varies by model
// (which is exactly what `structuredOutput.confidence` in the catalog records), and a reviewer that
// is trusted to make a security decision is not trusted to have obeyed a schema.
//
// EVERY STRING IS LENGTH-CAPPED, `auditReason` most of all. It is the one free-prose field, it flows
// into the private audit journal (`AutoAuditRecord.auditReason`), and a model can be induced to echo
// the action envelope — including whatever hostile text the envelope carried — straight back into
// it. An over-length value fails the schema and therefore collapses to `no_verdict`: §10.6-5's own
// "extra/unparseable output" arm, applied to size.
import Ajv, { type ValidateFunction } from "ajv";
import type { ClassifierRawResult } from "../../permissions/auto/engine.ts";
import type { ProviderToolSpec } from "../../engine.ts";

/** The one tool the classifier is allowed to call, and the one it is FORCED to call. */
export const CLASSIFIER_TOOL_NAME = "classifier_verdict";

/**
 * Length caps, stated once and used by both the schema and the report.
 *
 * `category`/`severity`/`reasonCode` are vocabulary slots — a value longer than this is prose in a
 * slot that is not for prose. `auditReason` is prose, so its cap is the real one: it bounds how much
 * of a hostile envelope a compromised reviewer can launder into the audit stream in a single call.
 */
export const CLASSIFIER_FIELD_CAPS = { category: 64, severity: 32, reasonCode: 64, auditReason: 1024 } as const;

/**
 * The verdict schema — draft-07, closed.
 *
 * `additionalProperties: false` is load-bearing, and it is the "extra output" half of §10.6-5:
 * a reviewer that returns a field nobody asked for has not answered the question it was asked, and
 * the safe reading of an unrecognised field is that the answer is not one this engine understands.
 */
export const CLASSIFIER_VERDICT_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["allow", "deny", "no_verdict"] },
    category: { type: "string", maxLength: CLASSIFIER_FIELD_CAPS.category },
    severity: { type: "string", maxLength: CLASSIFIER_FIELD_CAPS.severity },
    reasonCode: { type: "string", maxLength: CLASSIFIER_FIELD_CAPS.reasonCode },
    auditReason: { type: "string", maxLength: CLASSIFIER_FIELD_CAPS.auditReason },
  },
};

/**
 * Every way this classifier can fail to obtain a verdict, as a CLOSED vocabulary.
 *
 * A closed union rather than free strings because these codes reach `AutoAuditRecord.reasonCode` and
 * are the only evidence a reader has for WHY auto mode failed closed on a given action. "It returned
 * no_verdict" is not a diagnosis; "the model answered with prose instead of calling the tool" and
 * "the request timed out" call for opposite responses.
 */
export const CLASSIFIER_NO_VERDICT_REASONS = [
  /** The turn carried text and no tool call at all — the forced choice was not honoured. */
  "no_tool_call",
  /** More than one call in a turn that may contain exactly one: which one is the verdict is unanswerable. */
  "multiple_calls",
  /** A call to something other than `classifier_verdict`. */
  "wrong_tool",
  /** The provider reported `stopReason: "refusal"` — §10.6-5's "safety refusal" arm. */
  "refusal",
  /** The generation threw: transport, auth, resolution, a typed `ProviderTurnError`, anything. */
  "provider_error",
  /** `timeoutMs` elapsed before the generation resolved. */
  "timeout",
  /** The tool call arrived but its input does not satisfy the verdict schema. */
  "schema_invalid",
] as const;

export type ClassifierNoVerdictReason = (typeof CLASSIFIER_NO_VERDICT_REASONS)[number];

/**
 * The namespace every MODEL-AUTHORED `reasonCode` is stamped with on its way out of the parse.
 *
 * Review round 1, I2. The vocabulary above is closed, and the whole point of it being closed is that
 * a reader of the audit journal can tell WHY a review failed — the engine writes `reasonCode`
 * straight onto `AutoAuditRecord` (`permissions/auto/engine.ts`), which is a frozen file this lane
 * cannot change. But `reasonCode` is also a field the MODEL fills in, constrained only by
 * `{ type: "string", maxLength: 64 }`. A model answering `{ verdict: "no_verdict", reasonCode:
 * "timeout" }` would therefore be byte-identical, in the audit, to a genuine transport timeout —
 * a reviewer able to forge the transcript of its own supervision.
 *
 * Namespacing on the way out closes that at the one seam both paths cross: Winter's own codes stay
 * bare (they are what `noVerdict()` produces), and anything the model said is unambiguously the
 * model's. A fixture asserts the closed vocabulary contains no `model:` entry, so the two spaces
 * cannot collide by accident later either.
 */
export const MODEL_REASON_CODE_PREFIX = "model:";

/** The fail-closed answer, built in ONE place so every arm of the collapse produces the identical shape. */
export function noVerdict(reasonCode: ClassifierNoVerdictReason): ClassifierRawResult {
  return { verdict: "no_verdict", reasonCode };
}

/**
 * The tool spec the request advertises.
 *
 * A FUNCTION returning a fresh object rather than a shared const: `ProviderRequest.tools` reaches an
 * adapter that may serialise, decorate or (in a test double) mutate it, and one shared mutable
 * schema object living for the life of the process is the kind of shared state that produces a bug
 * nobody can reproduce.
 */
export function classifierVerdictToolSpec(): ProviderToolSpec {
  return {
    name: CLASSIFIER_TOOL_NAME,
    // Winter-authored, and deliberately mechanical: the description tells the reviewer what the
    // fields MEAN, never what to decide. Policy lives in the prompt's rule block, which is data the
    // caller supplies, not text baked into a tool description.
    description:
      "Record the review verdict for the single pending action described in the data blocks. " +
      "Call this exactly once. `verdict` is `allow` when the action is within the stated rules, " +
      "`deny` when it is not, and `no_verdict` when the data given is insufficient to decide. " +
      "`category` names the rule class involved, `severity` how serious a wrong allow would be, " +
      "`reasonCode` a short stable token, and `auditReason` one sentence for the private audit log.",
    // `structuredClone`, not a spread (review round 1, minor 4). A spread copies the TOP level and
    // shares `properties` by reference, so an adapter that decorated `properties.verdict` would be
    // editing the module constant every later review is built from — a shared-mutable-state bug that
    // would surface as one session's schema change silently applying to every subsequent one.
    inputSchema: structuredClone(CLASSIFIER_VERDICT_SCHEMA),
  };
}

// ONE compiled validator for the life of the module. The schema is a module constant, so compiling
// per call would re-parse the same object on every permission decision in every session.
//
// `strict: false` matches `structured/validator.ts`'s own reasoning and is inert here (this schema
// uses no vendor extensions) — it is set so a later addition to the schema cannot turn a compile
// warning into a thrown session failure. `allErrors` is deliberately OFF: nothing surfaces these
// errors to a model for repair (the classifier never retries), so collecting them all buys nothing
// and costs work on every call.
const validateVerdict: ValidateFunction = new Ajv({ strict: false }).compile(CLASSIFIER_VERDICT_SCHEMA);

/**
 * The forced tool call's input -> a `ClassifierRawResult`, or the reason it is not one.
 *
 * Keys are copied INDIVIDUALLY rather than spread. A spread would carry through whatever the model
 * sent (the schema's `additionalProperties: false` makes that unreachable today, but a future schema
 * relaxation would silently widen what reaches the audit record), and `exactOptionalPropertyTypes`
 * means an absent field must be an absent KEY rather than an `undefined` value.
 *
 * `reasonCode` is NAMESPACED here, and this is the one seam where it can be: see
 * `MODEL_REASON_CODE_PREFIX`. Everything else the model wrote (`category`, `severity`,
 * `auditReason`) is already unambiguously the model's — only `reasonCode` shares a field with
 * Winter's own closed vocabulary.
 */
export function parseClassifierVerdict(input: unknown): { ok: true; result: ClassifierRawResult } | { ok: false; reasonCode: ClassifierNoVerdictReason } {
  if (!validateVerdict(input)) return { ok: false, reasonCode: "schema_invalid" };
  const value = input as { verdict: ClassifierRawResult["verdict"]; category?: string; severity?: string; reasonCode?: string; auditReason?: string };
  return {
    ok: true,
    result: {
      verdict: value.verdict,
      ...(value.category !== undefined ? { category: value.category } : {}),
      ...(value.severity !== undefined ? { severity: value.severity } : {}),
      ...(value.reasonCode !== undefined ? { reasonCode: `${MODEL_REASON_CODE_PREFIX}${value.reasonCode}` } : {}),
      ...(value.auditReason !== undefined ? { auditReason: value.auditReason } : {}),
    },
  };
}
