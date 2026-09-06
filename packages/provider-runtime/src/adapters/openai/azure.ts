// `azure-openai@1` (R6-16 / ruling R6-A) — Azure OpenAI as a CONNECTION-PROFILE VARIANT over this
// lane's own Responses and Chat adapters, never a third wire mapping.
//
// That framing is the ruling, and it is also what the code does: the request bodies, the stream
// mappers, the effort and thinking rules and the refusals are all the family's. What Azure changes
// is addressing and auth, which is exactly the shape a connection profile describes:
//
//   TWO SURFACES, CHOSEN BY `apiVersion`. The classic one is the DEPLOYMENT PATH —
//     `{base}/openai/deployments/<deployment>/chat/completions?api-version=<v>` — where the model is
//     named by the deployment rather than in the body. `apiVersion: "preview"` selects the newer
//     `/openai/v1` surface, which speaks Responses and takes the model in the body like every other
//     OpenAI endpoint.
//
//   `api-version` IS MANDATORY ON EVERY CALL, and it is a QUERY parameter. That is why
//     `evaluateEndpoint` refuses a query string on a STORED endpoint but `evaluateRedirect` permits
//     one on a live request URL — Task 2 recorded Azure as one of the two providers that cannot be
//     called at all without it.
//
//   AUTH IS EITHER A KEY OR AN ENTRA BEARER. A resource key rides Azure's own `api-key` header; a
//     Microsoft Entra token arrives as `{ kind: "bearer" }` and rides `Authorization`. Both are
//     PROTOCOL headers (an endpoint cannot be spoken to without one), so neither goes through
//     `applyPrivilegedHeaders` — and neither is a reason to relax the origin-change rule, which
//     `stripCredentialHeaders` still owns.
//
//   THE ENDPOINT IS ALWAYS THE HOST'S. Every Azure resource is its own hostname, so there is no
//     generated default and therefore no privileged header on this surface at all. The catalog row
//     is `experimental` (R6-A); promoting it is Lane X's, on the corpus.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialRef, CredentialStatus, DiscoveryContext, ModelCatalogResult, ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "../../types.ts";
import { chatTurn } from "./chat-completions.ts";
import { responsesTurn } from "./responses.ts";
import { buildHeaders, capabilitiesFrom, capabilityRefusal, errorEvent, fetchOpenAiModels, identityFor, mapEffortAgainst, resolveAuth, resolveEndpoint, validateViaModels, type OpenAiAdapterOptions } from "./shared.ts";

/** The `apiVersion` that selects the `/openai/v1` Responses surface rather than the deployment path. */
export const AZURE_PREVIEW_API_VERSION = "preview";

export interface AzureAdapterOptions extends OpenAiAdapterOptions {
  /** Used when the connection profile names none. A host that configures neither gets a typed refusal. */
  defaultApiVersion?: string;
}

interface AzureRouting {
  apiVersion: string;
  preview: boolean;
  deployment?: string;
}

/**
 * Reads the routing facts off the connection profile, refusing rather than defaulting.
 *
 * A missing `api-version` is a refusal because Azure rejects every call without one — guessing a
 * version would silently pin the operator to a surface they never chose. A missing `deployment` is a
 * refusal only on the classic path, where it IS the address.
 */
export function azureRouting(ctx: ProviderContext, options: AzureAdapterOptions): AzureRouting {
  const apiVersion = ctx.connection.apiVersion ?? options.defaultApiVersion;
  if (apiVersion === undefined || apiVersion.length === 0) {
    throw capabilityRefusal(`azure-openai needs \`connection.apiVersion\`: every Azure OpenAI call carries an \`api-version\` query parameter, and Winter will not guess which surface you meant`);
  }
  const preview = apiVersion === AZURE_PREVIEW_API_VERSION;
  const deployment = ctx.connection.deployment;
  if (!preview && (deployment === undefined || deployment.length === 0)) {
    throw capabilityRefusal(`azure-openai needs \`connection.deployment\`: on the classic api-version surface the deployment name IS the address of the model`);
  }
  return { apiVersion, preview, ...(deployment !== undefined ? { deployment } : {}) };
}

