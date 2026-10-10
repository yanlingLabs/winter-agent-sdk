// Durable identities are discovered before runEngine. Live execution is rebound lazily after
// the new parent has established its host stream, policy and tool context.
import type { SessionStore } from "@yanlinglabs/winter-agent-sdk";
import type { ChildHandle, ChildResult, ChildSessionRecord } from "./child-handle.ts";
import { rebuildChildRoster, successfulRecords, type RosterKey } from "./roster.ts";
import { ensureDefaultMessagingRuntimeRegistered } from "../messaging/reference-adapter.ts";
import type { GlobalAgentMessage, DeliveryOutcome } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { RecordedModelEffort } from "./resolution.ts";
import { bindChildExecutionProjectKey } from "./execution-snapshot.ts";

type Restore = (record: ChildSessionRecord) => Promise<ChildHandle>;
const bindings = new WeakMap<ChildHandle, { bind(restore: Restore): void; drain(): Promise<void> }>();
export function bindRestoredChildren(handles: readonly ChildHandle[], restore: Restore): void {
  for (const handle of handles) bindings.get(handle)?.bind(restore);
}

/** Close the old context's resume gate synchronously, then release every generation using it. */
export async function drainRestoredChildren(handles: readonly ChildHandle[]): Promise<void> {
  await Promise.allSettled(handles.map((handle) => bindings.get(handle)?.drain()));
}

// The one place a rebuilt RECORD becomes a ChildHandle the messaging layer can list and address.
// Every method answers from the durable record alone -- there is no live engine behind it.
export function restoredChildHandle(record: ChildSessionRecord): ChildHandle {
  const terminal: ChildResult["status"] = record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : "stopped";
  let restore: Restore | undefined;
  let live: ChildHandle | undefined;
  let creating: Promise<ChildHandle> | undefined;
  let resuming = false;
  let cancelled = false;
  let bindingVersion = 0;
  let materializedVersion = -1;
  let suspended = false;
  let resumeDone: Promise<void> | undefined;
  const handle: ChildHandle = {
    record,
    status: () => live?.status() ?? record.status,
    async steer(msg): Promise<DeliveryOutcome> {
      if (live !== undefined) return live.steer(msg);
      return { status: "not_found", messageId: msg.messageId, reason: `child ${record.id} is not running (status: ${record.status})` };
    },
    async resume(msg): Promise<DeliveryOutcome> {
      if (suspended) return { status: "unavailable", messageId: msg.messageId, retryable: true, reason: `child ${record.id}'s parent context is ending` };
      if (resuming) return { status: "unavailable", messageId: msg.messageId, retryable: true, reason: `child ${record.id} is already resuming` };
      resuming = true;
      let finishResume!: () => void;
      resumeDone = new Promise<void>((resolve) => { finishResume = resolve; });
      cancelled = false;
      try {
        // Rebuild terminal handles even under the same parent binding: definitions, trust and tool
        // authority may have changed since the last generation without replacing the parent run.
        if (live !== undefined && live.status() !== "running") {
          await live.generationDone?.();
          live = undefined;
          creating = undefined;
        }
        if (suspended) return { status: "unavailable", messageId: msg.messageId, retryable: true, reason: `child ${record.id}'s parent context is ending` };
        if (cancelled) return { status: "unavailable", messageId: msg.messageId, retryable: false, reason: `child ${record.id} was stopped while restoring` };
        if (live !== undefined) return await live.resume(msg);
        if (restore === undefined) return {
          status: "unavailable", messageId: msg.messageId, retryable: false,
          reason: `child ${record.id} was restored from durable storage (${record.transcript})${record.model.effectiveProvider !== undefined ? ` (recorded provider: ${record.model.effectiveProvider})` : ""}, but no live parent execution context is bound`,
        };
        try {
          do {
            materializedVersion = bindingVersion;
            creating = restore(record);
            live = await creating;
            creating = undefined;
          } while (!cancelled && !suspended && materializedVersion !== bindingVersion);
        } catch (err) {
          live = undefined;
          materializedVersion = -1;
          creating = undefined;
          const providerNote = (record.model as RecordedModelEffort).effectiveProvider;
          return { status: "unavailable", messageId: msg.messageId, retryable: false, reason: `child ${record.id} cannot resume from durable storage${providerNote !== undefined ? ` (recorded provider: ${providerNote})` : ""}: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (suspended) return { status: "unavailable", messageId: msg.messageId, retryable: true, reason: `child ${record.id}'s parent context is ending` };
        if (cancelled) return { status: "unavailable", messageId: msg.messageId, retryable: false, reason: `child ${record.id} was stopped while restoring` };
        return await live.resume(msg);
      } finally { resuming = false; finishResume(); }
    },
    async result(): Promise<ChildResult> {
      return live !== undefined ? live.result() : { status: terminal, content: `restored from durable storage -- the authoritative record is its transcript: ${record.transcript}` };
    },
    async stop(): Promise<void> { cancelled = true; await live?.stop(); },
    async generationDone(): Promise<void> { await resumeDone; await live?.generationDone?.(); },
    usage: () => live?.usage?.(),
  };
  bindings.set(handle, { bind(binding) {
    restore = binding;
    suspended = false;
    bindingVersion++;
    // An old context must not dispatch a new generation after an async provider/store probe.
    // This cancels only its pending resume ticket, never a generation already running.
    if (resuming) live?.cancelPendingResume?.();
    // Materialized running generations retain their context until teardown. Terminal resumes
    // retire the old handle and re-read the newest immediate-parent authority.
  }, async drain() {
    suspended = true;
    bindingVersion++;
    // Pending provider/store work must lose its dispatch ticket before the first await.
    live?.cancelPendingResume?.();
    // A pending resume records "running" before awaiting metadata persistence. Let its cancelled
    // ticket restore the prior terminal state first; stop() here would turn a context change into
    // an explicit user stop and permanently replace the child's previous completion.
    await resumeDone;
    // A materialization that was already in flight can only finish now; it cannot dispatch.
    if (live?.status() === "running") await live.stop().catch(() => {});
    await live?.generationDone?.();
  } });
  return handle;
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
export async function restoreChildRoster(store: SessionStore, key: RosterKey, options: { registerMessaging?: boolean } = {}): Promise<RestoredChildRoster> {
  let handles: ChildHandle[] = [];
  try {
    handles = successfulRecords(await rebuildChildRoster(store, key)).map((record) => {
      bindChildExecutionProjectKey(record, key.projectKey);
      return restoredChildHandle(record);
    });
  } catch {
    handles = [];
  }
  if (handles.length === 0 || options.registerMessaging === false) return { handles, remove: () => {} };
  const remove = ensureDefaultMessagingRuntimeRegistered().addChildRosterSource(() => handles);
  return { handles, remove };
}
