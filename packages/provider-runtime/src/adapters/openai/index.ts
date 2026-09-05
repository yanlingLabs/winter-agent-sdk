// Lane A's public surface: the OpenAI family's five adapters and the profiles that configure them.
//
// This barrel is the LANE's, not the package's. `provider-runtime/src/index.ts` is frozen (R6-12)
// and does not re-export adapters, so a host wires these by importing this module directly and
// registering the results:
//
//     registry.register(createResponsesAdapter({ descriptors }));
//     registry.register(createChatCompletionsAdapter({ descriptors }));
//     registry.register(createCodexOauthAdapter({ descriptors }));
//     registry.register(createAzureOpenAIAdapter({ descriptors }));
//     registry.register(createLocalOpenAIAdapter({ descriptors, id: "winter.openai-chat-completions" }));
//
// `descriptors` is the catalog lookup every adapter needs to refuse an unmappable effort, an
// unrepresentable thinking config or an over-limit request BEFORE it sends anything (WS-13 §8.2).
// It is optional at the type level because a gateway model has no descriptor at all — see
// `shared.ts`'s decision 2 — so a host that forgets it gets a WEAKER adapter, not a broken one.
// That is a real wiring obligation and it is stated in the lane report.

export { createResponsesAdapter, buildResponsesBody, mapResponsesInput, mapResponsesTools, responsesTurn, streamResponsesTurn, privilegedHeaders, ResponsesStreamMapper, OPENAI_API_BASE_URL } from "./responses.ts";
export type { ResponsesTurnPlan } from "./responses.ts";

export {
  createChatCompletionsAdapter,
  buildChatBody,
  mapChatMessages,
  mapChatTools,
  chatTurn,
  deepSeekProfile,
  openRouterProfile,
  ChatStreamMapper,
  DEEPSEEK_BASE_URL,
  OPENAI_CHAT_BASE_URL,
  OPENROUTER_BASE_URL,
} from "./chat-completions.ts";
export type { ChatTurnOptions, ExposedReasoningItem } from "./chat-completions.ts";

export { createCodexOauthAdapter, codexCredentialRef, startCodexLogin } from "./codex-oauth.ts";
export type { CodexAdapterOptions, CodexLoginOptions, CodexLoginResult } from "./codex-oauth.ts";
export { CODEX, CODEX_MODELS, CODEX_MODELS_VERIFIED, CODEX_ORIGINATOR, DEFAULT_CODEX_MODEL, codexCredentialAccount } from "./codex-config.ts";
export { QuotaManager, quotaEvent } from "./quota.ts";
export type { QuotaState } from "./quota.ts";
export { base64Url, buildAuthorizeUrl, decodeAccountId, generatePkce, refreshTokens, runLoginFlow } from "./pkce.ts";
export type { LoginConfig, OAuthTokens } from "./pkce.ts";

export { createLocalOpenAIAdapter } from "./local.ts";
export type { LocalAdapterOptions } from "./local.ts";

export { createAzureOpenAIAdapter, azureProfile, azureRouting, azureTurnUrl, AZURE_PREVIEW_API_VERSION } from "./azure.ts";
export type { AzureAdapterOptions } from "./azure.ts";

export {
  EFFORT_LADDER,
  EventQueue,
  assertRepresentableTools,
  assertWithinLimits,
  buildHeaders,
  capabilitiesFrom,
  capabilityRefusal,
  fetchOpenAiModels,
  mapEffortAgainst,
  pumpEvents,
  resolveEndpoint,
  resolveReasoning,
  snapNumericEffort,
} from "./shared.ts";
export type { AuthStyle, DescriptorLookup, OpenAiAdapterOptions, ReasoningPlan, ResolvedEndpoint } from "./shared.ts";
