import { describe, test, expect } from "bun:test";
import { createListMcpResourcesExecutor } from "./list-mcp-resources-tool.ts";
import { createFakeConnectedMcpClient, createFakeMcpLifecycle } from "../../mcp/test-fixtures.ts";
import { createSessionReadState } from "../read-state.ts";
import type { ToolExecutionContext } from "../registry.ts";

// This executor never touches the filesystem (no tempDir/cwd I/O at all) -- a fixed, never-created
// dummy path is honest and avoids an unnecessary real mkdtemp per test.
function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/dummy/cwd",
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/dummy/tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/dummy/cwd", setSessionRoot() {} },
    ...overrides,
  };
}

describe("ListMcpResourcesTool executor", () => {
  test("no MCP lifecycle configured -> a legible typed error, never a crash", async () => {
    const executor = createListMcpResourcesExecutor({ resolveLifecycle: () => undefined });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no MCP lifecycle is configured");
  });

  test("'server' must be a string when provided", async () => {
    const executor = createListMcpResourcesExecutor({ resolveLifecycle: () => createFakeMcpLifecycle() });
    const result = await executor.execute({ server: 42 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("'server' must be a string");
  });

  test("omitted 'server': lists resources for every connected server", async () => {
    const a = createFakeConnectedMcpClient("a", { listResources: async () => [{ uri: "a://one" }] });
    const b = createFakeConnectedMcpClient("b", { listResources: async () => [{ uri: "b://two" }] });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { a, b } });
    const executor = createListMcpResourcesExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output) as { servers: unknown[] };
    expect(parsed.servers).toHaveLength(2);
    expect(parsed.servers).toContainEqual({ server: "a", resources: [{ uri: "a://one" }] });
    expect(parsed.servers).toContainEqual({ server: "b", resources: [{ uri: "b://two" }] });
  });

  test("named 'server': lists only that one server, ignoring others", async () => {
    const a = createFakeConnectedMcpClient("a", { listResources: async () => [{ uri: "a://one" }] });
    const b = createFakeConnectedMcpClient("b", { listResources: async () => [{ uri: "b://two" }] });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { a, b } });
    const executor = createListMcpResourcesExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "a" }, makeCtx());
    const parsed = JSON.parse(result.output) as { servers: unknown[] };
    expect(parsed.servers).toEqual([{ server: "a", resources: [{ uri: "a://one" }] }]);
  });

  test("a named server that isn't connected produces a per-server error entry, not a top-level tool failure", async () => {
    const lifecycle = createFakeMcpLifecycle({}); // nothing connected
    const executor = createListMcpResourcesExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "ghost" }, makeCtx());
    expect(result.isError).toBeUndefined(); // WS-09 §1.4's own "or error" clause -- inside the payload, not a tool-level error
    const parsed = JSON.parse(result.output) as { servers: unknown[] };
    expect(parsed.servers).toEqual([{ server: "ghost", error: 'server "ghost" is not connected' }]);
  });

  test("a connected server whose listResources() throws produces a per-server error entry, other servers unaffected", async () => {
    const ok = createFakeConnectedMcpClient("ok", { listResources: async () => [{ uri: "ok://x" }] });
    const broken = createFakeConnectedMcpClient("broken", {
      listResources: async () => {
        throw new Error("boom");
      },
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { ok, broken } });
    const executor = createListMcpResourcesExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({}, makeCtx());
    const parsed = JSON.parse(result.output) as { servers: unknown[] };
    expect(parsed.servers).toContainEqual({ server: "ok", resources: [{ uri: "ok://x" }] });
    expect(parsed.servers).toContainEqual({ server: "broken", error: "boom" });
  });
});
