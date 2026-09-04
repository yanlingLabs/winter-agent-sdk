import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadMcpResourceExecutor, saveBlobToTempDir } from "./read-mcp-resource-tool.ts";
import { createFakeConnectedMcpClient, createFakeMcpLifecycle } from "../../mcp/test-fixtures.ts";
import { createSessionReadState } from "../read-state.ts";
import type { ToolExecutionContext } from "../registry.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "winter-read-mcp-resource-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: dir,
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(dir, ".tmp"),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => dir, setSessionRoot() {} },
    ...overrides,
  };
}

describe("ReadMcpResourceTool executor", () => {
  test("'server' and 'uri' are both required", async () => {
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => createFakeMcpLifecycle() });
    const missingServer = await executor.execute({ uri: "x://y" }, makeCtx());
    expect(missingServer.isError).toBe(true);
    expect(missingServer.output).toContain("'server' is required");

    const missingUri = await executor.execute({ server: "s" }, makeCtx());
    expect(missingUri.isError).toBe(true);
    expect(missingUri.output).toContain("'uri' is required");
  });

  test("no MCP lifecycle configured -> a legible typed error", async () => {
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => undefined });
    const result = await executor.execute({ server: "s", uri: "x://y" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no MCP lifecycle is configured");
  });

  test("server not connected -> contents[] carries a per-item error, and the tool result IS marked isError", async () => {
    const lifecycle = createFakeMcpLifecycle({});
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "ghost", uri: "x://y" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ contents: [{ uri: "x://y", error: 'server "ghost" is not connected' }] });
  });

  test("text resource: returned inline, no file written", async () => {
    const client = createFakeConnectedMcpClient("s", {
      readResource: async (uri) => [{ uri, mimeType: "text/plain", text: "hello world" }],
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { s: client } });
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => lifecycle });
    const ctx = makeCtx();
    const result = await executor.execute({ server: "s", uri: "text://a.txt" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toEqual({ contents: [{ uri: "text://a.txt", mimeType: "text/plain", text: "hello world" }] });
    expect(existsSync(join(ctx.tempDir, "mcp-resources"))).toBe(false);
  });

  test("blob resource: saved under <tempDir>/mcp-resources/ with a path marker, byte-identical content, correct extension", async () => {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const client = createFakeConnectedMcpClient("s", {
      readResource: async (uri) => [{ uri, mimeType: "image/png", blobBase64: bytes.toString("base64") }],
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { s: client } });
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => lifecycle });
    const ctx = makeCtx();
    const result = await executor.execute({ server: "s", uri: "img://a.png" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output) as { contents: Array<{ uri: string; mimeType?: string; blobSavedTo?: string }> };
    const entry = parsed.contents[0]!;
    expect(entry.uri).toBe("img://a.png");
    expect(entry.mimeType).toBe("image/png");
    expect(entry.blobSavedTo).toBeDefined();
    expect(entry.blobSavedTo!.startsWith(join(ctx.tempDir, "mcp-resources"))).toBe(true);
    expect(entry.blobSavedTo!.endsWith(".png")).toBe(true);
    expect(readFileSync(entry.blobSavedTo!)).toEqual(bytes);
  });

  test("an unrecognized mimeType falls back to a generic .bin extension; an absent mimeType too", async () => {
    const client = createFakeConnectedMcpClient("s", {
      readResource: async (uri) => [{ uri, mimeType: "application/x-mystery", blobBase64: Buffer.from([1]).toString("base64") }],
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { s: client } });
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => lifecycle });
    const ctx = makeCtx();
    const result = await executor.execute({ server: "s", uri: "x://y" }, ctx);
    const parsed = JSON.parse(result.output) as { contents: Array<{ blobSavedTo?: string }> };
    expect(parsed.contents[0]!.blobSavedTo!.endsWith(".bin")).toBe(true);
  });

  test("readResource() throwing produces a per-item error and isError:true, never an uncaught rejection", async () => {
    const client = createFakeConnectedMcpClient("s", {
      readResource: async () => {
        throw new Error("resource read failed");
      },
    });
    const lifecycle = createFakeMcpLifecycle({ connectedServers: { s: client } });
    const executor = createReadMcpResourceExecutor({ resolveLifecycle: () => lifecycle });
    const result = await executor.execute({ server: "s", uri: "x://y" }, makeCtx());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({ contents: [{ uri: "x://y", error: "resource read failed" }] });
  });

  test("saveBlobToTempDir is reused verbatim by read-mcp-resource-dir-tool.ts's own convention (unit-level sanity check)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "winter-save-blob-test-"));
    try {
      const path = saveBlobToTempDir(dir2, Buffer.from("hi").toString("base64"), "text/plain");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("hi");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
