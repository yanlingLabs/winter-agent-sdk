// Phase 6 Task 6 (Lane B): the Vertex Gemini loopback fake.
//
// ADDED beside `fakes/server.ts`, which is FROZEN (R6-12).
//
// WHAT THIS FAKE ADDS OVER `gemini.ts`, and why it is a separate file: Vertex authenticates with a
// SIGNED ASSERTION, not an API key, and a fake that accepted any assertion would make "the adapter
// authenticated correctly" untestable. So this one runs the real token endpoint: it parses the
// `assertion`, VERIFIES ITS SIGNATURE against a public key, checks the header and the claim set, and
// only then mints an access token. An adapter that signed with the wrong algorithm, addressed the
// wrong audience, or forgot the scope gets a 401 from the fake -- exactly as it would from Google.
//
// THE KEYPAIR IS GENERATED IN-TEST AND NEVER COMMITTED (ruling R6-A, verbatim). `generateTestKeyPair`
// produces a fresh RSA keypair per call via WebCrypto; the private half is rendered as a PKCS#8 PEM
// so it can go into a service-account JSON exactly as a real one would, and the public half stays a
// `CryptoKey` that only this fake holds.
import { errorResponse, jsonResponse, type FakeRoute, type RecordedRequest } from "./server.ts";
import { geminiError, geminiModelOf, type GeminiFakeOptions } from "./gemini.ts";
import { base64UrlEncode, verifyRs256Jwt } from "../../../provider-runtime/src/adapters/google/index.ts";

/** A keypair for one test run. NEVER committed: this generates a fresh one every call. */
export async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  // Standard PEM: base64 in 64-character lines between the PKCS#8 markers, which is exactly the
  // shape a service-account JSON's `private_key` carries.
  const body = base64UrlEncode(pkcs8).replace(/-/g, "+").replace(/_/g, "/");
  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  const lines = padded.match(/.{1,64}/g) ?? [];
  return { privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

/** One assertion the token endpoint verified, recorded so a test can assert on its claims. */
export interface VerifiedAssertion {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export interface VertexFakeOptions extends GeminiFakeOptions {
  /** The public half of the in-test keypair. The token route verifies every assertion against it. */
  publicKey: CryptoKey;
  project: string;
  location: string;
  /** The `aud` every assertion must carry -- the fake's own token URL. */
  tokenUri: string;
  /** Filled in as assertions are verified. The evidence a claim assertion reads. */
  verified: VerifiedAssertion[];
  /** The access token the exchange mints. Distinctive so a "never logged" negative is meaningful. */
  accessToken?: string;
  /** `expires_in`, in seconds. `0` scripts a token that is already expired, for the cache fixture. */
  expiresIn?: number;
  /** Rejects every exchange, for the credential-failure fixture. */
  rejectExchange?: boolean;
}

/** The default access token. `test-...` by the lane's own rule; distinctive so `noRequestContains` means something. */
export const VERTEX_TEST_ACCESS_TOKEN = "test-vertex-access-token-1";

const REQUIRED_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * The token endpoint, for real.
 *
 * Every check below is one an adapter can actually get wrong, and each has a distinct 401 body so a
 * failing fixture says WHICH one failed rather than "unauthorized".
 */
async function handleTokenExchange(recorded: RecordedRequest, opts: VertexFakeOptions): Promise<Response> {
  if (opts.rejectExchange === true) return errorResponse(401, { error: "invalid_grant", error_description: "fake: the exchange was scripted to fail" });
  const form = new URLSearchParams(recorded.body);
  if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
    return errorResponse(400, { error: "unsupported_grant_type", error_description: `saw ${JSON.stringify(form.get("grant_type"))}` });
  }
  const assertion = form.get("assertion");
  if (assertion === null) return errorResponse(400, { error: "invalid_request", error_description: "no assertion" });

  const verified = await verifyRs256Jwt(assertion, opts.publicKey);
  if (verified === undefined) return errorResponse(401, { error: "invalid_grant", error_description: "the assertion's RS256 signature did not verify" });
  if (verified.header["alg"] !== "RS256" || verified.header["typ"] !== "JWT") {
    return errorResponse(401, { error: "invalid_grant", error_description: `unexpected JOSE header ${JSON.stringify(verified.header)}` });
  }
  const { claims } = verified;
  if (claims["aud"] !== opts.tokenUri) return errorResponse(401, { error: "invalid_grant", error_description: `wrong audience ${JSON.stringify(claims["aud"])}` });
  if (claims["scope"] !== REQUIRED_SCOPE) return errorResponse(401, { error: "invalid_grant", error_description: `wrong scope ${JSON.stringify(claims["scope"])}` });
  if (typeof claims["iss"] !== "string" || !claims["iss"].includes("@")) return errorResponse(401, { error: "invalid_grant", error_description: "iss is not a service-account email" });
  const iat = claims["iat"];
  const exp = claims["exp"];
  if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat) return errorResponse(401, { error: "invalid_grant", error_description: "iat/exp are missing or inverted" });
  if (exp - iat > 3600) return errorResponse(401, { error: "invalid_grant", error_description: "the assertion lifetime exceeds one hour" });

  opts.verified.push(verified);
  return jsonResponse({ access_token: opts.accessToken ?? VERTEX_TEST_ACCESS_TOKEN, token_type: "Bearer", expires_in: opts.expiresIn ?? 3600 });
}

