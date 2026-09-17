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

export type BackgroundTaskKind = "bash" | "monitor" | "monitor_ws" | "workflow" | "agent";

// Task-frames parity (2026-09-17 contract, §2): pinned against the `claude` 0.3.250 binary rather
// than assumed -- EVERY internal kind's wire `task_type` differs from its Winter-ergonomic name
// except `workflow`, which was already right (see the pre-existing comment below, kept verbatim).
// Two internal kinds -- `bash` and `monitor` (Monitor's COMMAND half) -- share the identical wire
// spelling `"local_bash"`: the pin registers Monitor's command half as a plain background shell task,
// indistinguishable on the wire from a backgrounded Bash call. Monitor's WEBSOCKET half is a
// DIFFERENT internal kind, `monitor_ws`, precisely because its wire shape differs too (no
// `is_backgrounded` field at all -- background-task-runtime.ts's own StartTrackingInput comment) --
// splitting the kind, rather than threading a second "half" axis through every call site, keeps this
// one table the single place a wire spelling is decided.
//
//   Winter kind   | wire task_type   | pinned Winter-facing name
//   --------------|-------------------|---------------------------
//   bash          | local_bash        | Bash (foreground or run_in_background)
//   monitor       | local_bash        | Monitor, command half
//   monitor_ws    | monitor_ws        | Monitor, WebSocket half
//   workflow      | local_workflow    | Workflow
//   agent         | local_agent       | Agent (subagent)
//
// ONE mapping, here, rather than a literal at each emission site. THE PRODUCER INVENTORY, kept
// current (fix round 1, M4 -- TaskStop was missing from it and was emitting the internal kind;
// task-frames parity -- agent.ts's own literal "agent"/"bash" spellings were replaced by calls
// through this function, closing the last two hand-written spellings):
//   1. `tools/impl/background-task-runtime.ts`  toBackgroundTasksChangedEntry -> background_tasks_changed[].task_type
//   2. `tools/impl/task-stop.ts`                formatResult                  -> the pinned TaskStop result's task_type
//   3. `tools/impl/agent.ts`                    task_started (foreground + background)
//   4. `tools/impl/bash.ts`                     task_started (foreground + background)
//   5. `tools/impl/monitor.ts`                  task_started (command + ws halves)
//   6. Lane W's own `task_started`/`task_progress` emissions (WorkflowRunHost)
// A hand-written spelling at any one of them is invisible until a conformance comparison runs, which
// is why every new producer belongs on this list.
const WIRE_TASK_TYPES: Readonly<Record<BackgroundTaskKind, string>> = Object.freeze({
  bash: "local_bash",
  monitor: "local_bash",
  monitor_ws: "monitor_ws",
  workflow: "local_workflow",
  agent: "local_agent",
});

export function wireTaskType(kind: BackgroundTaskKind): string {
  return WIRE_TASK_TYPES[kind];
}

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
