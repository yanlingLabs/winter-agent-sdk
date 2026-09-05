// Phase 5 Lane W (task 4): the PARENT half of the workflow runtime -- WS-11 §1.4/§1.5/§1.8. Ported
// from Norma's `workflows/runtime.ts` (D8/D11) with every `NORMA_HOME`/SessionEvent coupling removed:
// this class emits nothing of its own, holds no notion of a daemon, and reaches the session through
// exactly two objects -- `WorkflowRunHost` (the frozen seam) and `WorkflowSessionRuntime` (the paths
// and accountants a `ToolExecutionContext` cannot carry).
//
// THE DIVISION OF LABOUR, since it is the thing a reader most needs: the WORKER runs the script and
// asks; the PARENT decides and acts. Every cap, every budget check, every filesystem write and every
// child spawn happens here. The worker mirrors the caps so it can fail fast and produce a good error
// message, but a worker that ignored its mirror entirely could still not spawn one agent past the
// cap -- which is the property that makes the mirror an optimisation rather than a security control.
import { randomBytes } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
// STATIC, never `await import(...)`: this module is bundled into the `bun build --compile`
// single-file executable, where a dynamic import of a computed-or-not path is exactly the failure
// class main.ts's own header warns about -- and no gate in this repo exercises a nested `workflow()`
// through the compiled binary, so that leg would have been unproven as well as fragile.
import { mkdirSync, readFileSync } from "node:fs";
import { RunJournal, promptKey, type JournalEntry } from "./journal.ts";
import { RunTranscript, capTranscriptField, renderTranscriptValue } from "./transcript.ts";
import { WorkflowRegistry } from "./registry.ts";
import { makeSemaphore, resolveConcurrencyCap, type Semaphore } from "./semaphore.ts";
import { createBudget, type WorkflowBudget } from "./budget.ts";
import { buildWorkerSpawn, resolveWorkerCommand, workflowSandboxAvailable, type WorkerCommand } from "./sandbox.ts";
import { persistWorkflowScript, workflowTranscriptDir, workflowRunsDir, resolveWorkflowByName } from "./store.ts";
import { encodeNdjson, splitNdjson, type BridgeRequest, type BridgeResponse, type WorkerInit, type WorkflowRef } from "./bridge.ts";
import type { WorkflowSessionRuntime } from "./host-registry.ts";
import { matchPhaseGroup, type WorkflowMeta, type WorkflowMetaPhase } from "./meta.ts";
import type { AgentOpts, WorkflowRunView, WorkflowStatus } from "./types.ts";
import type { WorkflowRunHost, WorkflowTaskHandle } from "./seam.ts";
import type { RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import type { ChildHandle, SpawnChildRequest } from "../subagents/child-handle.ts";
import type { JsonSchema } from "../structured/seam.ts";

/** WS-11 §1.6's own three numbers, in one place so nothing re-derives them. */
export const TOTAL_AGENTS_PER_RUN = 1000;
export const MAX_ITEMS_PER_CALL = 4096;

/** A typed launch/resume refusal -- `code` so a tool executor can render each case differently without matching on message text. */
export class WorkflowRuntimeError extends Error {
  constructor(
    readonly code: "unknown-run" | "cross-session" | "not-stopped" | "sandbox-unavailable" | "no-source",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRuntimeError";
  }
}

// --- The spawn seam --------------------------------------------------------------------------------
//
// A tiny structural interface rather than `ChildProcess` directly, so `worker-harness.ts` can hand
// back an IN-PROCESS worker (the real `workflowWorkerMain` over a PassThrough pair) and the whole
// lifecycle can be exercised without a fork. The production implementation below is the real thing.

export interface WorkerProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  pid?: number;
  onExit(cb: (code: number | null) => void): void;
  onError(cb: (err: Error) => void): void;
  kill(): void;
}

export type WorkerSpawner = (command: WorkerCommand, opts: { home?: string }) => WorkerProcess;

/**
 * The production spawner: `sandbox-exec -p <profile> <worker>`, its own process-group leader.
 *
 * `sandbox: false` spawns the worker DIRECTLY, with no seatbelt. It exists for exactly one caller --
 * `scripts/verify-workflow.ts` on a host that has no `/usr/bin/sandbox-exec` (the linux CI runner),
 * where that gate's subject is the COMPILED ARGV DISPATCH and refusing to run at all would leave that
 * leg unverified. It is NOT a production posture and nothing in the runtime reaches it: `launch`
 * refuses outright when the sandbox is required and unavailable, and the seatbelt's own claims are
 * proved separately in `workflows/worker.darwin.test.ts`.
 */
