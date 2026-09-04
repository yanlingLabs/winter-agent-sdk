// Phase 4 Task 4 (Lane A), WS-09 §1.4 / WS-06 §3.6: RefreshMcpTools -- "re-queries one/all
// already-connected servers for changed tool lists; never establishes a disconnected connection."
//
// The MUST itself ("never establishes a disconnected connection") is enforced STRUCTURALLY one
// layer down, in mcp/lifecycle.ts's own `refreshServerTools` (refuses, with a typed reason, for
// anything not already in the live "connected" state) -- this file is a thin wire adapter over that
// method, never a second place that MUST could be violated from.
//
// Same constructor-injected-resolver pattern as the other three bridge tools in this directory (see
// list-mcp-resources-tool.ts's own header for the full rationale).
import "../descriptors/refresh-mcp-tools.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { getSessionMcpLifecycle } from "../../mcp/lifecycle.ts";
import type { McpLifecycle } from "../../mcp/lifecycle.ts";
import type { McpLifecycleResolver } from "./list-mcp-resources-tool.ts";

export const REFRESH_MCP_TOOLS_NAME = "RefreshMcpTools";

export interface RefreshMcpToolsDeps {
  resolveLifecycle: McpLifecycleResolver;
}

interface RefreshMcpToolsInput {
  server?: string;
}

function parseInput(raw: unknown): { ok: true; input: RefreshMcpToolsInput } | { ok: false; error: string } {
  const server = (raw as { server?: unknown } | null)?.server;
  if (server !== undefined && typeof server !== "string") {
    return { ok: false, error: "'server' must be a string when provided" };
  }
  return { ok: true, input: server !== undefined ? { server } : {} };
}

export function createRefreshMcpToolsExecutor(deps: RefreshMcpToolsDeps): ToolExecutor {
  return {
    async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      const parsed = parseInput(rawInput);
      if (!parsed.ok) return { output: `Error: ${parsed.error}`, isError: true };

      const lifecycle: McpLifecycle | undefined = deps.resolveLifecycle(ctx);
      if (!lifecycle) {
        return { output: "Error: no MCP lifecycle is configured for this session (no MCP servers are reachable)", isError: true };
      }

      // Omitted `server` -> every server ALREADY connected (never a server this call itself
      // connects) -- `listConnectedServerNames()` is the identical "truly connected" set
      // list-mcp-resources-tool.ts consults, so a caller refreshing "everything" never accidentally
      // reaches a pending/cached/failed/disabled server either.
      const names = parsed.input.server !== undefined ? [parsed.input.server] : lifecycle.listConnectedServerNames();

      const results = await Promise.all(
        names.map(async (name) => {
          const outcome = await lifecycle.refreshServerTools(name);
          return { server: name, ...outcome };
        }),
      );

      return { output: JSON.stringify({ refreshed: results }) };
    },
  };
}

replaceExecutor(
  REFRESH_MCP_TOOLS_NAME,
  createRefreshMcpToolsExecutor({
    // Phase 4 Task 8 (rider 11): no longer an inert `() => undefined` -- resolves THIS call's own
    // session lifecycle from mcp/lifecycle.ts's session-keyed registry, which a live runEngine
    // populates (and clears at teardown). A session with no MCP servers configured registers none, so
    // the tool still answers its own typed "no MCP lifecycle" error rather than throwing.
    resolveLifecycle: (ctx) => getSessionMcpLifecycle(ctx.sessionId),
  }),
);
