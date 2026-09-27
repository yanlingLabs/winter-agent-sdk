// WS-25: the host's three doors -- sign in, refresh, revoke -- against the fixture authorization server
// (test-fixture-as.ts). Each test pins a behaviour the spec names; none reaches a real server.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mcpOAuthClientAccount, mcpOAuthClientSecretAccount, mcpOAuthTokenAccount } from "./account.ts";
import { activeMcpOAuthLoginCount, startMcpOAuthLogin } from "./login.ts";
import { refreshMcpOAuthToken } from "./refresh.ts";
import { revokeMcpOAuth } from "./revoke.ts";
import { createMemoryMcpOAuthStore, readClientRecord, readTokenRecord, writeTokenRecord, type McpOAuthStore } from "./store.ts";
import { startFixtureAs, type FixtureAs, type FixtureAsOptions } from "./test-fixture-as.ts";

const CIMD_URL = "https://winter.test/oauth-client.json";
const fixtures: FixtureAs[] = [];
let logged: string[] = [];
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logged = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  for (const f of fixtures.splice(0)) f.close();
});

function fixture(opts: FixtureAsOptions = {}): FixtureAs {
  const f = startFixtureAs(opts);
  fixtures.push(f);
  return f;
}

async function signIn(fx: FixtureAs, store: McpOAuthStore, extra: Partial<Parameters<typeof startMcpOAuthLogin>[0]> = {}) {
  const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store, clientMetadataUrl: CIMD_URL, ...extra });
  const { callbackStatus, location } = await fx.approve(login.authUrl);
  return { login, callbackStatus, location, outcome: await login.done };
}

/** Every secret a store holds, so a test can prove none reached a log line. */
async function secretsIn(store: ReturnType<typeof createMemoryMcpOAuthStore>): Promise<string[]> {
  const out: string[] = [];
  for (const raw of store.entries.values()) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      for (const k of ["accessToken", "refreshToken", "clientSecret"]) if (typeof o[k] === "string") out.push(o[k] as string);
    } catch {
      out.push(raw);
    }
  }
  return out;
}

async function listenerIsClosed(redirectUri: string): Promise<boolean> {
  return fetch(redirectUri).then(
    () => false,
    () => true,
  );
}

describe("sign-in: DCR", () => {
  test("discovers, registers, authorizes and stores the sign-in; the listener closes after", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    const { login, callbackStatus, outcome } = await signIn(fx, store);
    expect(outcome).toEqual({ ok: true });
    expect(callbackStatus).toBe(200);
    expect(login.issuerOrigin).toBe(fx.origin);
    expect(login.authorizeOrigin).toBe(fx.origin);
    const token = await readTokenRecord(store, mcpOAuthTokenAccount(fx.mcpUrl));
    expect(token).toMatchObject({ v: 1, kind: "mcp-oauth", serverUrl: fx.mcpUrl, issuer: fx.issuer, generation: 1, scope: "read" });
    expect(token!.refreshToken).toBeString();
    expect(token!.expiresAt).toBeNumber();
    const client = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
    expect(client).toMatchObject({ registeredVia: "dcr", issuer: fx.issuer, clientId: fx.registrations[0]!.clientId });
    // Bound and registered as the SAME literal loopback URI.
    expect(client!.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(fx.registrations[0]!.redirectUris).toEqual([client!.redirectUri]);
    expect(fx.authorizeRedirects).toEqual([client!.redirectUri]);
    expect(await listenerIsClosed(client!.redirectUri)).toBe(true);
    expect(activeMcpOAuthLoginCount()).toBe(0);
  });

  test("a second sign-in REUSES the persisted registration and its port (no DCR spam)", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const first = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
    const again = await signIn(fx, store);
    expect(again.outcome).toEqual({ ok: true });
    expect(fx.registrations.length).toBe(1);
    expect(fx.authorizeRedirects).toEqual([first!.redirectUri, first!.redirectUri]);
    expect((await readTokenRecord(store, mcpOAuthTokenAccount(fx.mcpUrl)))!.generation).toBe(2);
  });

  test("a persisted port that is taken re-registers on a fresh port rather than failing", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const first = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: Number(new URL(first!.redirectUri).port), fetch: () => new Response("busy") });
    try {
      const again = await signIn(fx, store);
      expect(again.outcome).toEqual({ ok: true });
    } finally {
      squatter.stop(true);
    }
    expect(fx.registrations.length).toBe(2);
    const second = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
    expect(second!.redirectUri).not.toBe(first!.redirectUri);
  });
});

