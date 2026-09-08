// The admission-tier census, checked against the document it generates.
//
// HERMETIC: every case renders from a fixture catalog or reads the committed PROVENANCE.md. Nothing
// spawns the script, writes to the repository, or touches a home directory.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WinterCatalog, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { CATALOG_VOCABULARIES, loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { BEGIN_MARKER, END_MARKER, PROVENANCE_PATH, renderTierTable, spliceCensus } from "./provenance-tiers.ts";

function providerRow(id: string, tier: WinterProviderDescriptor["admission"]["tier"]): WinterProviderDescriptor {
  return {
    id,
    displayName: id,
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    defaultEndpoints: { api: "https://api.example/v1" },
    modelDiscovery: "none",
    liveCatalogAuthority: "unknown",
    adapterId: "winter.openai-chat-completions",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "review-required", reasons: ["fixture"] },
    scope: "llm",
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture", tier },
  };
}

function fixtureCatalog(providers: WinterProviderDescriptor[]): WinterCatalog {
  return {
    schemaVersion: 2,
    catalogVersion: "0.0.0-census-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers,
    models: [],
    families: [],
  };
}

describe("provenance-tiers: the census renders from the data, not from prose", () => {
  test("every tier in the vocabulary gets a row, including one with no members", () => {
    // A tier that vanished from the table when nothing was on it would make "0 rows on the weakest
    // tier" — the thing the document exists to let a reader check — indistinguishable from "that
    // tier is not mentioned here".
    const rendered = renderTierTable(fixtureCatalog([providerRow("a", "local")]));
    for (const tier of CATALOG_VOCABULARIES.admissionTiers) expect(rendered).toContain(`| **${tier}** |`);
    expect(rendered).toContain("| **local** | 1 |");
    expect(rendered).toContain("| **pinned-upstream** | 0 |");
  });

  test("tiers are in the VOCABULARY's order, never sorted by count", () => {
    // A table that reordered itself as rows moved would produce a diff on every catalog change and
    // tell a reader nothing about which change it was.
    const rendered = renderTierTable(fixtureCatalog([providerRow("a", "audit"), providerRow("b", "audit"), providerRow("c", "fetched-document")]));
    const order = CATALOG_VOCABULARIES.admissionTiers.map((tier) => rendered.indexOf(`| **${tier}** |`));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  test("a small tier names its rows; a large one reports the count only", () => {
    const small = renderTierTable(fixtureCatalog([providerRow("zeta", "spec-ruling"), providerRow("alpha", "spec-ruling")]));
    // Sorted, so the census does not change with the catalog's own row order.
    expect(small).toContain("`alpha`, `zeta`");

    const many = fixtureCatalog(Array.from({ length: 13 }, (_, i) => providerRow(`p${i}`, "spec-ruling")));
    const large = renderTierTable(many);
    expect(large).toContain("| **spec-ruling** | 13 |");
    expect(large).not.toContain("`p0`");
  });

  test("a tier outside the vocabulary THROWS rather than being dropped from the totals", () => {
    const rogue = providerRow("rogue", "audit");
    (rogue.admission as { tier: string }).tier = "vibes";
    expect(() => renderTierTable(fixtureCatalog([rogue]))).toThrow(/not in CATALOG_VOCABULARIES/);
  });
});

describe("provenance-tiers: the splice touches ONLY the marked block", () => {
  test("prose on both sides survives verbatim", () => {
    const document = `before\n\n${BEGIN_MARKER}\nstale\n${END_MARKER}\n\nafter\n`;
    const spliced = spliceCensus(document, "fresh");
    expect(spliced.ok).toBe(true);
    if (!spliced.ok) throw new Error(spliced.reason);
    expect(spliced.text).toBe(`before\n\n${BEGIN_MARKER}\n\nfresh\n\n${END_MARKER}\n\nafter\n`);
  });

  test("a document with no markers is REFUSED, never appended to", () => {
    const spliced = spliceCensus("no markers here\n", "fresh");
    expect(spliced.ok).toBe(false);
    if (spliced.ok) throw new Error("expected a refusal");
    expect(spliced.reason).toContain("markers are missing");
  });

  test("markers in the wrong order are refused", () => {
    const spliced = spliceCensus(`${END_MARKER}\n${BEGIN_MARKER}\n`, "fresh");
    expect(spliced.ok).toBe(false);
  });
});

describe("provenance-tiers --check: the committed document agrees with the shipped catalog", () => {
  test("PROVENANCE.md's census is exactly what a fresh render produces", () => {
    // The `--check` gate's own comparison, run in-process: `main(["--check"])` reads the same file
    // and re-renders from the same catalog, so a failure here is a failure there.
    const document = readFileSync(PROVENANCE_PATH, "utf8");
    const spliced = spliceCensus(document, renderTierTable(loadCatalog()));
    expect(spliced.ok).toBe(true);
    if (!spliced.ok) throw new Error(spliced.reason);
    expect(spliced.text).toBe(document);
  });
});

// --- P7a fix wave (item 3): the script is runnable BY NAME ---------------------------------------
//
// REDUCED from "add a CI step" after the Lane D review: the census drift is ALREADY gated by the
// `--check` test above, which runs under the repository's own `bun test` in CI. A second CI step
// would re-assert the same fact from a second place and drift from it.
//
// What was genuinely missing is discoverability: every other generator in this repository has a
// root script (`provider:catalog`, `provider:sync`, `differential`, `conformance:snapshot`), so a
// contributor who has just regenerated the catalog looks for one and finds a bare path in a comment
// instead. This pins the script and the documented `--check` form together, because a documented
// invocation that does not exist is worse than none.
describe("provenance-tiers: the root package script (P7a fix wave item 3)", () => {
  const ROOT_PACKAGE_JSON = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { scripts: Record<string, string> };

  test("`provenance:tiers` is a root script pointing at this generator", () => {
    expect(ROOT_PACKAGE_JSON.scripts["provenance:tiers"]).toBe("bun run scripts/provenance-tiers.ts");
  });

  test("PROVENANCE.md documents BOTH forms by the script's name, and the `--check` one keeps its `--` separator", () => {
    // `bun run provenance:tiers --check` would be consumed by bun itself; the argument only reaches
    // the script past a `--`. A document that omitted it would send every contributor to a no-op
    // that rewrites the file instead of checking it.
    const document = readFileSync(PROVENANCE_PATH, "utf8");
    expect(document).toContain("bun run provenance:tiers");
    expect(document).toContain("bun run provenance:tiers -- --check");
  });

  test("no CI step runs this generator -- the drift gate is the test above, and there is only one of it", () => {
    // The reduction, made enforceable. A future well-meaning addition of a `provenance:tiers` CI
    // step would create a second gate on the same fact; this says, in the place someone would look,
    // that the single gate is deliberate.
    const ci = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
    const runLines = ci.split("\n").filter((line) => /^\s*-\s*run:/.test(line));
    expect(runLines.filter((line) => line.includes("provenance"))).toEqual([]);
  });
});
