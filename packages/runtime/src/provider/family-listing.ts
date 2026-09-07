// FILLED BY LANE C (P6.6, WS-13c §7): the listing API `Query.listModelFamilies()` answers over the
// `list_model_families` control request — the active set first, then every family and its models
// behind "more options".
//
// The body returns an EMPTY listing rather than throwing, unlike `slots.ts`'s stubs, and the
// asymmetry is deliberate (kept from the spine's stub comment): this is a LISTING. A host that opens
// a model switcher against an unwired runtime should see nothing to choose, not an exception through
// the control channel — and `active` is passed through, so a caller that already computed one still
// gets a truthful answer. That same non-throwing posture extends to a family whose descriptor is
// somehow missing from `catalog.families` (defensive only — a validated catalog never has a model
// row's `modelFamily` point at nothing): it renders with the bare id standing in for `displayName`
// and no slots, rather than crashing a read-only view.
import type { FamilySlot, ModelFamilyDescriptor, WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { OTHER_FAMILY_ID } from "@yanlinglabs/winter-provider-catalog";
import type { ActiveSlotSet, ModelFamilyListing, ModelRowServable, SlotView } from "@yanlinglabs/winter-agent-sdk";

export interface FamilyListingInput {
  catalog: WinterCatalog;
  active: ActiveSlotSet | undefined;
  /**
   * WS-13c §7 as amended by P7a: a TRI-STATE, not a boolean.
   *
   * `"present"` a credential is configured and the provider is not disabled (§4 step 2).
   * `"absent"`  a probe answered, and there is none — or the provider is disabled.
   * `"unknown"` nobody has probed this provider yet.
   *
   * The third state is the honest first paint. `hasCredential` has been tri-state at the wiring
   * since R-6c-27, and this seam was the last place it was flattened: a boolean has to collapse
   * `unknown` onto one of the other two, and BOTH collapses are false statements to a model
   * switcher — `false` greys out a row the user can perfectly well use, and `true` (the shape the
   * cold paint originally shipped) claims every row in a 604-model catalog is available against an
   * empty credential store.
   */
  servable: (providerId: string) => ModelRowServable;
  /** Fills `SlotView.resolvesTo` — absent when nothing this session has can serve the slot. */
  resolveSlot?: (canonicalModelId: string, provider?: string) => { providerId: string; key: string } | undefined;
}

/**
 * Families sorted by id (WS-13c §7), `other` forced last regardless of where it would otherwise
 * fall alphabetically — unlike `catalog.families`'s own storage order (`scripts/provider-catalog.ts`
 * sorts by plain id for pipeline determinism, which is a DIFFERENT ordering rule this listing does
 * not inherit: "other" sits wherever its id falls there, e.g. between "o-series" and "qwen").
 */
function compareFamilyId(a: string, b: string): number {
  if (a === OTHER_FAMILY_ID) return b === OTHER_FAMILY_ID ? 0 : 1;
  if (b === OTHER_FAMILY_ID) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildModelFamilyListing(input: FamilyListingInput): ModelFamilyListing {
  const { catalog, active, servable, resolveSlot } = input;

  const providerById = new Map<string, WinterProviderDescriptor>(catalog.providers.map((p) => [p.id, p]));

  // Every provider row carries `pricingBasis` and every model row names an existing provider (catalog

  // integrity); a miss here is a corrupted catalog, never a "token" default (Lane C review, Minor 1).

  const pricingBasisOf = (providerId: string): string => {

    const provider = providerById.get(providerId);

    if (provider === undefined) throw new Error(`family listing: model row names provider "${providerId}" which the catalog does not carry`);

    return provider.pricingBasis;

  };
  const familyById = new Map<string, ModelFamilyDescriptor>(catalog.families.map((f) => [f.id, f]));

  // familyId -> canonicalModelId -> surviving rows, in `catalog.models` order. A family with zero
  // surviving rows (every row blocked/deprecated, or none at all) never gets a bucket here and so
  // never appears in the listing — the listing enumerates what the catalog can currently serve, not
  // every curated family id in existence. Iteration order is a stable, defensible default; §7's own
  // last sentence leaves `families[].models`' rendering to the host.
  const grouped = new Map<string, Map<string, WinterModelDescriptor[]>>();
  for (const modelRow of catalog.models) {
    if (modelRow.status === "blocked" || modelRow.status === "deprecated") continue;
    let byCanonical = grouped.get(modelRow.modelFamily);
    if (byCanonical === undefined) {
      byCanonical = new Map();
      grouped.set(modelRow.modelFamily, byCanonical);
    }
    let rows = byCanonical.get(modelRow.canonicalModelId);
    if (rows === undefined) {
      rows = [];
      byCanonical.set(modelRow.canonicalModelId, rows);
    }
    rows.push(modelRow);
  }

  function toSlotView(slot: FamilySlot): SlotView {
    const view: SlotView = { name: slot.name, canonicalModelId: slot.canonicalModelId, description: slot.description, reason: slot.reason };
    // Set only when the resolver actually answers (WS-13c §7 / SlotView's own doc: "present only
    // when the slot actually resolves for THIS session") — an unset key, never `resolvesTo: undefined`,
    // is what lets a switcher tell "not wired to check" apart from "checked, nothing can serve it".
    const resolvesTo = resolveSlot?.(slot.canonicalModelId, slot.provider);
    if (resolvesTo !== undefined) view.resolvesTo = resolvesTo;
    return view;
  }

  const families = [...grouped.keys()].sort(compareFamilyId).map((familyId) => {
    const descriptor = familyById.get(familyId);
    const byCanonical = grouped.get(familyId)!;
    const models = [...byCanonical.entries()].map(([canonicalModelId, modelRows]) => ({
      canonicalModelId,
      displayName: modelRows[0]!.displayName,
      rows: modelRows.map((row) => ({
        key: row.key,
        providerId: row.providerId,
        status: row.status,
        pricingBasis: pricingBasisOf(row.providerId),
        // P7a (Lane D): PASSED THROUGH, not mapped. The spine's shim turned a boolean into two of
        // the three states here; the predicate is three-valued now, so this listing has nothing left
        // to decide and the third state reaches the host intact. Any collapsing that still needs to
        // happen is the HOST's — it is the only party that knows how it wants to render "we have not
        // looked yet".
        servable: servable(row.providerId),
      })),
    }));
    return {
      id: familyId,
      displayName: descriptor?.displayName ?? familyId,
      vendor: descriptor?.vendor ?? "",
      slots: (descriptor?.slots ?? []).map(toSlotView),
      models,
    };
  });

  return { active, families };
}