export function realWorkerSpawner(opts: { sandbox?: boolean } = {}): WorkerSpawner {
  const sandbox = opts.sandbox ?? true;
  return (command, spawnOpts) => {
    const spawnTarget = sandbox
      ? buildWorkerSpawn({ command, ...(spawnOpts.home !== undefined ? { home: spawnOpts.home } : {}) })
      : command;
    const child = spawnProcess(spawnTarget.file, spawnTarget.args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      onExit: (cb) => child.on("close", (code) => cb(code)),
      onError: (cb) => child.on("error", cb),
      kill: () => {
        // WS-12 §5.2's process-group kill: `detached: true` made the child its own group leader, so
        // the negative pid reaps sandbox-exec AND the worker together. Falls back to a direct kill.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      },
    };
  };
}

// --- Deps ------------------------------------------------------------------------------------------

export interface WorkflowRuntimeDeps {
  session: WorkflowSessionRuntime;
  caps?: { concurrency?: number; totalAgents?: number; maxItemsPerCall?: number };
  /** Test seam. Defaults to `realWorkerSpawner()`. */
  spawnWorker?: WorkerSpawner;
  /** Test seam over the worker COMMAND (pre-sandbox). Defaults to the compiled-vs-dev split. */
  workerCommand?: () => WorkerCommand;
  /** Overridable resolver for a nested `workflow(nameOrRef)`. Defaults to store.ts's project resolution. */
  resolveNestedWorkflow?: (ref: WorkflowRef, ctx: { cwd: string; trustedWorkspace: boolean }) => Promise<{ ok: true; source: string } | { ok: false; error: string }>;
  /** Skips the `sandbox-exec` availability refusal. Only a non-default spawner has any business setting this. */
  requireSandbox?: boolean;
}

export interface WorkflowLaunchInput {
  sessionId: string;
  cwd: string;
  trustedWorkspace: boolean;
  source: string;
  meta: Pick<WorkflowMeta, "name" | "description"> & Partial<WorkflowMeta>;
  args?: unknown;
  /**
   * The MODEL's own `tool_use` id for the Workflow call (F11). REQUIRED, and deliberately so: WS-10
   * §4 correlates a child's forwarded frames on `SpawnChildRequest.parentToolUseId`, and the previous
   * `?? run.task.taskId` fallback quietly substituted a task id -- a different id space entirely, and
   * exactly the class of fabricated-value-on-a-pinned-field that this lane already removed once from
   * `task_started.workflow_name`. The tool executor refuses the call outright when `ctx.toolUseId` is
   * absent rather than inventing one here.
   */
  parentToolUseId: string;
  /** Only `resume` supplies these; a fresh launch never does. */
  runId?: string;
  resumeJournal?: JournalEntry[];
}

export interface WorkflowLaunchResult {
  taskId: string;
  runId: string;
  /**
   * `meta.name` VERBATIM -- item (g) doc-asserts (`4061`) that `WorkflowOutput.workflowName` is
   * `meta.name` and equals `task_started.workflow_name`. It is threaded rather than recovered from
   * the persisted filename, because that filename is SANITIZED (`store.ts`'s `sanitizeFileStem`):
   * a `meta.name` of `My Workflow!` persists as `My-Workflow-<runId>.js`, so a filename-derived name
   * would silently disagree with the pin for every name outside the slug alphabet.
   */
  name: string;
  scriptPath: string;
  transcriptDir: string;
  status: WorkflowStatus;
  summary: string;
}

interface LiveRun {
  runId: string;
  sessionId: string;
  host: WorkflowRunHost;
  /** The model's own tool_use id for the launching call -- every child of this run correlates on it. */
  parentToolUseId: string;
  cwd: string;
  trustedWorkspace: boolean;
  worker: WorkerProcess;
  task: WorkflowTaskHandle;
  /** Reassembly buffer: one `data` chunk may split a line or coalesce ten. */
  stdoutCarry: string;
  running: number;
  completed: number;
  total: number;
  toolUses: number;
  startedAt: number;
  sem: Semaphore;
  budget: WorkflowBudget;
  journal: RunJournal;
  abort: AbortController;
  /** F8: the resume journal this run was SEEDED with, so a `resumed` op can copy its replayed prefix into this run's own journal. */
  seedJournal: readonly JournalEntry[];
  /** A-14: the run's own record, under the `transcriptDir` this run REPORTS. Best-effort throughout. */
  transcript: RunTranscript;
  /** The DECLARED phases (WS-11 §1.2). A `phase()` call matching one exactly resolves to it; an unmatched call gets its own group. */
  declaredPhases: readonly WorkflowMetaPhase[] | undefined;
  /** WS-11 §1.8's abort chaining: stop must cancel IN-FLIGHT bridged agents, not merely the worker process. */
  children: Set<ChildHandle>;
}

export class WorkflowRuntime {
  private readonly registry = new WorkflowRegistry();
  private readonly live = new Map<string, LiveRun>();
  private readonly settlers = new Map<string, (view: WorkflowRunView) => void>();
  /** Kept beside `live` because `finish` runs AFTER teardown deleted the LiveRun and still has to settle the task. */
  private readonly tasks = new Map<string, WorkflowTaskHandle>();
  /** A-14: same reason as `tasks` -- the terminal record is written after the LiveRun is gone. */
  private readonly transcripts = new Map<string, RunTranscript>();
  /** Each run's source + launch context, so `resume` can replay it verbatim. Never pruned -- one string per run this session launched. */
  private readonly launches = new Map<string, WorkflowLaunchInput & { scriptPath: string }>();
  private readonly runsDir: string;
  private readonly concurrency: number;
  private readonly totalAgents: number;
  private readonly maxItemsPerCall: number;
  private readonly spawnWorker: WorkerSpawner;

  constructor(private readonly deps: WorkflowRuntimeDeps) {
    this.runsDir = workflowRunsDir(deps.session.sessionTempDir);
    this.concurrency = deps.caps?.concurrency ?? resolveConcurrencyCap();
    this.totalAgents = deps.caps?.totalAgents ?? TOTAL_AGENTS_PER_RUN;
    this.maxItemsPerCall = deps.caps?.maxItemsPerCall ?? MAX_ITEMS_PER_CALL;
    this.spawnWorker = deps.spawnWorker ?? realWorkerSpawner();
  }

  launch(input: WorkflowLaunchInput, host: WorkflowRunHost): WorkflowLaunchResult {
    // The sandbox refusal is checked BEFORE anything is created, so a host without `sandbox-exec`
    // gets a clean error instead of a half-registered run. Only an injected spawner skips it -- and
    // then only because that spawner is, by construction, not forking anything.
    const needsSandbox = this.deps.requireSandbox ?? this.deps.spawnWorker === undefined;
    if (needsSandbox && !workflowSandboxAvailable()) {
      throw new WorkflowRuntimeError("sandbox-unavailable", "workflows are unavailable: /usr/bin/sandbox-exec was not found, and a workflow worker is never run unsandboxed (WS-12 §3)");
    }

    const runId = input.runId ?? `wf_${randomBytes(6).toString("hex")}`;
    const location = { winterHome: this.deps.session.winterHome, projectKey: this.deps.session.projectKey, sessionId: input.sessionId };
    // Persisted BEFORE the worker starts, so the path in the tool result is real the moment the model
    // reads it -- WS-11 §1.3's edit-then-rerun loop begins with the model editing this exact file.
    const scriptPath = persistWorkflowScript({ ...location, name: input.meta.name, runId, source: input.source });
    // CREATED, not merely computed: `WorkflowOutput.transcriptDir` is handed to the model, and a
    // model that reads a path which does not exist gets ENOENT rather than an empty directory.
    //
    // A-14 (fix wave): it is no longer EMPTY either. The run's own transcript is written here --
    // launch, every `agent()` call and its outcome, phase changes, terminal state (transcript.ts).
    // Winter's CHILD transcripts are still written wherever `subagents/child-engine.ts` puts them
    // (another lane's file), which is the standing disclosure; this is the run's record, not theirs.
    const transcriptDir = workflowTranscriptDir({ ...location, runId });
    mkdirSync(transcriptDir, { recursive: true, mode: 0o700 });
    const transcript = new RunTranscript(transcriptDir);
    transcript.append({
      kind: "launch",
      runId,
      name: input.meta.name,
      scriptPath,
      ...(input.args !== undefined ? { args: renderTranscriptValue(input.args) } : {}),
      ...(input.resumeJournal !== undefined ? { replayed: input.resumeJournal.length } : {}),
    });
    this.launches.set(runId, { ...input, runId, scriptPath });

    const task = host.createTask("workflow", { runId, name: input.meta.name });
    const abort = new AbortController();
    this.registry.register({ runId, sessionId: input.sessionId, taskId: task.taskId, name: input.meta.name, abort });

    const command = this.deps.workerCommand?.() ?? resolveWorkerCommand();
    // T3's Lane W item 2: `home` MUST be passed, or the `~/.winter/run` read-deny is silently absent.
    // `winterHome` is the `.winter` directory itself, and the profile appends `.winter/run` to what it
    // is given -- so the value handed over is that directory's PARENT.
    const worker = this.spawnWorker(command, { home: parentOf(this.deps.session.winterHome) });

    const run: LiveRun = {
      runId,
      sessionId: input.sessionId,
      host,
      parentToolUseId: input.parentToolUseId,
      cwd: input.cwd,
      trustedWorkspace: input.trustedWorkspace,
      worker,
      task,
      stdoutCarry: "",
      running: 0,
      completed: 0,
      total: 0,
      toolUses: 0,
      startedAt: Date.now(),
      sem: makeSemaphore(this.concurrency),
      budget: createBudget({
        ...(this.deps.session.spentTokens !== undefined ? { spentTokens: this.deps.session.spentTokens } : {}),
        ...(this.deps.session.budgetTotal !== undefined ? { total: this.deps.session.budgetTotal } : {}),
      }),
      journal: new RunJournal(this.runsDir, runId),
      seedJournal: input.resumeJournal ?? [],
      transcript,
      abort,
      ...(input.meta.phases !== undefined ? { declaredPhases: input.meta.phases } : { declaredPhases: undefined }),
      children: new Set(),
    };
    this.live.set(runId, run);
    this.tasks.set(runId, task);
    this.transcripts.set(runId, transcript);

    abort.signal.addEventListener("abort", () => {
      // WS-11 §1.8: "stop/abort cancels in-flight bridged agents (abort chaining), not merely the
      // worker process." `SpawnChildRequest` carries no signal (P4's frozen seam), so the chaining is
      // done by holding every live handle and stopping each -- which is the same effect through the
      // one cancellation surface a ChildHandle actually exposes.
      for (const child of run.children) void child.stop().catch(() => {});
      run.children.clear();
      this.teardown(runId, () => this.finish(runId, "stopped"));
    });

    worker.stdout.on("data", (chunk: Buffer | string) => {
      run.stdoutCarry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const { lines, rest } = splitNdjson(run.stdoutCarry);
      run.stdoutCarry = rest;
      for (const line of lines) {
        let message: BridgeRequest;
        try {
          message = JSON.parse(line) as BridgeRequest;
        } catch {
          continue; // a non-frame line cannot be acted on; the worker writes diagnostics to stderr
        }
        void this.onWorkerMessage(run, message);
      }
    });

    // WS-11 §1.8's crash fallback: "a worker that exits without a terminal bridge message fails the
    // run, never hangs the awaiting caller." Guarded on `live.has` because a normal done/error/stop
    // already tore the run down and its terminal status must not be overwritten by the exit.
    worker.onExit((code) => {
      if (this.live.has(runId)) {
        this.teardown(runId, () => this.finish(runId, "failed", `the workflow worker exited (code ${code ?? "signal"}) without reporting a result`));
      }
    });
    worker.onError((err) => {
      if (this.live.has(runId)) {
        this.teardown(runId, () => this.finish(runId, "failed", `the workflow worker failed to spawn: ${err.message}`));
      }
    });

    const init: WorkerInit = {
      runId,
      source: input.source,
      args: input.args,
      concurrency: this.concurrency,
      totalAgentCap: this.totalAgents,
      maxItemsPerCall: this.maxItemsPerCall,
      budget: run.budget.snapshot(),
      ...(input.resumeJournal !== undefined ? { resumeJournal: input.resumeJournal } : {}),
    };
    run.worker.stdin.write(encodeNdjson(init));

    return { taskId: task.taskId, runId, name: input.meta.name, scriptPath, transcriptDir, status: "running", summary: summarize(input.meta) };
  }

  /**
   * WS-11 §1.5: a same-session resume of a STOPPED run, replaying its journal.
   *
   * Both preconditions are the pin's own (`sdk-tools.d.ts:2786`: "same-session only, with the prior
   * run stopped first via TaskStop") and both are typed refusals rather than silent no-ops -- this
   * launches a subprocess, so a typo'd runId failing loudly is worth more than a quiet nothing.
   * `sessionId` is taken from the CALLER, never from the input, so a run cannot be resumed into a
   * session that did not own it.
   *
   * RULING I6 (fix wave) -- `opts.replacement` / `opts.args`: a resume that supplies a NEW source
   * (the model edited the persisted script between the stop and the resume, which is exactly what
   * WS-11 §1.3's loop tells it to do) runs the NEW source against the OLD journal. The positional
   * replay then diverges at the first changed call and everything from there runs live, which is
   * §1.5's own contract. This used to rebuild the launch from `this.launches` unconditionally, so a
   * `{scriptPath: <edited>, resumeFromRunId}` call silently re-ran the PRIOR source and a changed
   * `args` was dropped -- the edit loop's own door was the one input the door ignored. With neither
   * supplied, the original launch input is replayed verbatim (the ruling's other half).
   */
  resume(
    runId: string,
    sessionId: string,
    host: WorkflowRunHost,
    opts: {
      parentToolUseId?: string;
      /**
       * The edited script AND its re-parsed meta, together: `meta.name` is what the new run's task,
       * persisted filename and `WorkflowOutput.workflowName` are built from, so carrying the source
       * without re-parsing the meta would label the edited run with the old script's name.
       */
      replacement?: { source: string; meta: WorkflowLaunchInput["meta"] };
      /** Supplied = the new args; OMITTED = the original launch's args, unchanged. */
      args?: unknown;
    } = {},
  ): WorkflowLaunchResult {
    const prior = this.registry.get(runId);
    if (prior === undefined) throw new WorkflowRuntimeError("unknown-run", `unknown workflow run "${runId}"`);
    if (prior.sessionId !== sessionId) {
      throw new WorkflowRuntimeError("cross-session", `workflow run "${runId}" belongs to another session -- resumeFromRunId is same session only`);
    }
    if (prior.status !== "stopped") {
      throw new WorkflowRuntimeError("not-stopped", `workflow run "${runId}" is ${prior.status}; resumeFromRunId requires the prior run to have been stopped first (TaskStop)`);
    }
    const original = this.launches.get(runId);
    if (original === undefined) throw new WorkflowRuntimeError("no-source", `no source is recorded for workflow run "${runId}"`);
    const journal = new RunJournal(this.runsDir, runId).load();
    // A FRESH runId: the prior run is terminal and its own journal is what seeds this one. Reusing
    // the id would make the two runs indistinguishable in the registry and would have the new run
    // append to the journal it is replaying.
    const { runId: _priorId, resumeJournal: _priorJournal, ...rest } = original;
    // The RESUMING call's tool_use id, not the original launch's. WS-10 §4 correlates a child's
    // forwarded frames by `parentToolUseId`, and replaying the prior run's would point every child of
    // the resumed run at a `tool_use` block from an earlier turn -- which the host cannot match.
    return this.launch(
      {
        ...rest,
        // I6: the NEW source/meta and the NEW args win over the recorded launch; absent, the
        // recorded ones stand. `"args" in opts` rather than `!== undefined`, so a caller of THIS
        // method can clear args by passing `args: undefined` explicitly. The tool executor cannot
        // express that (it conditional-spreads on `!== undefined`, matching the launch path), so
        // through `Workflow` the rule is simply "args given = args replaced".
        ...(opts.replacement !== undefined ? { source: opts.replacement.source, meta: opts.replacement.meta } : {}),
        ...("args" in opts ? { args: opts.args } : {}),
        ...(opts.parentToolUseId !== undefined ? { parentToolUseId: opts.parentToolUseId } : {}),
        ...(journal.length > 0 ? { resumeJournal: journal } : {}),
      },
      host,
    );
  }

  stop(runId: string): boolean {
    return this.registry.stop(runId);
  }

  get(runId: string): WorkflowRunView | undefined {
    return this.registry.get(runId);
  }

  list(sessionId: string): WorkflowRunView[] {
    return this.registry.list(sessionId);
  }

  /** Resolves when the run reaches a terminal state. An already-terminal or unknown run resolves immediately. */
  await(runId: string): Promise<WorkflowRunView> {
    const current = this.registry.get(runId);
    if (current !== undefined && current.status !== "running") return Promise.resolve(current);
    if (!this.live.has(runId) && current === undefined) {
      return Promise.resolve({ runId, sessionId: "", taskId: "", name: "", status: "failed", counts: { running: 0, completed: 0, total: 0 }, startedAt: 0, error: "unknown run" });
    }
    return new Promise<WorkflowRunView>((resolve) => {
      const existing = this.settlers.get(runId);
      this.settlers.set(runId, (view) => {
        existing?.(view);
        resolve(view);
      });
    });
  }

  /**
   * Whether a run reached `stopped` (as opposed to `failed`). The frozen `WorkflowTaskHandle` has no
   * `stop()`, so this is how a host renders the third terminal state truthfully -- see
   * `tools/impl/workflow.ts`'s `fail` implementation.
   */
  wasStopped(runId: string): boolean {
    return this.registry.get(runId)?.status === "stopped";
  }

  /** Test-only: simulates an external kill, for the crash-fallback path. */
  killWorkerForTest(runId: string): void {
    this.live.get(runId)?.worker.kill();
  }

  // --- The bridge service loop --------------------------------------------------------------------

  private async onWorkerMessage(run: LiveRun, message: BridgeRequest): Promise<void> {
    switch (message.op) {
      case "phase": {
        // WS-11 §1.2's matching rule, applied at the one moment it applies -- when a `phase()` call
        // actually arrives. A title matching a DECLARED `meta.phases` entry resolves to that entry
        // (and its `detail` is what the progress line carries, since the declaration is the richer
        // description); an unmatched call gets its OWN group rather than being dropped or folded into
        // the previous one.
        //
        // CLOSED AT THE SEAM by Phase 5 Task 8 (rider 27): `WorkflowProgress` carries `phase` and
        // `declaredPhase` now, so a host consuming the seam can tell a declared group from an ad-hoc
        // one structurally rather than by parsing the progress text -- which never distinguished
        // them reliably anyway (a declared phase with no `detail` renders exactly like an ad-hoc
        // one). The WIRE half stays open: the pinned `task_progress` frame has no phase field. See
        // `WorkflowProgress.phase`'s own header.
        const group = matchPhaseGroup(run.declaredPhases, message.title);
        this.registry.setPhase(run.runId, group.title);
        run.transcript.append({ kind: "phase", title: group.title, declared: group.declared });
        this.emitProgress(run, group.declared && group.detail !== undefined ? `${group.title}: ${group.detail}` : group.title, { phase: group.title, declaredPhase: group.declared });
        break;
      }
      case "log":
        this.emitProgress(run, message.message);
        break;
      case "resumed": {
        // F8: the worker replayed `cachedPrefix` calls from the seed journal and never told the
        // bridge about them (a cached call short-circuits in-worker by design). Copy exactly that
        // prefix into THIS run's journal, before any live append, so a resume-of-a-resume replays
        // them too. Bounded by the seed's own length -- a worker claiming more than it was given is
        // ignored rather than trusted.
        const count = Math.max(0, Math.min(Math.floor(message.cachedPrefix), run.seedJournal.length));
        for (let i = 0; i < count; i++) {
          const entry = run.seedJournal[i]!;
          run.journal.append(entry.promptKey, entry.value);
        }
        break;
      }
      case "agent": {
        const response = await this.serviceAgent(run, message);
        this.reply(run, response);
        break;
      }
      case "workflow": {
        const response = await this.serviceNestedWorkflow(run, message);
        this.reply(run, response);
        break;
      }
      case "done":
        this.teardown(run.runId, () => this.finish(run.runId, "completed", renderResult(message.result)));
        break;
      case "error":
        this.teardown(run.runId, () => this.finish(run.runId, "failed", message.message));
        break;
    }
  }

  private reply(run: LiveRun, response: BridgeResponse): void {
    // The run may already be torn down (stopped, or the worker died) by the time an agent resolves.
    if (this.live.has(run.runId)) run.worker.stdin.write(encodeNdjson(response));
  }

  /**
   * The authoritative half of every cap. Checked in this order, deliberately:
   *   1. the TOTAL cap, before the semaphore -- a run pinned at capacity must fail fast rather than
   *      queue behind work that can never help it (Norma's original ordering, kept);
   *   2. the BUDGET ceiling, for the same reason;
   *   3. only then a slot.
   */
  private async serviceAgent(run: LiveRun, message: Extract<BridgeRequest, { op: "agent" }>): Promise<BridgeResponse> {
    if (run.total >= this.totalAgents) {
      const error = `workflow exceeded the per-run agent cap (${this.totalAgents}) -- ${run.completed} completed before the stop`;
      this.teardown(run.runId, () => this.finish(run.runId, "failed", error));
      return { callId: message.callId, ok: false, error };
    }
    if (run.budget.exceeded()) {
      const error = `workflow budget exhausted: ${run.budget.spent()} of ${run.budget.total} tokens spent -- further agent() calls are refused (WS-11 §1.6)`;
      this.teardown(run.runId, () => this.finish(run.runId, "failed", error));
      return { callId: message.callId, ok: false, error, budget: run.budget.snapshot() };
    }

    await run.sem.acquire();
    run.running++;
    run.total++;
    run.toolUses++;
    // The agent's OWN group, never the ambient one -- see syncCounts.
    const group = message.opts?.phase;
    this.syncCounts(run, group);
    try {
      const spawned = await this.spawnAndAwaitChild(run, message.prompt, message.opts);
      if (!spawned.ok) {
        // m5: the HOST could not start an agent -- the same unswallowable class as the caps above,
        // and handled the same way: the run fails parent-side with the host's own message, and the
        // script sees `ok:false` (which `script-api.ts` throws) rather than a null it can filter out.
        run.transcript.append({ kind: "agent", prompt: capTranscriptField(message.prompt), outcome: "refused", ...(group !== undefined ? { phase: group } : {}) });
        this.teardown(run.runId, () => this.finish(run.runId, "failed", spawned.error));
        return { callId: message.callId, ok: false, error: spawned.error, budget: run.budget.snapshot() };
      }
      const outcome = spawned.value;
      // WS-11 §1.5: only SUCCESSFUL results are journaled -- a failed call has nothing worth caching,
      // and a later resume should retry it live rather than replay the failure.
      if (outcome !== null) run.journal.append(promptKey(message.prompt, message.opts), outcome);
      // A-14: the TRANSCRIPT records the null ones too. That asymmetry is the point -- the journal is
      // a resume cache and a run whose agents all came back null leaves it empty, which is exactly
      // the case WS-11 §1.8's "first diagnostic surface for empty results" is about.
      run.transcript.agent({
        prompt: message.prompt,
        value: outcome,
        resolvedNull: outcome === null,
        ...(group !== undefined ? { phase: group } : {}),
        ...(message.opts?.label !== undefined ? { label: message.opts.label } : {}),
      });
      return { callId: message.callId, ok: true, value: outcome, budget: run.budget.snapshot() };
    } finally {
      run.running--;
      run.completed++;
      run.sem.release(); // released FIRST -- never blocked behind a possibly-throwing emit
      this.syncCounts(run, group);
    }
  }

  /**
   * Spawns one child and resolves what `agent()` should see.
   *
   * NULL, not a throw, for every terminal child OUTCOME (WS-11 §1.6: "Resolves `null` when the user
   * skips the agent or it dies on a terminal error") -- a failed child, a stopped child, a child
   * whose text does not validate.
   *
   * A `spawnAgent` that THROWS is NOT one of those (whole-branch m5). It means the HOST could not
   * start an agent at all -- `tools/impl/workflow.ts` throws exactly that when the session has no
   * child-spawn capability -- and `script-api.ts`'s own contract lists "no spawn capability at all"
   * beside the agent cap and the budget ceiling as the refusals a script must not be able to
   * swallow. This used to fold it into the same `null`, so a workflow in a session with no spawn
   * capability "completed" with `.filter(Boolean)`-swallowed empties and the real cause appeared
   * nowhere. It now comes back as a refusal, which `serviceAgent` turns into the same
   * teardown-then-`ok:false` the caps use. Nothing escapes as an unhandled rejection either way.
   */
  private async spawnAndAwaitChild(run: LiveRun, prompt: string, opts: AgentOpts | undefined): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    let child: ChildHandle;
    try {
      child = await run.host.spawnAgent(this.buildSpawnRequest(run, prompt, opts));
    } catch (err) {
      return { ok: false, error: `workflow agent could not be started: ${err instanceof Error ? err.message : String(err)}` };
    }
    run.children.add(child);
    try {
      const result = await child.result();
      if (result.status !== "completed") return { ok: true, value: null };
      if (opts?.schema === undefined) return { ok: true, value: result.content };
      return { ok: true, value: this.validateStructured(opts.schema as JsonSchema, result.content) };
    } catch {
      return { ok: true, value: null };
    } finally {
      run.children.delete(child);
    }
  }

  /**
   * `agent({schema})` rides `SpawnChildRequest.outputFormat` (T3's Lane W item 5) -- the child is put
   * on the identical `StructuredOutput` mechanism the top-level session uses, never a second one.
   *
   * DISCLOSED GAP (report NEEDS_CONTEXT): `ChildResult` carries only `content: string`, and
   * `child-engine.ts`'s own `observe` reads `message.result` -- which the engine's structured SUCCESS
   * variant does not set (engine.ts's `finalResult` carries `structured_output` and no `result`). So
   * the validated object never reaches the parent through the P4 seam. This parses the child's text
   * and re-validates it through `host.structured` -- the same validator, so no second opinion is
   * introduced -- and resolves NULL when there is nothing valid to return, which is the "died on a
   * terminal error" arm of the same rule. `subagents/**` is frozen to this lane; the real fix is a
   * `ChildResult.structuredOutput` field.
   */
  private validateStructured(schema: JsonSchema, content: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const validation = this.deps.session.structured.validate(schema, parsed);
    return validation.ok ? validation.value : null;
  }

  private buildSpawnRequest(run: LiveRun, prompt: string, opts: AgentOpts | undefined): SpawnChildRequest {
    const definition = this.resolveChildDefinition(run, opts);
    return {
      parentToolUseId: run.parentToolUseId,
      prompt,
      runInBackground: false,
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.isolation !== undefined ? { isolation: opts.isolation } : {}),
      ...(opts?.label !== undefined ? { name: opts.label } : {}),
      ...(definition !== undefined ? { definition } : {}),
      ...(opts?.schema !== undefined ? { outputFormat: { type: "json_schema" as const, schema: opts.schema as Record<string, unknown> } } : {}),
    };
  }

  /**
   * `agentType` and `effort` BOTH arrive as the child's DEFINITION, because that is the only route
   * either has: `SpawnChildRequest` carries `definition` and no `effort` at all, and engine.ts's own
   * `buildChildInheritance` reads effort exclusively from `req.definition?.effort` (engine.ts:1236,
   * whose comment says so outright: "AgentInput/SpawnChildRequest carry no effort field at all").
   *
   * With `effort` and no `agentType`, a MINIMAL definition is synthesized. That is safe rather than
   * clever: `buildChildInheritance`'s base for a bare child is already `systemPrompt: ""`, an absent
   * `tools` inherits the parent's whole advertised pool, and an absent `permissionMode` changes
   * nothing -- so the synthesized definition differs from a bare child in exactly the one field it
   * exists to carry.
   */
  private resolveChildDefinition(run: LiveRun, opts: AgentOpts | undefined): RuntimeAgentDefinition | undefined {
    if (opts?.agentType === undefined && opts?.effort === undefined) return undefined;
    let base: RuntimeAgentDefinition | undefined;
    if (opts.agentType !== undefined) {
      base = this.deps.session.resolveAgentType?.(opts.agentType, { cwd: run.cwd, trustedWorkspace: run.trustedWorkspace });
      if (base === undefined) {
        // An unresolvable agentType is NOT silently downgraded to a bare child: a script that asked
        // for a reviewer and got a generic agent would produce plausible-looking wrong work. The
        // synthesized description records what was asked for so the failure is legible downstream.
        base = { description: `workflow agent type "${opts.agentType}" (unresolved)`, prompt: "" };
      }
    }
    const definition: RuntimeAgentDefinition = base ?? { description: "workflow agent", prompt: "" };
    return opts.effort !== undefined ? { ...definition, effort: opts.effort } : definition;
  }

  /** A nested `workflow(nameOrRef)`: resolved PARENT-side, because the worker can read no files. */
  private async serviceNestedWorkflow(run: LiveRun, message: Extract<BridgeRequest, { op: "workflow" }>): Promise<BridgeResponse> {
    const resolver = this.deps.resolveNestedWorkflow ?? defaultNestedResolver;
    let resolved: { ok: true; source: string } | { ok: false; error: string };
    try {
      resolved = await resolver(message.ref, { cwd: run.cwd, trustedWorkspace: run.trustedWorkspace });
    } catch (err) {
      resolved = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return resolved.ok
      ? { callId: message.callId, ok: true, value: { source: resolved.source } }
      : { callId: message.callId, ok: false, error: resolved.error };
  }

  // --- Progress and lifecycle ---------------------------------------------------------------------

  /**
   * `phase` is the group this progress report belongs to (F2): an agent's own `opts.phase` when it
   * supplied one, otherwise the run's current global phase. Passing it explicitly is the whole point
   * -- WS-11 §1.6 gives `opts.phase` the job of "avoiding races on the global `phase()` state inside
   * `pipeline`/`parallel` stages", and reading the ambient phase here would reintroduce exactly that
   * race for two agents running concurrently under different phases.
   */
  private syncCounts(run: LiveRun, phase?: string): void {
    if (!this.live.has(run.runId)) return; // never touch counts for an already-torn-down run
    this.registry.setCounts(run.runId, { running: run.running, completed: run.completed, total: run.total });
    const group = phase ?? this.registry.get(run.runId)?.phase;
    // Rider 27: the group travels STRUCTURALLY as well as in the text. `declaredPhase` is
    // deliberately omitted here rather than guessed -- this path reports a COUNT change (an agent
    // started or finished) under whatever group is current, and whether that group was declared is
    // a fact about the `phase()` call that established it, recorded at that call site above.
    this.emitProgress(run, group, group !== undefined ? { phase: group } : undefined);
  }

  /**
   * `usage` is filled on EVERY progress report, not just where it is convenient. `WorkflowProgress`
   * types it optional, but the pinned `task_progress` message it lands on makes the triple REQUIRED
   * (frames.ts) -- so a host mapping this to the wire would otherwise have to invent the numbers.
   * All three are real readings: tokens from the session accountant, `tool_uses` from this run's own
   * agent count, `duration_ms` from the parent's wall clock (the worker has no clock -- `Date.now` is
   * withheld inside it by design).
   */
  private emitProgress(run: LiveRun, summary?: string, group?: { phase?: string; declaredPhase?: boolean }): void {
    run.task.emit({
      running: run.running,
      completed: run.completed,
      total: run.total,
      ...(summary !== undefined ? { summary } : {}),
      ...(group?.phase !== undefined ? { phase: group.phase } : {}),
      ...(group?.declaredPhase !== undefined ? { declaredPhase: group.declaredPhase } : {}),
      usage: {
        total_tokens: this.deps.session.accountant.contextTokens(),
        tool_uses: run.toolUses,
        duration_ms: Date.now() - run.startedAt,
      },
    });
  }

  private teardown(runId: string, then: () => void): void {
    const run = this.live.get(runId);
    if (run === undefined) return;
    this.live.delete(runId);
    for (const child of run.children) void child.stop().catch(() => {});
    run.children.clear();
    run.worker.kill();
    then();
  }

  private finish(runId: string, status: "completed" | "failed" | "stopped", detail?: string): void {
    // A-14: written FIRST, before the seam calls below -- a throwing host callback must not be able
    // to leave the run's own record without a terminal line.
    const transcript = this.transcripts.get(runId);
    if (transcript !== undefined) {
      transcript.finish(status, detail);
      this.transcripts.delete(runId);
    }
    if (status === "completed") this.registry.complete(runId, { ok: true, result: detail ?? "" });
    else if (status === "failed") this.registry.fail(runId, detail ?? "error");
    // "stopped" was already set by `registry.stop()` before the abort fired -- see registry.ts.

    const view = this.registry.get(runId);
    const task = this.tasks.get(runId);
    if (task !== undefined) {
      // WS-11 §1.8 makes `stopped` its own terminal state, distinct from `failed`, and the pinned
      // `task_notification.status` union carries all three. The frozen `WorkflowTaskHandle` has only
      // `complete`/`fail` (no `stop`), so the DISTINCTION is carried out of band: the host's `fail`
      // implementation consults `wasStopped(runId)` -- see tools/impl/workflow.ts. Without it a user
      // pressing stop would be told on the wire that their workflow crashed.
      // Terminal seam calls are one-way and idempotent (seam.ts), so a late crash after a reported
      // completion cannot re-fail the task -- but the mapping is still made explicitly here rather
      // than relying on that guard alone.
      if (view?.status === "completed") task.complete(view.result ?? "");
      else task.fail(view?.error ?? `workflow ${view?.status ?? status}`);
      this.tasks.delete(runId);
    }
    if (view !== undefined) this.settlers.get(runId)?.(view);
    this.settlers.delete(runId);
  }

}

async function defaultNestedResolver(ref: WorkflowRef, ctx: { cwd: string; trustedWorkspace: boolean }): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
  if ("name" in ref) {
    const resolved = resolveWorkflowByName(ref.name, { cwd: ctx.cwd, trustedWorkspace: ctx.trustedWorkspace });
    return resolved.ok ? { ok: true, source: resolved.source } : { ok: false, error: resolved.error };
  }
  try {
    return { ok: true, source: readFileSync(ref.scriptPath, "utf8") };
  } catch (err) {
    return { ok: false, error: `unreadable workflow script ${JSON.stringify(ref.scriptPath)}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The model-facing one-liner: `meta.description`, which WS-11 §1.2 makes required for exactly this. */
function summarize(meta: Pick<WorkflowMeta, "name" | "description">): string {
  return meta.description.split("\n")[0]?.slice(0, 200) ?? meta.name;
}

/** A string result passes through; anything else is JSON, so the model always receives text. */
function renderResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}
