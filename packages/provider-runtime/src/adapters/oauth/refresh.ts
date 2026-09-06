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
import { winterUserAgent } from "../../identity.ts";
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
  /** Extra body fields the vendor's flow requires — an honest identity field, for instance. Never a credential. */
  extraFields?: Record<string, string>;
  /**
   * The grant's body encoding. Defaults to `"form"`.
   *
   * P6.5 ruling R-A2-1, "artifact wins": RFC 6749 §4.1.3 requires a token endpoint to ACCEPT
   * `application/x-www-form-urlencoded`, and every Winter flow posted that — but the Anthropic
   * Console endpoint is only ever OBSERVED receiving `application/json`, and an unobserved encoding
   * that turns out to be rejected breaks that flow completely rather than partially. So the
   * encoding is a per-flow fact rather than a constant. The default keeps codex byte-identical.
   */
  bodyEncoding?: "form" | "json";
}

/** `expires_in` is optional on the wire; an hour is the conventional default, and it is only ever a refresh-earlier hint. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Refreshes ALREADY RUNNING for a given record, so concurrent callers share one grant.
 *
 * P6.5 ruling R-A2-3, and it is a correctness fix rather than an optimisation. A single turn reaches
 * `buildHeaders` from three places (`streamTurn`, `countTokens`, `validateCredential`), and any two
 * of them inside the 60 s freshness window used to fire two independent refreshes with the SAME
 * refresh token. Against a server that rotates refresh tokens that is not merely wasteful: RFC 9700
 * §4.14 has an authorization server treat a replayed refresh token as evidence of theft and revoke
 * the whole token family — so the second call could log the user out. The loser's `store.set` would
 * also clobber the winner's newer material.
 *
 * KEYED ON THE RECORD **AND** THE TOKEN URL: two flows pointed at different endpoints are different
 * grants even for the same account, and sharing a promise between them would hand one flow the
 * other's tokens. `\u0000` separates the parts because it cannot occur in either.
 *
 * The entry is removed in a `finally`, so a FAILED refresh is never cached — the next caller retries
 * rather than inheriting a rejection forever.
 */
const inFlightRefreshes = new Map<string, Promise<OauthMaterial>>();

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
export function refreshOauthMaterial(input: RefreshOauthMaterialInput): Promise<OauthMaterial> {
  const key = `${input.ref.service ?? ""}\u0000${input.ref.account}\u0000${input.tokenUrl}`;
  const running = inFlightRefreshes.get(key);
  if (running !== undefined) return running;
  const pending = performRefresh(input).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, pending);
  return pending;
}

async function performRefresh(input: RefreshOauthMaterialInput): Promise<OauthMaterial> {
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

  const fields = { grant_type: "refresh_token", client_id: clientId, refresh_token: existing.refreshToken, ...(input.extraFields ?? {}) };
  const asJson = input.bodyEncoding === "json";
  const response = await boundedFetch(tokenUrl, {
    method: "POST",
    // WS-13b: a token endpoint is a vendor request like any other, so Winter names itself here too.
    // Lanes A2/O build their flows on this helper; an identity that stopped at the chat endpoint
    // would leave every OAuth row anonymous on the one request that renews its credential.
    headers: { "content-type": asJson ? "application/json" : "application/x-www-form-urlencoded", accept: "application/json", "user-agent": winterUserAgent() },
    body: asJson ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
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
