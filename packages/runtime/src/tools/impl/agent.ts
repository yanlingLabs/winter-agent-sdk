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
import { WINTER_BRAND, envName, type RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { AGENT_TOOL_CANONICAL_NAME } from "../../provider/slots.ts";
import { OMITTED_TYPE_REQUIRED_PREFIX } from "../descriptors/agent.ts"; // also self-sufficiency: guarantees the "Agent" stub is registered before replaceExecutor runs below.
import { createBackgroundTask } from "../background-tasks.ts";
// Phase 4 Task 8 (rider 24): the shared background-task runtime TaskStop/TaskOutput are built on.
// Task-frames parity (2026-09-17 contract §4): `backgroundAgentTasks`/`currentBackgroundTasksChanged`
// (this file's own header used to explain why a SECOND map existed alongside the shared registry) are
// GONE -- now that the registry's own `toBackgroundTasksChangedEntry` maps kind "agent" to the pinned
// wire spelling itself (background-tasks.ts's WIRE_TASK_TYPES), the second map carried nothing the
// registry did not already have; the two were kept in lockstep by hand, which is exactly the
// "per-tool literal" duplication the update/notify doors below exist to remove.
import { startTracking, updateTask, getTask, removeTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";
import { loadAgentDefinitions, findAgentByType, formatAgentNotFound, formatAgentAmbiguous, type SourcedAgentDefinition } from "../../subagents/definitions.ts";
import { getPluginAgents } from "../../subagents/plugin-agents.ts";
import { resolveForegroundBackground, resolveWorkspaceTrust } from "../../subagents/policy.ts";
import { renderAgentNotification } from "../../subagents/notification-queue.ts";
import { resolveForkSubagentEnabled } from "../../subagents/builtin-agents.ts";
import { hasGitRoot } from "../../subagents/git-root.ts";
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
//
// Contract §8: `description` is the child's most recent recorded tool call's ACTIVITY text
// (`progress.activity`, computed by child-engine.ts from that call's input), falling back to the task
// description only when that tool has none.
function emitAgentTaskProgress(ctx: ToolExecutionContext, taskId: string, parentToolUseId: string, description: string, subagentType: string | undefined, progress: ChildTaskProgress): void {
  ctx.emitFrame({
    type: "system",
    subtype: "task_progress",
    task_id: taskId,
    tool_use_id: parentToolUseId,
    description: progress.activity ?? description,
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
  const row = getTask(taskId);
  updateTask(taskId, {
    status: result.status,
    endTime: Date.now(),
    ...(result.status === "failed" ? { error: result.content } : {}),
    notification: {
      summary: result.content,
      outputFile: outputPath,
      toolUseId: parentToolUseId,
      ...(usage !== undefined ? { usage } : {}),
      // SDK 0.0.16 Lane N: the MODEL-facing document (claude's `vP`). A FOREGROUND agent gets none --
      // this tool call's own return value already carries the child's result to the model. A
      // BACKGROUND one gets the summary the pin builds from the DESCRIPTION (`Agent "<desc>"
      // finished`), with the child's report text in `<result>` -- deliberately not the frame's own
      // `summary`, which IS that report text (contract §4). `stoppedBy` is left absent here (Winter's
      // `ChildResult` carries no killer attribution, so the wording is the pin's unattributed "was
      // stopped"); `task-stop.ts` knows the actor and passes it.
      modelNotification:
        row?.isBackgrounded === false
          ? null
          : renderAgentNotification({
              taskId,
              toolUseId: parentToolUseId,
              description: row?.description ?? "",
              status: result.status,
              outputFile: outputPath,
              ...(result.status === "failed" ? { error: result.content } : { finalMessage: result.content }),
              ...(result.usage !== undefined ? { usage: { totalTokens: result.usage.totalTokens, toolUses: result.usage.toolUses, durationMs: result.usage.durationMs } } : {}),
            }),
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
    ...(ctx.agentId !== undefined ? { ownerAgentId: ctx.agentId } : {}),
    stop: () => {
      void handle.stop();
    },
    // Review r1 finding 4: whichever door finalizes this row (the agent's own result path or a
    // TaskStop that gets there first) reports the child's live usage.
    usage: () => toWireUsage(handle.usage?.()),
  });
  // Review r1 finding 12: a registration that fails AFTER the row exists must not leave a
  // "running" row behind that nothing will ever finalize.
  try {
    writeAgentTaskStub(outputPath, handle);
    emitAgentTaskStarted(ctx, taskId, parentToolUseId, description, subagentType, isBackgrounded, handle.record.spawnDepth, prompt);
  } catch (err) {
    removeTask(taskId);
    throw err;
  }
  return { taskId, outputPath };
}

// --- Spawn-surface parity (L2b): the model-facing refusals and the launch result -----------------

/** R-S5 / claude's own wording (an error message, not prompt text -- R-S4). */
export const FORK_INSIDE_FORK_REFUSAL = "Fork is not available inside a forked worker. Complete your task directly using your tools.";
/**
 * R-S5: claude's fork+remote refusal. The research file truncates claude's string after the dash; the
 * tail is a WINTER completion (disclosed).
 */
export const FORK_REMOTE_REFUSAL = 'Fork cannot use isolation: "remote" — a fork inherits this session\'s live conversation, which a remote environment cannot receive. Omit isolation, or use isolation: "worktree".';

/** R-S4: a thrown-style Agent-tool error -- claude's plain message text, `is_error: true`, no prefix. */
function refusal(message: string): ToolResultPayload {
  return { output: message, isError: true };
}

function isTruthyEnv(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

/**
 * Research §A5: the remote fallback is SILENT to the model -- claude records it in its debug log only.
 * Winter's equivalent: one stderr line, and only when `<PREFIX>DEBUG` is set for the session.
 */
function debugLog(ctx: ToolExecutionContext, line: string): void {
  const brand = ctx.brand ?? WINTER_BRAND;
  if (!isTruthyEnv((ctx.env ?? process.env)[envName(brand, "DEBUG")])) return;
  try {
    process.stderr.write(`${brand.envPrefix.toLowerCase().replace(/_$/, "")}[debug]: ${line}\n`);
  } catch {
    /* a closed stderr must never fail a spawn */
  }
}

/**
 * Research §A8: the background launch result. claude's structured shape (`status: "async_launched"`,
 * `agentId`, `description`, `prompt`, `outputFile`, `canReadOutputFile`) plus the model-facing
 * guidance, Winter-worded: it launched, a notification will arrive, do not predict its results, do
 * not read the output file while it runs, and SendMessage reaches it. `taskId` is a Winter extension
 * (a Winter agent id is not its task id, and TaskStop/TaskOutput take the task id).
 */
function backgroundLaunchResult(args: { agentId: string; taskId: string; description: string; prompt: string; outputFile: string; canReadOutputFile: boolean }): ToolResultPayload {
  const guidance = [
    `Agent launched in the background ("${args.description}").`,
    `agentId: ${args.agentId} -- an internal identifier; do not show it to the user. To give this agent more instructions, or to continue it after it finishes, use SendMessage with to: "${args.agentId}". To cancel it, use TaskStop with task_id: "${args.taskId}".`,
    "It is running now, and you will be notified automatically when it finishes. Do not guess at or describe its results before that notification arrives, and do not repeat the work it is doing.",
    args.canReadOutputFile
      ? `Its output is being recorded at ${args.outputFile}. Do not read or tail that file while the agent is still running -- wait for the notification. Until then, work only on things that do not overlap with this agent's task, or briefly tell the user what you launched and end your turn.`
      : "Briefly tell the user what you launched and end your turn; the agent's result will arrive in a later message.",
  ].join("\n");
  return {
    output: JSON.stringify({
      status: "async_launched",
      agentId: args.agentId,
      taskId: args.taskId,
      description: args.description,
      prompt: args.prompt,
      outputFile: args.outputFile,
      canReadOutputFile: args.canReadOutputFile,
      message: guidance,
    }),
  };
}

// Fire-and-forget completion of a BACKGROUND agent task whose row is already registered (by the
// spawn's own `onSpawned`, or by the fallback below). Mirrors bash.ts's own completion.then pattern.
// Per the seam-contracts-p4.test.ts fixture's own pinned behavior, result() resolves exactly once
// and never rejects -- the onRejected branch is defense-in-depth only.
function finishBackgroundAgentTaskLater(handle: ChildHandle, ctx: ToolExecutionContext, taskId: string, parentToolUseId: string, outputPath: string): void {
  handle.result().then(
    (result) => {
      // A TaskStop that already finalized this row (its own `updateTask` call) gets here first when
      // `handle.stop()`'s own settle resolves `result()` -- the guard avoids a redundant stub-append
      // and background_tasks_changed (updateTask itself would refuse the late change anyway).
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
}

export const agentExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = toRecordShape(input);
    const description = typeof record["description"] === "string" ? (record["description"] as string) : undefined;
    const prompt = typeof record["prompt"] === "string" ? (record["prompt"] as string) : undefined;
    if (description === undefined || prompt === undefined) {
      return { output: 'Error: Agent requires both "description" and "prompt" string fields.', isError: true };
    }
    const requestedType = typeof record["subagent_type"] === "string" ? (record["subagent_type"] as string) : undefined;
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

    // registry.ts's own documented contract (ToolExecutionContext.session.spawnChild's own header
    // comment): "Lane C's own tools/impl/agent.ts (the one production caller) is expected to treat
    // an absent method as 'no child-spawn capability configured for this run'".
    if (!ctx.session.spawnChild) {
      return { output: "no spawnChild capability configured", isError: true };
    }

    const env = ctx.env ?? process.env;
    const agentsBrand = ctx.brand ?? WINTER_BRAND;

    // R-S5: the fork gate (the session's resolved RuntimeConfig/env verdict). With the gate OFF,
    // "fork" is an ordinary name that no definition carries -- the not-found error below.
    const forkEnabled = ctx.forkSubagentEnabled ?? resolveForkSubagentEnabled(env, agentsBrand);

    // WS-10 §2: the session's subagent_type set -- built-ins (lowest tier), plugin, user, project
    // (trust-gated, RULING R4-7) and programmatic -- read with the SESSION's env so the built-in kill
    // switches apply per session (limits.ts precedent), and the same inputs every other reader of
    // this set uses (engine.ts's `sessionAgentDefinitions`).
    const trustedWorkspace = resolveWorkspaceTrust(ctx);
    const pluginAgents = getPluginAgents(ctx.sessionId);
    const definitions = loadAgentDefinitions({
      cwd: ctx.cwd,
      home: ctx.home,
      brand: agentsBrand,
      ...(ctx.winterHome !== undefined ? { winterHome: ctx.winterHome } : {}),
      trustedWorkspace,
      env,
      forkSubagentEnabled: forkEnabled,
      // Review r2 finding 2: wires `loadAgentDefinitions`' own `onReject` to the session's ONE
      // reporter (`ctx.onAgentDefinitionRejected`, threaded from `engine.ts`'s own
      // `reportAgentDefinitionRejection`) -- previously this call site passed nothing at all, so a
      // rejected agent file the Agent tool itself resolved against vanished with no report anywhere.
      ...(ctx.onAgentDefinitionRejected !== undefined ? { onReject: ctx.onAgentDefinitionRejected } : {}),
      ...(ctx.agents !== undefined ? { programmatic: ctx.agents as Record<string, RuntimeAgentDefinition> } : {}),
      ...(pluginAgents !== undefined ? { pluginAgents } : {}),
    });

    // Research §A4/§A7: omitted -> general-purpose; a name resolves after normalization (exact match
    // first); a miss or an ambiguity refuses with claude's own wording and the available list.
    //
    // SDK 0.0.16 Lane P (R3b §4): `ctx.agentAvailability` (registry.ts) is this session's live
    // Agent(type) deny / allowedAgentTypes / all-tools-denied verdict, built fresh by engine.ts per
    // call. `avail === undefined` (every hand-built ToolExecutionContext in this package's own test
    // files, and any host that never wires the seam) falls back to the PRE-EXISTING, unrestricted
    // behavior byte-for-byte -- resolution always runs against the FULL `definitions` map either
    // way (a denied/not-allowed type must still be resolvable BY NAME so its own refusal can name
    // it, never a bare "not found" for a type that genuinely exists).
    let definition: RuntimeAgentDefinition | undefined;
    let subagentType: string;
    let definitionSource: SourcedAgentDefinition["_source"] | undefined;
    const avail = ctx.agentAvailability?.();
    if (requestedType === undefined) {
      const generalPurpose = definitions.get("general-purpose");
      // R3b §4: "the omitted-type default (general-purpose) applies only when it is allowed" --
      // denied, not-allowed (allowedAgentTypes) and all-tools-denied all withhold the default
      // exactly like an explicit request would.
      const generalPurposeAvailable = generalPurpose !== undefined && (avail === undefined || avail.availableNames.includes("general-purpose"));
      if (!generalPurposeAvailable) {
        const available = avail?.availableNames ?? [...definitions.keys()];
        return refusal(`${OMITTED_TYPE_REQUIRED_PREFIX}. Available agents: ${available.length > 0 ? [...available].sort().join(", ") : "none"}`);
      }
      definition = generalPurpose;
      definitionSource = generalPurpose!._source;
      subagentType = "general-purpose";
    } else {
      const found = findAgentByType(definitions, requestedType);
      if (found.kind === "not-found") return refusal(formatAgentNotFound(requestedType, avail?.availableNames ?? [...definitions.keys()]));
      if (found.kind === "ambiguous") return refusal(formatAgentAmbiguous(requestedType, found.matches));
      // SDK 0.0.16 Lane P (R3b §4): a resolved type may EXIST in the full definitions map but be
      // unavailable right now -- either a per-type deny rule or "every tool it may use is denied"
      // (both carry their own exact claude-shaped prose, `unavailableMessage`), or simply excluded
      // from `allowedAgentTypes` (claude reuses the plain not-found shape for THAT case -- an
      // out-of-scope name reads exactly like an unknown one, and "Available agents" lists only
      // what is actually in scope -- `avail.availableNames`, never the full universe).
      const unavailable = avail?.unavailableMessage(found.name);
      if (unavailable !== undefined) return refusal(unavailable);
      if (avail !== undefined && !avail.availableNames.includes(found.name)) return refusal(formatAgentNotFound(requestedType, avail.availableNames));
      definition = found.definition;
      definitionSource = found.definition._source;
      subagentType = found.name;
    }

    // Review r2 finding 8 (whole-branch): `isFork` is decided from the RESOLVED name
    // (`subagentType`, `findAgentByType`'s own normalized `found.name`), never the raw
    // `requestedType` string. The old `requestedType === "fork"` exact-string check missed a
    // differently-cased request ("Fork") that `findAgentByType`'s own case-insensitive
    // normalization resolves to the SAME fork definition (definitions.ts's own `normalizeAgentTypeName`
    // lowercases before comparing) -- so a model asking for "Fork" got the fork definition's `tools:
    // ["*"]` pool and its placeholder prompt as an ORDINARY child (isFork false): the two refusals
    // below never ran, `model` was not ignored, and the child was never forced into the fork's own
    // inheritance/background/nesting semantics. Run AFTER resolution, and before the isolation
    // "remote" fallback below -- a Fork+remote request must refuse outright, not silently become a
    // worktree child.
    const isFork = forkEnabled && subagentType === "fork";
    if (isFork && ctx.insideFork === true) return refusal(FORK_INSIDE_FORK_REFUSAL);
    if (isFork && isolation === "remote") return refusal(FORK_REMOTE_REFUSAL);

    // Research §A5 / R-S8: `remote` stays advertised but has no backend -- claude's SILENT fallback:
    // a worktree when the session root is inside a git repository, else a plain local agent (a debug
    // line only, never a model-facing error). The `web-fetch` built-in ignores isolation altogether.
    let resolvedIsolation: "worktree" | undefined = isolation === "worktree" ? "worktree" : undefined;
    if (isolation === "remote") {
      const root = ctx.session.getSessionRoot();
      const inGit = await hasGitRoot(root);
      resolvedIsolation = inGit ? "worktree" : undefined;
      debugLog(ctx, `Agent isolation "remote" is unavailable; running ${inGit ? "in a worktree" : "locally"} instead (${root})`);
    }
    if (subagentType === "web-fetch") resolvedIsolation = undefined;

    // WS-10 §5: run_in_background is an invocation REQUEST, not the whole rule -- resolveForegroundBackground
    // owns the full chain. R-S7: Winter keeps its FOREGROUND default (it has no held-back turn result
    // for a background agent), with the fork gate on as well.
    const fgbg = resolveForegroundBackground({
      ...(runInBackgroundInput !== undefined ? { invocationRequest: runInBackgroundInput } : {}),
      ...(definition?.background !== undefined ? { definitionBackground: definition.background } : {}),
      isFork,
      env,
      brand: agentsBrand,
    });

    // Phase 4 Task 8 closed Lane C's Disclosed Gap #4: `ctx.toolUseId` IS the model's own `tool_use`
    // block id for this call. The randomUUID() fallback stays for a hand-built context.
    const parentToolUseId = ctx.toolUseId ?? randomUUID();

    // Task-frames parity: the task row + `task_started` are created from the spawn's own
    // `onSpawned` (review r1 finding 9) -- BEFORE the child's first generation, so nothing the child
    // produces can precede them. A spawner that never calls it (a hand-built test double) is covered
    // by the fallback after `spawnChild` returns. A registration failure is RECORDED, not thrown:
    // the child already exists by then, and what to do with it is decided below.
    let taskId: string | undefined;
    let outputPath: string | undefined;
    let registrationError: { error: unknown } | undefined;
    const register = (handle: ChildHandle): void => {
      if (taskId !== undefined || registrationError !== undefined) return;
      try {
        const registered = registerAgentTask(ctx, handle, description, prompt, subagentType, parentToolUseId, fgbg.background);
        taskId = registered.taskId;
        outputPath = registered.outputPath;
        if (fgbg.background) {
          ctx.emitFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
            uuid: randomUUID(),
            session_id: ctx.sessionId,
          });
        }
      } catch (err) {
        registrationError = { error: err };
      }
    };

    const req: SpawnChildRequest = {
      parentToolUseId,
      prompt,
      runInBackground: fgbg.background,
      ...(definition !== undefined ? { definition } : {}),
      ...(isFork ? { fork: true as const } : {}),
      // R-S5: a fork always inherits the parent's model -- `model` is ignored for it.
      ...(model !== undefined && !isFork ? { model } : {}),
      ...(resolvedIsolation !== undefined ? { isolation: resolvedIsolation } : {}),
      ...(name !== undefined ? { name } : {}),
      // SDK 0.0.16 Lane P (R3b §5): see SpawnChildRequest.builtinAgentType's own header -- this is
      // the one channel engine.ts's `resolveChildModel` has for telling "this child IS the built-in
      // Explore" (the Explore model cap) from "this child is merely named 'Explore'".
      ...(definitionSource === "builtin" ? { builtinAgentType: subagentType } : {}),
      onSpawned: register,
      onProgress: (progress) => {
        // Review r1 finding 3: a RESUMED child (SendMessage) runs a new generation under the same
        // request, and a stopped child may still flush buffered frames -- neither may report
        // progress for a task whose notification has already gone out.
        if (taskId === undefined || getTask(taskId)?.status !== "running") return;
        emitAgentTaskProgress(ctx, taskId, parentToolUseId, description, subagentType, progress);
      },
    };

    let handle: ChildHandle;
    try {
      handle = await ctx.session.spawnChild(req);
    } catch (err) {
      // Catches every failure spawnChild can produce: depth/concurrency limits (limits.ts), an
      // unresolvable model alias (resolution.ts), a slot nothing serves (WS-13c §4 step 5), a
      // workspace-creation failure (workspace.ts), or "no child engine factory is registered".
      // R-S4: claude's shape -- the thrown message, `is_error: true`. WS-13c §3/§4 (P6.6): the
      // typed code still joins the text when the error carries one.
      const code = typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : undefined;
      const message = err instanceof Error ? err.message : String(err);
      return refusal(`${code !== undefined ? `${code}: ` : ""}${message}`);
    }
    register(handle); // no-op when the spawn already called `onSpawned`

    if (!fgbg.background) {
      // Task-frames parity (contract §4): a FOREGROUND agent is registered too (`is_backgrounded:
      // false`) and terminates through the SAME `updateTask` door as a background one; it is never
      // listed, so no `background_tasks_changed` follows. The row is a convenience on top of a child
      // this call is already awaiting, so a failed registration degrades to "no task id".
      try {
        const result = await handle.result();
        // Review r1 finding 6: a TaskStop may already have finalized this row.
        if (taskId !== undefined && outputPath !== undefined && getTask(taskId)?.status === "running") finalizeAgentTask(taskId, parentToolUseId, outputPath, result);
        return foregroundResultToPayload(handle.record, result, prompt, subagentType);
      } catch (err) {
        // `handle.result()` never rejects per seam-contracts-p4.test.ts -- defense in depth only.
        if (taskId !== undefined && outputPath !== undefined && getTask(taskId)?.status === "running") {
          finalizeAgentTask(taskId, parentToolUseId, outputPath, { status: "failed", content: err instanceof Error ? err.message : String(err) });
        }
        throw err;
      }
    }

    // BACKGROUND: `handle` is already a real, running child. If its bookkeeping failed, the child
    // would otherwise be a silent ORPHAN (running, tracked nowhere, stoppable by nothing) -- stop it
    // and surface a legible error instead.
    if (registrationError !== undefined || taskId === undefined || outputPath === undefined) {
      void handle.stop();
      const err = registrationError?.error;
      return {
        output: `Error: subagent ${handle.record.id} was spawned but its background-task setup failed -- stopped it rather than leaving an orphan: ${err instanceof Error ? err.message : String(err ?? "no task id")}`,
        isError: true,
      };
    }
    finishBackgroundAgentTaskLater(handle, ctx, taskId, parentToolUseId, outputPath);
    const advertised = ctx.advertisedToolNames?.();
    return backgroundLaunchResult({
      agentId: handle.record.id,
      taskId,
      description,
      prompt,
      outputFile: outputPath,
      canReadOutputFile: advertised === undefined || advertised.includes("Read") || advertised.includes("Bash"),
    });
  },
};

replaceExecutor(AGENT_TOOL_NAME, agentExecutor);
