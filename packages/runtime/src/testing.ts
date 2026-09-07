import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnedRuntimeProcess, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames, WINTER_BRAND, envName } from "@yanlinglabs/winter-agent-sdk";
import { Queue } from "./protocol/channel.ts";
import type { FrameSource, FrameSink } from "./protocol/channel.ts";
import { runEngine, type Provider, type ToolExecutor } from "./engine.ts";
import { echoProvider } from "./provider/mock.ts";
import { resolveEngineSession } from "./store/dialect.ts";
// Phase 4 Task 8 (rider 18): see main.ts's own identical import comment.
import { registerDefaultChildEngineFactory } from "./subagents/register-default-factory.ts";
// Phase 5 Task 8: see main.ts's own identical import comment. The IDENTICAL call, so the in-memory
// leg and a real spawned/compiled `winter` cannot diverge on which P5 seams a session has.
import { buildProductionWiring, withAutoSkillPermissions } from "./production-wiring.ts";
import { loadResumedChain } from "./provider/session-provider.ts";
import { restoreChildRoster } from "./subagents/restore.ts";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
// Task 1 (P3, WS-06 §1): test-tool registration goes through the registry. The equivalence corpus
// (packages/sdk/src/query.test.ts's "tooluse" scenarios, scripts/differential.ts's tool-round/
// hooked-tool-round/canusetool-approved-round/mode-switch-mid-session scenarios) calls
// inMemoryProcess WITHOUT its own `tools` argument specifically so the DEFAULT executor is what
// runs -- flipping that default away from the old universal-echo `stubExecutor` to the real
// registry-backed adapter (below) means the two ad-hoc, non-WS-06 tool names those fixed provider
// scripts hard-code (provider/mock.ts's "tooluse"/"modeswitch" cases: `test_tool`, `mystery_tool`)
// must be pre-registered here with EXACTLY stubExecutor's own byte-for-byte echo behavior --
// `${name}:${JSON.stringify(input)}` -- or every committed differential golden that exercises one of
// them would stop matching. `long_task` is registered for the identical reason even though no
// CURRENT default-tools call site happens to invoke it (engine.test.ts's own `long_task` fixtures
// always pass an explicit `tools:`, bypassing this default entirely) -- named explicitly by this
// task's own brief, and harmless to pre-register defensively. `unmatched_tool` is deliberately NOT
// registered: its entire test purpose (engine.test.ts) is to be an unresolved permission-axis name,
// a concern orthogonal to this tool registry, and every one of its own call sites already supplies
// an explicit `tools:` too.
//
// These three are plain, throwaway, snake_case test doubles -- visually distinct from every real
// WS-06 PascalCase name and from the `mcp__server__tool` namespace by construction -- registered
// directly against the SAME module-level registry singleton descriptors/*.ts populate (registry.ts's
// own header documents why that singleton is safe to share here: bun's test runner evaluates this
// module's top-level side effects exactly once per `bun test` invocation, so this registration runs
// a single time regardless of how many test files import `inMemoryProcess` from this module).
import "./tools/descriptors/index.ts";
// Task 8 (P3 close-out, production wiring MUST): explicit for documentation parity with the
// descriptors import immediately above -- `./engine.ts` (imported below) already pulls this
// transitively (ES module evaluation runs an import's whole graph before the importer's own body),
// so this line changes no behavior; it just keeps this file's own header comment (which enumerates
// every registered tool an inMemoryProcess default-tools caller can reach) honest about what is
// actually live by the time this module's body runs.
import "./tools/impl/index.ts";
import { registerTool, type ToolResultPayload } from "./tools/registry.ts";

function registerEquivalenceStandIn(name: string): void {
  const echo: { execute(input: unknown): Promise<ToolResultPayload> } = {
    async execute(input: unknown) {
      return { output: `${name}:${JSON.stringify(input)}` };
    },
  };
  registerTool({
    descriptor: {
      canonicalName: name,
      advertisedName: name,
      source: "sdk",
      inputSchema: { type: "object" },
      description: "Test-only equivalence-corpus stand-in (testing.ts) -- not a WS-06 tool.",
      exposure: "hidden",
      permissionClass: "read",
      availability: {},
      capabilityRequirements: [],
      disposition: "implement-now",
    },
    executor: echo,
  });
}

for (const name of ["test_tool", "long_task", "mystery_tool"]) {
  registerEquivalenceStandIn(name);
}

