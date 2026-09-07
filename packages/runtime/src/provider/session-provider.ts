// Phase 6 Task 10 (R6-9/R6-10/R6-11/R6-13/R6-14/R6-17): THE production provider wiring.
//
// `selection.ts` resolves an identity and refuses to invent one. `bridge.ts` turns a resolved
// adapter into the engine's `Provider`. `registry.ts` maps a model string onto a catalog row. Every
// one of those was reachable only from a test until this file existed — which is exactly the P5
// lesson this phase was told to avoid: a seam declared upstream proves nothing across the seam.
//
// WHAT THIS FILE IS. The ONE place a live session's provider is built, called from
// `production-wiring.ts` so all three transport legs (the in-memory harness, a spawned `winter`
// child, the compiled binary) derive from one piece of code — the same reason
// `buildProductionWiring` itself exists (WS-04 §12 makes a per-leg divergence a release blocker).
//
// FOUR THINGS IT REFUSES TO DO, each of them a ruling rather than a preference:
//
//   1. NO SILENT DEFAULT (R6-9). A session with no resolvable model does not fall back to an echo
//      provider or to a built-in model — its refusal is DEFERRED onto its first generation (review
//      round 1, Critical A): the session starts, `system/init` carries no `winter_provider`, and the
//      first `generate()` throws the typed `WinterProviderResolutionError`, which lands on R6-F's
//      pinned result shape. A session that cannot say which model it is running never generates.
//   5. NO CREDENTIAL INHERITANCE ACROSS PROVIDERS (fix wave, Ruling E-1). A provider built for a
//      target on ANOTHER provider than the session's -- a classifier, an advisor, an R6-17 child --
//      never receives the session's `authRef` or the session's user `connection`. See
//      `describeTargetMaterial` for the three-step rule and the fixture that pins it.
//   2. NO SECOND `ProviderContext` CONSTRUCTOR. `createProviderContext` (selection.ts) is the only
//      one, because the stall timeout, the auth ref and the log sink are five decisions a second
//      constructor would silently make differently — and `sse.ts` reads `ctx.stallTimeoutMs` on
//      every chunk, so a context assembled without it disables R6-6's watchdog on every stream.
//   3. NO DEMOTION OF A REVIEWED ENDPOINT. `connection.baseUrl` is a USER endpoint by definition
//      (Lane A's decision 1), so copying the catalog's `defaultEndpoints.api` into it turns a
//      GENERATED endpoint into a user one and `applyPrivilegedHeaders` then drops `originator`,
//      `chatgpt-account-id`, `OpenAI-Organization` and `OpenAI-Project` — silently, because dropping
//      them is the CORRECT behaviour for a user endpoint. The copy happens only where there is no
//      vendor default to fall back to; see `connectionForProvider` for the exact rule and the
//      fixture that pins it.
//   4. NO AMBIENT CREDENTIAL SCAN (R6-10). The composite store below can serve `env` refs, but only
//      ones a host NAMED. Nothing here reads `ANTHROPIC_API_KEY` because it happened to be exported.
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialRef, ProviderConnectionConfig, ProviderSelection, RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialStore, ModelInfo, ProviderContext, ProviderRegistry, ResolvedModel } from "@yanlinglabs/winter-provider-runtime";
import {
  CredentialResolutionError,
  WinterProviderResolutionError,
  createCompositeCredentialStore,
  createEndpointResolver,
  createEnvCredentialStore,
  estimateCostUsd,
  createFileCredentialStore,
  createHistoryRenderer,
  createMemoryCredentialStore,
  createRegistry,
  createShippedAdapters,
} from "@yanlinglabs/winter-provider-runtime";
import type { MessageOrigin } from "@yanlinglabs/winter-provider-runtime";
import { createKeychainCredentialStore } from "./keychain-store.ts";
import { providerCredentialRef } from "./credential-api.ts";
import { adapterAsProvider, type HistoryRenderer } from "./bridge.ts";
import { testProviderForNamespace } from "./mock.ts";
import { createProviderContext, redactCredentialRef, resolveSessionProvider, type SelectionDeps, type SessionProviderSelection, type WinterProviderIdentity } from "./selection.ts";
import { createModelClassifier, selectClassifierRoute, type ClassifierRoute } from "./classifier/model-classifier.ts";
import type { ClassifierInterface } from "../permissions/auto/engine.ts";
import { buildContinuationChain, type ContinuationChain, type ProviderStateRecord } from "../store/provider-state.ts";
import type { ModelSwitchResolution, PricedUsage, Provider, ProviderRequest, ProviderTurn, ProviderUsage, ResolveModelSwitch } from "../engine.ts";
import type { SlotProviderResolution } from "./slots.ts";

/**
 * The pinned `ApiKeySource` vocabulary (`sdk.d.ts:127`), of which the JSDoc marks five members
 * legacy — the live set is these four.
 *
 * WINTER'S MAPPING, and it is a DISCLOSED gap-fill rather than a translation. The union has exactly
 * one spelling for "an API key", and it names an environment variable: `'ANTHROPIC_API_KEY'`. It has
 * no spelling for "a key from the Keychain", "a key from a file" or "a key the host passed inline" —
 * every credential shape R6-10 adds. So Winter reports `'ANTHROPIC_API_KEY'` for exactly that env
 * name and `'none'` for everything else, on the pin's own gloss that `'none'` means "not via an API
 * key" and is what the pinned runtime itself reports for OAuth, bearer and third-party-cloud auth.
 *
 * The REAL fact is never lost: it rides `winter_provider.authRefKind` on the same frame, which is
 * where a consumer that cares about Winter's credential model is supposed to look. Inventing a fifth
 * member of a closed pinned union would be the divergence; reporting the pin's own catch-all is not.
 */
