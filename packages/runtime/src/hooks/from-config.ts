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
// the moment such a producer exists.
//
// Finding 4 (P2 fix-wave) correction: this comment used to end "...with no changes needed here" —
// true of THIS function (it stays a pure, trust-blind converter), but that phrasing steered a future
// P5 loader away from the fact that a trust gate now exists, one call further downstream. Project/
// local sourced entries this function builds are NOT filtered here — they are excluded wholesale by
// hooks/registry.ts's `buildHookRegistry(entries, { trustedWorkspace })` the moment the workspace is
// untrusted (see that function's own header for why the exclusion is wholesale, not partial, unlike
// the rule-side precedent it otherwise mirrors). A P5 loader feeding this function's OUTPUT into
// buildHookRegistry inherits that gate automatically; it must NOT re-implement its own filter here.
import { HOOK_EVENTS, type HookEvent, type HookSource, type ResolvedSettingSource, type RuntimeHooksConfig } from "@yanlinglabs/winter-agent-sdk";
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

// --- Phase 5 Task 2: the SETTINGS-FILE hook block loader (WS-08 §13 OQ3, absorbed into P5) --------
//
// The sibling of buildHookEntriesFromConfig above: same output type, same positional id formula,
// same "unknown event names are accepted, preserved and INERT" rule -- a different INPUT. Where that
// one converts `Options.hooks` after query.ts stripped the callbacks out, this one converts the
// `hooks` block of every settings tier the P5 resolver loaded, which is what finally gives the
// `managed`/`user`/`project`/`local` HookSource values a real producer (P2 typed them and left them
// inert; phase ruling 1 promised P5's loader).
//
// THE TRUST GATE IS DELIBERATELY NOT HERE. hooks/registry.ts's `buildHookRegistry(entries,
// { trustedWorkspace })` already excludes `project`/`local` entries WHOLESALE when the workspace is
// untrusted, and from-config.ts's own header (above) explicitly instructs a P5 loader not to
// re-implement it: two independently-maintained filters over the same obligation is the exact
// producer/consumer drift class R5-2's contract tests exist to catch. This function is a pure,
// trust-blind converter; the seam-contract test (settings/seam-contracts-p5.test.ts section (vi))
// pins the composition, feeding this output into buildHookRegistry and asserting the gate fires.
// A caller MUST route these entries through buildHookRegistry -- never straight into a runner.
//
// RULING P5-A note for whoever wires the caller: the verdict to pass is
// `defaultTrustSource(config).verdict(config.cwd).trusted`, the same value engine.ts already derives
// once for all four trust consumers.

/** A settings hook block that could not be turned into an entry. Reported, never thrown (the brief's own MUST). */
export interface RejectedHookBlock {
  source: ResolvedSettingSource;
  path?: string;
  event?: string;
  reason: string;
}

export interface HookEntriesFromSettings {
  entries: SourcedHookEntry[];
  rejected: RejectedHookBlock[];
}

/** One settings tier's contribution, as `resolveSettingsDetailed` reports it (`perSource`) or as the pinned `ResolvedSettings.sources` does. */
export interface SettingsHookSourceInput {
  source: ResolvedSettingSource;
  path?: string;
  settings?: { hooks?: unknown; [key: string]: unknown };
  values?: { hooks?: unknown; [key: string]: unknown };
  // Declared but unread: BOTH real inputs -- `resolveSettingsDetailed`'s `perSource` entries
  // (`loaded`/`error`) and the pinned `ResolvedSettings.sources` entries (`policyOrigin`) -- must be
  // passable AS OBJECT LITERALS, which excess-property checking would otherwise reject at every
  // call site that builds one inline. Named explicitly rather than swept under an index signature,
  // which would break assignability the other way (neither real entry type declares one).
  policyOrigin?: string;
  loaded?: boolean;
  error?: string;
}

