// The provider registry: catalog + registered adapters -> a resolved model. FROZEN (R6-12).
//
// SCOPE, stated so T3/T10 neither duplicate nor omit the other half. This module resolves a model
// id against the CATALOG and nothing else. It deliberately does NOT implement:
//
//   - the pinned Anthropic aliases (`sonnet`/`opus`/`haiku`/`claude-*`) defaulting to the `anthropic`
//     provider when a credential ref for it is configured — that needs credential state;
//   - the reserved `winter-test/<name>` namespace and the scripted double (R6-13);
//   - `set_model`'s three-way reset spelling (omitted / null / the literal `'default'`);
//   - picking a session's provider when the host configured none.
//
// All four are `packages/runtime/src/provider/selection.ts`'s job (T3/T10): they need credential
// state, session state and the test-provider registry, none of which belong in a data-shaped
// resolver. What this module guarantees is that a resolution either produces a fully-identified
// model or a TYPED refusal — never a silent default (WS-13 §9: no routing, no substitution).

import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderAdapter } from "./types.ts";

export interface ResolvedModel {
  providerId: string;
  /** The catalog key, or `<providerId>/<id>` for an allowUnlisted passthrough. */
  modelKey: string;
  /** What actually goes on the wire. */
  providerModelId: string;
  adapterId: string;
  adapter: ProviderAdapter;
  /** `undefined` ONLY for an allowUnlisted passthrough on a non-authoritative provider. Absence is the honest signal that nothing is known — never read capabilities off it. */
  descriptor: WinterModelDescriptor | undefined;
  provider: WinterProviderDescriptor;
  continuationDomain?: string;
  catalogVersion: string;
}

export type ResolutionErrorCode =
  | "unknown-provider"
  | "unknown-model"
  | "no-adapter"
  | "blocked"
  | "no-provider-for-bare-model"
  | "capability";

export class WinterProviderResolutionError extends Error {
  readonly code: ResolutionErrorCode;
  constructor(code: ResolutionErrorCode, message: string) {
    super(message);
    this.name = "WinterProviderResolutionError";
    this.code = code;
  }
}

/** What `resolve` is asked. `provider` carries the session's selection; `allowUnlisted` is a selection-policy bit, deliberately NOT part of `ConnectionProfile`. */
export interface ResolveRequest {
  model: string;
  provider?: { providerId?: string; allowUnlisted?: boolean };
}

/** The pinned `ModelInfo` shape (`sdk.d.ts:1261-1300`): three required fields, six optional. */
export interface ModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

export interface RegistryListing {
  catalogVersion: string;
  adapters: Array<{ id: string; version: string; family: string; protocol: string }>;
  providers: Array<{ id: string; displayName: string; adapterId: string; adapterRegistered: boolean; modelCount: number; riskClass: string }>;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  resolve(request: ResolveRequest): ResolvedModel | WinterProviderResolutionError;
  list(): RegistryListing;
  /** R6-I: pinned-shaped rows for one provider's models. Optional capability booleans are OMITTED when unknown, never `false`. */
  listModelInfo(sessionProviderId: string): ModelInfo[];
}

const PINNED_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type PinnedEffortLevel = (typeof PINNED_EFFORT_LEVELS)[number];

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * R6-H: the descriptor's `pricing` evidence is the ONLY price source.
 *
 * An unpriced model — or one resolved with no descriptor at all — reports `0` with
 * `costBasis: "unknown"`. That is a DELIBERATE, DISCLOSED DIVERGENCE from the pin: capture (K) shows
 * the pinned runtime reporting a non-zero cost for a model no price table contains, guessing at the
 * default model's rate. A number nobody can justify is worse than an honest zero next to a marker
 * that says the basis is unknown, and `maxBudgetUsd` is correspondingly inert for such a model.
 *
 * Cache tokens with no cache rate are priced at the INPUT rate rather than free: pricing them at
 * zero would silently under-report, and the basis stays `"list"` because a real list price was used.
 */