/** The turn URL for a routing. `deployment` is percent-encoded: it is untrusted profile input going into a path. */
export function azureTurnUrl(baseUrl: string, routing: AzureRouting): string {
  const url =
    routing.preview
      ? new URL(`${baseUrl}/openai/v1/responses`)
      : new URL(`${baseUrl}/openai/deployments/${encodeURIComponent(routing.deployment ?? "")}/chat/completions`);
  url.searchParams.set("api-version", routing.apiVersion);
  return url.toString();
}

export function createAzureOpenAIAdapter(options: AzureAdapterOptions): ProviderAdapter {
  // Azure's own header, unless the host configured an Entra bearer — which `resolveAuth` detects
  // from the MATERIAL's kind rather than from this setting, so both work under one style.
  const withAuthStyle: AzureAdapterOptions = { ...options, authStyle: options.authStyle ?? "azure-api-key" };

  return {
    id: "winter.azure-openai",
    version: "1",
    family: "openai",
    protocol: "azure-openai",

    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      const routing = azureRouting(ctx, withAuthStyle);
      const endpoint = resolveEndpoint(ctx, withAuthStyle);
      const auth = await resolveAuth(ctx, withAuthStyle.authStyle ?? "azure-api-key");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      // `api-version` rides the PROBE too. Without it Azure answers 400 on every call, which
      // normalized to `network` and reported a perfectly valid key as unreachable.
      return validateViaModels(ref, ctx, { ...endpoint, baseUrl: azureModelsBase(endpoint.baseUrl, routing) }, headers, withAuthStyle, auth.material !== null, { "api-version": routing.apiVersion });
    },

    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const routing = azureRouting(ctx, withAuthStyle);
      const endpoint = resolveEndpoint(ctx, withAuthStyle);
      const auth = await resolveAuth(ctx, withAuthStyle.authStyle ?? "azure-api-key");
      const headers = buildHeaders({ policy: endpoint.policy, protocol: { accept: "application/json", ...auth.headers }, identity: identityFor(options, ctx), userSupplied: ctx.connection.headers });
      // `api-version` rides EVERY discovery page too — a paged walk that dropped it would 400 on
      // page two only, which is the worst possible place to find out.
      return fetchOpenAiModels(ctx, { ...endpoint, baseUrl: azureModelsBase(endpoint.baseUrl, routing) }, headers, withAuthStyle, { "api-version": routing.apiVersion });
    },

    streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncIterable<ProviderEvent> {
      return azureTurn(req, ctx, withAuthStyle);
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      const mapped = mapEffortAgainst(effort, model);
      return mapped.ok ? { ok: true as const, value: mapped.value } : mapped;
    },

    capabilities: capabilitiesFrom,
  };
}

/** Discovery lives under `/openai` on the classic surface and `/openai/v1` on the preview one. */
function azureModelsBase(baseUrl: string, routing: AzureRouting): string {
  return routing.preview ? `${baseUrl}/openai/v1` : `${baseUrl}/openai`;
}

/**
 * The turn, delegated to whichever of the lane's own adapters the routing selects.
 *
 * The routing is resolved FIRST and outside the delegate, so a misconfigured profile is a typed
 * refusal with zero requests on the wire rather than a 400 from Azure.
 */
async function* azureTurn(req: TurnRequest, ctx: ProviderContext, options: AzureAdapterOptions): AsyncIterable<ProviderEvent> {
  let routing: AzureRouting;
  try {
    routing = azureRouting(ctx, options);
    // Resolved here purely to surface an endpoint refusal before the delegate starts streaming.
    resolveEndpoint(ctx, options);
  } catch (err) {
    yield errorEvent(err);
    return;
  }
  if (routing.preview) {
    yield* responsesTurn(req, ctx, options, undefined, (baseUrl) => azureTurnUrl(baseUrl, routing));
    return;
  }
  yield* chatTurn(req, ctx, options, undefined, (endpoint) => azureTurnUrl(endpoint.baseUrl, routing));
}

/** An Azure connection profile, so a host names the three facts in one place. */
export function azureProfile(opts: { baseUrl: string; deployment?: string; apiVersion: string; headers?: Record<string, string> }): {
  providerId: string;
  baseUrl: string;
  apiVersion: string;
  deployment?: string;
  headers?: Record<string, string>;
} {
  return {
    providerId: "azure-openai",
    baseUrl: opts.baseUrl,
    apiVersion: opts.apiVersion,
    ...(opts.deployment !== undefined ? { deployment: opts.deployment } : {}),
    ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
  };
}
