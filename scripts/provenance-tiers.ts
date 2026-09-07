// PROVENANCE.md's admission-tier census, GENERATED from the catalog it describes.
//
// WHY THIS EXISTS. `admission.tier` became data in P6.5's fix wave (R-FW-3) precisely because a
// rule keyed on a substring inside a citation string is a rule that drifts. PROVENANCE.md then went
// on describing the tiers in hand-written prose with hand-counted totals — a second, unpinned copy
// of the same fact, and the one a reader trusts, because a prose table looks like a summary of the
// data rather than an independent claim about it. It was already out of date: it names two tiers
// and the vocabulary has five.
//
// So the CENSUS is generated and the JUDGEMENT stays prose. This script rewrites exactly one marked
// block; every paragraph around it — what a pinned-upstream citation is worth, why promotion is
// two-key, the liveness sweep — is human text nothing here touches.
//
// `--check` is the CI half: it re-renders and compares, so a regenerated catalog that moves a row
// between tiers fails the gate instead of silently disagreeing with the document.
//
//   bun run scripts/provenance-tiers.ts            # rewrite the block
//   bun run scripts/provenance-tiers.ts --check    # fail (exit 1) if the block has drifted
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { CATALOG_VOCABULARIES, loadCatalog } from "@yanlinglabs/winter-provider-catalog";

export const PROVENANCE_PATH = join(import.meta.dir, "..", "packages", "provider-catalog", "PROVENANCE.md");

/** The block this script owns. Everything outside it is hand-written and is never rewritten. */
export const BEGIN_MARKER = "<!-- BEGIN GENERATED: admission-tier census (bun run scripts/provenance-tiers.ts) -->";
export const END_MARKER = "<!-- END GENERATED: admission-tier census -->";

/**
 * What each tier MEANS — the one hand-written part of the generated block, and deliberately keyed to
 * the vocabulary rather than to a list of tiers written out here.
 *
 * `satisfies` against the validator's own `admissionTiers` is what makes a NEW tier a compile error
 * in this file rather than a row that renders with an empty explanation. A census that silently
 * described a tier as "" would be worse than no census.
 */
const TIER_MEANING = {
  "fetched-document": "a vendor page this repository retrieved and read, on a recorded date",
  "pinned-upstream": "the vendor's own site as the pinned upstream product catalog records it, plus that id's own pinned entry — a real, dated reference, but NOT a page read here",
  "spec-ruling": "a ruling in an approved spec (or a user ruling recorded in one) admits the PATH; the row's own details are carried from a reviewed ledger entry",
  local: "a local installation on the operator's own machine — there is no third party to be admitted by",
  audit: "the in-repo third-party-access audit's own findings, which cite the documents it read",
} as const satisfies Record<(typeof CATALOG_VOCABULARIES.admissionTiers)[number], string>;

/** Tiers whose membership is short enough to name in full. Above this the census reports the count only. */
const NAME_ROWS_UP_TO = 12;

/**
 * Renders the census block's INNER text (markers excluded).
 *
 * Ordering is `CATALOG_VOCABULARIES.admissionTiers`' own, never by count: a table that reordered
 * itself as rows moved between tiers would produce a diff on every catalog change and tell a reader
 * nothing about which change it was.
 */
export function renderTierTable(catalog: WinterCatalog): string {
  const byTier = new Map<string, string[]>();
  for (const tier of CATALOG_VOCABULARIES.admissionTiers) byTier.set(tier, []);
  for (const provider of catalog.providers) {
    const rows = byTier.get(provider.admission.tier);
    // A tier outside the vocabulary cannot reach a validated catalog (`validate.ts` closes the set),
    // so this is a corrupted input rather than a case to render — and a census that quietly dropped
    // a row would misreport the totals it exists to report.
    if (rows === undefined) throw new Error(`provenance-tiers: provider "${provider.id}" carries tier "${provider.admission.tier}", which is not in CATALOG_VOCABULARIES.admissionTiers`);
    rows.push(provider.id);
  }

  const lines: string[] = [];
  lines.push(`Generated from \`generated/catalog.json\` (\`${catalog.catalogVersion}\`, ${catalog.providers.length} provider rows). Do not edit by hand.`);
  lines.push("");
  lines.push("| Tier | Rows | What it means |");
  lines.push("| --- | ---: | --- |");
  for (const tier of CATALOG_VOCABULARIES.admissionTiers) {
    const rows = [...byTier.get(tier)!].sort();
    const named = rows.length > 0 && rows.length <= NAME_ROWS_UP_TO ? ` — ${rows.map((id) => `\`${id}\``).join(", ")}` : "";
    lines.push(`| **${tier}** | ${rows.length} | ${TIER_MEANING[tier]}${named} |`);
  }
  lines.push("");
  // The rule `catalog-integrity.test.ts` enforces, restated where a reader of the census meets it:
  // the census is a count, and the count is not the promotion rule.
  lines.push("**Promotion is two-key** (WS-13b §1, fix-wave R-FW-3): a row leaves `pinned-upstream` only when a fetched vendor document AND a live-gate pass both exist, and no `approved` row or `supported` model may sit on that tier while it does not.");
  return lines.join("\n");
}

/** Splices a freshly-rendered block into the document, or reports why it cannot. */
export function spliceCensus(document: string, rendered: string): { ok: true; text: string } | { ok: false; reason: string } {
  const begin = document.indexOf(BEGIN_MARKER);
  const end = document.indexOf(END_MARKER);
  if (begin < 0 || end < 0) return { ok: false, reason: `the census markers are missing (expected ${JSON.stringify(BEGIN_MARKER)} … ${JSON.stringify(END_MARKER)})` };
  if (end < begin) return { ok: false, reason: "the census END marker precedes its BEGIN marker" };
  return { ok: true, text: `${document.slice(0, begin)}${BEGIN_MARKER}\n\n${rendered}\n\n${document.slice(end)}` };
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  if (!existsSync(PROVENANCE_PATH)) {
    console.error(`provenance-tiers: ${PROVENANCE_PATH} does not exist`);
    return 1;
  }
  const document = readFileSync(PROVENANCE_PATH, "utf8");
  const spliced = spliceCensus(document, renderTierTable(loadCatalog()));
  if (!spliced.ok) {
    console.error(`provenance-tiers: ${spliced.reason}`);
    return 1;
  }
  if (check) {
    if (spliced.text !== document) {
      console.error("provenance-tiers --check: PROVENANCE.md's admission-tier census DRIFTED from the catalog (run `bun run scripts/provenance-tiers.ts` and commit the result)");
      return 1;
    }
    console.log("provenance-tiers --check: OK");
    return 0;
  }
  if (spliced.text === document) {
    console.log("provenance-tiers: already up to date");
    return 0;
  }
  writeFileSync(PROVENANCE_PATH, spliced.text);
  console.log("provenance-tiers: rewrote PROVENANCE.md's admission-tier census");
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
