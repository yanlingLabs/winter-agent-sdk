// The `winter` child entrypoint (WS-04 §1 topology path (a); Task 4). Parses `--run --config-json
// <json>` from argv, wires stdin bytes -> splitFrames -> engine input and engine output ->
// encodeFrame -> stdout bytes through the SAME codec path winter-agent-runtime/testing's
// inMemoryProcess uses (WS-04 §1: one framing code path for both transports — Task 2), and exits
// with runEngine's resolved code. Diagnostics (this file's own parse/crash messages) go to STDERR
// ONLY — stdout is reserved for the frame stream exclusively (WS-04 §2, §6: "Stderr ... is never
// part of the frame stream").
//
// COMPILED-BINARY CONSTRAINTS (this file is compiled by `bun build --compile` in Task 5): no
// dynamic `import()` of a computed path, no `import.meta.dir`-relative resource loads, no
// `require.resolve` at runtime — none of those survive being bundled into a single-file `$bunfs`
// executable. Every import below is a static, literal specifier resolved at BUILD time; nothing
// here touches the filesystem to find its own code.
import { fstatSync } from "node:fs";
import { SDK_VERSION, WINTER_BRAND, envName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
// WS-23: the whole session -- config parse, store resolution, production wiring, child-engine factory,
// roster restore, runEngine -- lives in `runEmbeddedSession`, which an embedded host also runs (one per
// Worker). This file hands it the REAL process: argv, `process.env`, stdin, stdout, stderr. One body,
// two topologies, so the spawned child and an embedded session cannot drift (WS-04 §12).
import { runEmbeddedSession } from "./embedded.ts";
// Phase 5 Task 3 (RULING R5-15): the pinned worker entry. Lane W replaces the BODY of
// workflowWorkerMain; this dispatch and the export's name/signature are frozen by that ruling and by
// workflows/seam.contract.test.ts.
// Fix round 1 (M5): `WORKFLOW_WORKER_ARGV_FLAG` is IMPORTED, not declared here. This file is a
// top-level script -- a spawner importing it to read the constant would parse argv, resolve a session
// and start an engine as an import side effect. subprocess-entry.ts is declaration-only and is the
// safe home for it.
import { workflowWorkerMain, WORKFLOW_WORKER_ARGV_FLAG } from "./workflows/subprocess-entry.ts";
// Review r2 finding 9 (whole-branch): the SIGTERM/SIGINT handler's own process-group sweep -- see
// installShutdownSignalHandlers's own header below for why this needs its OWN synchronous, frame-free
// door rather than reusing engine.ts's ordinary teardown sweep.
import { killAllTaskProcessGroups } from "./tools/impl/background-task-runtime.ts";
import { liveProcessGroups } from "./process-groups.ts";

// stdin as text chunks for `runEmbeddedSession`, which owns the framing (the one shared codec). The
// try/catch mirrors packages/sdk/src/transport.ts's textChunks: a raw low-level stream error (e.g.
// EPIPE if the parent side goes away) is ordinary end-of-input, never an uncaught exception --
// engine.ts's pump already treats input ending (for any reason) as "finish the in-flight turn, then
// tear down" (WS-04 §6's Stdin EOF row).
async function* stdinChunks(): AsyncGenerator<string> {
  process.stdin.setEncoding("utf8");
  try {
    for await (const chunk of process.stdin as unknown as AsyncIterable<string>) yield chunk;
  } catch {
    return;
  }
}

// --- Review r2 finding 9 (whole-branch): SIGTERM/SIGINT handling -----------------------------------
//
// Before this fix, main.ts installed NO signal handler at all. Node/Bun's DEFAULT disposition for
// both SIGTERM and SIGINT is to terminate the process immediately -- which means a `detached: true`
// background shell this run started (bash.ts's own `run_in_background: true`, or Monitor's command
// half) was never given a chance to be killed: the process just stopped existing mid-write,
// mid-await, mid-anything, orphaning that process group under its own reparent. (engine.ts's own
// `stopSessionShellTasks` sweep -- review r1 finding 2, and now also review r2 finding 9's own
// outer-wrapper fix for a THROWN runEngine -- never gets a chance to run either, for the identical
// reason: the process is simply gone.)
//
// Installing ANY listener for a signal OVERRIDES the runtime's own default "terminate" disposition,
// so this handler must both do the cleanup AND still actually end the process -- otherwise a
// SIGTERM/SIGINT silently becomes a no-op, which is worse than doing nothing (the daemon's own "kill
// this child" door would hang forever instead of failing fast).
//
// EXIT PATH: "remove this listener, then re-raise the SAME signal at ourselves", not a bare
// `process.exit(code)`. `process.exit()` is a NORMAL, code-based exit at the OS level
// (`{code, signal: null}` reported to a parent's `child_process`), never a signal-terminated one
// (`{code: null, signal: "SIGTERM"}`) -- the two are genuinely different exit PATHS, not just
// different ways of describing the same event, and downstream code (query.ts's own `ProcessError`
// classification; this SDK's own transport-equivalence fixtures, which pin the exact shape) tells
// them apart. Removing every listener for this signal restores the runtime's own default SIG_DFL
// disposition for it, so the re-raised signal terminates the process through the kernel's ordinary
// machinery -- a genuine signal-terminated exit. `process.exit(...)` with the POSIX signal-exit
// convention (128 + signal number) is kept only as the last-resort fallback for the case where
// re-raising somehow still leaves the process alive.
//
// MEASURED, not assumed (see this lane's own report for the full trace): signal delivery to a
// CUSTOM JS handler -- for EITHER exit path above, since both start by entering this same callback
// -- is mediated by the runtime's own native signal-to-callback bridge, unlike the kernel's
// unconditional default disposition, and under Bun that bridge has a narrow, real race (reproduced
// directly against `transport-equivalence.test.ts`'s own real-child-process round: killing a child
// within the same tick as it finishes writing a control_response can leave the JS handler never
// invoked at all, with no exception, no partial effect, nothing -- the process is simply left
// running). This is NOT something a handler body can defend against by construction: the handler
// never runs at all in that window, so no amount of code inside it helps -- the mitigation lives on
// the CALLER side, matching this codebase's own established precedent for exactly this class of
// problem (`query.ts`'s own `onAbort`, `KILL_GRACE_MS`'s SIGTERM-then-SIGKILL escalation, where
// SIGKILL cannot be intercepted or raced by ANY handler, custom or default);
// `transport-equivalence.test.ts`'s own `runLeg`/`killAndReap` helper now does the same. A SEPARATE,
// also-measured Bun `node:child_process` gap (the "close" event not firing even once SIGKILL has
// genuinely ended the process) is the reason that helper also bounds its own wait with a timeout --
// see its own header for the full trace; neither gap is specific to which exit path this handler
// takes, which is exactly why re-raising (needed for the correct exit SHAPE) is safe to use now:
// the caller-side escalation already covers the case this handler's own first, abandoned draft was
// avoiding when it reached for a bare `process.exit()` instead.
const SIGNAL_EXIT_CODE: Record<"SIGTERM" | "SIGINT", number> = { SIGTERM: 143, SIGINT: 130 };

function installShutdownSignalHandlers(): void {
  for (const signal of Object.keys(SIGNAL_EXIT_CODE) as Array<keyof typeof SIGNAL_EXIT_CODE>) {
    process.on(signal, () => {
      // Synchronously safe, as the review requires: killAllTaskProcessGroups is a plain loop of
      // process.kill(-pid, "SIGKILL") calls -- no await, no I/O, nothing that depends on the event
      // loop still turning, and (deliberately, unlike the ordinary teardown sweep) no frame write.
      try {
        killAllTaskProcessGroups();
      } catch {
        /* a signal handler must never itself throw */
      }
      process.removeAllListeners(signal);
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(SIGNAL_EXIT_CODE[signal]);
      }
    });
  }
}

