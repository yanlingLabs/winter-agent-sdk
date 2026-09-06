// AWS Signature Version 4, hand-rolled over WebCrypto. Lane N (Task 9, R6-16).
//
// Global Constraints: zero new runtime dependencies. `@aws-sdk/signature-v4` would drag in the
// whole AWS SDK middleware stack — a Node-focused dependency tree that WS-13 §11's Bun-compat rule
// makes a proof obligation this phase refuses to take on. SigV4 is four hashes and four HMACs, so it
// is written here, with `crypto.subtle` doing the primitives.
//
// THE ALGORITHM, in the order it runs (AWS's own four steps):
//
//   1. CANONICAL REQUEST = method \n canonical URI \n canonical query \n canonical headers \n
//      signed headers \n hex(sha256(payload)).
//   2. STRING TO SIGN = "AWS4-HMAC-SHA256" \n amz-date \n credential scope \n hex(sha256(canonical
//      request)), where the scope is `<yyyymmdd>/<region>/<service>/aws4_request`.
//   3. SIGNING KEY = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") —
//      four chained HMACs, each keyed by the previous result.
//   4. AUTHORIZATION = `AWS4-HMAC-SHA256 Credential=<key>/<scope>, SignedHeaders=<a;b;c>,
//      Signature=<hex>`.
//
// TWO DETAILS THAT ARE EASY TO GET WRONG AND SILENT WHEN WRONG, both pinned by known-answer tests
// against a Python oracle in `sigv4.test.ts`:
//
//   THE CANONICAL URI IS DOUBLE-ENCODED. Every service except S3 requires each path segment to be
//     URI-encoded TWICE. That is invisible until a path contains a character needing escaping — and
//     every Bedrock model id does: `anthropic.claude-3-5-sonnet-20241022-v2:0` carries a colon, so
//     the URL path holds `...v2%3A0` and the canonical URI holds `...v2%253A0`. Sign the once-encoded
//     form and every request 403s with a signature mismatch that names nothing useful.
//
//   `host` IS SIGNED BUT NEVER SET. `fetch` owns the `Host` header (it is a forbidden header name),
//     so the signer computes the value from the URL and includes it in the canonical headers without
//     attaching it. It must therefore be `url.host` and NOT `url.hostname`: they differ exactly when
//     a port is non-default, which is every loopback fake in this repo — so `hostname` would pass
//     against real AWS and fail every conformance fixture, or vice versa.

/** The signing algorithm's own name, as it appears in the string-to-sign and the Authorization header. */
export const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

/** The AWS service name Bedrock signs under — both the runtime and control planes use it. */
export const BEDROCK_SERVICE = "bedrock";

/** The AWS credential material a signature needs. A structural mirror of `CredentialMaterial`'s `aws` arm, so this module stays free of the credential types. */
export interface AwsSigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequestInput {
  method: string;
  /** The ABSOLUTE request URL, path already once-encoded (the canonical form encodes it again). */
  url: string;
  /** Headers to sign ALONGSIDE the derived ones. `host`, `x-amz-date`, `x-amz-content-sha256` and `x-amz-security-token` are added here and must not be passed in. */
  headers: Record<string, string>;
  /** The exact request body bytes, or empty for a GET. Hashed verbatim — a re-serialization would sign a different payload than the one sent. */
  body: Uint8Array;
  credentials: AwsSigningCredentials;
  region: string;
  service?: string;
  /** Injected so a fixture can pin a signature. Defaults to now. */
  date?: Date;
}

/**
 * RFC 3986 percent-encoding with AWS's unreserved set: `A-Za-z0-9` plus `-`, `_`, `.` and `~`.
 *
 * DELIBERATELY STRICTER THAN `encodeURIComponent`, which leaves `!*'()` alone. AWS's own SDKs use
 * `encodeURIComponent` for the path, so the two disagree on those five characters — a discrepancy
 * that is unreachable for Bedrock (a model id matches `[a-zA-Z0-9-:.]+`, and an ARN adds only `/`
 * and `:`), and the spec's reading is the safer one to be wrong in the direction of. Recorded here
 * rather than left as a silent choice.
 */
