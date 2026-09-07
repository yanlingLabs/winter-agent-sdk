// `@yanlinglabs/winter-provider-runtime` — the provider seam every adapter lane builds against.
//
// FROZEN as of P6 T2's merge (R6-12): lanes ADD files under their own directories and never edit
// `types.ts`, `registry.ts`, `http.ts`, `sse.ts`, `retry.ts`, `errors.ts`, `endpoint-policy.ts`,
// `discovery.ts`, `credentials/**`, or this barrel.
//
// This package NEVER imports `winter-agent-runtime` (R6-4, cycle). The dependency runs
// runtime → provider-runtime, which is also why the shared address classifier lives here.

export type * from "./types.ts";
export { classifyAddress, isDisallowedAddress, isLocalAddressClass } from "./address-classifier.ts";
export type { AddressClass } from "./address-classifier.ts";
export {
  CredentialResolutionError,
  createCompositeCredentialStore,
  redactMaterial,
  redactRef,
} from "./credentials/types.ts";
export type { CredentialResolutionCode } from "./credentials/types.ts";
export { createMemoryCredentialStore } from "./credentials/memory.ts";
export type { MemoryCredentialStore } from "./credentials/memory.ts";
export { createEnvCredentialStore } from "./credentials/env.ts";
export type { EnvCredentialStoreOptions } from "./credentials/env.ts";
export { createFileCredentialStore } from "./credentials/file.ts";
export type { FileCredentialStoreOptions } from "./credentials/file.ts";
export { CREDENTIAL_HEADER_NAMES, applyPrivilegedHeaders, connectionEndpointOptions, createEndpointPolicy, evaluateEndpoint, stripCredentialHeaders } from "./endpoint-policy.ts";
export type { EndpointEvaluation, EndpointEvaluationOptions, EndpointPolicy } from "./endpoint-policy.ts";
export {
  ProviderStallError,
  isProviderError,
  normalizeHttpError,
  redactCredentialMaterial,
  normalizeThrown,
  parseProviderErrorCode,
  parseRetryAfterMs,
  toSdkAssistantMessageError,
} from "./errors.ts";
export {
  DEFAULT_MAX_RETRIES,
  RETRY_AFTER_HONOUR_CEILING_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  createRetryPolicy,
  withRetry,
} from "./retry.ts";
export type { RetryPolicy, RetryPolicyOptions } from "./retry.ts";
export { DEFAULT_MAX_REDIRECTS, ProviderBodyLimitError, ProviderRequestError, boundedFetch } from "./http.ts";
export type { BoundedFetchInit } from "./http.ts";
// WS-13b (P6.5 spine): Winter's own wire identity. Exported because the widening lanes' new
// adapters and connect screens must reach the SAME function -- a second literal is how a
// family ends up presenting as something else.
export { winterUserAgent } from "./identity.ts";
// P7a (D19): the placeholder-substitution seam. `renderIdentityHeaders` is where a row's declared
// identity value becomes a wire value, and it is the one place a brand's `packageName` has to reach
// for a reuser's identity headers to name the reuser (Lane A threads it).
export { renderIdentityHeaders } from "./identity.ts";
// P7a (D19): the running product's identity. `setWinterIdentity` is what a branded session calls
// once at wiring time (and disposes at teardown) so every `User-Agent`, every `<product>`
// substitution and the codex `originator` name the reuser's product rather than Winter's;
// `activeWinterIdentity` is what the two originator sites read. See identity.ts's own header for
// why this is process-level state and not a threaded parameter.
export { setWinterIdentity, activeWinterIdentity } from "./identity.ts";
export type { WinterIdentity } from "./identity.ts";
export type { IdentityRenderContext } from "./identity.ts";

