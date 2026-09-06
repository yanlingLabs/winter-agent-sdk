// The refresh-token grant, shared by every Winter OAuth provider row.
//
// EXTRACTED FROM `openai/codex-oauth.ts`, whose `recover` hook did all of this inline. P6.5 adds two
// more OAuth rows (Anthropic Console, xAI) plus `qoder`, and three copies of "post the grant, merge
// the response over the old material, write it back" is three places the merge rule can be got
// wrong -- and getting it wrong is silent until the NEXT refresh fails.
//
// THE MERGE RULE IS THE WHOLE POINT, and it is the port's own hard-won finding: a refresh grant
// usually returns no id token and often does not rotate the refresh token, so a missing field must
// never clobber a known-good one. Writing back only what the response carried erases the refresh
// token and makes the record unrefreshable forever.
//
// THREE THINGS THIS FILE WILL NOT DO:
//
//   It never echoes the token endpoint's BODY. A rejected-grant body routinely quotes the grant it
//     rejected, so a message built from it would put a refresh token in a log the moment auth broke.
//     The error names the REF (a locator) and the HTTP status, and nothing else.
//
//   It never takes an injectable `fetch`. Every request goes through `boundedFetch` under an
//     endpoint policy built from the token URL's own origin, which is what stops a `Location` header
//     from replaying the grant to another host -- and the token endpoint is precisely where that
//     would be most valuable to an attacker. A fixture points `tokenUrl` at a loopback server
//     instead, which exercises the real transport rather than around it.
//
//   It never touches `Bun.secrets`. Persistence goes through the injected `CredentialStore`, so the
//     Keychain-backed store stays a runtime-side deliverable (R6-10) and a test can hand it an
//     in-memory one.

import { CredentialResolutionError, redactRef } from "../../credentials/types.ts";
import { createEndpointPolicy } from "../../endpoint-policy.ts";
import { boundedFetch } from "../../http.ts";
import type { CredentialMaterial, CredentialRef, CredentialStore } from "../../types.ts";

/** The oauth arm of `CredentialMaterial` — what a refresh reads, merges into, and writes back. */
export type OauthMaterial = Extract<CredentialMaterial, { kind: "oauth" }>;
/** Tokens live in ONE Keychain record per provider/account (R6-10), so a refresh is addressed by a keychain ref. */
export type KeychainRef = Extract<CredentialRef, { kind: "keychain" }>;

export interface RefreshOauthMaterialInput {
  store: CredentialStore;
  ref: KeychainRef;
  tokenUrl: string;
  clientId: string;
  /** Injectable clock, so a fixture can assert the exact `expiresAt` instead of a range. Defaults to `Date.now`. */
  now?: () => number;
  /** Extra form fields the vendor's flow requires — an honest identity field, for instance. Never a credential. */
  extraFields?: Record<string, string>;
}

/** `expires_in` is optional on the wire; an hour is the conventional default, and it is only ever a refresh-earlier hint. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Exchanges the record's refresh token for a fresh access token, PERSISTS the merged material, and
 * returns it.
 *
 * Failure modes, all typed `CredentialResolutionError` and all naming the ref rather than the token:
 * no record, a record that is not `oauth`, a record with no refresh token (refused BEFORE any
 * request — asking a vendor to refresh nothing is a pointless round trip that also tells them the
 * account exists), a non-2xx, an unparseable body, and a 200 that carries no access token. In every
 * failure the OLD material is left exactly as it was.
 */
export async function refreshOauthMaterial(input: RefreshOauthMaterialInput): Promise<OauthMaterial> {
  const { store, ref, tokenUrl, clientId } = input;
  const now = input.now ?? Date.now;
  const where = redactRef(ref);

  const existing = await store.get(ref);
  if (existing === null) throw new CredentialResolutionError("io", `oauth refresh for ${where} found no credential record to refresh`);
  if (existing.kind !== "oauth") throw new CredentialResolutionError("malformed", `oauth refresh for ${where} found ${existing.kind} material, which carries no refresh token`);
  if (existing.refreshToken === undefined || existing.refreshToken.length === 0) {
    throw new CredentialResolutionError("io", `oauth refresh for ${where} is impossible: the record holds no refresh token, so the login must be run again`);
  }

  const built = createEndpointPolicy(new URL(tokenUrl).origin, { generated: true });
  if (!built.ok) throw new CredentialResolutionError("io", `oauth refresh for ${where} cannot use its token endpoint: ${built.reason}`);

  const response = await boundedFetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: existing.refreshToken, ...(input.extraFields ?? {}) }).toString(),
    policy: built.policy,
    maxBodyBytes: 512 * 1024,
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    // Drained, never read into the message: a rejected-grant body quotes the grant it rejected.
    await response.text().catch(() => "");
    throw new CredentialResolutionError("io", `oauth refresh for ${where} failed with HTTP ${response.status}`);
  }

  let payload: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; expires_in?: unknown };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new CredentialResolutionError("malformed", `oauth refresh for ${where} returned a body that is not JSON`);
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new CredentialResolutionError("malformed", `oauth refresh for ${where} returned no access token`);
  }

  // THE MERGE. Spread the OLD material first: a field the response omits keeps the value that is
  // already known good, and only what the vendor actually rotated is replaced.
  const fresh: OauthMaterial = {
    ...existing,
    accessToken: payload.access_token,
    expiresAt: now() + (typeof payload.expires_in === "number" ? payload.expires_in : DEFAULT_EXPIRES_IN_SECONDS) * 1000,
    ...(typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? { refreshToken: payload.refresh_token } : {}),
    ...(typeof payload.id_token === "string" && payload.id_token.length > 0 ? { idToken: payload.id_token } : {}),
  };
  await store.set(ref, fresh);
  return fresh;
}
