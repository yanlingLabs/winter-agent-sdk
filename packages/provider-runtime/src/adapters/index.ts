// Phase 6 Task 10: THE SHIPPED ADAPTER LIST, in one place.
//
// Four lanes each shipped a family barrel (`adapters/<family>/index.ts`) and each documented, in its
// own header, how a host would register its adapters. Nothing collected them — so "which adapters
// does this build ship?" had four answers and no single reader, and a lane that added a family
// without telling the wirer would ship an adapter the catalog names and the registry has never seen
// (`no-adapter` at resolution time, for a row the catalog swears is shipped).
//
// `createShippedAdapters(catalog)` is that reader, and it exists to make the descriptor lookup
// impossible to forget. Lane A and Lane N take a REQUIRED `descriptors` option precisely because
// omitting it disables the effort / parameter / output-limit refusals SILENTLY (each family barrel
// says so in its own header); Lane B takes a `catalog` and derives the same lookup itself. Both
// shapes are satisfied HERE, from one catalog, so no call site can satisfy one and forget the other.
//
// THE LOOKUP IS KEYED BY ADAPTER, NOT BY PROVIDER, and that is load-bearing: one adapter serves many
// providers (`winter.local-openai` serves twelve local runners, `winter.openai-chat-completions`
// serves deepseek and openrouter), and the frozen `DescriptorLookup` signature is
// `(providerLocalModelId) => descriptor` with no provider argument. Searching the rows whose
// provider points AT THIS ADAPTER is the only resolution that is both correct for a multi-provider
// adapter and incapable of returning another adapter's row.
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderAdapter } from "../types.ts";
import { identityHeaderLookup } from "../identity.ts";
import { createAnthropicMessagesAdapter } from "./anthropic/index.ts";
import { createGoogleGenerateContentAdapter, createVertexGeminiAdapter } from "./google/index.ts";
import { createBedrockConverseAdapter } from "./bedrock/index.ts";
import { createResponsesAdapter, createChatCompletionsAdapter, createCodexOauthAdapter, createXaiOauthAdapter } from "./openai/index.ts";
import { createAzureOpenAIAdapter } from "./openai/azure.ts";
import { createLocalOpenAIAdapter } from "./openai/local.ts";

/** A per-adapter descriptor lookup: the provider-local model id (or key, or alias) a request named -> its catalog row. */
export type AdapterDescriptorLookup = (providerLocalModelId: string) => WinterModelDescriptor | undefined;

/**
 * Every row served by ONE adapter id, indexed by the three spellings a request may use.
 *
 * Built once per registration rather than scanned per request: `streamTurn` calls the lookup on
 * every turn, and a linear scan of the whole catalog per turn is a cost with no reason.
 */
export function descriptorLookupForAdapter(catalog: WinterCatalog, adapterId: string): AdapterDescriptorLookup {
  const providers = new Set(catalog.providers.filter((p) => p.adapterId === adapterId).map((p) => p.id));
  const index = new Map<string, WinterModelDescriptor>();
  for (const model of catalog.models) {
    if (!providers.has(model.providerId)) continue;
    // `key` first and never overwritten by a later row's alias: a key is globally unique, an alias
    // is not, so an alias collision must never shadow a real row.
    if (!index.has(model.key)) index.set(model.key, model);
    if (!index.has(model.upstreamId)) index.set(model.upstreamId, model);
    for (const alias of model.aliases) if (!index.has(alias)) index.set(alias, model);
  }
  return (id) => index.get(id);
}

/** The adapter ids this build ships, in the order they are registered. Exported so a test can assert the catalog names no adapter this list omits. */
export const SHIPPED_ADAPTER_IDS = [
  "winter.openai-responses",
  "winter.openai-chat-completions",
  "winter.codex-oauth",
  "winter.xai-oauth",
  "winter.azure-openai",
  "winter.local-openai",
  "winter.anthropic-messages",
  "winter.google-generate-content",
  "winter.vertex-gemini",
  "winter.bedrock-converse",
] as const;

/**
 * The GENERATED endpoint one adapter speaks to, from the catalog rather than from a constant.
 *
 * R6-11 makes a generated descriptor endpoint immutable and reviewed, and `applyPrivilegedHeaders`
 * gates the identity-bearing headers on exactly that reviewed status — so the endpoint's AUTHORITY
 * should be the catalog row that declares it, not a string compiled into the adapter. The adapter's
 * own constant stays as the fallback for a build with no row.
 *
 * ONLY FOR AN ADAPTER SERVING EXACTLY ONE PROVIDER. An adapter with several (twelve local runners,
 * deepseek + openrouter) has no single generated endpoint, and each of its providers reaches its own
 * through the connection profile instead — see `connectionForProvider` in the runtime's wiring for
 * that half and the fixture that pins both directions.
 */
function generatedBaseUrlForAdapter(catalog: WinterCatalog, adapterId: string): string | undefined {
  const providers = catalog.providers.filter((p) => p.adapterId === adapterId);
  if (providers.length !== 1) return undefined;
  const api = providers[0]?.defaultEndpoints["api"];
  return api !== undefined && api.length > 0 ? api : undefined;
}

/**
 * Builds every adapter this build ships against ONE catalog.
 *
 * The production wiring's only adapter-construction site (`production-wiring.ts`), and the corpus's
 * whole-catalog probe's too — so "which adapters does a session have?" and "which adapters did the
 * probe check?" cannot answer differently.
 */