// WS-13b (P6.5 spine): the two OAuth primitives every Winter-authored flow shares.
//
// `refreshOauthMaterial` is the refresh-token grant EXTRACTED from `codex-oauth.ts` -- including its
// merge rule, which is what stops a partial refresh response from erasing a still-good refresh
// token. `runDeviceCodeFlow` is RFC 8628, the login shape a vendor's public client supports without
// a registered `redirect_uri`. Both are exported so the widening lanes build on them rather than on
// a second copy: the merge rule and the honest-identity field are exactly the details a copy loses.
export { refreshOauthMaterial } from "./adapters/oauth/refresh.ts";
export type { KeychainRef, OauthMaterial, RefreshOauthMaterialInput } from "./adapters/oauth/refresh.ts";
export { runDeviceCodeFlow } from "./adapters/oauth/device-code.ts";
export type { DeviceCodeConfig } from "./adapters/oauth/device-code.ts";

// WS-13b D20: the Anthropic Console OAuth login, published so `runtime`'s `startProviderLogin` can
// reach it by package name. Exported from HERE rather than from `adapters/index.ts` — which the
// star-export below already republishes — because the widening lanes edit that file concurrently and
// this is the one place the two additions cannot collide.
export { CONSOLE_OAUTH, OAUTH_REFRESH_WINDOW_MS, anthropicCredentialRef, startAnthropicConsoleLogin } from "./adapters/anthropic/index.ts";
export type { AnthropicConsoleLoginOptions, AnthropicConsoleLoginResult } from "./adapters/anthropic/index.ts";
export { parseSse } from "./sse.ts";
export type { SseEvent, SseOptions } from "./sse.ts";
export { WinterProviderResolutionError, createRegistry, estimateCostUsd } from "./registry.ts";
export type { ModelInfo, ProviderRegistry, RegistryListing, ResolutionErrorCode, ResolveRequest, ResolvedModel, UsageForCost } from "./registry.ts";
export { createDiscoveryCache, discoverModels } from "./discovery.ts";
export type { DiscoveryCache } from "./discovery.ts";

// --- Phase 6 Task 10: the two surfaces the lanes built and the barrel could not publish -----------
//
// UNFROZEN AT CLOSE, deliberately and only here. R6-12 froze this file for the duration of the
// parallel lanes so no two of them could edit it at once; the freeze was never a statement that the
// package's own adapters and continuity module should stay unreachable by package name. Every lane
// reached them by relative path (`../../../provider-runtime/src/adapters/...`), which works and is
// exactly the drift the barrel exists to prevent: a path is a private detail, and four packages
// spelling it out is four places to fix when a file moves.
//
// `adapters/index.ts` additionally carries `createShippedAdapters`, the ONE construction site for
// every adapter this build ships — see its header for why the descriptor lookup lives there.
export * from "./adapters/index.ts";
// P6 fix wave (Ruling E-2): the continuity module BY NAME rather than by star -- the export list IS
// the production surface, and the retired switch coordinator (deleted) is not on it. The engine owns
// the switch point; a future "coordinator" reaching the barrel by star-export would be the duplicate
// the ruling retired.
export {
  RECOVERED_REASONING_TAG,
  MIN_DECORATION_BODY_CHARS,
  buildDecoration,
  decorationOverhead,
  doorFor,
  escapeAttribute,
  escapeInline,
  neutralizeDelimiters,
  trimToBudget,
  createEndpointResolver,
  endpointFromOrigin,
  readableStateOf,
  sameDomain,
  sameFamily,
  shouldRequestSummary,
  summaryRequestOf,
  applyDecorationToContent,
  createHistoryRenderer,
  classifySwitch,
  INSTRUCTION_FILE_BASENAMES,
  PRIOR_MODEL_HANDOFF_TAG,
  buildPortableHandoff,
  handoffDecoration,
} from "./continuity/index.ts";
export type {
  Decoration,
  DecorationDoor,
  DecorationInput,
  DecorationSource,
  ContinuityEndpoint,
  DomainFacts,
  ReadableState,
  ContinuationChainLike,
  ContinuationLinkLike,
  HistoryRendererOptions,
  HistoryTarget,
  MaterialKind,
  RenderReport,
  RenderedDecoration,
  WinterHistoryRenderer,
  LossClass,
  SwitchClassification,
  SwitchFacts,
  HandoffToolFact,
  PortableHandoff,
  PortableHandoffOptions,
  PortableHandoffSections,
} from "./continuity/index.ts";
