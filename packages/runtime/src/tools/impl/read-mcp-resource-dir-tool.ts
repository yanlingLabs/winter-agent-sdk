// Phase 4 Task 4 (Lane A), WS-06 §3.6 / WS-09 §1.4: ReadMcpResourceDirTool -- "direct children of a
// directory resource; declaration/runtime-present, outside the public table" (report §40.46). No MCP
// wire method exists for "list children of one directory-shaped resource URI" (verified: the base
// MCP protocol's own `resources/list` enumerates a server's ENTIRE resource set, paginated by an
// opaque cursor, with no URI-scoped filtering parameter at all) -- so this file's own interpretation
// (R4-8, CAPTURE-PENDING) is `listResources()` + a client-side URI-prefix filter, keeping "direct
// child" literal: a candidate URI must start with the parent's own URI (treated as ending in `/`)
// and have EXACTLY one more path segment after it, never a deeper descendant. This is a deliberate,
// disclosed choice among a few plausible readings (see this task's own report) -- picked because it
// uses only an ACTUAL protocol primitive (no invented wire method) and is fully testable against
// this lane's own fixture servers.
//
// Same constructor-injected-resolver pattern as list-mcp-resources-tool.ts/read-mcp-resource-tool.ts
// (see the former's own header for the full rationale).
import "../descriptors/read-mcp-resource-dir-tool.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import type { McpLifecycle } from "../../mcp/lifecycle.ts";
import type { McpLifecycleResolver } from "./list-mcp-resources-tool.ts";

export const READ_MCP_RESOURCE_DIR_TOOL_NAME = "ReadMcpResourceDirTool";

export interface ReadMcpResourceDirDeps {
  resolveLifecycle: McpLifecycleResolver;
}

interface ReadMcpResourceDirInput {
  server: string;
  uri: string;
}

function parseInput(raw: unknown): { ok: true; input: ReadMcpResourceDirInput } | { ok: false; error: string } {
  const server = (raw as { server?: unknown } | null)?.server;
  const uri = (raw as { uri?: unknown } | null)?.uri;
  if (typeof server !== "string" || server.length === 0) return { ok: false, error: "'server' is required and must be a non-empty string" };
  if (typeof uri !== "string" || uri.length === 0) return { ok: false, error: "'uri' is required and must be a non-empty string" };
  return { ok: true, input: { server, uri } };
}

// Exported for this file's own unit tests. `parent` is normalized to end in exactly one "/" before
// comparing -- a caller may pass either "scheme://a/b" or "scheme://a/b/" for the same directory.
export function isDirectChildUri(parent: string, candidate: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  if (!candidate.startsWith(normalizedParent)) return false;
  const rest = candidate.slice(normalizedParent.length);
  if (rest.length === 0) return false; // identical to the parent itself, not a child of it
  return !rest.includes("/"); // exactly one more segment -- a deeper descendant is excluded
}

export function createReadMcpResourceDirExecutor(deps: ReadMcpResourceDirDeps): ToolExecutor {
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
        return { output: JSON.stringify({ uri, error: `server "${server}" is not connected` }), isError: true };
      }
      try {
        const resources = await client.listResources();
        const children = resources.filter((r) => isDirectChildUri(uri, r.uri));
        return { output: JSON.stringify({ uri, children }) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: JSON.stringify({ uri, error: message }), isError: true };
      }
    },
  };
}

replaceExecutor(
  READ_MCP_RESOURCE_DIR_TOOL_NAME,
  createReadMcpResourceDirExecutor({
    resolveLifecycle: () => undefined,
  }),
);
