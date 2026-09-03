// Task 3 (Lane C, WS-12 §3/§4): execution-path SELECTION and the actual OS-level spawn. Everything
// platform-specific lives here (never in profile.ts, which stays pure/linux-safe): resolving the
// real per-user temp dir via `getconf`, checking /usr/bin/sandbox-exec, and the real child_process
// spawn with process-group kill semantics (WS-12 §5.2, carried verbatim from Norma's
// agent/tools/bash.ts).
//
// This module is the single place tools/impl/bash.ts and tools/impl/monitor.ts both go through for
// "run a shell command under whatever fence the effective config selects" -- keeping the sandbox
// MECHANISM (this file + profile.ts) independent of either tool's own contract (output capping,
// background-task registration, WS message framing, ...).
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import {
  buildSeatbeltProfile,
  canonicalizePath,
  resolveNetworkPosture,
  type SandboxSettings,
} from "./profile.ts";

// ---------------------------------------------------------------------------------------------
// §3: sandbox availability (darwin + /usr/bin/sandbox-exec present)
// ---------------------------------------------------------------------------------------------

const REAL_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

// `checkPath` is a TEST-ONLY injection seam (never used for the real spawn below, which always
// targets the real binary once this check passes) -- WS-12 §3's "typed unavailability error" path
// needs to be exercised on a machine that legitimately HAS sandbox-exec (this dev box does), so the
// unavailable branch must be reachable without uninstalling anything.
export function isSandboxAvailable(checkPath: string = REAL_SANDBOX_EXEC_PATH): boolean {
  return process.platform === "darwin" && existsSync(checkPath);
}

// WS-12 §3: "sandboxed execution MUST fail with a typed unavailability error -- never silently
// degrade to an unsandboxed spawn." A named class so a caller (tools/impl/bash.ts) can map it onto
// the `"unavailable"` posture in the tool result (§8) rather than a generic execution failure.
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

// ---------------------------------------------------------------------------------------------
// macOS per-user temp dir (WS-12 §5.2, verbatim carry from Norma's agent/sandbox.ts)
// ---------------------------------------------------------------------------------------------

// Resolved the SAME way the C library resolves it -- confstr(_CS_DARWIN_USER_TEMP_DIR), which
// `getconf DARWIN_USER_TEMP_DIR` exposes -- deliberately NOT os.tmpdir() (which reads $TMPDIR, and
// the bash tool overrides $TMPDIR for its own child to the per-session scratch dir; this needs the
// directory the child's libc will actually use no matter what the environment says). Cached for the
// process: fixed per user per boot, and this is on the path of every sandboxed call. A failure to
// resolve degrades to `null` (the mktemp convenience rule is simply omitted) rather than throwing.
let darwinTempDirCache: string | null | undefined;

export function resolveDarwinUserTempDir(): string | null {
  if (darwinTempDirCache !== undefined) return darwinTempDirCache;
  darwinTempDirCache = null;
  if (process.platform === "darwin") {
    try {
      const out = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
      const raw = out.stdout?.trim();
      if (raw) darwinTempDirCache = canonicalizePath(raw.replace(/\/+$/, ""));
    } catch {
      /* leave null */
    }
  }
  return darwinTempDirCache;
}

/** Test seam: forget the cached per-user temp dir so a test can observe resolution again. */
export function resetDarwinUserTempDirCacheForTest(): void {
  darwinTempDirCache = undefined;
}

// ---------------------------------------------------------------------------------------------
// §4.1: execution-path selection
// ---------------------------------------------------------------------------------------------

// §8's own vocabulary ("sandboxed / excluded / override-requested / unavailable"), plus
// "config-disabled" for the `enabled: false` row -- so a future auto-engine envelope integration
// maps 1:1 onto this type without a translation table. `resolveExecutionPath` below never itself
// produces "unavailable" (that is a FAILURE MODE of the "sandboxed" outcome once availability is
// actually checked, at spawn time -- see `runCommand`), but the union lives here because it is the
// one callers (tools/impl/*.ts) surface in a tool result.
export type SandboxPosture = "config-disabled" | "override-requested" | "excluded" | "sandboxed" | "unavailable";

