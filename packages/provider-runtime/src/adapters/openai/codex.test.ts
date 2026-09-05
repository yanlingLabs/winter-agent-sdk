// The codex port's own rules: the constants that must not drift, PKCE's encodings, and the quota
// manager R6-B makes the sole producer of `rate_limit`.
//
// The live half — the refresh actually re-sending with a NEW bearer, the privileged headers on the
// wire, the subscription event arriving before the retry it describes — is in the conformance
// package against a loopback fake.

import { describe, expect, test } from "bun:test";
import { CODEX, CODEX_MODELS, CODEX_MODELS_VERIFIED, CODEX_ORIGINATOR, DEFAULT_CODEX_MODEL, codexCredentialAccount } from "./codex-config.ts";
import { base64Url, buildAuthorizeUrl, decodeAccountId, generatePkce } from "./pkce.ts";
import { QuotaManager, quotaEvent } from "./quota.ts";
import { codexCredentialRef } from "./codex-oauth.ts";

describe("codex constants: the parity set, and the one deliberate divergence", () => {
  test("`originator` is `winter` — NEVER a first-party value", () => {
    // WS-01 §3's hard rule, carried from Norma. Winter is an independent client and says so rather
    // than impersonating OpenAI's own CLI to obtain first-party treatment. If this assertion ever
    // fails, read `codex-config.ts`'s header before changing it.
    expect(CODEX.headers.originator).toBe("winter");
    expect(CODEX_ORIGINATOR).toBe("winter");
    expect(CODEX.headers.originator).not.toBe("codex_cli_rs");
  });

  test("the codex-rs parity constants are carried verbatim", () => {
    expect(CODEX.clientId).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(CODEX.authorizeUrl).toBe("https://auth.openai.com/oauth/authorize");
    expect(CODEX.tokenUrl).toBe("https://auth.openai.com/oauth/token");
    expect(CODEX.backendUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(CODEX.callbackPort).toBe(1455);
    expect(CODEX.fallbackCallbackPort).toBe(1457);
    expect(CODEX.scope).toBe("openid profile email offline_access api.connectors.read api.connectors.invoke");
    expect(CODEX.headers["OpenAI-Beta"]).toBe("responses=experimental");
  });

  test("every model reports the same 272000 context window, and the set is dated", () => {
    // The number was hand-transcribed WRONG once (372000), which put an auto-compaction threshold
    // above the backend's own ceiling and killed compaction silently. Re-derive it; never edit it.
    for (const model of CODEX_MODELS) expect(model.contextWindow).toBe(272_000);
    expect(CODEX_MODELS.map((m) => m.id)).toContain(DEFAULT_CODEX_MODEL);
    expect(CODEX_MODELS_VERIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("a credential occupies one record per ACCOUNT (R6-10), never a shared slot", () => {
    expect(codexCredentialAccount("acct-1")).toBe("codex-oauth:acct-1");
    expect(codexCredentialRef("acct-1")).toEqual({ kind: "keychain", account: "codex-oauth:acct-1" });
    expect(codexCredentialRef("acct-1", "com.winter.core.dev")).toEqual({ kind: "keychain", account: "codex-oauth:acct-1", service: "com.winter.core.dev" });
  });
});

describe("PKCE", () => {
  test("base64url matches the platform's own encoding, minus padding", () => {
    for (const sample of ["", "a", "ab", "abc", "abcd", "hello world!", "\u0000\u00ff\u00fe"]) {
      const bytes = new TextEncoder().encode(sample);
      const expected = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(base64Url(bytes)).toBe(expected);
    }
  });

  test("a verifier is inside RFC 7636's 43-128 range and the challenge is its S256 digest", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(challenge).toBe(base64Url(new Uint8Array(digest)));
    // Two calls never agree: the verifier is the whole security of the exchange.
    const again = await generatePkce();
    expect(again.verifier).not.toBe(verifier);
  });

  test("the account id is read out of the id token's own claim, and a malformed token yields nothing", () => {
    const payload = btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-xyz" } }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeAccountId(`header.${payload}.sig`)).toBe("acct-xyz");
    expect(decodeAccountId("not-a-jwt")).toBeUndefined();
    expect(decodeAccountId("a.!!!!.c")).toBeUndefined();
    expect(decodeAccountId(`header.${btoa(JSON.stringify({ sub: "u" }))}.sig`)).toBeUndefined();
  });

  test("the authorize URL carries S256 and the state, and never the verifier", () => {
    const url = new URL(buildAuthorizeUrl({ authorizeUrl: CODEX.authorizeUrl, clientId: CODEX.clientId, redirectUri: "http://localhost:1455/auth/callback", scope: CODEX.scope, state: "st", challenge: "ch" }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.toString()).not.toContain("code_verifier");
  });
});

describe("the quota manager: R6-B's sole producer of `rate_limit`", () => {
  test("a limit window becomes a SUBSCRIPTION-shaped event, never an HTTP one", () => {
    let now = 1_000_000;
    const quota = new QuotaManager({ now: () => now });
    expect(quota.state()).toEqual({ kind: "ok" });
    quota.noteRateLimit(30_000);
    const state = quota.state();
    expect(state).toEqual({ kind: "limited", resumeAt: 1_030_000 });
    const event = quotaEvent(state);
    expect(event.kind).toBe("subscription-quota");
    // Only fields the pin actually declares. Inventing a `rateLimitType` would claim to know WHICH
    // window was hit, and a 429 does not say.
    expect(event.info).toEqual({ status: "rejected", resetsAt: 1030 });
    now = 1_040_000;
    expect(quota.state()).toEqual({ kind: "ok" });
  });

  test("a 429 with NO Retry-After is limited with NO resetsAt — never a resume time nobody stated", () => {
    // Finding I1. This previously read `ok` (a zero-length window), which is why the event could go
    // out saying `allowed` ON a rate limit; and it was asserted against a hand-built
    // `{kind:"limited", resumeAt:0}` the manager could never actually produce.
    const quota = new QuotaManager({ now: () => 5_000 });
    quota.noteRateLimit(undefined);
    expect(quota.state()).toEqual({ kind: "limited" });
    const event = quotaEvent(quota.state());
    expect(event.info).toEqual({ status: "rejected" });
    expect("resetsAt" in event.info).toBe(false);
  });

  test("a window-unknown limit does NOT lapse on its own, and `waitIfLimited` has nothing to wait for", async () => {
    let now = 0;
    const quota = new QuotaManager({ now: () => now });
    quota.noteRateLimit(undefined);
    now = 10_000_000;
    // Nothing said it resumed, so nothing pretends it did.
    expect(quota.state()).toEqual({ kind: "limited" });
    const started = Date.now();
    await quota.waitIfLimited();
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("`hasPendingLimit` survives the window elapsing, which is what makes the recovery event reachable", () => {
    // Finding I2: `state()` reads `ok` once a KNOWN window has passed — and by the time a retried
    // turn completes, the backoff has slept exactly that window. Reading `state()` there silently
    // turned "was this turn rate-limited?" into "no".
    let now = 0;
    const quota = new QuotaManager({ now: () => now });
    quota.noteRateLimit(2_000);
    expect(quota.hasPendingLimit()).toBe(true);
    now = 5_000;
    expect(quota.state()).toEqual({ kind: "ok" });
    expect(quota.hasPendingLimit()).toBe(true);
    quota.noteRecovered();
    expect(quota.hasPendingLimit()).toBe(false);
  });

  test("recovery notifies only when the state actually changed", () => {
    const seen: string[] = [];
    const quota = new QuotaManager();
    quota.onStateChange((s) => seen.push(s.kind));
    quota.noteRecovered();
    expect(seen).toEqual([]);
    quota.noteRateLimit(10_000);
    quota.noteRecovered();
    expect(seen).toEqual(["limited", "ok"]);
  });

  test("a later, SHORTER window never shortens a longer one already recorded", () => {
    let now = 0;
    const quota = new QuotaManager({ now: () => now });
    quota.noteRateLimit(60_000);
    quota.noteRateLimit(1_000);
    expect(quota.state()).toEqual({ kind: "limited", resumeAt: 60_000 });
  });

  test("a headerless refusal after a KNOWN window keeps the window it already had", () => {
    let now = 0;
    const quota = new QuotaManager({ now: () => now });
    quota.noteRateLimit(30_000);
    quota.noteRateLimit(undefined);
    expect(quota.state()).toEqual({ kind: "limited", resumeAt: 30_000 });
  });

  test("the concurrency cap admits exactly `maxConcurrent`, and a release admits the next waiter", async () => {
    const quota = new QuotaManager({ maxConcurrent: 2 });
    await quota.acquire();
    await quota.acquire();
    let third = false;
    const pending = quota.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    quota.release();
    await pending;
    expect(third).toBe(true);
  });

  test("usage accumulates across turns", () => {
    const quota = new QuotaManager();
    quota.accumulate(10, 3);
    quota.accumulate(5, 1);
    expect(quota.usage()).toEqual({ inputTokens: 15, outputTokens: 4 });
  });

  test("`waitIfLimited` returns immediately on an already-aborted signal", async () => {
    const quota = new QuotaManager({ now: () => 0 });
    quota.noteRateLimit(60_000);
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await quota.waitIfLimited(controller.signal);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
