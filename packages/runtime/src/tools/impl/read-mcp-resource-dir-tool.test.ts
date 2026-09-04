import { describe, test, expect } from "bun:test";
import { createReadMcpResourceDirExecutor, isDirectChildUri } from "./read-mcp-resource-dir-tool.ts";
import { createFakeConnectedMcpClient, createFakeMcpLifecycle } from "../../mcp/test-fixtures.ts";
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

describe("isDirectChildUri (R4-8: the chosen 'direct children' interpretation)", () => {
  test("a genuine direct child (one more segment) is true", () => {
    expect(isDirectChildUri("file:///a/b", "file:///a/b/c")).toBe(true);
  });

  test("works identically whether the parent URI is given with or without a trailing slash", () => {
    expect(isDirectChildUri("file:///a/b/", "file:///a/b/c")).toBe(true);
  });

  test("a deeper descendant (two or more segments below) is excluded -- 'direct' is literal", () => {
    expect(isDirectChildUri("file:///a/b", "file:///a/b/c/d")).toBe(false);
  });

  test("the parent URI itself is not its own child", () => {
    expect(isDirectChildUri("file:///a/b", "file:///a/b")).toBe(false);
    expect(isDirectChildUri("file:///a/b/", "file:///a/b/")).toBe(false);
  });

  test("a sibling (same prefix length, different branch) is excluded", () => {
    expect(isDirectChildUri("file:///a/b", "file:///a/bc")).toBe(false); // prefix-only match, not a real child
    expect(isDirectChildUri("file:///a/b", "file:///a/other")).toBe(false);
  });

  test("an unrelated URI (different scheme/host entirely) is excluded", () => {
    expect(isDirectChildUri("file:///a/b", "https://example.com/a/b/c")).toBe(false);
  });

  test("fix round 1 (Minor 5): a direct child that is ITSELF directory-shaped (single trailing slash) is still recognized", () => {
    expect(isDirectChildUri("file:///a/b", "file:///a/b/subdir/")).toBe(true);
    expect(isDirectChildUri("file:///a/b/", "file:///a/b/subdir/")).toBe(true);
    // A deeper, directory-shaped descendant is still excluded -- the trailing slash alone must not
    // change the segment count.
    expect(isDirectChildUri("file:///a/b", "file:///a/b/subdir/nested/")).toBe(false);
    // The parent itself, spelled with a trailing slash, is still not its own child.
    expect(isDirectChildUri("file:///a/b", "file:///a/b/")).toBe(false);
  });
});

describe("ReadMcpResourceDirTool executor", () => {
  test("'server' and 'uri' are both required", async () => {
    const executor = createReadMcpResourceDirExecutor({ resolveLifecycle: () => createFakeMcpLifecycle() });
    const result = await executor.execute({ server: "s" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("'uri' is required");
  });

  test("no MCP lifecycle configured -> a legible typed error", async () => {
    const executor = createReadMcpResourceDirExecutor({ resolveLifecycle: () => undefined });
    const result = await executor.execute({ server: "s", uri: "file:///a" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no MCP lifecycle is configured");
  });

  test("server not connected -> a typed error", async () => {
    const lifecycle = createFakeMcpLifecycle({});
    const executor = createReadMcpResourceDirExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "ghost", uri: "file:///a" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ uri: "file:///a", error: 'server "ghost" is not connected' });
  });

  test("returns only the DIRECT children of the given uri, filtering out siblings and deeper descendants", async () => {
    const client = createFakeConnectedMcpClient("s", {
      listResources: async () => [
        { uri: "file:///a/b/child1.txt", name: "child1.txt" },
        { uri: "file:///a/b/child2.txt", name: "child2.txt" },
        { uri: "file:///a/b/nested/deep.txt", name: "deep.txt" }, // deeper descendant, excluded
        { uri: "file:///a/other.txt", name: "other.txt" }, // sibling of "b" itself, excluded
        { uri: "file:///a/b", name: "b" }, // the directory itself, excluded
      ],
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { s: client } });
    const executor = createReadMcpResourceDirExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "s", uri: "file:///a/b" }, makeCtx());
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output) as { uri: string; children: Array<{ uri: string }> };
    expect(parsed.uri).toBe("file:///a/b");
    expect(parsed.children.map((c) => c.uri).sort()).toEqual(["file:///a/b/child1.txt", "file:///a/b/child2.txt"]);
  });

  test("listResources() throwing produces a typed error, never an uncaught rejection", async () => {
    const client = createFakeConnectedMcpClient("s", {
      listResources: async () => {
        throw new Error("boom");
      },
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { s: client } });
    const executor = createReadMcpResourceDirExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "s", uri: "file:///a" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ uri: "file:///a", error: "boom" });
  });
});
