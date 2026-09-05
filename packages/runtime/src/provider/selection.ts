// Phase 6 Task 3 (R6-9 / R6-13): the SESSION's provider selection.
//
// `registry.ts` resolves a model id against the CATALOG and nothing else, and says so in its own
// header. This module is the other half -- the four behaviours that need credential, session or
// test-registry state:
//
//   1. the pinned Anthropic ALIASES (`sonnet`/`opus`/`haiku`/`claude-*`) defaulting to the `anthropic`
//      provider when a credential ref for it is configured;
//   2. the reserved `winter-test/<name>` namespace and its in-process scripted double (R6-13);
//   3. choosing a provider when the host configured none;
//   4. `fallbackModel`'s domain check.
//
// WHAT THIS MODULE REFUSES TO DO IS THE POINT (WS-13 §9, and R6-9 verbatim): "No model + no provider
// -> typed `WinterProviderResolutionError`, never a silent default." There is no fallthrough to a
// built-in model, no ambient environment scan, and no substitution of a working provider for a
// broken one. A session either pins ONE fully-identified provider and model, or it refuses to start
// and says exactly why -- which R6-F then surfaces on the pinned result shape.
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ConnectionProfile, CredentialStore, ProviderContext, ProviderRegistry, ResolvedModel } from "@yanlinglabs/winter-provider-runtime";
import { WinterProviderResolutionError, createRegistry } from "@yanlinglabs/winter-provider-runtime";
import { DEFAULT_PROVIDER_STALL_TIMEOUT_MS, type CredentialRef, type RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { Provider } from "../engine.ts";

/**
 * The reserved namespace that reaches the in-process scripted double (R6-13).
 *
 * A NAMESPACE rather than an env var, and the ruling is worth restating because it inverts a P1
 * carry: "remove `WINTER_TEST_PROVIDER` affordances" is NOT taken as written, because `main.ts` also
 * uses that name to register in-process test TOOLS in the spawned runtime -- something no loopback
 * server can do. So production selection is catalog-first, the double is reachable only through this
 * namespace, and the env var survives ONLY as the harness's alias for it.
 */
export const WINTER_TEST_NAMESPACE = "winter-test";

/**
 * The pinned aliases, `sdk.d.ts:1794-1798`'s own examples plus the `claude-*` family.
 *
 * They resolve to the `anthropic` provider ONLY when a credential ref for it is configured. Without
 * one, an alias is not silently pointed at some other provider -- it is a typed refusal, because
 * "the caller asked for Claude and we quietly used something else" is exactly the substitution WS-13
 * §9 forbids.
 */
const PINNED_ANTHROPIC_ALIASES: ReadonlySet<string> = new Set(["sonnet", "opus", "haiku", "default"]);
const ANTHROPIC_PROVIDER_ID = "anthropic";

function isPinnedAnthropicAlias(model: string): boolean {
  return PINNED_ANTHROPIC_ALIASES.has(model) || model.startsWith("claude-");
}

/** R6-9: the resolved identity that rides `system/init`'s Winter-only `winter_provider` extension and the dialect record. */
export interface WinterProviderIdentity {
  providerId: string;
  modelKey: string;
  adapterId: string;
  adapterVersion: string;
  catalogVersion: string;
  continuationDomain?: string;
  authRefKind: CredentialRef["kind"];
}

/** What a session gets back. The `testProvider` arm is the reserved namespace's -- a scripted double has no catalog identity to report, and pretending otherwise would put a fake row in the init frame. */
export type SessionProviderSelection =
  | {
      provider: Provider;
      identity: WinterProviderIdentity;
      resolved: ResolvedModel;
      contextWindow?: number;
      supportsToolSearch: boolean;
      familyMetadata: { taskNative?: boolean };
      /** R6-9: the fallback candidates, already domain-checked. Empty when none was configured. */
      fallbackModels: ResolvedModel[];
    }
  | { testProvider: Provider };

export interface SelectionDeps {
  registry: ProviderRegistry;
  credentials: CredentialStore;
  env: Record<string, string | undefined>;
  /** R6-13: the in-process scripted double, resolved by name. Absent -> a `winter-test/<name>` model is a typed refusal rather than a silent miss. */
  testProviders?: (name: string) => Provider | undefined;
  /** How a resolved model becomes a `Provider`. Injected so this module never imports the bridge's own construction path in a test. */
  buildProvider?: (resolved: ResolvedModel) => Provider;
}

/**
 * Resolves the session's provider and model.
 *
 * Order, and each step exists because the one before it cannot answer:
 *   1. the reserved `winter-test/<name>` namespace -- checked FIRST so a test double can never be
 *      shadowed by a catalog row, and so the check is independent of every credential question;
 *   2. a QUALIFIED `<providerId>/<model>` key -> the catalog, verbatim;
 *   3. a pinned Anthropic ALIAS -> the `anthropic` provider, but only with a credential ref for it;
 *   4. a BARE id -> `config.provider.providerId`;
 *   5. no model and no provider -> a typed refusal.
 */
export function resolveSessionProvider(config: RuntimeConfig, deps: SelectionDeps): SessionProviderSelection {
  const model = resolveRequestedModel(config, deps.env);

  if (model === undefined) {
    throw new WinterProviderResolutionError(
      "no-provider-for-bare-model",
      "no model and no provider were configured for this session; set `model` (a `<providerId>/<model>` key or a bare id) and, for a bare id, `provider.providerId`",
    );
  }

  // (1) The reserved namespace. FIRST, deliberately -- see the doc comment above.
  const testName = testNamespaceName(model);
  if (testName !== undefined) {
    const testProvider = deps.testProviders?.(testName);
    if (testProvider === undefined) {
      throw new WinterProviderResolutionError("unknown-model", `no in-process test provider is registered under "${WINTER_TEST_NAMESPACE}/${testName}"`);
    }
    return { testProvider };
  }

  const resolved = resolveOne(model, config, deps);
  const authRef = config.provider?.authRef ?? { kind: "none" };
  const identity: WinterProviderIdentity = {
    providerId: resolved.providerId,
    modelKey: resolved.modelKey,
    adapterId: resolved.adapterId,
    adapterVersion: resolved.adapter.version,
    catalogVersion: resolved.catalogVersion,
    ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
    authRefKind: authRef.kind,
  };

  const contextWindow = resolved.descriptor?.contextWindow;
  const capabilities = resolved.descriptor !== undefined ? resolved.adapter.capabilities(resolved.descriptor) : undefined;

  return {
    provider: (deps.buildProvider ?? unbuildableProvider)(resolved),
    identity,
    resolved,
    ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    // P4 carry: derived from the descriptor's own evidence. `native` tool calling is the only state
    // that supports a deferred/searchable tool surface; `emulated` is DISABLED for agent modes and
    // `none` fails capability negotiation, so neither can support one either (WS-13 §8.1).
    supportsToolSearch: capabilities?.toolCalling === "native",
    // P3 carry: `taskNative` is a descriptor fact, and it is OMITTED rather than defaulted to false
    // when nothing is known -- capture (J) is explicit that absent means UNKNOWN, not "unsupported".
    familyMetadata: {},
    fallbackModels: resolveFallbackModels(config, resolved, deps),
  };
}

/**
 * R6-13: which model string this session actually asked for.
 *
 * The env var is honoured ONLY when `config.model` is absent or already in the reserved namespace --
 * the exact carve-out the ruling names. Any other configured model wins, so a harness variable left
 * in an environment can never silently redirect a real session away from the model its caller asked
 * for.
 */
function resolveRequestedModel(config: RuntimeConfig, env: Record<string, string | undefined>): string | undefined {
  const configured = config.model;
  const envAlias = env["WINTER_TEST_PROVIDER"];
  if (envAlias !== undefined && envAlias.length > 0 && (configured === undefined || configured.length === 0 || testNamespaceName(configured) !== undefined)) {
    return testNamespaceName(envAlias) !== undefined ? envAlias : `${WINTER_TEST_NAMESPACE}/${envAlias}`;
  }
  return configured !== undefined && configured.length > 0 ? configured : undefined;
}

function testNamespaceName(model: string): string | undefined {
  const prefix = `${WINTER_TEST_NAMESPACE}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : undefined;
}

/** One model string -> a `ResolvedModel`, or a THROWN typed refusal. Shared by the session model and every fallback candidate, so their rules cannot diverge. */
function resolveOne(model: string, config: RuntimeConfig, deps: SelectionDeps): ResolvedModel {
  const qualified = model.includes("/");
  // (3) A pinned alias defaults to `anthropic` -- but ONLY with a credential ref for it. A host that
  // configured a provider explicitly keeps it: an explicit choice is never overridden by an alias.
  const providerId = qualified
    ? undefined
    : config.provider?.providerId ?? (isPinnedAnthropicAlias(model) && hasAnthropicCredential(config) ? ANTHROPIC_PROVIDER_ID : undefined);

  if (!qualified && providerId === undefined) {
    throw new WinterProviderResolutionError(
      "no-provider-for-bare-model",
      isPinnedAnthropicAlias(model)
        ? `the alias "${model}" resolves to the "${ANTHROPIC_PROVIDER_ID}" provider only when a credential ref for it is configured; set \`provider.providerId\` or \`provider.authRef\``
        : `a bare model id needs a provider: set \`provider.providerId\`, or use a qualified "<providerId>/<model>" key`,
    );
  }

  const result = deps.registry.resolve({
    model,
    ...(providerId !== undefined || config.provider?.allowUnlisted !== undefined
      ? { provider: { ...(providerId !== undefined ? { providerId } : {}), ...(config.provider?.allowUnlisted !== undefined ? { allowUnlisted: config.provider.allowUnlisted } : {}) } }
      : {}),
  });
  if (result instanceof WinterProviderResolutionError) throw result;
  return result;
}