export function createShippedAdapters(catalog: WinterCatalog): ProviderAdapter[] {
  const lookup = (adapterId: string): AdapterDescriptorLookup => descriptorLookupForAdapter(catalog, adapterId);
  // WS-13b §7/§8.4 (fix-wave R-FW-2): the per-ROW identity headers, indexed ONCE off this catalog
  // and handed to every family that takes a construction option for them. The Anthropic and Google
  // families take a `catalog` instead and derive the identical index themselves — a shape a wiring
  // cannot forget — so they are absent from the calls below on purpose, not by omission.
  const identityHeaders = identityHeaderLookup(catalog);
  const generated = (c: WinterCatalog, adapterId: string): { generatedBaseUrl?: string } => {
    const url = generatedBaseUrlForAdapter(c, adapterId);
    return url !== undefined ? { generatedBaseUrl: url } : {};
  };
  return [
    // Lane A — the OpenAI family.
    createResponsesAdapter({ descriptors: lookup("winter.openai-responses"), identityHeaders, ...generated(catalog, "winter.openai-responses") }),
    createChatCompletionsAdapter({ descriptors: lookup("winter.openai-chat-completions"), identityHeaders, ...generated(catalog, "winter.openai-chat-completions") }),
    createCodexOauthAdapter({ descriptors: lookup("winter.codex-oauth"), identityHeaders, ...generated(catalog, "winter.codex-oauth") }),
    // `winter.xai-oauth` — the chat adapter at xAI's SUBSCRIPTION proxy. `generated(...)` reads the
    // endpoint off the catalog row rather than the adapter's own constant, which is what keeps the
    // reviewed row and the shipped request agreeing; the constant is the fallback for a build with
    // no row. The row is `pricingBasis: "subscription"`, so nothing it returns feeds R6-H cost.
    createXaiOauthAdapter({ descriptors: lookup("winter.xai-oauth"), identityHeaders, ...generated(catalog, "winter.xai-oauth") }),
    createAzureOpenAIAdapter({ descriptors: lookup("winter.azure-openai"), identityHeaders, ...generated(catalog, "winter.azure-openai") }),
    // Registered under the id the catalog's twelve local rows actually point at (see
    // `LocalAdapterOptions.id`'s own header for why that id is overridable at all).
    createLocalOpenAIAdapter({ descriptors: lookup("winter.local-openai"), identityHeaders, id: "winter.local-openai" }),
    // Lane B — Anthropic Messages, Google GenerateContent, and Vertex over the same wire mapping.
    // These take the CATALOG rather than a lookup (their own option shape) and derive the same rows.
    createAnthropicMessagesAdapter({ catalog }),
    createGoogleGenerateContentAdapter({ catalog }),
    createVertexGeminiAdapter({ catalog }),
    // Lane N — Bedrock Converse (experimental).
    createBedrockConverseAdapter({ descriptors: lookup("winter.bedrock-converse"), identityHeaders }),
  ];
}

// --- the families' own surfaces, re-exported ------------------------------------------------------
//
// NAMED rather than `export *`: `findDescriptor` is exported by BOTH the anthropic and the google
// barrel, and a star-export collision is silently excluded from the re-export set rather than
// reported — a consumer would import a name that type-checks nowhere and exists nowhere.
export {
  ANTHROPIC_ADAPTER_ID,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  createAnthropicMessagesAdapter,
  mapAnthropicEffort,
  toWireMessages,
} from "./anthropic/index.ts";
export type { AnthropicAdapterOptions } from "./anthropic/index.ts";
export {
  GOOGLE_ADAPTER_ID,
  GOOGLE_API_VERSION_PATH,
  GOOGLE_DEFAULT_BASE_URL,
  VERTEX_ADAPTER_ID,
  VERTEX_API_VERSION_PATH,
  createGoogleFamilyAdapter,
  createGoogleGenerateContentAdapter,
  createVertexGeminiAdapter,
  geminiTransport,
  mapGoogleEffort,
  toContents,
  vertexEndpointUrl,
  vertexTransport,
} from "./google/index.ts";
export type { GoogleAdapterOptions, GoogleTransport, VertexAdapterOptions } from "./google/index.ts";
export {
  BEDROCK_ADAPTER_ID,
  BEDROCK_ADAPTER_VERSION,
  createBedrockConverseAdapter,
  mapBedrockEffort,
  requireRegion,
  resolveAwsCredentials,
  signRequest,
} from "./bedrock/index.ts";
export type { BedrockAdapter, BedrockAdapterOptions } from "./bedrock/index.ts";
export {
  CODEX_ORIGINATOR,
  DEEPSEEK_BASE_URL,
  OPENAI_API_BASE_URL,
  OPENAI_CHAT_BASE_URL,
  OPENROUTER_BASE_URL,
  createChatCompletionsAdapter,
  createCodexOauthAdapter,
  createResponsesAdapter,
  codexCredentialAccount,
  codexCredentialRef,
  deepSeekProfile,
  openRouterProfile,
  startCodexLogin,
  XAI_CONSENT_DISCLOSURE,
  XAI_OAUTH,
  XAI_OAUTH_ADAPTER_ID,
  createXaiOauthAdapter,
  startXaiLogin,
  xaiCredentialRef,
  DERIVED_XAI,
  DERIVED_XAI_COMMIT,
  DERIVED_XAI_MODELS,
} from "./openai/index.ts";
export type { CodexAdapterOptions, CodexLoginOptions, CodexLoginResult, XaiLoginOptions, XaiLoginResult } from "./openai/index.ts";
export { createAzureOpenAIAdapter } from "./openai/azure.ts";
export type { AzureAdapterOptions } from "./openai/azure.ts";
export { createLocalOpenAIAdapter } from "./openai/local.ts";
export type { LocalAdapterOptions } from "./openai/local.ts";
export { PRIVILEGED_IDENTITY_HEADERS } from "./privileged-headers.ts";
