// WS-09 §1.3: the standing Winter server (`winter`) -- Winter's own product-capability tools,
// registered as a real, in-process @modelcontextprotocol/sdk `McpServer` object so the Winter branch
// and the official (Claude) branch can advertise byte-identical descriptors for the same names
// (WS-06 §6 obligation 5). This file registers ONLY `mcp__winter__advisor` this phase -- the other
// standing-server tools WS-09 §1.3 names (mcp__winter__browser/computer/docs/sheets/slides/sessions)
// are P7/P8 product-layer work owned by [WS-14]/[WS-15]; nothing registers them here yet.
//
// READ-ONLY consumption of advisor.ts (task-2 brief, MUST 4): this file reads the ALREADY-REGISTERED
// `mcp__winter__advisor` descriptor (installed by descriptors/advisor.ts, a P3 file this task does
// not edit) and mirrors its description/annotations/_meta onto a real MCP tool registration -- it
// never re-types or duplicates that descriptor's own field values by hand, so the two can never
// silently drift. Deliberately imports "../tools/descriptors/advisor.ts" (the STUB registration)
// rather than "../tools/impl/advisor.ts" (which additionally calls replaceExecutor) -- this file only
// needs the descriptor to exist; the real execution path stays on Winter's own registry regardless
// (see registerAdvisor's own handler comment below).
//
// Deliberately NOT wired into any auto-loaded barrel (main.ts, tools/descriptors/index.ts, this
// package's own index.ts): nothing imports this module yet, so the compiled `winter` binary's
// dependency graph is UNAFFECTED by this task -- @modelcontextprotocol/sdk is a real, declared
// dependency (R4-3) but is not yet reachable from any entry point `bun build --compile` follows.
// Task 8 is expected to be the first real caller, once the standing server is actually connected
// into a live session.
//
// Collision note (see registry.ts's own "Phase 4 Task 2: live MCP server registration" header): this
// file deliberately does NOT call registerMcpServerTools("winter", ...) for advisor -- that would
// collide with (and, by registry.ts's own collision guard, throw against) the P3-installed static
// stub under the exact same canonical name. Building a real McpServer object directly, as this file
// does, is how WS-09 §1.3's "byte-identical descriptors" obligation is met WITHOUT going through that
// live-registration mechanism at all for this one already-registered name. Updated, fix round 1
// RULING P4-B: a future task that tries to feed the standing server's OWN tools/list through
// registerMcpServerTools no longer merely hits the per-name collision this comment used to describe
// for "advisor" specifically -- "winter" is now a RESERVED server name (registry.ts's own
// RESERVED_MCP_SERVER_NAMES), so ANY registerMcpServerTools("winter", ...) call throws unconditionally,
// for any tool name, before the per-name check even runs. Resolving the two mechanisms deliberately
// (rather than by surprise) now means removing "winter" from that reserved set, not just working
// around one collided name.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import "../tools/descriptors/advisor.ts"; // self-sufficiency: guarantees the mcp__winter__advisor stub is registered before createWinterServer() ever runs.
import { getRegisteredTool } from "../tools/registry.ts";

export const WINTER_SERVER_NAME = "winter";
// Matches descriptors/advisor.ts's own `canonicalName` literal exactly (not imported by value, to
// avoid a hard coupling to impl/advisor.ts's own ADVISOR_TOOL_NAME export surviving a future
// refactor) -- registerAdvisor's own getRegisteredTool lookup fails loudly if this ever drifts.
const ADVISOR_CANONICAL_NAME = "mcp__winter__advisor";

// Re-callable by design (no module-load singleton, no cached instance) -- a later phase that wants a
// fresh server per session, or that extends this factory with more tools, can call it as many times
// as it needs.
export function createWinterServer(): McpServer {
  const server = new McpServer({ name: WINTER_SERVER_NAME, version: "0.0.1" });
  registerAdvisor(server);
  return server;
}

function registerAdvisor(server: McpServer): void {
  const registered = getRegisteredTool(ADVISOR_CANONICAL_NAME);
  if (!registered) {
    throw new Error(
      `mcp/winter-server: no registry descriptor found for "${ADVISOR_CANONICAL_NAME}" -- ` +
        `descriptors/advisor.ts must register it before createWinterServer() runs`,
    );
  }
  const { descriptor } = registered;
  server.registerTool(
    // Bare, server-local name -- WS-09 §1.3's mcp__<server>__<tool> canonical form is a naming
    // convention applied by whatever CONNECTS to this server (Lane A), not a shape this SDK object
    // itself needs to know about; a real MCP server never namespaces its own tool names by its own
    // server name.
    "advisor",
    {
      description: descriptor.description,
      ...(descriptor.annotations !== undefined ? { annotations: descriptor.annotations } : {}),
      ...(descriptor._meta !== undefined ? { _meta: descriptor._meta } : {}),
      // `inputSchema` deliberately OMITTED: advisor's own pinned shape is `{}` (WS-06 §4, "no
      // parameters"). Verified empirically against the real @modelcontextprotocol/sdk@1.30.0 that an
      // omitted `inputSchema` renders, over a real Client.listTools() round trip, as the WIRE shape
      // `{type:"object", properties:{}}` -- BYTE-IDENTICAL to descriptor.inputSchema, which is
      // exactly what winter-server.test.ts's identity fixture asserts.
    },
    async () => {
      // WS-09 §1.3: "the Winter runtime MAY execute a descriptor directly behind the registry, which
      // changes nothing model-visible" -- a real model-issued tool_use call for
      // "mcp__winter__advisor" is dispatched through Winter's OWN registry executor
      // (impl/advisor.ts's replaceExecutor, reached via registry.ts's buildRegistryToolExecutor),
      // NEVER through this handler. This handler exists only so the McpServer object is a fully
      // real, connectable server for shape/behavior fidelity (e.g. if anything ever speaks MCP to it
      // over an actual transport) -- nothing calls it today; see this file's own module header.
      return {
        content: [
          {
            type: "text" as const,
            text: "mcp__winter__advisor executes through Winter's own tool registry (registry.ts's buildRegistryToolExecutor), not this in-process MCP bridge handler.",
          },
        ],
      };
    },
  );
}
