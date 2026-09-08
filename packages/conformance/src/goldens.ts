// `@yanlinglabs/winter-conformance` goldens loader (P7a Lane C, WS-02 §9 Step 2).
//
// `scripts/differential.ts` (the app repo's own comparator/regenerator) reads its committed goldens
// directly by `new URL(...)`, scenario by scenario, and that stays untouched here — it is not this
// package's file to edit, and it already works. This module exists for everyone ELSE: a consumer
// of the PUBLISHED package (the router's hermetic tests, R-7a-12) who wants a committed golden trace
// without reimplementing "where do the goldens live" against a package whose install location it
// does not control.
//
// R-7a-12: `packages/conformance/goldens/*.trace.json` are Winter-produced normalized traces and ARE
// publishable — the package manifest's `files` allowlist (`["src", "goldens"]`) ships this directory
// verbatim, so `GOLDENS_DIR` below resolves correctly both inside this repo and inside an installed
// `node_modules/@yanlinglabs/winter-conformance`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConformanceTraceEntry } from "./trace.ts";

const GOLDENS_DIR = fileURLToPath(new URL("../goldens/", import.meta.url));

/** Every committed golden's file name (e.g. "plain-query.trace.json"), sorted for a stable order. */
export function listGoldens(): string[] {
  return readdirSync(GOLDENS_DIR)
    .filter((name) => name.endsWith(".trace.json"))
    .sort();
}

/** Absolute path to a named golden file. Does not check existence -- loadGolden's own read does that. */
export function goldenPath(name: string): string {
  return join(GOLDENS_DIR, name);
}

/**
 * Reads and parses a committed golden trace by file name (e.g. "plain-query.trace.json", one of
 * `listGoldens()`'s entries). The returned array is already `normalizeTrace()`-shaped -- every
 * committed golden is, by `differential.ts`'s own convention (trace.ts's header comment).
 */
export function loadGolden(name: string): ConformanceTraceEntry[] {
  return JSON.parse(readFileSync(goldenPath(name), "utf8")) as ConformanceTraceEntry[];
}
