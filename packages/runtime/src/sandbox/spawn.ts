import { DEFAULT_MAX_STREAMED_BYTES } from "./execution-limits.ts";
import type { HostOutputTransport } from "./host-output.ts";
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
  type SandboxBrand,
  canonicalizePath,
  resolveNetworkPosture,
  type SandboxSettings,
} from "./profile.ts";
import { globDenyEntriesOf, splitDenyPathsByGlobShape, type GlobDenyEntry } from "../permissions/file-rules.ts";
import { currentHostCodeProtectionPaths } from "./host-code-protection.ts";
import { trackProcessGroup } from "../process-groups.ts";
import { buildMandatoryFloorProfile, hasMandatoryFloor, type HostExecutionFloor, type HostCodeProcessScope, type HostCodeProcessHandle } from "@yanlinglabs/winter-agent-sdk";
import { currentHostCodeProcessClient, hostCodeProcessBrokerRequired, requireBoundHandle } from "./host-code-process.ts";
import { currentHostChildFloorProfile, prepareHostChildLaunch } from "./host-child-floor.ts";
import { newSandboxViolationTag, startViolationMonitor, tagSeatbeltDenials, VIOLATION_STREAM_MARGIN_SECONDS, type SandboxViolationReport, type ViolationMonitor } from "./violations.ts";

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
      const launch = prepareHostChildLaunch("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"]);
      const out = spawnSync(launch.command, launch.args, { encoding: "utf8" });
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
 *   2. `dangerouslyDisableSandbox: true` on the call, UNLESS `allowUnsandboxedCommands === false`
 *                                                                   -> unsandboxed (override-requested)
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
  // `allowUnsandboxedCommands: false` IGNORES the override (dist-session fixes, lane C C3): the
  // command runs sandboxed, as claude runs it when unsandboxed commands are disallowed by policy (the
  // override only takes a command out of the sandbox when the policy allows unsandboxed commands), and
  // the request is still recorded on the result. It used to honour the override whatever the policy
  // said.
  if (sandboxOverrideRequested && input.settings.allowUnsandboxedCommands !== false) return { posture: "override-requested", sandboxOverrideRequested };
  const isExcluded = input.settings.excludedCommands?.includes(input.command) === true;
  if (isExcluded && input.settings.allowUnsandboxedCommands === true) {
    return { posture: "excluded", sandboxOverrideRequested };
  }
  return { posture: "sandboxed", sandboxOverrideRequested };
}

// ---------------------------------------------------------------------------------------------
// runCommand: the real spawn, process-group kill, and 5 GB stream-kill (WS-12 §5.2/§6.3)
// ---------------------------------------------------------------------------------------------