export interface ResolveExecutionPathInput {
  settings: SandboxSettings;
  dangerouslyDisableSandbox?: boolean;
  command: string;
}

export interface ExecutionPathDecision {
  posture: Exclude<SandboxPosture, "unavailable">;
  /**
   * WS-12 §4: the call's OWN raw `dangerouslyDisableSandbox` flag, independent of which posture
   * actually won the first-match-wins table below -- so a result can show "the model asked for the
   * override" even on the rare path where `enabled: false` already made it moot (row 1 beats row 2).
   */
  sandboxOverrideRequested: boolean;
}

/**
 * WS-12 §4.1's own table, first-match-wins:
 *   1. `sandbox.enabled === false`                                  -> unsandboxed (config-disabled)
 *   2. `dangerouslyDisableSandbox: true` on the call                -> unsandboxed (override-requested)
 *   3. command matches `excludedCommands` AND `allowUnsandboxedCommands` -> unsandboxed (excluded)
 *   4. otherwise                                                    -> sandboxed
 *
 * R3-6 (capture-pending, per this task's own brief): `excludedCommands` matching is EXACT-FULL-
 * COMMAND-STRING equality only -- no trimming, no argv[0] extraction, no prefix rule. WS-12 §12
 * open question 2 leaves the real matching semantics for a future WS-17 differential capture; this
 * is the deliberately narrow placeholder until that capture lands.
 */
export function resolveExecutionPath(input: ResolveExecutionPathInput): ExecutionPathDecision {
  const sandboxOverrideRequested = input.dangerouslyDisableSandbox === true;
  if (input.settings.enabled === false) return { posture: "config-disabled", sandboxOverrideRequested };
  if (sandboxOverrideRequested) return { posture: "override-requested", sandboxOverrideRequested };
  const isExcluded = input.settings.excludedCommands?.includes(input.command) === true;
  if (isExcluded && input.settings.allowUnsandboxedCommands === true) {
    return { posture: "excluded", sandboxOverrideRequested };
  }
  return { posture: "sandboxed", sandboxOverrideRequested };
}

// ---------------------------------------------------------------------------------------------
// runCommand: the real spawn, process-group kill, and 5 GB stream-kill (WS-12 §5.2/§6.3)
// ---------------------------------------------------------------------------------------------

const DEFAULT_MAX_STREAMED_BYTES = 5 * 1024 ** 3; // WS-12 §6.3: >5 GB streamed output kills the command

export interface RunCommandOptions {
  command: string;
  /** Real, existing, already-canonicalized directory to spawn the shell in. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  /**
   * Fires synchronously once the child is spawned, before any output arrives -- the ONLY way a
   * caller can learn the process-group pid early enough to track/kill it while it is still
   * running (`RunCommandResult.exitCode` etc. only resolve once the process has already exited).
   * `run_in_background` callers (tools/impl/bash.ts) need this to register the task BEFORE
   * awaiting the eventual result; a foreground caller simply omits it.
   */
  onSpawned?: (info: { pid: number }) => void;
  maxStreamedBytes?: number;
  settings: SandboxSettings;
  dangerouslyDisableSandbox?: boolean;
  /**
   * TEST-ONLY injection seam: overrides which path the internal `isSandboxAvailable` check probes
   * for existence, WITHOUT changing the real spawn target (`REAL_SANDBOX_EXEC_PATH` below is always
   * what actually runs once availability passes). WS-12 §3's typed-unavailability path is otherwise
   * unreachable on any dev/CI box that genuinely has /usr/bin/sandbox-exec -- which is every darwin
   * box this product ships on -- so without this seam the throw site below has zero live coverage.
   * Never read from model input (bash.ts's own BashInput has no such field): a model-controllable
   * override of its own sandbox-availability check would be a containment hole, not a test seam.
   */
  sandboxExecPath?: string;
  /** Extra writable roots beyond cwd -- session scratch, configured filesystem.allowWrite, outputs dir. */
  writableRoots?: string[];
  denyWritePaths?: string[];
  denyReadPaths?: string[];
}