/** The token URL a fixture points a service-account JSON's `token_uri` at. */
export function vertexTokenUrl(fakeUrl: string): string {
  return `${fakeUrl}/token`;
}

/**
 * The Vertex routes: the token endpoint plus the location-scoped model paths.
 *
 * The model path is prefix-matched under `/v1/projects/...` because the model id and the method are
 * both IN the path. `assertVertexPath` is what checks it is the exact shape ruling R6-A names.
 */
export function vertexFakeRoutes(opts: VertexFakeOptions): FakeRoute[] {
  const attempts = new Map<string, number>();
  return [
    { path: "/token", method: "POST", handler: async (_req, recorded) => await handleTokenExchange(recorded, opts) },
    {
      path: `/v1/projects/${opts.project}/locations/${opts.location}/publishers/google/models*`,
      method: "POST",
      handler: async (_req, recorded) => {
        const model = geminiModelOf(recorded) ?? "";
        if (recorded.path.endsWith(":countTokens")) {
          return opts.countTokens?.(recorded) ?? jsonResponse({ totalTokens: 42 });
        }
        const attempt = (attempts.get(model) ?? 0) + 1;
        attempts.set(model, attempt);
        const entry = opts.stream[model];
        if (entry === undefined) return geminiError(400, "INVALID_ARGUMENT", `fake: no scenario for model ${JSON.stringify(model)}`);
        if (Array.isArray(entry)) return entry[Math.min(attempt - 1, entry.length - 1)]!;
        return await entry(recorded, attempt);
      },
    },
  ];
}

/**
 * Asserts the request landed on the EXACT location-endpoint path ruling R6-A names, and carried a
 * bearer token rather than an api key.
 *
 * The authorization value is checked in its REDACTED form -- the base replaces a credential header's
 * material as it records, so `Bearer ***` proves both that the adapter authenticated and that the
 * redaction ran.
 */
export function assertVertexRequest(recorded: RecordedRequest, expected: { project: string; location: string; model: string; method?: string; search?: string }): void {
  const method = expected.method ?? "streamGenerateContent";
  const path = `/v1/projects/${expected.project}/locations/${expected.location}/publishers/google/models/${expected.model}:${method}`;
  const detail = `\n  live request: ${recorded.method} ${recorded.path}${recorded.search}\n  headers: ${JSON.stringify(recorded.headers)}`;
  if (recorded.path !== path) throw new Error(`expected the Vertex location path ${path}${detail}`);
  if (expected.search !== undefined && recorded.search !== expected.search) throw new Error(`expected search ${expected.search}${detail}`);
  if (recorded.headers["authorization"] !== "Bearer ***") throw new Error(`expected a redacted bearer token${detail}`);
  if (recorded.headers["x-goog-api-key"] !== undefined) throw new Error(`a Vertex request must not carry an api key${detail}`);
}