async function runBrokeredCommand(opts: RunCommandOptions, bound: NonNullable<ReturnType<typeof currentHostCodeProcessClient>>): Promise<RunCommandResult> {
  if (!opts.hostCodeScope?.toolUseId) throw new SandboxUnavailableError("host Code execution requires an authenticated active tool call");
  if (opts.signal?.aborted) throw new SandboxUnavailableError("host Code execution cancelled before admission");
  const scope = { ...opts.hostCodeScope, generationId: bound.generationId };
  let handle: HostCodeProcessHandle | undefined;
  let released = false;
  const onAbort = () => { if (handle) void bound.client.signal(handle, "SIGKILL").catch(() => {}); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const started = await bound.client.start({ version: 1, ...scope, kind: "command", command: opts.matchCommand ?? opts.command, ...(opts.pwdCapturePath !== undefined ? {pwdCapturePath:opts.pwdCapturePath} : {}), cwd: opts.cwd, timeoutMs: opts.timeoutMs, maxStreamedBytes: opts.maxStreamedBytes ?? DEFAULT_MAX_STREAMED_BYTES, sandboxIntent: opts.dangerouslyDisableSandbox ? "override-requested" : "ordinary" }, opts.signal);
    requireBoundHandle(started.handle, scope); handle = started.handle;
    if (!["sandboxed", "config-disabled", "excluded", "override-requested"].includes(started.posture)) throw new SandboxUnavailableError("host Code broker returned invalid posture");
    if (opts.signal?.aborted) onAbort();
    const ownedHandle = handle;
    opts.onSpawned?.({ pid: ownedHandle.pid, stopOwnedProcess() {
      // The stable host handle, never the display PID, is signal authority. Completed/released
      // commands cannot re-signal even if their PID has since been reused.
      if (!released) void bound.client.signal(ownedHandle, "SIGKILL").catch(() => {});
    } });
    let sequence = 0;
    for (;;) {
      // Poll cancellation does not hide exit: the host must stop the process then provide exit evidence.
      const reply = await bound.client.poll(handle, sequence);
      requireBoundHandle(reply.handle, scope);
      if (reply.handle.id !== handle.id || reply.handle.pid !== handle.pid || !Array.isArray(reply.events)) throw new SandboxUnavailableError("host Code poll returned a foreign process");
      let bytes = 0;
      for (const event of reply.events) {
        if (event.sequence !== sequence + 1 || (event.stream !== "stdout" && event.stream !== "stderr") || typeof event.dataBase64 !== "string") throw new SandboxUnavailableError("host Code output sequence/schema invalid");
        const chunk = Buffer.from(event.dataBase64, "base64");
        if (chunk.toString("base64") !== event.dataBase64 || (bytes += chunk.length) > 65536) throw new SandboxUnavailableError("host Code output exceeds the admitted poll bound");
        sequence = event.sequence;
        (event.stream === "stdout" ? opts.onStdout : opts.onStderr)?.(chunk);
      }
      if (reply.exit) {
        if ((reply.exit.code !== null && (!Number.isInteger(reply.exit.code) || reply.exit.code < 0 || reply.exit.code > 255)) || [reply.exit.timedOut,reply.exit.aborted,reply.exit.streamKilled].some(value=>typeof value!=="boolean")) throw new SandboxUnavailableError("host Code exit schema invalid");
        await bound.client.release(handle,sequence);
        released = true;
        return { exitCode: reply.exit.code, timedOut: reply.exit.timedOut, aborted: reply.exit.aborted, streamKilled: reply.exit.streamKilled, posture: started.posture, sandboxOverrideRequested: opts.dangerouslyDisableSandbox === true };
      }
    }
  } catch (error) {
    if (handle) await bound.client.signal(handle, "SIGKILL").catch(() => {});
    throw new SandboxUnavailableError(`host Code broker unavailable; no local execution fallback (${error instanceof Error ? error.name : "error"})`);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (handle && !released) await bound.client.release(handle, 0, { abandon: true }).catch(() => {});
  }
}

