// The live WS-25 reconnect bug (Winter dev daemon, 2026-09-27): a HOST-BROKERED session (`onCredentialResolve`
// set, so `hostCredentials: true`) connected to a signed-in OAuth http server; the user signed out, then in
// again, and the host asked the live session to reconnect the server each time (`Query.reconnectMcpServer`,
// the runtime's `mcp_reconnect`). Both reconnects failed after exactly MCP_TIMEOUT (30 s), one behind the
// other, and the tools never came back.
//
// THE MECHANISM: the engine's input pump -- the ONLY reader of host->runtime frames -- awaited the reconnect
// INLINE. A brokered reconnect's preflight reads the sign-in over `credential_resolve`, whose answer is a
// `control_response` only that same pump routes back, so the answer sat unread until the preflight's own
// bound fired ("the sign-in check exceeded ..."), the slot went `failed` (not `needsAuth`), and every later
// control request -- the sign-in's reconnect included -- queued behind it and deadlocked the same way. The
// same class as the startup deadlock `brokered-init-order.test.ts` pins; that fix moved the startup wait
// below the pump, but the mutating MCP control subtypes still blocked it.
//
// Driven exactly as a daemon drives it: the real `query()` with STREAMING input (a live session between
// turns), the real runtime over the in-memory leg (`main.ts`'s own wiring), the fixture authorization
// server, and a host store serving the sign-in over `credential_resolve`.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { query, type CredentialResolveAnswer } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { mcpOAuthTokenAccount } from "./account.ts";
import { startMcpOAuthLogin } from "./login.ts";
import { createMemoryMcpOAuthStore, toSessionMcpTokenRecord, type McpOAuthStore } from "./store.ts";
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

async function signIn(store: McpOAuthStore): Promise<void> {
  const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
  await fx.approve(login.authUrl);
  expect(await login.done).toEqual({ ok: true });
}

// Short enough that the pre-fix deadlock fails this test in seconds (not 30 s), long enough for a real
// loopback connect. The fingerprint of the deadlock is the preflight's own timeout text.
const SHORT_TIMEOUT = { MCP_TIMEOUT: "3000" };
const DEADLOCK_FINGERPRINT = "sign-in check exceeded";

test("a brokered session: sign-out -> reconnect is needs-auth (fast), sign-in -> reconnect connects and the tool runs again", async () => {
  const name = "brk-reconnect";
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  const store = createMemoryMcpOAuthStore();
  await signIn(store);
  let generation = 1;
  const resolves: string[] = [];
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: `mcp__${name}__whoami`, input: {} }] },
    { kind: "text", text: "first done" },
    { kind: "tool_use", calls: [{ id: "c2", name: `mcp__${name}__whoami`, input: {} }] },
    { kind: "text", text: "second done" },
  ]);
  let releaseFirst!: () => void;
  const afterFirst = new Promise<void>((resolve) => (releaseFirst = resolve));
  let releaseSecond!: () => void;
  const afterSecond = new Promise<void>((resolve) => (releaseSecond = resolve));
  async function* prompt() {
    yield "first";
    await afterFirst;
    yield "second";
    await afterSecond;
  }
  const q = query({
    prompt: prompt(),
    options: {
      model: "winter-test/echo",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolSearchEnabled: false,
      strictMcpConfig: true,
      settingSources: [],
      mcpServers: { [name]: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy" } as never },
      // THE DAEMON's credential door: the stored sign-in (refresh token masked), `not_found` once signed out.
      onCredentialResolve: async (req): Promise<CredentialResolveAnswer> => {
        resolves.push(req.ref.account);
        if (req.ref.account !== account) return { ok: false, reason: "not_allowed" };
        const stored = await store.read(account);
        return stored !== null ? { ok: true, material: toSessionMcpTokenRecord(stored), generation } : { ok: false, reason: "not_found" };
      },
      spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider, undefined, SHORT_TIMEOUT),
    },
  });

  const toolOutputs: string[] = [];
  const outcome: { signOut?: { ms: number; error?: string }; signIn?: { ms: number; error?: string } } = {};
  // The host's side of a sign-out then a sign-in, run beside the read loop (every control answer arrives
  // through that loop, so it must never be blocked on one).
  const hostSequence = async (): Promise<void> => {
    // Sign-out: the host deletes the sign-in, then asks the live session to reconnect.
    await store.remove(account);
    generation++;
    let t0 = Date.now();
    try {
      await q.reconnectMcpServer!(name);
      outcome.signOut = { ms: Date.now() - t0 };
    } catch (err) {
      outcome.signOut = { ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
    // Sign-in: a fresh token, then the reconnect that must bring the tools back.
    await signIn(store);
    generation++;
    t0 = Date.now();
    try {
      await q.reconnectMcpServer!(name);
      outcome.signIn = { ms: Date.now() - t0 };
    } catch (err) {
      outcome.signIn = { ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
    releaseFirst();
  };
  let results = 0;
  let host: Promise<void> | undefined;
  for await (const m of q) {
    const msg = m as { type: string; message?: { content?: Array<{ content?: unknown }> } };
    if (msg.type === "user") toolOutputs.push(String(msg.message?.content?.[0]?.content ?? ""));
    if (msg.type !== "result") continue;
    results++;
    if (results === 1) host = hostSequence();
    if (results === 2) releaseSecond();
  }
  await host;

  // Turn 1 ran on the original sign-in.
  expect(toolOutputs[0]).toBe("PONG-ok-read");
  // Sign-out: the reconnect REJECTS -- and says the server needs a sign-in, promptly; never the deadlock's
  // preflight timeout.
  expect(outcome.signOut?.error).toBeDefined();
  expect(outcome.signOut?.error ?? "").not.toContain(DEADLOCK_FINGERPRINT);
  expect(outcome.signOut!.ms).toBeLessThan(2_000);
  // Sign-in: the reconnect RESOLVES (connected), promptly.
  expect(outcome.signIn).toEqual({ ms: expect.any(Number) });
  expect(outcome.signIn!.ms).toBeLessThan(2_000);
  // Turn 2's call on the same live session runs on the NEW sign-in.
  expect(toolOutputs[1]).toBe("PONG-ok-read");
  // Every read of the sign-in went through the host.
  expect(resolves.filter((a) => a === account).length).toBeGreaterThanOrEqual(3);
}, 30_000);
