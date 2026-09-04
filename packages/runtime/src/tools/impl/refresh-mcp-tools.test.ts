import { describe, test, expect } from "bun:test";
import { createRefreshMcpToolsExecutor } from "./refresh-mcp-tools.ts";
import { createFakeMcpLifecycle } from "../../mcp/test-fixtures.ts";
import { createSessionReadState } from "../read-state.ts";
import type { ToolExecutionContext } from "../registry.ts";

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

describe("RefreshMcpTools executor", () => {
  test("no MCP lifecycle configured -> a legible typed error", async () => {
    const executor = createRefreshMcpToolsExecutor({ resolveLifecycle: () => undefined });
    const result = await executor.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no MCP lifecycle is configured");
  });

  test("'server' must be a string when provided", async () => {
    const executor = createRefreshMcpToolsExecutor({ resolveLifecycle: () => createFakeMcpLifecycle() });
    const result = await executor.execute({ server: 1 }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("'server' must be a string");
  });

  test("named 'server': calls lifecycle.refreshServerTools for exactly that name and forwards its outcome", async () => {
    const calls: string[] = [];
    const lifecycle = createFakeMcpLifecycle({
      refreshServerTools: async (name) => {
        calls.push(name);
        return { ok: true, toolNames: ["a", "b"] };
      },
    });
    const executor = createRefreshMcpToolsExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "gh" }, makeCtx());
    expect(calls).toEqual(["gh"]);
    expect(JSON.parse(result.output)).toEqual({ refreshed: [{ server: "gh", ok: true, toolNames: ["a", "b"] }] });
  });

  test("omitted 'server': refreshes every server the lifecycle counts as connected, never a server it doesn't", async () => {
    const calls: string[] = [];
    const lifecycle = createFakeMcpLifecycle({
      connectedServers: { a: undefined as never, b: undefined as never }, // only keys matter for listConnectedServerNames() here
      refreshServerTools: async (name) => {
        calls.push(name);
        return { ok: true, toolNames: [] };
      },
    });
    const executor = createRefreshMcpToolsExecutor({ resolveLifecycle: () => lifecycle });
    await executor.execute({}, makeCtx());
    expect(calls.sort()).toEqual(["a", "b"]);
  });

  test("a refusal (server not connected) is forwarded verbatim -- this tool never itself tries to connect anything", async () => {
    const lifecycle = createFakeMcpLifecycle({
      refreshServerTools: async (name) => ({ ok: false, reason: `server "${name}" is not connected (state: pending) -- RefreshMcpTools never establishes a new connection` }),
    });
    const executor = createRefreshMcpToolsExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "pending-srv" }, makeCtx());
    expect(result.isError).toBeUndefined(); // a per-server refusal, not a top-level tool error
    const parsed = JSON.parse(result.output) as { refreshed: Array<{ server: string; ok: boolean; reason?: string }> };
    expect(parsed.refreshed).toEqual([{ server: "pending-srv", ok: false, reason: expect.stringContaining("never establishes a new connection") as unknown as string }]);
  });
});
