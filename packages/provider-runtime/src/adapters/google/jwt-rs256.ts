// Phase 6 Task 6 (Lane B): RS256 JWT signing over WebCrypto, for the Vertex service-account flow.
//
// ZERO NEW DEPENDENCIES (Global Constraints). Everything here is `crypto.subtle` plus base64 --
// about eighty lines against a signing library that would be one more Bun-compat proof obligation
// this phase explicitly refuses to take on (WS-13 §11).
//
// THE ONE SECURITY RULE THIS FILE ENFORCES, stated first because every function below is shaped by
// it: **no error message, no log line and no return value ever contains key material.** A PEM parse
// failure names the BLOCK TYPE it found and nothing else; an import failure names the algorithm. The
// obvious-looking alternative -- echoing the offending text so a user can see what went wrong -- is
// echoing a private key into whatever catches the error, which for an SDK is a log file.
//
// PKCS#8 ONLY, deliberately. `crypto.subtle.importKey` accepts no other private-key format, and a
// service-account JSON's `private_key` is always a PKCS#8 `-----BEGIN PRIVATE KEY-----` block. A
// PKCS#1 `BEGIN RSA PRIVATE KEY` block is rejected with a message that says which format was found,
// because "importKey failed" on its own is unactionable.

/** The signing algorithm, in the one spelling `importKey`/`sign` both accept. */
const RS256: RsaHashedImportParams = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

/** Raised when a PEM cannot be read or a key cannot be imported. Its message NEVER contains key material. */
export class JwtKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtKeyError";
  }
}

/** base64url, no padding -- the only encoding a JWT uses. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  // A chunked loop rather than `String.fromCharCode(...bytes)`: a 256-byte signature is fine as a
  // spread, but the same helper encodes the header and payload, and a spread over a long payload is
  // a stack-overflow waiting for a big enough claim set.
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

export function base64UrlDecodeText(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function base64UrlDecodeBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The DER bytes of a PKCS#8 PEM block.
 *
 * The block TYPE is checked explicitly so a PKCS#1 key (`BEGIN RSA PRIVATE KEY`, which openssl still
 * emits by default) produces a message that says what to convert rather than an opaque WebCrypto
 * `DataError`.
 */
export function pkcs8DerFromPem(pem: string): Uint8Array {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (match === null) throw new JwtKeyError("the service-account private key is not a PEM block (no BEGIN/END markers were found)");
  const label = match[1]!;
  if (label !== "PRIVATE KEY") {
    throw new JwtKeyError(`the service-account private key is a "${label}" PEM block; RS256 signing needs a PKCS#8 "PRIVATE KEY" block`);
  }
  const body = match[2]!.replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    // The offending text is a private key. Only the fact survives.
    throw new JwtKeyError("the service-account private key's PEM body is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Imports a PKCS#8 PEM as an RS256 signing key. */
export async function importRs256PrivateKey(pem: string): Promise<CryptoKey> {
  const der = pkcs8DerFromPem(pem);
  try {
    // `der.buffer` would hand over the WHOLE backing store when the view is a slice; `.slice()`
    // copies exactly the key's own bytes, which is both correct and one fewer thing to reason about.
    return await crypto.subtle.importKey("pkcs8", der.slice().buffer as ArrayBuffer, RS256, false, ["sign"]);
  } catch {
    throw new JwtKeyError("the service-account private key could not be imported as an RSASSA-PKCS1-v1_5 / SHA-256 key");
  }
}

/** The claims a Google service-account assertion carries. `iat`/`exp` are seconds since the epoch, as the spec requires. */
export interface ServiceAccountJwtClaims {
  iss: string;
  scope: string;
  aud: string;
  iat: number;
  exp: number;
  /** Domain-wide delegation. Omitted for an ordinary service account. */
  sub?: string;
}

/** Signs `{header}.{payload}` and returns the compact JWT. */
export async function signRs256Jwt(claims: ServiceAccountJwtClaims, key: CryptoKey): Promise<string> {
  const header = base64UrlEncodeText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncodeText(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(RS256.name, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verifies a compact RS256 JWT against a public key and returns its claims.
 *
 * Exported for the LOOPBACK FAKE, which is the whole point: a fake that accepted any assertion would
 * make "the adapter authenticated correctly" untestable, and the only way to check a signature is to
 * check it. Nothing in the shipped path calls this.
 */
export async function verifyRs256Jwt(jwt: string, publicKey: CryptoKey): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown> } | undefined> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  const [header, payload, signature] = parts as [string, string, string];
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(RS256.name, publicKey, base64UrlDecodeBytes(signature).slice().buffer as ArrayBuffer, new TextEncoder().encode(`${header}.${payload}`));
  } catch {
    return undefined;
  }
  if (!ok) return undefined;
  try {
    return { header: JSON.parse(base64UrlDecodeText(header)) as Record<string, unknown>, claims: JSON.parse(base64UrlDecodeText(payload)) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}