export type ApiKeySource = "ANTHROPIC_API_KEY" | "apiKeyHelper" | "/login managed key" | "none";

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

export function apiKeySourceFor(ref: CredentialRef | undefined): ApiKeySource {
  if (ref === undefined) return "none";
  if (ref.kind === "env" && ref.name === ANTHROPIC_API_KEY_ENV) return "ANTHROPIC_API_KEY";
  return "none";
}

/** The `AccountInfo` shape the pin declares (`sdk.d.ts:23-33`) — every field optional, an empty object valid. */
export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "anthropicAws" | "anthropicGoogleCloud" | "mantle" | "gateway";
}

/**
 * `AccountInfo.apiProvider`'s eight members are the pin's own provider-family enumeration, and its
 * JSDoc partitions them exactly the way WS-13 does — which is why this map is a lookup rather than
 * an invention. A provider with no member of its own reports nothing at all rather than being forced
 * into `'firstParty'`, whose JSDoc reserves it for Anthropic OAuth.
 */
const API_PROVIDER_BY_PROVIDER_ID: Readonly<Record<string, AccountInfo["apiProvider"]>> = {
  anthropic: "firstParty",
  bedrock: "bedrock",
  vertex: "vertex",
  "azure-openai": "foundry",
  openrouter: "gateway",
};

export interface SessionProviderOptions {
  /** The session's EFFECTIVE config. */
  config: RuntimeConfig;
  /** The environment governing R6-13's harness alias and the `env` credential store. Explicit at every entrypoint. */
  env: Record<string, string | undefined>;
  /** Injected in tests so a fixture owns its own rows. Production: the catalog compiled into this build. */
  catalog?: WinterCatalog;
  /** Injected in tests (an in-memory store). Production: keychain + env + file + inline, composed below. */
  credentials?: CredentialStore;
  /**
   * R6-13: the reserved `winter-test/<name>` namespace's in-process double.
   *
   * DEFAULTS TO `testProviderForNamespace` (`provider/mock.ts`) — the namespace is a DISCLOSED test
   * affordance that exists in production by ruling, not an injection point a caller has to remember,
   * and a default that refused it would make the namespace work on one leg and not another. A caller
   * overrides it only to supply something the shared table cannot: `main.ts` wraps it to register the
   * `bgtask` fixture's paired TOOL, and `testing.ts` replaces it with the live JS provider its caller
   * handed the leg — the one thing a spawned process can never be given.
   */
  testProviders?: (name: string) => Provider | undefined;
  /**
   * R6-7: the resumed continuation chain, as a GETTER.
   *
   * A getter rather than a value because the chain is re-attached asynchronously at the start of the
   * run (`attachContinuationChain`), after this wiring is built — a captured snapshot would always
   * be the empty one.
   */
  chain?: () => ContinuationChain;
  /** `ProviderContext.log` — provider/model identifiers and BYTE COUNTS only, never content. Defaults to a no-op. */
  log?: ProviderContext["log"];
  /**
   * The OS home the `file` credential store resolves `~/.aws/credentials` under.
   *
   * Explicit at every entrypoint and NEVER defaulted to `os.homedir()` here: a default would make
   * every test that forgot to set it read the developer's real credentials file, which is precisely
   * the hazard the Global Constraints forbid. `env.HOME` is the caller's usual answer.
   */
  home?: string;
  /**
   * WS-13b R6b-7: the resolved `settings.providers` map, as a GETTER (see `SelectionDeps`' own
   * field for why a getter is the hot-reload seam).
   *
   * Threaded into selection AND read again at the `set_model` seam: R6-K put resolution under the
   * session provider precisely so a switch cannot walk around a rule the session start applied, and
   * a disable that held only at start would be exactly such a walk-around.
   */
  providerSettings?: () => Record<string, { enabled: boolean }> | undefined;
  /**
   * WS-13c §4 step 6 (P6.6): the slot resolver, so `set_model` accepts a SLOT NAME.
   *
   * Consulted only for a BARE name — a qualified `<providerId>/<model>` key is already an
   * unambiguous statement and goes straight to R6-K's own rules, unchanged. A refusal is returned as
   * the seam's typed refusal and becomes the control response, exactly like `provider-mismatch`:
   * never a parked switch, never a substitution.
   *
   * ABSENT -> `set_model` keeps its pre-P6.6 shape verbatim (every scripted double, every pre-P6.6
   * fixture, and the reserved `winter-test/<name>` namespace, for which the wiring withholds it).
   */
  resolveSlot?: (requested: string, currentModelKey: string | undefined) => SlotProviderResolution;
}

