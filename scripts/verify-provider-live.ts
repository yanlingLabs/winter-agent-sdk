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
//   | kind      | selector                                        | admitted when                          | credential store  |
//   |-----------|-------------------------------------------------|----------------------------------------|-------------------|
//   | api-key   | `WINTER_LIVE_<P>_API_KEY=<key>`                 | the row is not OAuth-only              | ENV-only          |
//   | oauth     | `WINTER_LIVE_<P>_CREDENTIAL_REF=keychain:<acct>`| `authKinds` includes `oauth-approved`  | the Keychain      |
//   | keyless   | `WINTER_LIVE_<P>=1`                             | `free` AND no `api-key` in `authKinds` | none              |
//
// Each arm cross-checks the row's OWN `authKinds` and refuses with a warning rather than relabelling
// (review round 1, Important #1) — see the three predicates below for why each half is load-bearing.
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
//   ... WINTER_LIVE_KEYCHAIN_SERVICE=com.winter.live.20260906               # ...in a throwaway service
//   ... WINTER_LIVE_UNCLOSEAI=1                          # a keyless row (`free`, and documents no api key)
//   ... WINTER_LIVE_AIHORDE_API_KEY=0000000000           # a free row that DOES document a key: the vendor's own anonymous value
//   ... WINTER_LIVE_OPENAI_MODEL=openai/o4-mini          # override the model (a catalog key or a provider-local id)
//   ... WINTER_LIVE_OLLAMA_LOCAL_BASE_URL=http://127.0.0.1:11434/v1   # a local/gateway endpoint
//
//   bun run scripts/verify-provider-live.ts --login anthropic   # get an OAuth credential IN (see `runLogin`)
//
// A local provider may be selected either way: `WINTER_LIVE_OLLAMA_LOCAL=1` (it is `free` and
// documents no key, so the keyless kind fits it honestly) or the older `_API_KEY=anything`.
// Selecting a target on any signal OTHER than one of these named variables would be the implicit
// scan the rule forbids.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog, type WinterCatalog, type WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createEnvCredentialStore, CredentialResolutionError, winterUserAgent, type CredentialStore, type ProviderAdapter } from "@yanlinglabs/winter-provider-runtime";
import { describeThrown, formatClassifierSafetyReport, formatLiveRow, formatLiveReport, runClassifierSafetyCorpus, runLiveTarget, type LiveTargetKindLabel } from "winter-provider-conformance";
import { adapterAsProvider } from "../packages/runtime/src/provider/bridge.ts";
import { createProviderContext, createSelectionRegistry, resolveSessionProvider } from "../packages/runtime/src/provider/selection.ts";
import { createKeychainCredentialStore, DEFAULT_KEYCHAIN_SERVICE } from "../packages/runtime/src/provider/keychain-store.ts";
import { startProviderLogin, type ProviderLoginId, type StartProviderLoginOptions } from "../packages/runtime/src/provider/credential-api.ts";
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

/**
 * WS-13b §1's three documented third-party paths, one target kind each.
 *
 * ALIASED rather than re-spelled: the row this kind ends up on is built in
 * `provider-conformance`, and two declarations of one union is the drift this repository polices
 * everywhere else. The package declares it because the package is the shared library; a package
 * importing a type out of `scripts/` would be the wrong direction.
 */
export type LiveTargetKind = LiveTargetKindLabel;

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

// -------------------------------------------------------------------------------------------------
// ONE PREDICATE PER ARM, checked against the row's OWN `authKinds` (review round 1, Important #1).
//
// The first version cross-checked only the api-key arm, and the widened catalog made both holes
// real. The oauth arm accepted a `_CREDENTIAL_REF` on ANY row, so `openai` + a ref produced
// `kind: "oauth"` and mislabelled the promotion evidence it is the whole purpose of this gate to
// produce. The keyless arm checked only `pricingBasis`, and X2 ships `aihorde` as a `free` row whose
// documented anonymous access is still an `apikey` header — so `WINTER_LIVE_AIHORDE=1` would have
// selected it keyless and sent nothing at all.
//
// A refusal + a warning, never a relabel: a gate that quietly demoted an oauth selector to api-key
// would produce a target the operator did not ask for, which is the failure mode this whole file is
// arranged against.
// -------------------------------------------------------------------------------------------------

