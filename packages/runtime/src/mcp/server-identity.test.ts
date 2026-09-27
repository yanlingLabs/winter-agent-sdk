// WS-27: which MCP server a tool call is for, stated exactly -- `winter_mcp_server` on the PreToolUse /
// PostToolUse / PostToolUseFailure hook input (`mcpServer` on the runtime's hook request) and `mcpServer` on
// the `permission` request `canUseTool` answers. Driven through a real engine with real HTTP MCP servers: an
// explicit (host) server, a plugin's server (registered under the raw name its `.mcp.json` declares), a tool
// that states `readOnlyHint` and one with no annotations at all. The renamed subagent server is pinned in
// subagents/child-engine.test.ts beside the other rename tests.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { withHttpFixture, type FixtureServerSpec } from "./test-fixtures.ts";

const spec: FixtureServerSpec = {
  tools: [
    { name: "look", description: "reads", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: () => ({ content: [{ type: "text", text: "LOOK" }] }) },
    { name: "bare", description: "no annotations", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "BARE" }] }) },
  ],
  resources: [],
};

test("hook and permission requests name the called tool's server: explicit and plugin servers, readOnlyHint only when stated", async () => {
  await withHttpFixture(spec, async (hostUrl) => {
    await withHttpFixture(spec, async (pluginUrl) => {
      const provider = scriptedProvider([
        {
          kind: "tool_use",
          calls: [
            { id: "c1", name: "mcp__hostsrv__look", input: {} },
            { id: "c2", name: "mcp__hostsrv__bare", input: {} },
            { id: "c3", name: "mcp__plugsrv__look", input: {} },
          ],
        },
        { kind: "text", text: "done" },
      ]);
      const config = {
        sessionId: `ws27-identity-${randomUUID()}`,
        cwd: "/winter-fixture",
        model: "winter-test/echo",
        toolSearchEnabled: false,
        mcpServers: { hostsrv: { type: "http", url: hostUrl.href } },
        hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }], PostToolUse: [{ hookCount: 1, source: "sdk" }] },
      } as RuntimeConfig;
      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config,
        input: runtime.input,
        output: runtime.output,
        provider,
        // A plugin's servers arrive as their own `plugin`-origin source, keyed by the raw names its `.mcp.json` declares.
        extraMcpServerSources: [{ origin: "plugin", servers: { plugsrv: { type: "http", url: pluginUrl.href } } }],
        env: { MCP_CONNECTION_NONBLOCKING: "0" },
      });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      const hooks: Array<{ event: string; toolName: string; mcpServer?: unknown }> = [];
      const permissions: Array<{ toolName: string; mcpServer?: unknown }> = [];
      const frames: WinterFrame[] = [];
      for await (const f of host.input) {
        frames.push(f);
        if (f.type !== "control_request") continue;
        const cf = f as ControlRequestFrame;
        if (cf.subtype === "hook") {
          const p = cf.payload as { event: string; toolName: string; mcpServer?: unknown };
          hooks.push({ event: p.event, toolName: p.toolName, ...("mcpServer" in p ? { mcpServer: p.mcpServer } : {}) });
          host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
        } else if (cf.subtype === "permission") {
          const p = cf.payload as { toolName: string; mcpServer?: unknown };
          permissions.push({ toolName: p.toolName, ...("mcpServer" in p ? { mcpServer: p.mcpServer } : {}) });
          host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { behavior: "allow" } });
        }
      }
      expect(await done).toBe(0);

      const hostLook = { name: "hostsrv", configName: "hostsrv", readOnlyHint: true };
      const hostBare = { name: "hostsrv", configName: "hostsrv" };
      const plugLook = { name: "plugsrv", configName: "plugsrv", readOnlyHint: true };
      expect(hooks).toEqual([
        { event: "PreToolUse", toolName: "mcp__hostsrv__look", mcpServer: hostLook },
        { event: "PostToolUse", toolName: "mcp__hostsrv__look", mcpServer: hostLook },
        { event: "PreToolUse", toolName: "mcp__hostsrv__bare", mcpServer: hostBare },
        { event: "PostToolUse", toolName: "mcp__hostsrv__bare", mcpServer: hostBare },
        { event: "PreToolUse", toolName: "mcp__plugsrv__look", mcpServer: plugLook },
        { event: "PostToolUse", toolName: "mcp__plugsrv__look", mcpServer: plugLook },
      ]);
      // A tool with no annotations states no hint at all -- absent, never `false`.
      expect("readOnlyHint" in (hooks[2]!.mcpServer as object)).toBe(false);
      // Every call that reached the prompt carried the same identity for canUseTool.
      expect(permissions.length).toBeGreaterThan(0);
      for (const p of permissions) {
        expect(p.mcpServer).toEqual(p.toolName === "mcp__hostsrv__look" ? hostLook : p.toolName === "mcp__hostsrv__bare" ? hostBare : plugLook);
      }
      // ...and every call ran.
      const results = JSON.stringify(frames.filter((f) => f.type === "data"));
      for (const text of ["LOOK", "BARE"]) expect(results).toContain(text);
    });
  });
}, 30_000);