export interface SessionProviderWiring {
  /** What `runEngine` is handed. Either the catalog-resolved adapter chain or the reserved namespace's scripted double. */
  provider: Provider;
  registry: ProviderRegistry;
  credentials: CredentialStore;
  catalog: WinterCatalog;
  /** ABSENT for a `winter-test/<name>` session: a scripted double has no catalog identity, and putting a fake row in the init frame would be worse than omitting it. */
  identity?: WinterProviderIdentity;
  resolved?: ResolvedModel;
  /**
   * PRESENT when selection REFUSED, in which case this wiring's `provider` is the one that rethrows
   * the refusal on its first generation (see `buildSessionProvider`'s own header for the ruling).
   *
   * Exposed rather than swallowed so an entrypoint can also report the reason on stderr: the frame
   * stream is the host's channel, stderr is the operator's, and a refusal deserves both.
   */
  resolutionError?: WinterProviderResolutionError;
  /** R6-9: the pinned `system/init.apiKeySource`. Always present — the pin makes the field REQUIRED. */
  apiKeySource: ApiKeySource;
  /** P4 carry: `toolCalling === "native"`, from the descriptor's own evidence. Absent when nothing is known. */
  providerSupportsToolSearch?: boolean;
  /** The descriptor's context window, unless the host set `contextWindowTokens` explicitly. */
  contextWindowTokens?: number;
  /** R6-14: which classifier this session got, and why. Recorded so `fallback_state` can name the reason. */
  classifierRoute: ClassifierRoute;
  /** ABSENT unless the route produced a real one — `createAutoEngine`'s own default (always `no_verdict`) is what a manual fallback means. */
  classifier?: ClassifierInterface;
  /** The advisor/reviewer backend (P2 carry, `config.advisor.model`). Absent when unconfigured. */
  advisorProvider?: Provider;
  /**
   * Builds a `Provider` for any resolved model against THAT TARGET's material (Ruling E-1), the
   * session's renderer and the session's chain.
   *
   * Exposed because R6-17's per-child provider needs the identical construction — a child built
   * through a second construction path would get a different context (and, per
   * `createProviderContext`'s own header, could silently lose the stall watchdog).
   */
  buildProvider(resolved: ResolvedModel, opts?: BuildProviderOptions): Provider;
  /** Ruling E-1: WHICH credential and connection `buildProvider` would use for this target, and why. Pure -- no store is consulted. */
  describeTargetMaterial(resolved: ResolvedModel, opts?: BuildProviderOptions): TargetMaterial;
  /** The provider this session is configured for (`config.provider.providerId`, else the resolved model's). Undefined only for a session with neither. */
  sessionProviderId(): string | undefined;
  /**
   * P6 fix wave (Ruling E-2): THE SWITCH SEAM -- `EngineOptions.resolveModelSwitch`. R6-K resolution
   * under the session provider, `buildProvider` under Ruling E-1, the resolved identity, and the two
   * continuity endpoints `classifySwitch` compares. Present on every arm: a session that started
   * unresolvable can be handed a model that resolves and recover.
   */
  resolveModelSwitch: ResolveModelSwitch;
  /** P6 fix wave (Ruling E-3): `fallbackModel`'s candidates as catalog keys, in order, domain-checked at init. Empty for the reserved namespace and for a refused session. */
  fallbackModelKeys: string[];
  /** P6 fix wave (Ruling E-4, R6-H): prices one generation for the model it ran on, from the catalog's `pricing` evidence. `undefined` for an unpriced row. */
  priceUsage(modelKey: string, usage: ProviderUsage): PricedUsage | undefined;
  /** P6 fix wave (Ruling E-5, R6-14): the resolved classifier model's key, for the session pin. Present exactly when `classifier` is. */
  classifierIdentity?: { modelKey: string };
  /** R6-I: the `supportedModels()` rows for this session. */
  supportedModels(): ModelInfo[];
  /** R6-I / capture (d): the initialize-response account surface. Never `system/init` — the pin has no account field there. */
  accountInfo(): AccountInfo;
}

/** What a caller may pass to `buildProvider`. `authRef` is the target ROUTE's own credential (a classifier's `autoClassifier.authRef`, an advisor's `advisor.authRef`). */
export interface BuildProviderOptions {
  authRef?: CredentialRef;
}

/**
 * Ruling E-1: the credential and connection a provider built for `resolved` is given.
 *
 * `source` records which step of the rule answered:
 *   - `route`            an explicit `authRef` on the target's own route;
 *   - `session`          the target IS the session's provider, so the session's own material;
 *   - `provider-record`  the target provider's OWN keychain record (`<providerId>:default`, R6-10's
 *                        one-record-per-provider/account), whose existence the built provider
 *                        verifies on its first generation and refuses (typed) when absent.
 *
 * `crossProvider` is the fact every consumer keys on: a cross-provider target's `connection` is its
 * own generated endpoint -- never the session's user `baseUrl`/headers.
 */
export interface TargetMaterial {
  authRef: CredentialRef;
  connection?: ProviderConnectionConfig;
  source: "route" | "session" | "provider-record";
  crossProvider: boolean;
}

/** The account id a target provider's OWN keychain record is looked up under when a route names no ref (Ruling E-1 step 2). Disclosed in WS-13 §6. */
export const DEFAULT_PROVIDER_ACCOUNT_ID = "default";

/**
 * The production credential store: Keychain, then env, then file, then inline.
 *
 * COMPOSED, not chosen: a `CredentialRef` names its own kind, every member answers `null` (or a
 * typed `unsupported` the composite skips) for a ref it does not own, so the order is about which
 * member gets asked first and not about precedence between competing answers.
 *
 * The Keychain member is FIRST and is constructed unconditionally, which is safe because
 * `keychain-store.ts` resolves `Bun.secrets` LAZILY — a session with no keychain ref never touches
 * it, and a runtime without it reports a typed failure at the point of use rather than at import.
 */
