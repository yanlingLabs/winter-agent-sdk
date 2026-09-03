// WS-06 §3.2 "Monitor" -- implement-now, captured, verbatim schema. Dual class in prose
// ("execute/network") -- PRIMARY class picked here is "execute" (the command half uses the Bash
// permission family per spec text; the ws half's own network checks are additional, not the
// tool's identity). Availability across backends ([WS-13] provider capability) is left to Lane C's
// own executor-level checks at T1 (declarative per-provider gating needs the catalog metadata this
// phase does not yet have -- R3-4-style carry, not modeled here to avoid inventing an unpinned
// capability token).
//
// M1 schema-sweep fix (fix wave, Part B item 4, P3 close-out): decided ONCE, uniformly, across
// Bash/Monitor/ScheduleWakeup, per the ephemeral checksum-verified fetch of the pinned 0.3.250
// tarball's own `sdk-tools.d.ts` (nothing committed; see this repo's own scripts/fetch-upstream.ts,
// mirroring derived-shapes-p3-task8.md's method exactly). `MonitorInput.timeout_ms`'s own pinned doc
// comment ("Kill the monitor after this deadline. Default 300000ms, max 3600000ms.") carries the
// bound as PROSE ONLY -- json-schema-to-typescript renders no distinct `minimum`/`maximum` JSON
// Schema keyword for this field, the IDENTICAL evidentiary shape T8 already found for
// ScheduleWakeup's own `delaySeconds` (derived-shapes-p3-task8.md: "carries NO schema-level
// minimum/maximum -- clamping is runtime-only"). `minimum: 1000, maximum: 3600000` below were
// therefore UNPINNED (this lane's own guess, same class of mistake ScheduleWakeup's pre-T8 version
// made) and are removed -- the runtime clamp (impl/monitor.ts's own MIN_TIMEOUT_MS/MAX_TIMEOUT_MS,
// already a REJECT not a clamp for Monitor, unchanged by this fix) is the only enforcement, exactly
// as pinned. Bash's own `timeout` field needed no change: it already carries no schema-level
// `maximum` (bash.ts's own header already documents this as deliberate), which this same fetch
// confirms is the correct posture (BashInput.timeout's doc comment: "max 600000" as prose only, no
// distinct schema keyword either).
import { stub, ALWAYS_AVAILABLE } from "./_shared.ts";

stub({
  canonicalName: "Monitor",
  advertisedName: "Monitor",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      description: { type: "string" },
      timeout_ms: { type: "number" },
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
