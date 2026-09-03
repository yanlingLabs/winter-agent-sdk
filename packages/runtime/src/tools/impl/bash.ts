// Task 3 (Lane C): the Bash tool executor (WS-06 §3.2, WS-12 §6). Wires the sandbox mechanism
// (../../sandbox/{profile,spawn}.ts) behind the pinned Bash contract: fresh shell per call, env
// non-persistence, cwd-carry within allowed dirs only, TMPDIR export, timeout defaults/ceiling,
// run_in_background -> a real background task + frames, the ~30k inline cap with persisted
// overflow, a smaller failure excerpt, and the 5 GB stream kill.
//
// Task 8 (P3 close-out, "Settings threading" MUST) closed the gaps this header used to document:
//   - `ctx.sandboxSettings` (registry.ts) now carries the session's EFFECTIVE sandbox configuration
//     (RuntimeConfig.sandbox, resolved once per run against DEFAULT_SANDBOX_SETTINGS by engine.ts)
//     -- every `settings: DEFAULT_SANDBOX_SETTINGS` call site below became `settings:
//     ctx.sandboxSettings`. A session that configures nothing behaves byte-identically to before
//     this task (engine.ts's own fallback IS DEFAULT_SANDBOX_SETTINGS).
//   - `computeWritableRoots` now unions `ctx.session.getBoundedRoots()` (the SAME "cwd or
//     additionalDirectories" notion the standing evaluator computes for acceptEdits/critical-
//     removal -- rule-derived addDirectories grants + RuntimeConfig.additionalDirectories +
//     EnterWorktree's own addBoundedRoot calls) and `ctx.outDir` (WS-12 §5.3's OUTDIR extension,
//     when the session configured one) alongside `ctx.tempDir`. "Allowed working directories" for
//     the cwd-carry policy (WS-06 §6.1) is this SAME set, no longer a documented approximation.
//   - `$OUTDIR` is now exported into the spawned shell's env alongside `$TMPDIR`, when `ctx.outDir`
//     is configured (WS-12 §5.3: "The OUTDIR export remains a Winter extension").
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, createWriteStream } from "node:fs";
import { join, sep } from "node:path";
import "../descriptors/bash.ts";
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createBackgroundTask } from "../background-tasks.ts";
import { splitCompound, extractRedirectTargets } from "../../permissions/grammar.ts";
import { emptyPathSet, type ExtractedPaths } from "../paths-seam.ts";
import {
  runCommand,
  SandboxUnavailableError,
  resolveExecutionPath,
  isSandboxAvailable,
  type RunCommandResult,
} from "../../sandbox/spawn.ts";
import { SandboxConfigError, canonicalizePath, resolveNetworkPosture } from "../../sandbox/profile.ts";
import { startTracking, setTaskStatus, getTask, listRunningTasks, toBackgroundTasksChangedEntry } from "./background-task-runtime.ts";

// ---------------------------------------------------------------------------------------------
// Input validation (no zod/validation library is a dependency of this package -- verified before
// writing this module; every tools/impl/*.ts file hand-validates its own `unknown` input).
// ---------------------------------------------------------------------------------------------

interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
}

