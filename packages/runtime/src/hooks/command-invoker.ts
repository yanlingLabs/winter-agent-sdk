// Phase 5 Task 3 (T2 rider): the COMMAND-HOOK RUNNER -- the executor `SourcedHookEntry.command` has
// been waiting for since T2 typed it.
//
// Background: Winter has exactly one `HookInvoker` (bridge-invoker.ts), which dispatches to a host
// CALLBACK by positional id. A settings-file hook block declares `{ type: "command", command,
// timeout? }` instead, and `buildHookEntriesFromSettings` (hooks/from-config.ts) parses and carries
// it -- but nothing could RUN it. This is that executor.
//
// SHAPE: a DISPATCHING invoker that wraps another one, rather than a second seam. `runHooks` takes a
// single `invoker` for every participant in a run, and a session can legitimately mix SDK-callback
// hooks with settings-file command hooks. Wrapping keeps `HookInvocationRequest` unchanged -- the
// alternative (adding `command` to the request) would push a local shell command across the control
// bridge to the host on every callback invocation, for no reason.
//
// THE WIRE (WS-23 ruling: claude's command-hook wire, for ECOSYSTEM compatibility -- Winter's plugin
// layout IS claude's, so a plugin's `hooks/hooks.json` script was written against claude's stdin and
// exit codes, and the earlier Winter-only wire made every such script fail open):
//   stdin  <- claude's snake_case hook input (`session_id`, `transcript_path`, `cwd`,
//             `hook_event_name`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`, plus the
//             event's own fields -- `tool_response`, `prompt`, `source`, `stop_hook_active`, ...), built
//             by `commandHookInput` below. An SDK CALLBACK still receives Winter's camelCase request
//             over the bridge (the host's own wrapper, query.ts's `buildHookInput`, turns it into the
//             same snake_case shape for the JS callback) -- two independent builders of one shape, the
//             same "must agree, never shared" split query.ts and from-config.ts already keep for
//             hook ids (WS-02 §3: the runtime never imports the sdk's internal wiring).
//   stdout -> exit 0: JSON is the hook's output. Plain text (not starting with `{`) is claude's other
//             exit-0 form: CONTEXT for the events whose stdout claude feeds the model
//             (UserPromptSubmit, SessionStart, SubagentStart), an acknowledgement for the rest.
//
// EXIT CODES, claude's table:
//   - 0                    -> the output above.
//   - 2                    -> BLOCKING, with stderr as the reason, expressed as the output the event
//                             already understands (`exitTwoOutput`): the legacy
//                             `{decision: "block", reason}` envelope for PreToolUse (a deny),
//                             UserPromptSubmit (drop the prompt), Stop/SubagentStop (keep going),
//                             PostToolUse/PostToolUseFailure (the reason goes to the model); the
//                             explicit deny shape for PermissionRequest (whose interpreter reads no
//                             legacy envelope); and a `systemMessage` for every event that has
//                             nothing to block, so the user still sees what the script said.
//   - any other non-zero   -> a NON-BLOCKING error of that hook: thrown, folded by `runHooks` into
//                             `{kind: "error"}` -- unless the hook is fail-closed (runner.ts).
//
// ENVIRONMENT: `CLAUDE_PROJECT_DIR` (and its brand-named twin, `<PREFIX>PROJECT_DIR`) for every hook;
// `CLAUDE_PLUGIN_ROOT` (and `<PREFIX>PLUGIN_ROOT`) for a plugin's hook. A claude-format command
// spelled `${CLAUDE_PLUGIN_ROOT}/hooks/run.sh` is expanded by `/bin/sh` itself from that exported
// variable -- never by splicing the path into the command text first (fix round 1, M4: a `$(...)`,
// a backtick or a `"` in the plugin's directory name would otherwise be re-parsed as shell syntax).
// The TRUSTED-WORKSPACE gate is unchanged and still not here:
// `buildHookRegistry` drops project/local entries wholesale in an untrusted workspace, so an entry
// this invoker is asked to run has already passed it.
//
// ASYNC (WS-24): a hook DECLARED `async: true` on its handler, or one whose first stdout line ANNOUNCES
// `{"async": true}`, is handed to the session's async queue (hooks/async-hooks.ts) and the runner is
// answered at once -- see that file for what such a hook can still say, and the bounds on it. A
// fail-closed gating hook never goes to the background.
//
// TIMEOUTS: the runner stays the SOLE timeout authority (60 s gating / 30 s observational,
// hooks/runner.ts's own DEFAULT_*_TIMEOUT_MS, overridable per entry by the settings block's own
// `timeout`). This invoker adds no second, independently-tuned clock -- the exact reasoning
// bridge-invoker.ts's header already records. What it DOES own is making the runner's timeout
// effective on a real process: on abort it sends SIGTERM, then SIGKILL after a short grace, and it
// kills in `finally` on every path, so an abandoned hook process can never outlive its invocation.
import { spawn } from "node:child_process";
import { envName, type BrandProfile, type HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { FAIL_CLOSED_EVENTS, HOOK_PROCESS_OUTPUT, type HookInvocationRequest, type HookInvoker, type HookProcessOutput } from "./runner.ts";
import { MAX_HOOK_STDOUT_CAPTURE } from "./bounds.ts";
import type { SourcedHookEntry } from "./registry.ts";
import { trackProcessGroup } from "../process-groups.ts";
import { createAsyncHookQueue, DEFAULT_ASYNC_HOOK_TIMEOUT_MS, type AsyncHookQueue } from "./async-hooks.ts";

/** Grace between SIGTERM and SIGKILL. Short: by the time this fires the runner has already given up on the hook. */
export const COMMAND_HOOK_KILL_GRACE_MS = 250;

/** stderr is captured for diagnostics only and is bounded -- a hook that writes megabytes to stderr must not be able to grow an error message without limit. */
const MAX_STDERR_CAPTURE = 4096;
/** WS-23: the stdout echoed on the host-visible `hook_response` frame, bounded for the same reason. The PARSED output is never truncated. */
const MAX_STDOUT_ECHO = 16_384;

export class CommandHookError extends Error {
  /** Fix round 1 (M3): the failure's machine-readable class -- what a fail-closed denial names instead of this error's message (which embeds the command line). */
  readonly code: string;
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    stdout = "",
    code?: string,
  ) {
    super(message);
    this.name = "CommandHookError";
    this.code = code ?? (exitCode === null ? "terminated" : `exit_code_${exitCode}`);
    // WS-23: the process output rides the error too, so a FAILED hook's stderr still reaches the
    // host's `hook_response` frame (runner.ts reads it off the rejection).
    Object.defineProperty(this, HOOK_PROCESS_OUTPUT, { value: { stdout, stderr, exitCode } satisfies HookProcessOutput, enumerable: false });
  }
}