/** The OAuth arm's precondition: the row documents an OAuth path at all. */
function admitsOauth(provider: WinterProviderDescriptor): boolean {
  return provider.authKinds.includes("oauth-approved");
}

/** The api-key arm's precondition, stated as its negation: an OAuth-only row issues no keys. */
function admitsApiKey(provider: WinterProviderDescriptor): boolean {
  // `cloud-credential-chain` is deliberately admitted here: `bedrock`, `vertex` and `azure-openai`
  // are selected by their `_API_KEY` variable today, and withdrawing that would be a regression
  // dressed as a tightening. What this rejects is the row that documents OAuth and nothing else.
  return !(admitsOauth(provider) && !provider.authKinds.includes("api-key"));
}

/**
 * The keyless arm's precondition, and it is a CONJUNCTION of two independent questions.
 *
 * `!authKinds.includes("api-key")` is the AUTH half: a row that documents a key wants one, even when
 * the vendor publishes an anonymous value for it (X2's `aihorde` — the operator supplies that value
 * through `WINTER_LIVE_AIHORDE_API_KEY`, which is an api-key target).
 *
 * `pricingBasis === "free"` is the MONEY half, and dropping it is not safe merely because the auth
 * half exists: `xai-oauth` is `subscription` + `oauth-approved` with no api-key kind, so the auth
 * half alone would admit `WINTER_LIVE_XAI_OAUTH=1` and fire an unauthenticated request at a
 * subscription endpoint. Both halves, one warning each.
 */
function admitsKeyless(provider: WinterProviderDescriptor): boolean {
  return provider.pricingBasis === "free" && !provider.authKinds.includes("api-key");
}

/**
 * The Keychain service the run resolves refs against, when a ref does not name one itself.
 *
 * The close-out live run (T6) uses a DEDICATED temporary service (`com.winter.live.<yyyymmdd>`) that
 * is created for the run and deleted after it, so `com.winter.core` and `com.winter.core.dev` are
 * never touched by this gate. Without this door that ruling has no mechanism.
 */
export const KEYCHAIN_SERVICE_VAR = "WINTER_LIVE_KEYCHAIN_SERVICE";

/**
 * `keychain:<account>` or `keychain:<service>/<account>` -> the ref.
 *
 * ONE disambiguation rule, and it is decidable rather than heuristic: after `keychain:`, if the text
 * before the FIRST `/` contains no colon it is a SERVICE; otherwise the whole remainder is the
 * account. It works because the two shapes are structurally different — a Keychain account is
 * `<providerId>:<accountId>` and R6-10 forbids a colon in the provider id, so an account ALWAYS
 * contains one; a service is a reverse-DNS name (`com.winter.core`) and never does. An account may
 * legitimately contain a slash (account ids are frequently URL-shaped, which `credential-api.ts`'s
 * own locator rules permit), and that case is exactly what the colon test keeps correct:
 *
 *   keychain:anthropic:acct-1                        -> account `anthropic:acct-1`, default service
 *   keychain:com.winter.live.20260906/anthropic:a1   -> account `anthropic:a1`, service `com.winter.live.20260906`
 *   keychain:anthropic:https://id.example/u/1        -> account `anthropic:https://id.example/u/1`, default service
 *
 * The account is NOT trimmed of its own inner text and is never rendered by this script's output;
 * only the variable that named it is (Global Constraints put an account id with keys and tokens).
 */
