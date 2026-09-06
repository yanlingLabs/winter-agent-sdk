// `local-openai@1` — the twelve local OpenAI-compatible servers (Ollama, LM Studio, llama.cpp,
// vLLM, llamafile, Triton, Xinference, oobabooga, lemonade, Docker Model Runner, the two MLX
// servers).
//
// WHY THIS IS A SEPARATE ADAPTER AND NOT A PROFILE. Everything about the TURN is
// `openai-chat-completions@1`'s, and this file reuses it rather than copying it. What differs is
// entirely outside the turn:
//
//   THE ENDPOINT IS ALWAYS THE HOST'S. There is no vendor URL to default to — every local server has
//     its own port, and half of them share one — so `connection.baseUrl` is required, and reaching
//     it over plain http requires the host's explicit `local: true`. That declaration is what
//     `evaluateEndpoint` needs before it will accept a loopback/RFC-1918 target at all, and it is
//     also why a privileged header can never ride one of these (R6-L: a user endpoint gets `{}`).
//
//   A CREDENTIAL IS OPTIONAL. `local-none` is a first-class auth kind in the catalog (WS-13 §6), not
//     a degenerate api-key case — so a `none` ref here is a configuration, not a missing credential.
//
//   DISCOVERY HAS TWO DOORS. Most of these servers answer `/v1/models`; Ollama's native surface is
//     `/api/tags` on the same origin, and a server that answers only that one is not broken. The
//     fallback is tried on a 404/405/501 — the statuses that mean "this endpoint does not exist
//     here" — and never on an auth or server failure, which would turn a real problem into a
//     confusing second request.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { boundedFetch } from "../../http.ts";
import type { CredentialRef, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "../../types.ts";
import { chatTurn, type ChatTurnOptions } from "./chat-completions.ts";
import { responsesTurn } from "./responses.ts";
import {
  DEFAULT_HEADER_TIMEOUT_MS,
  buildHeaders,
  capabilitiesFrom,
  fetchOpenAiModels,
  identityFor,
  httpErrorFrom,
  mapEffortAgainst,
  resolveAuth,
  resolveEndpoint,
  validateViaModels,
} from "./shared.ts";

export interface LocalAdapterOptions extends ChatTurnOptions {
  /** Which surface this server speaks. Almost every local server is `chat`; a few expose Responses. */
  surface?: "chat" | "responses";
  /**
   * The registered adapter id.
   *
   * Overridable because the catalog's twelve local providers currently name
   * `winter.openai-chat-completions` as their `adapterId`, and a registry resolves an adapter BY
   * THAT ID. A host that wants the `/api/tags` fallback registers this adapter under whichever id
   * its catalog rows actually point at.
   */
  id?: string;
}

/** Statuses that mean "this endpoint is not here", as distinct from "this endpoint refused you". */
const ENDPOINT_ABSENT_STATUSES = new Set([404, 405, 501]);

export function createLocalOpenAIAdapter(options: LocalAdapterOptions): ProviderAdapter {
  const surface = options.surface ?? "chat";
  return {
    id: options.id ?? "winter.local-openai",
    version: "1",
    family: "local-openai",
    protocol: surface === "responses" ? "openai-responses" : "openai-chat-completions",

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      const endpoint = resolveEndpoint(ctx, options);
      const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      // `hasCredential: true` unconditionally: on a local endpoint, having none is a valid
      // configuration, so "missing" is never the right verdict here.
      return validateViaModels(ref, ctx, endpoint, headers, options, true);
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, options);
      const auth = await resolveAuth(ctx, options.authStyle ?? "bearer");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      try {
        return await fetchOpenAiModels(ctx, endpoint, headers, options);
      } catch (err) {
        const status = typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
        if (typeof status !== "number" || !ENDPOINT_ABSENT_STATUSES.has(status)) throw err;
        return fetchOllamaTags(ctx, endpoint, headers, options);
      }
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      // No fallback base URL: a local adapter with no `connection.baseUrl` refuses rather than
      // guessing which of twelve servers, on which of six shared ports, the host meant.
      return surface === "responses"
        ? responsesTurn(req, ctx, options, undefined, (baseUrl) => `${baseUrl}/responses`)
        : chatTurn(req, ctx, options, undefined, (endpoint) => `${endpoint.baseUrl}/chat/completions`);
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapEffortAgainst(effort, model);
      return mapped.ok ? { ok: true as const, value: mapped.value } : mapped;
    },

    capabilities: capabilitiesFrom,
  };
}

interface OllamaTag {
  name?: unknown;
  model?: unknown;
  details?: unknown;
}

/**
 * Ollama's own `/api/tags`, on the SAME ORIGIN as the OpenAI-compatible base.
 *
 * The path is computed from the origin rather than appended to the base, because the base carries
 * `/v1` and the native surface does not. Same origin means `boundedFetch`'s first-hop rule still
 * holds, so this is not a hole in the endpoint policy.
 */
async function fetchOllamaTags(ctx: DiscoveryContext, endpoint: { baseUrl: string; policy: Parameters<typeof boundedFetch>[1]["policy"] }, headers: Record<string, string>, options: LocalAdapterOptions): Promise<ModelCatalogResult> {
  const url = `${new URL(endpoint.baseUrl).origin}/api/tags`;
  const response = await boundedFetch(url, {
    method: "GET",
    headers,
    policy: endpoint.policy,
    maxBodyBytes: ctx.limits.maxBytes,
    timeoutMs: options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  if (!response.ok) throw await httpErrorFrom(response);
  const text = await response.text();
  let payload: { models?: unknown };
  try {
    payload = JSON.parse(text) as { models?: unknown };
  } catch {
    return { models: [], partial: false, cached: false, warnings: ["the local server's /api/tags returned a body that is not JSON; no models were discovered"] };
  }
  const rows = Array.isArray(payload.models) ? payload.models : [];
  const models: ModelCatalogResult["models"] = [];
  let partial = false;
  for (const row of rows) {
    if (models.length >= ctx.limits.maxItems) {
      partial = true;
      break;
    }
    if (row === null || typeof row !== "object") {
      // Kept as a row with no usable id so `discoverModels` counts the drop in ONE warning; dropping
      // it silently here would move the accounting into a second place.
      models.push({ id: "" });
      continue;
    }
    const tag = row as OllamaTag;
    // `name` is the tagged id a request must use (`llama3.1:8b`); `model` repeats it on current
    // versions. Neither is trusted — `discoverModels` validates every id it keeps.
    const id = typeof tag.name === "string" ? tag.name : typeof tag.model === "string" ? tag.model : "";
    models.push({ id });
  }
  return {
    models,
    partial,
    cached: false,
    warnings: ["models were discovered through the local server's native /api/tags, because it does not serve /v1/models"],
  };
}
