// Phase 4 fix wave (I3, whole-branch review): WS-10 §7's "the roster rebuilds from durable storage"
// finally has a PRODUCTION caller.
//
// `rebuildChildRoster` (roster.ts) was correct, independently tested, and dead: `grep -rn
// rebuildChildRoster packages/` found only its own definition and its unit tests, while
// `subagents/conformance.test.ts` cited those unit tests as coverage for the MUST. A resumed session
// therefore started with an EMPTY `childRoster` (engine.ts), so after a restart `SendMessage` to a
// prior child answered `not_found` and `ListAgents` showed nothing -- the child was unreachable by
// any tool, permanently. Mutual deferral: Lane C disclosed "no live handle rehydration" as a
// follow-up; T8's riders never took it; the matrix said "covered".
//
// WHAT THIS DELIVERS, AND WHAT IT DELIBERATELY DOES NOT. Rebuilding IDENTITY (the WS-10 §7 MUST's
// first half) is what makes a restored child addressable at all -- `ListAgents` lists it,
// `SendMessage` resolves it by id or name, and the row carries its real recorded status, model and
// permission triple. Rebuilding a LIVE, resumable child is a genuinely separate thing: a running
// generation needs a `ChildEngineRunContext` (forwardChildFrame onto the host stream this run owns,
// the P4-I response roster) that exists only INSIDE `runEngine`'s own spawn seam, plus the
// factory's provider/store -- none of which a restore performed BEFORE `runEngine` starts can hold.
// So a restored handle refuses `resume()` with a legible, NON-retryable outcome naming the carry,
// rather than pretending: WS-10 §10.3's "a terminal addressable child auto-resumes" is honoured for
// a child spawned in THIS process and explicitly deferred for one restored across a restart.
import type { SessionStore } from "@yanlinglabs/winter-agent-sdk";
import type { ChildHandle, ChildResult, ChildSessionRecord } from "./child-handle.ts";
import { rebuildChildRoster, successfulRecords, type RosterKey } from "./roster.ts";
import { ensureDefaultMessagingRuntimeRegistered } from "../messaging/reference-adapter.ts";
import type { GlobalAgentMessage, DeliveryOutcome } from "../messaging/adapter.ts";
import type { RecordedModelEffort } from "./resolution.ts";

// The one place a rebuilt RECORD becomes a ChildHandle the messaging layer can list and address.
// Every method answers from the durable record alone -- there is no live engine behind it.
export function restoredChildHandle(record: ChildSessionRecord): ChildHandle {
  const terminal: ChildResult["status"] = record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : "stopped";
  return {
    record,
    // `rebuildChildRoster` already reconciles a sidecar still claiming `running` (its own process
    // died) to `stopped`, so this is always terminal -- a restored child is never advertised as
    // live, which is what keeps `SendMessage` from trying to STEER something with no engine behind it.
    status: () => record.status,
    async steer(msg: GlobalAgentMessage): Promise<DeliveryOutcome> {
      return { status: "not_found", messageId: msg.messageId, reason: `child ${record.id} is not running (status: ${record.status})` };
    },
    async resume(msg: GlobalAgentMessage): Promise<DeliveryOutcome> {
      // WS-13c §8 (Lane D Task 5): "a restored handle's refusal text carries the recorded provider
      // id." `ChildSessionRecord.model` (child-handle.ts, spine-frozen) still declares the pre-P6.6
      // inline shape -- the spine added `effectiveProvider`/`slot` to `RecordedModelEffort`
      // (resolution.ts) without re-pointing this field at it (the same gap child-engine.ts's own
      // `record` declaration works around locally; see this lane's report). `rebuildChildRoster`
      // (roster.ts) reconstructs a child's sidecar via `{ type: _type, ...record }` -- a spread, not
      // a field-by-field rebuild -- so an `effectiveProvider` child-engine.ts wrote at spawn/resume
      // survives the round trip onto this object even though its OWN declared type does not name it;
      // a local cast reads it back without touching the frozen type.
      const modelInfo = record.model as RecordedModelEffort;
      const providerNote = modelInfo.effectiveProvider !== undefined ? ` (recorded provider: ${modelInfo.effectiveProvider})` : "";
      return {
        status: "unavailable",
        messageId: msg.messageId,
        retryable: false,
        reason:
          `child ${record.id} was restored from durable storage after a restart -- its identity and transcript are available ` +
          `(${record.transcript})${providerNote}, but reviving a live generation across a process restart is not implemented yet (WS-10 §7 carry)`,
      };
    },
    async result(): Promise<ChildResult> {
      return { status: terminal, content: `restored from durable storage -- the authoritative record is its transcript: ${record.transcript}` };
    },
    async stop(): Promise<void> {
      /* already terminal -- idempotent, exactly like a live handle's own stop() on a settled child */
    },
  };
}

export interface RestoredChildRoster {
  handles: ChildHandle[];
  // Withdraws the restored roster from the process-level messaging runtime -- the same discipline
  // engine.ts's own per-run `removeChildRosterSource` follows, and load-bearing for the in-memory
  // leg, where one process runs many sessions in sequence.
  remove(): void;
}

// Rebuilds the roster for one session and contributes it to the process-level messaging runtime, so
// `ListAgents`/`SendMessage` see restored children alongside the ones this run spawns itself.
// Never throws: a store with no children, an unreadable sidecar, or a store that cannot list
// subkeys at all yields an empty roster (rebuildChildRoster's own per-child error handling), because
// failing to restore a roster must never prevent a session from starting.
export async function restoreChildRoster(store: SessionStore, key: RosterKey): Promise<RestoredChildRoster> {
  let handles: ChildHandle[] = [];
  try {
    handles = successfulRecords(await rebuildChildRoster(store, key)).map(restoredChildHandle);
  } catch {
    handles = [];
  }
  if (handles.length === 0) return { handles, remove: () => {} };
  const remove = ensureDefaultMessagingRuntimeRegistered().addChildRosterSource(() => handles);
  return { handles, remove };
}
