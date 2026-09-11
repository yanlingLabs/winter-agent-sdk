// WS-06 §3.6 "ReadNotifications" -- winter-backed-equivalent: drains Winter's global-messaging
// notification queue ([WS-10]), not Anthropic's.
//
// CORRECTION (I4, fix wave, P3 close-out): this file used to claim "available now ... not gated
// behind a not-yet-satisfiable capability" -- that was aspirational, not actual: no `impl/*.ts`
// executor for this descriptor exists anywhere in the codebase (verified before this fix), so a
// real model handed this schema unconditionally got "registered but not yet executable" on every
// call. Now gated on "winter.global-messaging" (see the WebSearch/LSP precedent) until WS-10 wires a
// real executor.
//
// Schema-sweep fix (fix wave, Part B item 4, P3 close-out): `outputSchema` below was a FLAT
// single-notification shape; the pinned 0.3.250 artifact's own `ReadNotificationsOutput`
// (ephemeral checksum-verified fetch, scripts/fetch-upstream.ts -- nothing committed) is
// `{ notifications: Array<{notification_id, origin, queued_at, content}>, remaining: number }` --
// an ARRAY of drained notifications per call, not one. Corrected to match; zero behavioral risk
// (no executor consumes this schema yet -- WS-10 owns building the real thing).
import { READ_NOTIFICATIONS_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";

import { stub, ALWAYS_AVAILABLE, builtinNameOf, definitionFields } from "./_shared.ts";

stub({
  // R-8-1: `{}` in, the drained page out -- declared once in the SDK, bound here.
  ...definitionFields(READ_NOTIFICATIONS_DEFINITION),
  canonicalName: builtinNameOf(READ_NOTIFICATIONS_DEFINITION),
  advertisedName: builtinNameOf(READ_NOTIFICATIONS_DEFINITION),
  source: "builtin",
  exposure: "eager",
  availability: ALWAYS_AVAILABLE,
  // I4 (fix wave, P3 close-out): gated on "winter.global-messaging" -- this descriptor has no `impl/*.ts`
  // executor anywhere in the codebase yet (owned by WS-10), so advertising it unconditionally
  // handed a real model a schema for a tool that always answers "registered but not yet
  // executable" (registry.ts). Mirrors the WebSearch/LSP precedent -- a capability token, not
  // `executor !== undefined` (which would also silently hide a test-registered executorless tool).
  //
  // A DELIBERATE WINTER EXTENSION, recorded because the evidence points the other way (whole-branch
  // review M4, fix wave). T8's Scenario D capture of the pinned 0.3.250 runtime enumerated the
  // official default session's 24 advertised tools; `SendMessage`, `ListAgents` and `Agent` are all
  // there and `ReadNotifications` is NOT. WS-00 §1's "evidence wins" was applied to the winter.mcp
  // family on exactly that basis (gated on `hasMcpServers`, which dropped golden churn from +9 names
  // to +4), so applying it here too would mean gating or removing this descriptor.
  //
  // It stays advertised, as a judgment recorded rather than an oversight inherited: `ReadNotifications`
  // is a `winter-backed-equivalent` (this file's own `disposition`) -- it drains WINTER's global
  // messaging queue, a Winter-owned mechanism with no official counterpart, so the official session's
  // silence about it is not evidence about a tool the official runtime does not have. It is also the
  // only READ side of a queue Winter's own `SendMessage` fills: advertising the write half and
  // withholding the read half would leave the model able to enqueue and unable to drain. The
  // reviewable cost is one name in every `init.tools` golden that the capture does not back; that
  // name is the one to revisit first if a later capture shows a real official equivalent.
  //
  // (SB review r1: the two paragraphs above were lost when this descriptor's schema literal was
  // replaced by the SDK definition. Nothing about that change touched the judgment -- the
  // `capabilityRequirements` value below is still exactly the one they explain -- so they are
  // restored verbatim from e29dd99. The "no `impl/*.ts` executor... yet" clause in the first one was
  // already overtaken when it was written down; it is kept as the record of why the gate was added
  // rather than silently corrected in a comment-only restoration.)
  capabilityRequirements: ["winter.global-messaging"],
  disposition: "winter-backed-equivalent",
});