function parseBashInput(input: unknown): BashInput | { error: string } {
  if (typeof input !== "object" || input === null) return { error: 'Bash: input must be an object' };
  const obj = input as Record<string, unknown>;
  if (typeof obj.command !== "string" || obj.command.length === 0) {
    return { error: 'Bash: "command" is required and must be a non-empty string' };
  }
  if (obj.timeout !== undefined && (typeof obj.timeout !== "number" || !Number.isFinite(obj.timeout) || obj.timeout <= 0)) {
    return { error: 'Bash: "timeout" must be a positive number of milliseconds' };
  }
  if (obj.description !== undefined && typeof obj.description !== "string") {
    return { error: 'Bash: "description" must be a string' };
  }
  if (obj.run_in_background !== undefined && typeof obj.run_in_background !== "boolean") {
    return { error: 'Bash: "run_in_background" must be a boolean' };
  }
  if (obj.dangerouslyDisableSandbox !== undefined && typeof obj.dangerouslyDisableSandbox !== "boolean") {
    return { error: 'Bash: "dangerouslyDisableSandbox" must be a boolean' };
  }
  return {
    command: obj.command,
    ...(obj.timeout !== undefined ? { timeout: obj.timeout as number } : {}),
    ...(obj.description !== undefined ? { description: obj.description as string } : {}),
    ...(obj.run_in_background !== undefined ? { run_in_background: obj.run_in_background as boolean } : {}),
    ...(obj.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: obj.dangerouslyDisableSandbox as boolean } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// WS-12 §6.2: timeouts. Default 2 min; ordinary ceiling AND the input declaration cap are the SAME
// number, 600000ms (WS-06 §3.2/WS-12 §6.2) -- the descriptor's own JSON Schema (tools/descriptors/
// bash.ts, not this lane's file) does not encode a numeric `maximum` today, so this executor
// enforces the ceiling defensively regardless of what the declaration says. Effective-bounds env
// overrides are WS-17 capture-pending (WS-12 §12 open question 3, unbranded names uncaptured) --
// not implemented here.
//
// RULING R3-6: timeout PROMOTION ("a timed-out eligible command can be moved to the background
// instead of killed," WS-12 §6.2) is explicitly NOT implemented -- a timeout always kills (spawn.ts's
// own process-group SIGKILL), full stop, regardless of the command's shape. WS-12 §12 open question
// 3 leaves "eligibility" uncaptured by any pinned behavior; this is a marker for a future WS-17
// differential capture to replace, not a guessed heuristic.
// ---------------------------------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 120_000;
const CEILING_TIMEOUT_MS = 600_000;

function resolveTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(requested, CEILING_TIMEOUT_MS);
}

// WS-12 §6.3: inline caps. FAILURE_EXCERPT_CHARS is a documented placeholder -- WS-12 §6.3 pins
// only "a smaller head/tail excerpt," not an exact size; a future WS-17 capture may pin the real
// number, same "capture-pending" posture as PARSE_LIMIT/DANGEROUS_ASSIGNMENT_NAMES in grammar.ts.
const INLINE_CAP = 30_000;
const FAILURE_EXCERPT_CHARS = 2_000;

// ---------------------------------------------------------------------------------------------
// Writable roots (Task 8, "Settings threading" MUST) -- see this file's own header.
// ---------------------------------------------------------------------------------------------
function computeWritableRoots(ctx: ToolExecutionContext): string[] {
  // `ctx.session.getBoundedRoots()` already includes `ctx.cwd` itself (evaluator.ts's own
  // boundedRoots()) -- redundant with buildSeatbeltProfile's own separate, always-writable `cwd`
  // field, but harmless: SBPL allow rules are idempotent, and de-duplicating here would need a
  // canonicalize-then-Set pass for a purely cosmetic win (a shorter generated profile), not a
  // correctness one. `ctx.outDir` is appended only when the session actually configured one (WS-12
  // §5.3's OUTDIR extension) -- an unconfigured session sees byte-identical writableRoots to before
  // this task, i.e. exactly [ctx.tempDir].
  return [ctx.tempDir, ...ctx.session.getBoundedRoots(), ...(ctx.outDir !== undefined ? [ctx.outDir] : [])];
}

function isWithinAllowedDirs(candidate: string, cwd: string, writableRoots: string[]): boolean {
  const canonicalCandidate = canonicalizePath(candidate);
  const allowed = [canonicalizePath(cwd), ...writableRoots.map(canonicalizePath)];
  return allowed.some((root) => canonicalCandidate === root || canonicalCandidate.startsWith(root + sep));
}

// Task 8 (P3 close-out, "Settings threading" MUST; WS-12 §6.1/§5.3): the child env every spawn
// (foreground + background) exports -- `TMPDIR` always (the session scratch dir, pre-existing), plus
// `OUTDIR` when the session configured one. A session with no `ctx.outDir` gets a child env
// byte-identical to before this task.
function buildChildEnv(ctx: ToolExecutionContext): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: ctx.tempDir, ...(ctx.outDir !== undefined ? { OUTDIR: ctx.outDir } : {}) };
}

