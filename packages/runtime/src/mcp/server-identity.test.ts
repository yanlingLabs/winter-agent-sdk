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
import { withHttpFixture, withModernHttpFixture, type FixtureServerSpec } from "./test-fixtures.ts";

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

test("PostToolUseFailure names the called tool's server too (a tool that reports isError)", async () => {
  const failing: FixtureServerSpec = {
    tools: [{ name: "fails", description: "always fails", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false }, handler: () => ({ content: [{ type: "text", text: "nope" }], isError: true }) }],
    resources: [],
  };
  await withHttpFixture(failing, async (url) => {
    const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "f1", name: "mcp__failsrv__fails", input: {} }] }, { kind: "text", text: "done" }]);
    const config = {
      sessionId: `ws27-identity-failure-${randomUUID()}`,
      cwd: "/winter-fixture",
      model: "winter-test/echo",
      toolSearchEnabled: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: { failsrv: { type: "http", url: url.href } },
      hooks: { PostToolUse: [{ hookCount: 1, source: "sdk" }], PostToolUseFailure: [{ hookCount: 1, source: "sdk" }] },
    } as RuntimeConfig;
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: { MCP_CONNECTION_NONBLOCKING: "0" } });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    const hooks: Array<{ event: string; toolName: string; mcpServer?: unknown }> = [];
    for await (const f of host.input) {
      if (f.type !== "control_request") continue;
      const cf = f as ControlRequestFrame;
      if (cf.subtype === "hook") {
        const p = cf.payload as { event: string; toolName: string; mcpServer?: unknown };
        hooks.push({ event: p.event, toolName: p.toolName, ...("mcpServer" in p ? { mcpServer: p.mcpServer } : {}) });
      }
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: cf.subtype === "permission" ? { behavior: "allow" } : {} });
    }
    expect(await done).toBe(0);
    expect(hooks).toEqual([{ event: "PostToolUseFailure", toolName: "mcp__failsrv__fails", mcpServer: { name: "failsrv", configName: "failsrv", readOnlyHint: false } }]);
  });
}, 30_000);

test("a server served from the discovery cache (`cached`) states no readOnlyHint until its live connection is back", async () => {
  await withModernHttpFixture(spec, async (url) => {
    const provider = scriptedProvider([
      { kind: "text", text: "turn 1" },
      { kind: "tool_use", calls: [{ id: "c1", name: "mcp__cachesrv__look", input: {} }] },
      { kind: "text", text: "turn 2" },
      { kind: "tool_use", calls: [{ id: "c2", name: "mcp__cachesrv__look", input: {} }] },
      { kind: "text", text: "turn 3" },
    ]);
    const config = {
      sessionId: `ws27-identity-cached-${randomUUID()}`,
      cwd: "/winter-fixture",
      model: "winter-test/echo",
      toolSearchEnabled: false,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: { cachesrv: { type: "http", url: url.href } },
      hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] },
    } as RuntimeConfig;
    const { host, runtime } = createInMemoryChannel();
    // MCP_DISCOVERY_CACHE=1: a reconnect is served from the cache -- the slot is `cached`, with no live client.
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: { MCP_CONNECTION_NONBLOCKING: "0", MCP_DISCOVERY_CACHE: "1" } });
    host.output.write({ type: "user", text: "one" });
    const identities: unknown[] = [];
    let results = 0;
    for await (const f of host.input) {
      if (f.type === "control_request") {
        const cf = f as ControlRequestFrame;
        if (cf.subtype === "hook") identities.push((cf.payload as { mcpServer?: unknown }).mcpServer);
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
      }
      if (f.type === "control_response" && (f as { requestId: string }).requestId === "rc-1") host.output.write({ type: "user", text: "two" });
      if (f.type !== "data" || (f as { message: { type: string } }).message.type !== "result") continue;
      results++;
      if (results === 1) host.output.write({ type: "control_request", requestId: "rc-1", subtype: "mcp_reconnect", payload: { serverName: "cachesrv" } });
      if (results === 2) host.output.write({ type: "user", text: "three" });
      if (results === 3) host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
    }
    expect(await done).toBe(0);
    // Turn 2 called it while `cached`: no hint. Its first call connected it live, so turn 3's call states it.
    expect(identities).toEqual([
      { name: "cachesrv", configName: "cachesrv" },
      { name: "cachesrv", configName: "cachesrv", readOnlyHint: true },
    ]);
  });
}, 30_000);