// The two non-file tiers have no HookSource of their own: `flag` IS the sdk/inline tier (R5-8's own
// "inline/sdk" position, which WS-08 §2 already calls `sdk`), and `managed` maps straight across.
const HOOK_SOURCE_BY_SETTING_SOURCE: Record<ResolvedSettingSource, HookSource> = {
  managed: "managed",
  flag: "sdk",
  user: "user",
  project: "project",
  local: "local",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function buildHookEntriesFromSettings(perSource: readonly SettingsHookSourceInput[] | undefined): HookEntriesFromSettings {
  const entries: SourcedHookEntry[] = [];
  const rejected: RejectedHookBlock[] = [];
  if (!perSource) return { entries, rejected };

  for (const tier of perSource) {
    const settings = tier.settings ?? tier.values;
    const hooks = settings?.["hooks"];
    if (hooks === undefined) continue; // no hooks block at all -- not a rejection
    const where = { source: tier.source, ...(tier.path !== undefined ? { path: tier.path } : {}) };
    if (!isPlainObject(hooks)) {
      rejected.push({ ...where, reason: `expected an object for "hooks", got ${Array.isArray(hooks) ? "an array" : typeof hooks}` });
      continue;
    }
    const source = HOOK_SOURCE_BY_SETTING_SOURCE[tier.source];
    for (const [event, groups] of Object.entries(hooks)) {
      // WS-08 §1, identical to buildHookEntriesFromConfig above: an unknown event name is accepted,
      // preserved and inert. It is NOT a rejection -- a settings file written for a newer engine
      // must not start reporting errors on an older one.
      if (!KNOWN_HOOK_EVENTS.has(event)) continue;
      if (!Array.isArray(groups)) {
        rejected.push({ ...where, event, reason: `expected an array of matcher groups, got ${typeof groups}` });
        continue;
      }
      groups.forEach((group, groupIndex) => {
        if (!isPlainObject(group)) {
          rejected.push({ ...where, event, reason: `matcher group ${groupIndex} is not an object` });
          return;
        }
        const groupHooks = group["hooks"];
        if (!Array.isArray(groupHooks)) {
          rejected.push({ ...where, event, reason: `matcher group ${groupIndex} has no "hooks" array` });
          return;
        }
        const matcher = typeof group["matcher"] === "string" ? group["matcher"] : undefined;
        groupHooks.forEach((handler, hookIndex) => {
          if (!isPlainObject(handler)) {
            rejected.push({ ...where, event, reason: `hook ${groupIndex}:${hookIndex} is not an object` });
            return;
          }
          // Phase 5 fix wave, A-3: `handler.type` is VALIDATED. It was read nowhere -- so a block
          // declaring `{ type: "sdk", command: "..." }`, or any other type a newer engine might
          // define, was silently loaded AS A COMMAND HOOK and executed. That is the dangerous
          // direction of "accepted, preserved, inert": a settings file asking for something this
          // engine does not implement got something else instead, with a shell behind it.
          //
          // REPORTED AND SKIPPED, never thrown, matching every other rejection here: one unknown
          // handler must not cost a user the rest of their hooks. An ABSENT `type` is accepted --
          // `{type:"command"}` is the only shape the pin documents for a settings block, so omitting
          // it is an abbreviation of the one legal value rather than a request for something else.
          const declaredType = handler["type"];
          if (declaredType !== undefined && declaredType !== "command") {
            rejected.push({ ...where, event, reason: `hook ${groupIndex}:${hookIndex} declares type ${JSON.stringify(declaredType)}; only "command" is supported in a settings hook block` });
            return;
          }
          if (typeof handler["command"] !== "string" || handler["command"].length === 0) {
            rejected.push({ ...where, event, reason: `hook ${groupIndex}:${hookIndex} is not a { type: "command", command } handler` });
            return;
          }
          // `timeout` is SECONDS in the file (HookCallbackMatcher.timeout's own pinned unit) and
          // milliseconds on the entry -- converted exactly once, here, matching hooks/runner.ts's
          // own requirement that the conversion never happen twice.
          const timeout = handler["timeout"];
          entries.push({
            id: `${event}:${source}:${groupIndex}:${hookIndex}`,
            event: event as HookEvent,
            ...(matcher !== undefined ? { matcher } : {}),
            source,
            ...(typeof timeout === "number" && Number.isFinite(timeout) ? { timeoutMs: timeout * 1000 } : {}),
            command: handler["command"],
          });
        });
      });
    }
  }
  return { entries, rejected };
}
