// The live WS-25 bug, at the seam it was found on: a HOST-BROKERED session (`onCredentialResolve` set, so
// `hostCredentials: true`) whose MCP config names a signed-in OAuth http server. The runtime used to start
// that server's connect -- and so the `credential_resolve` for its token -- BEFORE it wrote the `type:"init"`
// handshake, and `query()` (rightly strict) refused the session with "expected 'init' as the first frame,
// got 'control_request'". Driven here exactly as a daemon drives it: the real `query()`, the real runtime
// (the in-memory leg, i.e. `main.ts`'s own wiring), the fixture authorization server, and a host store
// serving the sign-in over `credential_resolve` / refreshing it over `mcp_oauth_refresh`.
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, splitFrames, type CredentialResolveAnswer, type McpOAuthRefreshAnswer, type SpawnedRuntimeProcess, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import { spawnEmbeddedWorker } from "../embedded-host.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { mcpOAuthTokenAccount } from "./account.ts";
import { startMcpOAuthLogin } from "./login.ts";
import { refreshMcpOAuthToken } from "./refresh.ts";
import { createMemoryMcpOAuthStore, readTokenRecord, toSessionMcpTokenRecord, writeTokenRecord, type McpOAuthStore } from "./store.ts";
import { startFixtureAs, type FixtureAs } from "./test-fixture-as.ts";

let fx: FixtureAs;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  fx = startFixtureAs();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fx.close();
  errorSpy.mockRestore();
});

async function signedIn(expired: boolean): Promise<McpOAuthStore> {
  const store = createMemoryMcpOAuthStore();
  const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
  await fx.approve(login.authUrl);
  expect(await login.done).toEqual({ ok: true });
  if (expired) {
    const account = mcpOAuthTokenAccount(fx.mcpUrl);
    await writeTokenRecord(store, account, { ...(await readTokenRecord(store, account))!, expiresAt: Date.now() - 1000 });
  }
  return store;
}

/** Wraps a runtime process so the RAW stdout is recorded: `query()` swallows the handshake, and frame ORDER is the point. */
function teeStdout(proc: SpawnedRuntimeProcess, raw: WinterFrame[]): SpawnedRuntimeProcess {
  const stdout = proc.stdout;
  let carry = "";
  return {
    ...proc,
    stdout: (async function* () {
      for await (const chunk of stdout) {
        const split = splitFrames(String(chunk), carry);
        carry = split.carry;
        raw.push(...split.frames);
        yield chunk;
      }
    })(),
  };
}

const TEMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TEMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  /** Every frame the runtime wrote, in order, as the host's transport saw it. */
  raw: WinterFrame[];
  messages: Array<{ type: string; subtype?: string; mcp_servers?: Array<{ name: string; status: string }>; message?: { content?: Array<{ content?: unknown }> } }>;
  resolves: string[];
  refreshes: number;
}

