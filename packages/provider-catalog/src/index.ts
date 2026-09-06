// `@yanlinglabs/winter-provider-catalog` — the inert provider catalog and its validator.
//
// FROZEN as of P6 T2's merge (R6-12): lanes ADD files (Lane X adds `overlay/` rows and the upstream
// layer under `generated/`), never edit `src/` or `schema/`.

export type {
  CapabilityEvidence,
  CatalogValidationResult,
  EvidenceConfidence,
  EvidenceSource,
  ModelPricing,
  ModelStatus,
  ProviderAuthKind,
  ProviderProtocol,
  ReasoningCapabilities,
  ToolCalling,
  WinterCatalog,
  WinterModelDescriptor,
  WinterProviderDescriptor,
} from "./types.ts";

export { CATALOG_VOCABULARIES, scanForSecrets, validateCatalog } from "./validate.ts";

import type { WinterCatalog } from "./types.ts";
import { validateCatalog } from "./validate.ts";

// --- the bundled catalog ------------------------------------------------------------------------
//
// A BUNDLED JSON MODULE, never `fs.readFile`. This is the whole point: `bun build --compile`
// produces a single-file binary whose `$bunfs` has no repository beside it, so a runtime path read
// resolves to nothing there while type-checking and dev-mode testing both pass — the exact
// "silently breaks only in the compiled form" class scripts/build-runtime.ts's own header warns
// about. An import is resolved by the bundler at build time and travels INSIDE the binary.
// Task 10 re-proves this on the compiled artifact; this package proves the mechanism under
// `bun run typecheck` and its own unit test.
import catalogJson from "../generated/catalog.json" with { type: "json" };

let cached: WinterCatalog | undefined;

/**
 * The catalog compiled into this build.
 *
 * VALIDATES rather than casts. TypeScript infers the imported JSON's *widened* shape
 * (`schemaVersion: number`, every union member a bare `string`), so `catalogJson as WinterCatalog`
 * would be an unchecked assertion dressed as a type — and a malformed committed catalog would then
 * surface as an incomprehensible failure deep in an adapter. Running the real validator is what
 * narrows it, and a failure here is a BUILD defect, so it throws rather than degrading.
 *
 * Memoised: the validator walks every row, and the catalog is immutable for the life of a process.
 */
export function loadCatalog(): WinterCatalog {
  if (cached !== undefined) return cached;
  const result = validateCatalog(catalogJson);
  if (!result.ok) {
    throw new Error(
      `winter-provider-catalog: the bundled catalog.json is invalid (${result.errors.length} error(s)) — this is a build defect, not a runtime condition:\n  ${result.errors.map((e) => e.message).join("\n  ")}`,
    );
  }
  cached = result.catalog;
  return cached;
}

/** Test seam: forget the memoised catalog. Never used in production — `loadCatalog()` is idempotent there. */
export function __resetCatalogCacheForTests(): void {
  cached = undefined;
}
