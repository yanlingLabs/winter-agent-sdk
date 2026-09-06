// `bun run scripts/provider-source-sync.ts [--check|--offline]` — the WS-13 §3 extraction pipeline.
//
//   (default)   fetch the pinned OmniRoute tag, extract, and WRITE the upstream layer, the pin, the
//               extraction manifest and the upstream notice copies. NETWORK REQUIRED.
//   --check     do all of that into a scratch directory and byte-compare against what is committed.
//               Fails on any drift. NETWORK REQUIRED — this is the "same commit + extractor produces
//               byte-identical output" acceptance test (WS-13 §13) in its full form.
//   --offline   NO NETWORK. Re-merge and re-validate the COMMITTED snapshot: the upstream layer is
//               read from disk, the overlay beside it, and the result validated and byte-compared
//               through `scripts/provider-catalog.ts --check`. This is what CI runs on every push.
//
// Division of labour with `scripts/provider-catalog.ts` (FROZEN): that script is the ONLY writer of
// `generated/catalog.json` and `generated/rejections.json`. This one writes the upstream LAYER and
// then invokes it. Two serializers would be two chances to drift, and `provider:catalog --check`
// would then be comparing one of them against the other rather than against the layers.
//
// The overlay is never written here, by construction: no code path in this file opens
// `overlay/*.json` for writing, and a test asserts a re-sync leaves them byte-identical (WS-13 §7).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { scanForSecrets, validateCatalog } from "../packages/provider-catalog/src/validate.ts";
import type { WinterModelDescriptor, WinterProviderDescriptor } from "../packages/provider-catalog/src/types.ts";
import { fetchUpstream, type AllowlistPath, type MaterializedFile, type UpstreamPin } from "../packages/provider-catalog/src/extract/fetch.ts";
import { extractAll, type LiteralValue, type Rejection } from "../packages/provider-catalog/src/extract/literal-extractor.ts";
import { ADAPTER_PROTOCOL, buildUpstreamLayer, ExtractionRefusal, mergeLayers, OVERLAY_FILES, type Allowlist, type UpstreamLayer } from "../packages/provider-catalog/src/extract/merge.ts";
import { buildExtractionManifest, computeDenominator, type DenominatorReport } from "../packages/provider-catalog/src/extract/ledgers.ts";

const REPO = new URL("../", import.meta.url);
const THIRD_PARTY = fileURLToPath(new URL("third_party/omniroute-provider-source/", REPO));
const PKG = fileURLToPath(new URL("packages/provider-catalog/", REPO));
const CATALOG_SCRIPT = fileURLToPath(new URL("scripts/provider-catalog.ts", REPO));

const ALLOWLIST = join(THIRD_PARTY, "allowlist.json");
const INPUT_PIN = join(THIRD_PARTY, "UPSTREAM.json");
const MANIFEST = join(THIRD_PARTY, "extraction-manifest.json");
const UPSTREAM_LICENSE = join(THIRD_PARTY, "LICENSE");
const UPSTREAM_NOTICE = join(THIRD_PARTY, "NOTICE");
const OUTPUT_PIN = join(PKG, "UPSTREAM.json");
const UPSTREAM_LAYER = join(PKG, "generated", "upstream-layer.json");
const DENOMINATOR = join(PKG, "generated", "denominator.json");
const OUT_CATALOG = join(PKG, "generated", "catalog.json");

/** The two upstream files Winter COPIES, and where each lands. Nothing else from the tree is committed. */
const COPIED: ReadonlyArray<{ upstreamPath: string; localPath: string }> = [
  { upstreamPath: "LICENSE", localPath: "third_party/omniroute-provider-source/LICENSE" },
  { upstreamPath: "THIRD_PARTY_NOTICES.md", localPath: "third_party/omniroute-provider-source/NOTICE" },
];

/** Category const name -> the WS-13 §1 category it enumerates. */
const CATEGORY_CONSTS: Readonly<Record<string, string>> = {
  NOAUTH_PROVIDERS: "noauth",
  OAUTH_PROVIDERS: "oauth",
  WEB_COOKIE_PROVIDERS: "web-cookie",
  APIKEY_PROVIDERS: "apikey",
  LOCAL_PROVIDERS: "local",
  SEARCH_PROVIDERS: "search",
  AUDIO_ONLY_PROVIDERS: "audio",
  UPSTREAM_PROXY_PROVIDERS: "upstream-proxy",
  CLOUD_AGENT_PROVIDERS: "cloud-agent",
  SYSTEM_PROVIDERS: "system",
};