// ---------------------------------------------------------------------------------------------
// cwd-carry (WS-06 §6.1): "Main-session cwd changes carry to later calls only within allowed
// working directories." The child's own `pwd` is captured to a scratch file appended AFTER the
// user's script (never parsed from stdout, which the model already reads verbatim) -- best-effort
// and non-fatal throughout: a missing/unreadable capture file (the user's own script called `exit`
// early, or was itself a malformed/incomplete bash script whose parse never reaches these trailing
// lines) simply means no cwd carries, never a tool error.
// ---------------------------------------------------------------------------------------------
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// FIXED (Task 8, "excludedCommands raw-match" MUST) -- was a LATENT TRAP: `runForeground` passes
// THIS wrapped script (not the model's raw `input.command`) as `RunCommandOptions.command`, so a
// naive `resolveExecutionPath` match against `command` would compare `excludedCommands` entries to
// the pwd-capture wrapper, never the raw command the model wrote or the settings author configured.
// `runCommand` now takes a SEPARATE `matchCommand` (spawn.ts's own field, defaulting to `command`
// when omitted) precisely for this: `runForeground` below passes `matchCommand: input.command` (the
// raw string) while still spawning the wrapped script, so `excludedCommands` matches what it was
// always meant to match, on both the foreground AND background (`runBackground`, which never wrapped
// its command to begin with, and therefore needs no `matchCommand` override) paths alike.
function buildPwdCaptureScript(command: string, pwdFile: string): string {
  return `${command}\n__winter_bash_rc=$?\npwd > ${shQuote(pwdFile)} 2>/dev/null\nexit "$__winter_bash_rc"\n`;
}

function carryCwdIfAllowed(pwdFile: string, ctx: ToolExecutionContext, writableRoots: string[]): void {
  let finalCwd: string;
  try {
    finalCwd = readFileSync(pwdFile, "utf8").trim();
  } catch {
    return;
  }
  if (!finalCwd) return;
  if (isWithinAllowedDirs(finalCwd, ctx.cwd, writableRoots) && canonicalizePath(finalCwd) !== canonicalizePath(ctx.cwd)) {
    ctx.session.setCwd(canonicalizePath(finalCwd));
  }
}

