// WS-10: the Agent tool -- ties definitions/resolution/policy/limits/workspace/child-engine
// together into the model-facing tool a running session actually calls. child-engine.ts's own file
// header discloses three seam gaps this whole subsystem inherits (provider/store injection at
// main.ts, child permission-RPC routing, programmatic AgentDefinition visibility) -- this file
// documents a FOURTH below, and is where all four are actually felt by a real model-facing call.
//
// Disclosed Gap #4 (parentToolUseId): `SpawnChildRequest.parentToolUseId` is REQUIRED (child-
// handle.ts, T3-frozen), but `ToolExecutionContext` (registry.ts, frozen) carries no field for a
// tool's own tool_use_id. Confirmed by direct code reading, not assumption: engine.ts calls
// `tools.execute({id: record.toolUseID, ...})`, but `buildRegistryToolExecutor`'s own `execute`
// (registry.ts) constructs its `ctx: ToolExecutionContext` object WITHOUT ever including `call.id`
// -- grepping registry.ts for `toolUseId`/`tool_use_id`/`callId`/`call\.id` returns zero matches. No
// registered tool anywhere in this codebase can know its own tool_use_id today. No workaround exists
// within this lane's file authority (the fix is a one-line `toolUseId: string` field on
// ToolExecutionContext plus one `toolUseId: call.id` line in registry.ts's own ctx literal, both
// outside this lane's file list) -- a freshly generated id stands in for it instead. This is
// internally self-consistent (every frame ONE spawn's own descendants ever produce is stamped with
// the SAME synthetic id, so a listener can still correlate a family of frames to ONE spawn call),
// but it is NOT the model's own real tool_use_id -- WS-10 §4's "keyed by parent tool-use ID"
// correlation guarantee is real but rooted in a synthetic key, not the model's own. Flagged
// NEEDS_CONTEXT #1 in this lane's own report -- do not attempt to recover the real id from `input`;
// it is not present there.
import { randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync } from "node:fs";
import type { RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import "../descriptors/agent.ts"; // self-sufficiency: guarantees the "Agent" stub is registered before replaceExecutor runs below.
import { createBackgroundTask } from "../background-tasks.ts";
import { listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";
import { loadAgentDefinitions } from "../../subagents/definitions.ts";
import { resolveForegroundBackground, resolveWorkspaceTrust } from "../../subagents/policy.ts";
import type { ChildHandle, ChildResult, ChildSessionRecord, SpawnChildRequest } from "../../subagents/child-handle.ts";

export const AGENT_TOOL_NAME = "Agent";

// R4-8 / WS-10 §17 Open Question 1: the FROZEN descriptor (tools/descriptors/agent.ts) advertises
// `name` in its own `inputSchema.properties` -- the spec is explicit that it must instead be
// "accepted host-side, withheld from the model schema" until a real capability predicate for it
// exists (none does). This is a genuine violation of that MUST, in a file this lane may never edit
// (R4-10) -- NOT fixed here, reported as NEEDS_CONTEXT. This executor still accepts `name` (host-
// side acceptance is correct regardless of what the schema advertises) -- the bug is confined to
// what the MODEL is told is available, not to this file's own handling of the field once given.

// --- Background-task bookkeeping (WS-06 §3.5, WS-12 §7) ------------------------------------------
//
// background-task-runtime.ts's own registry (Lane C-of-P3) only knows "bash"/"monitor" tasks -- an
// agent task is deliberately NOT registered there (TaskStop's own `getTask(id)` lookup, and
// TaskOutput's tracked path, both stay blind to it; TaskOutput's own UNTRACKED fallback -- reading
// the physical `.output` file directly by path -- still works for the stub this file writes below).
// Wiring TaskStop/TaskOutput to also reach agent children needs edits to background-task-runtime.ts
// and/or tools/impl/task-stop.ts, both outside this lane's file list (R4-10) -- disclosed as
// NEEDS_CONTEXT, not attempted. A model-facing way to stop a background agent still exists in
// principle via SendMessage-driven steer (Lane D's own tool, WS-10 §10.3), just not via TaskStop.
//
// This own small map exists ONLY so `background_tasks_changed` can report an agent task ALONGSIDE
// whatever bash/monitor tasks are also running -- `listRunningTasks()` alone would omit it entirely.
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
  const { taskId, outputPath } = createBackgroundTask("agent");
  backgroundAgentTasks.set(taskId, { task_id: taskId, task_type: "agent", description });
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

  // Fire-and-forget: run_in_background's whole point is returning before completion (mirrors
  // bash.ts's own identical completion.then pattern for its own background tasks). Per the
  // seam-contracts-p4.test.ts fixture's own pinned behavior, result() resolves exactly once and
  // never rejects -- the onRejected branch is defense-in-depth only, never expected to fire.
  handle.result().then(
    (result) => {
      backgroundAgentTasks.delete(taskId);
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

    // WS-10 §2: subagent_type selects an AgentDefinition. Resolvable sources today are filesystem-
    // only: `~/.winter/agents/*.md` always, `.winter/agents/*.md` only in a trusted workspace
    // (RULING R4-7, resolveWorkspaceTrust()). A session's own programmatic Options.agents map is NOT
    // reachable from inside a tool executor at all (Disclosed Gap #3, child-engine.ts's own header)
    // -- `loadAgentDefinitions`'s own `programmatic` parameter is always omitted here until that seam
    // grows a field; this is a real, disclosed production limitation (NEEDS_CONTEXT), not a bug in
    // this call.
    let definition: RuntimeAgentDefinition | undefined;
    if (subagentType !== undefined) {
      const trustedWorkspace = resolveWorkspaceTrust();
      const definitions = loadAgentDefinitions({ cwd: ctx.cwd, home: ctx.home, trustedWorkspace });
      const found = definitions.get(subagentType);
      if (found === undefined) {
        return {
          output: `Error: unknown subagent_type "${subagentType}" -- no AgentDefinition by that name was found (checked ~/.winter/agents/*.md${trustedWorkspace ? " and .winter/agents/*.md" : ""}).`,
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

    // Disclosed Gap #4 (this file's own header): a freshly generated id stands in for the real
    // tool_use_id no registered executor can see.
    const parentToolUseId = randomUUID();

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
      const result = await handle.result();
      return foregroundResultToPayload(handle.record, result, prompt, subagentType);
    }

    return startBackgroundAgentTask(handle, ctx, description, prompt, subagentType);
  },
};

replaceExecutor(AGENT_TOOL_NAME, agentExecutor);