export function awsUriEncode(value: string, encodeSlash: boolean): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || char === "-" || char === "_" || char === "." || char === "~") {
      out += char;
    } else if (char === "/" && !encodeSlash) {
      out += "/";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * The canonical URI: the path, normalized then encoded a SECOND time (see the file header).
 *
 * `%2F` is restored to `/` after the whole path is encoded, which is what makes the separators
 * survive an encoding pass that would otherwise escape them — the same manoeuvre the AWS SDKs use.
 */
export function canonicalUri(pathname: string): string {
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `${pathname.startsWith("/") ? "/" : ""}${segments.join("/")}${segments.length > 0 && pathname.endsWith("/") ? "/" : ""}`;
  if (normalized.length === 0) return "/";
  return awsUriEncode(normalized, true).replace(/%2F/g, "/");
}

/** The canonical query string: every parameter encoded once, then sorted by name and, within a name, by value. */
export function canonicalQuery(search: string): string {
  const params = new URLSearchParams(search);
  const pairs: Array<[string, string]> = [];
  params.forEach((value, name) => {
    pairs.push([awsUriEncode(name, true), awsUriEncode(value, true)]);
  });
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * The canonical headers block and the signed-headers list.
 *
 * Names are lowercased and sorted; values are trimmed and their internal runs of whitespace
 * collapsed to a single space (AWS's own rule, and the reason a header value with a stray double
 * space still verifies).
 *
 * NAMES ARE DE-DUPLICATED AFTER LOWERCASING, and that is a latent-bug fix rather than a live one
 * (Lane N r1 carry). Every caller today hands this a map whose keys are already lowercase, so the
 * two spellings cannot both be present — but nothing in the signature *type* says so, and a future
 * caller passing `{ "X-Amz-Date": …, "x-amz-date": … }` would have produced `x-amz-date` TWICE in
 * both the canonical block and `SignedHeaders`. AWS would reject that with an
 * `InvalidSignatureException` whose text is about the signature, not about a duplicate header, so
 * the failure would read as a broken signer. `byLower` already collapsed the VALUES; only the name
 * list did not.
 */
export function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
  const names = [...new Set(Object.keys(headers).map((n) => n.toLowerCase()))].sort();
  const byLower = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonical = names.map((name) => `${name}:${(byLower.get(name) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  return { canonical, signed: names.join(";") };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `.slice()` gives a plain ArrayBuffer even for a Uint8Array that views part of a larger buffer;
  // handing `crypto.subtle` the whole underlying buffer would hash bytes the caller never passed.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key.slice().buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message)));
}

/** The four chained HMACs of step 3. Derived per request rather than cached: the key is scoped to a DATE, and a cache would need invalidating at midnight UTC for no measurable gain. */
export async function signingKey(secretAccessKey: string, datestamp: string, region: string, service: string): Promise<Uint8Array> {
  let key = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), datestamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  return await hmac(key, "aws4_request");
}

/** `YYYYMMDDTHHMMSSZ` — an ISO instant with every separator removed, which is the only form the header accepts. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export interface CanonicalRequestInput {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  payloadHash: string;
}

/** Step 1, exported whole so a fixture and the conformance fake can both assert on the exact string a signature was computed over. */
export function buildCanonicalRequest(input: CanonicalRequestInput): { canonicalRequest: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(input.headers);
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri(input.pathname), canonicalQuery(input.search), canonical, signed, input.payloadHash].join("\n");
  return { canonicalRequest, signedHeaders: signed };
}

/** Step 2, exported so a fixture can assert the exact string a signature was taken over — and so a verifier rebuilds it rather than re-deriving it differently. */
export async function buildStringToSign(canonicalRequest: string, stamp: string, scope: string): Promise<string> {
  return [SIGV4_ALGORITHM, stamp, scope, await sha256Hex(new TextEncoder().encode(canonicalRequest))].join("\n");
}

/** Steps 3 and 4's hash: the signing key, then one HMAC over the string-to-sign, hex-encoded. */
export async function computeSignature(secretAccessKey: string, datestamp: string, region: string, service: string, stringToSign: string): Promise<string> {
  return toHex(await hmac(await signingKey(secretAccessKey, datestamp, region, service), stringToSign));
}

export interface SignedRequest {
  /** The headers to ADD to the request. `host` is deliberately absent — it is signed but never set (see the file header). */
  headers: Record<string, string>;
  /** Exposed for fixtures and for the fake's recomputation; never logged. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
}

/**
 * Signs a request, returning the headers to attach.
 *
 * `x-amz-content-sha256` is ALWAYS sent, not only where a service requires it: it is what lets a
 * verifier (real AWS, or this repo's fake) check that the payload it received is the payload that
 * was signed, rather than only that the two agree about the headers.
 */
export async function signRequest(input: SignRequestInput): Promise<SignedRequest> {
  const url = new URL(input.url);
  const service = input.service ?? BEDROCK_SERVICE;
  const date = input.date ?? new Date();
  const stamp = amzDate(date);
  const datestamp = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(input.body);

  // `url.host`, NOT `url.hostname` — see the file header. The port is part of the signed value
  // whenever it is non-default.
  const toSign: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": stamp,
    "x-amz-content-sha256": payloadHash,
    ...(input.credentials.sessionToken !== undefined ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
  };

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: input.method,
    pathname: url.pathname,
    search: url.search,
    headers: toSign,
    payloadHash,
  });

  const scope = `${datestamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = await buildStringToSign(canonicalRequest, stamp, scope);
  const signature = await computeSignature(input.credentials.secretAccessKey, datestamp, input.region, service, stringToSign);

  return {
    headers: {
      "x-amz-date": stamp,
      "x-amz-content-sha256": payloadHash,
      ...(input.credentials.sessionToken !== undefined ? { "x-amz-security-token": input.credentials.sessionToken } : {}),
      authorization: `${SIGV4_ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
  };
}

export interface ParsedAuthorization {
  accessKeyId: string;
  datestamp: string;
  region: string;
  service: string;
  signedHeaders: string[];
  signature: string;
}

/**
 * Parses an `Authorization` header back into its parts.
 *
 * Exists so a VERIFIER can rebuild the canonical request from what the wire actually carried — the
 * signed-header list included — rather than from what the signer intended to send. That distinction
 * is the whole value of the conformance fake's signature check: a verifier that re-derived the
 * signed-header set from its own idea of the request would agree with a buggy signer about a header
 * neither of them included.
 */
export function parseAuthorization(header: string | null | undefined): ParsedAuthorization | undefined {
  if (header === null || header === undefined) return undefined;
  if (!header.startsWith(`${SIGV4_ALGORITHM} `)) return undefined;
  const parts = new Map<string, string>();
  for (const chunk of header.slice(SIGV4_ALGORITHM.length + 1).split(",")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    parts.set(chunk.slice(0, eq).trim(), chunk.slice(eq + 1).trim());
  }
  const credential = parts.get("Credential");
  const signedHeaders = parts.get("SignedHeaders");
  const signature = parts.get("Signature");
  if (credential === undefined || signedHeaders === undefined || signature === undefined) return undefined;
  const [accessKeyId, datestamp, region, service, terminator] = credential.split("/");
  if (accessKeyId === undefined || datestamp === undefined || region === undefined || service === undefined || terminator !== "aws4_request") return undefined;
  return { accessKeyId, datestamp, region, service, signedHeaders: signedHeaders.split(";"), signature };
}
