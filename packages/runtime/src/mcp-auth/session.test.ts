// WS-25 §1.2 / §1.3 at the SESSION: the read-only provider inside a real MCP lifecycle, against the
// fixture authorization server and the MCP server it protects. Every test proves what did NOT happen as
// much as what did -- no refresh of a usable token, no request at all for a dead sign-in.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { McpOAuthRefreshAnswer, McpOAuthRefreshRequest } from "@yanlinglabs/winter-agent-sdk";
import { getRegisteredTool } from "../tools/registry.ts";
import { createElicitationAsker } from "../mcp/elicitation.ts";
import { parseMcpEnvConfig } from "../mcp/env.ts";
import { createMcpLifecycle, type McpLifecycle } from "../mcp/lifecycle.ts";
import { mcpOAuthTokenAccount } from "./account.ts";
import { mcpNeedsAuthAttachment, needsAuthToolHint } from "./engine-wiring.ts";
import { startMcpOAuthLogin } from "./login.ts";
import { refreshMcpOAuthToken } from "./refresh.ts";
import { mcpSignInHint, type McpOAuthHostAsk } from "./session-provider.ts";
import { createHostBrokeredMcpOAuthStore, createMemoryMcpOAuthStore, MCP_OAUTH_HOST_HELD_REFRESH_TOKEN, readTokenRecord, toSessionMcpTokenRecord, writeTokenRecord, type McpOAuthStore } from "./store.ts";
import { startFixtureAs, type FixtureAs, type FixtureAsOptions } from "./test-fixture-as.ts";
import { renderAttachment } from "../context/attachments.ts";

const BRAND = { homeDirName: ".winter", productName: "Winter" };
const fixtures: FixtureAs[] = [];
const lifecycles: McpLifecycle[] = [];
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let counter = 0;

beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const l of lifecycles.splice(0)) await l.dispose();
  for (const f of fixtures.splice(0)) f.close();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

function fixture(opts: FixtureAsOptions = {}): FixtureAs {
  const f = startFixtureAs(opts);
  fixtures.push(f);
  return f;
}

async function signIn(fx: FixtureAs, store: McpOAuthStore): Promise<void> {
  const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
  await fx.approve(login.authUrl);
  expect(await login.done).toEqual({ ok: true });
}

/** A host that refreshes through the real door (single-flight, generation) and records every ask. */
function fakeHost(store: McpOAuthStore, override?: (req: McpOAuthRefreshRequest) => McpOAuthRefreshAnswer | "unhandled" | undefined): { askHost: McpOAuthHostAsk; asks: McpOAuthRefreshRequest[] } {
  const asks: McpOAuthRefreshRequest[] = [];
  return {
    asks,
    askHost: async (req) => {
      asks.push(req);
      const forced = override?.(req);
      if (forced !== undefined) return forced;
      const result = await refreshMcpOAuthToken({ account: req.account, store, generation: req.generation, ...(req.stepUpScope !== undefined ? { stepUpScope: req.stepUpScope } : {}) });
      return result.ok ? { ok: true } : result;
    },
  };
}

async function session(fx: FixtureAs, store: McpOAuthStore, askHost?: McpOAuthHostAsk): Promise<{ lifecycle: McpLifecycle; name: string }> {
  const name = `oauth-${++counter}`;
  const lifecycle = createMcpLifecycle({
    servers: [{ name, origin: "explicit", config: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy" } }],
    envConfig: parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "0", MCP_TIMEOUT: "5000", MCP_CONNECT_TIMEOUT_MS: "5000" }),
    elicitationAsk: createElicitationAsker(undefined),
    oauth: { store, ...(askHost !== undefined ? { askHost } : {}), signInHint: (server) => mcpSignInHint(BRAND, server) },
  });
  lifecycles.push(lifecycle);
  await lifecycle.start();
  return { lifecycle, name };
}

function stateOf(lifecycle: McpLifecycle, name: string) {
  return lifecycle.stateSource.snapshot().find((s) => s.name === name)!;
}

async function expire(store: McpOAuthStore, fx: FixtureAs, opts: { dropRefresh?: boolean } = {}): Promise<void> {
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  const record = (await readTokenRecord(store, account))!;
  const { refreshToken, ...rest } = record;
  await writeTokenRecord(store, account, { ...rest, ...(opts.dropRefresh === true ? {} : refreshToken !== undefined ? { refreshToken } : {}), expiresAt: Date.now() - 1000 });
}