describe("sign-in: CIMD and pre-registered clients", () => {
  test("CIMD when the AS advertises it: the client id IS the document URL, nothing is registered, any loopback port is accepted", async () => {
    const fx = fixture({ cimd: true, cimdDocuments: { [CIMD_URL]: { client_id: CIMD_URL, client_name: "Winter", redirect_uris: ["http://127.0.0.1/callback"] } } });
    const store = createMemoryMcpOAuthStore();
    const { outcome } = await signIn(fx, store);
    expect(outcome).toEqual({ ok: true });
    expect(fx.registrations).toEqual([]);
    const client = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
    expect(client).toMatchObject({ registeredVia: "cimd", clientId: CIMD_URL });
    // The document is portless; the request carried the listener's real port (RFC 8252 §7.3).
    expect(fx.authorizeRedirects[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  test("a PRE-REGISTERED confidential client beats CIMD and DCR; its secret comes from its DERIVED Keychain account and is kept for refresh", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port as number;
    probe.stop(true);
    const fx = fixture({ cimd: true, cimdDocuments: {}, preregistered: [{ clientId: "gh-app", clientSecret: "pre-secret-value", redirectUris: [`http://127.0.0.1:${port}/callback`] }] });
    const store = createMemoryMcpOAuthStore({ [mcpOAuthClientSecretAccount(fx.mcpUrl)]: "pre-secret-value" });
    const { outcome } = await signIn(fx, store, { oauth: { clientId: "gh-app", clientSecretRef: { kind: "keychain" }, callbackPort: port } });
    expect(outcome).toEqual({ ok: true });
    expect(fx.registrations).toEqual([]);
    const client = await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl));
    expect(client).toMatchObject({ registeredVia: "preregistered", clientId: "gh-app", clientSecret: "pre-secret-value", redirectUri: `http://127.0.0.1:${port}/callback` });
    // ...and the refresh authenticates as that confidential client.
    expect(await refreshMcpOAuthToken({ account: mcpOAuthTokenAccount(fx.mcpUrl), store })).toEqual({ ok: true, generation: 2 });
  });

  test("the secret is read ONLY from the derived account -- never a provider key a config (or anyone) names", async () => {
    const fx = fixture();
    const reads: string[] = [];
    const inner = createMemoryMcpOAuthStore({ "openai:default": "sk-provider-key" });
    const store: McpOAuthStore = { read: async (a) => (reads.push(a), inner.read(a)), write: inner.write, remove: inner.remove };
    // A config that still tries to name an account never gets past the type or validateServerConfig; even
    // cast through, the sign-in ignores it and reads the derived account, which is empty -> refused typed.
    const err = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store, oauth: { clientId: "x", clientSecretRef: { kind: "keychain", account: "openai:default" } as never } }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("client_secret_unavailable");
    expect(reads).toEqual([mcpOAuthClientSecretAccount(fx.mcpUrl)]);
    expect(fx.tokenPosts).toEqual([]);
    expect(activeMcpOAuthLoginCount()).toBe(0);
    // A host reader is called with that same derived account, and nothing else.
    const asked: string[] = [];
    await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store: createMemoryMcpOAuthStore(), oauth: { clientId: "x", clientSecretRef: { kind: "keychain" } }, readClientSecret: async (a) => (asked.push(a), null) }).catch(() => {});
    expect(asked).toEqual([mcpOAuthClientSecretAccount(fx.mcpUrl)]);
  });

  test("the LEGACY variant (no metadata anywhere) falls back to /authorize, /token and /register", async () => {
    const fx = fixture({ metadata: false });
    const store = createMemoryMcpOAuthStore();
    const { outcome } = await signIn(fx, store);
    expect(outcome).toEqual({ ok: true });
    expect(fx.log).toContain("POST /register");
    expect(fx.log).toContain("POST /token");
    expect(await refreshMcpOAuthToken({ account: mcpOAuthTokenAccount(fx.mcpUrl), store })).toEqual({ ok: true, generation: 2 });
  });

  test("oauth.authServerMetadataUrl seeds discovery (a server with no protected-resource metadata)", async () => {
    const fx = fixture({ metadata: false });
    // The fixture's own RFC 8414 document is 404 in the legacy variant, so serve one at a separate URL.
    const doc = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({ issuer: fx.issuer, authorization_endpoint: `${fx.origin}/authorize`, token_endpoint: `${fx.origin}/token`, registration_endpoint: `${fx.origin}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }),
    });
    try {
      const metadataUrl = `http://127.0.0.1:${doc.port}/.well-known/oauth-authorization-server`;
      const store = createMemoryMcpOAuthStore();
      const { outcome } = await signIn(fx, store, { oauth: { authServerMetadataUrl: metadataUrl } });
      expect(outcome).toEqual({ ok: true });
      expect((await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl)))!.authorizationServerUrl).toBe(metadataUrl);
      expect(await refreshMcpOAuthToken({ account: mcpOAuthTokenAccount(fx.mcpUrl), store })).toEqual({ ok: true, generation: 2 });
    } finally {
      doc.stop(true);
    }
  });
});