/** The barrel that merges the six apikey family files — read from it, not from the families, so an id counts once. */
const APIKEY_BARREL = "src/shared/constants/providers/apikey/index.ts";
const REGISTRY_INDEX = "open-sse/config/providers/index.ts";
const CLAIM_SOURCES = ["README.md", "docs/reference/PROVIDER_REFERENCE.md"];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The one renderer, matching `scripts/provider-catalog.ts`'s exactly. */
function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: LiteralValue | undefined): value is { [key: string]: LiteralValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExtractionOutcome {
  layer: UpstreamLayer;
  manifest: ReturnType<typeof buildExtractionManifest>;
  denominator: DenominatorReport;
  pin: { tag: string; tagObject: string; commit: string; extractorVersion: string; overlayVersion: string };
  files: readonly MaterializedFile[];
  /** upstream path -> the file's text, for the two copied notice files. */
  copiedText: Map<string, string>;
}

/** Fetch + parse + map. The scratch checkout is deleted before this returns, always. */
function runExtraction(): ExtractionOutcome {
  const allowlist = readJson<Allowlist & { $comment?: string }>(ALLOWLIST);
  const inputPin = readJson<UpstreamPin & { packageVersion?: string; extractorVersion: string; overlayVersion: string; observedAt: string }>(INPUT_PIN);
  const paths: AllowlistPath[] = allowlist.paths.map(({ pattern, role, why }) => ({ pattern, role, why }));

  const fetched = fetchUpstream(inputPin, paths);
  try {
    const sources = fetched.files.filter((f) => f.path.endsWith(".ts")).map((f) => ({ path: f.path, text: fetched.read(f.path) }));
    const { modules } = extractAll(sources);

    // --- categories -----------------------------------------------------------------------------
    const categories = new Map<string, { category: string; sourcePath: string; row: LiteralValue }>();
    const byCategory = new Map<string, Set<string>>();
    for (const [path, module] of modules) {
      if (path !== APIKEY_BARREL && !path.startsWith("src/shared/constants/providers/")) continue;
      if (path.startsWith("src/shared/constants/providers/apikey/") && path !== APIKEY_BARREL) continue;
      for (const [name, value] of module.values) {
        const category = CATEGORY_CONSTS[name];
        if (category === undefined || !isRecord(value)) continue;
        const ids = byCategory.get(category) ?? new Set<string>();
        byCategory.set(category, ids);
        for (const [id, row] of Object.entries(value)) {
          ids.add(id);
          if (!categories.has(id)) categories.set(id, { category, sourcePath: path, row });
        }
      }
    }
    if (byCategory.size !== Object.keys(CATEGORY_CONSTS).length) {
      const found = [...byCategory.keys()].sort().join(", ");
      throw new ExtractionRefusal(`expected all ${Object.keys(CATEGORY_CONSTS).length} upstream product-catalog categories, found ${byCategory.size} (${found}). A category that stopped resolving would silently shrink the denominator and quietly un-block whatever it contained.`);
    }

    // --- the backend registry --------------------------------------------------------------------
    const registryModule = modules.get(REGISTRY_INDEX);
    const registryLiteral = registryModule?.values.get("REGISTRY");
    if (!isRecord(registryLiteral)) {
      throw new ExtractionRefusal(`${REGISTRY_INDEX} did not yield an accepted \`REGISTRY\` object literal — refusing to extract from a registry the walker could not read`);
    }
    const registry = new Map<string, LiteralValue>(Object.entries(registryLiteral));
    // Each REGISTRY value is an identifier resolved from a leaf module; find which module declared
    // it so every emitted row can name its real source path (WS-13 §13: per-row source paths).
    const registrySourcePaths = new Map<string, string>();
    const declaringModule = new Map<string, string>();
    for (const [path, module] of modules) {
      for (const name of module.values.keys()) if (!declaringModule.has(name)) declaringModule.set(name, path);
    }
    const registryIdentifiers = registryIdentifierNames(fetched.read(REGISTRY_INDEX));
    for (const [id, identifier] of registryIdentifiers) {
      const path = declaringModule.get(identifier);
      if (path !== undefined) registrySourcePaths.set(id, path);
    }

    // --- SECRETS FLOOR over the RAW extraction, before anything is mapped -------------------------
    // `scanForSecrets` is exported for exactly this: the committed catalog is scanned too, but by
    // then a credential would already have been read into memory and could have reached a debug
    // dump. Scanning the raw literals is the earlier, stronger check.
    const rawFindings = scanForSecrets(Object.fromEntries([...modules].map(([path, m]) => [path, Object.fromEntries(m.values)])));
    if (rawFindings.length > 0) {
      throw new ExtractionRefusal(`the RAW upstream extraction carries credential-shaped material (${rawFindings.length} finding(s)) — refusing to continue:\n  ${rawFindings.slice(0, 20).join("\n  ")}`);
    }

    const moduleRejections: Rejection[] = [];
    const outOfAllowlistImports: string[] = [];
    for (const [path, module] of modules) {
      for (const rejection of module.rejections) {
        moduleRejections.push({ ...rejection, upstreamId: upstreamIdForRejection(path, rejection.path, registryIdentifiers) });
      }
      for (const specifier of module.outOfAllowlistImports) outOfAllowlistImports.push(`${path} -> ${specifier}`);
    }

    // DETERMINISM: the evidence instant comes from the PIN FILE, never from the clock. A
    // `new Date()` here would make every re-run differ in every evidence object, and
    // "byte-identical regeneration from the same commit + extractor" (WS-13 §13) would be
    // unsatisfiable by construction — the check would fail for a reason that has nothing to do
    // with upstream having changed.
    const observedAt = inputPin.observedAt;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt)) {
      throw new ExtractionRefusal(`third_party UPSTREAM.json \`observedAt\` must be an ISO-8601 INSTANT (the catalog validator rejects a date-only string), got ${JSON.stringify(observedAt)}`);
    }
    const layer = buildUpstreamLayer({
      allowlist,
      registry,
      categories,
      registrySourcePaths,
      commit: fetched.commit,
      observedAt,
      moduleRejections,
    });

    const denominator = computeDenominator({
      byCategory,
      registryIds: new Set(registryIdentifiers.keys()),
      registryIdsResolved: new Set(registry.keys()),
      claimSources: CLAIM_SOURCES.filter((p) => fetched.files.some((f) => f.path === p)).map((p) => ({ sourcePath: p, text: fetched.read(p) })),
    });

    const manifest = buildExtractionManifest({
      pin: { repository: inputPin.repository, tag: inputPin.tag, tagObject: fetched.tagObject, commit: fetched.commit, ...(inputPin.packageVersion !== undefined ? { packageVersion: inputPin.packageVersion } : {}) },
      extractorVersion: inputPin.extractorVersion,
      files: fetched.files,
      copiedTo: new Map(COPIED.map((c) => [c.upstreamPath, c.localPath])),
      outOfAllowlistImports,
    });

    const copiedText = new Map<string, string>();
    for (const { upstreamPath } of COPIED) {
      if (!fetched.files.some((f) => f.path === upstreamPath)) {
        throw new ExtractionRefusal(`the allowlist did not materialize ${upstreamPath} — a licence/notice file Winter must copy. Refusing to ship extracted data without its notices (WS-13 §13).`);
      }
      copiedText.set(upstreamPath, fetched.read(upstreamPath));
    }

    return {
      layer,
      manifest,
      denominator,
      pin: { tag: inputPin.tag, tagObject: fetched.tagObject, commit: fetched.commit, extractorVersion: inputPin.extractorVersion, overlayVersion: inputPin.overlayVersion },
      files: fetched.files,
      copiedText,
    };
  } finally {
    fetched.cleanup();
  }
}

