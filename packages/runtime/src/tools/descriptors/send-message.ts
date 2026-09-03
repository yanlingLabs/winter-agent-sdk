// WS-06 §3.3 "SendMessage" -- implement-now, captured, verbatim schema. [WS-10] owns the global
// router/executor; T1 registers the descriptor only.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "SendMessage",
  advertisedName: "SendMessage",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", maxLength: 300, description: 'no newline, no "*" broadcast' },
      message: { type: "string", description: 'required; defaults "" for pure idle subscription' },
      summary: { type: "string", maxLength: 200 },
      notify_when_idle: { type: "boolean", description: "one-shot; main conversation -> same-machine session only" },
    },
    required: ["to", "message"],
  },
  description:
    "Resolves `to` against child registry, teammates, live peer registry; steers a running child, resumes an addressable completed/stopped child, wakes an idle live peer, queues for a running peer; never cold-resumes an arbitrary exited transcript.",
  exposure: "eager",
  permissionClass: "messaging",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.subagents" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-10), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.subagents"],
  disposition: "implement-now",
});