// --- The parent's death is a HARD STOP, even mid-turn -------------------------------------------------
//
// A spawned runtime is driven by its parent (the host) over stdin/stdout. When the host dies -- killed,
// crashed -- nobody reads the stream any more, but a session in the middle of a turn would otherwise
// finish it: the engine treats stdin EOF as "no more input, finish the in-flight turn" (WS-04 §6),
// which is right for a host that closes its input on purpose and wrong for one that is gone. A real
// turn would keep spending tokens and running tools with no one supervising it.
//
// THE SIGNAL is the parent pid changing, not stdin EOF. EOF alone cannot tell the two cases apart: a
// print-mode host closes stdin right after its prompt and still wants the turn finished. When a
// process's parent dies, the kernel re-parents it (to launchd/init, pid 1, or to the nearest subreaper
// on Linux), so `process.ppid` (read live, one `getppid()` each time) stops being the host's pid. It is
// checked once at startup and then every `PARENT_WATCH_INTERVAL_MS` -- a single cheap syscall -- on
// macOS and Linux alike; no platform API (`PR_SET_PDEATHSIG` is Linux-only, a kqueue `NOTE_EXIT` watch
// macOS-only) is needed for that.
//
// WHICH PID IS THE HOST: the SDK's own spawn (`defaultSpawn`) states it in `<PREFIX>HOST_PID` (the
// brand's env prefix, `WINTER_HOST_PID` by default), so a host that died while the runtime was still
// loading -- when `process.ppid` may already be 1 -- is caught at the first check. The variable is
// removed from this process's environment at once, so nothing the session spawns inherits it. Without
// it (another spawner) the parent at startup is taken as the host.
//
// ARMED ONLY WHEN A HOST IS DRIVING THE SESSION: stdin is a pipe or a socket. A runtime reading its
// input from a FILE or a terminal was started on purpose to outlive whatever launched it -- `nohup
// winter … < in.ndjson > out.ndjson &`, cron, `setsid … &`, a forking service manager -- and its
// launcher exiting must not stop it. Not armed either when the host would be pid 1 (nothing to see
// die), or when `<PREFIX>DISABLE_PARENT_WATCH=1` opts out. One more reason to opt out: on macOS a
// debugger attaching (`PT_ATTACH`) temporarily re-parents the process to the debugger, which this
// watcher cannot tell from the host dying.
//
// THE STOP, when a turn is RUNNING: first, synchronously, SIGKILL every process group this process
// started -- background tasks AND the foreground ones the process-group ledger knows (a running Bash
// command, a stdio MCP server, a hook) -- so nothing it spawned outlives it whatever happens next. Then
// the engine's own hard stop (`EngineOptions.abortSignal`, through `runEmbeddedSession`'s signal): the
// turn ends interrupted, waiting input is dropped, the background wait stops, and the session tears
// down. If that has not finished within `PARENT_GONE_GRACE_MS`, the process exits anyway.
//
// WHEN NO TURN IS RUNNING (between turns, or already tearing down -- a host that read its last result
// and exited): the same, except that HOOK process groups are spared and there is no 1 s deadline, so a
// `SessionEnd` command hook still runs to completion, bounded by its own timeout; the process exits as
// soon as the teardown is done (`PARENT_GONE_IDLE_BACKSTOP_MS` is only a backstop for a teardown that
// never ends).
//
// Background agents run in this process, so they end with it. Writes to the dead parent's pipe are
// expected to fail from here on and are ignored. Exit code 129 (128 + SIGHUP, the conventional "the
// controlling side hung up"); nobody is left to read it.
const PARENT_WATCH_INTERVAL_MS = 250;
const PARENT_GONE_GRACE_MS = 1_000;
const PARENT_GONE_IDLE_BACKSTOP_MS = 65_000;
const PARENT_GONE_EXIT_CODE = 129;

