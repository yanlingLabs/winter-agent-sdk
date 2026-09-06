// Phase 6 Task 8 (Lane D): the OPT-IN live provider gate.
//
// THE ONLY THING IN THIS REPOSITORY THAT TALKS TO A REAL VENDOR ENDPOINT, and everything about it is
// arranged so that fact stays deliberate:
//
//   - it refuses to do anything without `WINTER_LIVE_PROVIDER_TESTS=1`, printing one line and
//     exiting 0 — so a CI runner, a hook, or a curious `bun run` costs nothing and hits nothing;
//   - it selects a provider ONLY when one of that provider's OWN three variables is set. There is no
//     ambient scan and no conventional fallback: R6-10's "ambient env keys are NEVER scanned
//     implicitly" holds here exactly as it holds in the credential store, and an `OPENAI_API_KEY`
//     sitting in a developer's shell does not spend their money;
//   - `WINTER_HOME` is repointed at a fresh mkdtemp before any run, and removed in `finally`;
//   - the output is provider/model identifiers, byte counts, token counts and durations. Never a
//     byte of what a provider returned (Global Constraints).
//
// P6.5 (WS-13b §1) ADMITS THREE DOCUMENTED THIRD-PARTY PATHS, so this gate selects three KINDS of
// target — one per path, each with its own variable and its own credential store:
//
//   | kind      | selector                                        | credential store        |
//   |-----------|-------------------------------------------------|-------------------------|
//   | api-key   | `WINTER_LIVE_<P>_API_KEY=<key>`                 | ENV-only                |
//   | oauth     | `WINTER_LIVE_<P>_CREDENTIAL_REF=keychain:<acct>`| the production Keychain |
//   | keyless   | `WINTER_LIVE_<P>=1` (a `free` row only)         | none                    |
//
// THE KEYCHAIN STORE IS CONSTRUCTED ONLY INSIDE THE OAUTH BRANCH, and only when the plan actually
// holds an oauth target. Phase 6's version of this file could say "no Keychain store is constructed
// anywhere in this file", which is no longer true and must not be left standing as a comment; what
// replaces it is narrower and still structural — an api-key or keyless target cannot reach the
// Keychain, because the store it would need is never built on its path. Under `bun test` no oauth
// target exists at all: `verify-provider-live.test.ts`'s spawn helper REFUSES a `_CREDENTIAL_REF`
// variable outright (and fires that refusal in a test), so the only way to this store is a local
// operator run.
//
// NEVER REACHES A VENDOR FROM CI. The workflow sets neither the opt-in variable nor any provider
// key (`grep -rn WINTER_LIVE .github/` finds nothing), and `verify-provider-live.test.ts` proves the
// skip path by SPAWNING this script with every `WINTER_LIVE_*` variable stripped from the inherited
// environment — stripping rather than merely not-adding, because `bun test` inherits the developer's
// shell.
//
// That same test DOES drive a full run, on purpose: its I1 fixture spawns this script against a
// loopback fake with a scripted adapter injected through `WINTER_LIVE_ADAPTERS_MODULE`, which is how
// the "identifiers and byte counts only" rule above is proved rather than asserted. The property that
// keeps it hermetic is that the fixture pins BOTH the endpoint and the adapter; a future fixture that
// omitted either would go live.
//
// Usage:
//   WINTER_LIVE_PROVIDER_TESTS=1 WINTER_LIVE_OPENAI_API_KEY=sk-... bun run scripts/verify-provider-live.ts
//   ... WINTER_LIVE_XAI_OAUTH_CREDENTIAL_REF=keychain:xai-oauth:<account>   # an OAuth row, from the Keychain
//   ... WINTER_LIVE_AIHORDE=1                            # a keyless row (a `free` row only)
//   ... WINTER_LIVE_OPENAI_MODEL=openai/o4-mini          # override the model (a catalog key or a provider-local id)
//   ... WINTER_LIVE_OLLAMA_LOCAL_BASE_URL=http://127.0.0.1:11434/v1   # a local/gateway endpoint
//
// A local provider may be selected either way: `WINTER_LIVE_OLLAMA_LOCAL=1` (it is a `free` row, so
// the keyless kind fits it honestly) or the older `_API_KEY=anything`. Selecting a target on any
// signal OTHER than one of these three named variables would be the implicit scan the rule forbids.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, type WinterCatalog, type WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createEnvCredentialStore, winterUserAgent, type CredentialStore, type ProviderAdapter } from "@yanlinglabs/winter-provider-runtime";
import { formatClassifierSafetyReport, formatLiveRow, liveRowSummary, formatLiveReport, runClassifierSafetyCorpus, runLiveCases } from "winter-provider-conformance";
import { adapterAsProvider } from "../packages/runtime/src/provider/bridge.ts";
import { createProviderContext, createSelectionRegistry, resolveSessionProvider } from "../packages/runtime/src/provider/selection.ts";
import { createKeychainCredentialStore } from "../packages/runtime/src/provider/keychain-store.ts";
import { createModelClassifier } from "../packages/runtime/src/provider/classifier/model-classifier.ts";
import { normalizeAutoModeConfig } from "../packages/runtime/src/permissions/auto/config.ts";
import type { ActionEnvelope } from "../packages/runtime/src/permissions/auto/envelope.ts";
import type { CredentialRef, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";

/** The exact line the not-opted-in path prints. Exported so the fixture asserts on THIS string rather than a copy of it. */
export const SKIPPED_LINE =
  "verify:provider-live skipped: not opted in (set WINTER_LIVE_PROVIDER_TESTS=1 and at least one of WINTER_LIVE_<PROVIDER>_API_KEY, WINTER_LIVE_<PROVIDER>_CREDENTIAL_REF=keychain:<account>, or WINTER_LIVE_<PROVIDER>=1 for a free row)";

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

/**
 * The suffix of the ONE selector that reaches the production Keychain (WS-13b §1 prong 2).
 *
 * Exported so `verify-provider-live.test.ts`'s spawn helper refuses it by the same constant this
 * file reads, rather than by a second copy of the spelling.
 */
export const CREDENTIAL_REF_SUFFIX = "_CREDENTIAL_REF";

/** WS-13b §1's three documented third-party paths, one target kind each. */
export type LiveTargetKind = "api-key" | "oauth" | "keyless";

export interface LiveTarget {
  providerId: string;
  kind: LiveTargetKind;
  /**
   * The environment variable that SELECTED this target.
   *
   * A variable NAME, never its value, and never the keychain account either: Global Constraints put
   * account ids in the same class as keys and tokens, so the run's own output identifies a target by
   * the thing the operator typed on the left of the `=`.
   */
  selectedBy: string;
  /** How the credential resolves: `env` for api-key, `keychain` for oauth, `none` for keyless. Data, not output. */
  authRef: CredentialRef;
  /** The catalog key (or a provider-local id when overridden). */
  model: string;
  baseUrl?: string;
}

export type LiveRunPlan =
  | { optedIn: false; reason: string; warnings?: string[] }
  | { optedIn: true; targets: LiveTarget[]; warnings?: string[] };

/**
 * True when this row's documented path is OAuth and NOT an API key.
 *
 * Stated as "includes oauth-approved and excludes api-key" rather than "is exactly
 * `['oauth-approved']`", so a dual-auth row (WS-13b §3 gives `anthropic` both) keeps its api-key
 * selector. `cloud-credential-chain` is deliberately NOT part of this test: `bedrock`, `vertex` and
 * `azure-openai` are selected by their `_API_KEY` variable today and withdrawing that would be a
 * regression dressed as a tightening.
 */
function isOauthOnly(provider: WinterProviderDescriptor): boolean {
  return provider.authKinds.includes("oauth-approved") && !provider.authKinds.includes("api-key");
}

/** `keychain:<account>` -> the ref. The account may itself contain colons (`xai-oauth:acct`), so only the FIRST is a separator. */
function parseKeychainRef(raw: string): CredentialRef | undefined {
  const value = raw.trim();
  const prefix = "keychain:";
  if (!value.startsWith(prefix)) return undefined;
  const account = value.slice(prefix.length).trim();
  if (account.length === 0) return undefined;
  return { kind: "keychain", account };
}

/**
 * PURE. What a run WOULD do, given an environment and a catalog.
 *
 * Separated from the run so the not-opted-in path — the one behaviour that must be right on every
 * machine, including a developer's with real keys exported — is unit-testable without spawning
 * anything. The OAuth kind's selection is unit-tested HERE and nowhere else: resolving it needs the
 * production Keychain, and no test may reach that.
 *
 * `warnings` carries every provider that named a variable and was NOT selected, so an operator who
 * mistypes one selector does not read the plain "not opted in" line and conclude the opt-in failed.
 * Warnings name VARIABLES; they never carry a value, a key, a token or an account id.
 */
export function planLiveRun(env: Record<string, string | undefined>, catalog: WinterCatalog): LiveRunPlan {
  if (env[OPT_IN_VAR] !== "1") return { optedIn: false, reason: SKIPPED_LINE };

  const targets: LiveTarget[] = [];
  const warnings: string[] = [];
  const named = (value: string | undefined): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

  for (const provider of catalog.providers) {
    const prefix = liveEnvPrefix(provider.id);
    const refEnvName = `${prefix}${CREDENTIAL_REF_SUFFIX}`;
    const keyEnvName = `${prefix}_API_KEY`;
    const keylessEnvName = prefix;
    const ref = named(env[refEnvName]);
    const key = named(env[keyEnvName]);
    const keyless = env[keylessEnvName] === "1";

    let selected: { kind: LiveTargetKind; selectedBy: string; authRef: CredentialRef } | undefined;
    if (ref !== undefined) {
      const authRef = parseKeychainRef(ref);
      if (authRef === undefined) {
        warnings.push(`${refEnvName} is not a \`keychain:<account>\` locator, so ${provider.id} was skipped (the OAuth kind resolves through the Keychain and nothing else)`);
      } else {
        // The ref WINS over a key variable on the same provider, and says so. It is the more specific
        // declaration — it names one Keychain record — and on a dual-auth row (WS-13b §3) both
        // variables can legitimately be exported at once from two different sessions of work.
        if (key !== undefined) warnings.push(`${provider.id} names both ${refEnvName} and ${keyEnvName}; the credential ref wins and the API-key variable is unused`);
        selected = { kind: "oauth", selectedBy: refEnvName, authRef };
      }
    } else if (key !== undefined) {
      if (isOauthOnly(provider)) {
        warnings.push(`${keyEnvName} names ${provider.id}, whose documented path is OAuth and not an API key (authKinds=${provider.authKinds.join(",")}); use ${refEnvName}=keychain:<account>`);
      } else {
        selected = { kind: "api-key", selectedBy: keyEnvName, authRef: { kind: "env", name: keyEnvName } };
      }
    } else if (keyless) {
      // The ONLY guard between `WINTER_LIVE_OPENAI=1` and an unauthenticated request to a paid
      // endpoint: selection resolves `{kind:"none"}` to null on every store and the adapter simply
      // sends no Authorization header, so nothing downstream objects. `pricingBasis` decides because
      // it is the field WS-13b §1 requires on every row — a keyless path is a `free` one by
      // definition, and a priced row reached without a credential can only 401.
      if (provider.pricingBasis !== "free") {
        warnings.push(`${keylessEnvName}=1 names ${provider.id}, whose pricingBasis is "${provider.pricingBasis}"; the keyless kind is for \`free\` rows only`);
      } else {
        selected = { kind: "keyless", selectedBy: keylessEnvName, authRef: { kind: "none" } };
      }
    }
    if (selected === undefined) continue;

    const overrideModel = named(env[`${prefix}_MODEL`]);
    const model = overrideModel ?? catalog.models.find((m) => m.providerId === provider.id)?.key;
    if (model === undefined) {
      // Previously a silent `continue`. A provider that was named and then dropped is exactly the
      // case the warnings channel exists for.
      warnings.push(`${selected.selectedBy} names ${provider.id}, which has no catalog model row; set ${prefix}_MODEL to a provider-local id`);
      continue;
    }
    const baseUrl = named(env[`${prefix}_BASE_URL`]);
    targets.push({ providerId: provider.id, ...selected, model, ...(baseUrl !== undefined ? { baseUrl } : {}) });
  }

  const carried = warnings.length > 0 ? { warnings } : {};
  if (targets.length === 0) return { optedIn: false, reason: SKIPPED_LINE, ...carried };
  return { optedIn: true, targets, ...carried };
}

/** The plan's shape, per kind. Printed BEFORE the run so an operator sees what is about to be spent. */
export function countByKind(targets: readonly LiveTarget[]): Record<LiveTargetKind, number> {
  const counts: Record<LiveTargetKind, number> = { "api-key": 0, oauth: 0, keyless: 0 };
  for (const target of targets) counts[target.kind] += 1;
  return counts;
}

function formatKindCounts(counts: Record<LiveTargetKind, number>): string {
  return `${counts["api-key"]} api-key, ${counts.oauth} oauth, ${counts.keyless} keyless`;
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

/**
 * A DEV/TEST override for where adapters come from (`WINTER_LIVE_ADAPTERS_MODULE`).
 *
 * Two honest uses, and no third: this gate's own hermetic fixture needs a scripted adapter pointed at
 * a loopback fake in order to prove what this script does and does not print, and a developer
 * iterating on an adapter before its lane merges needs to be able to drive it. Both are already
 * inside the trust boundary — nothing reaches this line without the operator having set
 * `WINTER_LIVE_PROVIDER_TESTS=1` and named one of their own API keys. It is deliberately NOT a
 * general plugin mechanism: no shipped code path reads it.
 */
export const ADAPTERS_MODULE_VAR = "WINTER_LIVE_ADAPTERS_MODULE";

async function loadAdapters(env: Record<string, string | undefined>): Promise<{ adapters: ProviderAdapter[]; note: string }> {
  const override = env[ADAPTERS_MODULE_VAR];
  const source = override !== undefined && override.trim().length > 0 ? override.trim() : ADAPTERS_INDEX;
  if (!existsSync(source)) {
    return {
      adapters: [],
      note:
        source === ADAPTERS_INDEX
          ? `no adapters merged yet: ${ADAPTERS_INDEX} does not exist, so every provider will report "no adapter registered"`
          : `${ADAPTERS_MODULE_VAR} points at ${source}, which does not exist`,
    };
  }
  const specifier = source;
  const mod = (await import(specifier)) as Record<string, unknown>;
  const adapters = collectAdapters(mod);
  return { adapters, note: `${adapters.length} adapter(s) registered from ${source}: ${adapters.map((a) => `${a.id}@${a.version}`).join(", ") || "(none found — the module exported no ProviderAdapter-shaped value)"}` };
}

/** One benign envelope the live classifier leg reuses per corpus case. The CASE supplies the real one; this only fills the shared context. */
const LIVE_CLASSIFIER_CONTEXT = { autoConfig: normalizeAutoModeConfig(undefined), classifierContext: [] };

/**
 * ONE store per target, chosen by KIND — the store an api-key target gets cannot read the Keychain,
 * and the store a keyless target gets cannot read anything at all.
 *
 * A composite store would have been shorter and would have made "never the Keychain" a property of
 * ref kinds rather than of what exists on the path. This shape keeps the Keychain constructor inside
 * one branch a reviewer can grep for, which is the whole argument of this file's header.
 */
function credentialStoreFor(kind: LiveTargetKind): CredentialStore {
  switch (kind) {
    case "oauth":
      // The PRODUCTION store, `com.winter.core`, reached from a local operator run and from nowhere
      // else (see the header). It is constructed lazily, per target, so a run with no oauth target
      // never touches `Bun.secrets` at all.
      return createKeychainCredentialStore();
    case "api-key":
      return createEnvCredentialStore({ env: process.env });
    case "keyless":
      // `{kind:"none"}` resolves to null on every store; an EMPTY env store makes that structural
      // rather than incidental — this target has nothing it could send even by mistake.
      return createEnvCredentialStore({ env: {} });
  }
}

async function runTarget(target: LiveTarget, catalog: WinterCatalog, adapters: readonly ProviderAdapter[]): Promise<boolean> {
  const registry = createSelectionRegistry(catalog);
  for (const adapter of adapters) registry.register(adapter);

  const config: RuntimeConfig = {
    sessionId: `live-${target.providerId}`,
    cwd: process.cwd(),
    model: target.model,
    provider: {
      providerId: target.providerId,
      authRef: target.authRef,
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

  const credentials = credentialStoreFor(target.kind);
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
  // `target.selectedBy` is a VARIABLE NAME. The keychain account behind an oauth target is never
  // rendered here: Global Constraints class an account id with keys and tokens.
  console.log(`  ${target.providerId}: ${identity.modelKey} via ${identity.adapterId}@${identity.adapterVersion} (catalog ${identity.catalogVersion}, kind ${target.kind}, auth ${identity.authRefKind} named by ${target.selectedBy})`);

  const report = await runLiveCases({
    providerId: target.providerId,
    modelKey: resolved.modelKey,
    adapter: resolved.adapter,
    ctx,
    model: resolved.providerModelId,
    ...(resolved.descriptor !== undefined ? { descriptor: resolved.descriptor } : {}),
  });
  console.log(formatLiveReport(report));
  // The one-line per-target ROW (WS-13b §7), printed after the per-case detail because it is the
  // line that gets pasted into a report. `identityHeader` is what THIS BUILD sends; that it is
  // actually on the wire is pinned by the corpus, not observed here.
  console.log(formatLiveRow(liveRowSummary(report, { kind: target.kind, identityHeader: winterUserAgent() })));

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
  // Warnings first, on BOTH arms. A provider that was named and then dropped is the case an operator
  // most needs told: without this, `WINTER_LIVE_CODEX_OAUTH_API_KEY` alone prints "not opted in" to
  // someone who plainly did opt in.
  for (const warning of plan.warnings ?? []) console.error(`  warning: ${warning}`);
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
  const failedByKind: Record<LiveTargetKind, number> = { "api-key": 0, oauth: 0, keyless: 0 };
  try {
    const catalog = loadCatalog();
    const { adapters, note } = await loadAdapters(process.env);
    console.log(`verify:provider-live -- catalog ${catalog.catalogVersion}, WINTER_HOME=${home}`);
    console.log(`  ${note}`);
    // What this run is ABOUT to do, per kind, before it does any of it.
    console.log(`  ${plan.targets.length} target(s): ${formatKindCounts(countByKind(plan.targets))}`);
    for (const target of plan.targets) {
      const targetOk = await runTarget(target, catalog, adapters);
      if (!targetOk) failedByKind[target.kind] += 1;
      ok = ok && targetOk;
    }
    console.log(`  verdict: ${plan.targets.length} target(s) run -- ${formatKindCounts(countByKind(plan.targets))}; failed: ${formatKindCounts(failedByKind)}`);
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
