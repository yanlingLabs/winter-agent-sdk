// WS-23 (embedded chat/dispatch): `runEmbeddedSession` -- ONE Winter session, run to completion, with
// every process global turned into a parameter.
//
// This is `main.ts`'s body, moved rather than copied: `main.ts` is now a thin wrapper that hands this
// function its real argv, `process.env`, stdin and stdout, so the spawned/compiled child and an
// embedded session run the SAME wiring and cannot drift (WS-04 §12 treats a cross-leg divergence as a
// release blocker; `testing.ts`'s `inMemoryProcess` is the third leg and is still a TEST leg -- its
// echo provider, its hermetic homes and its early-settling `kill()` are exactly what this is not).
//
// WHAT "WITHOUT PROCESS GLOBALS" COVERS, precisely:
//   - argv, env, stdin, stdout and stderr are parameters -- nothing here reads `process.argv`,
//     `process.stdin`, `process.stdout`, `process.stderr` or (for resolution) `process.env`;
//   - there is no `process.exit` and no `process.on`: the exit code is the return value, and the
//     SIGTERM handler's job is `signal` (see ABORT below);
//   - the session's homes come ONLY from `env` -- the run-home variables the router lays on
//     `Options.env` (`WINTER_HOME` = the run folder, `WINTER_STORE_HOME`, …) -- and from the config.
//
// WHAT IT DOES NOT COVER, and why a host must run this in its own Worker (WS-23 ruling R1): the
// runtime's tool registry, MCP executors, advisor, child-engine factory and background-task table are
// module-level singletons -- one per JS realm -- and Bash/Monitor spawn with `{...process.env}`. Two
// sessions in one realm would route each other's tool calls. A Worker gives each session its own
// realm and its own `process.env` (the Worker's `env` option), which is why `embedded-host.ts`
// constructs one per session and why nothing here tries to re-key those singletons.
//
// COMPILED-BINARY CONSTRAINTS apply exactly as in `main.ts` (a host compiles this into its own
// single-file binary): static, literal imports only.
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { splitFrames, encodeFrame } from "@yanlinglabs/winter-agent-sdk";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { runEngine, type Provider } from "./engine.ts";
import { stubExecutor, isTestProviderName, testProviderForNamespace, registerBgTaskTestTool } from "./provider/mock.ts";
import { resolveEngineSession, resolveProductionWinterHome, resolveProductionStoreHome } from "./store/dialect.ts";
// Phase 4 Task 8 (rider 18): the ONE production registration of Lane C's child-engine factory -- see
// that module's own header for why it is a SHARED helper every entrypoint calls.
import { registerDefaultChildEngineFactory } from "./subagents/register-default-factory.ts";
// Phase 5 Task 8: the SHARED production wiring every entrypoint calls -- see that module's header.
import { buildProductionWiring, withAutoSkillPermissions } from "./production-wiring.ts";
import { loadResumedChain } from "./provider/session-provider.ts";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { restoreChildRoster } from "./subagents/restore.ts";
// Review r2 finding 9's process-group sweep -- the embedded ABORT's first act, as it is SIGTERM's.
import { killAllTaskProcessGroups } from "./tools/impl/background-task-runtime.ts";
import { setHostWorkflowWorkerCommand, type WorkerCommand } from "./workflows/sandbox.ts";
import { EMBEDDED_ABORT_END_INPUT_REQUEST_ID, EMBEDDED_ABORT_INTERRUPT_REQUEST_ID } from "./embedded-protocol.ts";

