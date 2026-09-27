// WS-25 through a REAL engine: `EngineOptions.mcpOAuthStore` wires the session's sign-ins, the runtime
// asks the HOST over its own control bridge (`mcp_oauth_refresh`), and a host with no handler leaves the
// session to refresh in-process. The host side here is the in-memory channel, answering like a daemon.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { mcpOAuthTokenAccount } from "./account.ts";
import { startMcpOAuthLogin } from "./login.ts";
import { refreshMcpOAuthToken } from "./refresh.ts";
import { createMemoryMcpOAuthStore, readTokenRecord, writeTokenRecord, type McpOAuthStore } from "./store.ts";
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

async function signedInThenExpired(): Promise<McpOAuthStore> {
  const store = createMemoryMcpOAuthStore();
  const login = await startMcpOAuthLogin({ serverUrl: fx.mcpUrl, store });
  await fx.approve(login.authUrl);
  expect(await login.done).toEqual({ ok: true });
  const account = mcpOAuthTokenAccount(fx.mcpUrl);
  await writeTokenRecord(store, account, { ...(await readTokenRecord(store, account))!, expiresAt: Date.now() - 1000 });
  return store;
}

// DEFAULT startup (nonblocking, no alwaysLoad): the refresh ask is answered because the input pump is
// already reading by the first-turn wait. An `alwaysLoad` server that must refresh AT connect used to wait
// out the batch deadline (startup awaited it before the pump); it no longer does -- the engine launches the
// connects, writes the handshake, starts the pump, and only then awaits them. That case, and the host-
// brokered token read ahead of the handshake, are pinned through `query()` in brokered-init-order.test.ts.
/** One session whose model calls `mcp__<name>__whoami`; `answer` is how the host treats `mcp_oauth_refresh`. */
async function runSession(name: string, store: McpOAuthStore, answer: "refresh" | "unhandled"): Promise<{ asks: ControlRequestFrame[]; toolText: string }> {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: `mcp__${name}__whoami`, input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const config: RuntimeConfig = { sessionId: `ws25-${name}`, cwd: "/tmp/x", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, toolSearchEnabled: false, mcpServers: { [name]: { type: "http", url: fx.mcpUrl, versionNegotiation: "legacy" } } };
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, mcpOAuthStore: store });
  host.output.write({ type: "user", text: "go" });
  const asks: ControlRequestFrame[] = [];
  const seen: WinterFrame[] = [];
  let ended = false;
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "mcp_oauth_refresh") {
      const req = f as ControlRequestFrame;
      asks.push(req);
      if (answer === "unhandled") {
        host.output.write({ type: "control_response", requestId: req.requestId, ok: false, error: { code: "unhandled_subtype", message: "no handler" } });
      } else {
        const p = req.payload as { account: string; generation: number };
        const result = await refreshMcpOAuthToken({ account: p.account, store, generation: p.generation });
        host.output.write({ type: "control_response", requestId: req.requestId, ok: true, payload: result.ok ? { ok: true } : result });
      }
    }
    if (!ended && f.type === "data" && (f as { message: { type: string } }).message.type === "result") {
      ended = true;
      host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    }
  }
  await done;
  const toolResult = seen
    .filter((f) => f.type === "data")
    .map((f) => (f as { message: { type: string; message?: { content?: Array<{ content?: unknown }> } } }).message)
    .find((m) => m.type === "user");
  return { asks, toolText: String(toolResult?.message?.content?.[0]?.content ?? "") };
}

test("an expired sign-in: the engine asks the HOST (payload names only), the host refreshes, the tool call runs", async () => {
  const store = await signedInThenExpired();
  const { asks, toolText } = await runSession("oauth-engine-a", store, "refresh");
  expect(asks.length).toBe(1);
  expect(asks[0]!.payload).toEqual({ server: "oauth-engine-a", account: mcpOAuthTokenAccount(fx.mcpUrl), generation: 1 });
  expect(JSON.stringify(asks[0]!.payload)).not.toContain("rt-");
  expect(toolText).toBe("PONG-ok-read");
  expect(fx.tokenPosts).toEqual(["authorization_code", "refresh_token"]);
}, 20_000);

test("a host that answers unhandled_subtype: the session refreshes IN-PROCESS and the call still runs", async () => {
  const store = await signedInThenExpired();
  const { asks, toolText } = await runSession("oauth-engine-b", store, "unhandled");
  expect(asks.length).toBe(1);
  expect(toolText).toBe("PONG-ok-read");
  expect(fx.tokenPosts).toEqual(["authorization_code", "refresh_token"]);
}, 20_000);