// inMemoryProcess is a TESTING-ONLY entry point (winter-agent-runtime/testing — never used by real
// production code; main.ts is the real entrypoint) — so unlike main.ts's resolveProductionWinterHome,
// which correctly falls all the way back to the real user's home, this resolver must NEVER
// reach that fallback: `config.winterHome` wins if set; otherwise a non-blank `<PREFIX>HOME`
// (the HARD CONSTRAINT's injection point — see transport-equivalence.test.ts's spawnHook and
// scripts/differential.ts, which relies on omitting BOTH to land here); otherwise a fresh per-call
// mkdtemp. It never even LOOKS at process.env, let alone falls through to resolveWinterHome's
// homedir default — every caller of inMemoryProcess that doesn't explicitly opt in is safe by
// construction, including test files this task never had to touch.
function resolveInMemoryWinterHome(config: RuntimeConfig, env: Record<string, string | undefined> | undefined): string {
  if (config.winterHome !== undefined) return config.winterHome;
  // P7a (D19): the env NAME derives from the session's own prefix, read here rather than spelled.
  const override = env?.[envName(config.brand ?? WINTER_BRAND, "HOME")];
  if (override !== undefined && override.trim() !== "") return override;
  return mkdtempSync(join(tmpdir(), "winter-inmemory-"));
}

function parseConfigFromArgv(argv: string[]): RuntimeConfig {
  const idx = argv.indexOf("--config-json");
  const raw = idx === -1 ? undefined : argv[idx + 1];
  if (raw === undefined) throw new Error("inMemoryProcess: argv is missing '--config-json <json>'");
  return JSON.parse(raw) as RuntimeConfig;
}

