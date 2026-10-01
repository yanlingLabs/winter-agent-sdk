// WS-06 §3.5 "ToolSearch" -- implement-now. Contracts/result shapes owned by [WS-09]; registry
// obligation here is `searchHint` population per descriptor (left to each descriptor file itself --
// none set at T1 since no deferred-exposure tool exists yet to search for) plus this descriptor.
import { stub } from "./_shared.ts";
import { DEFERRED_BUILTINS_CAPABILITY } from "../registry.ts";

stub({
  canonicalName: "ToolSearch",
  advertisedName: "ToolSearch",
  source: "builtin",
  // Not pinned by WS-06 §3 (its own text defers the contract to [WS-09]) -- a reasonable
  // placeholder shape; [WS-09] owns the authoritative schema.
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      max_results: { type: "number" },
    },
    required: ["query"],
  },
  // claude's own head sentence and location hint (`ToolSearchTool/prompt.ts`, its delta variant): the
  // engine announces the deferred names in `deferred_tools_delta` system-reminder attachments
  // (context/attachments.ts; engine.ts's `scanAttachments`).
  description:
    "Fetches full schema definitions for deferred tools so they can be called.\n\n" +
    "Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. " +
    'Query forms: "select:Read,Edit,Grep" fetches these exact tools by name; "notebook jupyter" is a keyword search over the deferred tools.',
  exposure: "eager",
  permissionClass: "read",
  // Phase 4 Task 8 (rider 4): the activation gate Lane B's own report flagged as missing ("no
  // Tool-Search-activation gate at all -- unconditionally eager once winter.mcp is supplied"). This
  // tool is only meaningful when deferral is genuinely ACTIVE for the session: with activation off,
  // resolveDeferral collapses every `deferred: true` descriptor to "eager" (full injection, WS-09
  // §8.1's `false` row), so the deferred pool is empty by construction and every query can only ever
  // return nothing. The complement of WaitForMcpServers' own WS-09 §8.4 gate -- exactly one of the
  // two is advertised in any session.
  //
  // I4 (fix wave, P3 close-out) gated it on "winter.mcp" alone, because MCP tools were then the only
  // thing that could ever defer. A host's `deferTools` can now defer a BUILT-IN in a session with no MCP
  // server at all, and a deferred tool with no search tool to load it is unreachable -- so either token
  // suffices: `winter.mcp` (a session with MCP servers, unchanged) or `winter.deferred-builtins` (the
  // engine derives it when the host's `deferTools` names anything).
  availability: { requiresToolSearchEnabled: true, requiresAnyCapability: ["winter.mcp", DEFERRED_BUILTINS_CAPABILITY] },
  capabilityRequirements: [],
  disposition: "implement-now",
});
