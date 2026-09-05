// Phase 6 Task 6 (Lane B): the Google family's own barrel.
//
// The package barrel (`src/index.ts`) is FROZEN (R6-12) and this package's `exports` map publishes
// only `.`, so a consumer outside the package reaches an adapter through a relative path to THIS
// file.
//
// BOTH transports live behind one wire mapping: `generate-content.ts` owns the dialect and the
// normalizer, and `vertex.ts` supplies only a different URL and a different credential (R6-A/R6-16).
export {
  GOOGLE_ADAPTER_ID,
  GOOGLE_API_VERSION_PATH,
  GOOGLE_DEFAULT_BASE_URL,
  createGoogleFamilyAdapter,
  createGoogleGenerateContentAdapter,
  findDescriptor,
  geminiTransport,
  mapGoogleEffort,
  toContents,
} from "./generate-content.ts";
export type { GoogleAdapterOptions, GoogleEffortMapping, GoogleThoughtSignatureItem, GoogleTransport } from "./generate-content.ts";
export { VERTEX_ADAPTER_ID, VERTEX_API_VERSION_PATH, createVertexGeminiAdapter, vertexEndpointUrl, vertexModelPath, vertexTransport } from "./vertex.ts";
export type { VertexAdapterOptions } from "./vertex.ts";
export { GCP_CLOUD_PLATFORM_SCOPE, createAccessTokenSource, createServiceAccountTokenSource, createStaticAccessTokenSource } from "./adc.ts";
export type { AccessTokenSource, AccessTokenSourceOptions } from "./adc.ts";
export { JwtKeyError, RS256, base64UrlEncode, base64UrlEncodeText, importRs256PrivateKey, pkcs8DerFromPem, signRs256Jwt } from "./jwt-rs256.ts";
export type { ServiceAccountJwtClaims } from "./jwt-rs256.ts";
