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
  /** Overridable for tests; defaults to a real detection of the single-file `$bunfs` executable. */
  compiled?: boolean;
  execPath?: string;
}

/** True inside a `bun build --compile` single-file executable. */
export function isCompiledBinary(): boolean {
  if (import.meta.url.includes("$bunfs")) return true;
  return typeof Bun !== "undefined" && typeof Bun.main === "string" && Bun.main.includes("$bunfs");
}

export function resolveWorkerCommand(opts: ResolveWorkerCommandOptions = {}): WorkerCommand {
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
