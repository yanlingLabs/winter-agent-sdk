// Lane A's fixture helpers. TEST-ONLY: nothing in a shipped path imports this file.
//
// Kept beside the adapters rather than in the conformance package because both packages' fixtures
// need it and the dependency runs conformance -> provider-runtime, never the other way.
//
// NO REAL CREDENTIALS ANYWHERE. Every key here is `test-key-…`, every store is in-memory, and
// `Bun.secrets` is never reachable from this package at all (the Keychain-backed store is a
// runtime-side file, deliberately).

import type { CapabilityEvidence, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import type { ConnectionProfile, CredentialRef, DiscoveryContext, ProviderContext, ProviderEvent } from "../../types.ts";

export const TEST_API_KEY = "test-key-openai-0000";

export function evidence<T>(value: T, confidence: CapabilityEvidence<T>["confidence"] = "verified"): CapabilityEvidence<T> {
  return { value, source: "official-doc", confidence, observedAt: "2026-09-05T00:00:00Z" };
}

export interface DescriptorOverrides {
  key?: string;
  providerId?: string;
  upstreamId?: string;
  efforts?: string[];
  defaultEffort?: string;
  readableState?: "none" | "summary" | "full-exposed";
  summaryValues?: string[];
  maxOutputTokens?: number;
  unsupportedParameters?: string[];
  toolCalling?: "native" | "emulated" | "none";
  continuationDomain?: string[];
  continuation?: "none" | "plaintext" | "opaque-provider-state" | "server-response-handle";
  noReasoning?: boolean;
  inputModalities?: string[];
  parallelTools?: boolean;
}

// WS-13c: `modelFamily`/`canonicalModelId` are DERIVED, never hand-typed into a fixture. The
// pipeline's own `stampFamilyFields` fills them here with NO families, so a fixture row lands in
// `other` carrying the real normaliser's canonical id rather than a second, drifting spelling.
const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

/** A descriptor shaped like the seed catalog's rows, with only the fields a fixture cares about varied. */
export function descriptor(overrides: DescriptorOverrides = {}): WinterModelDescriptor {
  const key = overrides.key ?? "openai/o4-mini";
  return stampRow({
    key,
    providerId: overrides.providerId ?? key.split("/")[0]!,
    upstreamId: overrides.upstreamId ?? key.slice(key.indexOf("/") + 1),
    displayName: key,
    aliases: [],
    endpoints: ["responses"],
    inputModalities: evidence(overrides.inputModalities ?? ["text", "image"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence(overrides.toolCalling ?? "native"),
    nativeTools: evidence(true),
    ...(overrides.parallelTools !== undefined ? { parallelTools: evidence(overrides.parallelTools) } : {}),
    ...(overrides.maxOutputTokens !== undefined ? { maxOutputTokens: evidence(overrides.maxOutputTokens) } : {}),
    ...(overrides.noReasoning === true
      ? {}
      : {
          reasoning: {
            supported: evidence(true),
            efforts: overrides.efforts ?? ["low", "medium", "high"],
            ...(overrides.defaultEffort !== undefined ? { defaultEffort: overrides.defaultEffort } : {}),
            continuation: overrides.continuation ?? "opaque-provider-state",
            readableState: evidence(overrides.readableState ?? "summary"),
            ...(overrides.summaryValues !== undefined ? { summaryRequest: evidence({ field: "reasoning.summary", values: overrides.summaryValues }) } : {}),
            ...(overrides.continuationDomain !== undefined ? { continuationDomain: evidence(overrides.continuationDomain) } : {}),
          },
        }),
    unsupportedParameters: overrides.unsupportedParameters ?? [],
    status: "candidate",
  });
}

export interface TestContextOptions {
  providerId?: string;
  baseUrl?: string;
  local?: boolean;
  headers?: Record<string, string>;
  deployment?: string;
  apiVersion?: string;
  authRef?: CredentialRef;
  apiKey?: string | null;
  stallTimeoutMs?: number;
  logs?: Array<{ kind: string; providerId: string; model?: string; bytes?: number }>;
}

const KEYCHAIN_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "openai:test" };

export function testContext(opts: TestContextOptions = {}): ProviderContext {
  const key = opts.apiKey === undefined ? TEST_API_KEY : opts.apiKey;
  const credentials = createMemoryCredentialStore(key === null ? [] : [[KEYCHAIN_REF, { kind: "api-key", key }]]);
  const connection: ConnectionProfile = {
    providerId: opts.providerId ?? "openai",
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.local !== undefined ? { local: opts.local } : {}),
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
    ...(opts.deployment !== undefined ? { deployment: opts.deployment } : {}),
    ...(opts.apiVersion !== undefined ? { apiVersion: opts.apiVersion } : {}),
  };
  return {
    connection,
    credentials,
    authRef: opts.authRef ?? (key === null ? { kind: "none" } : KEYCHAIN_REF),
    stallTimeoutMs: opts.stallTimeoutMs ?? 2000,
    log: (event) => opts.logs?.push(event),
  };
}

export function testDiscoveryContext(opts: TestContextOptions & { maxItems?: number; maxBytes?: number; timeoutMs?: number; signal?: AbortSignal } = {}): DiscoveryContext {
  return {
    ...testContext(opts),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    limits: { maxBytes: opts.maxBytes ?? 1024 * 1024, maxItems: opts.maxItems ?? 100, timeoutMs: opts.timeoutMs ?? 5000 },
  };
}

/** A retry policy that never actually waits — one tick is enough for the observation pump to run, and a real backoff would eat a test budget. */
export const FAST_RETRY = { maxRetries: 3, random: () => 0.5, sleep: (_ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, 1)) };

/** Drains an adapter stream. The events, in order, exactly as a consumer would see them. */
export async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** The single `error` event a refused turn produces, or a failure naming what came instead. */
export function soleError(events: ProviderEvent[]): Extract<ProviderEvent, { type: "error" }> {
  const errors = events.filter((e): e is Extract<ProviderEvent, { type: "error" }> => e.type === "error");
  if (errors.length !== 1) throw new Error(`expected exactly one error event, got ${errors.length} in [${events.map((e) => e.type).join(", ")}]`);
  return errors[0]!;
}
