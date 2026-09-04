// Phase 4 Task 5 (LANE B, WS-09 §9): the exposure-mapping consumption layer ToolSearch/
// WaitForMcpServers stand on.
//
// This file is deliberately THIN -- RULING P4-A (task-2/task-3 adjudication, ledgered
// 2026-09-04-winter-phase-04-mcp-toolsearch-subagents/progress.md) already assigned the actual
// eager/deferred/hidden resolution to the spine (`resolveDeferral`/`partitionAdvertisedTools`,
// registry.ts, Task 3), specifically so there is only ONE "is Tool Search on" / "is this descriptor
// deferred" authority in the whole codebase. Reimplementing that logic here -- even a supposedly
// equivalent copy -- would be exactly the producer/consumer drift class R4-2 exists to catch, one
// layer up. Everything below is a call-through + reshape for ToolSearch's own specific needs (a
// live, per-call-recomputed candidate pool + a total-count), never a second decision-maker.
//
// Ground truth (WS-09 §8.5/§9, brief verbatim): "your fixtures assert what the model would RECEIVE
// (the partition's eager list / the tool_reference emission), not registry intent." Every test in
// this file's own exposure.test.ts therefore drives a REAL registered descriptor through
// `partitionAdvertisedTools` (never a hand-built ToolDescriptor object asserted against in isolation)
// so a fixture can never pass by agreeing with itself.
import { partitionAdvertisedTools, type AdvertisedSetInputs, type DeferralActivation, type ToolDescriptor } from "../tools/registry.ts";
import { hideAliasExcludedTwins } from "./aliases.ts";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";

// The subset of `AdvertisedSetInputs` ToolSearch/WaitForMcpServers need, plus the `DeferralActivation`
// `partitionAdvertisedTools` itself requires as a second argument. `mode` is taken as a plain value
// here (not a getter) -- unlike engine.ts's own `isDeferredAndUnloaded` closure (which re-reads
// `policyStateStore.getState().mode` fresh on every call because IT owns the live store), this
// module has no live store of its own to read from; search.ts's own `ToolSearchSessionRuntime` is
// what carries a live `getMode()` getter one level up, calling into this function fresh each time
// specifically so a mid-session `setPermissionMode` is reflected on the very next ToolSearch call
// (see search.ts's own header for that seam).
export interface ExposureQuery {
  mode: PermissionMode;
  activation: DeferralActivation;
  platform?: NodeJS.Platform;
  capabilities?: readonly string[];
  disallowedTools?: readonly string[];
  insideSubagent?: boolean;
  familyMetadata?: { taskNative?: boolean };
  // The HOST's own `Options.toolAliases` (RULING P4-E amended). Optional: the Winter-branch DEFAULT
  // canonical table is applied unconditionally by `hideAliasExcludedTwins` regardless, so a caller
  // that supplies nothing here still gets the C2 guarantee for the two canonical twins -- this field
  // only widens the same guarantee to a host-configured alias edge.
  toolAliases?: Record<string, string>;
}

export interface DeferredCandidates {
  eager: readonly ToolDescriptor[];
  deferred: readonly ToolDescriptor[];
  hidden: readonly ToolDescriptor[];
  // WS-09 §8.2's own `total_deferred_tools` result field -- always `deferred.length`, exposed here
  // as its own named value so a caller (search.ts) never has to re-derive it and risk drifting from
  // whatever `deferred` itself was computed from.
  totalDeferredTools: number;
}

// WS-09 §9's whole table, resolved for THIS session (mode + activation) against the LIVE registry --
// `partitionAdvertisedTools` calls `buildAdvertisedSet`, which reads `listRegisteredTools()` fresh on
// every invocation (registry.ts's own module-level Map, never a frozen snapshot), so calling this
// function again after a server connects/reconnects mid-session picks up the change with no cache to
// invalidate. `providerSupportsToolSearch: false` (WS-09 §8.1's provider-fallback contract) already
// makes `deferred` unconditionally empty here, by construction (`isDeferralActive`'s own first
// branch, registry.ts) -- "provider fallback -> full injection" therefore requires no special-casing
// in this function at all; exposure.test.ts proves it observably rather than merely trusting the
// upstream comment.
export function computeExposurePartition(query: ExposureQuery): DeferredCandidates {
  const cfg: AdvertisedSetInputs = {
    mode: query.mode,
    ...(query.platform !== undefined ? { platform: query.platform } : {}),
    ...(query.capabilities !== undefined ? { capabilities: query.capabilities } : {}),
    ...(query.disallowedTools !== undefined ? { disallowedTools: query.disallowedTools } : {}),
    ...(query.insideSubagent !== undefined ? { insideSubagent: query.insideSubagent } : {}),
    ...(query.familyMetadata !== undefined ? { familyMetadata: query.familyMetadata } : {}),
  };
  // RULING P4-E amended (whole-branch C2): the alias-EXCLUSION pass, and ONLY that pass. ToolSearch's
  // candidate pool must never offer a spelling `init.tools` withheld -- a deferred tool is one
  // `select:` away from being callable, so "absent from init.tools but searchable" is not a smaller
  // hole than the eager one C2 found, merely a slower one.
  //
  // Deliberately NOT `suppressAliasedDuplicates`: that function's OTHER half moves an alias target
  // eager -> deferred, which would inflate `total_deferred_tools` for a session whose activation is
  // off (where `partition.deferred` is empty by construction) and change a committed golden's own
  // count. Duplicate suppression is a MODEL-FACING listing concern that `init.tools` owns; exclusion
  // is a security concern both surfaces owe.
  const partition = hideAliasExcludedTwins(partitionAdvertisedTools(cfg, query.activation), query.toolAliases, query.disallowedTools);
  return { eager: partition.eager, deferred: partition.deferred, hidden: partition.hidden, totalDeferredTools: partition.deferred.length };
}