export interface CommandHookInvokerOptions {
  /** Where a non-command entry's invocation goes -- normally `createBridgeHookInvoker(bridge)`. */
  next: HookInvoker;
  /** Working directory for the spawned command. The session cwd; never `process.cwd()` picked up implicitly. */
  cwd: string;
  /** Environment for the spawned command. Passed explicitly so a caller states which environment governs, matching this codebase's standing rule for env-derived behaviour. */
  env?: Record<string, string | undefined>;
  /** The shell used to interpret a command string. Overridable for tests; never taken from `$SHELL`, which a repository could influence. */
  shellPath?: string;
  killGraceMs?: number;
  /** WS-23: `CLAUDE_PROJECT_DIR` (and its brand twin). Defaults to `cwd` -- the session's project directory. */
  projectDir?: string;
  /** WS-23: the brand whose env prefix names the Winter twins of `CLAUDE_PROJECT_DIR`/`CLAUDE_PLUGIN_ROOT`. Absent = no twin exported. */
  brand?: Pick<BrandProfile, "envPrefix">;
  /** WS-23: the stdin input's `transcript_path` -- the session transcript's absolute path, or `""` when there is none to name. */
  transcriptPath?: string;
  /** WS-23: the stdin input's `permission_mode`, read at invocation time (it changes mid-session). */
  permissionMode?: () => string | undefined;
  /** WS-24: where backgrounded (async) hooks go. Defaults to a fresh `createAsyncHookQueue()`, exposed as the invoker's `asyncHooks`. */
  asyncHooks?: AsyncHookQueue;
}

/** WS-24: the command invoker also OWNS the session's background hooks (hooks/async-hooks.ts). */
export interface CommandHookInvoker extends HookInvoker {
  readonly asyncHooks: AsyncHookQueue;
}

/**
 * Wraps `opts.next`, executing any invocation whose `hookId` belongs to a command-bearing entry as a
 * subprocess instead.
 *
 * The entry list is snapshotted at construction, matching `buildHookRegistry`'s own "a registry is
 * immutable for the life of a run" contract -- a run builds both from the same entries.
 */