function cleanupPwdFile(pwdFile: string): void {
  try {
    unlinkSync(pwdFile);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------------------------
// Output capping (WS-12 §6.3): success gets a straight ~30k cap; a failure gets a SMALLER
// head/tail excerpt instead of the full persisted body. Persistence (for foreground overflow only
// -- a background task already has its own `.output` file via createBackgroundTask) lands under
// `<tempDir>/bash-output/`, lazily created.
// ---------------------------------------------------------------------------------------------
interface CappedOutput {
  text: string;
  persistedPath?: string;
}

function persistOverflowOutput(ctx: ToolExecutionContext, stream: "stdout" | "stderr", text: string): string {
  const dir = join(ctx.tempDir, "bash-output");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${randomUUID()}-${stream}.txt`);
  writeFileSync(filePath, text, "utf8");
  return filePath;
}

function capOutput(ctx: ToolExecutionContext, stream: "stdout" | "stderr", raw: string, success: boolean): CappedOutput {
  if (raw.length === 0) return { text: "" };
  if (success) {
    if (raw.length <= INLINE_CAP) return { text: raw };
    return { text: raw.slice(0, INLINE_CAP), persistedPath: persistOverflowOutput(ctx, stream, raw) };
  }
  if (raw.length <= FAILURE_EXCERPT_CHARS * 2) return { text: raw };
  const persistedPath = persistOverflowOutput(ctx, stream, raw);
  const head = raw.slice(0, FAILURE_EXCERPT_CHARS);
  const tail = raw.slice(-FAILURE_EXCERPT_CHARS);
  return { text: `${head}\n... [excerpt -- see persisted output for the full body] ...\n${tail}`, persistedPath };
}

// WS-12 §4: "the result MUST record the sandbox-override state." Shared by the foreground result
// text AND the two background surfaces (the "started" message and the task_notification summary,
// see runBackground below) so all three render identically. When the posture itself is already
// "override-requested" that word already carries the fact; the extra annotation only adds
// information for the (rarer, but real) case where the flag was set yet a DIFFERENT row of the
// §4.1 table won first (e.g. `enabled: false` beats a same-call override request) -- avoids the
// redundant "override-requested, override-requested" this would otherwise read as.
function formatSandboxAnnotation(posture: string, sandboxOverrideRequested: boolean): string {
  const overrideNote = sandboxOverrideRequested && posture !== "override-requested" ? ", override-requested" : "";
  return `[sandbox: ${posture}${overrideNote}]`;
}

function formatForegroundResult(parts: {
  stdout: CappedOutput;
  stderr: CappedOutput;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  posture: string;
  sandboxOverrideRequested: boolean;
  streamKilled: boolean;
}): string {
  const lines: string[] = [];
  lines.push(parts.stdout.text.length > 0 ? parts.stdout.text : "(no stdout)");
  if (parts.stdout.persistedPath) lines.push(`[stdout truncated; full output: ${parts.stdout.persistedPath}]`);
  if (parts.stderr.text.length > 0) {
    lines.push("[stderr]");
    lines.push(parts.stderr.text);
    if (parts.stderr.persistedPath) lines.push(`[stderr truncated; full output: ${parts.stderr.persistedPath}]`);
  }
  if (parts.streamKilled) lines.push("[streamed output exceeded 5GB, killed]");
  if (parts.aborted) lines.push("[aborted]");
  else if (parts.timedOut) lines.push(`[timed out after ${parts.timeoutMs}ms, killed]`);
  else lines.push(`[exit ${parts.exitCode}]`);
  lines.push(formatSandboxAnnotation(parts.posture, parts.sandboxOverrideRequested));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Foreground execution
// ---------------------------------------------------------------------------------------------
async function runForeground(input: BashInput, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const writableRoots = computeWritableRoots(ctx);
  const timeoutMs = resolveTimeout(input.timeout);
  const pwdFile = join(ctx.tempDir, `.bash-cwd-${randomUUID()}`);

  let stdout = "";
  let stderr = "";
  let result: RunCommandResult;
  try {
    result = await runCommand({
      command: buildPwdCaptureScript(input.command, pwdFile),
      matchCommand: input.command,
      cwd: ctx.cwd,
      env: buildChildEnv(ctx),
      timeoutMs,
      settings: ctx.sandboxSettings,
      ...(input.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: input.dangerouslyDisableSandbox } : {}),
      writableRoots,
      home: ctx.home,
      onStdout: (c) => {
        stdout += c.toString("utf8");
      },
      onStderr: (c) => {
        stderr += c.toString("utf8");
      },
    });
  } catch (err) {
    if (err instanceof SandboxUnavailableError || err instanceof SandboxConfigError) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
    throw err;
  }

  carryCwdIfAllowed(pwdFile, ctx, writableRoots);
  cleanupPwdFile(pwdFile);

  const success = result.exitCode === 0 && !result.timedOut && !result.aborted;
  const stdoutCapped = capOutput(ctx, "stdout", stdout, success);
  const stderrCapped = capOutput(ctx, "stderr", stderr, success);

  return {
    output: formatForegroundResult({
      stdout: stdoutCapped,
      stderr: stderrCapped,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      aborted: result.aborted,
      timeoutMs,
      posture: result.posture,
      sandboxOverrideRequested: result.sandboxOverrideRequested,
      streamKilled: result.streamKilled,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Background execution (WS-06 §6.2/§7.1, WS-12 §5.2's process-group kill reused for TaskStop)
// ---------------------------------------------------------------------------------------------
function summarizeCommand(command: string, max = 80): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

async function runBackground(input: BashInput, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const writableRoots = computeWritableRoots(ctx);
  const timeoutMs = resolveTimeout(input.timeout);

  // Pre-flight the SAME checks runCommand performs internally, synchronously, BEFORE creating the
  // background task or returning "started" to the model -- a config/availability problem must
  // surface as an immediate tool error, never as a "background task started" claim contradicted a
  // moment later by an unobservable rejected promise (runCommand is `async`, so a synchronous
  // throw inside it becomes a REJECTED PROMISE, not something this caller can inspect before its
  // own `await`/`.then` -- see spawn.ts's own header on why it is declared `async` at all).
  const decision = resolveExecutionPath({
    settings: ctx.sandboxSettings,
    command: input.command,
    ...(input.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: input.dangerouslyDisableSandbox } : {}),
  });
  if (decision.posture === "sandboxed") {
    if (!isSandboxAvailable()) {
      return {
        output: "Error: sandbox is required by the effective configuration but /usr/bin/sandbox-exec is unavailable on this host (WS-12 §3) -- refusing to silently run unsandboxed",
        isError: true,
      };
    }
    try {
      resolveNetworkPosture(ctx.sandboxSettings.network);
    } catch (err) {
      return { output: `Error: ${(err as Error).message}`, isError: true };
    }
  }

  const { taskId, outputPath } = createBackgroundTask("bash");
  const description = input.description ?? summarizeCommand(input.command);
  const outStream = createWriteStream(outputPath, { flags: "a" });

  // Task 8 (found via a real differential-scenario repro, not assumed): register the task BEFORE
  // spawning, not only inside onSpawned below. runCommand's own spawn is asynchronous (onSpawned
  // fires on a later tick, once the child process object exists) -- the very next lines emit
  // task_started and, critically, background_tasks_changed's own listRunningTasks() snapshot
  // SYNCHRONOUSLY, before that later tick ever runs. Without this line, background_tasks_changed
  // always reported an EMPTY tasks list immediately after starting the very task it was announcing
  // (a real ordering bug, invisible to bash.test.ts's own `frames.some(subtype === ...)` existence
  // check, which never inspected the frame's own `tasks` contents). startTracking's own `pid?:
  // number` is optional and `tasks.set()` is a plain overwrite, so calling it again from onSpawned
  // with the real pid once spawning completes is a safe, idempotent update of the SAME entry, not a
  // duplicate or a race (Node's spawn callback never fires synchronously within this call).
  startTracking({ taskId, kind: "bash", outputPath, description, command: input.command });

  const completion = runCommand({
    command: input.command,
    cwd: ctx.cwd,
    env: buildChildEnv(ctx),
    timeoutMs,
    settings: ctx.sandboxSettings,
    ...(input.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: input.dangerouslyDisableSandbox } : {}),
    writableRoots,
    home: ctx.home,
    onSpawned: ({ pid }) => {
      startTracking({ taskId, kind: "bash", outputPath, description, command: input.command, pid });
    },
    onStdout: (c) => outStream.write(c),
    onStderr: (c) => outStream.write(c),
  });

  ctx.emitFrame({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description,
    is_backgrounded: true,
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });
  ctx.emitFrame({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
    uuid: randomUUID(),
    session_id: ctx.sessionId,
  });

  // Fire-and-forget: run_in_background's whole point is returning before completion. Both legs are
  // defensive against a torn-down/completed session's ctx.emitFrame throwing, and both defer to
  // TaskStop if it already recorded a terminal status first (see background-task-runtime.ts's own
  // "single source of truth" status field -- whichever of {natural exit, TaskStop} runs its
  // synchronous status check-and-set first wins; Node's single-threaded event loop means there is
  // no interleaving WITHIN either branch's own synchronous block).
  completion.then(
    (result) => {
      outStream.end();
      if (getTask(taskId)?.status !== "running") return; // TaskStop already recorded a terminal status
      const status = result.exitCode === 0 && !result.timedOut ? "completed" : "failed";
      setTaskStatus(taskId, status);
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status,
          output_file: outputPath,
          summary: `${description} (${status}) ${formatSandboxAnnotation(result.posture, result.sandboxOverrideRequested)}`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
        ctx.emitFrame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: listRunningTasks().map(toBackgroundTasksChangedEntry),
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* a torn-down session's emitFrame may throw; the registry's status and the .output file are still correct */
      }
    },
    (err) => {
      outStream.end();
      if (getTask(taskId)?.status !== "running") return;
      setTaskStatus(taskId, "failed");
      try {
        ctx.emitFrame({
          type: "system",
          subtype: "task_notification",
          task_id: taskId,
          status: "failed",
          output_file: outputPath,
          // No RunCommandResult exists on this branch (runCommand itself rejected, pre-spawn) -- the
          // pre-flight `decision` computed at the top of this function is what was actually attempted.
          summary: `${description} (failed to run: ${(err as Error).message}) ${formatSandboxAnnotation(decision.posture, decision.sandboxOverrideRequested)}`,
          uuid: randomUUID(),
          session_id: ctx.sessionId,
        });
      } catch {
        /* see above */
      }
    },
  );

  return {
    output: `background task ${taskId} started\noutput_file: ${outputPath}\n${formatSandboxAnnotation(decision.posture, decision.sandboxOverrideRequested)}\nRead or grep that file for output as it accumulates; use task_output to peek, task_stop to stop it.`,
  };
}