export function estimateCostUsd(usage: UsageForCost, descriptor: WinterModelDescriptor | undefined): { costUsd: number; costBasis: "list" | "unknown" } {
  const evidence = descriptor?.pricing;
  // R6-9 words the rule as "`official-doc` evidence → `costBasis: \"list\"`", and it is taken
  // literally: `"list"` is a claim that these are the vendor's PUBLISHED prices. A row priced from
  // an upstream extraction or an inference is a guess, and returning `"list"` for it would launder
  // that guess into exactly the assurance this function exists to withhold — the same reasoning
  // that keeps invented prices out of the seed catalog. An inferred price therefore reports
  // 0 / "unknown", identically to no price at all.
  if (evidence === undefined || evidence.source !== "official-doc") return { costUsd: 0, costBasis: "unknown" };
  const pricing = evidence.value;
  const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const costUsd =
    perMillion(usage.inputTokens, pricing.inputPerMTokUsd) +
    perMillion(usage.outputTokens, pricing.outputPerMTokUsd) +
    perMillion(cacheRead, pricing.cacheReadPerMTokUsd ?? pricing.inputPerMTokUsd) +
    perMillion(cacheWrite, pricing.cacheWritePerMTokUsd ?? pricing.inputPerMTokUsd);
  return { costUsd, costBasis: "list" };
}

/**
 * A stable identity for the set of models that can accept each other's native continuation objects
 * (R6-9: `fallbackModel` is honoured only INSIDE the same continuation domain).
 *
 * Derived from data alone — the lexicographically smallest member of the descriptor's own
 * `reasoning.continuationDomain` evidence, falling back to the model's own key — so two models that
 * list the same domain produce the same id without anything having to call an adapter. A catalog
 * whose two members list DIFFERENT domain sets would produce different ids; that is a catalog
 * consistency problem for Lane C/X to police, and the honest failure mode (a refused fallback)
 * rather than a silent cross-domain context loss.
 */
function continuationDomainOf(descriptor: WinterModelDescriptor): string | undefined {
  const reasoning = descriptor.reasoning;
  if (reasoning === undefined || reasoning.continuation === "none") return undefined;
  const members = reasoning.continuationDomain?.value;
  if (members !== undefined && members.length > 0) return [...members].sort()[0];
  return descriptor.key;
}

