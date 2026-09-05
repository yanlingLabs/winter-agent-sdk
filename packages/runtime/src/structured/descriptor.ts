// Phase 5 Task 7 (Lane K, R5-10): the HOST-GENERATED `StructuredOutput` descriptor.
//
// `input_schema` IS the caller's `outputFormat.schema`, by IDENTITY. Capture (6) proved this against
// the pinned runtime byte-for-byte -- same `type`, `properties`, `required`, `additionalProperties`,
// no wrapper object, no envelope field -- and the seam contract test asserts object identity
// (`toBe`), which is the only assertion a quiet normalization step cannot pass.
//
// The descriptor is built from a FRESH OBJECT LITERAL with the schema assigned to one field, never
// by spreading the schema: a caller schema is arbitrary JSON and may legally carry keys that collide
// with descriptor fields (`description`, `type`, `source`). A spread would let the caller's schema
// silently rewrite the tool's own identity.
import type { ToolDescriptor } from "../tools/registry.ts";
import { STRUCTURED_OUTPUT_TOOL_NAME, type JsonSchema } from "./seam.ts";

/**
 * Winter's own description of the tool. It is what the model reads to know HOW to return, so it says
 * that calling it ends the turn -- the engine's turn-ending rule is otherwise invisible to the model,
 * which would keep working after it had already answered.
 */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return this session's final result as structured data matching the required schema. " +
  "Calling this tool ends the turn: call it once, when the answer is complete. " +
  "If the value does not match the schema you will be told exactly what was wrong and may call it again.";

export function buildStructuredOutputDescriptor(schema: JsonSchema): ToolDescriptor {
  return {
    canonicalName: STRUCTURED_OUTPUT_TOOL_NAME,
    advertisedName: STRUCTURED_OUTPUT_TOOL_NAME,
    source: "host",
    // VERBATIM, by identity -- the one property capture (6) pins byte-for-byte.
    inputSchema: schema,
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    // Eager: the whole point of `outputFormat` is that the model can see how to return from the
    // first turn. It is never deferred and never hidden.
    exposure: "eager",
    permissionClass: "hosted",
    // Unconditionally available while registered, and registration is itself the condition (the
    // engine registers only while `outputFormat` is set and withdraws it at teardown).
    availability: {},
    capabilityRequirements: [],
    disposition: "implement-now",
  };
}
