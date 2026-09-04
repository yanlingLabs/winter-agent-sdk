// Phase 4 Task 5 (LANE B, WS-09 §10): aliased built-ins + duplicate suppression.
//
// Source of truth check (derived-shapes-p4.md item (c), pinned 0.3.250): `Options.toolAliases:
// Record<string, string>` is REAL (sdk.d.ts:1461-1486, wire twin 3759-3762) and is already threaded
// end to end on the Winter side as plain data -- `packages/sdk/src/options.ts`, `protocol/config.ts`
// (`RuntimeConfig.toolAliases`), and `query.ts`'s own `--config-json` serialization all carry it
// today (query.test.ts's own "Phase 4 Task 2" fixture).
//
// STALE-COMMENT SWEEP (P4 fix wave, KNOWN (8)): the two paragraphs replaced here said the resolution
// HOOK POINT inside engine.ts's dispatch loop "does NOT exist yet" and that R4-10 forbade that lane
// from adding it, so this file was to ship the resolver unwired and report NEEDS_CONTEXT. Both were
// true at the fork point (b883a48) and both are now DISCHARGED: engine.ts calls
// `suppressAliasedDuplicates` at its advertised-partition site (Task 8 rider 3) and
// `resolvePermissionIdentity` at its dispatch loop (this fix wave, RULING P4-E amended), and
// `effectiveAliasTable` supplies the default table to both plus `computeExposurePartition`. Nothing
// in this file is unwired.
//
// Pinned doc-comment behavior (derived-shapes-p4.md item (c), verbatim verdict: "matches WS-09 §10
// exactly"): the map is consulted EXACTLY ONCE, at the moment a model-emitted `tool_use` name is
// resolved to an actual tool -- the resolved name is a DESTINATION, never a further key to look up
// (this is what keeps a two-entry loop `{A:'B', B:'A'}` from being a problem). This mechanism only
// ever intercepts the model-emitted, NAME-based lookup path; it cannot substitute for a deny list,
// because a harness-internal caller that already holds a reference to the tool object and invokes it
// directly (never going through a name at all) is untouched by it -- `disallowedTools` remains the
// thing that actually closes that second door (WS-09 §10, same verdict).
import { getRegisteredTool, isBareDenied, type AdvertisedPartition, type ToolDescriptor } from "../tools/registry.ts";

// The Winter branch's own canonical alias pair, declared ONCE (it moved here from a `const` inside
// engine.ts's `runEngine` when RULING P4-E was amended): it is now read by THREE consumers -- the
// advertised-partition suppression below, `computeExposurePartition` (exposure.ts, so ToolSearch's
// own candidate pool agrees with `init.tools`), and the permission/hook identity resolution at
// engine.ts's dispatch loop. A security-relevant table living in more than one file is exactly the
// producer/consumer drift class R4-2 exists to catch.
//
// WS-10 §15 names this pair verbatim: [WS-14] redirects the model-visible `SendMessage`/`ListAgents`
// built-ins at `mcp__winter__send_message`/`mcp__winter__list_agents`. On the WINTER branch those
// canonical names are real, registered descriptors (descriptors/winter-*.ts, `deferred: true` at the
// source) backed by the SAME executor objects as the native names.
export const WINTER_CANONICAL_ALIASES: Readonly<Record<string, string>> = {
  SendMessage: "mcp__winter__send_message",
  ListAgents: "mcp__winter__list_agents",
};

// The effective table for a session: the Winter-branch defaults with the HOST's own
// `Options.toolAliases` layered on top (a host that redirects `SendMessage` somewhere else means it).
export function effectiveAliasTable(hostAliases: Record<string, string> | undefined): Record<string, string> {
  return { ...WINTER_CANONICAL_ALIASES, ...(hostAliases ?? {}) };
}

export function resolveToolAlias(name: string, toolAliases: Record<string, string> | undefined): string {
  if (!toolAliases) return name;
  const target = toolAliases[name];
  // `target` may legitimately be `""` in a pathological config; `undefined` (the key is simply
  // absent) is the only case that means "not aliased" -- an explicit-but-empty mapping is still a
  // caller's (mis)configuration to own, not this function's to silently paper over.
  return target !== undefined ? target : name;
}

