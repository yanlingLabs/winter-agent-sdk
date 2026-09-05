// Builds (and checks) `packages/provider-catalog/generated/catalog.json` from its two layers.
//
//   layer 1  UPSTREAM  — `packages/provider-catalog/generated/upstream-layer.json`, produced by
//                        Lane X's `scripts/provider-source-sync.ts` from the pinned OmniRoute tree.
//                        ABSENT on the spine: the committed catalog is a hand-authored SEED and its
//                        pin fields are empty strings, which is what says "no extraction produced
//                        this" (`catalogVersion: "0.0.0-seed"`, `upstream.commit: ""`).
//   layer 2  OVERLAY   — `packages/provider-catalog/overlay/{providers,models}.json`, hand-authored
//                        and reviewed. WS-13 §7: overlay evidence is NEVER silently overwritten by
//                        upstream extraction or live discovery, so the overlay wins every conflict.
//
// Usage:
//   bun run provider:catalog              # regenerate generated/catalog.json + generated/rejections.json
//   bun run provider:catalog -- --check   # regenerate in memory and FAIL on any drift (CI gate)
//
// `--check` is WS-13 §13's own acceptance test ("byte-identical regeneration from the same
// commit+extractor") applied to whatever layers are present. It is wired into the merge gates from
// Task 4 on.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCatalog } from "../packages/provider-catalog/src/validate.ts";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "../packages/provider-catalog/src/types.ts";

const PKG = new URL("../packages/provider-catalog/", import.meta.url);
const OVERLAY_PROVIDERS = fileURLToPath(new URL("overlay/providers.json", PKG));
const OVERLAY_MODELS = fileURLToPath(new URL("overlay/models.json", PKG));
const UPSTREAM_LAYER = fileURLToPath(new URL("generated/upstream-layer.json", PKG));
const UPSTREAM_PIN = fileURLToPath(new URL("UPSTREAM.json", PKG));
const OUT_CATALOG = fileURLToPath(new URL("generated/catalog.json", PKG));
const OUT_REJECTIONS = fileURLToPath(new URL("generated/rejections.json", PKG));

/** The seed's own version marker. A `0.0.0-seed` catalog is hand-authored, never extracted. */
const SEED_CATALOG_VERSION = "0.0.0-seed";

interface UpstreamPin {
  tag: string;
  tagObject: string;
  commit: string;
  extractorVersion: string;
  overlayVersion: string;
}

interface RejectionRow {
  upstreamId: string;
  reason: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** Strips the `$comment` documentation keys the hand-authored layers carry (they are for the human editing the file, never catalog data). */
function stripComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripComments(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "$comment") continue;
      out[k] = stripComments(v);
    }
    return out as unknown as T;
  }
  return value;
}

export interface BuildResult {
  catalog: WinterCatalog;
  rejections: RejectionRow[];
}

export function buildCatalog(): BuildResult {
  const overlayProviders = stripComments(readJson(OVERLAY_PROVIDERS) as { providers: WinterProviderDescriptor[] }).providers;
  const overlayModels = stripComments(readJson(OVERLAY_MODELS) as { models: WinterModelDescriptor[] }).models;

  let upstreamProviders: WinterProviderDescriptor[] = [];
  let upstreamModels: WinterModelDescriptor[] = [];
  let rejections: RejectionRow[] = [];
  if (existsSync(UPSTREAM_LAYER)) {
    const layer = stripComments(readJson(UPSTREAM_LAYER) as { providers?: WinterProviderDescriptor[]; models?: WinterModelDescriptor[]; rejections?: RejectionRow[] });
    upstreamProviders = layer.providers ?? [];
    upstreamModels = layer.models ?? [];
    rejections = layer.rejections ?? [];
  }

  const pin: UpstreamPin = existsSync(UPSTREAM_PIN)
    ? (stripComments(readJson(UPSTREAM_PIN) as { upstream: UpstreamPin }).upstream)
    : { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" };

  // The overlay WINS: an upstream row with the same id/key is dropped in its favour (WS-13 §7).
  const overlayProviderIds = new Set(overlayProviders.map((p) => p.id));
  const overlayModelKeys = new Set(overlayModels.map((m) => m.key));
  const providers = [...upstreamProviders.filter((p) => !overlayProviderIds.has(p.id)), ...overlayProviders];
  const models = [...upstreamModels.filter((m) => !overlayModelKeys.has(m.key)), ...overlayModels];

  // Deterministic order — the byte-identical-regeneration test needs one canonical ordering, and
  // "whatever order the layers happened to be written in" is not one.
  providers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  models.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const catalog: WinterCatalog = {
    schemaVersion: 1,
    catalogVersion: pin.commit === "" ? SEED_CATALOG_VERSION : `${pin.tag}+${pin.extractorVersion}`,
    upstream: pin,
    providers,
    models,
  };
  return { catalog, rejections };
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  const { catalog, rejections } = buildCatalog();

  const result = validateCatalog(catalog);
  if (!result.ok) {
    console.error(`provider:catalog — the merged catalog is INVALID (${result.errors.length} error(s)):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    return 1;
  }

  const catalogText = render(catalog);
  const rejectionsText = render({ rejections });

  if (check) {
    let drift = false;
    for (const [path, expected] of [
      [OUT_CATALOG, catalogText],
      [OUT_REJECTIONS, rejectionsText],
    ] as const) {
      const actual = existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
      if (actual !== expected) {
        drift = true;
        console.error(`provider:catalog --check: ${path} DRIFTED from a fresh regeneration (run \`bun run provider:catalog\` and commit the result)`);
      }
    }
    if (drift) return 1;
    console.log(`provider:catalog --check: OK (${catalog.providers.length} providers, ${catalog.models.length} models, catalogVersion ${catalog.catalogVersion})`);
    return 0;
  }

  writeFileSync(OUT_CATALOG, catalogText);
  writeFileSync(OUT_REJECTIONS, rejectionsText);
  console.log(`provider:catalog: wrote ${catalog.providers.length} providers, ${catalog.models.length} models (catalogVersion ${catalog.catalogVersion})`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
