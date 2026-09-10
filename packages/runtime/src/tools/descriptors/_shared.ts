// Every descriptors/*.ts file is a data-only leaf -- it builds exactly one ToolDescriptor and calls
// `stub` to register it (never an executor; lanes add executors from their OWN
// packages/runtime/src/tools/impl/*.ts files via replaceExecutor -- see registry.ts's own header).
// Keeping the registration call itself this thin is what makes "no lane ever edits... another
// tool's file" true by construction: a lane's impl file never needs to import, or even know about,
// this helper. Leading underscore keeps it sorted away from the 56 real tool files in a directory
// listing without needing a nested folder.
import type { WinterToolDefinition } from "@yanlinglabs/winter-agent-sdk/tools";

import { registerTool, type JSONSchema, type ToolDescriptor } from "../registry.ts";

export function stub(descriptor: ToolDescriptor): void {
  registerTool({ descriptor });
}

/**
 * The MODEL-FACING half of a descriptor, taken from the SDK's own definition (user ruling R-8-1).
 *
 * Winter's default tools are declared once, in `@yanlinglabs/winter-agent-sdk/tools`, because three
 * copies of the same schema is how "both runtime branches present this exact model-facing schema"
 * stops being true. A descriptor that binds one of them spreads THIS and then supplies only the
 * registry POLICY the SDK deliberately does not carry (ruling P-8): `canonicalName`,
 * `advertisedName`, `source`, `exposure`, `availability`, `capabilityRequirements`, `disposition`
 * and `deferred`.
 *
 * THE SCHEMA OBJECTS PASS THROUGH BY REFERENCE, not by copy — `one-definition.test.ts` asserts
 * identity (`toBe`), because two structurally identical literals pass every equality check on the
 * day they are written and drift the moment one of them is edited.
 *
 * The cast is the price of two structural schema types that were written independently: the SDK's
 * `JsonSchemaObject` types `properties` as `Record<string, unknown>` (it advertises schema DATA and
 * validates nothing), while this registry's `JSONSchema` recurses into itself. Neither is a
 * validator, both describe the same JSON, and widening either one to match the other would be a
 * worse trade than one cast in one helper.
 */
export function definitionFields(definition: WinterToolDefinition): Pick<ToolDescriptor, "description" | "inputSchema" | "permissionClass"> & Partial<Pick<ToolDescriptor, "outputSchema" | "searchHint" | "annotations">> {
  return {
    description: definition.description,
    inputSchema: definition.inputSchema as unknown as JSONSchema,
    permissionClass: definition.permissionClass,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema as unknown as JSONSchema }),
    ...(definition.searchHint === undefined ? {} : { searchHint: definition.searchHint }),
    ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
  };
}

/**
 * The name a definition registers under on the NATIVE side: the official SDK's own built-in name
 * when there is one, the bare tool name otherwise.
 *
 * A definition carries a bare name plus an alias key precisely so each host derives its own
 * spelling; this is that derivation, in one place, so a descriptor never re-types a string the
 * definition already knows.
 */
export function builtinNameOf(definition: WinterToolDefinition): string {
  return definition.builtinName ?? definition.toolName;
}

// The common default for the overwhelming majority of §2 rows: no mode/platform/feature/toolSearch/
// family/subagent restriction. A descriptor that DOES need a real gate builds its own
// AvailabilityPredicate object literal inline instead of this constant.
//
// Deliberately NOT exporting a shared `[]` constant for `capabilityRequirements` alongside this:
// ToolDescriptor types that field as mutable (`string[]`), so a shared reference risks a future
// accidental in-place mutation silently affecting every descriptor that pointed at it. Each file
// below writes its own `capabilityRequirements: []` literal instead -- three extra characters, zero
// aliasing risk.
export const ALWAYS_AVAILABLE = {} as const;
