// Phase 6 Task 8 (Lane D): the OPT-IN live provider gate.
//
// THE ONLY THING IN THIS REPOSITORY THAT TALKS TO A REAL VENDOR ENDPOINT, and everything about it is
// arranged so that fact stays deliberate:
//
//   - it refuses to do anything without `WINTER_LIVE_PROVIDER_TESTS=1`, printing one line and
//     exiting 0 — so a CI runner, a hook, or a curious `bun run` costs nothing and hits nothing;
//   - it selects a provider ONLY when that provider's own `WINTER_LIVE_<PROVIDER>_API_KEY` is set.
//     There is no ambient scan and no conventional fallback: R6-10's "ambient env keys are NEVER
//     scanned implicitly" holds here exactly as it holds in the credential store, and an
//     `OPENAI_API_KEY` sitting in a developer's shell does not spend their money;
//   - credentials resolve through `{ kind: "env" }` and an ENV-ONLY credential store. No Keychain
//     store is constructed anywhere in this file, so "never the Keychain" is structural rather than
//     a promise;
//   - `WINTER_HOME` is repointed at a fresh mkdtemp before any run, and removed in `finally`;
//   - the output is provider/model identifiers, byte counts, token counts and durations. Never a
//     byte of what a provider returned (Global Constraints).
//
// NEVER IN CI. The CI workflow does not set the opt-in variable, no `.test.ts` imports the live
// runner, and `scripts/verify-provider-live.test.ts` proves the not-opted-in path by SPAWNING this
// script with every `WINTER_LIVE_*` variable stripped from the environment.
//
// Usage:
//   WINTER_LIVE_PROVIDER_TESTS=1 WINTER_LIVE_OPENAI_API_KEY=sk-... bun run scripts/verify-provider-live.ts
//   ... WINTER_LIVE_OPENAI_MODEL=openai/o4-mini          # override the model (a catalog key or a provider-local id)
//   ... WINTER_LIVE_OLLAMA_LOCAL_BASE_URL=http://127.0.0.1:11434/v1   # a local/gateway endpoint
//
// A local provider still needs its `_API_KEY` variable set to SOMETHING (anything: a local adapter
// ignores it) — selecting a target on any other signal would be the implicit scan the rule forbids.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createEnvCredentialStore, type ProviderAdapter } from "@yanlinglabs/winter-provider-runtime";
import { formatClassifierSafetyReport, formatLiveReport, runClassifierSafetyCorpus, runLiveCases } from "winter-provider-conformance";
import { adapterAsProvider } from "../packages/runtime/src/provider/bridge.ts";
import { createProviderContext, createSelectionRegistry, resolveSessionProvider } from "../packages/runtime/src/provider/selection.ts";
import { createModelClassifier } from "../packages/runtime/src/provider/classifier/model-classifier.ts";
import { normalizeAutoModeConfig } from "../packages/runtime/src/permissions/auto/config.ts";
import type { ActionEnvelope } from "../packages/runtime/src/permissions/auto/envelope.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";

/** The exact line the not-opted-in path prints. Exported so the fixture asserts on THIS string rather than a copy of it. */
export const SKIPPED_LINE = "verify:provider-live skipped: not opted in (set WINTER_LIVE_PROVIDER_TESTS=1 and at least one WINTER_LIVE_<PROVIDER>_API_KEY)";

export const OPT_IN_VAR = "WINTER_LIVE_PROVIDER_TESTS";

/**
 * `openai` -> `OPENAI`, `codex-oauth` -> `CODEX_OAUTH`, `ollama-local` -> `OLLAMA_LOCAL`.
 *
 * One function, used for all three variables, so a provider's key, model and base-url variables
 * cannot be spelled three different ways.
 */