export interface EmbeddedSessionOptions {
  /** The spawn argv (`--run --config-json <json>`, any leading slots); flags are found by NAME. */
  argv: readonly string[];
  /**
   * The session's environment -- THE ONLY place its homes come from beside the config. A host running
   * this in a Worker passes the Worker's own `process.env` (set by the Worker's `env` option), which is
   * also what Bash/Monitor/stdio-MCP children inherit.
   */
  env: Record<string, string | undefined>;
  /** stdin as text chunks; framing (NDJSON split) happens here, through the one shared codec. */
  input: AsyncIterable<string>;
  /** stdout: receives encoded frames only, never a diagnostic (WS-04 §2/§6). */
  write: (chunk: string) => void;
  /** stderr: wiring warnings and the fatal line. Never a frame. */
  writeErr: (chunk: string) => void;
  /**
   * The embedded SIGTERM. On abort: background process groups are killed at once (as `main.ts`'s
   * SIGTERM handler does), then the engine is told to stop -- the input closes, the running turn is
   * interrupted -- and this function still resolves only after `runEngine` has RETURNED. That last
   * part is the contract a host relies on: the transcript lease is keyed by (projectKey, sessionId)
   * and stamped with the pid, and every Worker shares the host's pid, so the lock cannot tell an old
   * incarnation from a new one. Only "the old engine has returned" makes a resume safe.
   */
  signal?: AbortSignal;
  /** The workflow worker's spawn command for this session (see `setHostWorkflowWorkerCommand`). */
  workflowWorkerCommand?: WorkerCommand;
}

// Same argv contract as `testing.ts`'s inMemoryProcess: find the flag by NAME, never by position --
// `bun src/main.ts --run …` and the compiled `winter --run …` differ by one leading slot, and an
// embedded host passes the argv with no leading slots at all. indexOf is invariant to all three.
function parseConfigFromArgv(argv: readonly string[]): RuntimeConfig {
  if (!argv.includes("--run")) {
    throw new Error("winter: expected '--run --config-json <json>' (missing --run)");
  }
  const idx = argv.indexOf("--config-json");
  const raw = idx === -1 ? undefined : argv[idx + 1];
  if (raw === undefined) {
    throw new Error("winter: expected '--run --config-json <json>' (missing --config-json <json>)");
  }
  return JSON.parse(raw) as RuntimeConfig;
}

// Phase 6 Task 10 (R6-13): the reserved `winter-test/<name>` namespace's resolver.
//
// THE ENV VAR IS NO LONGER A PROVIDER SWITCH. Production selection is catalog-first
// (`provider/selection.ts`), and `WINTER_TEST_PROVIDER` survives only as the HARNESS'S ALIAS for the
// reserved namespace -- honoured, per the ruling, only when `config.model` is absent or already in
// that namespace. Selection does that check; this function answers the narrower question of which
// scripted double a given namespace name means.
//
// The P3 "bgtask" PAIRING is the one thing that could not move into `mock.ts`: that provider's
// target tool has to be REGISTERED in this realm for a call to it to do anything but echo through
// the `unregisteredToolExecutor` fallback, and registration is an entrypoint action, not a lookup.
function resolveNamespacedTestProvider(name: string): Provider | undefined {
  if (name === "bgtask") registerBgTaskTestTool();
  return testProviderForNamespace(name);
}

// A harness that exports an UNRECOGNISED `WINTER_TEST_PROVIDER` used to fail here with a named
// error. It still fails -- selection raises `WinterProviderResolutionError` when the namespace
// resolves to nothing -- but only when the env var is actually consulted. This check keeps the OLD
// failure for the OLD case: a bare, unrecognised value exported with no model configured.
function assertRecognizedTestProviderEnv(env: Record<string, string | undefined>): void {
  const raw = env["WINTER_TEST_PROVIDER"];
  if (raw === undefined || raw === "") return;
  const name = raw.startsWith("winter-test/") ? raw.slice("winter-test/".length) : raw;
  if (name !== "echo" && !isTestProviderName(name)) {
    throw new Error(`winter: unrecognized WINTER_TEST_PROVIDER '${raw}'`);
  }
}

const ABORTED = Symbol("aborted");

