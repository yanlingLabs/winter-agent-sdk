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
import type { RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import "../descriptors/agent.ts"; // self-sufficiency: guarantees the "Agent" stub is registered before replaceExecutor runs below.
import { createBackgroundTask } from "../background-tasks.ts";
// Phase 4 Task 8 (rider 24): the shared background-task runtime TaskStop/TaskOutput are built on.
import { startTracking, setTaskStatus, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";
import { loadAgentDefinitions } from "../../subagents/definitions.ts";
import { resolveForegroundBackground, resolveWorkspaceTrust } from "../../subagents/policy.ts";
import type { ChildHandle, ChildResult, ChildSessionRecord, SpawnChildRequest } from "../../subagents/child-handle.ts";

export const AGENT_TOOL_NAME = "Agent";

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
//
// The small map below still exists for a DIFFERENT reason, unchanged: `background_tasks_changed`
// carries a `task_type` per row, and the shared registry's own entry shape does not preserve the
// per-row description/type pairing this frame needs -- so agent rows are merged in alongside
// whatever the registry reports for bash/monitor.
interface AgentBackgroundTaskEntry {
  task_id: string;
  task_type: "agent";
  description: string;
}
const backgroundAgentTasks = new Map<string, AgentBackgroundTaskEntry>();

function currentBackgroundTasksChanged(): Array<{ task_id: string; task_type: string; description: string }> {
  return [...listRunningTasks().map(toBackgroundTasksChangedEntry), ...backgroundAgentTasks.values()];
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

function startBackgroundAgentTask(handle: ChildHandle, ctx: ToolExecutionContext, description: string, prompt: string, subagentType: string | undefined): ToolResultPayload {
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
    ({ taskId, outputPath } = createBackgroundTask("agent"));
    backgroundAgentTasks.set(taskId, { task_id: taskId, task_type: "agent", description });
    // Phase 4 Task 8 (rider 24): register the task in the SHARED background-task runtime, so
    // TaskStop and TaskOutput -- both of which are implemented entirely against that registry --
    // reach a background agent task exactly as they reach a backgrounded Bash command. Lane C's own
    // report flagged the asymmetry ("TaskStop/TaskOutput do not reach background agent tasks");
    // closing it needed the registry's own `BackgroundTaskKind` union widened first (done, this
    // task), because an agent task has no OS process at all.
    //
    // `pid` is deliberately ABSENT: a child is an in-process `runEngine` loop (RULING R4-4), never
    // an OS process, so there is no process group to signal. The generic `stop` callback is the
    // whole point of that field's existence (it was added for Monitor's socket half, which likewise
    // has no pid) -- `handle.stop()` is idempotent and settles the child's result, so a TaskStop
    // against a background agent aborts the real child rather than merely marking a row.
    startTracking({
      taskId,
      kind: "agent",
      outputPath,
      description,
      stop: () => {
        void handle.stop();
      },
    });
    writeAgentTaskStub(outputPath, handle);

    ctx.emitFrame({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: handle.record.parentToolUseId,
      description,
      ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
      is_backgrounded: true,
      task_type: "agent",
      prompt,
      uuid: randomUUID(),
      session_id: ctx.sessionId,
    });
    ctx.emitFrame({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: currentBackgroundTasksChanged(),
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
      backgroundAgentTasks.delete(taskId);
      // Rider 24: reflect the child's own terminal status into the shared registry, so
      // `listRunningTasks()` (and therefore TaskStop's own "already finished" answer) is accurate.
      setTaskStatus(taskId, result.status === "completed" ? "completed" : result.status === "stopped" ? "stopped" : "failed");
      // ChildResult.status (child-handle.ts, T3-frozen) is ALREADY the identical 3-member
      // "completed"|"stopped"|"failed" union SDKTaskNotificationMessage.status expects -- no
      // narrowing/fallback needed, unlike ChildSessionRecord.status's own wider 4-member ChildStatus.
      const status = result.status;
      try {
        appendFileSync(outputPath, `\n[${new Date().toISOString()}] subagent ${handle.record.id} ${status}.\n`);
      } catch {
        /* the stub file is a best-effort convenience; its own write failure must never crash this callback */
      }
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          tool_use_id: handle.record.parentToolUseId,
          status,
          output_file: outputPath,
          summary: `${description} (${status})`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
        ctx.emitFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: currentBackgroundTasksChanged(),
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* a torn-down session's emitFrame may throw; the registry's own state and the .output stub are still correct */
      }
    },
    () => {
      backgroundAgentTasks.delete(taskId);
      setTaskStatus(taskId, "failed");
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
    // (`~/.winter/agents/*.md` always, `.winter/agents/*.md` only in a trusted workspace, RULING
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
      const definitions = loadAgentDefinitions({
        cwd: ctx.cwd,
        home: ctx.home,
        trustedWorkspace,
        ...(ctx.agents !== undefined ? { programmatic: ctx.agents as Record<string, RuntimeAgentDefinition> } : {}),
      });
      const found = definitions.get(subagentType);
      if (found === undefined) {
        return {
          output: `Error: unknown subagent_type "${subagentType}" -- no AgentDefinition by that name was found (checked ~/.winter/agents/*.md${trustedWorkspace ? " and .winter/agents/*.md" : ""}${ctx.agents !== undefined ? " and this session's programmatic agents" : ""}).`,
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

    const req: SpawnChildRequest = {
      parentToolUseId,
      prompt,
      runInBackground: fgbg.background,
      ...(definition !== undefined ? { definition } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(resolvedIsolation !== undefined ? { isolation: resolvedIsolation } : {}),
      ...(name !== undefined ? { name } : {}),
    };

    let handle: ChildHandle;
    try {
      handle = await ctx.session.spawnChild(req);
    } catch (err) {
      // Catches every synchronous/asynchronous failure spawnChild can produce: depth/concurrency
      // limits (limits.ts), an unresolvable model alias (resolution.ts), a workspace-creation
      // failure (workspace.ts, e.g. isolation:"worktree" outside a git repo), or "no child engine
      // factory is registered" (Disclosed Gap #1, child-engine.ts's own header) -- one legible tool
      // error, never an uncaught throw out of this executor.
      return { output: `Error: subagent spawn failed -- ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }

    if (!fgbg.background) {
      // Phase 4 fix wave (I5): a FOREGROUND child is tracked in the same unified task namespace a
      // background one is, so `TaskStop` can reach it -- before this, a foreground child had no
      // task id at all and `stop()` was reachable through no tool. Deliberately SILENT: no
      // `task_started`/`background_tasks_changed` frame is emitted (those describe a BACKGROUNDED
      // task to the model, and emitting them here would both mislead and churn every committed
      // spawn golden), and the row is moved to a terminal status the moment the child settles, so a
      // later `background_tasks_changed` can never advertise a finished foreground child.
      //
      // Best-effort by construction: the tracking row is a convenience on top of a child this call
      // is ALREADY awaiting, so a failure to create it (a hand-built ToolExecutionContext whose run
      // never called configureBackgroundTaskRoot) must degrade to "no task id", never fail the call.
      let foregroundTaskId: string | undefined;
      try {
        const { taskId, outputPath } = createBackgroundTask("agent");
        startTracking({ taskId, kind: "agent", outputPath, description, stop: () => void handle.stop() });
        foregroundTaskId = taskId;
      } catch {
        /* see above -- tracking is auxiliary to a child this call already owns */
      }
      try {
        const result = await handle.result();
        return foregroundResultToPayload(handle.record, result, prompt, subagentType);
      } finally {
        if (foregroundTaskId !== undefined) {
          setTaskStatus(foregroundTaskId, handle.record.status === "completed" ? "completed" : handle.record.status === "stopped" ? "stopped" : "failed");
        }
      }
    }

    return startBackgroundAgentTask(handle, ctx, description, prompt, subagentType);
  },
};

replaceExecutor(AGENT_TOOL_NAME, agentExecutor);
