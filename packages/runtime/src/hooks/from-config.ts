// Task 10 (WS-08 §1/§2; phase ruling 1): builds a HookRegistry's own SourcedHookEntry[] input from
// the wire-safe RuntimeConfig.hooks — the converter T9's own report flagged as deliberately NOT
// built ("no real producer yet... no consumer to validate against... documented future work instead
// of speculative code"). Only ever produces entries for KNOWN HookEvent names (WS-08 §1: an unknown
// event name is "accepted, preserved, inert" — never registered as a matchable participant, which is
// exactly what skipping it here achieves; HookRegistry.matching() is typed against the closed
// HookEvent union anyway, so an unknown key could never become a live registration through that API
// regardless of what this function did). The id/name/timeout derivation matches query.ts's own
// INDEPENDENT derivation of the identical values exactly (protocol/config.ts's own
// RuntimeHookMatcherGroup header: the shared positional formula, deterministic on both sides without
// exchanging anything at config time) — this file and query.ts are the two independent
// implementations that MUST agree; never a shared function (WS-02 §3: the sdk never imports the
// runtime, and the runtime never imports the sdk's own internal wiring beyond its public barrel).
//
// Only "sdk"-sourced groups have a real producer at P2 (query.ts's own Options.hooks conversion) —
// filesystem-configured (managed/user/project/local) sources are typed but inert until P5's settings
// loader exists (phase ruling 1); this function is source-agnostic and will pick those up for free
// the moment such a producer exists, with no changes needed here.
import { HOOK_EVENTS, type HookEvent, type RuntimeHooksConfig } from "@yanlinglabs/winter-agent-sdk";
import type { SourcedHookEntry } from "./registry.ts";

const KNOWN_HOOK_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENTS);

export function buildHookEntriesFromConfig(config: RuntimeHooksConfig | undefined): SourcedHookEntry[] {
  if (!config) return [];
  const entries: SourcedHookEntry[] = [];
  for (const [event, groups] of Object.entries(config)) {
    if (!KNOWN_HOOK_EVENTS.has(event)) continue; // WS-08 §1: unknown event names accepted+preserved+INERT
    (groups ?? []).forEach((group, groupIndex) => {
      for (let hookIndex = 0; hookIndex < group.hookCount; hookIndex++) {
        const name = group.hookNames?.[hookIndex];
        entries.push({
          id: `${event}:${group.source}:${groupIndex}:${hookIndex}`,
          ...(name !== undefined && name !== null ? { name } : {}),
          event: event as HookEvent,
          ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          source: group.source,
          ...(group.timeoutSec !== undefined ? { timeoutMs: group.timeoutSec * 1000 } : {}),
        });
      }
    });
  }
  return entries;
}