export interface RunCommandOptions {
  /** Trusted host lifecycle owner; called only for the OS child close event. */
  onProcessClosed?: ()=>void;
  /** Trusted broker only: use parent-owned POSIX read fds instead of Bun eager buffers. */
  hostOwnedOutput?: HostOutputTransport;
  /** Trusted host parent only, separate from SandboxSettings; never a model input. */
  mandatoryFloor?: HostExecutionFloor;
  hostCodeScope?: Omit<HostCodeProcessScope, "generationId">;
  command: string;
  /**
   * Task 8 (P3 close-out, "excludedCommands raw-match" MUST): the command string `resolveExecutionPath`
   * matches against `settings.excludedCommands`, when it differs from `command` above (the string
   * that actually gets spawned). Defaults to `command` when omitted -- byte-identical to every caller
   * before this field existed (background execution, Monitor's command half, both of which already
   * spawn the model's raw command with no wrapper). bash.ts's own foreground path is the one caller
   * that needs this: it wraps the raw command in a pwd-capture script before spawning (see that
   * file's own `buildPwdCaptureScript`/`runForeground` header comment, "LATENT TRAP") but must match
   * `excludedCommands` against what the model/settings author actually wrote, never the wrapper.
   */
  matchCommand?: string;
  /** SDK-generated scratch path; broker parent independently validates it and renders the wrapper. */
  pwdCapturePath?: string;
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
  onSpawned?: (info: { pid: number; stopOwnedProcess?: () => void; pauseOutput?: () => void; resumeOutput?: () => void }) => void;
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
  /**
   * Fix round 11: glob-shaped `denyWritePaths`/
   * `denyReadPaths` entries, PRE-CONVERTED to SBPL regex source by the caller (`permissions/
   * file-rules.ts`'s `splitDenyPathsByGlobShape`) -- this module stays glob-grammar-free, exactly
   * like `denyWritePaths`/`denyReadPaths` themselves are already resolved, absolute paths by the
   * time they reach here.
   */
  denyWriteRegexes?: string[];
  denyReadRegexes?: string[];
  /**
   * Fix round 12: the ancestor-rename-bypass fix -- each
   * glob-shaped `denyWritePaths`/`denyReadPaths` entry's OWN canonicalized fixed-prefix directory
   * (see `SeatbeltProfileInput.denyWriteGlobFixedPrefixes`'s own header). Same "caller pre-resolves,
   * this module stays glob-grammar-free" posture as `denyWriteRegexes`/`denyReadRegexes` above.
   */
  denyWriteGlobFixedPrefixes?: string[];
  denyReadGlobFixedPrefixes?: string[];
  /**
   * Fix round 13: the read-deny-keep-in-place fix -- each glob-shaped `denyReadPaths` entry, PAIRED
   * with its own fixed prefix (see `SeatbeltProfileInput.denyReadGlobEntries`'s own header).
   * Read-side only -- keeping read-denied paths in place is a read-deny-specific concern.
   */
  denyReadGlobEntries?: GlobDenyEntry[];
  /**
   * WS-12 §2: the caller's `ctx.home`, threaded straight through to `buildSeatbeltProfile`'s own
   * `home` field for the baseline `<home>/<homeDirName>/run` read denial -- see that field's own header
   * for why this module (rather than profile.ts) is where a real `ctx.home` value gets plugged in.
   * Omitted -> no baseline deny is emitted, same graceful-degradation posture as every other
   * optional profile input here.
   */
  home?: string;
  /** Phase 5 fix wave, I1: the resolved winter root -- see `SeatbeltProfileInput.winterHome`. */
  winterHome?: string;
  /** WS-21 §3.7: the shared runtime home's durable-paths root -- see `SeatbeltProfileInput.storeHome`. */
  storeHome?: string;
  /** P7a (D19): the session's brand -- the dot-dir names the profile fences. Omitted = `WINTER_BRAND`. */
  brand?: SandboxBrand;
  /** Fix round 15: see `SeatbeltProfileInput.allowGitConfigWrites`'s own header. Omitted = `false`. */
  allowGitConfigWrites?: boolean;
  /**
   * Report this run's Seatbelt denials if it FAILS (`sandbox/violations.ts`): only a `"sandboxed"`
   * posture on the local path, only the SDK's own profile (never a host floor composed onto it --
   * `dangerouslyDisableSandbox` cannot lift a floor, so its denials are no reason to retry). The
   * profile is tagged and the command spawned only once a `log stream` for the tag is confirmed live;
   * a success kills the stream without waiting, a failure (not an interrupt) drains it briefly and the
   * result carries `sandboxViolations`. Omitted = untagged, no stream, byte-identical to before; the
   * foreground Bash path is the one caller that asks.
   */
  reportViolations?: boolean;
}

export interface RunCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  streamKilled: boolean;
  posture: Exclude<SandboxPosture, "unavailable">;
  sandboxOverrideRequested: boolean;
  /** The generated SBPL profile text, only present when posture === "sandboxed" (debug/test aid). Never carries the per-run violation tag. */
  profile?: string;
  /** Set when the child never actually launched (Node's "error" event) -- distinct from a signal-killed exit (exitCode null, this unset). */
  spawnError?: string;
  /** Present when `reportViolations` was honoured and the run failed with denials of its own (`formatSandboxViolations` renders it). */
  sandboxViolations?: SandboxViolationReport;
}

// `async` is deliberate, not decorative: resolveNetworkPosture (below) throws SYNCHRONOUSLY on a
// domain-list config, and this function's own SandboxUnavailableError construction is a plain
// `throw` too -- wrapping the whole body in an async function is what turns BOTH into a rejected
// promise (`.rejects.toBeInstanceOf(...)`-shaped) instead of a synchronous throw at the call site,
// which a plain non-async function returning `new Promise(...)` would NOT do for a throw that
// happens before that `return` statement is ever reached.
export async function runCommand(opts: RunCommandOptions): Promise<RunCommandResult> {
  const bound = currentHostCodeProcessClient();
  if (bound) return runBrokeredCommand(opts, bound);
  if (hostCodeProcessBrokerRequired()) throw new SandboxUnavailableError("required host Code broker unavailable; no local execution fallback");
  return runCommandLocally(opts);
}

