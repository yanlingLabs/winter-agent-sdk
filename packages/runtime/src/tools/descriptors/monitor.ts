// WS-06 §3.2 "Monitor" -- implement-now, captured, verbatim schema. Dual class in prose
// ("execute/network") -- PRIMARY class picked here is "execute" (the command half uses the Bash
// permission family per spec text; the ws half's own network checks are additional, not the
// tool's identity). Availability across backends ([WS-13] provider capability) is left to Lane C's
// own executor-level checks at T1 (declarative per-provider gating needs the catalog metadata this
// phase does not yet have -- R3-4-style carry, not modeled here to avoid inventing an unpinned
// capability token).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Monitor",
  advertisedName: "Monitor",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string" },
      timeout_ms: { type: "number", minimum: 1000, maximum: 3600000 },
      persistent: { type: "boolean" },
      command: { type: "string" },
      ws: {
        type: "object",
        properties: { url: { type: "string" }, protocols: { type: "array", items: { type: "string" } } },
        required: ["url"],
      },
    },
    required: ["description", "timeout_ms", "persistent"],
  },
  description:
    "Exactly one of command/ws. Stdout lines or WS frames re-enter the conversation as events; persistent = session-lifetime until TaskStop. Command half uses the Bash permission family; WS half has its own approval + network checks.",
  exposure: "eager",
  permissionClass: "execute",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: [],
  disposition: "implement-now",
});
