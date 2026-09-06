// `xai-oauth` — the second OAuth row Winter ships, and the only one admitted on vendor CONDUCT
// rather than vendor documentation (audit §2.5, prong 2).
//
// Three things are under test here and each guards a different failure:
//
//   1. THE CONSTANTS ARE THE ARTIFACT'S. Asserted across a module boundary against
//      `xai-derived-shapes.ts`, the transcription of the pinned capture — so editing the shipped
//      client id, scope set or identity field without re-deriving them fails here.
//   2. THE IDENTITY IS SENT, EVERYWHERE, AND IT IS WINTER'S. Read off the LIVE REQUESTS a loopback
//      fake received, never off the config object that produced them.
//   3. THE REVERSION CONDITION IS EXECUTABLE. Not a comment: a test that drives the "vendor rejects
//      an honest unregistered identity" case and pins the message a human would have to read.
import { describe, expect, test } from "bun:test";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import { DERIVED_XAI } from "./xai-derived-shapes.ts";
import { XAI_CONSENT_DISCLOSURE, XAI_OAUTH, createXaiOauthAdapter, startXaiLogin, xaiCredentialRef } from "./xai-oauth.ts";
import { REFRESHED_ACCESS_TOKEN, startXaiChatFake, startXaiOauthFake } from "./xai-oauth.testing.ts";
import { testContext } from "./testing.ts";

