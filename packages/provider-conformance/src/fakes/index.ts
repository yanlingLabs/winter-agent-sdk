// `@yanlinglabs/winter-provider-conformance/fakes` — every loopback fake in this directory, as one
// subpath (P7a Lane C, WS-02 §9 Step 2). A consumer who only wants the fakes (not the corpus runner,
// the continuity corpus, the classifier-safety corpus, or the live-gate machinery the package's main
// barrel also carries) imports this instead, for a smaller import graph.
//
// The main barrel (`../index.ts`) re-exports this file's entire surface via `export *`, so every
// existing consumer that imports a fake from the TOP-LEVEL package name (e.g.
// `verify-provider-live.test.ts`'s `import { anthropicConsoleOauthFake, ... } from
// "@yanlinglabs/winter-provider-conformance"`) keeps working unmodified.
//
// NAMESPACES RATHER THAN A FLAT `export *` for the per-family fakes, and the reason is not style:
// `corpus/anthropic.ts` and `corpus/google.ts` both export `collectEvents`, and the fakes below have
// their own share of common names across files (e.g. every OpenAI-shaped fake exports helpers named
// similarly) — a star-export collision is silently EXCLUDED rather than reported, so a flat barrel
// would publish a surface that quietly omits names a lane genuinely uses. A namespace per module is
// collision-proof by construction (mirrors the main barrel's own `anthropicCorpus`/`googleCorpus`/…
// convention for `corpus/*.ts`).
export {
  errorResponse,
  jsonResponse,
  noRequestContains,
  redirectResponse,
  requestsTo,
  scenarioTable,
  sseResponse,
  stalledResponse,
  startFake,
  withFake,
} from "./server.ts";
export type { FakeRoute, FakeServer, RecordedRequest, ScenarioResponder, ScenarioTableOptions, SseFrame, SseResponseOptions, StartFakeOptions } from "./server.ts";

export * as anthropicConsoleOauthFake from "./anthropic-console-oauth.ts";
export * as anthropicFake from "./anthropic-messages.ts";
export * as azureFake from "./azure-openai.ts";
export * as bedrockFake from "./bedrock.ts";
export * as codexFake from "./codex-oauth.ts";
export * as geminiFake from "./gemini.ts";
export * as openaiChatFake from "./openai-chat.ts";
export * as openaiModelsFake from "./openai-models.ts";
export * as openaiResponsesFake from "./openai-responses.ts";
export * as vertexFake from "./vertex.ts";
export * as xaiOauthFake from "./xai-oauth.ts";
export { OPAQUE_FIELD_NAMES, redactOpaqueFields } from "./redact-opaque.ts";

// P7a Lane C: the one fake-directory file the pre-7a barrel never re-exported. `jwt-verify.ts` is
// test support for the Vertex fake (RS256 JWT verification — nothing in the shipped path calls it,
// per that file's own header), not a network fake itself, so it gets named exports rather than a
// namespace, matching `redact-opaque.ts`'s own treatment just above.
export { base64UrlDecodeBytes, base64UrlDecodeText, verifyRs256Jwt } from "./jwt-verify.ts";
