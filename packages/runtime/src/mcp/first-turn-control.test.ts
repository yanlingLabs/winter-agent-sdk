// WS-24 (engine lane, item 3): control requests are answered DURING the first-turn MCP wait.
//
// The wait (see mcp/lifecycle.ts's `firstTurnMcpWaitDeadlineMs`) used to run before the
// engine's input pump started, so every control request queued behind it -- up to MCP_TIMEOUT behind a
// hung explicit server. The pump now reads while the servers connect; a user message still waits for them.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider } from "../engine.ts";

describe("WS-24: the first-turn MCP wait does not hold control requests", () => {
  test("behind a HUNG explicit server, mcp_status answers at once while the first turn still waits out the deadline", async () => {
    // An MCP endpoint that accepts the connection and never answers: the connect can only end at its deadline.
    const hung = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const WAIT_MS = 3000;
      const started = Date.now();
      let firstGenerateAt: number | undefined;
      const provider: Provider = {
        async generate() {
          firstGenerateAt ??= Date.now() - started;
          return { kind: "text", text: "done" };
        },
      };
      const { host, runtime } = createInMemoryChannel();
      const config = { sessionId: "ws24-hung-mcp", cwd: "/winter-fixture", model: "winter-test/echo", mcpServers: { hung: { type: "http", url: `http://127.0.0.1:${hung.port}/mcp` } } } as RuntimeConfig;
      // An explicit non-sdk server asks for the LONG wait, MCP_TIMEOUT -- set short here.
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: { MCP_TIMEOUT: String(WAIT_MS) } });
      host.output.write({ type: "user", text: "hi" });
      host.output.write({ type: "control_request", requestId: "status-1", subtype: "mcp_status", payload: undefined });

      const frames: WinterFrame[] = [];
      let statusAt: number | undefined;
      const reader = (async () => {
        for await (const f of host.input) {
          frames.push(f);
          if (statusAt === undefined && f.type === "control_response" && (f as { requestId?: string }).requestId === "status-1") statusAt = Date.now() - started;
          if (f.type === "data" && (f as { message: { type: string } }).message.type === "result") host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
        }
      })();
      expect(await done).toBe(0);
      await reader;

      // The control request was answered while the server was still connecting...
      expect(statusAt).toBeDefined();
      expect(statusAt!).toBeLessThan(WAIT_MS / 2);
      const status = frames.find((f) => f.type === "control_response" && (f as { requestId?: string }).requestId === "status-1") as { payload?: { servers?: Array<{ name: string; status: string }> } };
      expect(status.payload?.servers).toEqual([{ name: "hung", status: "pending" }]);
      // ...and AFTER the handshake, which is still frame one.
      expect(frames[0]!.type).toBe("init");
      // The user message still waited for the servers: the first request went out only once the wait ended.
      expect(firstGenerateAt).toBeDefined();
      expect(firstGenerateAt!).toBeGreaterThanOrEqual(WAIT_MS - 250);
    } finally {
      hung.stop(true);
    }
  }, 30_000);

  test("with nothing pending there is no wait and system/init still directly follows the handshake", async () => {
    const { host, runtime } = createInMemoryChannel();
    const config = { sessionId: "ws24-no-wait", cwd: "/winter-fixture", model: "winter-test/echo", mcpServers: { probe: { type: "sdk", name: "probe", tools: [{ name: "echo", inputSchema: { type: "object" } }] } } } as RuntimeConfig;
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: { generate: async () => ({ kind: "text", text: "ok" }) } });
    host.output.write({ type: "control_request", requestId: "status-1", subtype: "mcp_status", payload: undefined });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    const frames: WinterFrame[] = [];
    for await (const f of host.input) frames.push(f);
    expect(await done).toBe(0);
    expect(frames[0]!.type).toBe("init");
    expect(frames[1]!.type).toBe("data");
    expect((frames[1] as { message: { subtype?: string } }).message.subtype).toBe("init");
  });
});
