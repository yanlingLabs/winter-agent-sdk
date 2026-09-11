// WS-06 §3.3 "SendMessage" -- implement-now, captured, verbatim schema. [WS-10] owns the global
// router/executor; T1 registers the descriptor only.
import { SEND_MESSAGE_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";

import { stub, ALWAYS_AVAILABLE, builtinNameOf, definitionFields } from "./_shared.ts";

stub({
  // The model-facing half -- description, schema, permission class -- is the SDK's (R-8-1); the
  // policy below is this registry's (P-8). The two used to be one literal here, and a second copy of
  // it lived in the router package.
  ...definitionFields(SEND_MESSAGE_DEFINITION),
  canonicalName: builtinNameOf(SEND_MESSAGE_DEFINITION),
  advertisedName: builtinNameOf(SEND_MESSAGE_DEFINITION),
  source: "builtin",
  exposure: "eager",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.subagents" -- mirrors the WebSearch/LSP precedent,
  // a capability token rather than `executor !== undefined` (which would also silently hide a
  // test-registered executorless tool).
  capabilityRequirements: ["winter.subagents"],
  disposition: "implement-now",
});