/**
 * stdin chunks -> FrameSource, through `splitFrames`+carry -- the identical codec path every leg
 * uses (WS-04 §1) -- with the ABORT spliced in.
 *
 * ABORT = two synthetic control frames, then EOF, IN THIS ORDER:
 *   1. `end_input` -- the session's input is closed (`requestInputEnd`), so nothing new can start;
 *   2. `interrupt` -- the running turn (if any) ends interrupted, which sets the engine's
 *      session-level abort; with no turn running, "input closed + interrupt" is exactly the case the
 *      engine's own wind-down treats as "stop waiting on background work" (engine.ts's interrupt
 *      branch). Reversed, an idle session would ignore the interrupt and then sit in the background
 *      wait for as long as a background agent kept running;
 *   3. EOF -- the pump's own `finally` rejects every pending runtime->host RPC (a permission card
 *      nobody will answer now), so a turn blocked on one cannot hold `runEngine` open.
 *
 * Through the ENGINE'S OWN doors, not a new abort API on `runEngine`: an embedded abort then ends a
 * session exactly the way a host's `interrupt()` + closed stdin already does on every other leg.
 */
function frameSource(input: AsyncIterable<string>, aborted: Promise<typeof ABORTED>): FrameSource {
  return (async function* () {
    let carry = "";
    const iterator = input[Symbol.asyncIterator]();
    let sawAbort = false;
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === ABORTED) {
          sawAbort = true;
          break;
        }
        if (next.done) return;
        const split = splitFrames(next.value, carry);
        carry = split.carry;
        for (const frame of split.frames) yield frame;
      }
    } catch {
      // A raw stream error is ordinary end-of-input (main.ts's own stdin policy, and query.ts's
      // textChunks): the engine's pump already treats "input ended, for any reason" as its EOF row.
      return;
    }
    if (sawAbort) {
      // Release the host's input without waiting on it (a queue nobody will end must not hold this).
      void Promise.resolve(iterator.return?.()).catch(() => {});
      yield { type: "control_request", requestId: EMBEDDED_ABORT_END_INPUT_REQUEST_ID, subtype: "end_input", payload: {} } as WinterFrame;
      yield { type: "control_request", requestId: EMBEDDED_ABORT_INTERRUPT_REQUEST_ID, subtype: "interrupt", payload: {} } as WinterFrame;
    }
  })();
}

/** Is this frame the acknowledgement of one of the two synthetic abort requests? Those never reach the host. */
function isSyntheticAbortAck(frame: WinterFrame): boolean {
  if (frame.type !== "control_response") return false;
  const id = (frame as { requestId?: unknown }).requestId;
  return id === EMBEDDED_ABORT_END_INPUT_REQUEST_ID || id === EMBEDDED_ABORT_INTERRUPT_REQUEST_ID;
}

/**
 * Run ONE Winter session to completion and return its exit code: `runEngine`'s own code, or `1` when
 * the session could not start (the fatal line is on `writeErr`, mirroring a child that exits before
 * init -- WS-04 §6.1). Never throws.
 */
