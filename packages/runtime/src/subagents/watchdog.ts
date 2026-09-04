// WS-10 §6, RULING R4-9: the progress-stall watchdog. Parity target is Norma's shipped
// `packages/core/src/agent/subagents.ts` (WS-10 §6's own citation): a progress-INACTIVITY watchdog,
// on by default at 600_000ms, that aborts with a typed "stalled: no progress" error -- distinct from
// a wall-clock timeout (there is deliberately NO wall-clock timeout on a child at all, WS-10 §6's own
// table: "Wall-clock child timeout | none"). "Progress" is ANY frame or tool activity (R4-9) --
// child-engine.ts pokes this on every frame it reads back from a running child, resetting the clock;
// the watchdog only ever fires after a full timeoutMs window with ZERO such pokes.
export class ChildStalledError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`winter: subagent stalled -- no progress (no frame or tool activity) for ${timeoutMs}ms (WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS)`);
    this.name = "ChildStalledError";
  }
}

const DEFAULT_STALL_TIMEOUT_MS = 600_000;

export function resolveStallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env["WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return DEFAULT_STALL_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_TIMEOUT_MS;
}

export interface StallWatchdog {
  // Resets the countdown -- called on every observed unit of progress (a frame read back from the
  // child, WS-10 §6's own "activity" definition per R4-9).
  poke(): void;
  // Stops the watchdog for good (the child reached a terminal state through some OTHER path --
  // natural completion, an explicit stop() -- before the timer ever fired). Idempotent, and safe to
  // call after the watchdog has already fired.
  cancel(): void;
}

// `onStall` fires AT MOST once (the timer is one-shot; the watchdog never re-arms itself after
// firing -- child-engine.ts's own caller is expected to tear the child down for good the moment this
// fires, never to keep feeding it pokes afterward).
export function createStallWatchdog(timeoutMs: number, onStall: (err: ChildStalledError) => void): StallWatchdog {
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function arm(): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      if (fired) return;
      fired = true;
      onStall(new ChildStalledError(timeoutMs));
    }, timeoutMs);
    // Never keeps the process alive on its own -- a stalled child that the rest of the run has
    // otherwise finished with (e.g. the daemon is shutting down) must not be the one thing blocking
    // exit. Mirrors this codebase's own rpc/bridge.ts `timer.unref?.()` precedent.
    t.unref?.();
    return t;
  }

  timer = arm();

  return {
    poke(): void {
      if (fired) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = arm();
    },
    cancel(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      fired = true; // belt-and-suspenders: a poke()/cancel() arriving after this is a guaranteed no-op
    },
  };
}
