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
// ONE RECORDED SIDE EFFECT OF THAT `source` VALUE (review r1, Minor-5): registry.ts's
// `resolveDeferral` short-circuits `source: "builtin"` to `"eager"` UNCONDITIONALLY, before it looks
// at `alwaysLoad` or `deferred` ("core built-ins... never deferred through the public surface",
// WS-09 §8). The advisor is therefore structurally non-deferrable now, and adding `deferred: true`
// here later would be a SILENT NO-OP. Its advertised verdict is unchanged by the rename — it
// declared no `deferred` and resolved to `"eager"` before too — but WS-06 §4's contract row still
// calls it "deferred-eligible", so a later phase that wants the advisor in the Tool Search pool must
// change this `source` value, not add a flag.
//
// Input `{}` -- the runtime forwards the session's own conversation/tool history; no model-supplied
// parameters. Availability stays gated on `winter.reviewer-model` (a reviewer must be resolvable in
// the session's provider catalog).
import { ADVISOR_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";

import { stub, builtinNameOf, definitionFields } from "./_shared.ts";

stub({
  // R-8-1: the bare name, the empty input schema, the pinned `{advice, model, truncated?}` output and
  // the description are the SDK definition's; `source`/`exposure`/`availability`/the capability gate
  // are this registry's (P-8).
  ...definitionFields(ADVISOR_DEFINITION),
  canonicalName: builtinNameOf(ADVISOR_DEFINITION),
  advertisedName: builtinNameOf(ADVISOR_DEFINITION),
  source: "builtin",
  exposure: "eager",
  availability: {},
  capabilityRequirements: ["winter.reviewer-model"],
  disposition: "implement-now",
});