describe("startup (spec §1.2, exactly)", () => {
  test("a usable stored token connects and lists the tools -- and is NEVER refreshed at connect", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const host = fakeHost(store);
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "connected", toolNames: ["whoami", "step_up"] });
    expect(host.asks).toEqual([]);
    expect(fx.tokenPosts).toEqual(["authorization_code"]);
  });

  test("no `expiresAt` (no expires_in): valid until the server says 401 -- no refresh", async () => {
    const fx = fixture({ accessTokenTtlSec: null });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    expect((await readTokenRecord(store, mcpOAuthTokenAccount(fx.mcpUrl)))!.expiresAt).toBeUndefined();
    const host = fakeHost(store);
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name).state).toBe("connected");
    expect(host.asks).toEqual([]);
  });

  test("expired WITH a refresh token: the HOST is asked once, then it connects on the new token", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await expire(store, fx);
    const host = fakeHost(store);
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name).state).toBe("connected");
    expect(host.asks.map((a) => ({ server: a.server, account: a.account, generation: a.generation }))).toEqual([{ server: name, account: mcpOAuthTokenAccount(fx.mcpUrl), generation: 1 }]);
    expect(fx.tokenPosts).toEqual(["authorization_code", "refresh_token"]);
  });

  test("expired WITHOUT a refresh token: needs-auth at once -- no refresh, no host ask, no request to the server", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await expire(store, fx, { dropRefresh: true });
    const host = fakeHost(store);
    const before = fx.mcpRequests;
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "needsAuth", errorCode: "needs_auth", toolNames: [] });
    expect(fx.mcpRequests).toBe(before);
    expect(host.asks).toEqual([]);
    expect(fx.tokenPosts).toEqual(["authorization_code"]);
    expect(getRegisteredTool(`mcp__${name}__whoami`)).toBeUndefined();
    expect(stateOf(lifecycle, name).error).toContain(`winter mcp login ${name}`);
  });

  test("a refresh the host answers needs_auth (invalid_grant) -> needs-auth", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await expire(store, fx);
    const host = fakeHost(store, () => ({ ok: false, reason: "needs_auth" }));
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name).state).toBe("needsAuth");
  });

  test("a refresh the host answers transient -> failed (auth_refresh_failed), NOT needs-auth", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await expire(store, fx);
    const host = fakeHost(store, () => ({ ok: false, reason: "transient" }));
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "failed", errorCode: "auth_refresh_failed" });
  });

  test("never signed in: the server's 401 is needs-auth and no tool is registered", async () => {
    const fx = fixture();
    const { lifecycle, name } = await session(fx, createMemoryMcpOAuthStore(), fakeHost(createMemoryMcpOAuthStore()).askHost);
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "needsAuth", errorCode: "needs_auth" });
    expect(getRegisteredTool(`mcp__${name}__whoami`)).toBeUndefined();
  });

  test("a host with NO handler ('unhandled'): the session refreshes in-process (the standalone SDK case)", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await expire(store, fx);
    const host = fakeHost(store, () => "unhandled");
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name).state).toBe("connected");
    expect(host.asks.length).toBe(1);
    expect(fx.tokenPosts).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("fix round 1: expiry margin and the preflight bound", () => {
  test("M3: a short-lived token (expires_in 30 s) is refreshed ONCE, not on every request", async () => {
    const fx = fixture({ accessTokenTtlSec: 30 });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const host = fakeHost(store);
    const { name } = await session(fx, store, host.askHost);
    for (let i = 0; i < 3; i++) expect(await getRegisteredTool(`mcp__${name}__whoami`)!.executor!.execute({}, {} as never)).toEqual({ output: "PONG-ok-read" });
    expect(fx.tokenPosts.filter((g) => g === "refresh_token")).toEqual(["refresh_token"]);
  });

  test("M3: WITHOUT a refresh token the margin does not apply -- a token 30 s from expiry is still used", async () => {
    const fx = fixture({ accessTokenTtlSec: 30, refreshTokens: false });
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const { lifecycle, name } = await session(fx, store, fakeHost(store).askHost);
    expect(stateOf(lifecycle, name).state).toBe("connected");
  });

  test("M1: a host that never answers the refresh ask cannot stretch the connect budget", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    await expire(store, fx);
    const name = `oauth-${++counter}`;
    const lifecycle = createMcpLifecycle({
      servers: [{ name, origin: "explicit", config: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy" } }],
      envConfig: parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "0", MCP_TIMEOUT: "300", MCP_CONNECT_TIMEOUT_MS: "3000" }),
      elicitationAsk: createElicitationAsker(undefined),
      oauth: { store, askHost: () => new Promise(() => {}), signInHint: (server) => mcpSignInHint(BRAND, server) },
    });
    lifecycles.push(lifecycle);
    const started = Date.now();
    await lifecycle.start();
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "failed", errorCode: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("§7: a HOST-BROKERED session's MCP sign-ins (no Keychain, no refresh token in the session)", () => {
  /** The child's store: every read is a `credential_resolve` the host answers from ITS store, refresh token masked. */
  function brokered(hostStore: McpOAuthStore): { store: McpOAuthStore; served: string[] } {
    const served: string[] = [];
    const sender = {
      async request<T>(subtype: string, payload: unknown): Promise<T> {
        expect(subtype).toBe("credential_resolve");
        const raw = await hostStore.read((payload as { ref: { account: string } }).ref.account);
        if (raw === null) return { ok: false, reason: "not_found" } as T;
        const material = toSessionMcpTokenRecord(raw);
        served.push(material);
        return { ok: true, material, generation: 1 } as T;
      },
    };
    return { store: createHostBrokeredMcpOAuthStore(sender), served };
  }

  test("expired with a (host-held) refresh token: the host refreshes, the session re-reads, connects -- and never saw a refresh token", async () => {
    const fx = fixture();
    const hostStore = createMemoryMcpOAuthStore();
    await signIn(fx, hostStore);
    await expire(hostStore, fx);
    const { store, served } = brokered(hostStore);
    const host = fakeHost(hostStore);
    const name = `oauth-${++counter}`;
    const lifecycle = createMcpLifecycle({
      servers: [{ name, origin: "explicit", config: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy" } }],
      envConfig: parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "0", MCP_TIMEOUT: "5000" }),
      elicitationAsk: createElicitationAsker(undefined),
      oauth: { store, askHost: host.askHost, hostOwnsRefresh: true, signInHint: (server) => mcpSignInHint(BRAND, server) },
    });
    lifecycles.push(lifecycle);
    await lifecycle.start();
    expect(stateOf(lifecycle, name).state).toBe("connected");
    expect(host.asks.length).toBe(1);
    const realRefresh = (await readTokenRecord(hostStore, mcpOAuthTokenAccount(fx.mcpUrl)))!.refreshToken!;
    expect(served.length).toBeGreaterThan(0);
    for (const m of served) {
      expect(JSON.parse(m).refreshToken).toBe(MCP_OAUTH_HOST_HELD_REFRESH_TOKEN);
      expect(m).not.toContain(realRefresh);
    }
  });

  test("a host that does not answer the refresh is `transient` -- the session never refreshes in-process", async () => {
    const fx = fixture();
    const hostStore = createMemoryMcpOAuthStore();
    await signIn(fx, hostStore);
    await expire(hostStore, fx);
    const { store } = brokered(hostStore);
    const name = `oauth-${++counter}`;
    const lifecycle = createMcpLifecycle({
      servers: [{ name, origin: "explicit", config: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy" } }],
      envConfig: parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "0", MCP_TIMEOUT: "5000" }),
      elicitationAsk: createElicitationAsker(undefined),
      oauth: { store, askHost: async () => "unhandled", hostOwnsRefresh: true, signInHint: (server) => mcpSignInHint(BRAND, server) },
    });
    lifecycles.push(lifecycle);
    await lifecycle.start();
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "failed", errorCode: "auth_refresh_failed" });
    expect(fx.tokenPosts).toEqual(["authorization_code"]);
  });
});

describe("mid-session (spec §1.3)", () => {
  test("a 401 on a call re-reads, asks the host, and the retried call succeeds on the refreshed token", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const host = fakeHost(store);
    const { name } = await session(fx, store, host.askHost);
    fx.expireAllAccessTokens(); // the server revokes the access token before its expiresAt
    const result = await getRegisteredTool(`mcp__${name}__whoami`)!.executor!.execute({}, {} as never);
    expect(result).toEqual({ output: "PONG-ok-read" });
    expect(host.asks.length).toBe(1);
  });

  test("a call that finds the sign-in GONE turns the server needs-auth, withdraws its tools and names the door", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    await signIn(fx, store);
    const host = fakeHost(store, () => ({ ok: false, reason: "needs_auth" }));
    const { lifecycle, name } = await session(fx, store, host.askHost);
    fx.expireAllAccessTokens();
    const result = await getRegisteredTool(`mcp__${name}__whoami`)!.executor!.execute({}, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(`needs sign-in`);
    expect(result.output).toContain(`winter mcp login ${name}`);
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "needsAuth", errorCode: "needs_auth" });
    expect(getRegisteredTool(`mcp__${name}__whoami`)).toBeUndefined();
    // ...and the engine's "No such tool" answer for a stale call names the door too.
    expect(needsAuthToolHint(lifecycle.stateSource.snapshot(), `mcp__${name}__whoami`, BRAND)).toContain(`winter mcp login ${name}`);
  });

  test("a 403 insufficient_scope fails only that call, and the host records the step-up scope", async () => {
    const fx = fixture({ scopesSupported: ["read", "admin"] });
    const store = createMemoryMcpOAuthStore();
    const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store, oauth: { scopes: ["read"] } });
    await fx.approve(login.authUrl);
    await login.done;
    const host = fakeHost(store);
    const { lifecycle, name } = await session(fx, store, host.askHost);
    const result = await getRegisteredTool(`mcp__${name}__step_up`)!.executor!.execute({}, {} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("needs additional permission");
    expect(result.output).toContain("scope: read admin");
    expect(stateOf(lifecycle, name).state).toBe("connected");
    await Bun.sleep(20); // the report is fire-and-forget
    expect(host.asks.some((a) => a.stepUpScope === "read admin")).toBe(true);
  });

  test("after a sign-in, reconnect (mcp_reconnect / Query.reconnectMcpServer) lists the tools -- no restart", async () => {
    const fx = fixture();
    const store = createMemoryMcpOAuthStore();
    const host = fakeHost(store);
    const { lifecycle, name } = await session(fx, store, host.askHost);
    expect(stateOf(lifecycle, name).state).toBe("needsAuth");
    await signIn(fx, store);
    await lifecycle.controlSeam.reconnect(name);
    expect(stateOf(lifecycle, name)).toMatchObject({ state: "connected", toolNames: ["whoami", "step_up"] });
    expect(await getRegisteredTool(`mcp__${name}__whoami`)!.executor!.execute({}, {} as never)).toEqual({ output: "PONG-ok-read" });
  });

  test("a config with its OWN Authorization header is left alone (no provider, no Keychain read)", async () => {
    const fx = fixture();
    const reads: string[] = [];
    const store: McpOAuthStore = { read: async (a) => (reads.push(a), null), write: async () => {}, remove: async () => {} };
    const name = `static-${++counter}`;
    const lifecycle = createMcpLifecycle({
      servers: [{ name, origin: "explicit", config: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy", headers: { Authorization: "Bearer static-not-valid" } } }],
      envConfig: parseMcpEnvConfig({ MCP_CONNECTION_NONBLOCKING: "0", MCP_TIMEOUT: "5000" }),
      elicitationAsk: createElicitationAsker(undefined),
      oauth: { store, signInHint: (s) => mcpSignInHint(BRAND, s) },
    });
    lifecycles.push(lifecycle);
    await lifecycle.start();
    expect(reads).toEqual([]);
    expect(stateOf(lifecycle, name).state).toBe("needsAuth"); // the static header is refused, as before WS-25
  });
});

