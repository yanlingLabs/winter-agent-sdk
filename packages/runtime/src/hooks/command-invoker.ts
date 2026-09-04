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
// THE WIRE, both directions:
//   stdin  <- the §10 request payload, JSON, exactly as `HookInvocationRequest` (one line, then EOF)
//   stdout -> the event-specific hook output, JSON
//
// EXIT-CODE SEMANTICS, derived rather than invented. derived-shapes-p2 has NO exit-code table -- the
// pinned declaration says nothing about process hooks at all -- so the authority is WS-08 §8's
// failure matrix:
//   - exit 0 + parseable JSON on stdout  -> that object is the hook's output
//   - exit 0 + EMPTY stdout              -> an acknowledgement: `{}`, no decision, no transform
//   - exit 0 + unparseable stdout        -> "a malformed/unknown-shaped output ... treated as an
//                                           error of that hook" (§8 row 3): throws
//   - non-zero exit                      -> an error of that hook: throws, carrying the code and a
//                                           bounded stderr tail
// `runHooks` folds a thrown invoker into a normal `{kind:"error"}` audit outcome, so a failing
// command hook contributes nothing and evaluation continues -- §8 row 1, never a tool denial. NO
// exit code is given a special meaning (no "exit 2 blocks"): that convention is not in this spec or
// in the pinned artifact, and inventing it would let a hook deny a tool through an undocumented side
// channel. Recorded as capture-pending.
//
// TIMEOUTS: the runner stays the SOLE timeout authority (60 s gating / 30 s observational,
// hooks/runner.ts's own DEFAULT_*_TIMEOUT_MS, overridable per entry by the settings block's own
// `timeout`). This invoker adds no second, independently-tuned clock -- the exact reasoning
// bridge-invoker.ts's header already records. What it DOES own is making the runner's timeout
// effective on a real process: on abort it sends SIGTERM, then SIGKILL after a short grace, and it
// kills in `finally` on every path, so an abandoned hook process can never outlive its invocation.
import { spawn } from "node:child_process";
import type { HookInvocationRequest, HookInvoker } from "./runner.ts";
import type { SourcedHookEntry } from "./registry.ts";

/** Grace between SIGTERM and SIGKILL. Short: by the time this fires the runner has already given up on the hook. */
export const COMMAND_HOOK_KILL_GRACE_MS = 250;

/** stderr is captured for diagnostics only and is bounded -- a hook that writes megabytes to stderr must not be able to grow an error message without limit. */
const MAX_STDERR_CAPTURE = 4096;

export class CommandHookError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandHookError";
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
}

/**
 * Wraps `opts.next`, executing any invocation whose `hookId` belongs to a command-bearing entry as a
 * subprocess instead.
 *
 * The entry list is snapshotted at construction, matching `buildHookRegistry`'s own "a registry is
 * immutable for the life of a run" contract -- a run builds both from the same entries.
 */
export function createCommandHookInvoker(entries: readonly SourcedHookEntry[], opts: CommandHookInvokerOptions): HookInvoker {
  const commandsById = new Map<string, string>();
  for (const entry of entries) {
    if (entry.command !== undefined && entry.command.length > 0) commandsById.set(entry.id, entry.command);
  }
  const killGraceMs = opts.killGraceMs ?? COMMAND_HOOK_KILL_GRACE_MS;
  const shellPath = opts.shellPath ?? "/bin/sh";

  return {
    async invoke(request: HookInvocationRequest, invokeOpts: { signal: AbortSignal }): Promise<unknown> {
      const command = commandsById.get(request.hookId);
      if (command === undefined) return opts.next.invoke(request, invokeOpts);
      return runCommandHook(command, request, invokeOpts.signal, { cwd: opts.cwd, ...(opts.env !== undefined ? { env: opts.env } : {}), shellPath, killGraceMs });
    },
  };
}

async function runCommandHook(
  command: string,
  request: HookInvocationRequest,
  signal: AbortSignal,
  cfg: { cwd: string; env?: Record<string, string | undefined>; shellPath: string; killGraceMs: number },
): Promise<unknown> {
  // ARGV FORM, never `shell: true`. The command itself is an author-supplied shell string (that is
  // what a `{type:"command"}` block IS), so a shell interprets it -- but it is passed as an ARGUMENT
  // to that shell, never concatenated into a larger command line. Nothing from the REQUEST is ever
  // interpolated into the command: the hook's input rides stdin as JSON, which is the whole reason
  // the §10 payload is a stdin contract and not an argv one.
  const child = spawn(cfg.shellPath, ["-c", command], {
    cwd: cfg.cwd,
    ...(cfg.env !== undefined ? { env: cfg.env as NodeJS.ProcessEnv } : {}),
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

    // The §10 request payload, verbatim -- the SAME object shape the bridge invoker sends a host, so
    // a hook author writes one parser regardless of which topology invokes them. Written
    // fire-and-forget: a hook that exits without reading stdin produces EPIPE, which is normal (the
    // error listener swallows it), and awaiting the write's callback would be a second promise that
    // can outlive a killed child.
    child.stdin.on("error", () => {
      /* EPIPE when a hook exits without reading stdin -- normal, not a failure */
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);

    const exit = await exitPromise;

    if (exit.signalName !== null) {
      throw new CommandHookError(`hook command was terminated by ${exit.signalName}: ${command}`, null, stderr.slice(0, MAX_STDERR_CAPTURE));
    }
    if (exit.code !== 0) {
      throw new CommandHookError(`hook command exited with code ${exit.code}: ${command}`, exit.code, stderr.slice(0, MAX_STDERR_CAPTURE));
    }
    const trimmed = stdout.trim();
    if (trimmed.length === 0) return {}; // acknowledgement: ran, said nothing
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new CommandHookError(`hook command produced unparseable output (WS-08 §8: a malformed output is an error of that hook): ${command}`, exit.code, stderr.slice(0, MAX_STDERR_CAPTURE));
    }
  } finally {
    // Every path, including a throw and an abort: an abandoned hook process must never outlive its
    // invocation. macOS has no `timeout(1)`, so this is the only backstop there is.
    signal.removeEventListener("abort", onAbort);
    if (killTimer !== undefined) clearTimeout(killTimer);
    killTree("SIGKILL");
  }
}
