// Phase 5 Task 3 (spine): the STRUCTURED-OUTPUT seam -- R5-10. Lane K (task 7) implements it over
// `ajv` (R5-7); the ENGINE owns registration, the turn-ending rule, the retry counter and the
// exhaustion result.
//
// `StructuredOutput` is a HOST-GENERATED tool: its `input_schema` IS the caller's `outputFormat`
// schema, byte-for-byte (capture (6) proved this against the pinned runtime -- same `type`,
// `properties`, `required`, `additionalProperties`, no wrapper object, no envelope field). That is
// why the tool has no static declaration anywhere in the pinned artifact and why it cannot: a
// per-session generated schema has nothing to declare.
//
// Lane W rides the identical path -- `agent({schema})` reaches this seam through
// `WorkflowRunHost.structured`, never through a second validator.
import type { JSONSchema, ToolDescriptor } from "../tools/registry.ts";

/** The caller's `outputFormat.schema`. Aliased to the registry's own JSONSchema so the descriptor's `inputSchema` can be assigned the value VERBATIM, with no re-shaping step in between. */
export type JsonSchema = JSONSchema;

/** The tool name, one constant. Never hand-written at a call site -- an advertised-set assertion and a dispatch check that disagreed by a letter would be invisible. */
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

/**
 * The default number of ATTEMPTS, not retries. Capture (6) is explicit and was run both ways: with
 * the env unset the pinned runtime produced FIVE validation-failure tool results and terminated with
 * "after 5 attempts"; with `MAX_STRUCTURED_OUTPUT_RETRIES=2` it produced TWO. Reading the name as
 * "retries after the first attempt" would give six calls where the pin gives five.
 */
export const DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS = 5;

/** The unbranded env spelling, verbatim (Global Constraints: this family is NOT Winter-branded). */
export const MAX_STRUCTURED_OUTPUT_RETRIES_ENV = "MAX_STRUCTURED_OUTPUT_RETRIES";

/** Resolves the attempt budget from an environment snapshot. A non-numeric or non-positive value is ignored (the default stands) rather than producing a budget no run could ever satisfy. */
export function resolveMaxStructuredOutputAttempts(env: Record<string, string | undefined>): number {
  const raw = env[MAX_STRUCTURED_OUTPUT_RETRIES_ENV];
  if (raw === undefined) return DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STRUCTURED_OUTPUT_ATTEMPTS;
}

export interface StructuredOutputSeam {
  /**
   * Builds the host-generated descriptor. The implementation MUST put `schema` on `inputSchema`
   * unchanged -- not merged into a wrapper, not normalized, not re-serialized. The engine registers
   * whatever comes back and advertises it only while `outputFormat` is set.
   */
  buildDescriptor(schema: JsonSchema): ToolDescriptor;
  /**
   * Validates a model-supplied value against the caller's schema. `errors` are model-facing: capture
   * (6) observed the pinned runtime returning text naming the JSON-Pointer path and the expected
   * type (ajv's own rendering), which is the target shape.
   */
  validate(schema: JsonSchema, value: unknown): { ok: true; value: unknown } | { ok: false; errors: string[] };
}

/**
 * The spine's test double. Validation is deliberately CRUDE (required-key presence and a `type`
 * check on primitives) -- it exists to drive the engine's accept/retry/exhaust branches, never to
 * stand in for ajv. Lane K replaces it wholesale.
 */
export function fakeStructuredOutputSeam(opts?: { calls?: unknown[] }): StructuredOutputSeam {
  return {
    buildDescriptor(schema: JsonSchema): ToolDescriptor {
      return {
        canonicalName: STRUCTURED_OUTPUT_TOOL_NAME,
        advertisedName: STRUCTURED_OUTPUT_TOOL_NAME,
        source: "host",
        inputSchema: schema, // VERBATIM -- the one property capture (6) pins byte-for-byte
        description: "Return the session's final structured result.",
        exposure: "eager",
        permissionClass: "hosted",
        availability: {},
        capabilityRequirements: [],
        disposition: "implement-now",
      };
    },
    validate(schema: JsonSchema, value: unknown) {
      opts?.calls?.push(value);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: ["/: must be an object"] };
      const record = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`/${key}: must have required property '${key}'`);
      }
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        const expected = propSchema.type;
        if (!(key in record) || typeof expected !== "string") continue;
        const actual = Array.isArray(record[key]) ? "array" : record[key] === null ? "null" : typeof record[key];
        const matches = expected === "integer" ? actual === "number" : expected === actual;
        if (!matches) errors.push(`/${key}: must be ${expected}`);
      }
      return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
    },
  };
}