export function createProductionCredentialStore(config: RuntimeConfig, env: Record<string, string | undefined>, home: string): CredentialStore {
  // THE KEYCHAIN MEMBER IS ADAPTED, and the reason is a genuine disagreement between two shipped
  // contracts that only a live composition can expose.
  //
  // `createCompositeCredentialStore` advances to its next member ONLY when the current one throws a
  // typed `unsupported`; it RETURNS whatever else the member answers, `null` included.
  // `createKeychainCredentialStore` answers `null` for a ref it does not own -- and its own header
  // says it does so *for the composite's benefit*. Both are unit-tested against their own reading.
  // Composed as written, the keychain member answers `null` first for every `env`/`file`/`inline`
  // ref and the composite returns it: EVERY non-keychain credential in production resolves to "no
  // credential", and the failure surfaces as an unauthenticated provider call, far from here.
  //
  // Adapted at the composition site rather than fixed in either file: each is correct in isolation,
  // and this is the one place that has to pick a reading.
  const keychain = createKeychainCredentialStore(config.keychainService);
  return createCompositeCredentialStore([
    {
      ...keychain,
      async get(ref) {
        if (ref.kind !== "keychain") throw new CredentialResolutionError("unsupported", `the keychain credential store does not serve ${ref.kind} refs`);
        return keychain.get(ref);
      },
    },
    createEnvCredentialStore({ env }),
    // `home` is the OS home the default `~/.aws/credentials` location resolves under, PASSED rather
    // than read here: a test that let this reach the developer's real home would be reading a real
    // credentials file, which no test may do.
    createFileCredentialStore({ env, home }),
    // `inline` (and `none`) live here: `createMemoryCredentialStore` resolves an inline value and
    // NEVER retains it (R6-10 makes it a host responsibility), which is why the inline arm is a
    // store rather than a branch in this function.
    createMemoryCredentialStore(),
  ]);
}

/**
 * The connection profile for one resolved provider.
 *
 * THE RULE, and the fixture `production-wiring.test.ts` pins it in both directions:
 *
 *   - The operator's own `connection.baseUrl` always wins, verbatim, and is a USER endpoint.
 *   - Otherwise the catalog's `defaultEndpoints.api` is copied in ONLY when the adapter has no
 *     vendor default of its own to fall back to — which is exactly the adapters that serve MORE THAN
 *     ONE provider (`winter.local-openai`'s twelve local runners, `winter.openai-chat-completions`'s
 *     deepseek and openrouter). One adapter, many vendors, no single default.
 *   - Otherwise nothing is set, so the adapter uses its own reviewed endpoint and
 *     `applyPrivilegedHeaders` still has something to gate.
 *
 * "Serves more than one provider" is deliberately computed from the catalog rather than hard-coded,
 * and the fixture asserts BOTH directions (`openai`/`anthropic` get no baseUrl; `deepseek` and a
 * local runner do). If a future catalog row put a second provider on `winter.openai-responses`, that
 * fixture fails loudly rather than the endpoint being demoted silently.
 */
export function connectionForProvider(config: RuntimeConfig, catalog: WinterCatalog, provider: WinterProviderDescriptor): ProviderConnectionConfig | undefined {
  const configured = config.provider?.connection;
  return connectionFrom(configured, catalog, provider);
}

/**
 * Ruling E-1: a CROSS-PROVIDER target's connection. The session's user `connection` is NOT consulted
 * -- a user `baseUrl` and its headers belong to the session's own provider -- so the target reaches
 * its own generated endpoint (copied into the profile for a multi-provider adapter, per the rule
 * above; left to the adapter's reviewed default otherwise).
 */
export function generatedConnectionForProvider(catalog: WinterCatalog, provider: WinterProviderDescriptor): ProviderConnectionConfig | undefined {
  return connectionFrom(undefined, catalog, provider);
}

function connectionFrom(configured: ProviderConnectionConfig | undefined, catalog: WinterCatalog, provider: WinterProviderDescriptor): ProviderConnectionConfig | undefined {
  if (configured?.baseUrl !== undefined && configured.baseUrl.length > 0) return configured;
  const sharesAdapter = catalog.providers.filter((p) => p.adapterId === provider.adapterId).length > 1;
  if (!sharesAdapter) return configured;
  const api = provider.defaultEndpoints["api"];
  if (api === undefined || api.length === 0) return configured;
  return {
    ...configured,
    baseUrl: api,
    // A LOCAL installation is declared, not guessed: `evaluateEndpoint` refuses plain http to a
    // private address unless the profile says so, and every one of the twelve local runners is
    // exactly that shape. `modelDiscovery: "local"` is the catalog's own statement that this
    // provider IS a local installation.
    ...(provider.modelDiscovery === "local" ? { local: true } : {}),
  };
}

/** One descriptor lookup over the whole catalog, by key / provider-local id / alias, scoped to a provider. */
function descriptorFor(catalog: WinterCatalog, modelKey: string): WinterModelDescriptor | undefined {
  return catalog.models.find((m) => m.key === modelKey);
}

/**
 * Builds the session's provider, identity, classifier and account surface.
 *
 * NEVER THROWS for an unresolvable session model (R6-9, as reversed in review round 1): the refusal
 * is DEFERRED -- this returns a wiring whose `provider.generate()` rethrows the typed
 * `WinterProviderResolutionError`, so the session still starts, `system/init` is emitted (with no
 * `winter_provider`), and the first generation lands on R6-F's pinned result shape before `query()`
 * throws. `resolutionError` carries the reason so an entrypoint can also report it on stderr.
 */