describe("the needs-auth notice (a persisted attachment, announced once per change)", () => {
  test("announces the set, says nothing while it holds, and announces the all-clear", () => {
    const states = [
      { name: "linear", state: "needsAuth" as const, toolNames: [] },
      { name: "notion", state: "needsAuth" as const, toolNames: [] },
      { name: "fs", state: "connected" as const, toolNames: ["read"] },
    ];
    const first = mcpNeedsAuthAttachment(states, [], BRAND)!;
    expect(first.servers).toEqual(["linear", "notion"]);
    const text = renderAttachment(first)!;
    expect(text).toContain("linear, notion");
    expect(text).toContain("winter mcp login <server>");
    expect(text).toContain("Do not try to authenticate");
    const history = [{ role: "user", content: text, meta: { attachment: first } }] as never;
    expect(mcpNeedsAuthAttachment(states, history, BRAND)).toBeUndefined();
    const cleared = mcpNeedsAuthAttachment([{ name: "linear", state: "connected", toolNames: [] }], history, BRAND)!;
    expect(cleared.servers).toEqual([]);
    expect(renderAttachment(cleared)).toContain("signed in now");
    expect(mcpNeedsAuthAttachment([], [], BRAND)).toBeUndefined(); // nothing to say, ever, on a clean session
  });
});
