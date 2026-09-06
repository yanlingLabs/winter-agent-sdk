// D20: the Anthropic Console OAuth login, driven end to end against a loopback fake.
//
// The flow is HOST-INVOKED, exactly like codex's: a turn that finds no credential REFUSES and says
// what to run — it never opens a browser on a library's own initiative. So what is under test here
// is the host's entry point, its callback server, its PKCE binding, the profile lookup that names
// the record, and the record itself.
//
// THE FIRST TEST IS THE ONE THAT MATTERS MOST. The constants in `console-oauth.ts` are not values
// anybody may type from memory — they were read out of the pinned, checksum-verified artifact by the
// capture recorded in `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6b.md`, and
// `derived-p6b.ts` is that capture's table as data. Asserting the two agree is what makes "derived,
// not remembered" a property a gate holds rather than a claim a commit message makes.
//
// The fake lives in `provider-conformance` because that is where every other loopback fake lives and
// where the redaction discipline is enforced; the import is RELATIVE and test-only, so it adds no
// package dependency in either direction.
import { describe, expect, test } from "bun:test";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import { CONSOLE_OAUTH, anthropicCredentialRef, startAnthropicConsoleLogin } from "./console-oauth.ts";
import {
  FAKE_CONSOLE_ACCESS_TOKEN,
  FAKE_CONSOLE_ACCOUNT_ID,
  FAKE_CONSOLE_REFRESH_TOKEN,
  startAnthropicConsoleOauthFake,
} from "../../../../provider-conformance/src/fakes/anthropic-console-oauth.ts";
import { DERIVED } from "../../../../conformance/compat/anthropic/0.3.250/derived-p6b.ts";
import { winterUserAgent } from "../../identity.ts";
import { base64Url } from "../openai/pkce.ts";