export function buildSessionProvider(opts: SessionProviderOptions): SessionProviderWiring {
  const { config, env } = opts;
  const catalog = opts.catalog ?? loadCatalog();
  const credentials = opts.credentials ?? createProductionCredentialStore(config, env, opts.home ?? env["HOME"] ?? "");
  const registry = createRegistry(catalog);
  for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);

  // Lane C's renderer, NOT `createIdentityHistoryRenderer` — the T3 identity renderer is the
  // conservative placeholder its own header says it is (no decoration at all), so selecting it here
  // would leave every cross-family decoration Lane C built inert in production while its unit tests
  // stayed green.
  const renderer: HistoryRenderer = createHistoryRenderer(registry);
  const chain = opts.chain ?? ((): ContinuationChain => new Map());

  // THE SESSION'S PROVIDER, AS A STATE (fix wave round 2, R-E1). Three states, and the difference
  // between the last two is a credential boundary:
  //   - `resolving`: selection has not completed. The ONLY target `buildProvider` sees in this state
  //     is the session's own model (`resolveSessionProvider` builds it through `deps.buildProvider`),
  //     and the session's own model is never cross-provider.
  //   - `{ known }`: the provider selection resolved to, or -- for a session whose model FAILED to
  //     resolve -- the provider selection's own rule names: `config.provider.providerId`, else the
  //     qualified key's prefix (a qualified `<providerId>/<model>` key IS a provider selection). THE
  //     RESOLVED ID WINS over `config.provider.providerId`: selection ignores the latter for a
  //     qualified key, so the key's provider is the session's and its `authRef`/`connection` were
  //     configured for it.
  //   - `unknown`: nothing names a provider (a refused session with neither, or the reserved test
  //     namespace). `describeTargetMaterial` then FAILS CLOSED: every target is treated as another
  //     provider and gets ITS OWN record or a typed refusal -- never the session's material, which
  //     re-review probe P4 showed reaching vendor B through a later `set_model` on a refused session.
  let sessionProvider: "resolving" | "unknown" | { known: string } = "resolving";
  const sessionProviderId = (): string | undefined => (typeof sessionProvider === "object" ? sessionProvider.known : undefined);
  /** Selection's own reading of which provider a REFUSED session named: the configured id, else the qualified prefix when it is a catalog provider. */
  const providerNamedByConfig = (): string | undefined => {
    if (config.provider?.providerId !== undefined) return config.provider.providerId;
    const model = config.model ?? "";
    const slash = model.indexOf("/");
    if (slash <= 0) return undefined;
    const prefix = model.slice(0, slash);
    return catalog.providers.some((p) => p.id === prefix) ? prefix : undefined;
  };

  /**
   * RULING E-1 -- the credential and connection rule for every provider this wiring builds.
   *
   * Resolution order for the TARGET's material:
   *   (1) an explicit `authRef` on the target's own route (`autoClassifier.authRef`, `advisor.authRef`);
   *   (2) the session's own material -- ONLY when the target is the session's own provider;
   *   (3) the target provider's OWN keychain record (`<providerId>:default`; R6-10 keeps one record
   *       per provider/account), verified at the built provider's first generation and refused with
   *       a typed `no-credential-for-provider` when absent.
   *
   * What never happens: a target on another provider receiving the session's `authRef`, or the
   * session's user `baseUrl`/headers. Probe P1 of the whole-branch review showed exactly that --
   * vendor A's key on the wire to vendor B's endpoint -- and this function is the closed door.
   */
  const describeTargetMaterial = (resolved: ResolvedModel, buildOpts: BuildProviderOptions = {}): TargetMaterial => {
    // `resolving`: the session's own model, never cross-provider (see the state's own comment).
    // `unknown`: FAIL CLOSED -- cross-provider, so the target gets its own record or a typed refusal.
    // `{ known }`: the ordinary comparison.
    const crossProvider = sessionProvider === "resolving" ? false : sessionProvider === "unknown" ? true : resolved.providerId !== sessionProvider.known;
    // A cross-provider target's connection is ITS OWN generated endpoint; the session's user
    // connection (a proxy, a gateway, custom headers) is the session provider's business.
    const connection = crossProvider ? generatedConnectionForProvider(catalog, resolved.provider) : connectionForProvider(config, catalog, resolved.provider);
    if (buildOpts.authRef !== undefined) {
      return { authRef: buildOpts.authRef, ...(connection !== undefined ? { connection } : {}), source: "route", crossProvider };
    }
    if (!crossProvider) {
      return { authRef: config.provider?.authRef ?? { kind: "none" }, ...(connection !== undefined ? { connection } : {}), source: "session", crossProvider };
    }
    return {
      authRef: providerCredentialRef({ providerId: resolved.providerId, accountId: DEFAULT_PROVIDER_ACCOUNT_ID, ...(config.keychainService !== undefined ? { service: config.keychainService } : {}) }),
      ...(connection !== undefined ? { connection } : {}),
      source: "provider-record",
      crossProvider,
    };
  };

  const buildProvider = (resolved: ResolvedModel, buildOpts: BuildProviderOptions = {}): Provider => {
    const material = describeTargetMaterial(resolved, buildOpts);
    // The config handed to `createProviderContext` carries the TARGET's material and nothing of the
    // session's selection beyond `allowUnlisted`: `providerId` is the resolved model's own (a
    // qualified `<providerId>/<model>` key is a provider selection), `authRef` and `connection` are
    // what `describeTargetMaterial` chose. `createProviderContext` stays the ONE constructor.
    const selectionForContext: ProviderSelection = {
      providerId: resolved.providerId,
      authRef: material.authRef,
      ...(material.connection !== undefined ? { connection: material.connection } : {}),
      ...(config.provider?.allowUnlisted !== undefined ? { allowUnlisted: config.provider.allowUnlisted } : {}),
    };
    const ctx = createProviderContext(
      { ...config, provider: selectionForContext },
      { providerId: resolved.providerId, credentials, ...(opts.log !== undefined ? { log: opts.log } : {}) },
    );
    const built = adapterAsProvider(resolved, ctx, { renderer, chain });
    if (material.source !== "provider-record") return built;
    // Step (3)'s VERIFICATION. The record is looked up before the first request rather than left to
    // the adapter: an adapter reports a missing credential as its own family's auth failure, which
    // reads as "the key was rejected" when the truth is "no key was ever configured for this
    // provider". Verified once; the material itself is never held here (R6-10).
    let verified = false;
    return {
      async generate(input: ProviderRequest): Promise<ProviderTurn> {
        if (!verified) {
          const found = await credentials.get(material.authRef);
          if (found === null) {
            throw new WinterProviderResolutionError(
              "no-credential-for-provider",
              `no credential is configured for provider "${resolved.providerId}" (looked up the keychain record ${redactCredentialRef(material.authRef)}); a target on another provider than this session's never inherits the session's credential -- store one for "${resolved.providerId}" or pass the route its own \`authRef\``,
            );
          }
          verified = true;
        }
        return built.generate(input);
      },
    };
  };

  // RULING E-2: the switch seam. Resolution goes UNDER THE SESSION PROVIDER (R6-K), so a bare id, an
  // alias and this provider's own qualified key all resolve here, and a key qualified for ANOTHER
  // provider is a `provider-mismatch` refusal -- never a substitution, never a parked switch. The
  // `from` endpoint is looked up through the same registry the renderer uses, so the classification
  // and the replay decision cannot disagree about a domain.
  const endpointFor = createEndpointResolver(registry);
  const familyOf = (origin: MessageOrigin): string => {
    if (typeof origin.family === "string" && origin.family.length > 0) return origin.family;
    // A persisted identity carries no family (the resume-time comparison); the adapter's is the fact.
    const resolvedFrom = registry.resolve({ model: origin.modelKey, provider: { providerId: origin.providerId } });
    return resolvedFrom instanceof WinterProviderResolutionError ? "" : String(resolvedFrom.adapter.family);
  };
  const resolveModelSwitch: ResolveModelSwitch = (model, from) => {
    // WS-13c §4 step 6: a BARE name may be a slot (`luna`, `opus`, a custom slot's facing name) or a
    // canonical id, and the slot resolver is what turns either into a concrete row. Only a bare name
    // — a qualified key already names its provider, and reading it as a slot would be a second,
    // competing interpretation of the same string.
    let target = model;
    let slotProviderId: string | undefined;
    if (!model.includes("/") && opts.resolveSlot !== undefined) {
      const slot = opts.resolveSlot(model, from?.modelKey ?? config.model);
      // A typed refusal is the ANSWER, not a reason to fall through to `registry.resolve`: falling
      // through would report `unknown-model` for a name that is really "two families call a model
      // `flash`" or "nothing you have configured serves it", which is strictly less true.
      if (!slot.ok) return { refused: true, code: slot.code, message: slot.message };
      target = slot.modelKey;
      slotProviderId = slot.providerId;
    }
    // A SLOT'S OWN PROVIDER, not the session's. The slot resolver has ALREADY made the provider
    // decision (§4's ordering, under this session's credentials and enable settings), so passing the
    // session's id beside a cross-provider key would hit R6-K's `provider-mismatch` — a refusal for
    // a contradiction the caller never stated. WS-13c §5 makes cross-family sets explicitly legal,
    // so this is the case R6-K's rule was never written about, and the two agree: the key and the
    // provider id given here always name the same provider, so nothing is being reinterpreted.
    const providerId = slotProviderId ?? sessionProviderId();
    const result = registry.resolve({
      model: target,
      ...(providerId !== undefined || config.provider?.allowUnlisted !== undefined
        ? { provider: { ...(providerId !== undefined ? { providerId } : {}), ...(config.provider?.allowUnlisted !== undefined ? { allowUnlisted: config.provider.allowUnlisted } : {}) } }
        : {}),
    });
    if (result instanceof WinterProviderResolutionError) return { refused: true, code: result.code, message: result.message };
    // WS-13b R6b-7: the SECOND door into a provider. Read through the getter, so a settings change
    // between the session's start and this switch is honoured with no restart and nothing rebuilt.
    if (opts.providerSettings?.()?.[result.providerId]?.enabled === false) {
      return { refused: true, code: "provider-disabled", message: `provider "${result.providerId}" is disabled in settings (providers.${result.providerId}.enabled); the model was not switched` };
    }
    const material = describeTargetMaterial(result);
    const family = String(result.adapter.family);
    const resolution: ModelSwitchResolution = {
      provider: buildProvider(result),
      identity: {
        providerId: result.providerId,
        modelKey: result.modelKey,
        family,
        ...(result.continuationDomain !== undefined ? { continuationDomain: result.continuationDomain } : {}),
        adapterId: result.adapterId,
        adapterVersion: result.adapter.version,
        catalogVersion: result.catalogVersion,
        authRefKind: material.authRef.kind,
      },
      to: endpointFor({ providerId: result.providerId, modelKey: result.modelKey, family, ...(result.continuationDomain !== undefined ? { continuationDomain: result.continuationDomain } : {}) }),
      ...(from !== undefined ? { from: endpointFor({ ...from, family: familyOf(from) }) } : {}),
    };
    return resolution;
  };

  // RULING E-4 (R6-H): the price of one generation, from the descriptor's `pricing` evidence and
  // nothing else. `estimateCostUsd` answers `"unknown"` for an unpriced or inferred row, which is
  // `undefined` here -- no field is invented for it. `contextWindow`/`maxOutputTokens` come from the
  // descriptor when known and are otherwise omitted, exactly as the R6-H amendment states.
  const priceUsage = (modelKey: string, usage: ProviderUsage): PricedUsage | undefined => {
    const providerId = sessionProviderId();
    const result = registry.resolve({ model: modelKey, ...(providerId !== undefined ? { provider: { providerId } } : {}) });
    if (result instanceof WinterProviderResolutionError || result.descriptor === undefined) return undefined;
    // WS-13b §1: R6-H prices a turn from the model row's `pricing` evidence -- which, for a
    // subscription or free backend, describes the vendor's API TWIN and not the credential this
    // session is actually billed on. A per-token number for a seat is not a smaller error than no
    // number; it is a wrong one that reads as authoritative, so the row's own basis governs.
    if (result.provider.pricingBasis !== "token") return undefined;
    const estimate = estimateCostUsd({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}), ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}) }, result.descriptor);
    if (estimate.costBasis !== "list") return undefined;
    const apiProvider = API_PROVIDER_BY_PROVIDER_ID[result.providerId];
    const contextWindow = result.descriptor.contextWindow?.value;
    const maxOutputTokens = result.descriptor.maxOutputTokens?.value;
    return {
      costUsd: estimate.costUsd,
      costBasis: "list",
      canonicalModel: result.descriptor.key,
      ...(apiProvider !== undefined ? { provider: apiProvider } : {}),
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
    };
  };

  const deps: SelectionDeps = {
    registry,
    credentials,
    env,
    testProviders: opts.testProviders ?? testProviderForNamespace,
    buildProvider,
    ...(opts.providerSettings !== undefined ? { providerSettings: opts.providerSettings } : {}),
  };

  let selection: SessionProviderSelection;
  try {
    selection = resolveSessionProvider(config, deps);
  } catch (err) {
    if (!(err instanceof WinterProviderResolutionError)) throw err;
    // R-E1: the REFUSED session still has a provider selection -- the configured id, or the
    // qualified key's own prefix -- and every later target is judged against it: a `set_model` to
    // another provider's key is R6-K's `provider-mismatch`, a same-provider target keeps the session's
    // material, and a session that named nothing fails closed (`unknown`).
    const named = providerNamedByConfig();
    sessionProvider = named !== undefined ? { known: named } : "unknown";
    // THE DEFERRED REFUSAL. Everything a session needs to START is present; the one thing it does not
    // have is a provider, and the ONE thing it will ever do with a provider is generate. So the
    // refusal is carried on `generate` and nowhere else: no identity (there is none to report), no
    // model rows, no account, and a Manual classifier route naming the same reason.
    const refuse = (): Provider => ({
      async generate(): Promise<ProviderTurn> {
        throw err;
      },
    });
    return {
      provider: refuse(),
      registry,
      credentials,
      catalog,
      resolutionError: err,
      apiKeySource: apiKeySourceFor(config.provider?.authRef),
      classifierRoute: { kind: "manual-fallback", reason: `this session's own model could not be resolved (${err.code}), so there is nothing to route a classifier through` },
      // The REAL builder, not a second refusal (fix wave: the `buildProvider: refuse` arm was
      // unreachable). A session that started unresolvable can still be handed a model that DOES
      // resolve -- `set_model` through the switch seam below -- and recover; the refusal is the
      // session model's, not the wiring's.
      buildProvider,
      describeTargetMaterial,
      sessionProviderId,
      resolveModelSwitch,
      fallbackModelKeys: [],
      priceUsage: () => undefined,
      supportedModels: () => [],
      accountInfo: () => ({}),
    };
  }

  // --- the reserved `winter-test/<name>` namespace (R6-13) ----------------------------------------
  //
  // A scripted double has no catalog identity, so this arm reports NONE: no `winter_provider` block,
  // no descriptor-derived context window, no classifier route through a model. That is the point —
  // an init frame carrying a fabricated provider row would make every golden a statement about a
  // test double.
  if ("testProvider" in selection) {
    // A scripted double has no catalog identity: nothing may be judged "the session's provider".
    sessionProvider = "unknown";
    return {
      provider: selection.testProvider,
      registry,
      credentials,
      catalog,
      apiKeySource: apiKeySourceFor(config.provider?.authRef),
      classifierRoute: { kind: "manual-fallback", reason: "this session runs the reserved winter-test provider namespace, which has no catalog model to route a classifier through" },
      buildProvider,
      describeTargetMaterial,
      sessionProviderId,
      resolveModelSwitch,
      fallbackModelKeys: [],
      priceUsage: () => undefined,
      supportedModels: () => [],
      accountInfo: () => ({}),
    };
  }

  const { identity, resolved } = selection;
  sessionProvider = { known: resolved.providerId };
  const authRef = config.provider?.authRef;

  // --- R6-14: the classifier route ----------------------------------------------------------------
  //
  // Resolved through the SAME selection path as the session model (§10.6-4), which is why it builds
  // its own `ResolvedModel` rather than reusing the session's: a configured classifier is allowed to
  // be a different, cheaper model, and routing it through a second code path is how the two would
  // drift. A resolution failure DEGRADES to Manual rather than failing the session — the classifier
  // is an advisory reviewer, and R6-14's own rule is "never silently weaken", not "never start".
  const classifierRouteRaw = selectClassifierRoute(config, (modelKey) => descriptorFor(catalog, modelKey));
  let classifierRoute = classifierRouteRaw;
  let classifier: ClassifierInterface | undefined;
  let classifierIdentity: { modelKey: string } | undefined;
  if (classifierRouteRaw.kind === "configured") {
    try {
      const classifierResolved = registry.resolve({ model: classifierRouteRaw.model });
      if (classifierResolved instanceof WinterProviderResolutionError) throw classifierResolved;
      classifierIdentity = { modelKey: classifierResolved.modelKey };
      // Ruling E-1 (whole-branch C-1, probe P1b): the route's OWN `authRef` reaches the builder. It
      // was carried onto the route and then dropped here, so a classifier on another provider went
      // out with the SESSION's credential.
      classifier = createModelClassifier({
        provider: buildProvider(classifierResolved, classifierRouteRaw.authRef !== undefined ? { authRef: classifierRouteRaw.authRef } : {}),
        model: classifierResolved.providerModelId,
      });
    } catch (err) {
      classifier = undefined;
      classifierRoute = {
        kind: "manual-fallback",
        reason: `the configured classifier model "${classifierRouteRaw.model}" could not be resolved (${err instanceof Error ? err.name : "unknown error"}); Winter falls back to Manual rather than reviewing actions with a model it could not identify`,
      };
    }
  } else if (classifierRouteRaw.kind === "worker-eligible") {
    classifier = createModelClassifier({ provider: buildProvider(resolved), model: resolved.providerModelId });
    classifierIdentity = { modelKey: resolved.modelKey };
  }

  // --- the advisor/reviewer backend (P2 carry, disclosed) ------------------------------------------
  //
  // Same selection path, same degradation posture: an unresolvable advisor model leaves the tool
  // without a backend rather than taking the session down.
  let advisorProvider: Provider | undefined;
  const advisorModel = config.advisor?.model;
  if (advisorModel !== undefined && advisorModel.trim().length > 0) {
    const advisorResolved = registry.resolve({ model: advisorModel });
    // Ruling E-1: the advisor's own `authRef` (mirroring the classifier's), never the session's.
    if (!(advisorResolved instanceof WinterProviderResolutionError)) {
      advisorProvider = buildProvider(advisorResolved, config.advisor?.authRef !== undefined ? { authRef: config.advisor.authRef } : {});
    }
  }

  return {
    provider: selection.provider,
    registry,
    credentials,
    catalog,
    identity,
    resolved,
    apiKeySource: apiKeySourceFor(authRef),
    // P4 carry, from the descriptor's own evidence. OMITTED when nothing is known: `true` is the
    // engine's own pre-P6 default and a hard `false` would disable Tool Search on every unlisted
    // model, which is a different claim from "we do not know".
    ...(resolved.descriptor !== undefined ? { providerSupportsToolSearch: selection.supportsToolSearch } : {}),
    // P3 carry: the DESCRIPTOR's window, unless the host stated one. An explicit host value always
    // wins — it is the one number that can be smaller on purpose (a budget), and a descriptor that
    // overrode it would silently spend more context than the host allowed.
    ...(config.contextWindowTokens === undefined && selection.contextWindow !== undefined ? { contextWindowTokens: selection.contextWindow } : {}),
    classifierRoute,
    ...(classifier !== undefined ? { classifier } : {}),
    ...(classifier !== undefined && classifierIdentity !== undefined ? { classifierIdentity } : {}),
    ...(advisorProvider !== undefined ? { advisorProvider } : {}),
    buildProvider,
    describeTargetMaterial,
    sessionProviderId,
    resolveModelSwitch,
    // Ruling E-3: the keys, not the `ResolvedModel`s -- the engine re-resolves through the seam at
    // engagement time, so a candidate is always built fresh under the rule in force then.
    fallbackModelKeys: selection.fallbackModels.map((candidate) => candidate.modelKey),
    priceUsage,
    supportedModels: () => registry.listModelInfo(resolved.providerId),
    accountInfo: () => {
      const apiProvider = API_PROVIDER_BY_PROVIDER_ID[resolved.providerId];
      return {
        apiKeySource: apiKeySourceFor(authRef),
        ...(apiProvider !== undefined ? { apiProvider } : {}),
        // NO email / organization / subscriptionType. Every one of them is account PII the SDK does
        // not hold and would have to fetch; reporting an empty string for a field the pin marks
        // optional would be inventing an answer.
      };
    },
  };
}