describe("sign-in: the callback and the flow's lifetime", () => {
  test("a callback with the wrong `state` is refused 400 and the flow keeps waiting for the real one", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
    const redirectUri = new URL(login.authUrl).searchParams.get("redirect_uri")!;
    const forged = await fetch(`${redirectUri}?code=attacker-code&state=not-the-state`);
    expect(forged.status).toBe(400);
    expect(fx.tokenPosts).toEqual([]); // the forged code was never redeemed
    await fx.approve(login.authUrl);
    expect(await login.done).toEqual({ ok: true });
  });

  test("the authorize URL carries a 32-byte state and PKCE S256", async () => {
    const fx = fixture();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store: createMemoryMcpOAuthStore() });
    const params = new URL(login.authUrl).searchParams;
    expect(Buffer.from(params.get("state")!, "base64url").length).toBe(32);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("resource")).toBe(fx.mcpUrl);
    login.cancel();
    expect(await login.done).toEqual({ ok: false, reason: "login_cancelled" });
  });

  test("an authorization server's `error` ends the flow with its code only", async () => {
    const fx = fixture();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store: createMemoryMcpOAuthStore() });
    const params = new URL(login.authUrl).searchParams;
    await fetch(`${params.get("redirect_uri")}?state=${params.get("state")}&error=access_denied&error_description=${encodeURIComponent("<script>")}`);
    expect(await login.done).toEqual({ ok: false, reason: "authorization_denied:access_denied" });
  });

  test("the 5-minute bound (shortened here) settles login_timeout and closes the listener", async () => {
    const fx = fixture();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store: createMemoryMcpOAuthStore(), timeoutMs: 30 });
    expect(await login.done).toEqual({ ok: false, reason: "login_timeout" });
    expect(await listenerIsClosed(new URL(login.authUrl).searchParams.get("redirect_uri")!)).toBe(true);
  });

  test("one flow per server, even when two sign-ins START concurrently: one listener survives, the other unwinds", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    const [a, b] = await Promise.allSettled([startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store }), startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store })]);
    const live: Array<Awaited<ReturnType<typeof startMcpOAuthLogin>>> = [];
    const outcomes: unknown[] = [];
    for (const r of [a, b]) {
      if (r.status === "rejected") outcomes.push((r.reason as { code?: string }).code);
      else live.push(r.value);
    }
    const settled = await Promise.all(live.map((l) => Promise.race([l.done, Bun.sleep(50).then(() => "pending")])));
    // Exactly one flow is still waiting for its callback; the other was superseded (early or late).
    expect(settled.filter((o) => o === "pending").length + 0).toBe(1);
    expect([...outcomes, ...settled.filter((o) => o !== "pending").map((o) => (o as { reason: string }).reason)]).toEqual(["login_superseded"]);
    expect(activeMcpOAuthLoginCount()).toBe(1);
    const winner = live[settled.indexOf("pending")]!;
    await fx.approve(winner.authUrl);
    expect(await winner.done).toEqual({ ok: true });
    expect(activeMcpOAuthLoginCount()).toBe(0);
  });

  test("the code exchange runs ONCE: an invalid_client answer is reported by code, never retried, never logged verbatim, and the dead registration is cleared", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
    // The browser leg by hand: approved at /authorize, THEN the authorization server forgets the client.
    const consent = await fetch(login.authUrl, { redirect: "manual" });
    fx.forgetRegistrations();
    await (await fetch(consent.headers.get("location")!)).text();
    expect(await login.done).toEqual({ ok: false, reason: "token_exchange_failed:oauth_error:invalid_client" });
    expect(fx.tokenPosts).toEqual(["authorization_code"]); // the single-use code was posted once
    expect(fx.registrations.length).toBe(1); // no re-registration
    expect(await store.read(mcpOAuthClientAccount(fx.mcpUrl))).toBeNull();
    expect(await store.read(mcpOAuthTokenAccount(fx.mcpUrl))).toBeNull();
    for (const line of logged) expect(line).not.toContain("fixture: invalid_client");
  });

  test("a sign-in that ends DURING its code exchange (cancel, timeout) writes no tokens", async () => {
    const fx = fixture({ tokenDelayMs: 150 });
    const store = createMemoryMcpOAuthStore();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
    const approving = fx.approve(login.authUrl).catch(() => undefined);
    await Bun.sleep(40);
    login.cancel();
    await approving;
    await Bun.sleep(200);
    expect(await login.done).toEqual({ ok: false, reason: "login_cancelled" });
    expect(await store.read(mcpOAuthTokenAccount(fx.mcpUrl))).toBeNull();
  });

  test("one flow per server: a second sign-in supersedes the first", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    const first = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
    const second = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
    expect(await first.done).toEqual({ ok: false, reason: "login_superseded" });
    await fx.approve(second.authUrl);
    expect(await second.done).toEqual({ ok: true });
  });

  test("the server URL itself is held to the policy", async () => {
    for (const serverUrl of ["http://mcp.example.com/mcp", "https://10.1.2.3/mcp"]) {
      const err = await startMcpOAuthLogin({ serverUrl, store: createMemoryMcpOAuthStore() }).catch((e: unknown) => e);
      expect([serverUrl, (err as { code?: string }).code]).toEqual([serverUrl, "policy_refused"]);
    }
  });
});

