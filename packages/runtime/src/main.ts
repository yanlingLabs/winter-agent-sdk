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
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { splitFrames, encodeFrame } from "@yanlinglabs/winter-agent-sdk";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { runEngine, type Provider } from "./engine.ts";
import { stubExecutor, isTestProviderName, testProviderForNamespace, registerBgTaskTestTool } from "./provider/mock.ts";
import { resolveEngineSession, resolveProductionWinterHome } from "./store/dialect.ts";
// Phase 4 Task 8 (rider 18): the ONE production registration of Lane C's child-engine factory --
// see that module's own header for why it is a SHARED helper both entrypoints call rather than an
// inline one-liner here (cross-leg equivalence: a spawned/compiled child shares no module state with
// an in-process harness, so registering in only one of the two would make the Agent tool behave
// differently per transport, which WS-04 §12 treats as a release blocker).
import { registerDefaultChildEngineFactory } from "./subagents/register-default-factory.ts";
// Phase 5 Task 8: the SHARED production wiring both entrypoints call -- see that module's own header
// for why every P5 seam is registered from one function rather than twice. Without it a real
// spawned/compiled `winter` would have no system prompt, no skills, no slash commands, no
// compaction and no checkpointing, while the in-memory harness had all five (or vice versa) --
// which WS-04 §12 makes a release blocker.
import { buildProductionWiring, withAutoSkillPermissions } from "./production-wiring.ts";
import { loadResumedChain } from "./provider/session-provider.ts";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { restoreChildRoster } from "./subagents/restore.ts";
// Phase 5 Task 3 (RULING R5-15): the pinned worker entry. Lane W replaces the BODY of
// workflowWorkerMain; this dispatch and the export's name/signature are frozen by that ruling and by
// workflows/seam.contract.test.ts.
// Fix round 1 (M5): `WORKFLOW_WORKER_ARGV_FLAG` is IMPORTED, not declared here. This file is a
// top-level script -- a spawner importing it to read the constant would parse argv, resolve a session
// and start an engine as an import side effect. subprocess-entry.ts is declaration-only and is the
// safe home for it.
import { workflowWorkerMain, WORKFLOW_WORKER_ARGV_FLAG } from "./workflows/subprocess-entry.ts";

