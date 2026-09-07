// `@yanlinglabs/winter-provider-runtime/testing` — review r1 (Critical-2) remediation.
//
// WHY THIS FILE EXISTS. `packages/provider-conformance`'s corpus/fakes reached a handful of
// provider-runtime internals that the main barrel (`src/index.ts`) never re-exports -- mostly
// genuine test-support helpers (`adapters/openai/testing.ts`, `adapters/openai/xai-oauth.testing.ts`,
// `adapters/bedrock/testing.ts`, `continuity/fixtures.ts`), plus a few production functions whose
// ONLY consumer happens to be a test (`hostHeaders`, `base64Url`, `parseAuthorization`,
// `googleCompletionMarker`, `vertexModelPath`, `RS256`/`base64UrlEncode`, `CODEX`). Every one of
// them was previously reached via a relative path that ESCAPES provider-conformance's own package
// boundary (`../../../provider-runtime/src/...`) -- which works only inside this monorepo, where the
// path physically exists on disk, and throws `Cannot find module` the moment provider-conformance is
// packed and installed standalone (review r1 Critical Finding 2, reproduced against a real packed
// tarball).
//
// This is a SEPARATE subpath rather than an addition to the main barrel on purpose: the main barrel
// is provider-runtime's PRODUCTION surface (WS-13 §13's own adapter contract), and blending test
// scaffolding into it would make "is this safe to build a real adapter against" a harder question to
// answer by reading the file. A consumer that wants only the real adapters never needs to know this
// subpath exists.
//
// EXPLICIT NAMED RE-EXPORTS, not `export *` from each source file: `adapters/openai/testing.ts` and
// `continuity/fixtures.ts` BOTH export a function named `evidence` with an identical signature -- a
// star-export barrel would silently drop one of them. Every name below is exactly what
// provider-conformance's corpus/fakes files actually import; nothing else from these files is
// re-exported, matching the ruling's own "exactly those helpers."
export { concatFrames, converseStreamEvent, converseStreamException, verifySigV4, encodeEventStreamMessage } from "./adapters/bedrock/testing.ts";
export type { EventStreamHeaderInput, SigV4Verdict, VerifySigV4Input } from "./adapters/bedrock/testing.ts";
export { parseAuthorization } from "./adapters/bedrock/sigv4.ts";

export { FAST_RETRY, descriptor, testContext, testDiscoveryContext } from "./adapters/openai/testing.ts";
export type { DescriptorOverrides, TestContextOptions } from "./adapters/openai/testing.ts";
export { startXaiOauthFake } from "./adapters/openai/xai-oauth.testing.ts";
export type { XaiOauthFake, XaiOauthFakeOptions, XaiRecordedRequest } from "./adapters/openai/xai-oauth.testing.ts";
export { CODEX } from "./adapters/openai/codex-config.ts";
export { QuotaManager } from "./adapters/openai/quota.ts";
export { base64Url } from "./adapters/openai/pkce.ts";
export { AZURE_PREVIEW_API_VERSION } from "./adapters/openai/azure.ts";

export { hostHeaders } from "./adapters/privileged-headers.ts";
export { RS256, base64UrlEncode, importRs256PrivateKey, pkcs8DerFromPem, signRs256Jwt } from "./adapters/google/jwt-rs256.ts";
export { vertexModelPath } from "./adapters/google/index.ts";
export { GCP_CLOUD_PLATFORM_SCOPE, createServiceAccountTokenSource } from "./adapters/google/adc.ts";
export { googleCompletionMarker } from "./adapters/google/generate-content.ts";
export { THINKING_ENABLED_NEEDS_BUDGET } from "./adapters/refusals.ts";

export { fixtureCatalog, fixtureModel, fixtureProvider, fixtureReasoning, scriptedAdapter } from "./continuity/fixtures.ts";
