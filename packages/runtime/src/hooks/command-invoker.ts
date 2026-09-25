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
// `CLAUDE_PLUGIN_ROOT` (and `<PREFIX>PLUGIN_ROOT`) for a plugin's hook, whose `${CLAUDE_PLUGIN_ROOT}`
// in the command string is also substituted before the shell sees it -- claude-format plugins spell
// their script paths that way. The TRUSTED-WORKSPACE gate is unchanged and still not here:
// `buildHookRegistry` drops project/local entries wholesale in an untrusted workspace, so an entry
// this invoker is asked to run has already passed it.
//
// TIMEOUTS: the runner stays the SOLE timeout authority (60 s gating / 30 s observational,
// hooks/runner.ts's own DEFAULT_*_TIMEOUT_MS, overridable per entry by the settings block's own
// `timeout`). This invoker adds no second, independently-tuned clock -- the exact reasoning
// bridge-invoker.ts's header already records. What it DOES own is making the runner's timeout
// effective on a real process: on abort it sends SIGTERM, then SIGKILL after a short grace, and it
// kills in `finally` on every path, so an abandoned hook process can never outlive its invocation.
import { spawn } from "node:child_process";
import { envName, type BrandProfile, type HookEvent } from "@yanlinglabs/winter-agent-sdk";
import { HOOK_PROCESS_OUTPUT, type HookInvocationRequest, type HookInvoker, type HookProcessOutput } from "./runner.ts";
import type { SourcedHookEntry } from "./registry.ts";

/** Grace between SIGTERM and SIGKILL. Short: by the time this fires the runner has already given up on the hook. */
export const COMMAND_HOOK_KILL_GRACE_MS = 250;

/** stderr is captured for diagnostics only and is bounded -- a hook that writes megabytes to stderr must not be able to grow an error message without limit. */
const MAX_STDERR_CAPTURE = 4096;
/** WS-23: the stdout echoed on the host-visible `hook_response` frame, bounded for the same reason. The PARSED output is never truncated. */
const MAX_STDOUT_ECHO = 16_384;

export class CommandHookError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    stdout = "",
  ) {
    super(message);
    this.name = "CommandHookError";
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
}

/**
 * Wraps `opts.next`, executing any invocation whose `hookId` belongs to a command-bearing entry as a
 * subprocess instead.
 *
 * The entry list is snapshotted at construction, matching `buildHookRegistry`'s own "a registry is
 * immutable for the life of a run" contract -- a run builds both from the same entries.
 */
export function createCommandHookInvoker(entries: readonly SourcedHookEntry[], opts: CommandHookInvokerOptions): HookInvoker {
  const commandsById = new Map<string, { command: string; pluginRoot?: string }>();
  for (const entry of entries) {
    if (entry.command !== undefined && entry.command.length > 0) commandsById.set(entry.id, { command: entry.command, ...(entry.pluginRoot !== undefined ? { pluginRoot: entry.pluginRoot } : {}) });
  }
  const killGraceMs = opts.killGraceMs ?? COMMAND_HOOK_KILL_GRACE_MS;
  const shellPath = opts.shellPath ?? "/bin/sh";
  const projectDir = opts.projectDir ?? opts.cwd;

  return {
    async invoke(request: HookInvocationRequest, invokeOpts: { signal: AbortSignal }): Promise<unknown> {
      const target = commandsById.get(request.hookId);
      if (target === undefined) return opts.next.invoke(request, invokeOpts);
      const env = commandHookEnv(opts.env ?? process.env, { projectDir, ...(target.pluginRoot !== undefined ? { pluginRoot: target.pluginRoot } : {}), ...(opts.brand !== undefined ? { brand: opts.brand } : {}) });
      const permissionMode = opts.permissionMode?.();
      const input = commandHookInput(request, { cwd: opts.cwd, transcriptPath: opts.transcriptPath ?? "", ...(permissionMode !== undefined ? { permissionMode } : {}) });
      const command = target.pluginRoot !== undefined ? substitutePluginRoot(target.command, target.pluginRoot) : target.command;
      return runCommandHook(command, request.event, input, invokeOpts.signal, { cwd: opts.cwd, env, shellPath, killGraceMs });
    },
  };
}

/**
 * claude's `${CLAUDE_PLUGIN_ROOT}` substitution. Plain text replacement BEFORE the shell sees the
 * string, exactly as claude does it -- the variable is also exported, so a script that re-reads it
 * from its environment agrees. The root is an absolute path Winter resolved itself (the plugin
 * loader's `bundle.path`), never model or repository input, so splicing it into the command is not
 * an injection surface the command itself did not already have.
 */
export function substitutePluginRoot(command: string, pluginRoot: string): string {
  return command.split("${CLAUDE_PLUGIN_ROOT}").join(pluginRoot);
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

async function runCommandHook(
  command: string,
  event: HookEvent,
  input: Record<string, unknown>,
  signal: AbortSignal,
  cfg: { cwd: string; env: Record<string, string | undefined>; shellPath: string; killGraceMs: number },
): Promise<unknown> {
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

  const onAbort = (): void => {
    killTree("SIGTERM");
    killTimer = setTimeout(() => killTree("SIGKILL"), cfg.killGraceMs);
    // Never hold the event loop open on the escalation timer alone.
    killTimer.unref?.();
  };

  try {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CAPTURE) stderr += chunk;
    });

    // The exit promise is armed FIRST, before anything is awaited. `error` (a spawn that failed
    // outright -- no such shell, permission denied) can fire on the very next tick, and a listener
    // attached after an intervening `await` misses it: the promise then never settles and the whole
    // invocation hangs until the runner's timeout. Observed, not theorised -- the "cannot be spawned"
    // fixture below hung the suite before this ordering was fixed.
    const exitPromise = new Promise<{ code: number | null; signalName: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
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

    const exit = await exitPromise;
    const boundedStderr = stderr.slice(0, MAX_STDERR_CAPTURE);
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
    if (!trimmed.startsWith("{")) return withProcessOutput(plainStdoutOutput(event, trimmed), processOutput);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CommandHookError(`hook command produced unparseable output (WS-08 §8: a malformed output is an error of that hook): ${command}`, exit.code, boundedStderr, processOutput.stdout);
    }
    return typeof parsed === "object" && parsed !== null ? withProcessOutput(parsed, processOutput) : parsed;
  } finally {
    // Every path, including a throw and an abort: an abandoned hook process must never outlive its
    // invocation. macOS has no `timeout(1)`, so this is the only backstop there is.
    signal.removeEventListener("abort", onAbort);
    if (killTimer !== undefined) clearTimeout(killTimer);
    killTree("SIGKILL");
  }
}
