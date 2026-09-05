// The codex login flow, driven end to end against a loopback token endpoint.
//
// The flow is HOST-INVOKED — a turn that finds no credential refuses and says what to run, it never
// opens a browser on a library's own initiative — so what is tested here is exactly the host's
// entry point: `startCodexLogin(store, { openUrl })`, its callback server, its state check, and the
// record it leaves behind.
//
// `callbackPort: 0` throughout: the production ports (1455, with 1457 as codex-rs's own fallback)
// are a registered `redirect_uri`, and a test that bound them would fight a real login and fail on
// a machine where one is in use.

import { describe, expect, test } from "bun:test";
import { startCodexLogin } from "../../../provider-runtime/src/adapters/openai/codex-oauth.ts";
import { CODEX } from "../../../provider-runtime/src/adapters/openai/codex-config.ts";
import { base64Url } from "../../../provider-runtime/src/adapters/openai/pkce.ts";
import { createMemoryCredentialStore } from "../../../provider-runtime/src/credentials/memory.ts";
import { startFake } from "../fakes/server.ts";
import { FAKE_ACCOUNT_ID, FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, codexTokenRoute } from "../fakes/codex-oauth.ts";
import type { CodexTokenEndpointOptions } from "../fakes/codex-oauth.ts";

/** Completes the browser half: reads the authorize URL the flow produced and calls its own callback. */
function browserThatApproves(overrides: { state?: string; code?: string | null } = {}): (url: string) => Promise<void> {
  return async (url: string) => {
    const authorize = new URL(url);
    const redirectUri = authorize.searchParams.get("redirect_uri");
    if (redirectUri === null) throw new Error("the authorize URL carried no redirect_uri");
    const callback = new URL(redirectUri);
    callback.searchParams.set("state", overrides.state ?? authorize.searchParams.get("state") ?? "");
    if (overrides.code !== null) callback.searchParams.set("code", overrides.code ?? "test-code-authorization");
    await fetch(callback.toString()).catch(() => undefined);
  };
}

async function withTokenEndpoint<T>(opts: CodexTokenEndpointOptions, fn: (url: string, requests: Array<{ body: string }>) => Promise<T>): Promise<T> {
  const fake = await startFake({ routes: [codexTokenRoute(opts)] });
  try {
    return await fn(`${fake.url}/oauth/token`, fake.requests);
  } finally {
    await fake.close();
  }
}