// ---------------------------------------------------------------------------------------------
// extractPaths (P2-T11 carry): Bash's cwd-drift-aware redirect-target extraction, reusing T3's
// grammar (splitCompound/extractRedirectTargets) rather than re-parsing shell syntax. This function
// has NO ToolExecutionContext (registry.ts's own extractPaths signature is `(input) => {...}`,
// deliberately -- see paths-seam.ts's own header), so it cannot resolve against the call's real
// cwd; it tracks `cd` drift RELATIVE TO ITSELF (never against `process.cwd()`, which `path.resolve`
// would silently substitute for a bare "." base -- a real bug this deliberately avoids) and leaves
// absolute resolution to a future caller that has the real cwd (paths-seam.ts's own
// resolveCandidatePaths is exactly that caller's tool, not this function's).
//
// Judgment call, flagged per this lane's own brief ("grammar-reading judgment calls"): `cd`
// detection here is a simple, quote-UNAWARE regex (`/^cd\s+(\S+)/`), not grammar.ts's own private
// quote-aware word scanner (that scanner is not exported, and this lane does not modify grammar.ts
// -- a shared, already-shipped Phase 2/WS-07 file). A `cd "my dir"` with an embedded space is not
// tracked correctly; documented rather than silently guessed at.
const CD_RE = /^cd\s+(\S+)/;