// Same argv contract as winter-agent-runtime/testing's inMemoryProcess (Task 2): find the flag by
// NAME, never by position. Position-based parsing would silently break between the two ways this
// file is invoked — `bun src/main.ts --run --config-json <json>` (argv[0]=bun, argv[1]=this file,
// argv[2..]=flags) vs. the Task 5 compiled binary (argv[0]=the binary itself, argv[1..]=flags
// directly, no separate "script path" slot) — indexOf is invariant to that shift, so the identical
// function works unmodified under both invocation shapes without needing to slice argv at all.
function parseConfigFromArgv(argv: string[]): RuntimeConfig {
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
// target tool has to be REGISTERED in this process for a call to it to do anything but echo through
// the `unregisteredToolExecutor` fallback, and registration is an entrypoint action, not a lookup.
function resolveNamespacedTestProvider(name: string): Provider | undefined {
  if (name === "bgtask") registerBgTaskTestTool();
  return testProviderForNamespace(name);
}

// A harness that exports an UNRECOGNISED `WINTER_TEST_PROVIDER` used to fail here with a named
// error. It still fails -- selection raises `WinterProviderResolutionError` ("no in-process test
// provider is registered under ...") when the namespace resolves to nothing -- but only when the env
// var is actually consulted, which after the ruling means only when `config.model` leaves room for
// it. This check keeps the OLD failure for the OLD case: a bare, unrecognised value exported with no
// model configured, which is a harness mistake worth naming at the entrypoint rather than deep
// inside resolution.
function assertRecognizedTestProviderEnv(env: Record<string, string | undefined>): void {
  const raw = env["WINTER_TEST_PROVIDER"];
  if (raw === undefined || raw === "") return;
  const name = raw.startsWith("winter-test/") ? raw.slice("winter-test/".length) : raw;
  if (name !== "echo" && !isTestProviderName(name)) {
    throw new Error(`winter: unrecognized WINTER_TEST_PROVIDER '${raw}'`);
  }
}

// stdin -> FrameSource, decoded through splitFrames+carry — the identical codec path
// winter-agent-runtime/testing's inMemoryProcess drives over its in-memory byte queue (WS-04 §1).
// The try/catch mirrors packages/sdk/src/transport.ts's textChunks: a raw low-level stream error
// (e.g. EPIPE if the parent side goes away) is treated as ordinary end-of-input, never an uncaught
// exception — engine.ts's pump already treats input ending (for any reason) as "finish the
// in-flight turn, then tear down" (WS-04 §6's Stdin EOF row), so collapsing a raw stream error into
// that same EOF path is the correct, already-handled outcome rather than a second failure mode.
function stdinFrameSource(): FrameSource {
  return (async function* () {
    let carry = "";
    process.stdin.setEncoding("utf8");
    try {
      for await (const chunk of process.stdin as unknown as AsyncIterable<string>) {
        const split = splitFrames(chunk, carry);
        carry = split.carry;
        for (const frame of split.frames) yield frame;
      }
    } catch {
      return;
    }
  })();
}

// FrameSink -> encodeFrame -> stdout bytes only; NEVER writes to stderr, NEVER logs a frame.
const stdoutFrameSink: FrameSink = {
  write(frame) {
    process.stdout.write(encodeFrame(frame));
  },
  end() {
    // stdout is a real OS pipe backed by this process's own lifecycle; there is no separate
    // "end" event to raise the way the in-memory Queue is ended in testing.ts — the wrapper
    // observes completion via this process's exit (WS-04 §6.1), not a synthetic stream-end frame.
  },
};

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

try {
  const config = parseConfigFromArgv(process.argv);
  assertRecognizedTestProviderEnv(process.env);
  // Task 8: persists by default (RuntimeConfig.persistSession defaults ON) to config.winterHome, or
  // else the real WINTER_HOME|~/.winter (resolveProductionWinterHome) — this is the REAL production
  // entrypoint, so unlike testing.ts's inMemoryProcess it deliberately DOES fall through to the
  // real environment/homedir when nothing overrides it. Task 9: resolveEngineSession ALSO resolves
  // continue/resume/forkSession/resumeSessionAt against `process.env` (WINTER_PROJECT_DIR_NAME) —
  // the same deliberate real-environment fallback policy as resolveProductionWinterHome above, on
  // the same real production entrypoint. A resolution failure (e.g. an ambiguous or not-found
  // resume target) throws here, before any frame is written — caught by this function's own
  // top-level catch below, exiting nonzero with the detail on stderr (matching WS-04 §6.1's "exited
  // before init" lifecycle on the wrapper side).
  const { config: effectiveConfig, store, initialMessages, approvalStore, autoStateStore } = await resolveEngineSession({
    config,
    resolveWinterHome: () => resolveProductionWinterHome(config, process.env),
    env: process.env,
  });
  // Rider 18: registered BEFORE runEngine starts, so the very first turn's Agent call can spawn.
  // A non-persistent session (`persistSession: false`) gets no STORE -- children then run without
  // durable transcripts, exactly as the parent does, rather than being handed a store the parent
  // itself was denied.
  //
  // R-2 (residual round 2): `winterHome` is now handed over UNCONDITIONALLY; only the STORE is
  // conditional on persistence. The two used to travel together because the factory's `winterHome`
  // was purely a transcript-path helper -- "a child gets no store, so it needs no root either" was
  // true and harmless. NEW-4 made that same value the child's FLOOR ANCHOR
  // (`buildBaselineDenyRules(resolvedWinterHome)`), and the coupling silently became "a
  // non-persistent session's child has no resolved-root floors": under forced bypass such a child
  // wrote into `<root>/projects` and created `<root>/backups`, while the identical parent-direct
  // write was denied. The parent was never affected -- it takes its root from the wiring regardless.
  //
  // Safe in the other direction because `child-engine.ts`'s transcript expression tests
  // `childStore === undefined` FIRST and only then `deps.winterHome`, so a child with a root and no
  // store still reports "none -- no durable session store is configured" rather than advertising an
  // absolute path nothing writes. That ordering is pinned by a fixture.
  const childWinterHome = resolveProductionWinterHome(config, process.env);
  // ONE store object, shared by the child-engine factory and the fix wave's roster restore below --
  // `resolveEngineSession`'s own `store` is a narrower write-side `SessionPersistence`, which can
  // neither list a session's child subkeys nor read a sidecar back.
  const childStore = config.persistSession === false ? undefined : new WinterCompatibilitySessionStore({ winterHome: childWinterHome });
  // Phase 5 Task 8. Built BEFORE both `registerDefaultChildEngineFactory` and runEngine, because two of its outputs must reach the engine's own
  // startup: the rule set (`withAutoSkillPermissions`, WS-11 §2.2's automatic `Skill(...)` entries,
  // which `runEngine` seeds once and never re-reads) and the init frame's four P5 fields.
  //
  // `withAutoSkillPermissions` is applied to the config the ENGINE gets, not to the one the wiring
  // reads -- the wiring's own `validateSkillsOption` must see the host's original `allowedTools` to
  // decide whether `Skill` is reachable at all.
  // R6-7: the RESUMED continuation chain, read once from the sidecar before the run starts -- see
  // `loadResumedChain` for why the renderer needs it and an empty map is not equivalent.
  const providerChain = await loadResumedChain(store, initialMessages);
  const wiring = await buildProductionWiring({
    config: effectiveConfig,
    env: process.env,
    winterHome: resolveProductionWinterHome(config, process.env),
    ...(store !== undefined ? { persistence: store } : {}),
    // Phase 6 Task 10: the PRODUCTION provider inputs. Only two, and both are the real environment
    // this entrypoint deliberately falls through to (the same posture `resolveProductionWinterHome`
    // takes): the reserved-namespace resolver, and the OS home the `file` credential store resolves
    // `~/.aws/credentials` under. The catalog and the credential store are left at their production
    // defaults -- the compiled catalog and the Keychain/env/file/inline composite.
    provider: {
      testProviders: resolveNamespacedTestProvider,
      ...(process.env.HOME !== undefined ? { home: process.env.HOME } : {}),
      // R6-7: the RESUMED continuation chain, read through the same store the sidecar was written
      // to. A getter, because `attachContinuationChain` re-attaches it after the run starts.
      chain: () => providerChain,
    },
  });
  const provider = wiring.providerWiring.provider;
  // Non-fatal, and STDERR only: stdout is the frame stream exclusively (WS-04 §2/§6). A malformed
  // the project `mcp.json`, a plugin that would not load, or a `skills` entry naming something unknown
  // must be visible to an operator without taking the session down.
  for (const warning of wiring.warnings) process.stderr.write(`winter: ${warning}\n`);
  registerDefaultChildEngineFactory({
    provider,
    config: effectiveConfig,
    env: process.env,
    // Ruling E-1: a refused cross-provider child reports on the SAME stderr channel every wiring
    // warning uses (stdout stays the frame stream, WS-04 §2/§6).
    warn: (line) => process.stderr.write(`${line}\n`),
    // R-2: TWO spreads, not one. This single conditional was the coupling -- see `childWinterHome`
    // above for why the floors now depend on it.
    ...(childStore !== undefined ? { store: childStore } : {}),
    ...(childWinterHome !== undefined ? { winterHome: childWinterHome } : {}),
    // Phase 5 Task 8: a CHILD gets the same assembler and skill index its parent has.
    ...wiring.childFactoryOptions,
  });
  // Phase 4 fix wave (I3): WS-10 §7's "the roster rebuilds from durable storage" MUST -- on a
  // RESUME (never a fork, which is a NEW session whose children belong to the source), the prior
  // session's children are restored from their durable sidecars and contributed to the messaging
  // runtime BEFORE the first turn, so `ListAgents`/`SendMessage` can see a child that outlived a
  // restart. Withdrawn once this session's own run ends. See subagents/restore.ts for what a
  // restored handle can and cannot do (identity yes, live resume no -- an explicit carry).
  const restoredChildren =
    childStore !== undefined && config.forkSession !== true && (config.resume !== undefined || config.continue === true)
      ? await restoreChildRoster(childStore, { projectKey: compatibilityKeys(effectiveConfig.cwd).transcriptProjectKey, sessionId: effectiveConfig.sessionId })
      : undefined;
  const code = await runEngine({
    // `wiring.config` -- the effective config PLUS the provider-derived defaults (the descriptor's
    // own context window when the host stated none). Never `effectiveConfig` directly: that would
    // silently drop them.
    config: withAutoSkillPermissions(wiring.config),
    ...wiring.engineOptions,
    input: stdinFrameSource(),
    output: stdoutFrameSink,
    provider,
    // P3 fix round 1 (RULING P3-C): `tools` is no longer supplied here -- omitting it lets runEngine
    // build its own registry-backed default (buildDefaultToolExecutor, engine.ts), so a real WS-06
    // tool call now flows through a FULL ToolExecutionContext (emitFrame/session/tempDir/readState/
    // probeReadAccess all wired to this run's own live engine state) instead of stubExecutor's blind
    // echo -- see the phase's own descriptor index (tools/descriptors/index.ts, imported
    // transitively via engine.ts) for what "registered" means today: every WS-06 §2 name has a
    // descriptor, but only names a later lane's replaceExecutor has reached actually execute for
    // real; everything else reports its own typed not-yet-executable/correctly-absent error.
    // `unregisteredToolExecutor: stubExecutor` keeps the PRE-EXISTING scripted test doubles
    // ("test_tool"/"mystery_tool"/"long_task", none of which are — or ever will be — a WS-06 name)
    // echoing exactly as before this fix round; see registry.ts's buildRegistryToolExecutorWithFallback
    // for the exact "no descriptor at all" test that triggers this fallback.
    unregisteredToolExecutor: stubExecutor,
    ...(store !== undefined ? { store } : {}),
    ...(initialMessages.length > 0 ? { initialMessages } : {}),
    // Task 11 (WS-07 §9): threaded exactly like `store`/`initialMessages` above -- resolveEngineSession
    // already constructed it against the resolved winterHome/projectKey/sessionId.
    ...(approvalStore !== undefined ? { approvalStore } : {}),
    // Task 12 (WS-07 §10.5): same precedent, same resolved triple.
    ...(autoStateStore !== undefined ? { autoStateStore } : {}),
  });
  // Withdrawn before exit for symmetry with engine.ts's own per-run roster withdrawal; this process
  // is about to end either way, so it is hygiene, not a leak fix (testing.ts's in-memory leg, where
  // ONE process runs many sessions, is where it genuinely matters).
  restoredChildren?.remove();
  // Hygiene only here (this process is about to exit); genuinely load-bearing on the in-memory leg,
  // where ONE process runs many sessions -- see testing.ts's own `finally`.
  wiring.dispose();
  process.exit(code);
} catch (err) {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`winter: fatal: ${text}\n`);
  process.exit(1);
}