describe("refresh: one refresher, rotating tokens", () => {
  test("rotates the pair, bumps the generation and keeps the issuer binding", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    const before = (await readTokenRecord(store, account))!;
    expect(await refreshMcpOAuthToken({ account, store, now: () => 1_000 })).toEqual({ ok: true, generation: 2 });
    const after = (await readTokenRecord(store, account))!;
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.expiresAt).toBe(1_000 + 3600 * 1000);
    expect(after.issuer).toBe(before.issuer);
  });

  test("the RFC 8707 resource is sent VERBATIM on refresh -- a pathless PRM resource is not turned into `origin/`", async () => {
    const fx = fixture({ pathlessResource: true });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    expect(await refreshMcpOAuthToken({ account: mcpOAuthTokenAccount(fx.mcpUrl), store })).toEqual({ ok: true, generation: 2 });
    expect(fx.tokenResources).toEqual([fx.origin, fx.origin]);
  });

  test("SINGLE-FLIGHT: five concurrent asks post ONE refresh grant", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    const results = await Promise.all(Array.from({ length: 5 }, () => refreshMcpOAuthToken({ account, store, generation: 1 })));
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: true, generation: 2 })));
    expect(fx.tokenPosts.filter((g) => g === "refresh_token")).toEqual(["refresh_token"]);
    expect(fx.reuseRevokedFamilies).toEqual([]);
  });

  test("GENERATION: an ask from a session holding an older generation posts nothing", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    await refreshMcpOAuthToken({ account, store });
    const posts = fx.tokenPosts.length;
    expect(await refreshMcpOAuthToken({ account, store, generation: 1 })).toEqual({ ok: true, generation: 2 });
    expect(fx.tokenPosts.length).toBe(posts);
  });

  test("a replayed (rotated) refresh token is invalid_grant: the AS revokes the family and the sign-in is cleared", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    const stale = (await readTokenRecord(store, account))!;
    await refreshMcpOAuthToken({ account, store });
    // Another process wrote the OLD record back (the replay a second refresher would make).
    await writeTokenRecord(store, account, { ...stale, generation: 7 });
    expect(await refreshMcpOAuthToken({ account, store })).toEqual({ ok: false, reason: "needs_auth" });
    expect(fx.reuseRevokedFamilies.length).toBe(1);
    expect(await store.read(account)).toBeNull();
    expect(await store.read(mcpOAuthClientAccount(fx.mcpUrl))).not.toBeNull(); // the registration is KEPT
  });

  test("no refresh token -> needs_auth with no request at all", async () => {
    const fx = fixture({ refreshTokens: false });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const posts = fx.tokenPosts.length;
    expect(await refreshMcpOAuthToken({ account: mcpOAuthTokenAccount(fx.mcpUrl), store })).toEqual({ ok: false, reason: "needs_auth" });
    expect(fx.tokenPosts.length).toBe(posts);
  });

  test("invalid_client clears the REGISTRATION (the next sign-in registers afresh)", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const clientAccount = mcpOAuthClientAccount(fx.mcpUrl);
    const client = (await readClientRecord(store, clientAccount))!;
    await store.write(clientAccount, JSON.stringify({ ...client, clientId: "forgotten-by-the-as" }));
    expect(await refreshMcpOAuthToken({ account: mcpOAuthTokenAccount(fx.mcpUrl), store })).toEqual({ ok: false, reason: "needs_auth" });
    expect(await store.read(clientAccount)).toBeNull();
  });

  test("an authorization server that is down is `transient`, and nothing is cleared", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    fx.close();
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    expect(await refreshMcpOAuthToken({ account, store })).toEqual({ ok: false, reason: "transient" });
    expect(await store.read(account)).not.toBeNull();
  });

  test("a step-up scope is recorded on the registration and the NEXT sign-in asks for it", async () => {
    const fx = fixture({ scopesSupported: ["read", "admin"] });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store, { oauth: { scopes: ["read"] } });
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    expect(await refreshMcpOAuthToken({ account, store, stepUpScope: "read admin" })).toEqual({ ok: false, reason: "needs_auth" });
    expect((await readClientRecord(store, mcpOAuthClientAccount(fx.mcpUrl)))!.stepUpScope).toBe("read admin");
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store, oauth: { scopes: ["read"] } });
    expect(new URL(login.authUrl).searchParams.get("scope")!.split(" ").sort()).toEqual(["admin", "read"]);
    await fx.approve(login.authUrl);
    expect(await login.done).toEqual({ ok: true });
    expect((await readTokenRecord(store, account))!.scope).toBe("read admin");
  });

  test("NO SECRET in any log line across sign-in, refresh, reuse and failure", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    const stale = (await readTokenRecord(store, account))!;
    const seen = await secretsIn(store);
    await refreshMcpOAuthToken({ account, store });
    seen.push(...(await secretsIn(store)));
    await writeTokenRecord(store, account, { ...stale, generation: 9 });
    await refreshMcpOAuthToken({ account, store });
    expect(logged.length).toBeGreaterThan(0); // the reuse was logged -- by account and code
    for (const line of logged) for (const secret of seen) expect(line.includes(secret)).toBe(false);
  });
});