export interface RunCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  streamKilled: boolean;
  posture: Exclude<SandboxPosture, "unavailable">;
  sandboxOverrideRequested: boolean;
  /** The generated SBPL profile text, only present when posture === "sandboxed" (debug/test aid). */
  profile?: string;
  /** Set when the child never actually launched (Node's "error" event) -- distinct from a signal-killed exit (exitCode null, this unset). */
  spawnError?: string;
}

// `async` is deliberate, not decorative: resolveNetworkPosture (below) throws SYNCHRONOUSLY on a
// domain-list config, and this function's own SandboxUnavailableError construction is a plain
// `throw` too -- wrapping the whole body in an async function is what turns BOTH into a rejected
// promise (`.rejects.toBeInstanceOf(...)`-shaped) instead of a synchronous throw at the call site,
// which a plain non-async function returning `new Promise(...)` would NOT do for a throw that
// happens before that `return` statement is ever reached.
export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const { posture, sandboxOverrideRequested } = resolveExecutionPath({
    settings: opts.settings,
    command: opts.command,
    ...(opts.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: opts.dangerouslyDisableSandbox } : {}),
  });

  let spawnFile: string;
  let spawnArgs: string[];
  let profile: string | undefined;

  if (posture === "sandboxed") {
    // §3: never silently degrade to an unsandboxed spawn -- a typed error, before any process
    // starts, is the only outcome when the sandbox is required but unavailable.
    if (!isSandboxAvailable(opts.sandboxExecPath)) {
      throw new SandboxUnavailableError(
        "sandbox is required by the effective configuration but /usr/bin/sandbox-exec is unavailable on this host (WS-12 §3) -- refusing to silently run unsandboxed",
      );
    }
    const allowNetwork = resolveNetworkPosture(opts.settings.network); // throws SandboxConfigError on a domain-list config -- propagates to the caller uncaught, by design (§2/§12)
    const darwinUserTempDir = resolveDarwinUserTempDir();
    profile = buildSeatbeltProfile({
      cwd: opts.cwd,
      ...(opts.writableRoots !== undefined ? { writableRoots: opts.writableRoots } : {}),
      ...(opts.denyWritePaths !== undefined ? { denyWritePaths: opts.denyWritePaths } : {}),
      ...(opts.denyReadPaths !== undefined ? { denyReadPaths: opts.denyReadPaths } : {}),
      allowNetwork,
      ...(darwinUserTempDir !== null ? { darwinUserTempDir } : {}),
    });
    spawnFile = REAL_SANDBOX_EXEC_PATH;
    spawnArgs = ["-p", profile, "/bin/bash", "-c", opts.command];
  } else {
    // config-disabled / override-requested / excluded: no seatbelt wrapper at all (§4.1 table).
    spawnFile = "/bin/bash";
    spawnArgs = ["-c", opts.command];
  }

  const maxStreamedBytes = opts.maxStreamedBytes ?? DEFAULT_MAX_STREAMED_BYTES;

  return new Promise<RunCommandResult>((resolve) => {
    const child = spawn(spawnFile, spawnArgs, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Process-group kill (WS-12 §5.2, carried): `detached: true` makes this child its own group
      // leader (setsid), so a negative-pid signal below reaps sandbox-exec + bash + any forked or
      // backgrounded grandchildren -- closing every pipe fd so stream collection unblocks promptly.
      detached: true,
      env: opts.env,
    });
    if (child.pid !== undefined) opts.onSpawned?.({ pid: child.pid });

    let streamedBytes = 0;
    let streamKilled = false;
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* group already gone */
      }
    };
    const onChunk = (chunk: Buffer, forward: ((c: Buffer) => void) | undefined) => {
      if (streamKilled) return;
      forward?.(chunk);
      streamedBytes += chunk.length;
      if (streamedBytes > maxStreamedBytes) {
        streamKilled = true;
        killGroup();
      }
    };
    child.stdout.on("data", (d: Buffer) => onChunk(d, opts.onStdout));
    child.stderr.on("data", (d: Buffer) => onChunk(d, opts.onStderr));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    let spawnError: string | undefined;
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        timedOut,
        aborted,
        streamKilled,
        posture,
        sandboxOverrideRequested,
        ...(profile !== undefined ? { profile } : {}),
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      spawnError = (err as Error).message;
      finish(null);
    });
  });
}
