// Phase 5 Task 7 (Lane K, R5-7/R5-10): JSON Schema validation over `ajv`.
//
// TWO ENTRY POINTS, TWO CONSTRUCTORS, not a flag (T2's own seam-contract finding, re-verified here):
// `ajv` is the draft-07 constructor and `ajv/dist/2020` is the 2020-12 one. Getting this wrong is
// silent in the dangerous direction -- a 2020-12 keyword (`prefixItems`, `$dynamicRef`) handed to
// the draft-07 constructor is simply an unknown keyword, so the schema COMPILES and then ACCEPTS
// values the caller's schema rejects. Nothing throws and nothing logs; the host just gets a
// `structured_output` that does not match what it asked for.
//
// The dialect is chosen from `$schema` alone, and exactly two are supported -- R5-7's own
// "2020-12 + draft-07". A THIRD dialect (2019-09, draft-06, anything else) is REFUSED at compile
// time rather than quietly falling back: ajv validates a schema against its own declared `$schema`
// meta-schema, and neither instance holds those, so `compile` throws and this file reports a
// StructuredSchemaError. That is the loud direction and the right one -- a fallback to draft-07
// would validate a 2019-09 schema under draft-07 rules, which is the very
// accepts-what-the-caller-rejects failure the two-entry-point rule exists to prevent.
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { JsonSchema } from "./seam.ts";

/** A caller schema that ajv cannot compile at all. Distinct from a validation failure -- see below. */
export class StructuredSchemaError extends Error {}

// Options, each load-bearing:
//
//   allErrors    -- the attempt budget is FIVE (capture (6)). A validator that reveals one error per
//                   attempt spends the budget teaching the model its own schema instead of letting
//                   it fix everything at once.
//   strict       -- OFF. A caller's schema is arbitrary JSON and may carry vendor extensions
//                   (`x-*`, `$comment`-adjacent keys, an unknown format). Strict mode THROWS on
//                   those at compile time, which would turn a perfectly valid host schema into a
//                   hard session failure.
//
// Deliberately NOT enabled: `useDefaults`, `coerceTypes`, `removeAdditional`. All three MUTATE the
// value being validated, and `result.structured_output` must be exactly what the model produced --
// a host that asked for validation did not ask for rewriting.
const AJV_OPTIONS = { allErrors: true, strict: false } as const;

function isDialect2020(schema: JsonSchema): boolean {
  const declared = (schema as { $schema?: unknown }).$schema;
  return typeof declared === "string" && declared.includes("2020-12");
}

/**
 * Renders ajv's errors as model-facing text. Capture (6) observed the pinned runtime returning text
 * naming the JSON-Pointer path and the expected type -- ajv's own rendering -- which is the target
 * shape, so this stays a thin projection of `instancePath` + `message` rather than a bespoke prose
 * layer that would drift from it.
 *
 * A root-level failure is reported at `/`, never at the empty string ajv uses: `": must be object"`
 * reads as a typo, and the pointer is the thing the model navigates by.
 */
export function formatValidationErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (errors === null || errors === undefined || errors.length === 0) {
    // ajv sets `.errors` to null on success; reaching here with nothing to say would otherwise hand
    // the model a validation-failure tool result containing no explanation at all.
    return ["the value did not match the requested schema"];
  }
  return errors.map((e) => {
    const path = e.instancePath.length > 0 ? e.instancePath : "/";
    const message = e.message ?? `failed ${e.keyword}`;
    return `${path}: ${message}`;
  });
}

/**
 * Compiles per SCHEMA OBJECT and caches by identity. The engine hands the same `outputFormat.schema`
 * object to `validate` on every attempt of every turn, so a per-call compile would re-parse the
 * schema up to five times per turn for the life of the session. A `WeakMap` rather than a `Map` so a
 * finished session's schema is collectable.
 */
export function createSchemaValidatorCache(): (schema: JsonSchema) => ValidateFunction {
  const draft07 = new Ajv(AJV_OPTIONS);
  const draft2020 = new Ajv2020(AJV_OPTIONS);
  const compiled = new WeakMap<object, ValidateFunction>();

  return (schema: JsonSchema): ValidateFunction => {
    const cached = compiled.get(schema);
    if (cached !== undefined) return cached;
    let validator: ValidateFunction;
    try {
      validator = (isDialect2020(schema) ? draft2020 : draft07).compile(schema as object);
    } catch (err) {
      // A schema the caller supplied and ajv rejects is a CONFIGURATION error, not a model error.
      // Reporting it as a validation failure would hand the model a message it can never act on and
      // burn the whole attempt budget before terminating as though the MODEL had failed.
      throw new StructuredSchemaError(`the requested output schema could not be compiled: ${err instanceof Error ? err.message : String(err)}`);
    }
    compiled.set(schema, validator);
    return validator;
  };
}