describe("revoke: best effort, then the local sign-out", () => {
  test("revokes refresh then access at the AS, removes the token item, KEEPS the registration", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    const record = (await readTokenRecord(store, account))!;
    await revokeMcpOAuth({ account, store });
    expect(fx.revokedViaEndpoint).toEqual([record.refreshToken!, record.accessToken]);
    expect(await store.read(account)).toBeNull();
    expect(await store.read(mcpOAuthClientAccount(fx.mcpUrl))).not.toBeNull();
  });

  test("--forget-client also removes the registration", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await revokeMcpOAuth({ account: mcpOAuthTokenAccount(fx.mcpUrl), store, forgetClient: true });
    expect(store.entries.size).toBe(0);
  });

  test("an AS with no revocation endpoint, or one that is down, still signs out locally", async () => {
    const fx = fixture({ revocation: false });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await revokeMcpOAuth({ account: mcpOAuthTokenAccount(fx.mcpUrl), store });
    expect(fx.log.some((l) => l.includes("/revoke"))).toBe(false);
    expect(await store.read(mcpOAuthTokenAccount(fx.mcpUrl))).toBeNull();

    const down = fixture();
    const store2 = createMemoryMcpOAuthStore();
    await signIn(down, store2);
    down.close();
    await revokeMcpOAuth({ account: mcpOAuthTokenAccount(down.mcpUrl), store: store2 });
    expect(await store2.read(mcpOAuthTokenAccount(down.mcpUrl))).toBeNull();
  });
});
