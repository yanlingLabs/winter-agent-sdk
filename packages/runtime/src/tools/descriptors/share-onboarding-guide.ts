// WS-06 §3.2 "ShareOnboardingGuide" -- winter-backed-later, runtime-derived, verbatim schema.
// Winter's later equivalent is WINTER.md-oriented and points at a Winter backend; absent until that
// backend exists.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "ShareOnboardingGuide",
  advertisedName: "ShareOnboardingGuide",
  source: "host",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["check", "update", "create", "delete"] },
      short_code: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["created", "updated", "deleted", "has_existing", "unavailable"] },
      share_url: { type: "string" },
      short_code: { type: "string" },
      message: { type: "string" },
    },
    required: ["status", "message"],
  },
  // P7a fix wave (item 5, M-1): reworded generically, exactly as Lane A did for `enter-worktree`
  // and `cron-create`. `stub({...})` is evaluated at module load with a STATIC description, so this
  // string cannot be session-aware without moving every tool's advertised description onto a
  // per-session render path -- a registry change, not a brand fix. A generic sentence is honest
  // under every brand including Winter's; naming a file a reuser's product does not have is not.
  description: "64 KiB source cap. The later equivalent is oriented around this product's own instructions file and backed by a first-party backend -- absent until that backend exists.",
  // See send-user-file.ts's identical comment: exposure:"hidden" is reserved for correctly-absent
  // tools; a winter-backed-later tool relies on capabilityRequirements to stay unadvertised today.
  exposure: "eager",
  permissionClass: "hosted",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["winter.onboarding-guide-backend"],
  disposition: "winter-backed-later",
});
