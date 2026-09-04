// WS-09 §2.1: the seven-state MCP server connection model, plus the McpServerStateSource seam Lane
// B (Tool Search, Task 5) consumes and Lane A (MCP transports/lifecycle, Task 4) produces (task-2
// brief's own Interfaces block, verbatim). This file owns the shape + a FAKE implementation for
// tests -- the REAL implementation (driving these states from actual stdio/http/sse/sdk transport
// connections) is Lane A's own job; nothing here should be mistaken for that.
//
// Why a factory, not a singleton (contrast registry.ts's own module-level Map): unlike the tool
// registry (one process-wide catalog), MCP server connection state is SESSION state -- two
// concurrent sessions (or a session and its unit tests) must never observe each other's server
// states. `createFakeMcpServerStateSource` therefore returns a fresh, independent instance every
// call, exactly like registry.ts's own `createLoadedToolSet` (Phase 4 Task 2, same file).

// WS-09 §2.1's own table, member for member, verbatim names and order.
export type McpServerStateKind = "pending" | "connected" | "cached" | "failed" | "needsAuth" | "disabled" | "unconfigured";

export interface McpServerState {
  name: string;
  state: McpServerStateKind;
  errorCode?: string;
  error?: string;
  toolNames: string[];
}

export interface McpServerStateSource {
  snapshot(): McpServerState[];
  subscribe(cb: (states: McpServerState[]) => void): () => void;
  // WS-09 §8.4: waits up to `deadlineMs` for every named server (or, when `servers` is omitted,
  // every server currently known to this source) to leave the `pending` state, then resolves with
  // the current snapshot regardless of whether the deadline or the transition won. `cached` (and
  // every other non-"pending" state, including "failed"/"unconfigured") counts as settled for THIS
  // wait -- WS-09 §8.4's own "ready" boolean (which further excludes unconfigured et al.) is a
  // SEPARATE, higher-level computation this file does not perform; a source's own resolution here
  // only answers "is anything still connecting," never "is the overall wait successful."
  waitForPending(servers: string[] | undefined, deadlineMs: number): Promise<McpServerState[]>;
}

// Lane B's tests drive state transitions through `.transition` rather than reconstructing a whole
// new source per scenario. Upsert semantics: a name already in `initial` is updated in place
// (unspecified `extra` fields carry over from the PRIOR state, mirroring how a real server's error/
// toolNames persist across an incremental status update); a name not yet known is added fresh
// (a legitimate real-world case too -- e.g. `setMcpServers` introducing a brand-new server name mid-
// session, WS-09 §3, which enters `pending` without ever having appeared in an initial snapshot).
export function createFakeMcpServerStateSource(
  initial: readonly McpServerState[],
): McpServerStateSource & { transition(name: string, next: McpServerStateKind, extra?: Partial<McpServerState>): void } {
  const states = new Map<string, McpServerState>(initial.map((s) => [s.name, { ...s }]));
  const listeners = new Set<(states: McpServerState[]) => void>();

  function snapshotArray(): McpServerState[] {
    return Array.from(states.values());
  }

  function notify(): void {
    const snap = snapshotArray();
    for (const cb of listeners) {
      try {
        cb(snap);
      } catch (err) {
        console.error("createFakeMcpServerStateSource: a subscriber threw", err);
      }
    }
  }

  function subscribe(cb: (states: McpServerState[]) => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  function waitForPending(servers: string[] | undefined, deadlineMs: number): Promise<McpServerState[]> {
    // An unknown name (present in `servers` but absent from `states`) has no state at all, so it
    // can never be "pending" -- it never blocks the wait (WS-09 §8.4's own `unknown[]` bucket is the
    // higher-level union field this manifests as; sourced here at the state-existence level).
    const targets = servers ?? snapshotArray().map((s) => s.name);
    const anyStillPending = () => targets.some((n) => states.get(n)?.state === "pending");
    if (!anyStillPending()) return Promise.resolve(snapshotArray());

    return new Promise<McpServerState[]>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(snapshotArray());
      }, deadlineMs);
      timer.unref?.(); // never keeps the test runner (or a real process) alive on its own
      unsubscribe = subscribe(() => {
        if (settled || anyStillPending()) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshotArray());
      });
    });
  }

  function transition(name: string, next: McpServerStateKind, extra?: Partial<McpServerState>): void {
    const existing = states.get(name);
    const toolNames = extra?.toolNames ?? existing?.toolNames ?? [];
    // Fix round 1, MAJOR item 3: errorCode/error are CLEARED on every transition unless `extra`
    // ITSELF supplies them -- unlike toolNames (which legitimately carries over from the prior state
    // when a transition doesn't mention it), an error belongs to the state that produced it. The
    // previous `extra?.errorCode ?? existing?.errorCode` treated "extra has no errorCode key at all"
    // the same as "extra explicitly cleared it," so a stale "failed" error/errorCode silently rode
    // along into every later transition that never mentioned the field (e.g. a subsequent successful
    // "connected" transition would still report the OLD failure). Checked by key PRESENCE (`in`), not
    // by the value's own truthiness, so `extra` can still explicitly re-set a NEW errorCode/error on a
    // repeat "failed" transition.
    const errorCode = extra && "errorCode" in extra ? extra.errorCode : undefined;
    const error = extra && "error" in extra ? extra.error : undefined;
    states.set(name, {
      name,
      state: next,
      toolNames,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    notify();
  }

  return { snapshot: snapshotArray, subscribe, waitForPending, transition };
}