export function createCommandHookInvoker(entries: readonly SourcedHookEntry[], opts: CommandHookInvokerOptions): CommandHookInvoker {
  const commandsById = new Map<string, { command: string; pluginRoot?: string; failClosed: boolean; async: boolean; timeoutMs?: number }>();
  for (const entry of entries) {
    if (entry.command !== undefined && entry.command.length > 0) {
      commandsById.set(entry.id, {
        command: entry.command,
        ...(entry.pluginRoot !== undefined ? { pluginRoot: entry.pluginRoot } : {}),
        failClosed: entry.failClosed === true,
        async: entry.async === true,
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      });
    }
  }
  const killGraceMs = opts.killGraceMs ?? COMMAND_HOOK_KILL_GRACE_MS;
  const shellPath = opts.shellPath ?? "/bin/sh";
  const projectDir = opts.projectDir ?? opts.cwd;
  const asyncHooks = opts.asyncHooks ?? createAsyncHookQueue();

  return {
    asyncHooks,
    async invoke(request: HookInvocationRequest, invokeOpts: { signal: AbortSignal }): Promise<unknown> {
      const target = commandsById.get(request.hookId);
      if (target === undefined) return opts.next.invoke(request, invokeOpts);
      const env = commandHookEnv(opts.env ?? process.env, { projectDir, ...(target.pluginRoot !== undefined ? { pluginRoot: target.pluginRoot } : {}), ...(opts.brand !== undefined ? { brand: opts.brand } : {}) });
      const permissionMode = opts.permissionMode?.();
      const input = commandHookInput(request, { cwd: opts.cwd, transcriptPath: opts.transcriptPath ?? "", ...(permissionMode !== undefined ? { permissionMode } : {}) });
      // Fix round 1 (I2): a fail-closed hook on a gating event must answer in JSON (see runCommandHook).
      const strictJson = target.failClosed && FAIL_CLOSED_EVENTS.has(request.event);
      // WS-24: every hook but a fail-closed gating one may go to the background -- DECLARED (`async`
      // on its handler; from-config.ts already refused it on a fail-closed gating hook, and strictJson
      // re-checks) or ANNOUNCED (an `{"async": true}` first stdout line).
      const background = strictJson
        ? undefined
        : {
            queue: asyncHooks,
            event: request.event,
            hookName: request.toolName !== undefined ? `${request.event}:${request.toolName}` : request.event,
            ...(request.toolUseID !== undefined ? { toolUseID: request.toolUseID } : {}),
            ...(target.timeoutMs !== undefined ? { declaredTimeoutMs: target.timeoutMs } : {}),
            declared: target.async,
          };
      return runCommandHook(target.command, request.event, input, invokeOpts.signal, { cwd: opts.cwd, env, shellPath, killGraceMs, strictJson, ...(background !== undefined ? { background } : {}) });
    },
  };
}

function commandHookEnv(
  base: Record<string, string | undefined>,
  opts: { projectDir: string; pluginRoot?: string; brand?: Pick<BrandProfile, "envPrefix"> },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_PROJECT_DIR: opts.projectDir };
  if (opts.brand !== undefined) env[envName(opts.brand, "PROJECT_DIR")] = opts.projectDir;
  if (opts.pluginRoot !== undefined) {
    env["CLAUDE_PLUGIN_ROOT"] = opts.pluginRoot;
    if (opts.brand !== undefined) env[envName(opts.brand, "PLUGIN_ROOT")] = opts.pluginRoot;
  }
  return env;
}

/**
 * claude's command-hook stdin: the snake_case `HookInput` for this event, built from the runner's
 * camelCase request. `payload` already carries each event's own fields in claude's spelling (the
 * engine's firing sites pass `tool_response`, `prompt`, `source`, `stop_hook_active`, ...), so it is
 * spread last and verbatim -- the same lossless construction query.ts's `buildHookInput` applies for
 * a JS callback. `transcript_path` is claude's non-optional field: `""` when the session has no
 * durable transcript to point at, never a guessed path.
 */