// Byte-level virtual process (WS-04 §1.1): boots runEngine behind the SAME codec path a real
// spawned `winter` child will use (Task 4) — engine WinterFrames encode to stdout text chunks via
// encodeFrame, stdin text chunks decode to WinterFrames via splitFrames — so the in-memory and
// child transports can never diverge on framing (WS-04 §1). Parses the same `--config-json` argv
// contract the future real binary parses, and (Task 3) now hands the ENGINE the full parsed
// RuntimeConfig — not just sessionId/cwd/model — so maxTurns/permissionMode/etc. all flow through;
// the remaining fields (resume/continue/fork/...) stay inert until resume machinery (Task 9) reads
// them.
//
// Replaces P0's object-level inMemorySpawn (deleted with the spawnRuntime option it served).
//
// `env` (Task 8) controls ONLY where a persisted transcript lands when config.persistSession !==
// false (see resolveInMemoryWinterHome above) — it is NOT the child's process.env in any other
// sense (there is no real child process here). Omit it and persistence still activates by default
// (RuntimeConfig.persistSession defaults ON) but writes to an isolated, disposable temp directory,
// never a real shared path.
export function inMemoryProcess(
  argv: string[],
  provider: Provider = echoProvider,
  // Task 1 (P3): no longer defaults to stubExecutor -- an omitted (or explicit `undefined`, the
  // SAME thing to a default parameter; scripts/differential.ts relies on exactly this) `tools`
  // now flows through to runEngine as omitted too, so THAT function builds its own registry-backed
  // executor (see engine.ts's own EngineOptions.tools comment). Every caller that still wants the
  // old universal-echo double keeps working unchanged by passing `stubExecutor` explicitly (every
  // pre-existing test that does so already spells it out at the call site).
  tools?: ToolExecutor,
  env?: Record<string, string | undefined>,
): SpawnedRuntimeProcess {
  const config = parseConfigFromArgv(argv);

  // Phase 5 fix wave (B-low): ONE root per virtual process, minted at most once.
  //
  // `resolveInMemoryWinterHome` mkdtemps a FRESH directory whenever neither `config.winterHome` nor
  // the brand's own `<PREFIX>HOME` is set -- and it was called three times per session: once for
  // `resolveEngineSession`, once for the child store, once for `buildProductionWiring`. So in the
  // default case (which is most tests, and every `scripts/differential.ts` run) a session's own
  // transcript, its children's transcripts and the settings/skills/plugins its wiring discovered all
  // lived under three DIFFERENT roots. Wasteful is the smaller half; the real cost is that the
  // wiring read a settings tree that was not the one anything wrote to, so no in-memory test could
  // ever observe a settings file affecting a transcript, and a child could not be found under its
  // parent's root.
  //
  // LAZY on purpose: `persistSession: false` must still mint nothing at all.
  let memoizedWinterHome: string | undefined;
  const winterHomeOnce = (): string => (memoizedWinterHome ??= resolveInMemoryWinterHome(config, env));

  const stdin = new Queue<string>();
  const stdout = new Queue<string>();
  // Lane Y addendum item 3: the leg's own STDERR PIPE, which `SpawnedRuntimeProcess` has always
  // declared (`stderr?: AsyncIterable<string>`) and this leg has always left undefined. A real
  // spawned `winter` writes main.ts's wiring warnings to its stderr pipe and the HOST decides where
  // they go; writing them to the ambient `process.stderr` here would not be that mirror -- it would
  // be this leg inventing a destination a child never chooses for itself, and would put lines on a
  // test runner's console that no consumer asked for. Unbounded and non-blocking (see Queue), so a
  // caller that ignores `stderr` entirely costs nothing.
  const stderr = new Queue<string>();

  const input: FrameSource = (async function* () {
    let carry = "";
    for await (const chunk of stdin) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const frame of split.frames) yield frame;
    }
  })();
  const output: FrameSink = {
    write(frame: WinterFrame) {
      stdout.write(encodeFrame(frame));
    },
    end() {
      stdout.end();
    },
  };

  let settleExited!: (v: { code: number | null; signal: string | null }) => void;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    settleExited = resolve;
  });
  let settled = false;

  // Task 9: resolveEngineSession is ASYNC (continue/resume/forkSession/resumeSessionAt all need to
  // await store I/O) — wrapped in its own async IIFE rather than making inMemoryProcess itself
  // async, preserving its synchronous "returns a SpawnedRuntimeProcess immediately" contract
  // (WS-04 §1.1's virtual handle): stdin writes issued by a caller before this resolves just buffer
  // harmlessly in the `stdin` Queue above, exactly as they would while runEngine itself is merely
  // slow to start reading.
  //
  // The try/catch here is NOT redundant with runEngine's own always-resolves design (runEngine
  // never throws) — resolveEngineSession CAN throw before runEngine ever starts (an ambiguous or
  // not-found resume target, ResumeTargetError/ResumeTruncationError). Without this catch, such a
  // throw would leave `stdout` never ended: a consumer draining `proc.stdout` would hang forever
  // waiting for an EOF that never comes. Ending stdout with nothing ever written mirrors a real
  // child process exiting before writing its init frame (WS-04 §6.1) — the same lifecycle query.ts
  // already maps to CLIConnectionError("runtime exited before init") on the child leg.
  void (async () => {
    try {
      const { config: effectiveConfig, store, initialMessages, approvalStore, autoStateStore } = await resolveEngineSession({
        config,
        resolveWinterHome: winterHomeOnce,
        env: env ?? {},
      });
      // Phase 4 Task 8 (rider 18): the IDENTICAL registration main.ts performs, so the in-memory leg
      // and a real spawned/compiled `winter` child behave the same way for an Agent call -- see
      // subagents/register-default-factory.ts's own header for why both entrypoints call it.
      // `resolveInMemoryWinterHome` is the in-memory leg's own hermetic root (it must NEVER reach the
      // real process.env fallback -- that function's own header), so a child's transcripts land under
      // the same temp root the parent's do.
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
      const childWinterHome = winterHomeOnce();
      // ONE store object, shared by the child-engine factory and the roster restore below (see
      // main.ts's own identical comment for why `resolveEngineSession`'s `store` cannot serve).
      const childStore = config.persistSession === false ? undefined : new WinterCompatibilitySessionStore({ winterHome: childWinterHome });
      // Phase 5 Task 8: the same wiring main.ts builds, from the same function, against this leg's
      // own hermetic `resolveInMemoryWinterHome` root -- which must NEVER reach the real
      // `process.env` fallback (that function's own header), so a differential/equivalence run can
      // not read a developer's real skills, commands, plugins or settings.
      // Phase 6 Task 10: the in-memory leg's provider inputs.
      //
      // `testProviders: () => provider` is the WHOLE of this leg's provider policy, and it is the
      // reserved namespace's door (R6-13) rather than a bypass of it: selection still runs, still
      // refuses a model it cannot resolve, and still reaches the catalog for everything outside
      // `winter-test/<name>` -- which is what makes this leg's provider behaviour the SAME code as a
      // spawned child's. The caller's own scripted double answers for whichever reserved name the
      // session asked for, because a JS function is precisely what a spawned process cannot be handed
      // and is the only thing this leg has that the other two do not.
      const providerChain = await loadResumedChain(store, initialMessages);
      const wiring = await buildProductionWiring({
        config: effectiveConfig,
        env: env ?? {},
        winterHome: winterHomeOnce(),
        ...(store !== undefined ? { persistence: store } : {}),
        provider: {
          testProviders: () => provider,
          chain: () => providerChain,
          // NEVER the real `$HOME`: this leg runs inside a test process, and the `file` credential
          // store's default `~/.aws/credentials` location must not resolve to a developer's own.
          home: (env ?? {})["HOME"] ?? winterHomeOnce(),
        },
      });
      // Lane Y addendum, item 3 (the B-low half): the SAME warnings main.ts emits, on the same
      // prefix, down this leg's own stderr pipe. It dropped every one of them on the floor before,
      // so a malformed project `mcp.json`, a plugin that would not load or a broken skill was
      // invisible on exactly the leg the differential and equivalence suites run -- the place a
      // Winter developer meets it first. NOT the frame sink: stdout is the frame stream exclusively
      // (WS-04 §2/§6).
      for (const warning of wiring.warnings) stderr.write(`winter: ${warning}\n`);
      registerDefaultChildEngineFactory({
        provider: wiring.providerWiring.provider,
        config: effectiveConfig,
        env: env ?? {},
        // Ruling E-1: the in-memory leg's own stderr pipe, exactly where its wiring warnings go.
        warn: (line) => stderr.write(`${line}\n`),
        // R-2: TWO spreads, not one. This single conditional was the coupling -- see
        // `childWinterHome` above for why the floors now depend on it.
        ...(childStore !== undefined ? { store: childStore } : {}),
        ...(childWinterHome !== undefined ? { winterHome: childWinterHome } : {}),
        // Phase 5 Task 8: the IDENTICAL mirrors main.ts passes -- a child on the in-memory leg and a
        // child on a spawned/compiled one must have the same context surface.
        ...wiring.childFactoryOptions,
      });
      // Phase 4 fix wave (I3): WS-10 §7's roster rebuild -- the identical wiring main.ts performs,
      // so the in-memory leg and a real spawned/compiled `winter` behave the same way for a resumed
      // session's own children (WS-04 §12 makes a cross-leg divergence a release blocker). Withdrawn
      // in the `finally` below: unlike main.ts, ONE process runs many sessions here, so a roster
      // left registered would leak a dead session's children into the next session's ListAgents.
      const restoredChildren =
        childStore !== undefined && config.forkSession !== true && (config.resume !== undefined || config.continue === true)
          ? await restoreChildRoster(childStore, { projectKey: compatibilityKeys(effectiveConfig.cwd).transcriptProjectKey, sessionId: effectiveConfig.sessionId })
          : undefined;
      try {
      const code = await runEngine({
        config: withAutoSkillPermissions(wiring.config),
        ...wiring.engineOptions,
        input,
        output,
        provider: wiring.providerWiring.provider,
        ...(tools !== undefined ? { tools } : {}),
        ...(store !== undefined ? { store } : {}),
        ...(initialMessages.length > 0 ? { initialMessages } : {}),
        // Task 11 (WS-07 §9): threaded exactly like `store`/`initialMessages` above.
        ...(approvalStore !== undefined ? { approvalStore } : {}),
        // Task 12 (WS-07 §10.5): same precedent, same resolved triple.
        ...(autoStateStore !== undefined ? { autoStateStore } : {}),
        // Phase 4 Task 3: `inMemoryProcess`'s own `env` param, UNMODIFIED (never the `env ?? {}`
        // widening resolveEngineSession's own call just above uses for winterHome resolution -- that
        // widening is deliberately winterHome-specific, per resolveInMemoryWinterHome's own "must
        // NEVER reach the real process.env fallback" header). Passing `{}` here instead of leaving
        // this field OMITTED would make runEngine's own MCP-env parsing see no variables at all
        // rather than falling back to the real `process.env` (its own documented default, matching
        // main.ts's production posture) -- silently breaking any test that relies on an ambient env
        // var. Omitted (the common case) lets runEngine's own default take over unchanged.
        ...(env !== undefined ? { env } : {}),
      });
      if (!settled) {
        settled = true;
        stderr.end();
        settleExited({ code, signal: null });
      }
      } finally {
        restoredChildren?.remove();
        // LOAD-BEARING here, unlike main.ts: one process runs many sessions on this leg, so a skill
        // index or plugin-agent map left registered would leak into the next session's own lookups.
        wiring.dispose();
      }
    } catch {
      if (!settled) {
        settled = true;
        stdout.end();
        stderr.end();
        settleExited({ code: 1, signal: null });
      }
    }
  })();

  return {
    stdin: {
      write(chunk: string) {
        stdin.write(chunk);
      },
      end() {
        stdin.end();
      },
    },
    stdout,
    stderr,
    kill(signal?: string) {
      if (settled) return;
      settled = true;
      // §1.1 ordering: end the stdout queue first (buffered frames still drain from an ended
      // Queue) — then resolve exited, so a consumer racing stdout against exited sees the
      // buffered data before/alongside the exit, never after it silently vanished.
      stdout.end();
      stderr.end(); // same ordering rule as stdout: buffered warnings still drain from an ended Queue
      stdin.end(); // let the backgrounded engine terminate rather than leak
      settleExited({ code: null, signal: signal ?? "SIGTERM" });
    },
    exited,
    pid: null, // virtual handle — hosts MUST NOT require a PID (WS-04 §1.1)
  };
}