describe("startCodexLogin", () => {
  test("a completed login persists ONE record under `codex-oauth:<accountId>` and reports progress", async () => {
    await withTokenEndpoint({}, async (tokenUrl, requests) => {
      const store = createMemoryCredentialStore();
      const statuses: Array<{ isAuthenticating: boolean; output?: string[]; error?: string }> = [];
      let authorizeUrl: string | undefined;
      const result = await startCodexLogin(store, {
        openUrl: async (url) => {
          authorizeUrl = url;
          await browserThatApproves()(url);
        },
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl,
        callbackPort: 0,
        onAuthStatus: (status) => statuses.push(status),
      });

      expect(result.accountId).toBe(FAKE_ACCOUNT_ID);
      expect(result.ref).toEqual({ kind: "keychain", account: `codex-oauth:${FAKE_ACCOUNT_ID}` });
      // R6-10: ONE record per provider/account, never a shared global slot.
      expect(store.size()).toBe(1);
      const material = await store.get(result.ref);
      expect(material?.kind).toBe("oauth");
      expect(material?.kind === "oauth" ? material.accessToken : "").toBe(FAKE_ACCESS_TOKEN);
      expect(material?.kind === "oauth" ? material.refreshToken : "").toBe(FAKE_REFRESH_TOKEN);
      expect(material?.kind === "oauth" ? material.accountId : "").toBe(FAKE_ACCOUNT_ID);

      // The exchange was a PKCE authorization-code grant with the verifier, and the verifier never
      // rode the authorize URL (which is the browser-visible half).
      const form = new URLSearchParams(requests[0]!.body);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("client_id")).toBe(CODEX.clientId);
      expect(form.get("code")).toBe("test-code-authorization");
      const verifier = form.get("code_verifier") ?? "";
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      // THE BINDING ITSELF (minor 13): the verifier sent to the token endpoint must be the S256
      // preimage of the challenge the authorize URL carried. Asserting both exist proves neither is
      // empty; asserting they HASH proves the exchange is actually PKCE-bound rather than two
      // unrelated random strings, which is the whole security of a loopback flow.
      const challenge = new URL(authorizeUrl!).searchParams.get("code_challenge");
      expect(challenge).toBeTruthy();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      expect(base64Url(new Uint8Array(digest))).toBe(challenge ?? "");

      // `auth_status` is a login-flow PROGRESS channel (R6-F), and it never carries material.
      expect(statuses.length).toBeGreaterThanOrEqual(2);
      expect(statuses.at(-1)).toEqual({ isAuthenticating: false, output: ["signed in"] });
      expect(JSON.stringify(statuses)).not.toContain(FAKE_ACCESS_TOKEN);
      expect(JSON.stringify(statuses)).not.toContain(FAKE_REFRESH_TOKEN);
    });
  }, 15_000);

  test("a callback whose `state` does not match is REFUSED — a planted callback cannot complete someone else's login", async () => {
    await withTokenEndpoint({}, async (tokenUrl, requests) => {
      const store = createMemoryCredentialStore();
      const statuses: Array<{ error?: string }> = [];
      await expect(
        startCodexLogin(store, { openUrl: browserThatApproves({ state: "not-the-state-we-minted" }), authorizeUrl: "https://auth.example.test/oauth/authorize", tokenUrl, callbackPort: 0, onAuthStatus: (s) => statuses.push(s) }),
      ).rejects.toThrow(/state mismatch/i);
      // Nothing was exchanged and nothing was stored.
      expect(requests).toHaveLength(0);
      expect(store.size()).toBe(0);
      expect(statuses.at(-1)?.error).toMatch(/state mismatch/i);
    });
  }, 15_000);

  test("a callback with no code fails the flow rather than exchanging an empty grant", async () => {
    await withTokenEndpoint({}, async (tokenUrl, requests) => {
      const store = createMemoryCredentialStore();
      await expect(startCodexLogin(store, { openUrl: browserThatApproves({ code: null }), authorizeUrl: "https://auth.example.test/oauth/authorize", tokenUrl, callbackPort: 0 })).rejects.toThrow(/authorization code/i);
      expect(requests).toHaveLength(0);
      expect(store.size()).toBe(0);
    });
  }, 15_000);

  test("a token endpoint that refuses does not persist anything, and its body is NOT echoed", async () => {
    await withTokenEndpoint({ failWith: 400 }, async (tokenUrl) => {
      const store = createMemoryCredentialStore();
      const outcome: unknown = await startCodexLogin(store, { openUrl: browserThatApproves(), authorizeUrl: "https://auth.example.test/oauth/authorize", tokenUrl, callbackPort: 0 }).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(Error);
      const message = (outcome as Error).message;
      expect(message).toContain("HTTP 400");
      // A token-endpoint failure body routinely quotes the grant it rejected; it never reaches the
      // message.
      expect(message).not.toContain("invalid_grant");
      expect(store.size()).toBe(0);
    });
  }, 15_000);

  test("an exchange that returns no account id is REFUSED — there is no per-account record to occupy", async () => {
    await withTokenEndpoint({ omitIdToken: true }, async (tokenUrl) => {
      const store = createMemoryCredentialStore();
      await expect(startCodexLogin(store, { openUrl: browserThatApproves(), authorizeUrl: "https://auth.example.test/oauth/authorize", tokenUrl, callbackPort: 0 })).rejects.toThrow(/account id/i);
      expect(store.size()).toBe(0);
    });
  }, 15_000);

  test("the record honours the host's Keychain service (the dev profile's own)", async () => {
    await withTokenEndpoint({}, async (tokenUrl) => {
      const store = createMemoryCredentialStore();
      const result = await startCodexLogin(store, { openUrl: browserThatApproves(), authorizeUrl: "https://auth.example.test/oauth/authorize", tokenUrl, callbackPort: 0, service: "com.winter.core.dev" });
      expect(result.ref).toEqual({ kind: "keychain", account: `codex-oauth:${FAKE_ACCOUNT_ID}`, service: "com.winter.core.dev" });
      expect(await store.get(result.ref)).not.toBeNull();
    });
  }, 15_000);
});
