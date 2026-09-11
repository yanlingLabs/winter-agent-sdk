// WS-06 §3.3 "ListAgents" -- implement-now, captured, verbatim schema. [WS-10] owns the router.
import { LIST_AGENTS_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";

import { stub, ALWAYS_AVAILABLE, builtinNameOf, definitionFields } from "./_shared.ts";

stub({
  // R-8-1: the schema, the output shape and the description come from the one definition both hosts
  // bind; only the registry policy below is this runtime's own (P-8).
  ...definitionFields(LIST_AGENTS_DEFINITION),
  canonicalName: builtinNameOf(LIST_AGENTS_DEFINITION),
  advertisedName: builtinNameOf(LIST_AGENTS_DEFINITION),
  source: "builtin",
  exposure: "eager",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): a capability token, not `executor !== undefined`.
  capabilityRequirements: ["winter.subagents"],
  disposition: "implement-now",
});
