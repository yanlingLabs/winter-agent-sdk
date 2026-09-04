// Phase 4 Task 4 (Lane A), WS-09 §1.4 / WS-06 §3: ListMcpResourcesTool -- "lists resources
// (identity/URI/metadata or error) of connected servers. Lists resources, not tools."
//
// Mirrors tools/impl/advisor.ts's own established pattern EXACTLY (its own header explains why):
// registry.ts (the index) is closed to this lane (R3-5/R4-10), and `ToolExecutionContext` has no
// MCP-shaped field at all -- so this file defines its own constructor-injected seam
// (`McpLifecycleResolver`), unit-tests the executor against a hand-built fake, and installs an
// INERT-BUT-CORRECT default at module load (a resolver that always returns `undefined`, producing a
// legible "no MCP lifecycle configured" tool error rather than a crash). Whoever wires a real
// `mcp/lifecycle.ts` instance into a live session (an OWED follow-up -- see this task's own report)
// is expected to call `createListMcpResourcesExecutor` again with a real resolver and
// `replaceExecutor` a second time, exactly like T8 is expected to do for advisor.ts's own default.
//
// The resolver is `(ctx) => McpLifecycle | undefined`, NOT a bare module-level singleton: MCP
// connection state is SESSION state (mcp/state.ts's own header: "two concurrent sessions... must
// never observe each other's server states"), so a future multi-session host is expected to key its
// own resolver off `ctx.sessionId` -- this file's own default ignores `ctx` entirely (there is
// nothing to key off of yet), but the shape is ready for that without a future signature change.
import "../descriptors/list-mcp-resources-tool.ts"; // self-sufficiency: guarantees the stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { getSessionMcpLifecycle } from "../../mcp/lifecycle.ts";
import type { McpLifecycle } from "../../mcp/lifecycle.ts";

export const LIST_MCP_RESOURCES_TOOL_NAME = "ListMcpResourcesTool";

export type McpLifecycleResolver = (ctx: ToolExecutionContext) => McpLifecycle | undefined;

export interface ListMcpResourcesDeps {
  resolveLifecycle: McpLifecycleResolver;
}

interface ListMcpResourcesInput {
  server?: string;
}

function parseInput(raw: unknown): { ok: true; input: ListMcpResourcesInput } | { ok: false; error: string } {
  const server = (raw as { server?: unknown } | null)?.server;
  if (server !== undefined && typeof server !== "string") {
    return { ok: false, error: "'server' must be a string when provided" };
  }
  return { ok: true, input: server !== undefined ? { server } : {} };
}

export function createListMcpResourcesExecutor(deps: ListMcpResourcesDeps): ToolExecutor {
  return {
    async execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
      const parsed = parseInput(rawInput);
      if (!parsed.ok) return { output: `Error: ${parsed.error}`, isError: true };

      const lifecycle = deps.resolveLifecycle(ctx);
      if (!lifecycle) {
        return { output: "Error: no MCP lifecycle is configured for this session (no MCP servers are reachable)", isError: true };
      }

      // Omitted `server` -> every server this lane's own McpLifecycle counts as truly connected
      // (never pending/cached/failed/needsAuth/disabled -- see mcp/lifecycle.ts's own header on
      // that deliberate scope). A NAMED server that isn't connected still produces a per-server
      // `error` entry rather than a top-level tool failure -- WS-09 §1.4's own "or error" clause.
      const names = parsed.input.server !== undefined ? [parsed.input.server] : lifecycle.listConnectedServerNames();

      const servers = await Promise.all(
        names.map(async (name) => {
          const client = lifecycle.getConnectedClient(name);
          if (!client) return { server: name, error: `server "${name}" is not connected` };
          try {
            const resources = await client.listResources();
            return { server: name, resources };
          } catch (err) {
            return { server: name, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );

      return { output: JSON.stringify({ servers }) };
    },
  };
}

// Module-load default (a future task replaces this per the header above): every call resolves to
// the ordinary "no MCP lifecycle" tool error until real deps are wired in -- never a crash, never a
// silently-empty success.
replaceExecutor(
  LIST_MCP_RESOURCES_TOOL_NAME,
  createListMcpResourcesExecutor({
    // Phase 4 Task 8 (rider 11): no longer an inert `() => undefined` -- resolves THIS call's own
    // session lifecycle from mcp/lifecycle.ts's session-keyed registry, which a live runEngine
    // populates (and clears at teardown). A session with no MCP servers configured registers none, so
    // the tool still answers its own typed "no MCP lifecycle" error rather than throwing.
    resolveLifecycle: (ctx) => getSessionMcpLifecycle(ctx.sessionId),
  }),
);
