// Phase 4 Task 4 (Lane A), WS-09 §1.4 / WS-06 §3.6: ReadMcpResourceTool -- "invokes resources/read;
// text inline; binary blobs saved and represented by a local path marker; result contents[] with
// uri, mimeType?/text?/blobSavedTo?, error?."
//
// Same constructor-injected-resolver pattern as list-mcp-resources-tool.ts (see that file's own
// header for the full rationale -- registry.ts is closed, ToolExecutionContext has no MCP field,
// mirrors advisor.ts's own precedent).
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import "../descriptors/read-mcp-resource-tool.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import type { McpLifecycle } from "../../mcp/lifecycle.ts";
import type { McpLifecycleResolver } from "./list-mcp-resources-tool.ts";

export const READ_MCP_RESOURCE_TOOL_NAME = "ReadMcpResourceTool";

export interface ReadMcpResourceDeps {
  resolveLifecycle: McpLifecycleResolver;
}

interface ReadMcpResourceInput {
  server: string;
  uri: string;
}

function parseInput(raw: unknown): { ok: true; input: ReadMcpResourceInput } | { ok: false; error: string } {
  const server = (raw as { server?: unknown } | null)?.server;
  const uri = (raw as { uri?: unknown } | null)?.uri;
  if (typeof server !== "string" || server.length === 0) return { ok: false, error: "'server' is required and must be a non-empty string" };
  if (typeof uri !== "string" || uri.length === 0) return { ok: false, error: "'uri' is required and must be a non-empty string" };
  return { ok: true, input: { server, uri } };
}

// A small, best-effort mimeType -> extension table -- purely cosmetic (the file is still fully
// readable/identifiable without it via its own saved-path parent directory and the JSON result's
// own `mimeType` field); falls back to a generic, honest ".bin" rather than guessing wrong.
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/json": ".json",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
};
function extensionFor(mimeType: string | undefined): string {
  if (mimeType === undefined) return ".bin";
  return EXTENSION_BY_MIME[mimeType] ?? ".bin";
}

// Exported for read-mcp-resource-dir-tool.ts's own tests (and any future direct caller) to reuse
// the exact same "where do binary blobs land" convention without duplicating it.
export function saveBlobToTempDir(tempDir: string, blobBase64: string, mimeType: string | undefined): string {
  const dir = join(tempDir, "mcp-resources");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${randomUUID()}${extensionFor(mimeType)}`);
  writeFileSync(filePath, Buffer.from(blobBase64, "base64"));
  return filePath;
}

export function createReadMcpResourceExecutor(deps: ReadMcpResourceDeps): ToolExecutor {
  return {
    async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      const parsed = parseInput(rawInput);
      if (!parsed.ok) return { output: `Error: ${parsed.error}`, isError: true };
      const { server, uri } = parsed.input;

      const lifecycle: McpLifecycle | undefined = deps.resolveLifecycle(ctx);
      if (!lifecycle) {
        return { output: "Error: no MCP lifecycle is configured for this session (no MCP servers are reachable)", isError: true };
      }
      const client = lifecycle.getConnectedClient(server);
      if (!client) {
        // WS-09 §1.4's own per-content `error?` field, not a top-level tool failure by itself --
        // still marked `isError` on the ToolResultPayload too, since there is genuinely nothing
        // useful in `contents[]` for the model to act on here (contrast list-mcp-resources-tool.ts,
        // which can report SOME servers successfully alongside one that failed).
        return { output: JSON.stringify({ contents: [{ uri, error: `server "${server}" is not connected` }] }), isError: true };
      }

      try {
        const contents = await client.readResource(uri);
        const mapped = contents.map((c) => {
          if (c.blobBase64 !== undefined) {
            const blobSavedTo = saveBlobToTempDir(ctx.tempDir, c.blobBase64, c.mimeType);
            return { uri: c.uri, ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}), blobSavedTo };
          }
          return { uri: c.uri, ...(c.mimeType !== undefined ? { mimeType: c.mimeType } : {}), text: c.text ?? "" };
        });
        return { output: JSON.stringify({ contents: mapped }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: JSON.stringify({ contents: [{ uri, error: message }] }), isError: true };
      }
    },
  };
}

replaceExecutor(
  READ_MCP_RESOURCE_TOOL_NAME,
  createReadMcpResourceExecutor({
    resolveLifecycle: () => undefined,
  }),
);