/**
 * R6-9: `fallbackModel` is a COMMA-SEPARATED list, and every candidate must share the session's
 * provider AND continuation domain -- a typed error at init otherwise.
 *
 * Comma-separated because capture (G) found the pinned runtime treating it that way ("a
 * comma-separated string of candidates tried in order"), and the domain check because a fallback
 * across a domain boundary silently loses every native continuation the session had accumulated. The
 * failure is at INIT rather than at the moment of the swap: a session discovers its fallback is
 * unusable when it is configured, not while it is failing over.
 */
function resolveFallbackModels(config: RuntimeConfig, session: ResolvedModel, deps: SelectionDeps): ResolvedModel[] {
  const raw = config.fallbackModel;
  if (raw === undefined || raw.trim().length === 0) return [];
  const out: ResolvedModel[] = [];
  for (const candidate of raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
    const resolved = resolveOne(candidate, config, deps);
    if (resolved.providerId !== session.providerId) {
      throw new WinterProviderResolutionError(
        "capability",
        `fallbackModel "${candidate}" resolves to provider "${resolved.providerId}", but this session's provider is "${session.providerId}"; a fallback may not change providers (R6-9)`,
      );
    }
    if (resolved.continuationDomain !== session.continuationDomain) {
      throw new WinterProviderResolutionError(
        "capability",
        `fallbackModel "${candidate}" is in continuation domain "${resolved.continuationDomain ?? "none"}", but this session's is "${session.continuationDomain ?? "none"}"; a fallback across a domain boundary would discard the session's native continuation state (R6-9)`,
      );
    }
    out.push(resolved);
  }
  return out;
}

