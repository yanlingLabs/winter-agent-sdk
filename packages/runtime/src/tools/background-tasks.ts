// WS-06 §3.5: ONE task-id namespace spans background commands (Bash/Monitor/Workflow) and
// background/named agents -- distinct, BY CONSTRUCTION, from the separate TaskCreate graph (Lane D
// owns that store, task-graph-store.ts; the two id spaces must never collide or be mistaken for one
// another). Output files live at `<session-temp>/tasks/<task-id>.output`, the D18 engine-sibling
// layout (paths/temp.ts's own sessionTempDir/ensureTasksDir); `tasks/` is created lazily, at the
// first task, never eagerly (paths/temp.ts's own header).
//
// Module-level configuration, deliberately NOT a parameter of createBackgroundTask itself -- the
// task-1 brief pins that function's signature as `(kind) => {taskId, outputPath}`, no session
// argument. ONE-LIVE-ENGINE ASSUMPTION, documented rather than hidden: this module tracks a SINGLE
// active session's temp-root resolver at a time. A second concurrent in-memory engine run in the
// same process that ALSO calls configureBackgroundTaskRoot before the first one's own tools have
// called createBackgroundTask would silently resolve against the second session's root instead of
// the first's. Nothing in this phase's test suite exercises two concurrent default-tools engine
// runs (every query()/inMemoryProcess default-tools call in the current suite is awaited to
// completion before the next one starts) -- this is a real, scoped limitation for a future
// multi-session daemon host (WS-15) to close, not a T1 gap papered over.
//
// The resolver is a FUNCTION, not a resolved value, specifically so resolution stays exactly as
// lazy as `ToolExecutionContext.tempDir`'s own getter (registry.ts) -- engine.ts wires both to the
// SAME memoized closure. Configuring this is cheap and side-effect-free; only actually CALLING
// createBackgroundTask (or reading ctx.tempDir) touches the filesystem.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureTasksDir, type SessionTempDirPaths } from "../paths/temp.ts";

export type SessionTempRootResolver = () => SessionTempDirPaths;

let activeResolver: SessionTempRootResolver | undefined;

export function configureBackgroundTaskRoot(resolver: SessionTempRootResolver): void {
  activeResolver = resolver;
}

// Test-only escape hatch (mirrors this module's own "tests drive the configure function directly"
// design, task-1 brief) -- lets a test start from a known-unconfigured state rather than depending
// on suite ordering never having called configureBackgroundTaskRoot yet.
export function resetBackgroundTaskRootForTest(): void {
  activeResolver = undefined;
}

export type BackgroundTaskKind = "bash" | "monitor" | "workflow" | "agent";

// N1 (fix wave, P3 close-out): STALE as of Lane C's own Task 3 -- "still UNEXERCISED by anything
// real" was accurate at fix-round-1 time; it no longer is. `createBackgroundTask("bash")` and
// `createBackgroundTask("monitor")` are both real, exercised call sites now (tools/impl/bash.ts's
// own `runBackground`, tools/impl/monitor.ts's own command/ws halves) -- both `randomUUID()` task
// ids and `ensureTasksDir`'s real mkdir path run for real on every backgrounded Bash/Monitor call
// this phase's own test suite (and every live session) makes. T2's own scripted-tool proof
// (provider/mock.ts's registerBgTaskTestTool) remains a SEPARATE, still-fixed-literal path -- it
// simply is no longer the ONLY caller.
export function createBackgroundTask(kind: BackgroundTaskKind): { taskId: string; outputPath: string } {
  if (!activeResolver) {
    throw new Error(
      `background-tasks: createBackgroundTask("${kind}") called before configureBackgroundTaskRoot(...) -- the engine wires this once per run (see this module's own header)`,
    );
  }
  const paths = activeResolver();
  const tasksDir = ensureTasksDir(paths); // lazy: creates `tasks/` on first call, validated no-op after
  const taskId = randomUUID();
  return { taskId, outputPath: join(tasksDir, `${taskId}.output`) };
}
