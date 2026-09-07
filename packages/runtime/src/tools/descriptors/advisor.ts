// WS-06 §4 "advisor" (Winter-only) -- implement-now, and since P7a a NATIVE tool named `advisor`.
//
// D29 (user directive 2026-09-08) OVERRIDES §4's original naming argument. §4 reasoned from the
// interchangeability rule (report §122, D7): a bare `advisor` could exist only on the Winter branch,
// so it registered under an `mcp__`-prefixed name on the standing Winter server, to keep both
// branches identical to the model. The directive settles it the other way, and the empirical shape
// is what makes that the better answer: on the OFFICIAL branch the model already sees Anthropic's
// own API-side advisor server tool, which is ALSO called `advisor` and is ALSO parameterless — and a
// host cannot intercept it (`toolAliases` never sees a server tool's `tool_use`). So the bare name
// is what makes the two branches MATCH; the server-qualified name is what made them differ. Same
// name, same empty schema, different backing: Anthropic's reviewer there, the user-picked Winter
// reviewer here.
//
// `source: "builtin"` follows the name: this is no longer a tool that pretends to arrive from a
// server. It is rule-addressable as `advisor` (deny/ask rules apply normally), and `permissionClass`
// stays `"mcp"` deliberately — WS-06 §4's permission semantics are unchanged by the rename (default
// no-prompt: it sends conversation content to a provider in the session's OWN trust domain, the same
// class of egress as the worker model's own requests). The class is about what the call DOES, not
// about where the descriptor came from.
//
// Input `{}` -- the runtime forwards the session's own conversation/tool history; no model-supplied
// parameters. Availability stays gated on `winter.reviewer-model` (a reviewer must be resolvable in
// the session's provider catalog).
import { stub } from "./_shared.ts";

stub({
  canonicalName: "advisor",
  advertisedName: "advisor",
  source: "builtin",
  // N2 (fix wave, nit, P3 close-out): the schema previously declared `additionalProperties: false`
  // here, but no executor in this codebase validates input against a JSON Schema at all
  // (registry.ts's own JSONSchema type is explicitly "self-describing... not a validator") -- the
  // keyword was decorative, never enforced. Dropped uniformly (see the same fix on CronList/TaskList/
  // EnterPlanMode/advisor -- pick one posture and apply it everywhere, rather than a schema that
  // implies enforcement none of these executors perform).
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: {
      advice: { type: "string" },
      model: { type: "string" },
      truncated: { type: "boolean" },
    },
    required: ["advice", "model"],
  },
  description:
    "Consults a stronger reviewer model over this session's own conversation/tool history (provider-opaque state such as encrypted_content is never included). Reviewer unavailable/timeout -> ordinary tool error; never blocks the turn.",
  exposure: "eager",
  permissionClass: "mcp",
  availability: {},
  capabilityRequirements: ["winter.reviewer-model"],
  disposition: "implement-now",
});
