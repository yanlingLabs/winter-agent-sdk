// Every descriptors/*.ts file is a data-only leaf -- it builds exactly one ToolDescriptor and calls
// `stub` to register it (never an executor; lanes add executors from their OWN
// packages/runtime/src/tools/impl/*.ts files via replaceExecutor -- see registry.ts's own header).
// Keeping the registration call itself this thin is what makes "no lane ever edits... another
// tool's file" true by construction: a lane's impl file never needs to import, or even know about,
// this helper. Leading underscore keeps it sorted away from the 56 real tool files in a directory
// listing without needing a nested folder.
import { registerTool, type ToolDescriptor } from "../registry.ts";

export function stub(descriptor: ToolDescriptor): void {
  registerTool({ descriptor });
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