export function commandHookInput(request: HookInvocationRequest, ctx: { cwd: string; transcriptPath: string; permissionMode?: string }): Record<string, unknown> {
  const payload = typeof request.payload === "object" && request.payload !== null && !Array.isArray(request.payload) ? (request.payload as Record<string, unknown>) : {};
  return {
    session_id: request.sessionId,
    transcript_path: ctx.transcriptPath,
    cwd: ctx.cwd,
    ...(ctx.permissionMode !== undefined ? { permission_mode: ctx.permissionMode } : {}),
    ...(request.agentID !== undefined ? { agent_id: request.agentID } : {}),
    hook_event_name: request.event,
    ...(request.toolName !== undefined ? { tool_name: request.toolName } : {}),
    // WS-24: the MCP server behind the tool, and its own name there -- the sdk's `McpToolProvenance`.
    ...(request.mcpServerName !== undefined ? { mcp_server_name: request.mcpServerName } : {}),
    ...(request.mcpToolName !== undefined ? { mcp_tool_name: request.mcpToolName } : {}),
    // WS-27: the exact server identity -- the sdk's `WinterMcpServerHookField`.
    ...(request.mcpServer !== undefined
      ? {
          winter_mcp_server: {
            name: request.mcpServer.name,
            config_name: request.mcpServer.configName,
            ...(request.mcpServer.readOnlyHint !== undefined ? { read_only_hint: request.mcpServer.readOnlyHint } : {}),
          },
        }
      : {}),
    ...(request.input !== undefined ? { tool_input: request.input } : {}),
    ...(request.toolUseID !== undefined ? { tool_use_id: request.toolUseID } : {}),
    ...payload,
  };
}

// The events whose exit-2 is a BLOCK of something (see this file's header for what each block means).
const LEGACY_BLOCK_EVENTS: ReadonlySet<HookEvent> = new Set(["PreToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "PostToolUseFailure"]);
// claude feeds these events' plain-text stdout to the model.
const PLAIN_STDOUT_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(["UserPromptSubmit", "SessionStart", "SubagentStart"]);

/** A stderr-less exit 2 still blocks; it just has nothing better to say than this. */
const EXIT_TWO_NO_STDERR = "Blocked by hook (exit code 2, no stderr)";

function exitTwoOutput(event: HookEvent, stderr: string): Record<string, unknown> {
  const reason = stderr.trim().length > 0 ? stderr.trim() : EXIT_TWO_NO_STDERR;
  if (event === "PermissionRequest") return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: reason } } };
  if (LEGACY_BLOCK_EVENTS.has(event)) return { decision: "block", reason };
  return { systemMessage: reason };
}

function plainStdoutOutput(event: HookEvent, stdout: string): Record<string, unknown> {
  if (!PLAIN_STDOUT_CONTEXT_EVENTS.has(event)) return {}; // an acknowledgement: ran, said nothing machine-readable
  return { hookSpecificOutput: { hookEventName: event, additionalContext: stdout } };
}

function withProcessOutput<T extends object>(value: T, processOutput: HookProcessOutput): T {
  Object.defineProperty(value, HOOK_PROCESS_OUTPUT, { value: processOutput, enumerable: false });
  return value;
}

interface HookProcess {
  /** Settles when the process has exited and its pipes closed; rejects only when it could not be spawned. */
  exited: Promise<{ code: number | null; signalName: NodeJS.Signals | null }>;
  /** Resolves with the first stdout line once one is complete (never, if the process exits first). */
  firstLine: Promise<string>;
  stdout(): string;
  stderr(): string;
  /** SIGTERM the whole group now, SIGKILL after `graceMs` (the runner's timeout). */
  terminate(graceMs: number): void;
  /** SIGKILL the whole group now. Idempotent; a no-op once the process has exited. */
  kill(): void;
  /** Drop the escalation timer `terminate` armed. */
  clearTimers(): void;
}

/** WS-24: the most bytes the first stdout line may take and still be read as an `{"async": true}` announcement. */
const MAX_ASYNC_ANNOUNCEMENT_CHARS = 4096;

