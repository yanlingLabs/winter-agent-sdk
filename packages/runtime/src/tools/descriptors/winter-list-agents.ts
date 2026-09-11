// WS-09 §10 / WS-10 §15 -- the CANONICAL `list_agents` entry on the standing Winter server. See
// descriptors/winter-send-message.ts's own header for the full rationale (why the pair
// exists, why `deferred: true` is declared at the source per RULING P4-E, why `source: "mcp"` rather
// than "builtin", and where duplicate suppression actually happens); everything there applies here
// unchanged. The schema below byte-mirrors descriptors/list-agents.ts's own, and
// tools/impl/list-agents.ts installs the IDENTICAL executor object under both names.
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";
import { LIST_AGENTS_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";

import { stub, definitionFields } from "./_shared.ts";

const NAME = mcpToolName(WINTER_BRAND, LIST_AGENTS_DEFINITION.toolName);

stub({
  // R-8-1: the same one definition the native `ListAgents` binds -- see winter-send-message.ts's own
  // note for why a shared OBJECT rather than a mirrored literal is what WS-09 §10 actually requires.
  ...definitionFields(LIST_AGENTS_DEFINITION),
  canonicalName: NAME,
  advertisedName: NAME,
  source: "mcp",
  exposure: "deferred",
  availability: {},
  capabilityRequirements: ["winter.global-messaging"],
  deferred: true,
  disposition: "implement-now",
});