// WS-09 §10 "Duplicate suppression": "when a built-in is aliased to a canonical `mcp__winter__*`
// entry, Winter defers the duplicate canonical MCP entries where supported so the model normally
// sees ONE SendMessage and ONE ListAgents... on the Winter branch the registry advertises the
// built-in-compatible name directly and keeps the canonical entry deferred."
//
// Reads `toolAliases` as {modelFacingName -> canonicalTargetName} (the exact direction
// `Options.toolAliases` itself uses, e.g. `{SendMessage: "mcp__winter__send_message"}`,
// derived-shapes-p4.md item (c)). For every entry whose SOURCE name is advertised somewhere in this
// partition (eager or deferred -- i.e. the model already has, or can already discover, that native
// spelling) AND whose TARGET name is currently sitting in `eager`, this moves the target descriptor
// into `deferred` -- never removes it outright (WS-09 §10: "the registry advertises the
// built-in-compatible name directly and keeps the canonical entry deferred", not hidden; a model
// that already knows the exact canonical name can still ToolSearch-select it). A target that is
// already deferred, hidden, or simply absent from this partition is left untouched -- there is
// nothing to deduplicate against.
//
// Ground truth (WS-09 §9/§127, brief verbatim): this function operates on an ALREADY-COMPUTED
// `AdvertisedPartition` (the live per-session result of `partitionAdvertisedTools`) -- it is a
// post-processing step on real registry output, never a second, independently-derived guess at what
// is advertised. aliases.test.ts drives it against a real partition built from real registrations,
// per this file's own package-level convention (exposure.test.ts's identical discipline).
//
// RULING P4-E AMENDED (whole-branch C2): this is now the SECOND of two passes. `hideAliasExcludedTwins`
// runs FIRST -- suppression's own "is the source advertised?" test is exactly what made a DENIED
// native surface its canonical twin eagerly, so the exclusion pass has to have settled before this
// one asks the question.
export function suppressAliasedDuplicates(
  partition: AdvertisedPartition,
  toolAliases: Record<string, string> | undefined,
  disallowedTools?: readonly string[],
): AdvertisedPartition {
  const base = hideAliasExcludedTwins(partition, toolAliases, disallowedTools);
  if (!toolAliases) return base;

  const allAdvertisedNames = new Set([...base.eager, ...base.deferred].map((d) => d.canonicalName));
  const targetsToDefer = new Set<string>();
  for (const [source, target] of Object.entries(toolAliases)) {
    if (allAdvertisedNames.has(source) && allAdvertisedNames.has(target)) {
      targetsToDefer.add(target);
    }
  }
  if (targetsToDefer.size === 0) return base;

  const eager: ToolDescriptor[] = [];
  const deferred = [...base.deferred];
  for (const descriptor of base.eager) {
    if (targetsToDefer.has(descriptor.canonicalName)) deferred.push(descriptor);
    else eager.push(descriptor);
  }
  return { eager, deferred, hidden: base.hidden };
}

// --- RULING P4-E amended: exclusion travels along the alias edge ---------------------------------
//
// The whole-branch review's CRITICAL C2, restated as the invariant this function enforces: a name
// this session EXCLUDES must not be reachable under a second spelling. `suppressAliasedDuplicates`
// alone could never enforce it -- it keys on the source being advertised, so `disallowedTools:
// ["SendMessage"]` (which unadvertises the source) silently DISABLED suppression and let
// `mcp__winter__send_message` -- the identical executor object under the canonical spelling -- resolve
// EAGER into `system/init.tools`, callable with no deny rule and no hook matcher matching it.
//
// Two directions, deliberately asymmetric in their trigger:
//
//   (1) source REGISTERED but not advertised  ->  hide the TARGET.
//       "Denied or excluded" per the amendment: a bare deny, a capability/platform/mode gate, an
//       `exposure:"hidden"` descriptor -- every reason the native spelling is not on offer is a
//       reason its twin must not be either. Keyed on `getRegisteredTool(source)` so a host alias
//       whose SOURCE is not a Winter tool at all (an arbitrary model-facing label, which is a
//       perfectly ordinary `Options.toolAliases` use) is a no-op rather than a mass hide.
//
//   (2) target BARE-DENIED  ->  hide the SOURCE.
//       The T8 review's M6, second door: a deny written against the alias TARGET already gates
//       EXECUTION (identity resolution below resolves the source's call to the target), but the
//       source stayed advertised -- the model was offered a tool every call to which is refused.
//       Restricted to a BARE DENY rather than "excluded for any reason" on purpose: the native and
//       its twin do not carry identical availability axes (`SendMessage` requires
//       `winter.subagents`, `mcp__winter__send_message` requires `winter.global-messaging`), so a
//       symmetric "any exclusion" rule here would let one family's capability gate silently take
//       out the other family's tool.
// The names this pass takes away, and WHY -- factored out of `hideAliasExcludedTwins` (NEW-5,
// residual round) because the dispatch loop needs the same answer for a different purpose. A tool
// hidden HERE is not "deferred and unloaded": no `select:` can ever load it, so refusing a call to
// one with the load-first hint sends the model to a ToolSearch that will never return it. The reason
// string is what lets the dispatch boundary say what actually happened instead.
export interface AliasExclusion {
  reason: string;
  // WHICH of the two directions took the name away. It matters at dispatch: only
  // `native-excluded` needs a bespoke refusal. A `target-denied` source still reaches the permission
  // pipeline, where a real rule denies it -- a `permission_denied` frame and a
  // `result.permission_denials` entry, which is strictly better than an availability-class refusal
  // and is what the C2 fixtures pin.
  cause: "native-excluded" | "target-denied";
}

