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
export { CREDENTIAL_HEADER_NAMES, applyPrivilegedHeaders, createEndpointPolicy, evaluateEndpoint, stripCredentialHeaders } from "./endpoint-policy.ts";
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
