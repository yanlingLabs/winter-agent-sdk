// WS-23: the REAL `ToolInputValidator` -- a hook's `updatedInput` checked against the tool
// registry's own `inputSchema` before anything runs with it.
//
// runner.ts has carried the seam since P2 (`ToolInputValidator`, with `NO_SCHEMAS_YET_VALIDATOR` as the
// documented "no schemas exist yet" default) and the engine passed no validator at all, so a
// PreToolUse/PermissionRequest transform reached the executor unchecked. The registry has had real
// schemas since P3; this is the missing wire.
//
// ONE ajv stack, not a second one: `createSchemaValidatorCache` (structured/validator.ts) already
// picks the dialect from `$schema` (draft-07 vs 2020-12, the two-constructor rule that file's header
// explains) and caches compiled validators by schema identity -- a registry descriptor's
// `inputSchema` is a stable object, so each tool's schema compiles once per session.
//
// WHAT COUNTS AS "NOTHING TO CHECK" (valid, by design):
//  - a tool the registry does not know (no descriptor, so no schema to hold the hook to);
//  - a schema ajv cannot compile. That is a defect in the TOOL's declaration (an MCP server's schema
//    in a dialect ajv does not carry, most likely), not in the hook, and denying every transform of
//    that tool would punish the hook for it -- including a safety hook whose whole job is the
//    transform (a floor narrowing `WebSearch`'s domains). Warned ONCE per tool, then treated as
//    unvalidatable.
import { getRegisteredTool } from "../tools/registry.ts";
import { createSchemaValidatorCache, formatValidationErrors, StructuredSchemaError } from "../structured/validator.ts";
import type { ToolInputValidator } from "./runner.ts";

export interface RegistryToolInputValidatorOptions {
  /** Where the once-per-tool "this schema does not compile" note goes. Defaults to stderr. */
  warn?: (line: string) => void;
}

export function createRegistryToolInputValidator(opts: RegistryToolInputValidatorOptions = {}): ToolInputValidator {
  const validatorFor = createSchemaValidatorCache();
  const warned = new Set<string>();
  const warn = opts.warn ?? ((line: string) => console.error(line));
  return {
    validate(toolName, input) {
      const schema = getRegisteredTool(toolName)?.descriptor.inputSchema;
      if (schema === undefined || typeof schema !== "object" || schema === null) return { valid: true };
      let validate: ReturnType<typeof validatorFor>;
      try {
        validate = validatorFor(schema);
      } catch (err) {
        if (!(err instanceof StructuredSchemaError)) throw err;
        if (!warned.has(toolName)) {
          warned.add(toolName);
          warn(`winter: ${toolName}'s input schema does not compile, so a hook's updatedInput for it cannot be validated and is accepted as-is: ${err.message}`);
        }
        return { valid: true };
      }
      if (validate(input) === true) return { valid: true };
      return { valid: false, reason: formatValidationErrors(validate.errors).join("; ") };
    },
  };
}
