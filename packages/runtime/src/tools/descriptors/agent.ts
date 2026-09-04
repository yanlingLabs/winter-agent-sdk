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
      // `name` is DELIBERATELY ABSENT from the model-visible schema (Phase 4 Task 8, rider 22).
      // WS-10 §17 Open Question 1, verbatim: "the pinned default session did not advertise `name`
      // (report §41); the exact capability predicate that turns it on (teams feature state) must be
      // captured before Winter advertises it -- until then Winter accepts the field host-side and
      // withholds it from the model schema." R4-8 restates it as a capture-pending obligation.
      // Lane C's own report raised this descriptor as a live conflict with that ruling, and RULING
      // P4-J(d) settled it: "§17 OQ1 stands verbatim -- the Agent descriptor withholds `name` from
      // the model schema while the host-side field is accepted."
      //
      // HOST-SIDE ACCEPTANCE IS UNAFFECTED and is regression-pinned: `tools/impl/agent.ts` reads
      // `name` off its raw `input` and threads it onto `SpawnChildRequest.name` regardless of what
      // this schema advertises (nothing in this codebase validates a call against a descriptor's
      // inputSchema -- registry.ts's own JSONSchema type is explicitly "not a validator"), so this
      // change is purely about what the MODEL is told exists. Restoring the field is a one-line
      // edit here once a real capture pins the teams-feature predicate.
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