/**
 * R6-7 / Lane C wiring item 2: the RESUMED continuation chain, loaded once before the run starts.
 *
 * WHY IT IS LOADED HERE AND NOT INSIDE THE ENGINE. `attachContinuationChain` (engine.ts) folds each
 * record's `origin` onto the in-memory message it belongs to, which is what the domain check reads —
 * but the renderer's OTHER input is the chain itself, and that is where the `summary` records live.
 * R6-8 forbids a foreign summary from ever entering `assistant.message.content`, so the sidecar is
 * its only home; a renderer handed an empty chain therefore renders a resumed cross-family history
 * with no decoration at all, which is indistinguishable from a session that had nothing to carry.
 *
 * `entryUuids` is the set of assistant entries that ACTUALLY EXIST in the rebuilt history —
 * `buildContinuationChain`'s own rule is that a record without its entry is ignored (and
 * garbage-collectable), so passing the record's own anchors back in would defeat the check.
 *
 * An unreadable sidecar yields an EMPTY chain rather than a throw: `attachContinuationChain` already
 * emits the `sidecar_unreadable` continuity warning for exactly this case, and a session must not
 * fail to start because its optional continuation state could not be read.
 */
export async function loadResumedChain(
  store: { loadProviderState?(): Promise<ProviderStateRecord[]> } | undefined,
  messages: ReadonlyArray<{ uuid?: string }>,
): Promise<ContinuationChain> {
  if (store?.loadProviderState === undefined) return new Map();
  let records: ProviderStateRecord[];
  try {
    records = await store.loadProviderState();
  } catch {
    return new Map();
  }
  const entryUuids = new Set<string>();
  for (const message of messages) if (message.uuid !== undefined) entryUuids.add(message.uuid);
  return buildContinuationChain(records, entryUuids);
}

/**
 * A `Provider` that never streams, for the auxiliary generations R6-G names.
 *
 * `ProviderRequest.sink` is what makes a generation's `stream_event`s reach the host, and capture (F)
 * found the pinned runtime forwarding events for only the FORWARDED generations — the compaction
 * summariser, the classifier, the advisor and `countTokens` are all suppressed. The engine already
 * builds those requests without a sink; this wrapper is the belt-and-braces half for a provider
 * handed to one of them directly (the advisor backend below), so a future caller that copies a
 * request wholesale cannot accidentally re-enable streaming for an auxiliary call.
 */
export function withoutStreaming(provider: Provider): Provider {
  return {
    async generate(input: ProviderRequest): Promise<ProviderTurn> {
      const { sink: _suppressed, ...rest } = input;
      return provider.generate(rest);
    },
  };
}
