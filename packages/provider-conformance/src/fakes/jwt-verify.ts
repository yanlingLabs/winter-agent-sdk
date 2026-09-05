// Phase 6 Task 6 (Lane B): RS256 JWT VERIFICATION — test support for the Vertex fake.
//
// It lives here rather than in `provider-runtime` (Minor 6) because nothing in the shipped path
// verifies a JWT: Winter SIGNS assertions and Google verifies them. The only caller is the loopback
// token endpoint, which has to check a signature for "the adapter authenticated correctly" to be
// something a test knows rather than something a comment asserts — so the verifier belongs beside
// that fake, in this lane's own directory, and a runtime package carries no code whose sole consumer
// is a test.
//
// The ALGORITHM PARAMETERS are imported from the signer rather than restated, so the two halves of
// the round trip cannot drift apart.
import { RS256 } from "../../../provider-runtime/src/adapters/google/jwt-rs256.ts";

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
