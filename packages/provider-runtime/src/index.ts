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
export { CREDENTIAL_HEADER_NAMES, createEndpointPolicy, evaluateEndpoint, stripCredentialHeaders } from "./endpoint-policy.ts";
export type { EndpointEvaluation, EndpointEvaluationOptions, EndpointPolicy } from "./endpoint-policy.ts";
export {
  ProviderStallError,
  isProviderError,
  normalizeHttpError,
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