describe("D20: Anthropic Console OAuth", () => {
  test("the constants are the artifact's, not typed from memory", () => {
    expect(CONSOLE_OAUTH.clientId).toBe(DERIVED.consoleOauth.clientId);
    expect(CONSOLE_OAUTH.authorizeUrl).toBe(DERIVED.consoleOauth.authorizeUrl);
    expect(CONSOLE_OAUTH.tokenUrl).toBe(DERIVED.consoleOauth.tokenUrl);
    expect(CONSOLE_OAUTH.profileUrl).toBe(DERIVED.consoleOauth.profileUrl);
    expect(CONSOLE_OAUTH.scope).toBe(DERIVED.consoleOauth.scope);
    expect(CONSOLE_OAUTH.callbackPort).toBe(DERIVED.consoleOauth.callbackPort);
    expect(CONSOLE_OAUTH.callbackPath).toBe(DERIVED.consoleOauth.callbackPath);
    expect(CONSOLE_OAUTH.betaHeader).toBe(DERIVED.consoleOauth.betaHeader);
  });

  test("D13/D14: the CONSOLE host is what D20 speaks to — the consumer subscription host appears nowhere in the shipped constants", () => {
    // The pinned artifact carries BOTH authorize hosts (derived-shapes-p6b.md §2). Only the Console
    // one is a Winter provider; the claude.ai subscription login never is. This is a NEGATIVE pin on
    // the whole constants object rather than on one field, because the way that host would come back
    // is as a new field somebody adds "for completeness".
    expect(CONSOLE_OAUTH.authorizeUrl).toContain("platform.claude.com");
    expect(JSON.stringify(CONSOLE_OAUTH)).not.toContain("claude.ai");
    expect(JSON.stringify(CONSOLE_OAUTH)).not.toContain("/cai/");
    // Nor does it reach for the API-key-minting or roles paths, which are `claude_cli`-scoped: using
    // one presents as the vendor's own CLI, which D21 excludes.
    expect(JSON.stringify(CONSOLE_OAUTH)).not.toContain("claude_cli");
  });

  test("D21: the requested scope is the admissible SUBSET — inference and profile, never the vendor application's own entitlements", () => {
    const scopes = CONSOLE_OAUTH.scope.split(" ");
    expect(scopes).toEqual(["user:inference", "user:profile"]);
    // The artifact's DEFAULT list is the union of two larger lists; these three are the members that
    // make it inadmissible, and none of them may ever be requested.
    expect(scopes).not.toContain("user:sessions:claude_code");
    expect(scopes).not.toContain("user:mcp_servers");
    expect(scopes).not.toContain("org:create_api_key");
  });

  test("the PKCE loopback login persists oauth material under `anthropic:<accountId>` and sends an honest identity", async () => {
    const fake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const statuses: Array<{ isAuthenticating: boolean; output?: string[]; error?: string }> = [];
      let authorizeUrl: string | undefined;
      const result = await startAnthropicConsoleLogin(store, {
        openUrl: async (url) => {
          authorizeUrl = url;
          await fake.completeAuthorization(url);
        },
        authorizeUrl: fake.authorizeUrl,
        tokenUrl: fake.tokenUrl,
        profileUrl: fake.profileUrl,
        callbackPort: 0,
        onAuthStatus: (status) => statuses.push(status),
      });

      // R6-10: ONE record per provider/account, named for the account the profile lookup reported.
      expect(result.ref).toEqual({ kind: "keychain", account: `anthropic:${FAKE_CONSOLE_ACCOUNT_ID}` });
      expect(result.accountId).toBe(FAKE_CONSOLE_ACCOUNT_ID);
      expect(store.size()).toBe(1);
      const material = await store.get(result.ref);
      expect(material?.kind).toBe("oauth");
      expect(material?.kind === "oauth" ? material.accessToken : "").toBe(FAKE_CONSOLE_ACCESS_TOKEN);
      expect(material?.kind === "oauth" ? material.refreshToken : "").toBe(FAKE_CONSOLE_REFRESH_TOKEN);
      expect(material?.kind === "oauth" ? material.accountId : "").toBe(FAKE_CONSOLE_ACCOUNT_ID);

      // WS-13b HONEST IDENTITY, read off the LIVE request the fake received. The negative half is
      // what carries it: Bun supplies `Bun/<version>` when nothing sets the header, so a
      // presence-only assertion passes on a flow that never named Winter at all. The second negative
      // is this lane's own rule — Winter never presents a vendor product identity on a token
      // exchange, however convenient borrowing one would be.
      expect(fake.tokenRequests[0]?.headers["user-agent"]).toBe(winterUserAgent());
      expect(fake.tokenRequests[0]?.headers["user-agent"]).toMatch(/^winter-agent-sdk\//);
      expect(fake.tokenRequests[0]?.headers["user-agent"]).not.toMatch(/claude/i);
      expect(fake.tokenRequests[0]?.headers["user-agent"]).not.toMatch(/anthropic/i);
      expect(fake.tokenRequests[0]?.headers["user-agent"]).not.toMatch(/bun/i);
      expect(fake.profileRequests[0]?.headers["user-agent"]).toBe(winterUserAgent());

      // The authorize URL carried the derived Console constants and the admissible scope.
      const authorize = new URL(authorizeUrl!);
      expect(authorize.searchParams.get("client_id")).toBe(CONSOLE_OAUTH.clientId);
      expect(authorize.searchParams.get("scope")).toBe(CONSOLE_OAUTH.scope);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      // The artifact builds `http://localhost:${port}/callback`; the PATH is the part a registration
      // pattern-matches, and pkce.ts's own default is a different one.
      const redirectUri = new URL(authorize.searchParams.get("redirect_uri") ?? "");
      expect(redirectUri.pathname).toBe(CONSOLE_OAUTH.callbackPath);

      // THE PKCE BINDING ITSELF: the verifier sent to the token endpoint must be the S256 preimage of
      // the challenge the browser-visible authorize URL carried. Asserting both merely exist proves
      // neither is empty; asserting they HASH is what proves the exchange is bound rather than two
      // unrelated random strings — which is the entire security of a loopback flow.
      const form = new URLSearchParams(fake.tokenRequests[0]!.body);
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("client_id")).toBe(CONSOLE_OAUTH.clientId);
      const verifier = form.get("code_verifier") ?? "";
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      expect(base64Url(new Uint8Array(digest))).toBe(authorize.searchParams.get("code_challenge") ?? "");

      // `auth_status` is a login-flow PROGRESS channel (R6-F) and never carries material.
      expect(statuses.at(-1)).toEqual({ isAuthenticating: false, output: ["signed in"] });
      expect(JSON.stringify(statuses)).not.toContain(FAKE_CONSOLE_ACCESS_TOKEN);
      expect(JSON.stringify(statuses)).not.toContain(FAKE_CONSOLE_REFRESH_TOKEN);
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("a profile lookup that reports no account id is REFUSED — there is no per-account record to occupy (R6-10)", async () => {
    const fake = await startAnthropicConsoleOauthFake({ omitAccount: true });
    try {
      const store = createMemoryCredentialStore();
      await expect(
        startAnthropicConsoleLogin(store, {
          openUrl: (url) => fake.completeAuthorization(url),
          authorizeUrl: fake.authorizeUrl,
          tokenUrl: fake.tokenUrl,
          profileUrl: fake.profileUrl,
          callbackPort: 0,
        }),
      ).rejects.toThrow(/account id/i);
      expect(store.size()).toBe(0);
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("a token endpoint that refuses stores nothing, and its body is NOT echoed", async () => {
    const fake = await startAnthropicConsoleOauthFake({ failTokenWith: 400 });
    try {
      const store = createMemoryCredentialStore();
      const outcome: unknown = await startAnthropicConsoleLogin(store, {
        openUrl: (url) => fake.completeAuthorization(url),
        authorizeUrl: fake.authorizeUrl,
        tokenUrl: fake.tokenUrl,
        profileUrl: fake.profileUrl,
        callbackPort: 0,
      }).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("HTTP 400");
      // A rejected-grant body routinely quotes the grant it rejected; it never reaches the message.
      expect((outcome as Error).message).not.toContain("invalid_grant");
      expect(store.size()).toBe(0);
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("a callback whose `state` does not match is REFUSED — a planted callback cannot complete a login this process did not start", async () => {
    const fake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      await expect(
        startAnthropicConsoleLogin(store, {
          openUrl: (url) => fake.completeAuthorization(url, { state: "not-the-state-we-minted" }),
          authorizeUrl: fake.authorizeUrl,
          tokenUrl: fake.tokenUrl,
          profileUrl: fake.profileUrl,
          callbackPort: 0,
        }),
      ).rejects.toThrow(/state mismatch/i);
      // Nothing was exchanged and nothing was stored.
      expect(fake.tokenRequests).toHaveLength(0);
      expect(store.size()).toBe(0);
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("the record honours the host's Keychain service (the dev profile's own)", async () => {
    const fake = await startAnthropicConsoleOauthFake();
    try {
      const store = createMemoryCredentialStore();
      const result = await startAnthropicConsoleLogin(store, {
        openUrl: (url) => fake.completeAuthorization(url),
        authorizeUrl: fake.authorizeUrl,
        tokenUrl: fake.tokenUrl,
        profileUrl: fake.profileUrl,
        callbackPort: 0,
        service: "com.winter.core.dev",
      });
      expect(result.ref).toEqual({ kind: "keychain", account: `anthropic:${FAKE_CONSOLE_ACCOUNT_ID}`, service: "com.winter.core.dev" });
      expect(await store.get(result.ref)).not.toBeNull();
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("`anthropicCredentialRef` is the ONE spelling of the record name — a host never assembles it by hand", () => {
    expect(anthropicCredentialRef("acct-x")).toEqual({ kind: "keychain", account: "anthropic:acct-x" });
    expect(anthropicCredentialRef("acct-x", "com.winter.core.dev")).toEqual({ kind: "keychain", account: "anthropic:acct-x", service: "com.winter.core.dev" });
  });
});
