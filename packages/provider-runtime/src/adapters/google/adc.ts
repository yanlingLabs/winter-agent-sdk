// Phase 6 Task 6 (Lane B): Application Default Credentials for Vertex, in the two forms R6-A scopes.
//
//   `{ kind: "file", format: "gcp-service-account-json" }` -> material `gcp-service-account`
//        -> an RS256 JWT assertion -> a token exchange at the file's OWN `token_uri`
//        -> an access token, cached until it expires.
//   `{ kind: "gcp-access-token" }` -> the token, used as given.
//
// THERE IS NO THIRD LINK, and that is a scope decision rather than an omission: the metadata-server
// flow would make a credential lookup issue a request to `169.254.169.254`, which on a non-GCE host
// hangs until a timeout and on a GCE host silently succeeds with an instance identity nobody
// configured. `credentials/file.ts` records the identical ruling for the AWS chain.
//
// THE TOKEN ENDPOINT GETS ITS OWN ENDPOINT POLICY, and it must: `boundedFetch` refuses a first URL
// that is not on its policy's origin, and `token_uri` is a DIFFERENT HOST from the model endpoint.
// It is evaluated as a USER endpoint (`generated: false`) because it comes out of a credentials
// FILE -- reviewed by nobody -- so an https URL is required unless the connection declares itself
// local, which is what lets a loopback fake stand in for it under test and nothing else.
//
// NOTHING HERE LOGS, RETURNS OR THROWS A TOKEN. A failure names the status and the service-account's
// client email (a non-secret locator, exactly as `redactMaterial` treats it) and nothing more.
import { boundedFetch, ProviderRequestError } from "../../http.ts";
import { normalizeHttpError } from "../../errors.ts";
import { createEndpointPolicy } from "../../endpoint-policy.ts";
import type { CredentialMaterial } from "../../types.ts";
import { importRs256PrivateKey, signRs256Jwt } from "./jwt-rs256.ts";

/** The scope a Vertex generation needs. The one value; it is not configurable, so it cannot drift. */
export const GCP_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** How long an assertion is valid for. One hour is the maximum Google accepts. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/**
 * How early a cached token is considered expired.
 *
 * A token that expires WHILE a request is in flight fails the request, and the retry policy will not
 * replay a committed stream -- so the margin is generous on purpose.
 */
const EXPIRY_SKEW_MS = 60_000;

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

export interface AccessTokenSourceOptions {
  /** Injected in tests so a cache-expiry fixture never has to wait for real time. */
  now?: () => number;
  /** Declares the token endpoint local, so a loopback fake can stand in for it. Mirrors `ConnectionProfile.local`. */
  local?: boolean;
}

export interface AccessTokenSource {
  /** The bearer token to send. Cached until it expires; a cache miss performs the exchange. */
  token(signal?: AbortSignal): Promise<string>;
  /** Test/diagnostic seam: how many exchanges have actually been performed. NEVER exposes the token. */
  exchanges(): number;
}

/** A `gcp-access-token` ref: the host already holds a token, so there is nothing to exchange. */
export function createStaticAccessTokenSource(token: string): AccessTokenSource {
  return {
    async token(): Promise<string> {
      return token;
    },
    exchanges(): number {
      return 0;
    },
  };
}

/**
 * The service-account flow: sign an assertion, exchange it, cache the result until it expires.
 *
 * The KEY IS IMPORTED ONCE and the promise is memoised -- both because importing is not free and
 * because a concurrent burst of turns would otherwise import the same key many times over. The
 * imported `CryptoKey` is non-extractable (`importRs256PrivateKey` passes `false`), so even holding
 * it cannot re-export the PEM.
 */
export function createServiceAccountTokenSource(
  material: Extract<CredentialMaterial, { kind: "gcp-service-account" }>,
  opts: AccessTokenSourceOptions = {},
): AccessTokenSource {
  const now = opts.now ?? Date.now;
  let keyPromise: Promise<CryptoKey> | undefined;
  let cached: { token: string; expiresAtMs: number } | undefined;
  let exchanges = 0;

  const policy = (() => {
    const built = createEndpointPolicy(new URL(material.tokenUri).origin, { generated: false, ...(opts.local === true ? { local: true } : {}) });
    if (!built.ok) {
      // A refusal is raised at USE time, not construction time, so a badly-configured credential
      // fails the turn that needs it rather than the whole session start.
      return built.reason;
    }
    return built.policy;
  })();

  return {
    async token(signal?: AbortSignal): Promise<string> {
      const current = cached;
      if (current !== undefined && current.expiresAtMs - EXPIRY_SKEW_MS > now()) return current.token;
      if (typeof policy === "string") throw new ProviderRequestError({ code: "capability", message: `the service-account token endpoint is unusable: ${policy}`, retryable: false });

      keyPromise ??= importRs256PrivateKey(material.privateKeyPem);
      const key = await keyPromise;
      const issuedAt = Math.floor(now() / 1000);
      const assertion = await signRs256Jwt(
        { iss: material.clientEmail, scope: GCP_CLOUD_PLATFORM_SCOPE, aud: material.tokenUri, iat: issuedAt, exp: issuedAt + ASSERTION_LIFETIME_SECONDS },
        key,
      );

      exchanges++;
      const res = await boundedFetch(material.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
        maxBodyBytes: TOKEN_RESPONSE_MAX_BYTES,
        policy,
        ...(signal !== undefined ? { signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) {
        // `normalizeHttpError` already scrubs a credential-shaped body wholesale, and the message it
        // builds names the status and a bounded snippet -- never the assertion that was sent.
        const normalized = normalizeHttpError(res.status, res.headers, text);
        throw new ProviderRequestError({ ...normalized, message: `the service-account token exchange for ${material.clientEmail} failed: ${normalized.message}` });
      }
      let parsed: { access_token?: unknown; expires_in?: unknown };
      try {
        parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
      } catch {
        throw new ProviderRequestError({ code: "bad_request", message: `the service-account token exchange for ${material.clientEmail} returned a body that is not JSON`, retryable: false });
      }
      if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
        throw new ProviderRequestError({ code: "auth", message: `the service-account token exchange for ${material.clientEmail} returned no access token`, retryable: false });
      }
      // A missing or absurd `expires_in` is treated as ALREADY EXPIRED rather than defaulted to an
      // hour: caching a token whose lifetime nobody stated is how a fleet starts sending expired
      // credentials in unison.
      const expiresInSeconds = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0 ? parsed.expires_in : 0;
      cached = { token: parsed.access_token, expiresAtMs: now() + expiresInSeconds * 1000 };
      return parsed.access_token;
    },
    exchanges(): number {
      return exchanges;
    },
  };
}

/**
 * The material -> a token source.
 *
 * `undefined` for material this flow does not handle, so the caller can produce its own typed
 * refusal naming the kind -- a `null` here would be indistinguishable from "no credential".
 */
export function createAccessTokenSource(material: CredentialMaterial, opts: AccessTokenSourceOptions = {}): AccessTokenSource | undefined {
  if (material.kind === "gcp-service-account") return createServiceAccountTokenSource(material, opts);
  if (material.kind === "gcp-access-token") return createStaticAccessTokenSource(material.token);
  return undefined;
}