/** True when this session has SOMETHING that could authenticate the `anthropic` provider. Never a scan of the ambient environment (R6-10): a host names its refs explicitly. */
function hasAnthropicCredential(config: RuntimeConfig): boolean {
  const selection = config.provider;
  if (selection === undefined) return false;
  if (selection.providerId === ANTHROPIC_PROVIDER_ID) return true;
  return selection.authRef !== undefined && selection.authRef.kind !== "none";
}

/**
 * The default `buildProvider`, which REFUSES.
 *
 * Selection resolves an identity; turning one into a live `Provider` is `adapterAsProvider`'s job and
 * needs a `ProviderContext` (a connection profile, a credential store, a stall timeout, a log sink)
 * that only the caller can assemble. A default that silently produced a non-working provider would
 * fail at the first generation with no explanation; this fails at construction, saying which seam is
 * missing. T10 supplies the real one.
 */
function unbuildableProvider(resolved: ResolvedModel): Provider {
  return {
    async generate() {
      throw new WinterProviderResolutionError(
        "no-adapter",
        `no provider factory was supplied to resolveSessionProvider, so the resolved model "${resolved.modelKey}" cannot be driven; pass \`deps.buildProvider\``,
      );
    },
  };
}

/**
 * Redacts a `CredentialRef` for a frame, a log line or an error message.
 *
 * `inline` is the case this exists for: R6-10 makes it a HOST responsibility that the SDK never
 * persists, and its value is a live secret sitting in the session's own config -- so anything that
 * renders a ref renders it through here. The others carry only locators, and those are reproduced
 * because a locator is what makes a credential problem diagnosable.
 */
