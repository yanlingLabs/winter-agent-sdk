// WS-10: the Agent tool -- ties definitions/resolution/policy/limits/workspace/child-engine
// together into the model-facing tool a running session actually calls.
//
// CLOSED by Phase 4 Task 8 (this header previously documented both as live gaps; kept as a record
// of what the fix actually was rather than deleted):
//   - Gap #4 (parentToolUseId): `ToolExecutionContext` now carries `toolUseId`, threaded from
//     `EngineToolCall.id` in registry.ts's own ctx literal, so `SpawnChildRequest.parentToolUseId`
//     is the MODEL's own tool_use id and WS-10 §4's "keyed by parent tool-use ID" correlation is
//     rooted in a real key. The randomUUID() fallback below survives only for a hand-built context.
//   - Gap #3 (programmatic AgentDefinition visibility): `ToolExecutionContext.agents` now carries
//     `RuntimeConfig.agents`, so `loadAgentDefinitions`'s own `programmatic` parameter finally has a
//     production producer -- WS-10 §2's "programmatic definitions and filesystem-defined agents MUST
//     coexist" holds in a live session, not only in this lane's own unit tests.
// child-engine.ts's own header still discloses the remaining subsystem-level seams.
import { randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync } from "node:fs";
import { WINTER_BRAND, type RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { AGENT_TOOL_CANONICAL_NAME } from "../../provider/slots.ts";
import "../descriptors/agent.ts"; // self-sufficiency: guarantees the "Agent" stub is registered before replaceExecutor runs below.
import { createBackgroundTask } from "../background-tasks.ts";
// Phase 4 Task 8 (rider 24): the shared background-task runtime TaskStop/TaskOutput are built on.
// Task-frames parity (2026-09-17 contract §4): `backgroundAgentTasks`/`currentBackgroundTasksChanged`
// (this file's own header used to explain why a SECOND map existed alongside the shared registry) are
// GONE -- now that the registry's own `toBackgroundTasksChangedEntry` maps kind "agent" to the pinned
// wire spelling itself (background-tasks.ts's WIRE_TASK_TYPES), the second map carried nothing the
// registry did not already have; the two were kept in lockstep by hand, which is exactly the
// "per-tool literal" duplication the update/notify doors below exist to remove.
import { startTracking, updateTask, getTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";
import { loadAgentDefinitions } from "../../subagents/definitions.ts";
import { getPluginAgents } from "../../subagents/plugin-agents.ts";
import { resolveForegroundBackground, resolveWorkspaceTrust } from "../../subagents/policy.ts";
import type { ChildHandle, ChildResult, ChildSessionRecord, ChildTaskProgress, SpawnChildRequest } from "../../subagents/child-handle.ts";

// ONE PRODUCER for the name (P6.6): `provider/slots.ts` declares it, `descriptors/agent.ts`
// registers under it, engine.ts recognises the descriptor by it, and this executor replaces the
// executor under it. The export stays for every existing importer.
export const AGENT_TOOL_NAME = AGENT_TOOL_CANONICAL_NAME;

// R4-8 / WS-10 §17 Open Question 1 -- CLOSED by Phase 4 Task 8 (rider 22, RULING P4-J(d)):
// `tools/descriptors/agent.ts` no longer advertises `name` in its own `inputSchema.properties`.
// This executor's host-side acceptance of the field is unchanged and is exactly what the ruling
// requires ("Winter accepts the field host-side and withholds it from the model schema").

// --- Background-task bookkeeping (WS-06 §3.5, WS-12 §7) ------------------------------------------
//
// Phase 4 Task 8 (rider 24): a background agent task IS registered in background-task-runtime.ts's
// shared registry now (its `BackgroundTaskKind` union was widened to match the spine seam's own four
// members, which was the mechanical blocker), so TaskStop and TaskOutput -- both implemented
// entirely against that registry -- reach a background agent exactly as they reach a backgrounded
// Bash command. A child has no OS process (RULING R4-4: it is an in-process runEngine loop), so it
// registers with no `pid` and a generic `stop` callback instead: `handle.stop()`, which is
// idempotent and settles the child's own result.

// Task-frames parity (contract §4): usage on the WIRE (snake_case, the pinned SDKTaskProgressMessage/
// SDKTaskNotificationMessage shape) from ChildResult.usage's own camelCase counters -- ONE converter
// so the two spellings never drift apart at two separate call sites (the terminal notification and,
// via child-engine.ts's own onProgress, every task_progress frame).
function toWireUsage(usage: ChildResult["usage"]): { total_tokens: number; tool_uses: number; duration_ms: number } | undefined {
  return usage === undefined ? undefined : { total_tokens: usage.totalTokens, tool_uses: usage.toolUses, duration_ms: usage.durationMs };
}

// Task-frames parity (contract §4): registration -- BOTH foreground and background -- emits this
// SAME frame shape; only `is_backgrounded` (and whether a background_tasks_changed follows) differs.
// `spawn_depth` is omitted only for a hand-built ChildHandle whose record never went through the
// real spawn path (every impl/*.test.ts fixture that constructs one directly).
function emitAgentTaskStarted(ctx: ToolExecutionContext, taskId: string, parentToolUseId: string, description: string, subagentType: string | undefined, isBackgrounded: boolean, spawnDepth: number | undefined, prompt: string): void {
  ctx.emitFrame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: parentToolUseId,
    description,
    ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
    is_backgrounded: isBackgrounded,
    ...(spawnDepth !== undefined ? { spawn_depth: spawnDepth } : {}),
    task_type: "local_agent",
    prompt,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
}

// Task-frames parity (contract §4): one `task_progress` per qualifying child assistant message,
// foreground and background alike -- `child-engine.ts`'s own `SpawnChildRequest.onProgress` is what
// calls this, through the closure built in `execute()` below.
function emitAgentTaskProgress(ctx: ToolExecutionContext, taskId: string, parentToolUseId: string, description: string, subagentType: string | undefined, progress: ChildTaskProgress): void {
  ctx.emitFrame({
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    tool_use_id: parentToolUseId,
    description,
    ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
    usage: { total_tokens: progress.totalTokens, tool_uses: progress.toolUses, duration_ms: progress.durationMs },
    last_tool_name: progress.lastToolName,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
}

// Task-frames parity (contract §4's own termination table -- CORRECTED 2026-09-17 from a live run of
// the pinned binary: the earlier "foreground success removes the row" reading was wrong for agents;
// the remove-without-task_updated path exists for foreground BASH only, bash.ts's own runForeground).
// Foreground and background agents terminate THROUGH THE SAME DOOR -- the registry's own `updateTask`:
// `task_updated {status, end_time[, error]}` then, synchronously, the once-per-id `task_notification`.
// They differ ONLY in `task_started.is_backgrounded` and whether `background_tasks_changed` follows
// (both decided by the CALLER, not here) -- so a foreground task needs a real `.output` file exactly
// like a background one, never `output_file:""`.
//
// `summary` is the child's own `result.content` on every branch, uniformly -- observed directly on
// the pin for the success case (`summary: "<the child's final report text>"`); the failed/stopped
// cases have no pinned wording of their own, and `result.content` is already the descriptive text
// for those (the error message / "stopped by request") that `foregroundResultToPayload` below reads
// for the model-facing result too, so this is the same text on both surfaces rather than a second,
// invented phrasing. `usage` rides every branch, per the contract's own "usage on every agent
// task_notification".
function finalizeAgentTask(taskId: string, parentToolUseId: string, outputPath: string, result: ChildResult): void {
  const usage = toWireUsage(result.usage);
  updateTask(taskId, {
    status: result.status,
    endTime: Date.now(),
    ...(result.status === "failed" ? { error: result.content } : {}),
    notification: {
      summary: result.content,
      outputFile: outputPath,
      toolUseId: parentToolUseId,
      ...(usage !== undefined ? { usage } : {}),
    },
  });
}

function toRecordShape(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

// WS-10 §1.4: "Result data MAY include agentId, agentType, text content, resolvedModel/modelsUsed,
// tool-use count, duration, and usage." `usage`/`modelsUsed`/`worktreePath` are deliberately omitted
// below -- no token-counting exists anywhere in this codebase yet (a fabricated `total_tokens: 0`
// would be a false claim, not an honest absence), and ChildSessionRecord/ChildResult carry no cwd
// for a "worktreePath" field to report accurately. Disclosed, not silently narrowed.
function foregroundResultToPayload(record: ChildSessionRecord, result: ChildResult, prompt: string, subagentType: string | undefined): ToolResultPayload {
  if (result.status !== "completed") {
    return { output: `Error: subagent ${record.id} ${result.status}: ${result.content}`, isError: true };
  }
  return {
    output: JSON.stringify({
      agentId: record.id,
      ...(subagentType !== undefined ? { agentType: subagentType } : {}),
      content: [{ type: "text", text: result.content }],
      ...(result.totalToolUseCount !== undefined ? { totalToolUseCount: result.totalToolUseCount } : {}),
      ...(result.totalDurationMs !== undefined ? { totalDurationMs: result.totalDurationMs } : {}),
      ...(result.resolvedModel !== undefined ? { resolvedModel: result.resolvedModel } : {}),
      prompt,
    }),
  };
}

// WS-12 §7.2: "An agent task's `.output` MAY be a symlink to its durable subagent transcript only
// when symlink ownership and target containment pass strict validation... When the platform or
// sandbox cannot permit that symlink safely, Winter MUST expose a small generated reference/stub
// and return the durable transcript path through the tool result -- never repeatedly re-copy a
// growing transcript." The symlink branch is deliberately NOT attempted here: at spawn time the
// child's own `.jsonl` does not exist yet (a symlink to it would dangle until the child's first
// write), this executor has no access to `winterHome` to resolve the transcript to an absolute path
// (ToolExecutionContext carries no such field), and nothing reachable from a `ChildHandle` reveals
// whether a store is even configured for this run. The stub is always spec-compliant (the symlink
// is a MAY, the stub is the MUST) -- taking it unconditionally is a disclosed simplification, not a
// spec violation; the symlink branch is left as a follow-up. The stub is written once at spawn and
// APPENDED to (never rewritten with a growing copy) once the child settles.
function writeAgentTaskStub(outputPath: string, handle: ChildHandle): void {
  writeFileSync(
    outputPath,
    `Background agent task (agentId ${handle.record.id}) is running.\n` +
      `Its durable transcript is the authoritative record: ${handle.record.transcript}\n` +
      `Read that file directly for the child's real output; this stub is never rewritten with a growing copy (WS-12 §7.2).\n`,
  );
}

// Task-frames parity: the ONE registration door for an agent task, foreground and background alike
// (they differ only in `isBackgrounded`, per finalizeAgentTask's own header) -- allocates the task
// id/output path, registers it in the shared registry with a stop callback, writes the initial stub
// (so a real `.output` file exists at the SAME path the eventual notification names -- "a foreground
// agent needs an output file like a background one"), and emits `task_started`.
function registerAgentTask(
  ctx: ToolExecutionContext,
  handle: ChildHandle,
  description: string,
  prompt: string,
  subagentType: string | undefined,
  parentToolUseId: string,
  isBackgrounded: boolean,
): { taskId: string; outputPath: string } {
  // Phase 4 Task 8 (rider 24): register the task in the SHARED background-task runtime, so
  // TaskStop and TaskOutput -- both of which are implemented entirely against that registry --
  // reach an agent task exactly as they reach a backgrounded Bash command. `pid` is deliberately
  // ABSENT: a child is an in-process `runEngine` loop (RULING R4-4), never an OS process, so there
  // is no process group to signal. The generic `stop` callback is the whole point of that field's
  // existence (it was added for Monitor's socket half, which likewise has no pid) -- `handle.stop()`
  // is idempotent and settles the child's result, so a TaskStop against an agent task aborts the
  // real child rather than merely marking a row.
  const { taskId, outputPath } = createBackgroundTask("agent");
  startTracking({
    taskId,
    kind: "agent",
    outputPath,
    description,
    isBackgrounded,
    toolUseId: parentToolUseId,
    emitter: { emitFrame: ctx.emitFrame, sessionId: ctx.sessionId },
    stop: () => {
      void handle.stop();
    },
  });
  writeAgentTaskStub(outputPath, handle);
  emitAgentTaskStarted(ctx, taskId, parentToolUseId, description, subagentType, isBackgrounded, handle.record.spawnDepth, prompt);
  return { taskId, outputPath };
}

function startBackgroundAgentTask(
  handle: ChildHandle,
  ctx: ToolExecutionContext,
  description: string,
  prompt: string,
  subagentType: string | undefined,
  parentToolUseId: string,
  // Task-frames parity: the `onProgress` closure baked into `req` (execute()'s own SpawnChildRequest,
  // BEFORE spawnChild is called) needs the real taskId the moment it exists -- this is that channel.
  setTaskId: (taskId: string) => void,
): ToolResultPayload {
  // `handle` is ALREADY a real, running child by the time this function is called (spawnChild has
  // already succeeded, in the caller). Everything below is bookkeeping ON TOP of that live child --
  // if ANY of it throws (createBackgroundTask before configureBackgroundTaskRoot, a filesystem
  // error writing the stub, a torn-down session's emitFrame), the child would otherwise become a
  // silent ORPHAN: already running, tracked nowhere, awaited by nothing, stoppable by nothing. The
  // try/catch below exists ONLY to prevent that -- on any failure here, stop() the child rather than
  // leaving it live with zero visibility, and surface a legible error instead of letting the
  // executor throw past this point with a real subagent already in flight underneath it.
  let taskId: string;
  let outputPath: string;
  try {
    ({ taskId, outputPath } = registerAgentTask(ctx, handle, description, prompt, subagentType, parentToolUseId, true));
    setTaskId(taskId);
    ctx.emitFrame({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
      uuid: randomUUID(),
      session_id: ctx.sessionId,
    });
  } catch (err) {
    void handle.stop();
    return {
      output: `Error: subagent ${handle.record.id} was spawned but its background-task setup failed -- stopped it rather than leaving an orphan: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }

  // Fire-and-forget: run_in_background's whole point is returning before completion (mirrors
  // bash.ts's own identical completion.then pattern for its own background tasks). Per the
  // seam-contracts-p4.test.ts fixture's own pinned behavior, result() resolves exactly once and
  // never rejects -- the onRejected branch is defense-in-depth only, never expected to fire.
  handle.result().then(
    (result) => {
      // A TaskStop that already finalized this row (its own `updateTask` call, moving status out of
      // "running") gets here first when `handle.stop()`'s own `settle("stopped", ...)` resolves
      // `result()` -- `finalizeAgentTask` is idempotent either way (updateTask's own empty-diff/
      // already-terminal guards), but the guard avoids a redundant stub-append and
      // background_tasks_changed for the common case, matching workflow.ts's own identical guard.
      if (getTask(taskId)?.status !== "running") return;
      try {
        appendFileSync(outputPath, `\n[${new Date().toISOString()}] subagent ${handle.record.id} ${result.status}.\n`);
      } catch {
        /* the stub file is a best-effort convenience; its own write failure must never crash this callback */
      }
      finalizeAgentTask(taskId, parentToolUseId, outputPath, result);
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* a torn-down session's emitFrame may throw; the registry's own state and the .output stub are still correct */
      }
    },
    () => {
      if (getTask(taskId)?.status !== "running") return;
      finalizeAgentTask(taskId, parentToolUseId, outputPath, { status: "failed", content: `subagent ${handle.record.id}: result() rejected unexpectedly` });
    },
  );

  return {
    output: JSON.stringify({
      status: "async_launched",
      agentId: handle.record.id,
      taskId,
      ...(subagentType !== undefined ? { agentType: subagentType } : {}),
      outputFile: outputPath,
      message: `Subagent ${handle.record.id} started in the background (task ${taskId}). Use TaskOutput to peek at ${outputPath}, or SendMessage to steer/resume it once addressable.`,
    }),
  };
}

export const agentExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = toRecordShape(input);
    const description = typeof record["description"] === "string" ? (record["description"] as string) : undefined;
    const prompt = typeof record["prompt"] === "string" ? (record["prompt"] as string) : undefined;
    if (description === undefined || prompt === undefined) {
      return { output: 'Error: Agent requires both "description" and "prompt" string fields.', isError: true };
    }
    const subagentType = typeof record["subagent_type"] === "string" ? (record["subagent_type"] as string) : undefined;
    const model = typeof record["model"] === "string" ? (record["model"] as string) : undefined;
    const runInBackgroundInput = typeof record["run_in_background"] === "boolean" ? (record["run_in_background"] as boolean) : undefined;
    const isolation = typeof record["isolation"] === "string" ? (record["isolation"] as string) : undefined;
    // WHOLE-BRANCH N2: `name` is read from the RAW input here, and nothing validates a call against
    // the advertised `inputSchema` -- so withholding `name` from that schema (descriptors/agent.ts,
    // RULING P4-J(d)) makes it UNADVERTISED, never unreachable: a model that emits it anyway gets it
    // honoured. That is deliberate and harmless (WS-10 §11 rule 6: a name grants nothing -- it is an
    // addressing convenience, and a duplicate name resolves to a `stale` refusal rather than to
    // either child), but "withheld" must not be read as "impossible".
    const name = typeof record["name"] === "string" ? (record["name"] as string) : undefined;
    // WS-10 §1.2: `team_name`/`mode` are deprecated, accepted-ignored -- deliberately never read
    // from `record` at all; there is no decision anywhere below that could consult them.

    // WS-10 §8: isolation:"remote" is schema-accepted but capability-gated -- v1 Winter has no
    // remote execution backend configured anywhere in this codebase. A typed unsupported-capability
    // error, checked BEFORE any spawn work (limits/definitions/workspace), matching this whole spec
    // family's "a rejected spawn should be cheap and side-effect-free" posture (WS-10 §6, mirrored
    // verbatim in child-engine.ts's own depth/concurrency check ordering).
    if (isolation === "remote") {
      return {
        output: 'Error: isolation:"remote" is not available -- no remote execution backend is configured for this session (WS-10 §8 unsupported-capability error).',
        isError: true,
      };
    }
    const resolvedIsolation: "worktree" | undefined = isolation === "worktree" ? "worktree" : undefined;

    // registry.ts's own documented contract (ToolExecutionContext.session.spawnChild's own header
    // comment): "Lane C's own tools/impl/agent.ts (the one production caller) is expected to treat
    // an absent method as 'no child-spawn capability configured for this run'" -- matching the exact
    // phrasing this lane's own child-engine.test.ts fixtures already use for the identical check.
    if (!ctx.session.spawnChild) {
      return { output: "no spawnChild capability configured", isError: true };
    }

    // WS-10 §2: subagent_type selects an AgentDefinition. Both sources now resolve -- filesystem
    // (the user tier always, a project `agents/*.md` only in a trusted workspace, RULING
    // R4-7 / resolveWorkspaceTrust()) AND the session's own PROGRAMMATIC `Options.agents` map,
    // which reaches this executor via `ctx.agents` (Phase 4 Task 8 closed Lane C's Disclosed Gap #3
    // by adding that field to ToolExecutionContext and threading `config.agents` onto it in
    // engine.ts's buildDefaultToolExecutor). `loadAgentDefinitions`'s own `programmatic` parameter
    // was always implemented and independently tested; this call site simply had nothing to pass it
    // until the seam existed. Precedence across sources is definitions.ts's own (programmatic >
    // project > user, "most specific wins" -- see that file's own header).
    let definition: RuntimeAgentDefinition | undefined;
    if (subagentType !== undefined) {
      // M11 (fix wave follow-up 6): the SESSION's own trust verdict, threaded from engine.ts through
      // ToolExecutionContext -- never a second hardcoded constant that could drift from the one the
      // permission evaluator and hook registry already use.
      const trustedWorkspace = resolveWorkspaceTrust(ctx);
      // Phase 5 Task 8 (Lane S's "What T8 must wire" item 3): plugin-contributed definitions, out of
      // the session-keyed registry `production-wiring.ts` populates. NOT folded into `ctx.agents` --
      // that field is the PROGRAMMATIC tier, and a plugin agent must sit at the BOTTOM of
      // `loadAgentDefinitions`' precedence (programmatic > project > user > plugin), never above a
      // user's own user-tier `agents/<name>.md`. See subagents/plugin-agents.ts for why the key is
      // the session id rather than the agent id.
      const pluginAgents = getPluginAgents(ctx.sessionId);
      // P7a fix r1 (Minor-1): the session's own profile, for BOTH the directories this reads and
      // the message it may print. `engine.ts`'s own `resolveAgentType` already threads one; this
      // second call site did not, so a branded session's Agent tool looked in `<home>/.winter/agents`.
      const agentsBrand = ctx.brand ?? WINTER_BRAND;
      const definitions = loadAgentDefinitions({
        cwd: ctx.cwd,
        home: ctx.home,
        brand: agentsBrand,
        // Phase 5 fix wave, KNOWN-6: the RESOLVED winter root, so a session run under a custom
        // `<PREFIX>HOME` finds its user agent definitions in the SAME root its skills and commands
        // came from. `ctx.winterHome` is threaded by `buildDefaultToolExecutor`.
        ...(ctx.winterHome !== undefined ? { winterHome: ctx.winterHome } : {}),
        trustedWorkspace,
        ...(ctx.agents !== undefined ? { programmatic: ctx.agents as Record<string, RuntimeAgentDefinition> } : {}),
        ...(pluginAgents !== undefined ? { pluginAgents } : {}),
      });
      const found = definitions.get(subagentType);
      if (found === undefined) {
        return {
          // P7a fix r1 (Minor-1): the MODEL-FACING text derives too. `loadAgentDefinitions` above
          // already reads the branded directories; a message naming `~/.winter/agents` sent the
          // model to look in a directory this product does not have.
          output: `Error: unknown subagent_type "${subagentType}" -- no AgentDefinition by that name was found (checked ~/${agentsBrand.homeDirName}/agents/*.md${trustedWorkspace ? ` and ${agentsBrand.projectDirName}/agents/*.md` : ""}${ctx.agents !== undefined ? " and this session's programmatic agents" : ""}).`,
          isError: true,
        };
      }
      definition = found;
    }

    // WS-10 §5: run_in_background is an invocation REQUEST, not the whole rule -- resolveForegroundBackground
    // owns the full chain (team constraints -> WINTER_DISABLE_BACKGROUND_TASKS -> fork default ->
    // invocation -> result-needed). `isFork` is always false here: AgentInput (WS-10 §1.2's pinned
    // field table) has no fork-triggering field at all -- fork is a SEPARATE spawn shape
    // (SpawnChildRequest.fork), never reachable through the model-facing Agent tool.
    // `resultNeededImmediately` is deliberately never passed -- see policy.ts's own header comment
    // on that parameter for why this call site has no meaningful value to give it.
    const fgbg = resolveForegroundBackground({
      ...(runInBackgroundInput !== undefined ? { invocationRequest: runInBackgroundInput } : {}),
      ...(definition?.background !== undefined ? { definitionBackground: definition.background } : {}),
      isFork: false,
    });

    // Phase 4 Task 8 closed Lane C's Disclosed Gap #4: `ctx.toolUseId` IS the model's own
    // `tool_use` block id for this call (registry.ts threads `EngineToolCall.id` onto every
    // ToolExecutionContext it builds), so WS-10 §4's "child progress correlated, keyed by parent
    // tool-use ID" is now keyed on the real id a host can match against the tool_use block it saw.
    // The randomUUID() fallback stays for a hand-built context that supplies no id (every
    // pre-existing impl/*.test.ts fixture): internally self-consistent, never a fabricated claim to
    // be the model's id.
    const parentToolUseId = ctx.toolUseId ?? randomUUID();

    // Task-frames parity (contract §4): `onProgress` is wired into the request BEFORE spawnChild
    // even runs, but the real task id does not exist until AFTER it resolves (background allocates
    // one via createBackgroundTask; foreground, a few lines below, allocates one the same way) -- so
    // the closure reads a variable this same scope assigns once the id is known, rather than the id
    // being a field of the request itself. A progress frame that somehow arrived before the id was
    // set (not reachable in practice -- see child-engine.ts's own header on why the pump cannot run
    // ahead of spawnChild's own return) would simply be dropped rather than throw.
    let taskId: string | undefined;
    const req: SpawnChildRequest = {
      parentToolUseId,
      prompt,
      runInBackground: fgbg.background,
      ...(definition !== undefined ? { definition } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(resolvedIsolation !== undefined ? { isolation: resolvedIsolation } : {}),
      ...(name !== undefined ? { name } : {}),
      onProgress: (progress) => {
        if (taskId === undefined) return;
        emitAgentTaskProgress(ctx, taskId, parentToolUseId, description, subagentType, progress);
      },
    };

    let handle: ChildHandle;
    try {
      handle = await ctx.session.spawnChild(req);
    } catch (err) {
      // Catches every synchronous/asynchronous failure spawnChild can produce: depth/concurrency
      // limits (limits.ts), an unresolvable model alias (resolution.ts), a slot that nothing this
      // session has can serve (WS-13c §4 step 5), a workspace-creation failure (workspace.ts, e.g.
      // isolation:"worktree" outside a git repo), or "no child engine factory is registered"
      // (Disclosed Gap #1, child-engine.ts's own header) -- one legible tool error, never an
      // uncaught throw out of this executor.
      //
      // WS-13c §3/§4 (P6.6): the CODE joins the text when the error carries one. A typed refusal
      // whose code is dropped reads to the model as an unexplained failure, and `slot-unservable`
      // (nothing serves it) versus `ambiguous-slot-name` (two families use that name) are two
      // different things for the model to do next -- pick another slot, or name the family's own.
      const code = typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error: subagent spawn failed -- ${code !== undefined ? `${code}: ` : ""}${message}`, isError: true };
    }

    if (!fgbg.background) {
      // Phase 4 fix wave (I5): a FOREGROUND child is tracked in the same unified task namespace a
      // background one is, so `TaskStop` can reach it -- before this, a foreground child had no
      // task id at all and `stop()` was reachable through no tool.
      //
      // Task-frames parity (contract §4): the pin registers a FOREGROUND agent too (`task_started
      // {..., is_backgrounded: false}`) and terminates it through the SAME `updateTask` door a
      // background agent uses -- the older "deliberately SILENT, remove on success" posture this
      // file's own history carried was measured wrong against a live run of the pin (that
      // remove-without-task_updated path is bash.ts's own foreground convention, never an agent's).
      // `background_tasks_changed` still never follows registration or termination here (§1's own
      // listing rule already excludes `isBackgrounded:false` rows, so emitting one would announce a
      // row nothing lists anyway) -- that is the ONE structural difference from the background path
      // below, per `finalizeAgentTask`'s own header.
      //
      // Best-effort by construction: the tracking row is a convenience on top of a child this call
      // is ALREADY awaiting, so a failure to create it (a hand-built ToolExecutionContext whose run
      // never called configureBackgroundTaskRoot) must degrade to "no task id", never fail the call.
      let outputPath: string | undefined;
      try {
        const registered = registerAgentTask(ctx, handle, description, prompt, subagentType, parentToolUseId, false);
        taskId = registered.taskId;
        outputPath = registered.outputPath;
      } catch {
        /* see above -- tracking is auxiliary to a child this call already owns */
      }
      try {
        const result = await handle.result();
        if (taskId !== undefined && outputPath !== undefined) finalizeAgentTask(taskId, parentToolUseId, outputPath, result);
        return foregroundResultToPayload(handle.record, result, prompt, subagentType);
      } catch (err) {
        // `handle.result()` per seam-contracts-p4.test.ts's own pinned behavior never actually
        // rejects -- this mirrors the background path's own defense-in-depth-only onRejected branch,
        // never expected to fire, but a terminal update here (rather than an orphaned "running" row)
        // is cheap insurance if it ever does.
        if (taskId !== undefined && outputPath !== undefined) {
          finalizeAgentTask(taskId, parentToolUseId, outputPath, { status: "failed", content: err instanceof Error ? err.message : String(err) });
        }
        throw err;
      }
    }

    return startBackgroundAgentTask(handle, ctx, description, prompt, subagentType, parentToolUseId, (id) => {
      taskId = id;
    });
  },
};

replaceExecutor(AGENT_TOOL_NAME, agentExecutor);