describe("xai-oauth (WS-13b §4, prong 2)", () => {
  test("constants are the pinned public client's", () => {
    expect(XAI_OAUTH.clientId).toBe(DERIVED_XAI.clientId);
    expect(XAI_OAUTH.scope).toBe(DERIVED_XAI.scope);
    expect(XAI_OAUTH.identityField).toBe(DERIVED_XAI.identityField);
  });

  test("the device login persists oauth material under xai-oauth:<accountId> and sends Winter's identity on every request", async () => {
    const fake = await startXaiOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const r = await startXaiLogin(store, { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5, onAuthStatus: () => {} });
      expect(r.ref).toEqual({ kind: "keychain", account: "xai-oauth:acct-x" });
      for (const req of fake.requests) expect(new URLSearchParams(req.body).get(XAI_OAUTH.identityField)).toBe("winter-agent-sdk");
      for (const req of fake.requests) expect(req.headers["user-agent"]).toMatch(/^winter-agent-sdk\//);
    } finally {
      await fake.close();
    }
  });

  test("REVERSION CONDITION (WS-13b §4): an honest unregistered agent identity that the vendor rejects is a partner allowlist in fact", async () => {
    const fake = await startXaiOauthFake({ rejectIdentity: "winter-agent-sdk" });
    try {
      const err = await startXaiLogin(createMemoryCredentialStore(), { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5, onAuthStatus: () => {} }).catch((e: unknown) => e);
      expect((err as Error).message).toContain("reversion condition");
      expect((err as Error).message).toContain("WS-13b §4");
    } finally {
      await fake.close();
    }
  });

  // --- what the three above would still let through ------------------------------------------------

  test("the login persists the material itself, not just a ref — and the record holds a refresh token so the session can outlive the first hour", async () => {
    const fake = await startXaiOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const r = await startXaiLogin(store, { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5 });
      const material = await store.get(r.ref);
      expect(material?.kind).toBe("oauth");
      // Narrowed rather than cast: an `api-key` material would satisfy a bare `?.kind` read.
      if (material?.kind !== "oauth") throw new Error("expected oauth material");
      expect(material.accessToken.length).toBeGreaterThan(0);
      expect(material.refreshToken).toBeDefined();
      expect(material.accountId).toBe("acct-x");
      expect(r.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await fake.close();
    }
  });

  test("NONE of the vendor's six product-identity headers is sent on the LOGIN path (WS-13 §5) — Winter authors its own", async () => {
    const fake = await startXaiOauthFake();
    try {
      await startXaiLogin(createMemoryCredentialStore(), { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5 });
      expect(fake.requests.length).toBeGreaterThan(0);
      // The list is the capture's, not a hand-copy — six today, and a seventh added there is
      // asserted here without touching this file.
      expect(DERIVED_XAI.vendorOnlyHeaders.length).toBe(6);
      for (const req of fake.requests) {
        for (const banned of DERIVED_XAI.vendorOnlyHeaders) expect(req.headers[banned]).toBeUndefined();
        // The negative that actually bites: the vendor's user-agent shape, and its identity VALUE.
        expect(req.headers["user-agent"]).not.toMatch(/grok/i);
        expect(new URLSearchParams(req.body).get(XAI_OAUTH.identityField)).not.toBe(DERIVED_XAI.vendorIdentityValue);
      }
    } finally {
      await fake.close();
    }
  });

  test("the identity field rides the POLLS too, not only the device request — a flow honest exactly once is not honest", async () => {
    // The vendor's own client sends `referrer` only on the device request (capture §3.2). Winter
    // sends it on every request, deliberately; this pins the superset rather than the artifact.
    const fake = await startXaiOauthFake({ pendingPolls: 2 });
    try {
      await startXaiLogin(createMemoryCredentialStore(), { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5 });
      const polls = fake.requests.filter((r) => r.path === "/oauth2/token");
      expect(polls.length).toBe(3);
      for (const req of polls) expect(new URLSearchParams(req.body).get(XAI_OAUTH.identityField)).toBe("winter-agent-sdk");
    } finally {
      await fake.close();
    }
  });

  test("a device flow that fails for an ORDINARY reason does NOT claim the reversion condition", async () => {
    // Without this, the reversion test above passes on an implementation that stamps the message
    // onto every failure — and the row's most important signal becomes noise.
    const fake = await startXaiOauthFake({ tokenError: "expired_token" });
    try {
      const err = await startXaiLogin(createMemoryCredentialStore(), { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("reversion condition");
      expect((err as Error).message).toContain("expired_token");
    } finally {
      await fake.close();
    }
  });

  test("the reversion error names the OTHER reading too — a user pressing Deny is wire-identical to a vendor allowlist", async () => {
    const fake = await startXaiOauthFake({ rejectIdentity: "winter-agent-sdk" });
    try {
      const err = await startXaiLogin(createMemoryCredentialStore(), { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5 }).catch((e: unknown) => e);
      const message = (err as Error).message;
      // `access_denied` carries both meanings on the wire and the message must not pick one silently.
      expect(message).toMatch(/denied|declined/i);
      expect(message).toContain("access_denied");
      expect(message).toMatch(/settings|providers\["?xai-oauth"?\]|disable/i);
    } finally {
      await fake.close();
    }
  });

  test("the credential ref is one record per account (R6-10), and the host's keychain service rides it", () => {
    expect(xaiCredentialRef("acct-x")).toEqual({ kind: "keychain", account: "xai-oauth:acct-x" });
    expect(xaiCredentialRef("acct-x", "com.winter.core.dev")).toEqual({ kind: "keychain", account: "xai-oauth:acct-x", service: "com.winter.core.dev" });
  });

  test("a token exchange that returns no account id is a refusal, not a shared default slot (R6-10)", async () => {
    const fake = await startXaiOauthFake({ omitIdToken: true });
    try {
      const err = await startXaiLogin(createMemoryCredentialStore(), { deviceCodeUrl: fake.deviceCodeUrl, tokenUrl: fake.tokenUrl, pollIntervalMs: 5 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("account");
    } finally {
      await fake.close();
    }
  });

  test("the consent disclosure tells the user the vendor's page may name someone else, and names Winter", () => {
    // Audit §2.5's disclosure note: the flow rides xAI's shared client, so the consent screen may
    // show the vendor's product. Not impersonation, but a misattribution a host must surface.
    expect(XAI_CONSENT_DISCLOSURE).toContain("Grok Build");
    expect(XAI_CONSENT_DISCLOSURE).toContain("winter-agent-sdk");
  });

  // --- the refresh half of the credential's life ---------------------------------------------------

  test("a turn on a NEARLY-EXPIRED token refreshes it first, persists the new one, and names Winter on the refresh form too", async () => {
    const fake = await startXaiOauthFake();
    try {
      const ref = xaiCredentialRef("acct-x");
      const store = createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: "test-token-xai-access", refreshToken: "test-token-xai-refresh", accountId: "acct-x", expiresAt: Date.now() + 5_000 }]]);
      const chat = await startXaiChatFake();
      try {
        const adapter = createXaiOauthAdapter({ generatedBaseUrl: chat.url, tokenUrl: fake.tokenUrl, descriptors: () => undefined });
        const events: string[] = [];
        for await (const e of adapter.streamTurn({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }] }, { ...testContext({ providerId: "xai-oauth" }), credentials: store, authRef: ref })) events.push(e.type);
        expect(events).not.toContain("error");

        const material = await store.get(ref);
        if (material?.kind !== "oauth") throw new Error("expected oauth material");
        expect(material.accessToken).toBe("test-token-xai-access-refreshed");
        // The merge rule: a refresh response carrying no refresh token must not clobber the good one.
        expect(material.refreshToken).toBe("test-token-xai-refresh");

        const refreshes = fake.requests.filter((r) => new URLSearchParams(r.body).get("grant_type") === "refresh_token");
        expect(refreshes).toHaveLength(1);
        expect(new URLSearchParams(refreshes[0]!.body).get(XAI_OAUTH.identityField)).toBe("winter-agent-sdk");
        // And the turn that followed carried the NEW token, not the stale one. Read off the fake's
        // own comparison: `requests` redacts the value to `Bearer ***`, so the recorded header can
        // never distinguish a refreshed bearer from a stale one and an assertion on it would pass
        // either way.
        expect(chat.sawFreshBearer).toBe(true);
        expect(REFRESHED_ACCESS_TOKEN).not.toBe("test-token-xai-access");
      } finally {
        await chat.close();
      }
    } finally {
      await fake.close();
    }
  });

  test("NONE of the vendor's six product-identity headers is sent on the GENERATION path either — including the two the proxy's own client injects", async () => {
    // `X-XAI-Token-Auth: xai-grok-cli` and `x-authenticateresponse` are injected by the vendor's
    // client ONLY for cli-chat-proxy base URLs — which is precisely the endpoint this row uses. They
    // are the two most likely to be "helpfully" added by someone making a live call work, and
    // `xai-grok-cli` is a first-party product identity Winter may not send (capture §3.4/§7).
    const chat = await startXaiChatFake();
    try {
      const ref = xaiCredentialRef("acct-x");
      const store = createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: "test-token-xai-access", refreshToken: "test-token-xai-refresh", accountId: "acct-x", expiresAt: Date.now() + 3_600_000 }]]);
      const adapter = createXaiOauthAdapter({ generatedBaseUrl: chat.url, descriptors: () => undefined });
      for await (const _ of adapter.streamTurn({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }] }, { ...testContext({ providerId: "xai-oauth" }), credentials: store, authRef: ref })) void _;
      expect(chat.requests.length).toBeGreaterThan(0);
      for (const req of chat.requests) {
        for (const banned of DERIVED_XAI.vendorOnlyHeaders) expect(req.headers[banned]).toBeUndefined();
        expect(req.headers["user-agent"]).not.toMatch(/grok/i);
      }
    } finally {
      await chat.close();
    }
  });

  test("a turn on a HEALTHY token does not refresh — the window is a window, not an every-turn round trip", async () => {
    const fake = await startXaiOauthFake();
    try {
      const ref = xaiCredentialRef("acct-x");
      const store = createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: "test-token-xai-access", refreshToken: "test-token-xai-refresh", accountId: "acct-x", expiresAt: Date.now() + 3_600_000 }]]);
      const chat = await startXaiChatFake();
      try {
        const adapter = createXaiOauthAdapter({ generatedBaseUrl: chat.url, tokenUrl: fake.tokenUrl, descriptors: () => undefined });
        for await (const _ of adapter.streamTurn({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }] }, { ...testContext({ providerId: "xai-oauth" }), credentials: store, authRef: ref })) void _;
        expect(fake.requests).toHaveLength(0);
      } finally {
        await chat.close();
      }
    } finally {
      await fake.close();
    }
  });

  test("the subscription endpoint is the proxy the capture found, NOT the metered api-key surface", () => {
    // Capture §4. Getting this wrong bills a user's metered account for traffic their subscription
    // already covers, or fails to authenticate — and both look like "the provider is broken".
    expect(XAI_OAUTH.apiBaseUrl).toBe(DERIVED_XAI.apiBaseUrl);
    expect(XAI_OAUTH.apiBaseUrl).not.toContain("api.x.ai");
  });
});
