// WS-24: THE PROCESS-GROUP LEDGER -- every live `detached: true` process group this JS realm spawned.
//
// WHY IT EXISTS. Each spawn site that makes its child a process-group leader (a Bash/Monitor command,
// a stdio MCP server, a command hook, the workflow worker) also owns that group's death: a timeout,
// an abort, `close()`, an engine teardown. All of those are JS running in THIS realm. When the realm
// itself dies without running them -- an embedded session's Worker `terminate()`d while spinning, or
// crashing on an uncaught throw -- every group it started is orphaned: `setsid` detached them from
// the host process on purpose, so nothing the host does to itself reaches them. The only party left
// that can reap them is the HOST, and the host cannot see a Worker's module state. So the realm
// MIRRORS the one fact the host needs, as it changes: which process-group ids are alive right now
// (`embedded-worker.ts` posts each change on the Worker channel; `embedded-host.ts` surfaces them to
// the daemon, which SIGKILLs whatever is left when the Worker closes).
//
// WHAT IT IS NOT. Not a second kill path: every spawn site keeps killing its own group exactly as it
// did. Not a task table: `tools/impl/background-task-runtime.ts` still owns task identity, status and
// frames -- this knows only pgids, which is why it covers the groups the task table never sees (a
// FOREGROUND Bash command, an MCP server, a hook). A spawn site registers when the group is BORN (the
// child has a pid) and releases when its leader is gone (`close`), which is the lifecycle the brief
// asks for ("as it starts and ends").
//
// ONE PER REALM, like the task table: a module-level Map. A realm is a session in the embedded
// topology (one Worker per session) and a whole `winter` process in the spawned one.
//
// THE RESIDUAL, stated: a release fires when the group's LEADER closes. A grandchild that outlives its
// leader keeps the group alive but is no longer listed -- the same scope every existing kill door here
// already has (TaskStop, the teardown sweep), not a new gap.

/** Which spawn site a group came from -- for diagnostics only; the host treats every group alike. */
export type ProcessGroupKind = "command" | "mcp_stdio" | "hook" | "workflow";

export interface ProcessGroupChange {
  op: "add" | "remove";
  pgid: number;
  kind: ProcessGroupKind;
}

// The value is the REGISTRATION (an object identity), not just the kind: a release compares identities,
// so a reused pid registered again after its first group ended can never be dropped by the old
// registration's late release.
const live = new Map<number, { kind: ProcessGroupKind }>();
const listeners = new Set<(change: ProcessGroupChange) => void>();

function notify(change: ProcessGroupChange): void {
  // Every listener runs even if one throws: a broken observer must never cost a spawn site its
  // bookkeeping (the same isolation tools/registry.ts's `notifyRegistryChange` applies).
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      /* an observer's failure is its own */
    }
  }
}

/**
 * Record `pgid` (the pid of a child spawned `detached: true`, i.e. its group leader) as live. Returns
 * the release, which is idempotent -- a spawn site may reach its "the leader is gone" point by more
 * than one path (`close` after `error`, an explicit `close()` racing the exit event).
 */
export function trackProcessGroup(pgid: number, kind: ProcessGroupKind): () => void {
  if (!Number.isInteger(pgid) || pgid <= 1) return () => {}; // never a real group leader; `-1`/`0` would mean "every process" to kill(2)
  const registration = { kind };
  live.set(pgid, registration);
  notify({ op: "add", pgid, kind });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (live.get(pgid) !== registration) return; // superseded by a newer registration of a reused pid
    live.delete(pgid);
    notify({ op: "remove", pgid, kind });
  };
}

/** Every group currently recorded as live, oldest first. */
export function liveProcessGroups(): ReadonlyArray<{ pgid: number; kind: ProcessGroupKind }> {
  return [...live.entries()].map(([pgid, { kind }]) => ({ pgid, kind }));
}

/** Observe every add/remove from now on. Returns the unsubscribe. */
export function onProcessGroupChange(listener: (change: ProcessGroupChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget everything (a test that spawns and kills in one realm must not see another test's groups). */
export function resetProcessGroupsForTest(): void {
  live.clear();
}