function startHookProcess(command: string, input: Record<string, unknown>, cfg: { cwd: string; env: Record<string, string | undefined>; shellPath: string }): HookProcess {
  // ARGV FORM, never `shell: true`. The command itself is an author-supplied shell string (that is
  // what a `{type:"command"}` block IS), so a shell interprets it -- but it is passed as an ARGUMENT
  // to that shell, never concatenated into a larger command line. Nothing from the REQUEST is ever
  // interpolated into the command: the hook's input rides stdin as JSON, which is the whole reason
  // the §10 payload is a stdin contract and not an argv one.
  const child = spawn(cfg.shellPath, ["-c", command], {
    cwd: cfg.cwd,
    env: cfg.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so the kill below takes down anything the command itself spawned --
    // otherwise a hook that backgrounds a child leaves it running past the session (the same
    // process-group discipline sandbox/spawn.ts applies).
    detached: true,
  });
  // WS-24: mirrored to an embedded session's host while the hook's group lives (process-groups.ts).
  const releaseGroup = child.pid !== undefined ? trackProcessGroup(child.pid, "hook") : () => {};
  child.once("close", releaseGroup);
  child.once("error", releaseGroup);

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killTree = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // The group is already gone, or was never created (spawn failure) -- both benign.
      try {
        child.kill(sig);
      } catch {
        /* nothing left to kill */
      }
    }
  };

  let stdout = "";
  let stderr = "";
  let resolveFirstLine!: (line: string) => void;
  const firstLine = new Promise<string>((resolve) => (resolveFirstLine = resolve));
  let firstLineSeen = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    // Fix round 1 (C1): bounded like stderr (hooks/bounds.ts's MAX_HOOK_STDOUT_CAPTURE). A script
    // that floods stdout costs a bounded buffer; a JSON answer cut here fails to parse -- its error.
    if (stdout.length < MAX_HOOK_STDOUT_CAPTURE) stdout += chunk.slice(0, MAX_HOOK_STDOUT_CAPTURE - stdout.length);
    if (!firstLineSeen) {
      const nl = stdout.indexOf("\n");
      if (nl !== -1 || stdout.length > MAX_ASYNC_ANNOUNCEMENT_CHARS) {
        firstLineSeen = true;
        resolveFirstLine(nl !== -1 ? stdout.slice(0, nl) : "");
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR_CAPTURE) stderr += chunk;
  });

  // The exit promise is armed FIRST, before anything is awaited. `error` (a spawn that failed
  // outright -- no such shell, permission denied) can fire on the very next tick, and a listener
  // attached after an intervening `await` misses it: the promise then never settles and the whole
  // invocation hangs until the runner's timeout. Observed, not theorised -- the "cannot be spawned"
  // fixture below hung the suite before this ordering was fixed.
  const exited = new Promise<{ code: number | null; signalName: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code, signalName) => resolveExit({ code, signalName }));
  });

  // claude's snake_case input (see this file's header). Written fire-and-forget: a hook that exits
  // without reading stdin produces EPIPE, which is normal (the error listener swallows it), and
  // awaiting the write's callback would be a second promise that can outlive a killed child.
  child.stdin.on("error", () => {
    /* EPIPE when a hook exits without reading stdin -- normal, not a failure */
  });
  child.stdin.end(`${JSON.stringify(input)}\n`);

  return {
    exited,
    firstLine,
    stdout: () => stdout,
    stderr: () => stderr.slice(0, MAX_STDERR_CAPTURE),
    terminate(graceMs: number): void {
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), graceMs);
      // Never hold the event loop open on the escalation timer alone.
      killTimer.unref?.();
    },
    kill: () => killTree("SIGKILL"),
    clearTimers(): void {
      if (killTimer !== undefined) clearTimeout(killTimer);
    },
  };
}

/**
 * WS-24: an `{"async": true, "asyncTimeout"?: <ms>}` first line -- the announcement that the rest of the
 * hook runs in the background (hooks/async-hooks.ts). `undefined` for any other line.
 */
function asyncAnnouncement(line: string): { value: Record<string, unknown>; timeoutMs?: number } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { async?: unknown }).async !== true) return undefined;
  const timeout = (parsed as { asyncTimeout?: unknown }).asyncTimeout;
  return { value: parsed as Record<string, unknown>, ...(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}) };
}

/** WS-24: what a backgrounded hook is handed to the async queue as. */
interface BackgroundTarget {
  queue: AsyncHookQueue;
  event: HookEvent;
  hookName: string;
  toolUseID?: string;
  /** The handler's own `timeout` (already ms), when it declared one. */
  declaredTimeoutMs?: number;
}

function adoptInBackground(proc: HookProcess, target: BackgroundTarget, stdoutOffset: number, announcedTimeoutMs?: number): void {
  target.queue.adopt({
    event: target.event,
    hookName: target.hookName,
    ...(target.toolUseID !== undefined ? { toolUseID: target.toolUseID } : {}),
    // Never rejects: a hook that could not even be spawned simply says nothing.
    finished: proc.exited.then(
      (exit) => ({ exitCode: exit.signalName !== null ? null : exit.code, stdout: proc.stdout().slice(stdoutOffset) }),
      () => ({ exitCode: null, stdout: "" }),
    ),
    kill: () => proc.kill(),
    // An ANNOUNCED `asyncTimeout` is the hook's own statement of its background budget, so it outranks the
    // handler's generic `timeout` (which governed the synchronous wait up to that line).
    timeoutMs: announcedTimeoutMs ?? target.declaredTimeoutMs ?? DEFAULT_ASYNC_HOOK_TIMEOUT_MS,
  });
}