export function redactCredentialRef(ref: CredentialRef): string {
  switch (ref.kind) {
    case "keychain":
      return `keychain(${ref.service ?? "default"}:${ref.account})`;
    case "env":
      return `env(${ref.name})`;
    case "file":
      return `file(${ref.path}, ${ref.format}${ref.profile !== undefined ? `, profile=${ref.profile}` : ""})`;
    case "inline":
      return "inline(***)";
    case "aws-default-chain":
      return "aws-default-chain";
    case "none":
      return "none";
  }
}

/**
 * R6-6: how the session's stall timeout reaches an adapter.
 *
 * THROUGH `ProviderContext`, not `ProviderRequest`, and the placement is the design. A stall watchdog
 * is a property of the CONNECTION -- an adapter arms it around its own `boundedFetch`/`parseSse`,
 * once, for every call it makes -- not of one turn's payload. Putting it on the request would invite
 * a per-turn override that no ruling asks for and that an adapter would have to re-arm mid-stream.
 *
 * One resolution site, so the disclosed default cannot be applied differently by two callers.
 */
export function resolveStallTimeoutMs(config: RuntimeConfig): number {
  const configured = config.providerStallTimeoutMs;
  // A non-positive value is IGNORED rather than honoured, matching `contextWindowTokens`' own
  // precedent (engine.ts's `createContextAccountant`): a `0` here would mean "abort immediately",
  // which is never what a host configuring a watchdog intends.
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_PROVIDER_STALL_TIMEOUT_MS;
}

/**
 * Assembles the `ProviderContext` an adapter runs under.
 *
 * THE PRODUCTION CALLER OF `resolveStallTimeoutMs`, and the reason this function exists rather than
 * leaving five separate decisions to whoever wires a session (review round 1, M1). The stall timeout
 * is the one that shows why: `sse.ts` reads `ctx.stallTimeoutMs` on every chunk, so a caller that
 * assembled a context without it would silently disable R6-6's watchdog on every stream — a disclosed
 * option that quietly did nothing.
 *
 * `log` defaults to a NO-OP rather than to a console writer: `ProviderContext.log`'s own contract is
 * provider/model identifiers and byte COUNTS only, and a default that wrote anywhere would be a
 * default that a careless adapter could turn into a content leak.
 */
export function createProviderContext(
  config: RuntimeConfig,
  deps: { providerId: string; credentials: CredentialStore; log?: ProviderContext["log"] },
): ProviderContext {
  const connectionConfig = config.provider?.connection;
  const connection: ConnectionProfile = {
    providerId: deps.providerId,
    ...(connectionConfig?.baseUrl !== undefined ? { baseUrl: connectionConfig.baseUrl } : {}),
    ...(connectionConfig?.headers !== undefined ? { headers: connectionConfig.headers } : {}),
    ...(connectionConfig?.region !== undefined ? { region: connectionConfig.region } : {}),
    ...(connectionConfig?.project !== undefined ? { project: connectionConfig.project } : {}),
    ...(connectionConfig?.location !== undefined ? { location: connectionConfig.location } : {}),
    ...(connectionConfig?.deployment !== undefined ? { deployment: connectionConfig.deployment } : {}),
    ...(connectionConfig?.apiVersion !== undefined ? { apiVersion: connectionConfig.apiVersion } : {}),
    ...(connectionConfig?.local !== undefined ? { local: connectionConfig.local } : {}),
  };
  return {
    connection,
    credentials: deps.credentials,
    // `none` is the honest default: a host that named no ref has not authenticated this provider, and
    // an adapter that needs material gets a typed refusal rather than an ambient key it never asked
    // for (R6-10: ambient env keys are NEVER scanned implicitly).
    authRef: config.provider?.authRef ?? { kind: "none" },
    stallTimeoutMs: resolveStallTimeoutMs(config),
    log: deps.log ?? (() => {}),
  };
}

/** Convenience for a caller that has a catalog rather than a registry. One construction site, so a registry is never built twice for one session. */
export function createSelectionRegistry(catalog: WinterCatalog): ProviderRegistry {
  return createRegistry(catalog);
}
