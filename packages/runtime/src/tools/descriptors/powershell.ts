// WS-06 §3.2 "PowerShell" -- correctly-absent (macOS v1). Same field surface as Bash (captured
// under opt-in); Winter v1 does not advertise it and does not mirror CC's enabling env var (WS-01
// §2.5). Registered here (internal bookkeeping only, never advertised -- see registry.ts's own
// buildAdvertisedSet, which excludes every correctly-absent entry unconditionally) so permission
// rules and drift gates can still recognize the name. Implement-later behind a `pwsh` capability
// gate is the documented future path, not a v1 obligation.
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "PowerShell",
  advertisedName: "PowerShell",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number" },
      description: { type: "string" },
      run_in_background: { type: "boolean" },
      dangerouslyDisableSandbox: { type: "boolean" },
    },
    required: ["command"],
  },
  description: "Native pwsh executor; normally Windows, opt-in elsewhere when PowerShell 7 exists. Correctly absent on Winter macOS v1.",
  exposure: "hidden",
  permissionClass: "execute",
  availability: ALWAYS_AVAILABLE,
  capabilityRequirements: ["pwsh"],
  disposition: "correctly-absent",
});
