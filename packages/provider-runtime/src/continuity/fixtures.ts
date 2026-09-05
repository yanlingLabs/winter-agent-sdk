// Phase 6 Lane C: TEST SUPPORT for the continuity fixtures. Not exported from `continuity/index.ts`
// and imported by nothing the runtime ships -- it exists so every continuity test builds its
// descriptors, catalogs and scripted adapters the same way, against the REAL catalog types rather
// than an `as never` cast that would let a fixture drift from the schema it claims to exercise.
//
// No network, no filesystem, no credentials: a scripted adapter's `streamTurn` yields whatever the
// fixture scripted, and its `capabilities()` reads the descriptor it is handed.

import type {
  CapabilityEvidence,
  EvidenceConfidence,
  ReasoningCapabilities,
  ToolCalling,
  WinterCatalog,
  WinterModelDescriptor,
  WinterProviderDescriptor,
} from "@yanlinglabs/winter-provider-catalog";
import type { ProviderAdapter, ProviderEvent, ProviderFamily } from "../types.ts";
import { readableStateOf } from "./domains.ts";

export const evidence = <T>(value: T, confidence: EvidenceConfidence = "verified"): CapabilityEvidence<T> => ({
  value,
  source: "official-doc",
  observedAt: "2026-09-05",
  confidence,
});

export interface FixtureModelInit {
  key: string;
  providerId: string;
  upstreamId?: string;
  aliases?: string[];
  reasoning?: ReasoningCapabilities;
  toolCalling?: ToolCalling;
  contextWindow?: number;
}

export function fixtureModel(init: FixtureModelInit): WinterModelDescriptor {
  return {
    key: init.key,
    providerId: init.providerId,
    upstreamId: init.upstreamId ?? init.key.slice(init.key.indexOf("/") + 1),
    displayName: init.key,
    aliases: init.aliases ?? [],
    endpoints: ["responses"],
    ...(init.contextWindow !== undefined ? { contextWindow: evidence(init.contextWindow) } : {}),
    inputModalities: evidence(["text"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence<ToolCalling>(init.toolCalling ?? "native"),
    nativeTools: evidence(true),
    ...(init.reasoning !== undefined ? { reasoning: init.reasoning } : {}),
    unsupportedParameters: [],
    status: "supported",
  };
}

/**
 * The reasoning evidence a reasoning-capable row carries. `domain` is the MEMBER LIST the registry
 * derives a domain id from -- passing two models the same list is how a fixture certifies a shared
 * domain, and passing different lists is how it certifies two domains that share an HTTP shape.
 */
export function fixtureReasoning(init: {
  readableState: "none" | "summary" | "full-exposed";
  continuation?: ReasoningCapabilities["continuation"];
  domain?: string[];
  summaryRequest?: { field: string; values: string[] };
  efforts?: string[];
  confidence?: EvidenceConfidence;
}): ReasoningCapabilities {
  return {
    supported: evidence(true),
    efforts: init.efforts ?? [],
    continuation: init.continuation ?? "opaque-provider-state",
    readableState: evidence(init.readableState, init.confidence),
    ...(init.summaryRequest !== undefined ? { summaryRequest: evidence(init.summaryRequest, init.confidence) } : {}),
    ...(init.domain !== undefined ? { continuationDomain: evidence(init.domain, init.confidence) } : {}),
  };
}

export function fixtureProvider(init: { id: string; adapterId?: string; family?: string; baseUrl?: string }): WinterProviderDescriptor {
  return {
    id: init.id,
    displayName: init.id,
    protocols: ["openai-responses"],
    authKinds: ["api-key"],
    // Two providers can share this URL SHAPE and share nothing else -- which is the point of the
    // `sameDomain` fixture that uses them.
    defaultEndpoints: { base: init.baseUrl ?? "https://example.invalid/v1/responses" },
    modelDiscovery: "none",
    liveCatalogAuthority: "partial",
    adapterId: init.adapterId ?? `${init.id}-adapter`,
    family: init.family ?? "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
  };
}

export function fixtureCatalog(providers: WinterProviderDescriptor[], models: WinterModelDescriptor[]): WinterCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-continuity-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers,
    models,
  };
}

/** A scripted `ProviderAdapter`: no HTTP, no credentials. `events` is what `streamTurn` yields, and every request it is handed is recorded for assertions. */
export function scriptedAdapter(init: { id: string; family?: ProviderFamily; events?: ProviderEvent[] }): ProviderAdapter & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    id: init.id,
    version: "0.0.0-fixture",
    family: init.family ?? "openai",
    protocol: "openai-responses",
    requests,
    async validateCredential() {
      return { ok: true };
    },
    async listModels() {
      return { models: [], partial: false, cached: false, warnings: [] };
    },
    streamTurn(req) {
      requests.push(req);
      const events = init.events ?? [{ type: "done" as const, stopReason: "end_turn" as const }];
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
    mapEffort() {
      return { ok: true, value: undefined };
    },
    capabilities(model) {
      const domain = model.reasoning?.continuationDomain?.value;
      return {
        toolCalling: model.toolCalling.value,
        ...(domain !== undefined && domain.length > 0 ? { continuationDomain: [...domain].sort()[0]! } : {}),
        readableState: readableStateOf(model),
      };
    },
  };
}