export function liveEnvPrefix(providerId: string): string {
  return `WINTER_LIVE_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export interface LiveTarget {
  providerId: string;
  /** The variable that SELECTED this target. Reported so a run says which key it used without printing it. */
  keyEnvName: string;
  /** The catalog key (or a provider-local id when overridden). */
  model: string;
  baseUrl?: string;
}

export type LiveRunPlan = { optedIn: false; reason: string } | { optedIn: true; targets: LiveTarget[] };

/**
 * PURE. What a run WOULD do, given an environment and a catalog.
 *
 * Separated from the run so the not-opted-in path — the one behaviour that must be right on every
 * machine, including a developer's with real keys exported — is unit-testable without spawning
 * anything.
 */
export function planLiveRun(env: Record<string, string | undefined>, catalog: WinterCatalog): LiveRunPlan {
  if (env[OPT_IN_VAR] !== "1") return { optedIn: false, reason: SKIPPED_LINE };

  const targets: LiveTarget[] = [];
  for (const provider of catalog.providers) {
    const prefix = liveEnvPrefix(provider.id);
    const keyEnvName = `${prefix}_API_KEY`;
    const key = env[keyEnvName];
    if (typeof key !== "string" || key.trim().length === 0) continue;
    const overrideModel = env[`${prefix}_MODEL`];
    const model = overrideModel !== undefined && overrideModel.trim().length > 0 ? overrideModel.trim() : catalog.models.find((m) => m.providerId === provider.id)?.key;
    if (model === undefined) continue; // a provider with no catalog rows and no override has nothing to ask
    const baseUrl = env[`${prefix}_BASE_URL`];
    targets.push({ providerId: provider.id, keyEnvName, model, ...(baseUrl !== undefined && baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}) });
  }

  if (targets.length === 0) return { optedIn: false, reason: SKIPPED_LINE };
  return { optedIn: true, targets };
}

/** Where a merged adapter lane publishes its adapters. Absent until Lane A/B/N merges — read as a computed path so tsc never tries to resolve it. */
const ADAPTERS_INDEX = join(import.meta.dir, "..", "packages", "provider-runtime", "src", "adapters", "index.ts");

/**
 * Duck-types the adapters out of whatever the lanes' barrel exports.
 *
 * DUCK-TYPED because this file is written before any adapter lane has merged, and guessing at an
 * export NAME would be a guess that fails silently: an empty registry produces "no adapter
 * registered", which reads exactly like "the lane has not merged yet". Scanning for the SHAPE
 * (`{ id, version, streamTurn, validateCredential }`) cannot make that mistake — a value either is a
 * `ProviderAdapter` or it is not.
 */
export function collectAdapters(mod: Record<string, unknown>): ProviderAdapter[] {
  const found = new Map<string, ProviderAdapter>();
  const looksLikeAdapter = (value: unknown): value is ProviderAdapter => {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v["id"] === "string" && typeof v["version"] === "string" && typeof v["streamTurn"] === "function" && typeof v["validateCredential"] === "function";
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 2) return;
    if (looksLikeAdapter(value)) {
      found.set(value.id, value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1);
    }
  };
  visit(mod, 0);
  return [...found.values()];
}

async function loadAdapters(): Promise<{ adapters: ProviderAdapter[]; note: string }> {
  if (!existsSync(ADAPTERS_INDEX)) {
    return { adapters: [], note: `no adapters merged yet: ${ADAPTERS_INDEX} does not exist, so every provider will report "no adapter registered"` };
  }
  const specifier = ADAPTERS_INDEX;
  const mod = (await import(specifier)) as Record<string, unknown>;
  const adapters = collectAdapters(mod);
  return { adapters, note: `${adapters.length} adapter(s) registered from ${ADAPTERS_INDEX}: ${adapters.map((a) => `${a.id}@${a.version}`).join(", ") || "(none found — the barrel exported no ProviderAdapter-shaped value)"}` };
}

/** One benign envelope the live classifier leg reuses per corpus case. The CASE supplies the real one; this only fills the shared context. */
const LIVE_CLASSIFIER_CONTEXT = { autoConfig: normalizeAutoModeConfig(undefined), classifierContext: [] };

async function runTarget(target: LiveTarget, catalog: WinterCatalog, adapters: readonly ProviderAdapter[]): Promise<boolean> {
  const registry = createSelectionRegistry(catalog);
  for (const adapter of adapters) registry.register(adapter);

  const config: RuntimeConfig = {
    sessionId: `live-${target.providerId}`,
    cwd: process.cwd(),
    model: target.model,
    provider: {
      providerId: target.providerId,
      authRef: { kind: "env", name: target.keyEnvName },
      // An unlisted id is allowed through only where the provider's own live catalog is not
      // authoritative -- the registry enforces that; this merely permits a `_MODEL` override that
      // the seed catalog does not carry.
      allowUnlisted: true,
      // `local` is INFERRED from the URL here, where R6-11 makes it a host DECLARATION. That is
      // acceptable only because this script IS the host, opt-in, and developer-run: the person who
      // exported a loopback base url has already declared it by typing it. Nothing in the shipped
      // runtime infers this bit, and nothing should.
      ...(target.baseUrl !== undefined ? { connection: { baseUrl: target.baseUrl, local: target.baseUrl.includes("127.0.0.1") || target.baseUrl.includes("localhost") } } : {}),
    },
  };

  // ENV-ONLY, and there is no Keychain store anywhere in this file: "never the Keychain" is a fact
  // about what is constructed, not a rule someone has to remember.
  const credentials = createEnvCredentialStore({ env: process.env });
  const ctx = createProviderContext(config, {
    providerId: target.providerId,
    credentials,
    // Identifiers and byte counts only -- `ProviderContext.log`'s own contract.
    log: (event) => console.log(`    [${event.kind}] ${event.providerId}${event.model === undefined ? "" : ` ${event.model}`}${event.bytes === undefined ? "" : ` ${event.bytes}B`}`),
  });

  let selection;
  try {
    selection = resolveSessionProvider(config, { registry, credentials, env: process.env, buildProvider: (resolved) => adapterAsProvider(resolved, ctx) });
  } catch (err) {
    console.error(`  ${target.providerId}: FAILED to resolve -- ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return false;
  }
  if ("testProvider" in selection) {
    console.error(`  ${target.providerId}: resolved to the in-process test double, which is not a live provider`);
    return false;
  }

  const { resolved, identity, provider } = selection;
  console.log(`  ${target.providerId}: ${identity.modelKey} via ${identity.adapterId}@${identity.adapterVersion} (catalog ${identity.catalogVersion}, auth ${identity.authRefKind}:${target.keyEnvName})`);

  const report = await runLiveCases({
    providerId: target.providerId,
    modelKey: resolved.modelKey,
    adapter: resolved.adapter,
    ctx,
    model: resolved.providerModelId,
    ...(resolved.descriptor !== undefined ? { descriptor: resolved.descriptor } : {}),
  });
  console.log(formatLiveReport(report));

  // R6-14's evidence leg. RECORDED, never a gate: the ruling makes a live corpus pass the
  // precondition for setting `classifierEligible` in the overlay, and that is a human decision made
  // from this output -- not something a script may grant itself.
  const classifier = createModelClassifier({ provider, model: resolved.providerModelId, timeoutMs: 60_000 });
  const safety = await runClassifierSafetyCorpus(async (envelope) => classifier.classify(envelope as ActionEnvelope, LIVE_CLASSIFIER_CONTEXT), { label: `${identity.modelKey} (live)` });
  console.log(formatClassifierSafetyReport(safety));
  console.log(
    `  classifier-safety evidence for ${identity.modelKey}: ${safety.agreed}/${safety.total} agreed, ${safety.missedDenials} missed denial(s). ` +
      `R6-14 requires a clean pass before an overlay may set \`classifierEligible\`; this run does not set it and does not gate on it.`,
  );

  return report.ok;
}