function joinRelative(base: string, candidate: string): string {
  if (candidate.startsWith("/")) return candidate;
  return base === "." ? candidate : `${base}/${candidate}`;
}

function extractBashPaths(input: unknown): ExtractedPaths {
  const parsed = parseBashInput(input);
  if ("error" in parsed) return emptyPathSet();
  const segments = splitCompound(parsed.command);
  if (!segments) return emptyPathSet(); // unparseable -- conservative: nothing extracted (WS-07 §3's own "fall back" posture)

  const writes: string[] = [];
  let base = ".";
  for (const segment of segments) {
    for (const target of extractRedirectTargets(segment)) {
      writes.push(joinRelative(base, target));
    }
    const cdMatch = CD_RE.exec(segment.trim());
    if (cdMatch) {
      const target = cdMatch[1]!.replace(/^["']|["']$/g, "");
      base = joinRelative(base, target);
    }
  }
  return { reads: [], writes: [...new Set(writes)] };
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------
export const bashExecutor: ToolExecutor = {
  async execute(input, ctx) {
    const parsed = parseBashInput(input);
    if ("error" in parsed) return { output: `Error: ${parsed.error}`, isError: true };
    return parsed.run_in_background ? runBackground(parsed, ctx) : runForeground(parsed, ctx);
  },
};

replaceExecutor("Bash", bashExecutor, extractBashPaths);

// Exported for direct unit testing without going through the full registry/ctx machinery.
export { parseBashInput, resolveTimeout, extractBashPaths, computeWritableRoots, capOutput, formatForegroundResult };
