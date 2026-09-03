// WS-06 §3.3 "Agent" -- implement-now, captured model schema (declared superset noted in the
// description). [WS-10] owns lifecycle/definition/model-resolution/fork semantics; T1 registers the
// descriptor only. `resume`/`max_turns` are deliberately NOT input fields (see WS-06 §3.3).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Agent",
  advertisedName: "Agent",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
      subagent_type: { type: "string" },
      model: { type: "string", enum: ["sonnet", "opus", "haiku", "fable"] },
      run_in_background: { type: "boolean" },
      isolation: { type: "string", enum: ["worktree", "remote"] },
      name: { type: "string", description: "capability-gated: named teammates" },
    },
    required: ["description", "prompt"],
  },
  description:
    "Starting a worker does not prompt; every child tool call passes the applicable tool set/permissions/hooks. Foreground/background is an invocation field + runtime policy, never a hardcoded default.",
  exposure: "eager",
  permissionClass: "task",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.subagents" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by P4/WS-10), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  capabilityRequirements: ["winter.subagents"],
  disposition: "implement-now",
});