export async function main(): Promise<void> {
  const plan = planLiveRun(process.env, loadCatalog());
  if (!plan.optedIn) {
    console.log(plan.reason);
    return;
  }

  const home = mkdtempSync(join(tmpdir(), "winter-live-"));
  // Set BEFORE anything that reads it. Nothing in this script reads WINTER_HOME today, and that is
  // exactly why it is set here rather than trusted to stay true: a later addition that does read it
  // must land in the temp home, not the developer's.
  const priorHome = process.env["WINTER_HOME"];
  process.env["WINTER_HOME"] = home;
  let ok = true;
  try {
    const catalog = loadCatalog();
    const { adapters, note } = await loadAdapters();
    console.log(`verify:provider-live -- catalog ${catalog.catalogVersion}, WINTER_HOME=${home}`);
    console.log(`  ${note}`);
    for (const target of plan.targets) {
      const targetOk = await runTarget(target, catalog, adapters);
      ok = ok && targetOk;
    }
  } finally {
    if (priorHome === undefined) delete process.env["WINTER_HOME"];
    else process.env["WINTER_HOME"] = priorHome;
    rmSync(home, { recursive: true, force: true });
  }

  if (!ok) {
    // `process.exitCode`, never `process.exit()` -- exiting here would skip the cleanup above
    // (verify-workflow.ts's own finding, and the same fix).
    console.error("verify:provider-live FAILED -- at least one live case failed above");
    process.exitCode = 1;
  } else {
    console.log("verify:provider-live OK");
  }
}

if (import.meta.main) {
  await main();
}
