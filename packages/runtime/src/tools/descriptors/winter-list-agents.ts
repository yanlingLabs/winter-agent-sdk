// WS-09 §10 / WS-10 §15 -- the CANONICAL `mcp__winter__list_agents` entry on the standing Winter
// server. See descriptors/winter-send-message.ts's own header for the full rationale (why the pair
// exists, why `deferred: true` is declared at the source per RULING P4-E, why `source: "mcp"` rather
// than "builtin", and where duplicate suppression actually happens); everything there applies here
// unchanged. The schema below byte-mirrors descriptors/list-agents.ts's own, and
// tools/impl/list-agents.ts installs the IDENTICAL executor object under both names.
import { stub } from "./_shared.ts";

stub({
  canonicalName: "mcp__winter__list_agents",
  advertisedName: "mcp__winter__list_agents",
  source: "mcp",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string", maxLength: 256, description: "reserved" },
      q: { type: "string", maxLength: 256, description: "reserved" },
    },
  },
  outputSchema: { type: "object", properties: { listing: { type: "string" } }, required: ["listing"] },
  description:
    "Canonical Winter-server entry for ListAgents ([WS-10] §15): the alias target the official branch redirects the native ListAgents name to. Accepts the native arguments exactly.",
  searchHint: "list agents sessions peers children roster reachable",
  exposure: "deferred",
  permissionClass: "messaging",
  availability: {},
  capabilityRequirements: ["winter.global-messaging"],
  deferred: true,
  disposition: "implement-now",
});
