// Phase 4 Task 5 (LANE B, WS-09 §10): aliased built-ins + duplicate suppression.
//
// Source of truth check (derived-shapes-p4.md item (c), pinned 0.3.250): `Options.toolAliases:
// Record<string, string>` is REAL (sdk.d.ts:1461-1486, wire twin 3759-3762) and is already threaded
// end to end on the Winter side as plain data -- `packages/sdk/src/options.ts`, `protocol/config.ts`
// (`RuntimeConfig.toolAliases`), and `query.ts`'s own `--config-json` serialization all carry it
// today (query.test.ts's own "Phase 4 Task 2" fixture). What does NOT exist yet is the actual
// RESOLUTION HOOK POINT inside engine.ts's tool-dispatch loop -- confirmed by grep: zero reads of
// `toolAliases`/`config.toolAliases` anywhere in engine.ts as of this lane's fork point (b883a48).
// R4-10 forbids this lane from editing engine.ts, so this file supplies exactly what the brief asks
// for on that basis ("provide the resolver as a pure function + tests and report NEEDS_CONTEXT for
// the engine call site rather than editing engine.ts") -- see task-5-report.md for the precise call
// sites this still needs.
//
// Pinned doc-comment behavior (derived-shapes-p4.md item (c), verbatim verdict: "matches WS-09 §10
// exactly"): the map is consulted EXACTLY ONCE, at the moment a model-emitted `tool_use` name is
// resolved to an actual tool -- the resolved name is a DESTINATION, never a further key to look up
// (this is what keeps a two-entry loop `{A:'B', B:'A'}` from being a problem). This mechanism only
// ever intercepts the model-emitted, NAME-based lookup path; it cannot substitute for a deny list,
// because a harness-internal caller that already holds a reference to the tool object and invokes it
// directly (never going through a name at all) is untouched by it -- `disallowedTools` remains the
// thing that actually closes that second door (WS-09 §10, same verdict).
import type { AdvertisedPartition, ToolDescriptor } from "../tools/registry.ts";

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
export function suppressAliasedDuplicates(partition: AdvertisedPartition, toolAliases: Record<string, string> | undefined): AdvertisedPartition {
  if (!toolAliases) return partition;

  const allAdvertisedNames = new Set([...partition.eager, ...partition.deferred].map((d) => d.canonicalName));
  const targetsToDefer = new Set<string>();
  for (const [source, target] of Object.entries(toolAliases)) {
    if (allAdvertisedNames.has(source) && allAdvertisedNames.has(target)) {
      targetsToDefer.add(target);
    }
  }
  if (targetsToDefer.size === 0) return partition;

  const eager: ToolDescriptor[] = [];
  const deferred = [...partition.deferred];
  for (const descriptor of partition.eager) {
    if (targetsToDefer.has(descriptor.canonicalName)) deferred.push(descriptor);
    else eager.push(descriptor);
  }
  return { eager, deferred, hidden: partition.hidden };
}