/** Trusted parent entry; bypasses the child's RPC client, never its mandatory kernel floor. */
export async function runCommandLocally(opts: RunCommandOptions): Promise<RunCommandResult> {
  const { posture, sandboxOverrideRequested } = resolveExecutionPath({
    settings: opts.settings,
    command: opts.matchCommand ?? opts.command,
    ...(opts.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: opts.dangerouslyDisableSandbox } : {}),
  });

  let spawnFile: string;
  let spawnArgs: string[];
  let profile: string | undefined;
  // What sandbox-exec actually loads: `profile`, plus the per-run violation tag when one was asked
  // for (`reportViolations`). `profile` itself stays untagged -- it is what the result reports.
  let spawnProfile: string | undefined;
  let violationTag: string | undefined;

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
    const protection = currentHostCodeProtectionPaths();
    const read = splitDenyPathsByGlobShape(protection.denyReadPaths), write = splitDenyPathsByGlobShape(protection.denyWritePaths);
    profile = buildSeatbeltProfile({
      cwd: opts.cwd,
      ...(opts.writableRoots !== undefined ? { writableRoots: opts.writableRoots } : {}),
      denyWritePaths: [...(opts.denyWritePaths ?? []), ...new Set([...protection.denyWritePaths, ...write.paths])],
      denyReadPaths: [...(opts.denyReadPaths ?? []), ...new Set([...protection.denyReadPaths, ...read.paths])],
      denyWriteRegexes: [...(opts.denyWriteRegexes ?? []), ...write.regexes],
      denyReadRegexes: [...(opts.denyReadRegexes ?? []), ...read.regexes],
      denyWriteGlobFixedPrefixes: [...(opts.denyWriteGlobFixedPrefixes ?? []), ...write.globFixedPrefixes],
      denyReadGlobFixedPrefixes: [...(opts.denyReadGlobFixedPrefixes ?? []), ...read.globFixedPrefixes],
      denyReadGlobEntries: [...(opts.denyReadGlobEntries ?? []), ...globDenyEntriesOf(protection.denyReadPaths)],
      allowNetwork,
      ...(darwinUserTempDir !== null ? { darwinUserTempDir } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
      // Phase 5 fix wave, I1: the RESOLVED winter root, so the run/backups denies land where a
      // session's own storage actually is under a custom `<PREFIX>HOME`.
      ...(opts.winterHome !== undefined ? { winterHome: opts.winterHome } : {}),
      // WS-21 §3.7: the shared store home, when the router supplied one -- see `SeatbeltProfileInput.storeHome`.
      ...(opts.storeHome !== undefined ? { storeHome: opts.storeHome } : {}),
      ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
      ...(opts.allowGitConfigWrites !== undefined ? { allowGitConfigWrites: opts.allowGitConfigWrites } : {}),
    });
    spawnProfile = profile;
    if (opts.reportViolations === true) {
      const tag = newSandboxViolationTag();
      const tagged = tagSeatbeltDenials(profile, tag);
      // An untaggable profile (never produced by buildSeatbeltProfile) runs untagged, and reports nothing.
      if (tagged !== undefined) {
        spawnProfile = tagged;
        violationTag = tag;
      }
    }
    spawnFile = REAL_SANDBOX_EXEC_PATH;
    spawnArgs = ["-p", spawnProfile, "/bin/bash", "-c", opts.command];
  } else {
    // config-disabled / override-requested / excluded: no seatbelt wrapper at all (§4.1 table).
    spawnFile = "/bin/bash";
    spawnArgs = ["-c", opts.command];
  }
  const hostFloor = currentHostChildFloorProfile();
  if (hostFloor || (opts.mandatoryFloor && hasMandatoryFloor(opts.mandatoryFloor))) {
    if (!isSandboxAvailable()) throw new SandboxUnavailableError("mandatory host control floor unavailable");
    const profiles = [hostFloor, opts.mandatoryFloor && hasMandatoryFloor(opts.mandatoryFloor) ? buildMandatoryFloorProfile(opts.mandatoryFloor) : undefined].filter((value): value is string => value !== undefined);
    const floor = profiles[0]! + profiles.slice(1).map(value => `\n${value.split("\n").slice(2).join("\n")}`).join("");
    profile = profile === undefined ? floor : `${profile}\n${floor.split("\n").slice(2).join("\n")}`;
    spawnProfile = spawnProfile === undefined ? floor : `${spawnProfile}\n${floor.split("\n").slice(2).join("\n")}`;
    spawnFile = REAL_SANDBOX_EXEC_PATH;
    spawnArgs = ["-p", spawnProfile, "/bin/bash", "-c", opts.command];
  }

  const maxStreamedBytes = opts.maxStreamedBytes ?? DEFAULT_MAX_STREAMED_BYTES;

  const hostOutput = opts.hostOwnedOutput;
  // The violations stream must be SUBSCRIBED before the command starts, or a fast failure's denials
  // are gone before anyone listens. A stream that cannot confirm in time leaves the run unreported.
  let violationMonitor: ViolationMonitor | undefined;
  if (violationTag !== undefined) {
    violationMonitor = await startViolationMonitor(violationTag, {
      lifetimeSeconds: Math.ceil(opts.timeoutMs / 1000) + VIOLATION_STREAM_MARGIN_SECONDS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }
  return new Promise<RunCommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnFile, spawnArgs, {
        cwd: opts.cwd,
        stdio: ["ignore", hostOutput?.stdoutFd ?? "pipe", hostOutput?.stderrFd ?? "pipe"],
        // Process-group kill (WS-12 §5.2, carried): `detached: true` makes this child its own group
        // leader (setsid), so a negative-pid signal below reaps sandbox-exec + bash + any forked or
        // backgrounded grandchildren -- closing every pipe fd so stream collection unblocks promptly.
        detached: true,
        env: opts.env,
      });
    } catch (error) {
      violationMonitor?.stop(); // never leave a stream behind a command that did not start
      throw error;
    }
    // WS-24: the group is live from here until its leader closes -- mirrored to an embedded session's
    // host, which reaps it if the Worker dies without running the kill doors below (process-groups.ts).
    // Recorded BEFORE `onSpawned`, so no caller can learn the pid ahead of the ledger.
    hostOutput?.closeWriters();
    const releaseGroup = child.pid !== undefined ? trackProcessGroup(child.pid, "command") : () => {};
    if (child.pid !== undefined) opts.onSpawned?.({ pid: child.pid, pauseOutput() { if(hostOutput)hostOutput.pause();else{child.stdout!.pause(); child.stderr!.pause();} }, resumeOutput() { if(hostOutput)hostOutput.resume();else{child.stdout!.resume(); child.stderr!.resume();} } });

    let streamedBytes = 0;
    let streamKilled = false;
    let processClosed = false;
    const killGroup = () => {
      // Output may remain paused after the actual process closed. Its former
      // PID/group is no longer authority to signal anything during that drain.
      if (processClosed || child.pid === undefined) return;
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
    let outputDone: Promise<unknown> | undefined;
    try { outputDone = hostOutput?.start(chunk => onChunk(chunk, opts.onStdout), chunk => onChunk(chunk, opts.onStderr)); }
    catch (error) { outputDone = Promise.reject(error); }
    void outputDone?.catch(() => { streamKilled = true; hostOutput?.dispose(); killGroup(); });
    if (!hostOutput) {
      child.stdout!.on("data", (d: Buffer) => onChunk(d, opts.onStdout));
      child.stderr!.on("data", (d: Buffer) => onChunk(d, opts.onStderr));
    }

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
      releaseGroup();
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const result: RunCommandResult = {
        exitCode,
        timedOut,
        aborted,
        streamKilled,
        posture,
        sandboxOverrideRequested,
        ...(profile !== undefined ? { profile } : {}),
        ...(spawnError !== undefined ? { spawnError } : {}),
      };
      const monitor = violationMonitor;
      violationMonitor = undefined;
      if (monitor === undefined) return resolve(result);
      // A success, an interrupt (nobody reads its result) or a launch failure: the stream goes now,
      // without waiting. A real failure waits a bounded moment for its trailing denials.
      if ((exitCode === 0 && !timedOut) || aborted || spawnError !== undefined) {
        monitor.stop();
        return resolve(result);
      }
      void monitor.drain().then((report) => resolve(report.lines.length > 0 ? { ...result, sandboxViolations: report } : result));
    };

    child.on("close", (code) => {
      processClosed = true;
      clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort); releaseGroup();
      opts.onProcessClosed?.();
      if(outputDone)void outputDone.then(()=>finish(code),()=>finish(null));else finish(code);
    });
    child.on("error", (err) => {
      spawnError = (err as Error).message;
      hostOutput?.dispose();
      finish(null);
    });
  });
}
