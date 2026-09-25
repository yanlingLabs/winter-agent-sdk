// Phase 5 Lane W (task 4), WS-11 §1.7 / WS-12 §5.2: how the worker subprocess is actually launched.
//
// TWO CONCERNS, both small and both easy to get silently wrong:
//
// 1. THE COMPILED-VS-DEV SPLIT. `process.execPath` is always the file to spawn, but the two legs
//    differ by one argv slot: compiled, the self binary IS the executable and the flags follow it
//    directly; in dev, `process.execPath` is `bun` and it needs the entry script handed to it first.
//    Norma's original discriminated on `Bun.main` containing `/$bunfs/`; this checks the module's own
//    `import.meta.url` as well, because under `bun test` `Bun.main` is the TEST RUNNER, not main.ts.
//    The dev entry is `main.ts`, not `subprocess-entry.ts`: main.ts owns the argv dispatch (R5-15),
//    and subprocess-entry.ts has no `import.meta.main` self-exec of its own.
//
// 2. THE SEATBELT, WITH `home`. T3's fix round made `buildWorkflowWorkerSeatbeltProfile`'s second
//    argument REQUIRED (`opts: { home: string | undefined }`) precisely so that "Lane W's spawner
//    must remember to pass it" is a compile error rather than a silent gap -- omitting it used to
//    drop the run-directory read-deny with nothing to notice. `buildWorkerSpawn` is still the ONE
//    place a worker command becomes a spawn, so the value is threaded through exactly one call site.
import { fileURLToPath } from "node:url";
import { buildWorkflowWorkerSeatbeltProfile, type SandboxBrand } from "../sandbox/profile.ts";
import { isSandboxAvailable } from "../sandbox/spawn.ts";
// The argv contract lives with the ENTRY that reads it (subprocess-entry.ts), never in main.ts --
// see that module's own header for why main.ts cannot be imported at all. Re-exported here so a
// spawner needs one import, not two.
import { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG } from "./subprocess-entry.ts";

export { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG };

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

export interface WorkerCommand {
  file: string;
  args: string[];
}

export interface ResolveWorkerCommandOptions {
  /**
   * Overridable for tests; defaults to a real detection of the single-file `$bunfs` executable.
   * Stating either field bypasses a host command installed by `setHostWorkflowWorkerCommand`.
   */
  compiled?: boolean;
  execPath?: string;
}

/** True inside a `bun build --compile` single-file executable. */
export function isCompiledBinary(): boolean {
  if (import.meta.url.includes("$bunfs")) return true;
  return typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.includes("$bunfs");
}

// --- WS-23: the HOST's worker command (embedded sessions) -------------------------------------------
//
// The default below assumes `process.execPath` is a `winter` binary whose main routes
// `__workflow-worker --bridge` to `workflowWorkerMain`. That holds for a spawned `winter` child and
// for `bun src/main.ts`, and it is FALSE for an embedded session: there `process.execPath` is the
// HOST's own binary. Measured on Winter's daemon (`winter-core`), whose `main.ts` sends ANY argv
// containing `__workflow-worker` to the daemon's own, different workflow worker without looking at
// `--bridge` -- so a Workflow call from an embedded session would have launched the wrong program
// under the seatbelt and failed its bridge handshake.
//
// So the host says what to spawn, through this one setter, and the default is untouched for every
// other caller. MODULE STATE ON PURPOSE: an embedded session runs in its own Worker realm (one
// session per realm, the ruling that made embedding safe at all), so a realm-wide value IS a
// per-session value. `runEmbeddedSession` sets it for its run and restores the previous one after.
let hostWorkerCommand: WorkerCommand | undefined;

/**
 * Install the host's workflow-worker command for this realm; returns a restore function. `undefined`
 * clears it (the default applies again). The command is copied, so a caller mutating its own object
 * afterwards changes nothing here.
 */
export function setHostWorkflowWorkerCommand(command: WorkerCommand | undefined): () => void {
  const previous = hostWorkerCommand;
  hostWorkerCommand = command === undefined ? undefined : { file: command.file, args: [...command.args] };
  return () => {
    hostWorkerCommand = previous;
  };
}

export function resolveWorkerCommand(opts: ResolveWorkerCommandOptions = {}): WorkerCommand {
  // The host's command wins over the DERIVED default -- but not over a caller that states its own
  // `compiled`/`execPath` (the unit tests of the derivation itself, which must keep testing it).
  if (hostWorkerCommand !== undefined && opts.compiled === undefined && opts.execPath === undefined) {
    return { file: hostWorkerCommand.file, args: [...hostWorkerCommand.args] };
  }
  const execPath = opts.execPath ?? process.execPath;
  const compiled = opts.compiled ?? isCompiledBinary();
  if (compiled) {
    // The self binary IS the executable; main.ts's dispatch routes on the flag.
    return { file: execPath, args: [WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG] };
  }
  // DEV/TEST: execPath is `bun`. Resolved LAZILY, inside this branch: an `import.meta.url`-relative
  // path does not survive `bun build --compile` (main.ts's own header), and evaluating it eagerly at
  // module scope would compute a `/$bunfs/...` path in the compiled binary for no reason.
  const entry = fileURLToPath(new URL("../main.ts", import.meta.url));
  return { file: execPath, args: [entry, WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_BRIDGE_FLAG] };
}

export interface BuildWorkerSpawnOptions {
  command: WorkerCommand;
  /**
   * The session's WINTER HOME. Supplying it is what emits the run-directory read-deny (R5-5);
   * `undefined` opts out EXPLICITLY, which is the only way to opt out now that the profile builder's
   * own argument is required. Every production call site passes a real value, and worker.test.ts pins
   * the difference between the two profiles.
   */
  home?: string;
  /**
   * The RESOLVED Winter home (fix wave I1, the resolved-home class): when it is not
   * `<home>/<homeDirName>`, the profile ALSO denies `<winterHome>/run` -- a `<PREFIX>HOME` pointing
   * at a differently-named root is otherwise unprotected. Both anchors are emitted; overlapping
   * denies cost nothing.
   */
  winterHome?: string;
  /** P7a (D19): the session's brand -- the dot-dir names the worker profile fences. */
  brand?: SandboxBrand;
}

/** The actual `(file, args)` to spawn: sandbox-exec wrapping the worker command under the tight profile. */
export function buildWorkerSpawn(opts: BuildWorkerSpawnOptions): WorkerCommand {
  const profile = buildWorkflowWorkerSeatbeltProfile(opts.command.file, {
    home: opts.home,
    ...(opts.winterHome !== undefined ? { winterHome: opts.winterHome } : {}),
    ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
  });
  return { file: SANDBOX_EXEC_PATH, args: ["-p", profile, opts.command.file, ...opts.command.args] };
}

/** WS-12 §3's own availability rule, reused rather than re-derived. */
export function workflowSandboxAvailable(): boolean {
  return isSandboxAvailable();
}

export { SANDBOX_EXEC_PATH };