export function aliasExclusionReasons(
  partition: AdvertisedPartition,
  hostAliases: Record<string, string> | undefined,
  disallowedTools: readonly string[] | undefined,
): Map<string, AliasExclusion> {
  const table = effectiveAliasTable(hostAliases);
  const advertised = new Set([...partition.eager, ...partition.deferred].map((d) => d.canonicalName));
  const reasons = new Map<string, AliasExclusion>();
  for (const [source, target] of Object.entries(table)) {
    if (source === target) continue;
    if (advertised.has(target) && !advertised.has(source) && getRegisteredTool(source) !== undefined) {
      reasons.set(target, {
        cause: "native-excluded",
        reason: `its native spelling '${source}' is denied or excluded in this session, and RULING P4-E hides the canonical twin with it`,
      });
    }
    if (advertised.has(source) && isBareDenied(target, disallowedTools)) {
      reasons.set(source, { cause: "target-denied", reason: `it resolves to '${target}', which this session denies (disallowedTools)` });
    }
  }
  return reasons;
}

export function hideAliasExcludedTwins(
  partition: AdvertisedPartition,
  hostAliases: Record<string, string> | undefined,
  disallowedTools: readonly string[] | undefined,
): AdvertisedPartition {
  const toHide = new Set(aliasExclusionReasons(partition, hostAliases, disallowedTools).keys());
  if (toHide.size === 0) return partition;

  const eager: ToolDescriptor[] = [];
  const deferred: ToolDescriptor[] = [];
  const hidden = [...partition.hidden];
  for (const descriptor of partition.eager) {
    if (toHide.has(descriptor.canonicalName)) hidden.push(descriptor);
    else eager.push(descriptor);
  }
  for (const descriptor of partition.deferred) {
    if (toHide.has(descriptor.canonicalName)) hidden.push(descriptor);
    else deferred.push(descriptor);
  }
  return { eager, deferred, hidden };
}

// --- RULING P4-E amended: permission/hook identity is alias-aware in BOTH directions --------------

// Every spelling one call may be judged under, PRIMARY FIRST. The primary is still exactly what
// P4-E pinned -- `resolveToolAlias(call.name, config.toolAliases)`, the HOST's own forward mapping --
// so a session that configures no aliases and writes no rule against a canonical twin behaves
// byte-identically to before this amendment. The alternates are the rest of the single-hop
// equivalence set over the EFFECTIVE table (defaults + host): the call's own unresolved name, its
// forward target, and every source that aliases TO it.
//
// Single-hop by construction, exactly as `resolveToolAlias` is: a resolved name is a destination,
// never a further key to look up, so a two-entry loop `{A:'B', B:'A'}` terminates here too.
export function aliasPermissionIdentities(name: string, hostAliases: Record<string, string> | undefined): string[] {
  const table = effectiveAliasTable(hostAliases);
  const primary = resolveToolAlias(name, hostAliases);
  const out = [primary];
  const push = (candidate: string | undefined): void => {
    if (candidate !== undefined && !out.includes(candidate)) out.push(candidate);
  };
  push(name);
  push(table[name]);
  for (const [source, target] of Object.entries(table)) {
    if (target === name) push(source);
  }
  return out;
}

// What a caller must be able to answer about ONE candidate identity. Every probe is a pure lookup
// against state the engine already holds (the live rule set; the hook registry) -- deliberately
// injected rather than imported, so this module stays free of `permissions/**` and `hooks/**` and
// can be unit-tested with plain literals.
export interface AliasIdentityProbes {
  deniedByRule(name: string): boolean;
  askedByRule(name: string): boolean;
  // A hook registration with an EXPLICIT matcher selects this name. Matcher-absent ("matches every
  // occurrence", WS-08 §2.1) registrations must NOT count -- they match every identity equally, so
  // letting them vote would flip the identity of every call in a session with one global hook.
  hookScoped(name: string): boolean;
  allowedByRule(name: string): boolean;
}

// STRICTEST-OF over the identity set, in one pass, producing the ONE name the permission pipeline is
// then run against. Running `evaluate()` once per identity and combining afterwards was the obvious
// alternative and is wrong: an `ask` identity would prompt the user twice.
//
// Order is the strictness order WS-07 already uses -- deny beats ask beats allow -- with the hook
// probe slotted between ask and allow so "hooks match both spellings" (the amendment, verbatim)
// holds without a hook ever being able to loosen a rule-derived outcome. When nothing matches on any
// identity, the primary wins and behaviour is unchanged.
export function resolvePermissionIdentity(name: string, hostAliases: Record<string, string> | undefined, probes: AliasIdentityProbes): string {
  const identities = aliasPermissionIdentities(name, hostAliases);
  if (identities.length === 1) return identities[0]!;
  for (const probe of [probes.deniedByRule, probes.askedByRule, probes.hookScoped, probes.allowedByRule]) {
    for (const identity of identities) {
      if (probe(identity)) return identity;
    }
  }
  return identities[0]!;
}