export function createRegistry(catalog: WinterCatalog): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();
  const providersById = new Map(catalog.providers.map((p) => [p.id, p]));
  const modelsByKey = new Map(catalog.models.map((m) => [m.key, m]));
  /** providerId -> (upstreamId | alias) -> descriptor. Alias scope is per provider, exactly as the validator enforces. */
  const namesByProvider = new Map<string, Map<string, WinterModelDescriptor>>();
  for (const model of catalog.models) {
    let names = namesByProvider.get(model.providerId);
    if (names === undefined) {
      names = new Map<string, WinterModelDescriptor>();
      namesByProvider.set(model.providerId, names);
    }
    names.set(model.upstreamId, model);
    for (const alias of model.aliases) names.set(alias, model);
  }

  function build(provider: WinterProviderDescriptor, descriptor: WinterModelDescriptor | undefined, providerModelId: string): ResolvedModel | WinterProviderResolutionError {
    if (provider.risk.class === "blocked") {
      return new WinterProviderResolutionError("blocked", `provider "${provider.id}" is blocked: ${provider.risk.reasons.join("; ")}`);
    }
    if (descriptor !== undefined && descriptor.status === "blocked") {
      return new WinterProviderResolutionError("blocked", `model "${descriptor.key}" is blocked in the catalog`);
    }
    const adapter = adapters.get(provider.adapterId);
    if (adapter === undefined) {
      return new WinterProviderResolutionError("no-adapter", `no adapter registered for "${provider.adapterId}" (provider "${provider.id}")`);
    }
    const domain = descriptor === undefined ? undefined : continuationDomainOf(descriptor);
    return {
      providerId: provider.id,
      modelKey: descriptor?.key ?? `${provider.id}/${providerModelId}`,
      providerModelId,
      adapterId: provider.adapterId,
      adapter,
      descriptor,
      provider,
      ...(domain !== undefined ? { continuationDomain: domain } : {}),
      catalogVersion: catalog.catalogVersion,
    };
  }

  function resolveWithin(provider: WinterProviderDescriptor, name: string, allowUnlisted: boolean): ResolvedModel | WinterProviderResolutionError {
    const descriptor = namesByProvider.get(provider.id)?.get(name);
    if (descriptor !== undefined) return build(provider, descriptor, descriptor.upstreamId);
    // R6-F: an unlisted id passes through ONLY for a provider whose live catalog is not
    // authoritative. Where it IS authoritative, absence is a FACT rather than a gap, and waving the
    // id through would defeat WS-13 §8.3's validation exactly where it is most reliable.
    if (allowUnlisted && provider.liveCatalogAuthority !== "authoritative") return build(provider, undefined, name);
    return new WinterProviderResolutionError(
      "unknown-model",
      `model "${name}" is not in provider "${provider.id}"'s catalog${provider.liveCatalogAuthority === "authoritative" ? " (its live catalog is authoritative, so absence is definitive)" : " — set `provider.allowUnlisted: true` to pass an unlisted id through"}`,
    );
  }

  return {
    register(adapter: ProviderAdapter): void {
      adapters.set(adapter.id, adapter);
    },

    resolve(request: ResolveRequest): ResolvedModel | WinterProviderResolutionError {
      const allowUnlisted = request.provider?.allowUnlisted === true;
      const slash = request.model.indexOf("/");
      if (slash > 0) {
        // FIRST slash only: an OpenRouter upstreamId is itself slash-bearing (`openai/gpt-4.1`), so
        // splitting on the last one would address a provider that does not exist.
        const providerId = request.model.slice(0, slash);
        const rest = request.model.slice(slash + 1);
        const provider = providersById.get(providerId);
        if (provider === undefined) {
          return new WinterProviderResolutionError("unknown-provider", `no provider "${providerId}" in catalog ${catalog.catalogVersion}`);
        }
        // The exact key wins before the per-provider name index, so a key and an alias that collide
        // across the two indexes still resolve deterministically.
        const byKey = modelsByKey.get(request.model);
        if (byKey !== undefined) return build(provider, byKey, byKey.upstreamId);
        return resolveWithin(provider, rest, allowUnlisted);
      }

      const providerId = request.provider?.providerId;
      if (providerId === undefined) {
        return new WinterProviderResolutionError(
          "no-provider-for-bare-model",
          `bare model id "${request.model}" needs a provider — pass a qualified "<providerId>/<model>" key or set \`provider.providerId\``,
        );
      }
      const provider = providersById.get(providerId);
      if (provider === undefined) return new WinterProviderResolutionError("unknown-provider", `no provider "${providerId}" in catalog ${catalog.catalogVersion}`);
      return resolveWithin(provider, request.model, allowUnlisted);
    },

    list(): RegistryListing {
      return {
        catalogVersion: catalog.catalogVersion,
        adapters: [...adapters.values()].map((a) => ({ id: a.id, version: a.version, family: a.family, protocol: a.protocol })),
        providers: catalog.providers.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          adapterId: p.adapterId,
          // Reported rather than filtered: "you have no adapter for bedrock" is actionable, "bedrock
          // is missing" is not.
          adapterRegistered: adapters.has(p.adapterId),
          modelCount: catalog.models.filter((m) => m.providerId === p.id).length,
          riskClass: p.risk.class,
        })),
      };
    },

    listModelInfo(sessionProviderId: string): ModelInfo[] {
      const rows: ModelInfo[] = [];
      for (const model of catalog.models) {
        if (model.providerId !== sessionProviderId) continue;
        const efforts = model.reasoning?.efforts ?? [];
        const levels = PINNED_EFFORT_LEVELS.filter((l) => efforts.includes(l)) as PinnedEffortLevel[];
        // OMITTED, never `false` (capture (J)): the `haiku` row carried only the four base fields,
        // and `supportsFastMode` was absent on the sonnet rows while present on the opus ones — the
        // omission is per-capability, and absent means UNKNOWN rather than "unsupported". Winter's
        // catalog has no evidence field for adaptive-thinking / fast mode / auto mode at all, so
        // those three are ALWAYS omitted here rather than invented (a disclosed gap, not a claim).
        const capability =
          levels.length > 0 ? { supportsEffort: true, supportedEffortLevels: levels } : {};
        const base = {
          displayName: model.displayName,
          // `description` is REQUIRED on the pinned shape, and a catalog row has no prose field —
          // so it states what IS known: promotion status and how well-evidenced the row is. That is
          // more useful to a picker than invented marketing copy and cannot be mistaken for one.
          description: `${model.displayName} — ${model.status}${model.reasoning !== undefined ? ", reasoning-capable" : ""} (catalog ${catalog.catalogVersion})`,
          ...capability,
        };
        rows.push({ value: model.key, resolvedModel: model.upstreamId, ...base });
        // Alias rows, `value` = the alias and `resolvedModel` = the canonical wire id, exactly the
        // shape capture (J) observed for every pinned row. R6-I frames these as the Anthropic-family
        // case; emitting them for any descriptor that DECLARES aliases is the same rule stated over
        // data rather than over a family name (and identical in effect on today's catalog, where
        // only the Anthropic rows carry aliases).
        for (const alias of model.aliases) rows.push({ value: alias, resolvedModel: model.upstreamId, ...base });
      }
      return rows;
    },
  };
}
