// Lane N's barrel — `bedrock-converse@1` and the primitives it is built from. Task 9 (R6-16).
//
// A LANE BARREL RATHER THAN THE PACKAGE'S OWN: `provider-runtime/src/index.ts` is FROZEN (R6-12) and
// exports no adapters, so a consumer reaches this family through this file. T10's wiring imports
// from here.
//
// WIRING, restated where a wirer will see it. `descriptors` is a REQUIRED option, deliberately: the
// frozen `ProviderAdapter` seam hands a descriptor to `mapEffort`/`capabilities` but never to
// `streamTurn`, so without a lookup the tools-on-a-non-tool-calling-model and output-token-limit
// refusals simply do not happen — silently, with nothing failing to compile. Making it required
// turns that from an omission anyone can make into a decision someone has to write down; a caller
// with no catalog passes `descriptors: () => undefined` and has SAID so.
//
//   createBedrockConverseAdapter({
//     descriptors: (id) => catalog.models.find((m) => m.providerId === "bedrock" && m.upstreamId === id),
//     // and, where discovery says a model does not stream:
//     streaming: (id) => streamingSupported.get(id) ?? true,
//   })
//
// The connection profile MUST carry `region` (there is no default — it is part of the credential
// scope and of where the request is served) and an `authRef` that resolves to AWS material:
// `{ kind: "aws-default-chain" }`, a `{ kind: "file", format: "aws-shared-credentials" }` ref, or a
// Keychain ref holding an access key pair.

export {
  BEDROCK_ADAPTER_ID,
  BEDROCK_ADAPTER_VERSION,
  bedrockErrorCode,
  buildConverseBody,
  createBedrockConverseAdapter,
  mapBedrockEffort,
  normalizeBedrockError,
  toBedrockMessages,
} from "./converse.ts";
export type { BedrockAdapter, BedrockAdapterOptions, BedrockRequestBody } from "./converse.ts";

export { requireRegion, resolveAwsCredentials } from "./credentials.ts";

export {
  EventStreamDecodeError,
  MAX_EVENT_STREAM_HEADER_BYTES,
  MAX_EVENT_STREAM_MESSAGE_BYTES,
  createEventStreamDecoder,
  jsonPayload,
  messageType,
  stringHeader,
} from "./eventstream.ts";
export type { EventStreamDecodeErrorCode, EventStreamDecoder, EventStreamHeaderValue, EventStreamMessage, EventStreamMessageType } from "./eventstream.ts";

export { crc32 } from "./crc32.ts";

export {
  BEDROCK_SERVICE,
  SIGV4_ALGORITHM,
  awsUriEncode,
  buildCanonicalRequest,
  buildStringToSign,
  canonicalQuery,
  canonicalUri,
  computeSignature,
  amzDate,
  parseAuthorization,
  sha256Hex,
  signRequest,
  signingKey,
} from "./sigv4.ts";
export type { AwsSigningCredentials, CanonicalRequestInput, ParsedAuthorization, SignRequestInput, SignedRequest } from "./sigv4.ts";
