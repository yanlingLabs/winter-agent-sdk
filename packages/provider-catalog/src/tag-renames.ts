// WS-21 lane L1b, Task L1b.1 (spec §8 step 5; F23): `CATALOG_TAG_RENAMES` is the host-facing map a
// STORED old-catalog compound tag (`<providerId>/<id>`, e.g. from `settings.json`, runtime-state or
// a phone frame) canonicalizes through, after a reviewed catalog refresh renames the row underneath
// it. Stored tags are never rewritten in place at migration time (an older Winter's catalog has no
// row under the new spelling, so a blind rewrite would be a downgrade hazard) -- they canonicalize on
// read instead, through `canonicalModelTag` (the daemon), applying exactly this map.
//
// DERIVED, never hand-typed (the WS-21 lane L1b brief's own rule). Two published, bundled sources --
// never `third_party/omniroute-provider-source/allowlist.json`, which is a DEV-ONLY extraction input
// this package's `files` list never ships:
//
//   - the DOMAIN comes from `generated/rejections.json`'s own `scope: "model"` /
//     `exclusionClass: "out-of-scope"` rows. Every one of those is `merge.ts`'s own `reject(...)`
//     call for a REVIEWED `modelOverrides` exclusion (`src/extract/merge.ts:747`), recorded at
//     `"<upstreamId>.models[<excludedId>]"` -- so the excluded id is read off the ledger, not
//     retyped;
//   - the RANGE comes from `generated/catalog.json`'s own `aliases`: for an excluded id, every row
//     (any provider) that lists it as an alias is where that id now lives. The 2026-09-19 refresh
//     ships DeepSeek's legacy `deepseek-v4-flash` as exactly that kind of alias, on both DeepSeek
//     dialect rows (`deepseek/deepseek-flash`, `deepseek-anthropic/deepseek-flash`) --
//     PROVENANCE.md's "out-of-scope" row: "a retired legacy id that DeepSeek temporarily routes to
//     canonical `deepseek-flash`".
//
// An excluded id with NO surviving alias anywhere is a PURE removal (the refresh's other
// `out-of-scope` row, a text-to-speech model with no replacement) and mints no rename -- which is
// also V16's ruling for `deepseek-reasoner`: the refresh drops the `deepseek/deepseek-reasoner` and
// `deepseek-anthropic/deepseek-reasoner` overlay rows outright (git history shows the array slots
// repurposed for the new `deepseek-flash` rows), and nothing in the refresh's own provenance --
// PROVENANCE.md, the allowlist's reviewed `modelOverrides`, or DeepSeek's cited pricing-page note --
// documents `deepseek-reasoner` as routed anywhere. No alias names it, so it is correctly left
// unmapped: a host reading a stored `deepseek/deepseek-reasoner` tag finds no row and no rename, and
// refuses it typed rather than guessing a destination.
import catalogJson from "../generated/catalog.json" with { type: "json" };
import rejectionsJson from "../generated/rejections.json" with { type: "json" };

interface MinimalCatalogModel {
  readonly key: string;
  readonly providerId: string;
  readonly aliases?: readonly string[];
}
interface MinimalCatalog {
  readonly models: readonly MinimalCatalogModel[];
}
interface MinimalRejection {
  readonly scope: string;
  readonly exclusionClass: string;
  readonly path: string;
}
interface MinimalRejectionsLedger {
  readonly rejections: readonly MinimalRejection[];
}

/** `merge.ts:747`'s own path shape for a model-scope rejection: `"<upstreamId>.models[<excludedId>]"`. */
const MODEL_REJECTION_PATH_RE = /^.+\.models\[(.+)]$/;

function deriveCatalogTagRenames(): Readonly<Record<string, string>> {
  const catalog = catalogJson as unknown as MinimalCatalog;
  const ledger = rejectionsJson as unknown as MinimalRejectionsLedger;

  // The reviewed, excluded upstream ids -- the ONLY candidates a rename can ever be minted for.
  const excludedIds = new Set<string>();
  for (const rejection of ledger.rejections) {
    if (rejection.scope !== "model" || rejection.exclusionClass !== "out-of-scope") continue;
    const excludedId = MODEL_REJECTION_PATH_RE.exec(rejection.path)?.[1];
    if (excludedId !== undefined) excludedIds.add(excludedId);
  }

  const liveKeys = new Set(catalog.models.map((m) => m.key));
  const renames: Record<string, string> = {};
  for (const model of catalog.models) {
    for (const alias of model.aliases ?? []) {
      if (!excludedIds.has(alias)) continue;
      const oldTag = `${model.providerId}/${alias}`;
      if (liveKeys.has(oldTag)) continue; // never shadow a tag that still resolves on its own
      renames[oldTag] = model.key;
    }
  }
  return Object.freeze(renames);
}

/**
 * Old compound `<providerId>/<id>` tag -> the catalog key it now lives under.
 *
 * Every value names a real row of the bundled catalog; no key is ever a live catalog key itself (a
 * rename never shadows a tag that still resolves on its own). `canonicalModelTag` (the daemon, WS-21
 * spec §8 step 5) applies this at every stored-tag read boundary, so a tag written by an older
 * catalog keeps resolving after a refresh renames the row underneath it.
 */
export const CATALOG_TAG_RENAMES: Readonly<Record<string, string>> = deriveCatalogTagRenames();
