// Phase 5 Task 7 (Lane K, R5-7/R5-10): the real `StructuredOutputSeam`, replacing the spine's
// deliberately crude fake wholesale.
//
// The seam is only these two operations. Everything else about structured output -- WHEN the tool is
// registered, that a valid call ends the turn, the attempt counter, the two-spelling exhaustion
// result -- belongs to the engine and is pinned by `structured/seam.contract.test.ts`.
//
// Lane W rides this identical object: `agent({schema})` reaches it through
// `WorkflowRunHost.structured`, never through a second validator. One seam per process-worth of
// schema validation is the point -- two would drift on dialect selection and error rendering, which
// are exactly the two things a caller notices.
import type { ToolDescriptor } from "../tools/registry.ts";
import type { JsonSchema, StructuredOutputSeam } from "./seam.ts";
import { buildStructuredOutputDescriptor } from "./descriptor.ts";
import { createSchemaValidatorCache, formatValidationErrors } from "./validator.ts";

/**
 * One seam per session (or per workflow host). The ajv instances and the compiled-validator cache
 * live inside the closure, so two concurrent sessions never share compile state and a finished one
 * releases it.
 */
export function createStructuredOutputSeam(): StructuredOutputSeam {
  const validatorFor = createSchemaValidatorCache();
  return {
    buildDescriptor(schema: JsonSchema): ToolDescriptor {
      return buildStructuredOutputDescriptor(schema);
    },
    validate(schema: JsonSchema, value: unknown): { ok: true; value: unknown } | { ok: false; errors: string[] } {
      const validate = validatorFor(schema);
      // ajv's compiled validators are stateful in exactly one way: `.errors` belongs to the LAST
      // call. Read it immediately, never across an await -- there is none here for that reason.
      if (validate(value) === true) return { ok: true, value };
      return { ok: false, errors: formatValidationErrors(validate.errors) };
    },
  };
}