export async function runEmbeddedSession(opts: EmbeddedSessionOptions): Promise<number> {
  const { env, write, writeErr, signal } = opts;
  // The abort is observed from the first line: a host can abort while the session is still resolving
  // (store I/O, provider wiring), and the process-group sweep must never wait for that.
  let settleAborted!: (v: typeof ABORTED) => void;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    settleAborted = resolve;
  });
  const onAbort = (): void => {
    // Synchronously, before anything else -- the same frame-free, await-free sweep main.ts's SIGTERM
    // handler runs (review r2 finding 9). A backgrounded shell must not outlive its session just
    // because the engine's own teardown is still unwinding.
    try {
      killAllTaskProcessGroups();
    } catch {
      /* an abort path must never itself throw */
    }
    settleAborted(ABORTED);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const restoreWorkflowCommand = opts.workflowWorkerCommand !== undefined ? setHostWorkflowWorkerCommand(opts.workflowWorkerCommand) : undefined;

  const output: FrameSink = {
    write(frame) {
      if (isSyntheticAbortAck(frame)) return;
      write(encodeFrame(frame));
    },
    end() {
      // Nothing to end: the host observes completion through this function's resolution (a child's
      // exit), never through a synthetic stream-end frame (WS-04 §6.1).
    },
  };

  try {
    const config = parseConfigFromArgv(opts.argv);
    assertRecognizedTestProviderEnv(env);
    // Task 8: persists by default (RuntimeConfig.persistSession defaults ON) to config.winterHome, or
    // else `env`'s WINTER_HOME, or else ~/.winter (resolveProductionWinterHome) -- this is a
    // PRODUCTION entry, so unlike testing.ts's inMemoryProcess it deliberately DOES fall through to
    // the home directory when nothing overrides it. Task 9: resolveEngineSession ALSO resolves
    // continue/resume/forkSession/resumeSessionAt against `env` (WINTER_PROJECT_DIR_NAME). A
    // resolution failure throws here, before any frame is written, and exits 1 with the detail on
    // stderr (WS-04 §6.1's "exited before init").
    const { config: effectiveConfig, store, initialMessages, approvalStore, autoStateStore } = await resolveEngineSession({
      config,
      resolveWinterHome: () => resolveProductionWinterHome(config, env),
      // WS-21 §6.3 item 3 (durable-write audit, fix round 2): every store `resolveEngineSession`
      // builds (transcript, provider-state sidecar, permission journal, approval store, auto-counter
      // store) roots on this instead of `resolveWinterHome`'s per-run folder -- see dialect.ts.
      resolveStoreHome: () => resolveProductionStoreHome(config, env),
      env,
    });
    // Rider 18: registered BEFORE runEngine starts, so the very first turn's Agent call can spawn. A
    // non-persistent session (`persistSession: false`) gets no STORE -- children then run without
    // durable transcripts, exactly as the parent does.
    //
    // R-2 (residual round 2): `winterHome` is handed over UNCONDITIONALLY; only the STORE is
    // conditional on persistence. NEW-4 made that value the child's FLOOR ANCHOR
    // (`buildBaselineDenyRules(resolvedWinterHome)`), and coupling it to persistence silently gave a
    // non-persistent session's child no resolved-root floors. Safe the other way because
    // `child-engine.ts` tests `childStore === undefined` FIRST (pinned by a fixture).
    const childWinterHome = resolveProductionWinterHome(config, env);
    // WS-21 §6.3 item 3 (durable-write audit, fix round 2): `childWinterHome` stays the per-run folder
    // (the floor anchor); the STORE OBJECT roots on the shared store home when this incarnation has
    // one, so a session's subagent history does not vanish with the per-run folder (WS-21 §2.1).
    const childDurableRoot = resolveProductionStoreHome(config, env) ?? childWinterHome;
    // ONE store object, shared by the child-engine factory and the roster restore below --
    // `resolveEngineSession`'s own `store` is a narrower write-side `SessionPersistence`.
    const childStore = config.persistSession === false ? undefined : new WinterCompatibilitySessionStore({ winterHome: childDurableRoot });
    // R6-7: the RESUMED continuation chain, read once from the sidecar before the run starts -- see
    // `loadResumedChain` for why the renderer needs it and an empty map is not equivalent.
    const providerChain = await loadResumedChain(store, initialMessages);
    // Phase 5 Task 8. Built BEFORE both `registerDefaultChildEngineFactory` and runEngine, because
    // two of its outputs must reach the engine's own startup: the rule set (`withAutoSkillPermissions`,
    // WS-11 §2.2) and the init frame's four P5 fields. `withAutoSkillPermissions` is applied to the
    // config the ENGINE gets, not the one the wiring reads -- the wiring's own `validateSkillsOption`
    // must see the host's original `allowedTools`.
    const wiring = await buildProductionWiring({
      config: effectiveConfig,
      env,
      winterHome: resolveProductionWinterHome(config, env),
      ...(store !== undefined ? { persistence: store } : {}),
      // Phase 6 Task 10: the PRODUCTION provider inputs -- the reserved-namespace resolver and the
      // OS home the `file` credential store resolves `~/.aws/credentials` under. The catalog and the
      // credential store stay at their production defaults (the compiled catalog; the
      // Keychain/env/file/inline composite). NOT testing.ts's `testProviders: () => provider`.
      provider: {
        testProviders: resolveNamespacedTestProvider,
        ...(env["HOME"] !== undefined ? { home: env["HOME"] } : {}),
        // R6-7: a getter, because `attachContinuationChain` re-attaches it after the run starts.
        chain: () => providerChain,
      },
    });
    const provider = wiring.providerWiring.provider;
    // Non-fatal, and STDERR only (stdout is the frame stream exclusively, WS-04 §2/§6).
    for (const warning of wiring.warnings) writeErr(`winter: ${warning}\n`);
    registerDefaultChildEngineFactory({
      provider,
      config: effectiveConfig,
      env,
      // Ruling E-1: a refused cross-provider child reports on the SAME stderr channel.
      warn: (line) => writeErr(`${line}\n`),
      // R-2: TWO spreads, not one -- see `childWinterHome` above.
      ...(childStore !== undefined ? { store: childStore } : {}),
      ...(childWinterHome !== undefined ? { winterHome: childWinterHome } : {}),
      // WS-21 §3.7: the RESOLVED store home the wiring folded into its config.
      ...(wiring.config.storeHome !== undefined ? { storeHome: wiring.config.storeHome } : {}),
      // Phase 5 Task 8: a CHILD gets the same assembler and skill index its parent has.
      ...wiring.childFactoryOptions,
    });
    // Phase 4 fix wave (I3): WS-10 §7's roster rebuild -- on a RESUME (never a fork), the prior
    // session's children are restored from their durable sidecars before the first turn, so
    // `ListAgents`/`SendMessage` can see a child that outlived a restart. Withdrawn after the run.
    const restoredChildren =
      childStore !== undefined && config.forkSession !== true && (config.resume !== undefined || config.continue === true)
        ? await restoreChildRoster(childStore, { projectKey: compatibilityKeys(effectiveConfig.cwd).transcriptProjectKey, sessionId: effectiveConfig.sessionId })
        : undefined;
    try {
      return await runEngine({
        // `wiring.config` -- the effective config PLUS the provider-derived defaults (the
        // descriptor's own context window when the host stated none). Never `effectiveConfig`.
        config: withAutoSkillPermissions(wiring.config),
        ...wiring.engineOptions,
        input: frameSource(opts.input, aborted),
        output,
        provider,
        // P3 fix round 1 (RULING P3-C): no `tools` -- runEngine builds its registry-backed default.
        // `unregisteredToolExecutor: stubExecutor` keeps the scripted test doubles' non-WS-06 names
        // ("test_tool"/"mystery_tool"/"long_task") echoing (registry.ts's
        // buildRegistryToolExecutorWithFallback).
        unregisteredToolExecutor: stubExecutor,
        ...(store !== undefined ? { store } : {}),
        ...(initialMessages.length > 0 ? { initialMessages } : {}),
        // Task 11 (WS-07 §9) / Task 12 (WS-07 §10.5): the same resolved triple as `store`.
        ...(approvalStore !== undefined ? { approvalStore } : {}),
        ...(autoStateStore !== undefined ? { autoStateStore } : {}),
        // STATED, where main.ts used to leave it to runEngine's `process.env` default: the two are
        // the same object for the spawned child (main.ts passes `process.env`), and for an embedded
        // session the env parameter is the only environment that is this session's.
        env,
      });
    } finally {
      // LOAD-BEARING for a realm that outlives this session (a test runner calling this in-process):
      // a restored roster, skill index or plugin-agent map left registered would leak into the next
      // session's own lookups. Hygiene for a Worker or a child process, which end right after.
      restoredChildren?.remove();
      wiring.dispose();
    }
  } catch (err) {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
    try {
      writeErr(`winter: fatal: ${text}\n`);
    } catch {
      /* a closed stderr must not turn a startup failure into a throw */
    }
    return 1;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    restoreWorkflowCommand?.();
  }
}