function parseKeychainRef(raw: string): CredentialRef | undefined {
  const value = raw.trim();
  const prefix = "keychain:";
  if (!value.startsWith(prefix)) return undefined;
  const rest = value.slice(prefix.length).trim();
  if (rest.length === 0) return undefined;
  // A leading slash is the service form with its service half missing. It is refused rather than
  // read as an account beginning with `/`, which no `keychainAccountName` ever produces.
  if (rest.startsWith("/")) return undefined;
  const slash = rest.indexOf("/");
  if (slash > 0 && !rest.slice(0, slash).includes(":")) {
    const service = rest.slice(0, slash).trim();
    const account = rest.slice(slash + 1).trim();
    if (service.length === 0 || account.length === 0) return undefined;
    return { kind: "keychain", account, service };
  }
  return { kind: "keychain", account: rest };
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

    const authKinds = `authKinds=${provider.authKinds.join(",")}`;
    let selected: { kind: LiveTargetKind; selectedBy: string; authRef: CredentialRef } | undefined;
    if (ref !== undefined) {
      const authRef = parseKeychainRef(ref);
      if (!admitsOauth(provider)) {
        warnings.push(`${refEnvName} names ${provider.id}, which documents no OAuth path (${authKinds}); a keychain ref here would label the run's evidence "oauth" for a row that has no such path`);
      } else if (authRef === undefined) {
        warnings.push(`${refEnvName} is not a \`keychain:<account>\` or \`keychain:<service>/<account>\` locator, so ${provider.id} was skipped (the OAuth kind resolves through the Keychain and nothing else)`);
      } else {
        // The ref WINS over a key variable on the same provider, and says so. It is the more specific
        // declaration — it names one Keychain record — and on a dual-auth row (WS-13b §3 gives
        // `anthropic` both) the two variables can legitimately be exported at once from two different
        // sessions of work.
        if (key !== undefined) warnings.push(`${provider.id} names both ${refEnvName} and ${keyEnvName}; the credential ref wins and the API-key variable is unused`);
        selected = { kind: "oauth", selectedBy: refEnvName, authRef };
      }
    } else if (key !== undefined) {
      if (!admitsApiKey(provider)) {
        warnings.push(`${keyEnvName} names ${provider.id}, whose documented path is OAuth and not an API key (${authKinds}); use ${refEnvName}=keychain:<account>`);
      } else {
        selected = { kind: "api-key", selectedBy: keyEnvName, authRef: { kind: "env", name: keyEnvName } };
      }
    } else if (keyless) {
      // The ONLY guard between `WINTER_LIVE_OPENAI=1` and an unauthenticated request to a paid
      // endpoint: selection resolves `{kind:"none"}` to null on every store and the adapter simply
      // sends no Authorization header, so nothing downstream objects. Two independent reasons to
      // refuse, reported separately because they are different mistakes.
      if (provider.pricingBasis !== "free") {
        warnings.push(`${keylessEnvName}=1 names ${provider.id}, whose pricingBasis is "${provider.pricingBasis}"; the keyless kind is for \`free\` rows only`);
      } else if (provider.authKinds.includes("api-key")) {
        warnings.push(
          `${keylessEnvName}=1 names ${provider.id}, which documents an API key (${authKinds}) even though it is free; ` +
            `supply the vendor's own value — the documented anonymous one where there is one — through ${keyEnvName}`,
        );
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
function credentialStoreFor(kind: LiveTargetKind, env: Record<string, string | undefined>): CredentialStore {
  switch (kind) {
    case "oauth": {
      // The Keychain store, reached from a local operator run and from nowhere else (see the
      // header). Constructed lazily, per target, so a run with no oauth target never touches
      // `Bun.secrets` at all.
      //
      // Service precedence, and there are three levels rather than two: a REF that names its own
      // service wins (that is `keychain-store.ts`'s documented behaviour, not something added here),
      // then `WINTER_LIVE_KEYCHAIN_SERVICE`, then the production default. The middle level is what
      // lets the close-out live run point the whole gate at a throwaway service.
      const service = env[KEYCHAIN_SERVICE_VAR]?.trim();
      return service !== undefined && service.length > 0 ? createKeychainCredentialStore(service) : createKeychainCredentialStore();
    }
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

  const credentials = credentialStoreFor(target.kind, process.env);
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

  // ONE call, not `runLiveCases` followed by a separate fold: the row must be built from the run it
  // names, and a two-call site is one where a later edit can report a row for something else — or
  // forget the row entirely.
  const { report, row } = await runLiveTarget({
    providerId: target.providerId,
    modelKey: resolved.modelKey,
    adapter: resolved.adapter,
    ctx,
    model: resolved.providerModelId,
    ...(resolved.descriptor !== undefined ? { descriptor: resolved.descriptor } : {}),
    // A PROVIDER fact, off the resolved row rather than the model descriptor. It gates the
    // inference-path reversion case (WS-13b §4), which is about an entitlement.
    pricingBasis: resolved.provider.pricingBasis,
    kind: target.kind,
    // What THIS BUILD sends. That it is actually on the wire is pinned by the corpus, not observed here.
    identityHeader: winterUserAgent(),
  });
  console.log(formatLiveReport(report));
  // The one-line per-target ROW (WS-13b §7), printed after the per-case detail because it is the
  // line that gets pasted into a report.
  console.log(formatLiveRow(row));

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

// -------------------------------------------------------------------------------------------------
// `--login <providerId>`: how an OAuth credential gets IN.
//
// Without this door the oauth target kind is unreachable in practice. `WINTER_LIVE_<P>_CREDENTIAL_REF`
// names a Keychain record, and nothing in this repository could put one there under a service the
// operator chose — `startProviderLogin` is a library function with no command-line surface, and the
// close-out live run's ruling (a throwaway `com.winter.live.<yyyymmdd>` service, never
// `com.winter.core`) exists precisely so the run does not touch the operator's real records.
//
// IT IS A VENDOR NETWORK CALL, so it sits behind the same `WINTER_LIVE_PROVIDER_TESTS=1` opt-in as
// everything else here, and `verify-provider-live.test.ts`'s spawn helper refuses `--login` for the
// same reason it refuses a credential-ref variable. Its tests drive it IN-PROCESS against the
// loopback OAuth fakes with a memory store — the shape `runtime/src/provider/credential-api.test.ts`
// already uses for `startProviderLogin` — so no test spawns it and no test reaches the Keychain.
//
// THE SUCCESS LINE PRINTS THE OPERATOR'S OWN ACCOUNT NAME, on the operator's own terminal, because
// the whole point is to hand them the exact `WINTER_LIVE_<P>_CREDENTIAL_REF` value to export. It is
// never captured into this repository: no fixture, golden or log in the tree carries a real account,
// and the gate's own per-target output identifies a target by the VARIABLE that named it.
// -------------------------------------------------------------------------------------------------

/** Mirrors `ProviderLoginId`. A bare string from `argv` is validated against it before it reaches the door. */
export const PROVIDER_LOGIN_IDS: readonly ProviderLoginId[] = ["anthropic", "codex-oauth", "xai-oauth", "qoder"];

export interface LoginIo {
  /**
   * Where a loopback flow's authorization URL goes. Production PRINTS it; a device-code flow never
   * calls this at all (RFC 8628 — the user code arrives on `onAuthStatus` instead).
   */
  openUrl: (url: string) => Promise<void>;
  log: (line: string) => void;
  /**
   * FIXTURES ONLY, and the same two honest uses `WINTER_LIVE_ADAPTERS_MODULE` has: a hermetic test
   * needs a memory store and loopback endpoints, and nothing shipped supplies either. Production
   * passes neither — the store is the Keychain and the endpoints are each flow's own derived
   * constants.
   */
  store?: CredentialStore;
  overrides?: Partial<StartProviderLoginOptions>;
}

/**
 * Runs one provider's login and reports the ref the credential now occupies.
 *
 * Returns whether it succeeded rather than throwing, so `main` can set an exit code without a second
 * error-rendering rule. Every failure renders through `describeThrown`'s discipline: class name and
 * normalized code, never a vendor's message body.
 */
export async function runLogin(providerId: string, env: Record<string, string | undefined>, io: LoginIo): Promise<boolean> {
  if (env[OPT_IN_VAR] !== "1") {
    io.log(`--login skipped: not opted in (set ${OPT_IN_VAR}=1; a login is a vendor network call like any other on this gate)`);
    return false;
  }
  if (!PROVIDER_LOGIN_IDS.includes(providerId as ProviderLoginId)) {
    io.log(`--login: "${providerId}" has no login flow; one of ${PROVIDER_LOGIN_IDS.join(", ")}`);
    return false;
  }
  const service = env[KEYCHAIN_SERVICE_VAR]?.trim();
  const named = service !== undefined && service.length > 0 ? service : undefined;
  const store = io.store ?? (named !== undefined ? createKeychainCredentialStore(named) : createKeychainCredentialStore());
  io.log(`--login ${providerId} into keychain service ${named ?? DEFAULT_KEYCHAIN_SERVICE}`);
  try {
    const result = await startProviderLogin(providerId as ProviderLoginId, store, {
      openUrl: io.openUrl,
      // A PROGRESS channel, never material (R6-F): a device flow's verification URL and user code
      // arrive here, and they are the two strings the person signing in actually needs.
      onAuthStatus: (status) => {
        for (const line of status.output ?? []) io.log(`  ${line}`);
        if (status.error !== undefined) io.log(`  ${status.error}`);
      },
      ...(named !== undefined ? { service: named } : {}),
      ...io.overrides,
    });
    const locator = result.ref.service === undefined ? result.ref.account : `${result.ref.service}/${result.ref.account}`;
    io.log(`  stored. Export this:`);
    io.log(`    export ${liveEnvPrefix(providerId)}${CREDENTIAL_REF_SUFFIX}='keychain:${locator}'`);
    return true;
  } catch (err) {
    // Identity only. A login failure's message can carry a vendor's error body, and this line reaches
    // a terminal — except for a `CredentialResolutionError`, whose message is Winter-authored and is
    // the whole diagnosis (`qoder`'s "not wired in this build" is the case that matters here).
    io.log(`  login FAILED: ${err instanceof CredentialResolutionError ? `${err.name}: ${err.message}` : describeThrown(err)}`);
    return false;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const loginAt = argv.indexOf("--login");
  if (loginAt !== -1) {
    const providerId = argv[loginAt + 1];
    if (providerId === undefined) {
      console.error(`--login needs a provider id: one of ${PROVIDER_LOGIN_IDS.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const ok = await runLogin(providerId, process.env, { openUrl: async (url) => void console.log(`  open this URL to continue: ${url}`), log: (line) => console.log(line) });
    if (!ok) process.exitCode = 1;
    return;
  }

  const plan = planLiveRun(process.env, loadCatalog());
  // Warnings first, on BOTH arms. A provider that was named and then dropped is the case an operator
  // most needs told: without this, `WINTER_LIVE_CODEX_OAUTH_API_KEY` alone prints "not opted in" to
  // someone who plainly did opt in.
  for (const warning of plan.warnings ?? []) console.error(`  warning: ${warning}`);
  if (!plan.optedIn) {
    console.log(plan.reason);
    // EXIT 1 when the operator opted in, named at least one provider, and got nothing (review round
    // 1, minor 6). Exiting 0 there tells a script and a human the same thing a genuinely idle run
    // tells them, which is the one reading that is wrong. An untouched environment still exits 0:
    // no variable was named, so nothing was refused.
    if ((plan.warnings ?? []).length > 0) {
      console.error("verify:provider-live FAILED -- every provider named above was refused; no target ran");
      process.exitCode = 1;
    }
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
