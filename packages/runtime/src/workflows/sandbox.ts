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
// 2. THE SEATBELT, WITH `home`. `buildWorkflowWorkerSeatbeltProfile`'s `home` parameter is OPTIONAL
//    for pre-P5 callers, and omitting it silently drops the `~/.winter/run` read-deny (T3's Lane W
//    item 2, verbatim: "your spawner MUST pass `{ home }` or the pre-P5 gap comes back silently").
//    `buildWorkerSpawn` is the ONE place a worker command becomes a spawn, so the obligation is
//    discharged once, here, rather than at each call site.
import { fileURLToPath } from "node:url";
import { buildWorkflowWorkerSeatbeltProfile } from "../sandbox/profile.ts";
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
   * The session's WINTER HOME. Supplying it is what emits the `~/.winter/run` read-deny (R5-5).
   * Optional in the TYPE only because the profile builder's own parameter is; every production call
   * site passes it, and worker.test.ts pins the difference between the two profiles.
   */
  home?: string;
}

/** The actual `(file, args)` to spawn: sandbox-exec wrapping the worker command under the tight profile. */
export function buildWorkerSpawn(opts: BuildWorkerSpawnOptions): WorkerCommand {
  const profile = buildWorkflowWorkerSeatbeltProfile(opts.command.file, opts.home !== undefined ? { home: opts.home } : {});
  return { file: SANDBOX_EXEC_PATH, args: ["-p", profile, opts.command.file, ...opts.command.args] };
}

/** WS-12 §3's own availability rule, reused rather than re-derived. */
export function workflowSandboxAvailable(): boolean {
  return isSandboxAvailable();
}

export { SANDBOX_EXEC_PATH };
