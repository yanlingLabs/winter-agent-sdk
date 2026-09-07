// STUB created by the P6.6 SPINE; FILLED BY LANE C (the listing API + `set_model` by slot name).
// The signature below is the pinned cross-lane contract — Lane C replaces the body and adds
// `family-listing.test.ts`; nobody else edits this file.
//
// WS-13c §7: what `Query.listModelFamilies()` answers — the active set first, then every family and
// its models behind "more options".
//
// The body returns an EMPTY listing rather than throwing, unlike `slots.ts`'s stubs, and the
// asymmetry is deliberate: this is a LISTING. A host that opens a model switcher against an
// unwired runtime should see nothing to choose, not an exception through the control channel — and
// `active` is passed through, so a caller that already computed one still gets a truthful answer.
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ActiveSlotSet, ModelFamilyListing } from "@yanlinglabs/winter-agent-sdk";

export interface FamilyListingInput {
  catalog: WinterCatalog;
  active: ActiveSlotSet | undefined;
  /** WS-13c §7: a credential is configured AND the provider is not disabled (§4 step 2). */
  servable: (providerId: string) => boolean;
  /** Fills `SlotView.resolvesTo` — absent when nothing this session has can serve the slot. */
  resolveSlot?: (canonicalModelId: string, provider?: string) => { providerId: string; key: string } | undefined;
}

export function buildModelFamilyListing(input: FamilyListingInput): ModelFamilyListing {
  return { active: input.active, families: [] };
}