async function runCommandHook(
  command: string,
  event: HookEvent,
  input: Record<string, unknown>,
  signal: AbortSignal,
  cfg: { cwd: string; env: Record<string, string | undefined>; shellPath: string; killGraceMs: number; strictJson: boolean; background?: BackgroundTarget & { declared: boolean } },
): Promise<unknown> {
  const proc = startHookProcess(command, input, cfg);

  // WS-24, door 1 -- DECLARED async: the hook never had a synchronous answer to give. The runner is
  // answered at once and never waits; the runner's signal is not attached (its timeout is for a hook it
  // waits on), and the job's own timeout governs from here (hooks/async-hooks.ts).
  if (cfg.background?.declared === true) {
    adoptInBackground(proc, cfg.background, 0);
    return { async: true };
  }

  let backgrounded = false;
  const onAbort = (): void => {
    if (!backgrounded) proc.terminate(cfg.killGraceMs);
  };

  try {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    // WS-24, door 2 -- an ANNOUNCED async hook: a first stdout line `{"async": true}` answers the runner
    // NOW and the process runs on in the background. Never for a fail-closed gating hook (strictJson):
    // its answer must arrive before the call, so it waits for the exit as always, and an `async` answer
    // is its malformed-output error (runner.ts).
    if (cfg.background !== undefined && !cfg.strictJson) {
      const first = await Promise.race([proc.firstLine.then((line) => ({ line })), proc.exited.then(() => undefined, () => undefined)]);
      const announced = first !== undefined ? asyncAnnouncement(first.line) : undefined;
      if (announced !== undefined) {
        backgrounded = true;
        adoptInBackground(proc, cfg.background, first!.line.length + 1, announced.timeoutMs);
        return announced.value;
      }
    }

    const exit = await proc.exited;
    const boundedStderr = proc.stderr();
    const stdout = proc.stdout();
    const processOutput: HookProcessOutput = { stdout: stdout.slice(0, MAX_STDOUT_ECHO), stderr: boundedStderr, exitCode: exit.code };

    if (exit.signalName !== null) {
      throw new CommandHookError(`hook command was terminated by ${exit.signalName}: ${command}`, null, boundedStderr, processOutput.stdout);
    }
    // WS-23: exit 2 is claude's BLOCK, with stderr as the reason -- see `exitTwoOutput`.
    if (exit.code === 2) return withProcessOutput(exitTwoOutput(event, boundedStderr), processOutput);
    if (exit.code !== 0) {
      throw new CommandHookError(`hook command exited with code ${exit.code}: ${command}`, exit.code, boundedStderr, processOutput.stdout);
    }
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return withProcessOutput({}, processOutput); // acknowledgement: ran, said nothing
    // claude's rule: output that does not even START like a JSON object is plain text, not a broken
    // JSON document. Only a `{`-led stdout that fails to parse is the malformed-output error.
    if (!trimmed.startsWith("{")) {
      // Fix round 1 (I2): for a FAIL-CLOSED PreToolUse/PermissionRequest hook, prose on stdout is not
      // an answer -- malformed, so the runner denies. Everyone else keeps claude's plain-text reading.
      if (cfg.strictJson) throw new CommandHookError(`fail-closed hook command answered with non-JSON stdout: ${command}`, exit.code, boundedStderr, processOutput.stdout, "malformed_output");
      return withProcessOutput(plainStdoutOutput(event, trimmed), processOutput);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CommandHookError(`hook command produced unparseable output (WS-08 §8: a malformed output is an error of that hook): ${command}`, exit.code, boundedStderr, processOutput.stdout, "malformed_output");
    }
    return typeof parsed === "object" && parsed !== null ? withProcessOutput(parsed, processOutput) : parsed;
  } finally {
    // Every path, including a throw and an abort: an abandoned hook process must never outlive its
    // invocation. macOS has no `timeout(1)`, so this is the only backstop there is. WS-24: except a
    // BACKGROUNDED one, which the async queue now owns (its timeout, its kill, session end).
    signal.removeEventListener("abort", onAbort);
    proc.clearTimers();
    if (!backgrounded) proc.kill();
  }
}
