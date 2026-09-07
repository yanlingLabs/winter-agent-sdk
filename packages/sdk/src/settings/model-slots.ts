// STUB created by the P6.6 SPINE; FILLED BY LANE B (settings: `modelSlots` + `preferredProviders`).
// The signatures below are the pinned cross-lane contract — Lane B replaces the bodies and adds
// `model-slots.test.ts`; nobody else edits this file.
//
// WS-13c §5 (D27): whole-set validation of the user's own four options.
//
// WHOLE-SET, never partial, and that is the design rather than a simplification: a set with one
// unresolvable `model` applied minus that entry is a lineup the user did not choose, silently. The
// failure carries a `reason` so the runtime can record `modelSlotsIgnored: "invalid"` beside the
// entry that broke it.
//
// Node-portable like the rest of `packages/sdk/src` (tsconfig.sdk-fence.json): no Bun API, no
// filesystem, no catalog import. The catalog lookups arrive as `ModelSlotsLookup` precisely so this
// module stays inside the fence — `@yanlinglabs/winter-provider-catalog` is fence-resident but the
// SESSION's view of which rows exist is a runtime fact, not a bundled one.
import type { ModelSlotSetting } from "../protocol/config.ts";

/**
 * The catalog questions validation needs, injected.
 *
 * `model` in a `ModelSlotSetting` may be a `canonicalModelId` OR a catalog key (both are things a
 * user has to hand), so validation needs to go both ways: canonical id -> the rows serving it, and
 * key -> its canonical id.
 */
export interface ModelSlotsLookup {
  rowsForCanonicalId(id: string): Array<{ key: string; providerId: string }>;
  keyToCanonicalId(key: string): string | undefined;
}

export type ModelSlotsValidation = { ok: true; slots: ModelSlotSetting[] } | { ok: false; reason: string };

/**
 * Validates a raw `settings.modelSlots` value (WS-13c §5).
 *
 * Lane B's obligations, from the spec: 1–4 entries; names match the slot token grammar and are
 * unique; NO name is a reserved Claude name (D25); every `model` resolves in the catalog; a given
 * `provider` actually serves it; no `description` carries a currency amount.
 */
export function validateModelSlots(raw: unknown, lookup: ModelSlotsLookup): ModelSlotsValidation {
  void raw;
  void lookup;
  return { ok: false, reason: "modelSlots validation not implemented (P6.6 Lane B)" };
}
