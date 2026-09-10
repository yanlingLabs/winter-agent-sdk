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
  capabilityRequirements: ["winter.global-messaging"],
  disposition: "winter-backed-equivalent",
});