async function runBrokered(name: string, store: McpOAuthStore, server: Record<string, unknown>, env: Record<string, string> = {}): Promise<Run> {
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  const raw: WinterFrame[] = [];
  const resolves: string[] = [];
  let refreshes = 0;
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: `mcp__${name}__whoami`, input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const q = query({
    prompt: "go",
    options: {
      model: "winter-test/echo",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolSearchEnabled: false,
      strictMcpConfig: true,
      settingSources: [],
      mcpServers: { [name]: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy", ...server } as never },
      // THE DAEMON's credential door: the sign-in, refresh token masked, and nothing else.
      onCredentialResolve: async (req): Promise<CredentialResolveAnswer> => {
        resolves.push(req.ref.account);
        const stored = req.ref.account === account ? await store.read(account) : null;
        return stored !== null ? { ok: true, material: toSessionMcpTokenRecord(stored), generation: 1 } : { ok: false, reason: "not_allowed" };
      },
      onMcpOAuthRefresh: async (req): Promise<McpOAuthRefreshAnswer> => {
        refreshes += 1;
        const result = await refreshMcpOAuthToken({ account: req.account, store, generation: req.generation });
        return result.ok ? { ok: true } : result;
      },
      spawnClaudeCodeProcess: (opts) => teeStdout(inMemoryProcess(opts.args, provider, undefined, env), raw),
    },
  });
  const messages: Run["messages"] = [];
  for await (const m of q) messages.push(m as Run["messages"][number]);
  return { raw, messages, resolves, refreshes };
}

function expectHealthySession(run: Run, name: string): void {
  // The handshake is the FIRST frame, and nothing the runtime asks the host precedes it.
  expect(run.raw[0]?.type).toBe("init");
  expect(run.raw.filter((f) => f.type === "init").length).toBe(1);
  // The sign-in was read through the host, never a Keychain.
  expect(run.resolves).toContain(mcpOAuthTokenAccount(fx.mcpUrl));
  // The tool listed, and the authenticated call came back.
  const init = run.messages.find((m) => m.type === "system" && m.subtype === "init");
  expect(init?.mcp_servers?.find((s) => s.name === name)?.status).toBe("connected");
  const toolResult = run.messages.find((m) => m.type === "user");
  expect(String(toolResult?.message?.content?.[0]?.content ?? "")).toBe("PONG-ok-read");
}

test("a signed-in OAuth server at START: init is the first frame, the token is host-resolved, the tool call runs", async () => {
  const run = await runBrokered("brk-start", await signedIn(false), {});
  expectHealthySession(run, "brk-start");
  expect(run.refreshes).toBe(0);
}, 20_000);

test("an EXPIRED sign-in at start: init first, then the host refreshes over mcp_oauth_refresh, and the call runs", async () => {
  const run = await runBrokered("brk-expired", await signedIn(true), {});
  expectHealthySession(run, "brk-expired");
  expect(run.refreshes).toBe(1);
  expect(fx.tokenPosts).toEqual(["authorization_code", "refresh_token"]);
}, 20_000);

// THE DEADLOCK CASES. Startup waits for an `alwaysLoad` server (or, under MCP_CONNECTION_NONBLOCKING=0, for
// the whole batch) -- and that server's connect needs a host answer. The connect deadline is set far above
// the test's own timeout, so a startup wait that sits ahead of the handshake or of the input pump (the only
// thing that routes the host's answer back) fails this test instead of silently waiting the deadline out.
const LONG_CONNECT_DEADLINE = { MCP_CONNECT_TIMEOUT_MS: "120000" };

test("an alwaysLoad OAuth server whose connect needs the host: no deadlock -- init first, connected before system/init", async () => {
  const started = Date.now();
  const run = await runBrokered("brk-always", await signedIn(false), { alwaysLoad: true }, LONG_CONNECT_DEADLINE);
  expectHealthySession(run, "brk-always");
  expect(Date.now() - started).toBeLessThan(10_000);
}, 15_000);

test("an alwaysLoad OAuth server with an EXPIRED sign-in (credential_resolve AND mcp_oauth_refresh at connect): no deadlock", async () => {
  const run = await runBrokered("brk-always-exp", await signedIn(true), { alwaysLoad: true }, LONG_CONNECT_DEADLINE);
  expectHealthySession(run, "brk-always-exp");
  expect(run.refreshes).toBe(1);
}, 15_000);

test("MCP_CONNECTION_NONBLOCKING=0 with a brokered OAuth server: no deadlock -- init first, connected before system/init", async () => {
  const run = await runBrokered("brk-blocking", await signedIn(false), {}, { ...LONG_CONNECT_DEADLINE, MCP_CONNECTION_NONBLOCKING: "0" });
  expectHealthySession(run, "brk-blocking");
}, 15_000);

// THE EMBEDDED TOPOLOGY (a Bun Worker per session, how Winter runs chat and dispatch): the same engine, so the
// same gate -- proven on a real Worker rather than assumed. A Worker cannot be handed a scripted provider, so
// this session makes no tool call; what it proves is the start: init first, the sign-in resolved through the
// host, and the server connected in `system/init`, for both an ordinary and an `alwaysLoad` server.
test("embedded Worker: a host-brokered OAuth server at start -- init first, connected, no deadlock under alwaysLoad", async () => {
  const store = await signedIn(false);
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  for (const server of [{}, { alwaysLoad: true }]) {
    const raw: WinterFrame[] = [];
    const resolves: string[] = [];
    const home = mkdtempSync(join(tmpdir(), "winter-brokered-embedded-"));
    TEMP_ROOTS.push(home);
    const messages: Run["messages"] = [];
    const q = query({
      prompt: "hi",
      options: {
        model: "winter-test/echo",
        cwd: home,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", ...LONG_CONNECT_DEADLINE },
        strictMcpConfig: true,
        settingSources: [],
        mcpServers: { brkembed: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy", ...server } as never },
        onCredentialResolve: async (req): Promise<CredentialResolveAnswer> => {
          resolves.push(req.ref.account);
          const stored = req.ref.account === account ? await store.read(account) : null;
          return stored !== null ? { ok: true, material: toSessionMcpTokenRecord(stored), generation: 1 } : { ok: false, reason: "not_allowed" };
        },
        spawnClaudeCodeProcess: (o) => teeStdout(spawnEmbeddedWorker({ workerEntry: join(import.meta.dir, "..", "embedded-worker.ts"), spawn: o }), raw),
      },
    });
    for await (const m of q) messages.push(m as Run["messages"][number]);
    expect(raw[0]?.type).toBe("init");
    expect(resolves).toContain(account);
    const init = messages.find((m) => m.type === "system" && m.subtype === "init");
    expect([JSON.stringify(server), init?.mcp_servers?.find((s) => s.name === "brkembed")?.status]).toEqual([JSON.stringify(server), "connected"]);
  }
}, 30_000);
