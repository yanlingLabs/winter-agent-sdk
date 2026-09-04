// WS-10 §6: resource limits on subagent spawning -- max nesting depth beneath the main agent (env
// WINTER_MAX_SUBAGENT_SPAWN_DEPTH, default 3) and max concurrent subagents (env
// WINTER_MAX_CONCURRENT_SUBAGENTS, default 20). Deliberately NO wall-clock timeout here -- WS-10
// §6's own table pins that as "none"; the progress-STALL watchdog (a different control) lives in
// watchdog.ts.
//
// A child is an in-process runEngine() instance (R4-4, child-handle.ts's own header) -- there is no
// OS-process tree to walk for "how deep am I," and the T3-frozen seam types
// (SpawnChildRequest/ChildInheritance/ChildEngineRunContext) carry no depth field at all. This
// module therefore keeps its own process-wide bookkeeping, keyed by the ENGINE session id every
// runEngine() invocation already carries (RuntimeConfig.sessionId): child-engine.ts sets a child's
// own `config.sessionId` to its freshly-minted agentId (see that file's header for why), so
// `runCtx.parentSessionId` (ChildEngineRunContext, T3-frozen) is exactly the right lookup key at
// every nesting level -- depth 0 for the real top-level session (never registered here, since
// nothing ever spawns it), depth 1 for its direct children, depth 2 for their own children, etc.
//
// Same "ONE-LIVE-ENGINE ASSUMPTION" this codebase already accepts elsewhere for an identical reason
// (tools/background-tasks.ts's own module-level temp-root resolver; tools/impl/
// background-task-runtime.ts's own module-level task Map) -- a second, fully concurrent daemon host
// sharing one process is a later WS-15 concern, not this phase's.

export class SpawnDepthExceededError extends Error {
  constructor(
    public readonly depth: number,
    public readonly max: number,
  ) {
    super(`winter: subagent spawn refused -- nesting depth ${depth} exceeds WINTER_MAX_SUBAGENT_SPAWN_DEPTH (${max})`);
    this.name = "SpawnDepthExceededError";
  }
}

export class SpawnConcurrencyExceededError extends Error {
  constructor(
    public readonly running: number,
    public readonly max: number,
  ) {
    super(`winter: subagent spawn refused -- ${running} subagent(s) already running, at WINTER_MAX_CONCURRENT_SUBAGENTS (${max})`);
    this.name = "SpawnConcurrencyExceededError";
  }
}

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENCY = 20;

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function resolveMaxSpawnDepth(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntEnv(env["WINTER_MAX_SUBAGENT_SPAWN_DEPTH"], DEFAULT_MAX_DEPTH);
}

export function resolveMaxConcurrentSubagents(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveIntEnv(env["WINTER_MAX_CONCURRENT_SUBAGENTS"], DEFAULT_MAX_CONCURRENCY);
}

// Absent from this map = depth 0 (the true top-level session, or any id this module has never seen)
// -- the same "absent means not known-true" convention this whole codebase already uses elsewhere
// (RuntimeConfig.insideSubagent, etc.).
const depthById = new Map<string, number>();
let runningCount = 0;

export interface SpawnLimitCheck {
  depth: number;
}

// Called ONCE per spawn, before the child engine actually starts -- throws a typed, distinct error
// for each of the two limits (never a generic Error), matching this codebase's own established
// "typed capability/limit error" precedent (sandbox/profile.ts's SandboxConfigError). Registers the
// new child's OWN depth (for ITS future children to look up) and increments the running counter --
// paired with releaseSpawn below, called once the child reaches a terminal status.
export function checkAndRegisterSpawn(opts: { parentSessionId: string; childSessionId: string; env?: Record<string, string | undefined> }): SpawnLimitCheck {
  const env = opts.env ?? process.env;
  const maxDepth = resolveMaxSpawnDepth(env);
  const maxConcurrency = resolveMaxConcurrentSubagents(env);
  const parentDepth = depthById.get(opts.parentSessionId) ?? 0;
  const depth = parentDepth + 1;
  if (depth > maxDepth) throw new SpawnDepthExceededError(depth, maxDepth);
  if (runningCount >= maxConcurrency) throw new SpawnConcurrencyExceededError(runningCount, maxConcurrency);
  depthById.set(opts.childSessionId, depth);
  runningCount += 1;
  return { depth };
}

// Called once a child reaches ANY terminal status (completed/stopped/failed) -- frees its
// concurrency slot and its depth-table entry (a terminal child's own future grandchildren are moot;
// keeping the entry around would just leak memory for a long-lived daemon). Idempotent: a second
// call for an id already released is a silent no-op -- mirrors this codebase's own
// cancel()/stopTask-style "already gone is fine" convention, since a child's own natural-completion
// path and an external stop() can legitimately race to call this once each.
export function releaseSpawn(childSessionId: string): void {
  if (depthById.delete(childSessionId)) {
    runningCount = Math.max(0, runningCount - 1);
  }
}

export function currentRunningSubagentCount(): number {
  return runningCount;
}

export function resetSpawnLimitsForTest(): void {
  depthById.clear();
  runningCount = 0;
}