/** `REGISTRY: { openai: openaiProvider, … }` -> `openai -> openaiProvider`, read straight from the text. */
function registryIdentifierNames(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = /export const REGISTRY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(text);
  if (body?.[1] === undefined) return out;
  for (const line of body[1].split("\n")) {
    const match = /^\s*"?([A-Za-z0-9_.-]+)"?\s*:\s*([A-Za-z0-9_$]+)\s*,?\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) out.set(match[1], match[2]);
  }
  return out;
}

/** Best-effort attribution of a field rejection to the upstream provider it belongs to. */
function upstreamIdForRejection(sourcePath: string, path: string, registryIdentifiers: ReadonlyMap<string, string>): string {
  const binding = path.split(/[.[]/)[0] ?? "";
  for (const [id, identifier] of registryIdentifiers) if (identifier === binding) return id;
  const dir = /registry\/([^/]+(?:\/[^/]+)?)\/index\.ts$/.exec(sourcePath);
  return dir?.[1] ?? "";
}

function writeOutputs(outcome: ExtractionOutcome, target: { thirdParty: string; pkg: string }): void {
  mkdirSync(join(target.pkg, "generated"), { recursive: true });
  mkdirSync(target.thirdParty, { recursive: true });
  writeFileSync(join(target.pkg, "generated", "upstream-layer.json"), render(outcome.layer));
  writeFileSync(join(target.pkg, "generated", "denominator.json"), render({ $comment: "GENERATED — the upstream provider-count denominators recomputed at the pin. WS-13 §3 step 5 requires the extractor to REPORT the 351/352 discrepancy rather than hide it; this file is that report, and PROVENANCE.md quotes its summary.", ...outcome.denominator }));
  writeFileSync(join(target.pkg, "UPSTREAM.json"), render({
    $comment:
      "GENERATED — do not edit. The pin `scripts/provider-catalog.ts` stamps onto the merged catalog; the extractor's INPUT pin lives in third_party/omniroute-provider-source/UPSTREAM.json. `tagObject` is the annotated tag's own object id and `commit` is that tag PEELED — they are different objects, and recording only one of them would not be a pin.",
    upstream: outcome.pin,
  }));
  writeFileSync(join(target.thirdParty, "extraction-manifest.json"), render(outcome.manifest));
  for (const { upstreamPath, localPath } of COPIED) {
    const text = outcome.copiedText.get(upstreamPath);
    if (text === undefined) continue;
    writeFileSync(join(target.thirdParty, localPath.split("/").pop()!), text);
  }
}

/**
 * Every model whose `endpoints` name a surface the adapter that will SERVE it does not speak.
 *
 * Keyed on the ADAPTER, deliberately, and this is the whole finding. Resolution hands a model to its
 * provider's `adapterId` (`registry.ts`) and NOTHING reads `provider.protocols` — so a gate that
 * consulted the protocols list could be satisfied by widening that list, which is precisely what
 * happened: `deepseek` declared `openai-responses` beside `openai-chat-completions` while its
 * adapter remained `winter.openai-chat-completions`, the gate went quiet, and two responses-only
 * rows still routed onto the Chat adapter. The declaration was never the thing that had to change.
 *
 * `responses` needs a Responses-shaped adapter; `chat` needs one that is not Responses-only. An
 * unknown adapter id is reported rather than waved through — a new adapter with no entry here is a
 * gap in this map, not a licence.
 *
 * Exported so the offline gate and its tests read one rule.
 */
export function findEndpointContradictions(catalog: { providers: WinterProviderDescriptor[]; models: WinterModelDescriptor[] }): string[] {
  const byId = new Map(catalog.providers.map((p) => [p.id, p]));
  const out: string[] = [];
  for (const model of catalog.models) {
    const provider = byId.get(model.providerId);
    if (provider === undefined) continue;
    const protocol = ADAPTER_PROTOCOL[provider.adapterId];
    if (protocol === undefined) {
      out.push(`${model.key}: provider "${provider.id}" names adapter "${provider.adapterId}", whose protocol this gate does not know — add it to ADAPTER_PROTOCOL rather than leaving the row unchecked`);
      continue;
    }
    // ONE DIRECTION ONLY, and the asymmetry is real rather than convenient. A RESPONSES-ONLY row
    // under a Chat Completions adapter has no surface that adapter can drive — that is the hazard,
    // and it is what shipped. The reverse is not a hazard: OpenAI's Responses API serves the models
    // whose `endpoints` say `chat` (the field records which surfaces a model is AVAILABLE on, not
    // which one its adapter picks), so flagging those would be false churn on eight healthy rows.
    const responsesShaped = protocol === "openai-responses" || protocol === "azure-openai";
    const responsesOnly = model.endpoints.includes("responses") && !model.endpoints.includes("chat");
    if (responsesOnly && !responsesShaped) {
      out.push(
        `${model.key} declares endpoints ${JSON.stringify(model.endpoints)} — RESPONSES ONLY — but provider "${provider.id}" is served by "${provider.adapterId}", which speaks ${protocol}, so the row would be serialized as Chat Completions. The provider's \`protocols\` list is NOT what decides this: resolution reads \`adapterId\` and nothing reads \`protocols\` at all.`,
      );
    }
  }
  return out.sort();
}

function readIfPresent(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "<missing>";
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  const offline = argv.includes("--offline");
  if (check && offline) {
    console.error("provider-source-sync: --check and --offline are mutually exclusive (one needs the network, the other refuses it)");
    return 2;
  }

  if (offline) return runOffline(false);

  let outcome: ExtractionOutcome;
  try {
    outcome = runExtraction();
  } catch (error) {
    console.error(`provider-source-sync: extraction REFUSED — ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (check) {
    const scratch = mkdtempSync(join(tmpdir(), "winter-catalog-check-"));
    try {
      writeOutputs(outcome, { thirdParty: join(scratch, "third_party"), pkg: join(scratch, "pkg") });
      const comparisons: Array<[string, string]> = [
        [UPSTREAM_LAYER, join(scratch, "pkg", "generated", "upstream-layer.json")],
        [DENOMINATOR, join(scratch, "pkg", "generated", "denominator.json")],
        [OUTPUT_PIN, join(scratch, "pkg", "UPSTREAM.json")],
        [MANIFEST, join(scratch, "third_party", "extraction-manifest.json")],
        [UPSTREAM_LICENSE, join(scratch, "third_party", "LICENSE")],
        [UPSTREAM_NOTICE, join(scratch, "third_party", "NOTICE")],
      ];
      let drift = false;
      for (const [committed, fresh] of comparisons) {
        if (readIfPresent(committed) !== readIfPresent(fresh)) {
          drift = true;
          console.error(`provider-source-sync --check: ${relative(fileURLToPath(REPO), committed)} DRIFTED from a fresh extraction of ${outcome.pin.commit}`);
        }
      }
      if (drift) return 1;
      console.log(`provider-source-sync --check: OK — byte-identical regeneration from ${outcome.pin.tag} (${outcome.pin.commit})`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    return runOffline(false);
  }

  const overlayBefore = OVERLAY_FILES.map((f) => readIfPresent(join(PKG, f)));
  writeOutputs(outcome, { thirdParty: THIRD_PARTY, pkg: PKG });
  const overlayAfter = OVERLAY_FILES.map((f) => readIfPresent(join(PKG, f)));
  for (let i = 0; i < OVERLAY_FILES.length; i++) {
    if (overlayBefore[i] !== overlayAfter[i]) {
      console.error(`provider-source-sync: a re-sync MODIFIED ${OVERLAY_FILES[i]} — WS-13 §7 forbids it outright. This is a bug in the extractor, not a data condition.`);
      return 1;
    }
  }
  console.log(
    `provider-source-sync: extracted ${outcome.layer.providers.length} provider(s) and ${outcome.layer.models.length} model(s) from ${outcome.pin.tag} (${outcome.pin.commit}); ${outcome.layer.rejections.length} rejection(s) recorded`,
  );
  console.log(`provider-source-sync: ${outcome.denominator.summary}`);
  return runOffline(true);
}

/**
 * The no-network half: validate the committed layer STANDALONE, then hand the merge to the frozen
 * catalog script.
 *
 * The standalone validation is not redundant. The merged catalog is validated by the script, but
 * every upstream provider row for the cohort is SHADOWED by an overlay row and therefore never
 * reaches that validation — an upstream row with a malformed endpoint or an unknown protocol would
 * sit in the committed layer indefinitely, and only surface the day someone removed its overlay
 * shadow.
 */
function runOffline(write = false): number {
  if (!existsSync(UPSTREAM_LAYER)) {
    console.error(`provider-source-sync --offline: ${relative(fileURLToPath(REPO), UPSTREAM_LAYER)} is missing — run \`bun run scripts/provider-source-sync.ts\` (network) to produce it`);
    return 1;
  }
  const layer = readJson<{ providers?: WinterProviderDescriptor[]; models?: WinterModelDescriptor[] }>(UPSTREAM_LAYER);
  const pin = readJson<{ upstream: { tag: string; tagObject: string; commit: string; extractorVersion: string; overlayVersion: string } }>(OUTPUT_PIN).upstream;
  const standalone = mergeLayers({ providers: layer.providers ?? [], models: layer.models ?? [] }, { providers: [], models: [] }, pin);
  const result = validateCatalog(standalone);
  if (!result.ok) {
    console.error(`provider-source-sync --offline: the UPSTREAM LAYER is invalid on its own (${result.errors.length} error(s)) — it would be hidden by its overlay shadows in the merged catalog:`);
    for (const error of result.errors) console.error(`  - [${error.code}] ${error.message}`);
    return 1;
  }

  // Hand the MERGE to the frozen script — it is the only writer of catalog.json/rejections.json, so
  // "regenerate then verify" is a single serializer verified against itself, never two.
  try {
    if (write) process.stdout.write(execFileSync("bun", ["run", CATALOG_SCRIPT], { cwd: fileURLToPath(REPO), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    process.stdout.write(execFileSync("bun", ["run", CATALOG_SCRIPT, "--check"], { cwd: fileURLToPath(REPO), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const stdout = (error as { stdout?: string }).stdout ?? "";
    console.error(`provider-source-sync: \`provider:catalog\` failed:\n${stdout}${stderr}`);
    return 1;
  }
  // --- the CROSS-LAYER consistency check the frozen validator structurally cannot do -------------
  //
  // `validateCatalog` sees one row at a time, and the merge is ROW-LEVEL (an overlay provider row
  // replaces its upstream twin whole). So an overlay provider can declare a narrower `protocols`
  // list than the upstream MODEL rows beneath it were built against — and the merged catalog
  // contradicts itself while every individual row validates cleanly. Not hypothetical: upstream's
  // deepseek entry is `format: "openai-responses"`, so its model rows land `endpoints: ["responses"]`
  // beneath an overlay provider that has to say so too, or a responses-only row reaches a Chat
  // Completions adapter.
  // BOTH layers, for the reason review round 1's I1 named: an overlay row shadows its upstream twin,
  // so a defect corrected in the overlay leaves the layer's own copy wrong and unread until the day
  // the shadow comes off. That is exactly how the Vertex adapter misroute survived a round.
  for (const [label, document] of [
    ["the UPSTREAM LAYER, standalone (shadowed rows are still checked)", { providers: layer.providers ?? [], models: layer.models ?? [] }],
    ["the MERGED catalog", readJson<{ providers: WinterProviderDescriptor[]; models: WinterModelDescriptor[] }>(OUT_CATALOG)],
  ] as const) {
    const contradictions = findEndpointContradictions(document);
    if (contradictions.length > 0) {
      console.error(`provider-source-sync: ${label} contradicts itself ACROSS LAYERS (${contradictions.length}) — the row-level merge's blind spot:`);
      for (const line of contradictions) console.error(`  - ${line}`);
      return 1;
    }
  }

  console.log(`provider-source-sync${write ? "" : " --offline"}: OK — the committed upstream layer validates standalone (${standalone.providers.length} providers, ${standalone.models.length} models), and BOTH layers are cross-layer consistent`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

export { main, runExtraction, runOffline, writeOutputs, COPIED, CATEGORY_CONSTS, APIKEY_BARREL, REGISTRY_INDEX, CLAIM_SOURCES, registryIdentifierNames, upstreamIdForRejection, THIRD_PARTY, PKG };

/** Local helper the tests reuse: every file under a directory, repository-relative. */
export function listSourceFiles(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: relative(root, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