/** The session's env prefix, read from the config on argv (the brand rides it); the default brand's otherwise. */
function sessionEnvPrefix(argv: readonly string[]): Pick<BrandProfile, "envPrefix"> {
  const at = argv.indexOf("--config-json");
  try {
    const brand = (JSON.parse(argv[at + 1] ?? "") as { brand?: { envPrefix?: unknown } }).brand;
    if (typeof brand?.envPrefix === "string") return { envPrefix: brand.envPrefix };
  } catch {
    /* a malformed config fails later, with its own message */
  }
  return DEFAULT_BRAND_PREFIX;
}
const DEFAULT_BRAND_PREFIX: Pick<BrandProfile, "envPrefix"> = WINTER_BRAND;

/** Whether stdin is a pipe or a socket -- a host is writing it -- rather than a file or a terminal. */
function stdinFromHost(): boolean {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isSocket();
  } catch {
    return false;
  }
}

function killEveryProcessGroup(opts?: { spareHooks?: boolean }): void {
  try {
    killAllTaskProcessGroups();
  } catch {
    /* a stop path must never itself throw */
  }
  for (const { pgid, kind } of liveProcessGroups()) {
    if (opts?.spareHooks === true && kind === "hook") continue;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Arms the watcher (see the header above). `phase` is the session's live phase (`running` while a
 * turn runs); `stop` is aborted when the host is gone.
 */
function stopOnParentDeath(argv: readonly string[], phase: () => "running" | "idle" | "ending", stop: AbortController): void {
  const prefix = sessionEnvPrefix(argv);
  const hostPidVar = envName(prefix, "HOST_PID");
  const stated = Number(process.env[hostPidVar]);
  delete process.env[hostPidVar];
  if (process.env[envName(prefix, "DISABLE_PARENT_WATCH")] === "1") return;
  if (!stdinFromHost()) return;
  const host = Number.isInteger(stated) && stated > 1 ? stated : process.ppid;
  if (!Number.isInteger(host) || host <= 1) return;
  const onGone = (): void => {
    const ignore = (): void => {};
    process.stdout.on("error", ignore);
    process.stderr.on("error", ignore);
    const midTurn = phase() === "running";
    killEveryProcessGroup({ spareHooks: !midTurn });
    stop.abort();
    const deadline = setTimeout(
      () => {
        killEveryProcessGroup();
        process.exit(PARENT_GONE_EXIT_CODE);
      },
      midTurn ? PARENT_GONE_GRACE_MS : PARENT_GONE_IDLE_BACKSTOP_MS,
    );
    deadline.unref?.();
  };
  if (process.ppid !== host) {
    // Already gone while this process was loading. Deferred one tick, so the session's own wiring
    // below still runs and the stop reaches it through the same door.
    setTimeout(onGone, 0);
    return;
  }
  const timer = setInterval(() => {
    if (process.ppid === host) return;
    clearInterval(timer);
    onGone();
  }, PARENT_WATCH_INTERVAL_MS);
  // Never what keeps the process alive: a session that is over exits as before.
  timer.unref?.();
}

// --- P9a-6: the `--version` door -------------------------------------------------------------------
//
// Checked FIRST -- before the `__workflow-worker` dispatch below and before `parseConfigFromArgv` --
// so `--version --run ...` still prints the version (this door wins over every other argv shape).
// Exact flag only (no `-v`, no `--help`): the surface stays minimal, matching WS-02 §4's stated
// interface. Prints to STDOUT (not the frame stream -- no session ever starts for this invocation)
// and exits 0, mirroring `SDK_VERSION`'s own bare semver string (no leading "v", no trailing newline
// baked into the constant -- the newline is this door's own doing, for a clean CLI line).
if (process.argv.includes("--version")) {
  process.stdout.write(SDK_VERSION + "\n");
  process.exit(0);
}

// --- Phase 5 Task 3 (R5-5/R5-15): the `__workflow-worker` argv dispatch ---------------------------
//
// Checked BEFORE `parseConfigFromArgv`, because a worker invocation carries no `--run --config-json`
// and would otherwise die on the missing-flag throw. Found by NAME, never by position -- `bun
// src/main.ts __workflow-worker ...` and the compiled `winter __workflow-worker ...` differ by one
// leading argv slot, the same shift `parseConfigFromArgv`'s own indexOf comment describes.
//
// A STATIC import (see the file header's compiled-binary constraints): a dynamic import of the entry
// would not survive `bun build --compile`, which is precisely the leg `verify:workflow` exercises.
if (process.argv.includes(WORKFLOW_WORKER_ARGV_FLAG)) {
  try {
    const code = await workflowWorkerMain(process.argv, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
    process.exit(code);
  } catch (err) {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`winter: fatal (workflow worker): ${text}\n`);
    process.exit(1);
  }
}

// Review r2 finding 9: installed BEFORE anything else this process does -- a SIGTERM/SIGINT can
// arrive at any point in this process's lifetime, including before `runEngine` itself even starts
// (session resolution, provider wiring), so the handler must be live from the very first line.
installShutdownSignalHandlers();
// The parent's death stops the session, mid-turn included (see `stopOnParentDeath`).
const parentGone = new AbortController();
let sessionPhase: "running" | "idle" | "ending" = "idle";
stopOnParentDeath(process.argv, () => sessionPhase, parentGone);
// Task 8's persistence default, the production provider inputs, the child-engine factory and the
// fatal-line-then-exit-1 path all live in `runEmbeddedSession` now (see embedded.ts). stdout is the
// frame stream exclusively; every diagnostic goes to stderr (WS-04 §2/§6).
const code = await runEmbeddedSession({
  argv: process.argv,
  env: process.env,
  input: stdinChunks(),
  write: (chunk) => {
    process.stdout.write(chunk);
  },
  writeErr: (chunk) => {
    process.stderr.write(chunk);
  },
  signal: parentGone.signal,
  onSessionPhase: (phase) => {
    sessionPhase = phase;
  },
});
process.exit(parentGone.signal.aborted ? PARENT_GONE_EXIT_CODE : code);
