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
import { echoProvider, stubExecutor, isTestProviderName, testProviderByName, registerBgTaskTestTool } from "./provider/mock.ts";
import { resolveEngineSession, resolveProductionWinterHome } from "./store/dialect.ts";

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

// P1 test-only provider selection (WINTER_TEST_PROVIDER) — see provider/mock.ts's
// testProviderByName for the full rationale: this is what lets the CHILD leg of Task 4's
// transport-equivalence suite (packages/sdk/src/transport-equivalence.test.ts) script the same
// error/tool-use/hang behaviors an in-process test double gets for free, since a real spawned
// process can't be handed a JS function. Default (unset / empty) is echoProvider — byte-identical
// to every other P1 entrypoint's default. REMOVE at P6 alongside provider/mock.ts's half (real
// providers land then).
function resolveProvider(): Provider {
  const raw = process.env.WINTER_TEST_PROVIDER;
  if (raw === undefined || raw === "") return echoProvider;
  if (!isTestProviderName(raw)) {
    throw new Error(`winter: unrecognized WINTER_TEST_PROVIDER '${raw}'`);
  }
  // P3 fix round 1 (RULING P3-C): "bgtask" needs its OWN registered tool for a call to it to do
  // anything but echo through the unregisteredToolExecutor fallback (below) -- see
  // provider/mock.ts's registerBgTaskTestTool for why the provider and the tool are a pair, never
  // one without the other. Every other TestProviderName's own target ("test_tool"/"mystery_tool")
  // needs no such pairing -- they were never meant to do more than echo.
  if (raw === "bgtask") registerBgTaskTestTool();
  return testProviderByName(raw);
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

try {
  const config = parseConfigFromArgv(process.argv);
  const provider = resolveProvider();
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
  const code = await runEngine({
    config: effectiveConfig,
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
  process.exit(code);
} catch (err) {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`winter: fatal: ${text}\n`);
  process.exit(1);
}
