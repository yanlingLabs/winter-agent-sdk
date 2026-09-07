// Task 4 (WS-04 §12): every scenario below runs over BOTH topology legs — the in-memory transport
// (winter-agent-runtime/testing's inMemoryProcess, WS-04 §1.1 virtual handle) and a REAL spawned
// `winter` child (packages/runtime/src/main.ts, WS-04 §1 path (a), run here under the DEV leg —
// `bun src/main.ts`, not the Task 5 compiled binary) — and asserts their normalized message
// sequences are IDENTICAL. A divergence between the two legs is a release blocker per spec, not a
// mere test failure.
//
// Four scenarios (multi-turn, interrupt, split-frame-carry, rpcprobe) drive the raw
// SpawnedRuntimeProcess frame stream directly instead of going through query():
//  - multi-turn: query.ts's iterate() USED to stop at the FIRST terminal result unconditionally,
//    silently dropping every subsequent streaming-input turn (a real gap this task's first pass
//    discovered — confirmed empirically, then fixed in query.ts per controller Ruling P1-I:
//    termination is now mode-aware — a single-shot prompt still stops at its one result unchanged;
//    a streaming-input prompt runs to the transport's own natural EOF, yielding every turn's
//    result). `multi-turn (streaming input, 2 envelopes)` below still drives the raw frame stream
//    directly — it tests the WIRE contract independently of whatever the query() wrapper does —
//    and a SEPARATE `multi-turn via query()` test now covers the wrapper-level fix directly.
//  - interrupt: Query.interrupt() is now real (Task 2 — it sends a genuine interrupt
//    control_request and resolves on the ack), but `traceInterrupt` below still drives the raw
//    frame stream directly rather than going through query() — deliberately left as-is (Task 2
//    brief): it synchronizes with "the engine is genuinely blocked inside provider.generate()" via
//    INTERRUPT_SETTLE_MS below, something a query()-driven scenario can't observe any more
//    precisely either, so rewriting it through query() would trade one timing assumption for an
//    identical one while losing this file's independent proof of the WIRE contract. A
//    query()-driven interrupt test now exists too (packages/sdk/src/query.test.ts), synchronized
//    precisely via the scripted provider's own "entered" signal instead of a timer.
//  - split-frame-carry: exercises splitFrames' carry mechanism directly at the transport boundary
//    (a frame's bytes deliberately split across two stdin writes) — unrelated to query() at all.
//  - (rpcprobe was the fourth of these until Phase 6 Task 10 removed it with the `rpc_probe` turn
//    kind — R6-13's condition was met by the real permission/hook control-RPC scenarios below.)
import { describe, test, expect, afterAll } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "./query.ts";
import { defaultSpawn, type SpawnedRuntimeProcess, type SpawnRuntimeOptions, type SpawnClaudeCodeProcess } from "./transport.ts";
import { ResultError, ProcessError, AbortError, CLIConnectionError } from "./errors.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import type { WinterFrame, ControlRequestFrame, ControlResponseFrame } from "./protocol/frames.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import type { CanUseTool, PermissionMode } from "./permissions/types.ts";
import type { Options, WinterMcpServerInstance } from "./options.ts";
import type { ModelInfo } from "./protocol/config.ts";
import { PROVIDER_STATE_FILE_SUFFIX } from "./store/session-store.ts";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import {
  echoProvider,
  stubExecutor,
  testProviderByName,
  type TestProviderName,
  WinterCompatibilitySessionStore,
  compatibilityKeys,
  // P3 fix round 1 (RULING P3-C): the "bgtask" TestProviderName's own paired tool -- see
  // provider/mock.ts's registerBgTaskTestTool for why the name is exported rather than hand-copied
  // here (this file, main.ts, and `allowedTools` below all need the identical literal).
  registerBgTaskTestTool,
  BGTASK_TEST_TOOL_NAME,
  // Phase 4 Task 3 (WS-04 addendum): the "mcpsdk" scripted provider's own paired tool/server names --
  // see provider/mock.ts's own comment for why these are exported rather than hand-copied here.
  MCP_SDK_TEST_SERVER_NAME,
  MCP_SDK_TEST_TOOL_NAME,
  // Phase 4 Task 8 (riders 6/25): the subagent/messaging equivalence fixtures' own shared literal.
  SUBAGENT_CHILD_PROBE_TEXT,
  // Phase 5 Task 8: the fixture skill's name, shared with provider/mock.ts's own `p5skill` case.
  P5_FIXTURE_SKILL_NAME,
  // Phase 6 Task 10: the SHARED provider-scenario fake -- one definition, consumed by this file and
  // by scripts/differential.ts, so the equivalence suite and the goldens cannot drift.
  SCENARIO_CHILD_AGENT,
  SCENARIO_CHILD_MODEL,
  SCENARIO_CHILD_WIRE_ID,
  SCENARIO_DELEGATE_MARKER,
  SCENARIO_FINAL_TEXT,
  SCENARIO_MODELS,
  SCENARIO_TOOL_NAME,
  startScenarioFake,
  type ScenarioFake,
} from "winter-agent-runtime";
import { normalizeTrace, compareTraces, type ConformanceTraceEntry } from "@yanlinglabs/winter-conformance/trace";

// Task 8: every engine run in this file persists by default (RuntimeConfig.persistSession defaults
// ON) — a SHARED per-file temp WINTER_HOME keeps every leg (inMemory/child/compiled) off the real
// ~/.winter regardless of the running user's environment, per the HARD CONSTRAINT that no test/gate
// code path may ever touch it. One shared value for the whole file is fine: persistence has no
// observable effect on the wire trace (task-8 report), and every assertion in this file compares
// wire frames only, never transcript file contents. Removed at the end of the run.
const TEST_WINTER_HOME = mkdtempSync(join(tmpdir(), "winter-transport-equivalence-"));
afterAll(() => {
  rmSync(TEST_WINTER_HOME, { recursive: true, force: true });
});

// --- fixtures / constants -----------------------------------------------------------------------

// A pinned model constant, and a REAL cwd. scripts/differential.ts's in-memory-only golden can pin
// a synthetic, nonexistent path ("/winter-fixture") because inMemoryProcess never touches the
// filesystem with it — but the CHILD leg here does a real node:child_process.spawn(cmd, args,
// {cwd}), which fails to spawn at all (an immediate "error" event, defaultSpawn's Task-2 Finding-1b
// handler, zero frames) if cwd doesn't exist on disk. Both legs just need to agree with EACH OTHER
// within a single test run — not with a byte-fixed golden across machines/time — so process.cwd()
// (always real) is the right fixture here, not a synthetic constant.
const FIXTURE_CWD = process.cwd();
// Phase 6 Task 10 (R6-9/R6-13): the fixture model moved INTO the reserved namespace.
//
// Production selection is catalog-first now and refuses a model it cannot resolve -- the pinned
// `"sonnet"` alias resolves to the `anthropic` provider only when a credential ref for it is
// configured, and no test has (or may have) one. `winter-test/<name>` is the ONE door to an
// in-process scripted double, and `WINTER_TEST_PROVIDER` remains the harness's alias for it,
// honoured because `config.model` is already in that namespace.
//
// `system/init.model` reports WHAT THE CALLER PASSED (R6-9), so this value is visible in every
// golden -- which is why the goldens move in the same commit as this line and in no other.
const FIXTURE_MODEL = "winter-test/echo";

// Absolute path to the real winter entrypoint. There is no package export for a non-data file like
// an entrypoint script (nor should there be one — this is test-only wiring, never a runtime
// import), so this resolves it the same way scripts/differential.ts resolves its sibling-package
// golden file: a relative URL from this file's own location.
const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));

// WS-04 §5's interrupt is a protocol-level control_request the WRAPPER has no API to send yet
// (Query.interrupt() is a stub). Testing it at the transport boundary means synchronizing with "the
// engine has genuinely started the turn and is blocked inside provider.generate()" from OUTSIDE the
// process — and unlike a tool-level hang, a provider-level hang emits no observable frame first, so
// there is no wire event to wait on. A short real-clock wait is the only mechanism available across
// a real OS pipe boundary; precedented by this codebase's own timing-based synchronization
// (transport.test.ts's 30ms pre-abort delay, query.ts's own 50ms KILL_GRACE_MS) — 150ms is several
// orders of magnitude past the microtask-scheduling gap it covers. See the task report's Concerns.
const INTERRUPT_SETTLE_MS = 150;

// Task 5: "compiled" is a third leg — a real spawned process, like "child", but the binary IS the
// executable (no `process.execPath main.ts` wrapping) — active only when WINTER_COMPILED_BIN is
// set (verify-protocol-compiled.ts sets it after building to a temp path). LEG_NAMES only grows to
// include it when the env var is present, so the Finding-7 loop below (the one thing that iterates
// LEG_NAMES) picks it up automatically; the main equivalence describe block further down stays
// hand-written per pair (inMemory vs child) and is untouched by this — its compiled-leg mirror is
// its own separate, env-gated describe block at the end of this file.
type LegName = "inMemory" | "child" | "compiled";
const LEG_NAMES: LegName[] = process.env.WINTER_COMPILED_BIN ? ["inMemory", "child", "compiled"] : ["inMemory", "child"];

// P3 fix round 1 (RULING P3-C): registers BGTASK_TEST_TOOL_NAME for the IN-MEMORY leg, which runs in
// THIS process -- a spawned child/compiled process shares no module state with this test file, so it
// registers its own copy independently (main.ts's own conditional call, gated on
// WINTER_TEST_PROVIDER=bgtask, provider/mock.ts's registerBgTaskTestTool's own doc comment). Module-
// load-time, once per `bun test` invocation of this file, exactly like testing.ts's own
// registerEquivalenceStandIn calls.
registerBgTaskTestTool();

// Task 8 (P3 close-out): every scripted TestProviderName whose target is a REAL WS-06 tool name
// (reachable now via tools/impl/index.ts's production wiring) rather than one of the throwaway
// snake_case doubles ("test_tool"/"mystery_tool") testing.ts pre-registers to mirror stubExecutor's
// own echo. One shared set (not a repeated inline `=== "bgtask" || ...` chain) so a future addition
// here can't independently drift between this file's own spawnHook branch and any other reader.
//
// Phase 4 Task 3: "mcpsdk" joins this set for the identical reason -- its target tool
// (mcp__<server>__echo) is registered dynamically by engine.ts's own SDK-MCP-server wiring
// (registerMcpServerTools + a real sdk_mcp_call-forwarding executor, never a WS-06 descriptor), and
// that registration+forwarding path only runs when the in-memory leg dispatches through the real
// registry. Leaving "mcpsdk" out of this set silently swapped in stubExecutor's blind
// `${name}:${JSON.stringify(input)}` echo for the in-memory leg only -- discovered empirically: the
// child leg (which always uses the real registry) genuinely forwarded through the fixture's
// `callTool`, but the in-memory leg's "tool_result" content came back prefixed with the qualified
// tool name (stubExecutor's own `name` parameter, the canonical `mcp__t8mcpsdk__echo`) -- a
// harness-config gap (this set is spawnHook's own fixture-selection knob, never engine.ts), not an
// engine-side divergence, but exactly the class of bug compareTraces exists to catch: the two legs
// disagreeing on wire content is a release blocker per spec regardless of which side the actual
// root cause sits on.
// Phase 4 Task 8: "subagent"/"childmsg" join for the identical reason -- their target tools (Agent,
// SendMessage) are REAL WS-06 names with real executors reached through the impl barrel, so the
// in-memory leg must dispatch through the real registry, not stubExecutor's blind echo.
// Phase 5 Task 8: the six P5 fixtures join for the identical reason -- each targets a REAL tool
// name with a real executor reached through the impl barrel (`StructuredOutput` is host-generated
// from the session's own seam, `Skill`/`Workflow`/`Write`/`Bash` are registry entries), so the
// in-memory leg must dispatch through the real registry rather than stubExecutor's blind echo.
// `p5compact` is here too even though it makes no tool call at all: leaving it out would hand the
// in-memory leg a different executor than the child leg, which is a divergence this file exists to
// forbid regardless of whether any current assertion could see it.
const REGISTRY_BACKED_TEST_PROVIDERS: ReadonlySet<TestProviderName> = new Set([
  "bgtask", "lanea", "laneb", "lanec", "laned", "lanee", "mcpsdk", "subagent", "childmsg", "subagentperm", "toolsearch",
  "p5compact", "p5structured", "p5structuredfail", "p5skill", "p5checkpoint", "p5workflow",
]);

// --- Phase 5 Task 8: the echoed prompt, after the assembler is wired ------------------------------
//
// `echoProvider` echoes the LAST USER MESSAGE it was handed. With Lane C's assembler registered in
// production (production-wiring.ts, on every leg), that message is `<user-context blocks>\n\n<the
// prompt>` on the live request -- R5-9's "always injected as user-context", re-attached every turn
// and never persisted. The default session carries one such block (the auto-memory guidance), whose
// text names this session's own resolved memory directory: a machine- and run-specific absolute
// path that no byte-exact literal can hold.
//
// So the shape a scenario actually cares about is asserted instead: exactly one text block, echoing
// exactly this prompt, with the prompt LAST. That is strictly stronger than a `toContain` on the
// prompt (a stray later block would slip past that) and it still fails if a turn echoes the wrong
// envelope, which is what the multi-turn scenarios below are for.
//
// CROSS-LEG EQUIVALENCE IS UNAFFECTED and is checked separately, byte-for-byte: every scenario's
// `compareTraces(a.trace, b.trace)` runs both legs under one shared TEST_WINTER_HOME, so the two
// legs' blocks are identical strings and a divergence in the injected context would still fail
// there -- which is the assertion this file exists for.
function expectEchoedPrompt(content: unknown, prompt: string): void {
  expect(Array.isArray(content)).toBe(true);
  const blocks = content as Array<{ type: string; text: string }>;
  expect(blocks.length).toBe(1);
  expect(blocks[0]?.type).toBe("text");
  const text = blocks[0]!.text;
  expect(text.startsWith("echo: ")).toBe(true);
  // Either no user-context block at all (a session that disabled auto-memory) or the prompt after
  // the blocks -- never the prompt merely appearing somewhere in the middle.
  expect(text === `echo: ${prompt}` || text.endsWith(`\n\n${prompt}`)).toBe(true);
}

// Phase 5 Task 8: a scenario-LOCAL volatile scrub, never a widening of `trace.ts`'s shared VOLATILE
// set. Two reasons it must stay local: that set is what the committed differential goldens are
// normalized by, so widening it would silently stop pinning the `resume` golden's own meaningful
// uuid chain; and the keys below are volatile only in THESE scenarios (a compaction's preserved-uuid
// list, a workflow's run/task ids and paths), not in general.
//
// Applied to the JSON TEXT of the whole trace, because the values that need scrubbing live BOTH in
// structured fields and inside a JSON-encoded tool_result STRING -- where a key-walking scrub cannot
// reach them at all (the P4 `scrubJsonToolResults` helper exists for exactly that reason). Escaped
// and unescaped quote forms are both matched, which is what makes one pass cover both placements.
function scrubVolatileText(entries: ConformanceTraceEntry[], patterns: RegExp[]): ConformanceTraceEntry[] {
  let text = JSON.stringify(entries);
  for (const re of patterns) text = text.replace(re, (m) => m.replace(/:(\\?")[^"\\]*\1/, ":$1SCRUBBED$1"));
  return JSON.parse(text) as ConformanceTraceEntry[];
}

/** `"<key>":"<value>"`, in both the plain and the backslash-escaped (inside-a-JSON-string) forms. */
/**
 * A compaction boundary's `preserved_messages` names the kept segment BY UUID -- minted inside the
 * store, per run, so two independent runs of the same scenario never agree on them. Replaced by
 * their POSITION, which keeps the assertion meaningful (both legs must preserve the same NUMBER of
 * messages, anchored the same way) without pinning a random value.
 */
function scrubPreservedUuids(entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] {
  return entries.map((e) => {
    const meta = (e.payload as { compact_metadata?: { preserved_messages?: { anchor_uuid: string; uuids: string[] } } } | undefined)?.compact_metadata;
    if (meta?.preserved_messages === undefined) return e;
    return {
      ...e,
      payload: { ...(e.payload as object), compact_metadata: { ...meta, preserved_messages: { anchor_uuid: "ANCHOR", uuids: meta.preserved_messages.uuids.map((_, i) => `PRESERVED_${i}`) } } },
    };
  });
}

function volatileKey(key: string): RegExp {
  return new RegExp(`\\\\?"${key}\\\\?":\\\\?"[^"\\\\]*\\\\?"`, "g");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- leg construction ----------------------------------------------------------------------------

// Builds the SpawnClaudeCodeProcess hook for one leg (WS-04 §1: both legs speak the identical frame
// contract through the same protocol code path — this is the one place that picks which transport
// backs a given scenario run). `testProviderName`, when given, selects a WINTER_TEST_PROVIDER
// scripted behavior — passed as a direct function call for the in-memory leg, as an env var merged
// into the child's environment for the real leg (provider/mock.ts's testProviderByName is the SAME
// function both call, so the two legs are byte-identical by construction). `capture` is populated
// SYNCHRONOUSLY — query() invokes the hook before returning its generator, and the two manually-
// driven scenarios below invoke it directly — so every caller may assume `capture.proc` is set
// before it starts reading.
function spawnHook(
  leg: LegName,
  testProviderName: TestProviderName | undefined,
  capture: { proc?: SpawnedRuntimeProcess },
  // Phase 4 fix wave: per-scenario environment, merged LAST so a scenario can shorten a control
  // that is otherwise unreachable through Options -- specifically WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS,
  // which the CHILD engine reads from the runtime's own environment on every leg (main.ts hands
  // `process.env` to registerDefaultChildEngineFactory; testing.ts hands inMemoryProcess's own env
  // parameter, which is this same object).
  scenarioEnv?: Record<string, string | undefined>,
  // Phase 6 Task 10: see `QueryScenarioOptions.registryBackedTools` for why this is explicit.
  registryBackedTools?: boolean,
): SpawnClaudeCodeProcess {
  return (opts: SpawnRuntimeOptions): SpawnedRuntimeProcess => {
    // WINTER_HOME merged in for every leg (Task 8 HARD CONSTRAINT) — ahead of the
    // WINTER_TEST_PROVIDER merge, which stays conditional exactly as before.
    const env = { ...opts.env, WINTER_HOME: TEST_WINTER_HOME, ...(testProviderName ? { WINTER_TEST_PROVIDER: testProviderName } : {}), ...(scenarioEnv ?? {}) };
    let proc: SpawnedRuntimeProcess;
    if (leg === "inMemory") {
      // The in-memory leg has no real child env to merge into — inMemoryProcess's own 4th `env`
      // param controls where (if anywhere) it persists (Task 8); passed the SAME env object so all
      // three legs share one WINTER_HOME.
      //
      // P3 fix round 1 (RULING P3-C): "bgtask" is the ONE scenario in this file whose target tool
      // needs a REAL ToolExecutionContext (ctx.emitFrame) -- stubExecutor's shape has no context
      // parameter at all, so it structurally cannot serve this scenario. Passing `undefined` (instead
      // of `stubExecutor`) lets inMemoryProcess build the SAME registry-backed default main.ts now
      // uses, matching the child/compiled branches below exactly. Every OTHER testProviderName here
      // keeps `stubExecutor` unchanged -- their own target names ("test_tool"/"mystery_tool") have no
      // WS-06 descriptor and never will, so this substitution is invisible to every pre-existing
      // scenario (registerEquivalenceStandIn's own echo executor for those names, testing.ts, is
      // byte-identical to stubExecutor's formula: `${name}:${JSON.stringify(input)}`).
      //
      // Task 8 (P3 close-out): the five "lane*" providers join "bgtask" here for the identical
      // reason -- each targets a REAL WS-06 tool name (Glob/Write/Bash/TaskCreate/EnterPlanMode)
      // that now has a real executor (the production-wiring MUST, tools/impl/index.ts) and needs the
      // real registry-backed dispatch, not stubExecutor's blind echo.
      proc = inMemoryProcess(
        opts.args,
        testProviderName ? testProviderByName(testProviderName) : echoProvider,
        registryBackedTools === true || (testProviderName !== undefined && REGISTRY_BACKED_TEST_PROVIDERS.has(testProviderName)) ? undefined : stubExecutor,
        env,
      );
    } else if (leg === "compiled") {
      // Task 5: the compiled `winter` binary IS the executable — spawn it directly (no
      // `process.execPath main.ts` wrapping the way the dev-child leg below needs). Same env
      // plumbing as the dev-child leg (WINTER_TEST_PROVIDER passthrough), same opts.args untouched.
      const compiledBin = process.env.WINTER_COMPILED_BIN;
      if (!compiledBin) throw new Error("spawnHook: leg 'compiled' requires WINTER_COMPILED_BIN to be set");
      proc = defaultSpawn({ ...opts, command: compiledBin, args: [...opts.args], env });
    } else {
      proc = defaultSpawn({
        ...opts,
        command: process.execPath, // under bun, process.execPath IS bun, which runs .ts directly
        args: [mainPath, ...opts.args],
        env,
      });
    }
    capture.proc = proc;
    return proc;
  };
}

// --- trace helpers ---------------------------------------------------------------------------

function kindOfMessage(message: { type: string; subtype?: string }): string {
  return message.type === "system" ? `system/${message.subtype}` : message.type;
}

// Appends one runtime->host trace entry for a raw WinterFrame — "data" frames are unwrapped to
// their .message (matching what query() itself yields, so raw-driven and query()-driven scenarios
// produce directly comparable entry shapes); other frame kinds (init, control_response) are
// recorded whole. `sequence` is a placeholder — normalizeTrace renumbers from final array position.
function pushFrame(entries: ConformanceTraceEntry[], frame: WinterFrame): void {
  if (frame.type === "data") {
    const message = (frame as { message: { type: string; subtype?: string } }).message;
    entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOfMessage(message), payload: message });
  } else {
    entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: frame.type, payload: frame });
  }
}

// Folds "how did this leg's run end" into the SAME comparison mechanism compareTraces already
// provides (direction:"process" exists in the ConformanceTraceEntry taxonomy precisely for this,
// WS-04 §12) rather than a parallel, easy-to-forget assertion: a leg that threw a DIFFERENT error
// class, or exited with a different code/signal, while otherwise emitting identical data frames is
// every bit as real a transport divergence as a mismatched payload.
function describeThrown(err: unknown): Record<string, unknown> {
  if (err === undefined) return { thrownClass: null };
  const ctorName = err instanceof Error ? err.constructor.name : typeof err;
  const out: Record<string, unknown> = { thrownClass: ctorName, message: err instanceof Error ? err.message : String(err) };
  if (err instanceof ProcessError) {
    out.code = err.code ?? null;
    out.signal = err.signal ?? null;
  }
  return out;
}

function pushExit(entries: ConformanceTraceEntry[], payload: Record<string, unknown>): void {
  entries.push({ sequence: entries.length, direction: "process", kind: "exit", payload });
}

// --- scenario runner: through query() ---------------------------------------------------------

interface QueryScenarioOptions {
  prompt: string | AsyncIterable<string>;
  testProviderName?: TestProviderName;
  useAbortController?: boolean;
  // Task 9 (WS-05 §7): threaded straight into query()'s options — lets a scenario pre-allocate a
  // session id and/or resume a previously-established one over the SAME leg's spawnHook (which
  // always merges in the shared TEST_WINTER_HOME below, so two traceViaQuery calls using the same
  // sessionId genuinely resume across two separate query()/process instances, never merely reuse
  // in-process state).
  sessionId?: string;
  resume?: string;
  // Ruling P2-I: with the real PromptStage wired, an unmatched tool call with zero permission
  // configuration now denies (WS-07 §6.1 "never implicitly allowed") rather than falling through
  // the retired T6 interim-allow fallback — scenarios that need a tool call to actually EXECUTE
  // (this file's own point is transport/wire equivalence, not permissions) pre-approve it here.
  allowedTools?: string[];
  // Ruling P2-B / Task 8: lets a scenario register a real canUseTool callback, exercised through
  // query()'s own wrapper handler — the ONLY way to prove the runtime-originated "permission"
  // control_request round-trips end-to-end on every leg.
  canUseTool?: CanUseTool;
  // Task 10 (WS-08 §1/§9/§10): lets a scenario register real SDK-callback hooks, exercised through
  // query()'s own "hook" wrapper handler — the ONLY way to prove the runtime-originated "hook"
  // control_request (and the public hook_started/hook_response lifecycle stream it can trigger)
  // round-trips end-to-end on every leg, including a REAL spawned child process.
  hooks?: Options["hooks"];
  includeHookEvents?: boolean;
  // Task 13 (WS-07 §2 / §12 "stale-policy-version" / mode-switch-mid-session equivalence): lets a
  // scenario start a session in a non-default mode — needed to observe a LIVE setPermissionMode()
  // switch away from it mid-session (permissionMode alone would only prove two SEPARATE sessions'
  // own configured-at-startup behavior, not the live-switch mechanic WS-07 §2 promises).
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  // Task 8 (P3 close-out, "Settings threading" MUST): lets a scenario configure the session's
  // effective sandbox posture -- the Lane C equivalence scenario below passes `{enabled:false}` so
  // its Bash round runs identically whether or not the host actually has /usr/bin/sandbox-exec
  // (Linux CI does not), proving the settings-threading wiring end-to-end rather than depending on
  // this suite running on a darwin box.
  sandbox?: Options["sandbox"];
  // Phase 4 Task 3 (WS-04 addendum): lets a scenario configure Options.mcpServers -- the ONLY way to
  // prove the sdk_mcp_call host-side bridge (query.ts's own makeSdkMcpCallHandler + toWireMcpServers)
  // round-trips byte-identically on every leg, since the LIVE `instance` object lives entirely in
  // THIS test process regardless of which leg actually runs the runtime.
  mcpServers?: Options["mcpServers"];
  // Phase 4 Task 3: lets a scenario supply resolved runtime capability tokens (e.g. "winter.mcp") --
  // registry.ts's own `isAvailable` gates every MCP-family descriptor (including a freshly
  // registerMcpServerTools-registered one, buildMcpToolDescriptor's own capabilityRequirements) on
  // this token, a pre-existing I4/P3 precedent this task's own SDK-server wiring did NOT change
  // (deliberately -- see registry.ts's own comment on why: T8 flips it to runtime-derived later, not
  // this task). Without it, a live-registered SDK server's tool is genuinely absent from
  // `system/init.tools` on every leg alike -- both legs would silently agree on that (possibly
  // wrong) shape, since compareTraces only diffs the two legs against EACH OTHER, never against the
  // spec. The MCP SDK-server scenario below passes this explicitly so its own init-advertisement
  // assertion means something.
  capabilities?: Options["capabilities"];
  // Phase 4 fix wave, follow-up (9) / whole-branch M9: lets a scenario turn Tool Search on. Activation
  // travels as `RuntimeConfig.toolSearchEnabled` and is leg-invariant BY CONSTRUCTION -- which is
  // exactly why the two things that are NOT (the `tool_reference` emission and the load-first
  // execution boundary) needed a scenario rather than an argument.
  toolSearchEnabled?: boolean;
  // Invoked once per yielded message, AFTER it's recorded into the trace — the kill/abort
  // scenarios use this to act at a precise, OBSERVED point in the stream (WS-04 events), never a
  // real-clock guess (unlike the raw-driven interrupt scenario, which has no such observable event
  // to key off — see INTERRUPT_SETTLE_MS above). `setPermissionMode` (Task 13) is the SAME live
  // method query.test.ts's own setPermissionMode() test drives — exposed here so a scenario can
  // fire a genuine mid-stream mode switch from an OBSERVED point (e.g. "the first round's result"),
  // never a real-clock guess.
  onMessage?: (
    msg: { type: string },
    ctx: {
      proc: SpawnedRuntimeProcess | undefined;
      abort: () => void;
      setPermissionMode: (mode: PermissionMode) => Promise<void>;
      // P6 fix wave (Ruling E-2): the R6-I picker flow -- `supportedModels()[i].value` into
      // `setModel()` -- driven between two turns of one session, on every leg.
      setModel: (model?: string) => Promise<void>;
      supportedModels: () => Promise<ModelInfo[]>;
    },
  ) => void;
  // Phase 4 fix wave (T8 review I2): WS-10 §4's own forwarding gate -- with it ON, a child's text
  // and its tool_use/tool_result blocks reach the parent's wire stamped with `parent_tool_use_id`,
  // which is the whole point of the scenario below. Off (the default) for every pre-existing
  // scenario, so none of their traces move.
  forwardSubagentText?: boolean;
  // Phase 4 fix wave: extra environment for the runtime process on every leg -- see spawnHook.
  env?: Record<string, string | undefined>;
  // --- Phase 5 Task 8: the P5 configuration axes -------------------------------------------------
  //
  // Each is a real `Options` field the P5 wiring reads, and each is the ONLY way to drive its
  // scenario across a real process boundary: a spawned/compiled leg receives its whole configuration
  // as `--config-json`, so anything not on `RuntimeConfig` is unreachable there.
  contextWindowTokens?: number;
  compactionThreshold?: number;
  outputFormat?: Options["outputFormat"];
  enableFileCheckpointing?: boolean;
  skills?: Options["skills"];
  settingSources?: Options["settingSources"];
  // --- Phase 6 Task 10: the provider-layer axes -------------------------------------------------
  //
  // `model` and `provider` are what point a session at the shared loopback fake, and both must be
  // real `Options` fields for the same reason every field above is: a spawned or compiled leg
  // receives its WHOLE configuration as `--config-json`, so anything not on `RuntimeConfig` is
  // simply unreachable there.
  model?: string;
  provider?: Options["provider"];
  /**
   * Whether the IN-MEMORY leg dispatches tool calls through the real registry, as every spawned leg
   * always does.
   *
   * IT HAS TO BE EXPLICIT. `spawnHook` selects `stubExecutor` for the in-memory leg unless the
   * scenario names a `testProviderName` in `REGISTRY_BACKED_TEST_PROVIDERS` — a rule written when the
   * only way to script a provider was by NAME. A P6 scenario scripts its provider through a loopback
   * FAKE and names no test provider at all, so it fell into the stub branch and its in-memory leg
   * echoed `Glob:{...}` while its child leg ran the real Glob: a genuine cross-leg divergence
   * produced by the harness, not by the runtime.
   */
  registryBackedTools?: boolean;
  fallbackModel?: string;
  includePartialMessages?: boolean;
  agents?: Options["agents"];
}

interface ScenarioResult {
  trace: ConformanceTraceEntry[]; // normalized; always ends with a direction:"process" exit entry
  thrown: unknown;
}

async function traceViaQuery(leg: LegName, scenario: QueryScenarioOptions): Promise<ScenarioResult> {
  const capture: { proc?: SpawnedRuntimeProcess } = {};
  const abortController = scenario.useAbortController ? new AbortController() : undefined;
  const entries: ConformanceTraceEntry[] = [];
  let thrown: unknown;
  try {
    const gen = query({
      prompt: scenario.prompt,
      options: {
        model: scenario.model ?? FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        spawnClaudeCodeProcess: spawnHook(leg, scenario.testProviderName, capture, scenario.env, scenario.registryBackedTools),
        ...(abortController ? { abortController } : {}),
        ...(scenario.sessionId !== undefined ? { sessionId: scenario.sessionId } : {}),
        ...(scenario.resume !== undefined ? { resume: scenario.resume } : {}),
        ...(scenario.allowedTools !== undefined ? { allowedTools: scenario.allowedTools } : {}),
        ...(scenario.canUseTool !== undefined ? { canUseTool: scenario.canUseTool } : {}),
        ...(scenario.hooks !== undefined ? { hooks: scenario.hooks } : {}),
        ...(scenario.includeHookEvents !== undefined ? { includeHookEvents: scenario.includeHookEvents } : {}),
        ...(scenario.permissionMode !== undefined ? { permissionMode: scenario.permissionMode } : {}),
        ...(scenario.allowDangerouslySkipPermissions !== undefined ? { allowDangerouslySkipPermissions: scenario.allowDangerouslySkipPermissions } : {}),
        ...(scenario.sandbox !== undefined ? { sandbox: scenario.sandbox } : {}),
        ...(scenario.mcpServers !== undefined ? { mcpServers: scenario.mcpServers } : {}),
        ...(scenario.capabilities !== undefined ? { capabilities: scenario.capabilities } : {}),
        ...(scenario.toolSearchEnabled !== undefined ? { toolSearchEnabled: scenario.toolSearchEnabled } : {}),
        ...(scenario.forwardSubagentText !== undefined ? { forwardSubagentText: scenario.forwardSubagentText } : {}),
        ...(scenario.contextWindowTokens !== undefined ? { contextWindowTokens: scenario.contextWindowTokens } : {}),
        ...(scenario.compactionThreshold !== undefined ? { compactionThreshold: scenario.compactionThreshold } : {}),
        ...(scenario.outputFormat !== undefined ? { outputFormat: scenario.outputFormat } : {}),
        ...(scenario.enableFileCheckpointing !== undefined ? { enableFileCheckpointing: scenario.enableFileCheckpointing } : {}),
        ...(scenario.skills !== undefined ? { skills: scenario.skills } : {}),
        ...(scenario.settingSources !== undefined ? { settingSources: scenario.settingSources } : {}),
        ...(scenario.provider !== undefined ? { provider: scenario.provider } : {}),
        ...(scenario.fallbackModel !== undefined ? { fallbackModel: scenario.fallbackModel } : {}),
        ...(scenario.includePartialMessages !== undefined ? { includePartialMessages: scenario.includePartialMessages } : {}),
        ...(scenario.agents !== undefined ? { agents: scenario.agents } : {}),
      },
    });
    for await (const msg of gen) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOfMessage(msg), payload: msg });
      scenario.onMessage?.(msg, {
        proc: capture.proc,
        abort: () => abortController?.abort(),
        setPermissionMode: (mode) => gen.setPermissionMode(mode),
        setModel: (model) => gen.setModel(model),
        supportedModels: () => gen.supportedModels(),
      });
    }
  } catch (e) {
    thrown = e;
  } finally {
    // Reap every child leg explicitly (never rely on query()'s own internal paths having already
    // awaited it — the sawTerminal/aborted paths return/throw without doing so) so bun test never
    // lingers on a straggling process.
    if (capture.proc) await capture.proc.exited;
  }
  pushExit(entries, describeThrown(thrown));
  return { trace: normalizeTrace(entries), thrown };
}

// --- scenario runner: raw frame driver (bypasses query() — see header note) ---------------------

function createDriver(proc: SpawnedRuntimeProcess) {
  const pending: WinterFrame[] = [];
  let carry = "";
  const it = proc.stdout[Symbol.asyncIterator]();
  async function nextFrame(): Promise<WinterFrame | null> {
    while (pending.length === 0) {
      const { value, done } = await it.next();
      if (done) return null;
      const split = splitFrames(value, carry);
      carry = split.carry;
      pending.push(...split.frames);
    }
    return pending.shift() ?? null;
  }
  return {
    send(frame: WinterFrame): void {
      proc.stdin.write(encodeFrame(frame));
    },
    nextFrame,
  };
}

function buildRawProc(leg: LegName, testProviderName: TestProviderName | undefined, sessionId: string, extraConfig?: Partial<RuntimeConfig>): SpawnedRuntimeProcess {
  const capture: { proc?: SpawnedRuntimeProcess } = {};
  const hook = spawnHook(leg, testProviderName, capture);
  // Phase 5 Task 8: `extraConfig` exists because a spawned/compiled leg receives its WHOLE
  // configuration as `--config-json` -- there is no other channel, so a raw-driven scenario that
  // needs a non-default option (checkpointing, a context window) has to put it here.
  const config: RuntimeConfig = { sessionId, cwd: FIXTURE_CWD, model: FIXTURE_MODEL, ...extraConfig };
  return hook({
    command: "winter", // placeholder — ignored by both legs' hooks above (matches query.ts's own "winter" placeholder when a custom spawn hook is set)
    args: ["--run", "--config-json", JSON.stringify(config)],
    // The SPAWN cwd follows the CONFIG cwd: a real child is spawned with `node:child_process`, which
    // fails outright if the directory does not exist, and a scenario that relocates the session's own
    // cwd (the checkpoint round, which writes real files into a temp tree) must relocate both.
    cwd: config.cwd,
    env: process.env as Record<string, string>,
  });
}

async function traceMultiTurn(leg: LegName): Promise<ConformanceTraceEntry[]> {
  const proc = buildRawProc(leg, undefined, "multi-turn-fixture");
  // Exception-safe reaping (review finding 1): the `finally` below is CLEANUP-ONLY —
  // proc.kill() then await proc.exited, unconditionally — so an assertion failure ANYWHERE in the
  // body still reaps the process. It does NOT replace the natural `await proc.exited` at the end of
  // the try block: that in-body await is the proof the engine exits ON ITS OWN after end_input
  // (WS-04 §6) — folding the only reap into an unconditional kill would mask a real "never exits"
  // regression by killing it either way. kill() on an already-exited process (the success path,
  // where the finally's kill() always fires AFTER the natural exit above) is a harmless no-op on
  // both legs — inMemoryProcess.kill() has its own `if (settled) return;` guard, already idempotent
  // before this fix round; Bun/Node's ChildProcess.kill() on an already-reaped pid returns `false`
  // (ESRCH) without throwing (verified empirically for this fix — see the task report).
  try {
    const driver = createDriver(proc);
    const entries: ConformanceTraceEntry[] = [];

    const init = await driver.nextFrame();
    expect(init?.type).toBe("init");
    pushFrame(entries, init!);
    const sys = await driver.nextFrame();
    expect(sys?.type).toBe("data");
    pushFrame(entries, sys!);

    // Both envelopes written up front — mirrors engine.test.ts's own multi-turn precedent (the
    // Queue drains its backlog before honoring end, so both become turns regardless of read timing)
    // and WS-04 §2's "sequence of envelopes in streaming input mode."
    driver.send({ type: "user", text: "first" });
    driver.send({ type: "user", text: "second" });

    let resultsSeen = 0;
    while (resultsSeen < 2) {
      const frame = await driver.nextFrame();
      if (!frame) throw new Error(`${leg}: unexpected EOF while awaiting the second turn's frames`);
      pushFrame(entries, frame);
      if (frame.type === "data" && (frame as { message: { type: string } }).message.type === "result") resultsSeen++;
    }

    // end_input sent only AFTER both turns' results are observed (never up front alongside the user
    // frames): the pump acks end_input as soon as it dequeues that control frame, independent of
    // turn state, so sending it early would race its ack's wire position against turn 1's data
    // frames — an interleaving that can differ between legs on nothing more than chunk/hop count.
    // Sequencing it after both results pins its position structurally instead of by timing.
    driver.send({ type: "control_request", requestId: "end-input-1", subtype: "end_input", payload: undefined });
    const ack = await driver.nextFrame();
    expect(ack?.type).toBe("control_response");
    expect((ack as ControlResponseFrame).ok).toBe(true);
    pushFrame(entries, ack!);

    const eof = await driver.nextFrame();
    expect(eof).toBeNull();

    const exitInfo = await proc.exited; // natural exit — proves the engine terminates on its own
    pushExit(entries, { code: exitInfo.code, signal: exitInfo.signal });
    return normalizeTrace(entries);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function traceInterrupt(leg: LegName): Promise<ConformanceTraceEntry[]> {
  const proc = buildRawProc(leg, "hang", "interrupt-fixture");
  // Exception-safe reaping (review finding 1) — see traceMultiTurn's comment for the full
  // rationale. This function is the sharper case: the "hang" provider's generate() NEVER resolves
  // on its own (no stdin-EOF exit — end_input only arrives after we already observed the
  // interrupted result — and no parent-death exit either), so a body that throws BEFORE reaching
  // the interrupt/end_input exchange would orphan a child that can never exit by itself. The
  // `finally` guarantees a kill either way; the natural `await proc.exited` after end_input in the
  // try block is still what proves the engine returns to a cleanly-terminable idle state post-
  // interrupt, per WS-04 §5 — the finally's kill() on that already-exited process is then a no-op.
  try {
    const driver = createDriver(proc);
    const entries: ConformanceTraceEntry[] = [];

    const init = await driver.nextFrame();
    pushFrame(entries, init!);
    const sys = await driver.nextFrame();
    pushFrame(entries, sys!);

    driver.send({ type: "user", text: "please hang" });
    await sleep(INTERRUPT_SETTLE_MS); // see INTERRUPT_SETTLE_MS's comment above
    driver.send({ type: "control_request", requestId: "interrupt-1", subtype: "interrupt", payload: { scope: "turn" } });

    const ack = await driver.nextFrame();
    expect(ack?.type).toBe("control_response");
    expect((ack as ControlResponseFrame).ok).toBe(true);
    pushFrame(entries, ack!);

    const result = await driver.nextFrame();
    expect(result?.type).toBe("data");
    const resultMessage = (result as { message: unknown }).message;
    // Direct sanity check on the provisional interrupted-result shape (engine.test.ts's own pin) —
    // a cross-leg trace diff alone can never catch a bug that affects BOTH legs identically.
    // Finding 3 (P2 fix-wave): permission_denials is now always present -- [] here, this turn denied nothing.
    expect(resultMessage).toEqual({ type: "result", subtype: "success", is_error: false, interrupted: true, permission_denials: [] });
    pushFrame(entries, result!);

    driver.send({ type: "control_request", requestId: "end-input-1", subtype: "end_input", payload: undefined });
    const endAck = await driver.nextFrame();
    expect((endAck as ControlResponseFrame).ok).toBe(true);
    pushFrame(entries, endAck!);

    const eof = await driver.nextFrame();
    expect(eof).toBeNull();

    const exitInfo = await proc.exited; // natural exit — proves the engine is back to a clean idle state
    pushExit(entries, { code: exitInfo.code, signal: exitInfo.signal });
    return normalizeTrace(entries);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

// Review finding 2: exercises splitFrames' "carry" mechanism directly — a single frame's ENCODED
// bytes, deliberately cut mid-line and written via two separate stdin.write() calls, must still
// decode to exactly one frame once both slices have arrived. Bypasses driver.send() (which always
// writes one full encoded frame per call) to get raw, sub-frame control over what hits the wire.
async function traceSplitFrameCarry(leg: LegName): Promise<ConformanceTraceEntry[]> {
  const proc = buildRawProc(leg, undefined, "split-carry-fixture");
  try {
    const driver = createDriver(proc);
    const entries: ConformanceTraceEntry[] = [];

    const init = await driver.nextFrame();
    pushFrame(entries, init!);
    const sys = await driver.nextFrame();
    pushFrame(entries, sys!);

    const encoded = encodeFrame({ type: "user", text: "carried" });
    const mid = Math.floor(encoded.length / 2);
    const firstSlice = encoded.slice(0, mid); // no trailing "\n" yet — must be held in `carry`
    const secondSlice = encoded.slice(mid); // completes the line
    proc.stdin.write(firstSlice);
    if (leg !== "inMemory") {
      // A real OS pipe can coalesce two quick writes into a single read on the receiving end,
      // which would let this scenario pass trivially without ever exercising the carry path (the
      // two slices would just arrive pre-joined). A short delay makes the two writes land as
      // separate reads in practice — but the scenario is correct (and stays green) even on a run
      // where the OS coalesces them anyway, since a single already-complete line decodes fine too.
      // Fix round 1 (reviewer Finding B, controller Ruling P1-M): applies to EVERY real-process leg
      // (child AND compiled — both are real OS pipes), not just "child" — the original `leg ===
      // "child"` check predates the compiled leg and silently left it far LESS LIKELY to exercise
      // the carry path on that leg (T5 fix-wave: "never" overstated it — coalescing without the
      // delay is likely, not guaranteed; REDUCING how often the carry path fires is the accurate
      // claim, not eliminating it). The in-memory leg alone needs no such delay: each stdin.write()
      // is its own Queue entry by construction (no OS buffering to coalesce across), so it
      // deterministically exercises the carry path every run regardless.
      await sleep(20);
    }
    proc.stdin.write(secondSlice);

    let resultsSeen = 0;
    while (resultsSeen < 1) {
      const frame = await driver.nextFrame();
      if (!frame) throw new Error(`${leg}: unexpected EOF while awaiting the split-frame turn`);
      pushFrame(entries, frame);
      if (frame.type === "data" && (frame as { message: { type: string } }).message.type === "result") resultsSeen++;
    }

    driver.send({ type: "control_request", requestId: "end-input-1", subtype: "end_input", payload: undefined });
    const ack = await driver.nextFrame();
    expect(ack?.type).toBe("control_response");
    expect((ack as ControlResponseFrame).ok).toBe(true);
    pushFrame(entries, ack!);

    const eof = await driver.nextFrame();
    expect(eof).toBeNull();

    const exitInfo = await proc.exited;
    pushExit(entries, { code: exitInfo.code, signal: exitInfo.signal });
    return normalizeTrace(entries);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function traceResumeScenario(leg: LegName): Promise<{ trace: ConformanceTraceEntry[]; sessionId: string; secondAssistantText: string }> {
  const sessionId = randomUUID();
  const entries: ConformanceTraceEntry[] = [];
  let secondAssistantText = "";

  async function runLeg(prompt: string, extra: { sessionId?: string; resume?: string }): Promise<void> {
    const capture: { proc?: SpawnedRuntimeProcess } = {};
    try {
      const gen = query({
        prompt,
        options: {
          model: FIXTURE_MODEL,
          cwd: FIXTURE_CWD,
          spawnClaudeCodeProcess: spawnHook(leg, "reflect", capture),
          ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
          ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
        },
      });
      for await (const msg of gen) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOfMessage(msg), payload: msg });
        if (msg.type === "assistant") {
          const content = (msg as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
          const textBlock = content.find((b) => b.type === "text");
          if (textBlock?.text !== undefined) secondAssistantText = textBlock.text;
        }
      }
    } finally {
      if (capture.proc) await capture.proc.exited;
    }
  }

  // Run 1: establishes history under a freshly-minted, pre-allocated sessionId.
  await runLeg("first", { sessionId });
  // Run 2: a NEW process/instance resumes that SAME sessionId.
  await runLeg("second", { resume: sessionId });

  pushExit(entries, describeThrown(undefined));
  return { trace: normalizeTrace(entries), sessionId, secondAssistantText };
}


// --- Phase 4 Task 8 (rider 25's normalization gap #2): scenario-local tool_result scrubbing -------
//
// Lane C's own finding, restated: a JSON-encoded tool_result `content` is a plain STRING, and
// `normalizeTrace`'s VOLATILE stripping is a recursive walk over OBJECT keys -- it never parses JSON
// found inside a string value, so `agentId`/`totalDurationMs`/`messageId` inside the Agent and
// SendMessage payloads are structurally unreachable to it.
//
// Fixed HERE, scenario-locally, rather than by widening trace.ts's shared VOLATILE set -- which
// would be actively wrong: `task_id` and `output_file` are MEANINGFUL fixed literals pinned by
// scripts/differential.ts's own background-task golden and by this file's own bgtask scenario
// (`task_id: "t2-fixture-task"`), and stripping them globally would delete real assertions'
// subjects. Deliberately the same posture scripts/differential.ts's own bash-background scenario
// already takes for its value-based scrub.
// Phase 4 fix wave (whole-branch N5): `totalToolUseCount` is deliberately NOT in this set. It is
// the one key here that could MASK a real cross-leg divergence (a child counting its own tool calls
// differently on two transports is exactly the kind of drift this corpus exists to catch), and it
// is not volatile at all for these fixtures -- every scenario's child makes a fixed number of tool
// calls. The rest genuinely are volatile: uuids, wall-clock durations, and machine-specific paths.
const AGENT_RESULT_VOLATILE_KEYS = new Set(["agentId", "totalDurationMs", "taskId", "messageId", "transcript"]);

function scrubJsonToolResults(entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] {
  const scrubValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = AGENT_RESULT_VOLATILE_KEYS.has(k) ? "<scrubbed>" : scrubValue(v);
    }
    return out;
  };
  return entries.map((entry) => {
    const message = (entry.payload as { message?: { content?: unknown } } | undefined)?.message;
    if (!message || !Array.isArray(message.content)) return entry;
    const content = message.content.map((block) => {
      const b = block as { type?: string; content?: unknown; name?: string; input?: unknown };
      // A tool_use whose INPUT embeds a volatile id -- SendMessage's `to` is the child's own agentId,
      // read by the fixture provider out of the Agent result, so it is as machine-specific as the
      // agentId itself. Scrubbed by the same key set, on the input object.
      if (b.type === "tool_use" && typeof b.input === "object" && b.input !== null) {
        const input = b.input as Record<string, unknown>;
        if (b.name === "SendMessage" && typeof input.to === "string") return { ...b, input: { ...input, to: "<scrubbed>" } };
        return block;
      }
      if (b.type !== "tool_result" || typeof b.content !== "string") return block;
      try {
        return { ...b, content: JSON.stringify(scrubValue(JSON.parse(b.content))) };
      } catch {
        return block; // not JSON (Glob's newline-joined list, Bash's text) -- left untouched
      }
    });
    return { ...entry, payload: { ...(entry.payload as object), message: { ...message, content } } };
  });
}

// --- the equivalence suite -----------------------------------------------------------------------
//
// Registers the 9 equivalence scenarios (WS-04 §12) comparing `legA` against `legB`. Controller
// ruling (Task 5 rider): this was previously two hand-copied 9-test lists — the block below, plus a
// verbatim mirror of it for the compiled leg — rejected as the final shape because two
// hand-mirrored lists WILL drift (a 10th scenario added to one and forgotten in the other is silent
// coverage loss — this project's most-burned failure class). Extracting the registrations into one
// function parameterized on leg names removes the duplication entirely: there is exactly one copy
// of each scenario's body, assertions, and comments, no matter how many leg pairings call this.
// This function only registers `test()`s — it does not open its own `describe` scope — so each call
// site keeps its own title.
function registerEquivalenceScenarios(legA: LegName, legB: LegName): void {
  test("plain query", async () => {
    const a = await traceViaQuery(legA, { prompt: "hi" });
    const b = await traceViaQuery(legB, { prompt: "hi" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "result", "exit"]);
    const assistantMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expectEchoedPrompt(assistantMsg.message.content, "hi");
  });

  test("multi-turn (streaming input, 2 envelopes) — raw wire, independent of query()", async () => {
    const a = await traceMultiTurn(legA);
    const b = await traceMultiTurn(legB);
    expect(compareTraces(a, b)).toEqual([]);
    expect(a.map((e) => e.kind)).toEqual(["init", "system/init", "assistant", "result", "assistant", "result", "control_response", "exit"]);
    const first = a[2]!.payload as { message: { content: unknown } };
    expectEchoedPrompt(first.message.content, "first");
    const second = a[4]!.payload as { message: { content: unknown } };
    expectEchoedPrompt(second.message.content, "second");
  });

  // Controller Ruling P1-I: query()'s own streaming-input iteration, exercised directly (not the
  // raw wire above) — this is what actually broke for a real consumer before the query.ts fix in
  // this round (see this file's header note). RED before the fix (only turn 1 surfaced, no error);
  // GREEN after (mode-aware termination — see query.ts).
  test("multi-turn via query() (streaming input, 2 envelopes)", async () => {
    const twoTurns = () =>
      (async function* () {
        yield "first";
        yield "second";
      })();
    const a = await traceViaQuery(legA, { prompt: twoTurns() });
    const b = await traceViaQuery(legB, { prompt: twoTurns() });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "result", "assistant", "result", "exit"]);
    const first = a.trace[1]!.payload as { message: { content: unknown } };
    expectEchoedPrompt(first.message.content, "first");
    const second = a.trace[3]!.payload as { message: { content: unknown } };
    expectEchoedPrompt(second.message.content, "second");
  });

  test("tool round", async () => {
    // Ruling P2-I: allowedTools:["test_tool"] pre-approves the "tooluse" provider's own call so it
    // executes as before — this scenario proves wire/transport equivalence, not permissions.
    const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "tooluse", allowedTools: ["test_tool"] });
    const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "tooluse", allowedTools: ["test_tool"] });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
    const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "test-call-1", name: "test_tool", input: { probe: true } }]);
    const toolResultMsg = a.trace[2]!.payload as { message: { content: unknown } };
    expect(toolResultMsg.message.content).toEqual([{ type: "tool_result", tool_use_id: "test-call-1", content: 'test_tool:{"probe":true}' }]);
  });

  // P3 fix round 1 (RULING P3-C): the background-task message family (WS-06 §3.5) -- ctx.emitFrame ->
  // the wire -- now proven identically across EVERY leg this pairing covers, closing the structural
  // gap Task 2 documented and deliberately stopped short of (main.ts hard-coded `tools: stubExecutor`
  // unconditionally, so ctx.emitFrame was unreachable on the child/compiled legs by construction).
  // The "bgtask" TestProviderName + BGTASK_TEST_TOOL_NAME pairing (provider/mock.ts) is what makes
  // this reachable on a REAL spawned/compiled process: the provider selects by env name (like every
  // other child/compiled scenario here), and main.ts's own resolveProvider() registers the matching
  // tool when that name is selected, so the SAME registry-backed dispatch this file's inMemory-leg
  // spawnHook branch now also uses picks it up on every leg identically.
  test("background-task message family (WS-06 §3.5): ctx.emitFrame -> the wire, identically on every leg", async () => {
    const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "bgtask", allowedTools: [BGTASK_TEST_TOOL_NAME] });
    const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "bgtask", allowedTools: [BGTASK_TEST_TOOL_NAME] });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual([
      "system/init",
      "assistant",
      "system/task_started",
      "system/task_progress",
      "system/task_notification",
      "user",
      "assistant",
      "result",
      "exit",
    ]);
    const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "bgtask-call-1", name: BGTASK_TEST_TOOL_NAME, input: {} }]);

    expect(a.trace[2]!.payload).toEqual({ type: "system", subtype: "task_started", task_id: "t2-fixture-task", description: "fixture background task" });

    expect(a.trace[3]!.payload).toEqual({
      type: "system",
      subtype: "task_progress",
      task_id: "t2-fixture-task",
      description: "fixture background task",
      usage: { total_tokens: 1, tool_uses: 1 }, // duration_ms is normalizeTrace's own VOLATILE field -- stripped
    });

    expect(a.trace[4]!.payload).toEqual({
      type: "system",
      subtype: "task_notification",
      task_id: "t2-fixture-task",
      status: "completed",
      output_file: "/dev/null",
      summary: "fixture background task complete",
    });

    const toolResultMsg = a.trace[5]!.payload as { message: { content: unknown } };
    expect(toolResultMsg.message.content).toEqual([{ type: "tool_result", tool_use_id: "bgtask-call-1", content: "bgtask-probe-done" }]);
  });

  // Task 8 (P3 close-out, production-wiring MUST): "one tool-round scenario per lane family runs on
  // all three legs" -- the equivalence proof that tools/impl/index.ts's barrel wiring reaches a REAL
  // WS-06 tool's REAL executor identically on every transport, not just in-process (where every
  // lane's own impl/*.test.ts already exercises it directly). Each scenario targets ONE
  // representative tool per lane (provider/mock.ts's own header names the choice and why); every
  // scenario also proves the equivalence-suite-wide invariant (`allowedTools` pre-approves so the
  // scenario proves TRANSPORT equivalence, not permissions, mirroring "tool round"/"bgtask" above).
  describe("Task 8: one real WS-06 tool round per lane family, on every leg", () => {
    test("Lane A (Read/Glob/Grep): a real Glob round", async () => {
      const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "lanea", allowedTools: ["Glob"] });
      const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "lanea", allowedTools: ["Glob"] });
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();
      expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
      const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
      expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "lanea-call-1", name: "Glob", input: { pattern: "winter-t8-lanea-fixture-*.does-not-exist-anywhere" } }]);
      const toolResultMsg = a.trace[2]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string }> } };
      const resultText = toolResultMsg.message.content[0]!.content;
      // Glob's real executor (glob.ts) returns a plain newline-joined path list, not JSON -- a
      // no-match result is the empty string. Proven identical across legs by compareTraces above;
      // this assertion just confirms it is genuinely the real executor's own no-match shape, never a
      // stub/unregistered-tool echo (which would read `Glob:{"pattern":...}`).
      expect(resultText).toBe("");
      const finalMsg = a.trace[3]!.payload as { message: { content: unknown } };
      expect(finalMsg.message.content).toEqual([{ type: "text", text: "lane a done" }]);
    });

    test("Lane B (Edit/Write/NotebookEdit): a real Write round", async () => {
      // ONE real, absolute path shared by BOTH legs (advisor guidance, this task's own report): the
      // scripted "laneb" provider (provider/mock.ts) reads it back out of the query's own `prompt`
      // text, so both legs embed the IDENTICAL literal in their own Write call/result -- the mkdtemp
      // path itself is created once, here, by the TEST, never inside either spawned leg.
      const fixtureDir = mkdtempSync(join(tmpdir(), "winter-t8-laneb-"));
      afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));
      const filePath = join(fixtureDir, "out.txt");

      const a = await traceViaQuery(legA, { prompt: filePath, testProviderName: "laneb", allowedTools: ["Write"] });
      // Found empirically (this scenario's own first draft): both legs target the SAME literal path
      // by design (see this test's own header comment), but Write's own executor is genuinely
      // stateful -- a file that already exists takes the "update" branch (with `previousContent`
      // populated), while a fresh path takes "create". Running BOTH legs against the same path
      // SEQUENTIALLY means leg B's own call would otherwise see the file leg A's call just created,
      // producing a genuinely different (not merely differently-ordered) result shape than leg A saw
      // -- a real behavioral fact about Write, not a test bug to route around by comparing less.
      // Removing what leg A wrote before leg B's call keeps this a fair "identical fresh input on
      // both legs" comparison rather than accidentally testing "create" against "update".
      rmSync(filePath, { force: true });
      const b = await traceViaQuery(legB, { prompt: filePath, testProviderName: "laneb", allowedTools: ["Write"] });
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();
      expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
      const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
      expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "laneb-call-1", name: "Write", input: { file_path: filePath, content: "winter-t8-laneb-fixture-content\n" } }]);
      const toolResultMsg = a.trace[2]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string }> } };
      const resultText = toolResultMsg.message.content[0]!.content;
      expect(resultText).not.toContain("Write:{");
      expect(JSON.parse(resultText)).toMatchObject({ type: "create" });
      const finalMsg = a.trace[3]!.payload as { message: { content: unknown } };
      expect(finalMsg.message.content).toEqual([{ type: "text", text: "lane b done" }]);
      // Both legs really wrote the file (not just agreeing on an error) -- read it back once, for real.
      expect(readFileSync(filePath, "utf8")).toBe("winter-t8-laneb-fixture-content\n");
    });

    // `sandbox: {enabled:false}` (Task 8's own "Settings threading" MUST) makes this scenario run
    // identically whether or not the host has /usr/bin/sandbox-exec (Linux CI does not) -- proving
    // BOTH the production-wiring barrel AND the settings-threading plumbing end-to-end, without
    // darwin-gating a real cross-leg proof.
    test("Lane C (Bash/sandbox/Monitor/TaskOutput/TaskStop): a real, unsandboxed Bash round", async () => {
      const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "lanec", allowedTools: ["Bash"], sandbox: { enabled: false } });
      const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "lanec", allowedTools: ["Bash"], sandbox: { enabled: false } });
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();
      expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
      const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
      expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "lanec-call-1", name: "Bash", input: { command: "echo winter-t8-lanec" } }]);
      const toolResultMsg = a.trace[2]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string }> } };
      const resultText = toolResultMsg.message.content[0]!.content;
      expect(resultText).not.toContain("Bash:{");
      expect(resultText).toContain("winter-t8-lanec");
      expect(resultText).toContain("[exit 0]");
      expect(resultText).toContain("[sandbox: config-disabled]");
      const finalMsg = a.trace[3]!.payload as { message: { content: unknown } };
      expect(finalMsg.message.content).toEqual([{ type: "text", text: "lane c done" }]);
    });

    test("Lane D (task graph/Cron/ScheduleWakeup/ReportFindings/PushNotification): a real ReportFindings round", async () => {
      // ReportFindings, not TaskCreate: found empirically (this scenario's own first draft) that
      // TaskCreate mints a fresh randomUUID() row id per call (task-graph-store.ts) that can never be
      // byte-identical across two SEPARATE invocations -- see provider/mock.ts's own "laned" comment.
      const findingInput = { findings: [{ file: "winter-t8-laned.ts", summary: "lane d equivalence fixture", failure_scenario: "none -- deterministic fixture" }] };
      const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "laned", allowedTools: ["ReportFindings"] });
      const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "laned", allowedTools: ["ReportFindings"] });
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();
      expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
      const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
      expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "laned-call-1", name: "ReportFindings", input: findingInput }]);
      const toolResultMsg = a.trace[2]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string }> } };
      const resultText = toolResultMsg.message.content[0]!.content;
      expect(resultText).not.toContain("ReportFindings:{");
      // A pure, stateless echo of the validated input (report-findings.ts's own header) -- byte-equal
      // to what was sent, no invented fields.
      expect(JSON.parse(resultText)).toEqual(findingInput);
      const finalMsg = a.trace[3]!.payload as { message: { content: unknown } };
      expect(finalMsg.message.content).toEqual([{ type: "text", text: "lane d done" }]);
    });

    test("Lane E (plan/worktree posture, AskUserQuestion, advisor): a real EnterPlanMode round", async () => {
      const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "lanee", allowedTools: ["EnterPlanMode"] });
      const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "lanee", allowedTools: ["EnterPlanMode"] });
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();
      expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);
      const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
      expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "lanee-call-1", name: "EnterPlanMode", input: {} }]);
      const toolResultMsg = a.trace[2]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string }> } };
      const resultText = toolResultMsg.message.content[0]!.content;
      expect(resultText).not.toContain("EnterPlanMode:{");
      expect(JSON.parse(resultText)).toMatchObject({ mode: "plan" });
      const finalMsg = a.trace[3]!.payload as { message: { content: unknown } };
      expect(finalMsg.message.content).toEqual([{ type: "text", text: "lane e done" }]);
    });
  });

  // Phase 4 Task 3 (WS-04 addendum, "sdk_mcp_call host-side bridge" -- BOTH halves): the ONE
  // consumer of the "mcpsdk" scripted provider (provider/mock.ts). The live `instance` object lives
  // entirely in THIS test process regardless of which leg actually runs the runtime (query.ts's own
  // makeSdkMcpCallHandler is host-side code, never spawned) -- so this scenario proves the WHOLE
  // bridge (runtime-side forwarding via bridge.request + host-side invocation of the live instance)
  // is byte-identical across legs BY CONSTRUCTION, not merely by coincidence: the only thing that
  // differs between legs is which process runs engine.ts's own registration/forwarding code, and
  // that code is exactly what this task's own engine.test.ts unit-proves in isolation.
  describe("Phase 4 Task 3: MCP SDK-server tool round (sdk_mcp_call both halves, every leg)", () => {
    test("an in-process SDK server's tool is reachable end-to-end and byte-identical across legs", async () => {
      function makeFixtureInstance(): { instance: WinterMcpServerInstance; calls: Array<{ name: string; args: Record<string, unknown> }> } {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        return {
          calls,
          instance: {
            listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
            async callTool(name: string, args: Record<string, unknown>) {
              calls.push({ name, args });
              return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
            },
          },
        };
      }
      const fixtureA = makeFixtureInstance();
      const fixtureB = makeFixtureInstance();
      const mcpServersFor = (fixture: ReturnType<typeof makeFixtureInstance>): Options["mcpServers"] => ({
        [MCP_SDK_TEST_SERVER_NAME]: { type: "sdk", name: MCP_SDK_TEST_SERVER_NAME, instance: fixture.instance },
      });

      // Phase 4 Task 3: "winter.mcp" is REQUIRED for a live-registered MCP tool to appear in
      // system/init.tools at all -- registry.ts's own buildMcpToolDescriptor gates every
      // registerMcpServerTools-registered descriptor on this capability token (the SAME pre-existing
      // I4/P3 gate WebSearch/LSP/ToolSearch/WaitForMcpServers/ListMcpResourcesTool already carry;
      // this task's own SDK-server wiring deliberately did not special-case around it -- see
      // registry.ts's own comment: auto-derivation is a LATER task's job). Omitting it here would
      // make BOTH legs silently agree the tool is unadvertised (compareTraces only diffs legs
      // against each other, never against the spec) while this scenario's own scripted provider
      // still "calls" it regardless -- proving only the wire mechanics, not MUST 3's advertisement
      // obligation. Supplying it is what makes the init.tools assertion below mean something.
      const a = await traceViaQuery(legA, {
        prompt: "go",
        testProviderName: "mcpsdk",
        allowedTools: [MCP_SDK_TEST_TOOL_NAME],
        mcpServers: mcpServersFor(fixtureA),
        capabilities: ["winter.mcp"],
      });
      const b = await traceViaQuery(legB, {
        prompt: "go",
        testProviderName: "mcpsdk",
        allowedTools: [MCP_SDK_TEST_TOOL_NAME],
        mcpServers: mcpServersFor(fixtureB),
        capabilities: ["winter.mcp"],
      });
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();
      expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);

      // MUST 3: the live-registered SDK server's tool is genuinely ADVERTISED (system/init.tools),
      // not merely callable out-of-band of advertisement -- checked on both legs independently
      // (compareTraces already proved them equal to each other; this pins the actual value).
      const initA = a.trace[0]!.payload as { tools: string[] };
      const initB = b.trace[0]!.payload as { tools: string[] };
      expect(initA.tools).toContain(MCP_SDK_TEST_TOOL_NAME);
      expect(initB.tools).toContain(MCP_SDK_TEST_TOOL_NAME);

      // The live instance was genuinely invoked on BOTH legs, with the identical (name, arguments).
      expect(fixtureA.calls).toEqual([{ name: "echo", args: { x: 1 } }]);
      expect(fixtureB.calls).toEqual(fixtureA.calls);

      const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
      expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "mcpsdk-call-1", name: MCP_SDK_TEST_TOOL_NAME, input: { x: 1 } }]);
      const toolResultMsg = a.trace[2]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string }> } };
      expect(toolResultMsg.message.content[0]!.content).toBe('echo:{"x":1}');
      const finalMsg = a.trace[3]!.payload as { message: { content: unknown } };
      expect(finalMsg.message.content).toEqual([{ type: "text", text: "mcp sdk done" }]);
    });
  });

  // Phase 4 fix wave, follow-up (9) -- whole-branch review M9, the Minor Lane X could not take
  // ("it needs a SECOND provider/mock.ts arm... a second ownership deviation for a Minor in the
  // ToolSearch family, whose files Lane Y owns, is not defensible").
  //
  // What was unproven, precisely: `toolsearch-select-round` is an IN-MEMORY golden only. Activation
  // itself travels as `RuntimeConfig.toolSearchEnabled` and is leg-invariant by construction, so the
  // gap was never "does the flag arrive" -- it is the two mechanisms activation switches ON: the
  // `tool_reference` block the runtime emits after a successful `select:`, and the load-first
  // execution boundary that makes the selected name callable only afterwards. Both are runtime-side
  // emissions, and neither had ever run on the child or compiled leg.
  describe("ToolSearch select -> tool_reference -> call, on both legs (whole-branch M9)", () => {
    test("the deferred tool is withheld from init.tools, selected by ToolSearch, and then executes -- identically on both legs", async () => {
      function makeFixtureInstance(): { instance: NonNullable<Options["mcpServers"]>[string] extends { instance?: infer I } ? I : never; calls: Array<{ name: string; args: Record<string, unknown> }> } {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        return {
          calls,
          instance: {
            listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
            async callTool(name: string, args: Record<string, unknown>) {
              calls.push({ name, args });
              return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
            },
          } as never,
        };
      }
      const fixtureA = makeFixtureInstance();
      const fixtureB = makeFixtureInstance();
      const mcpServersFor = (fixture: ReturnType<typeof makeFixtureInstance>): Options["mcpServers"] => ({
        [MCP_SDK_TEST_SERVER_NAME]: { type: "sdk", name: MCP_SDK_TEST_SERVER_NAME, instance: fixture.instance },
      });
      // `ToolSearch` must be in the allowlist alongside the deferred target: a bare allowlist is a
      // PRE-APPROVAL, not a visibility filter (WS-06 §1.3), so this only pre-approves the two calls
      // this scenario makes -- the deferral partition is what decides what the model is SHOWN.
      const scenarioFor = (fixture: ReturnType<typeof makeFixtureInstance>) => ({
        prompt: "find and call it",
        testProviderName: "toolsearch" as const,
        toolSearchEnabled: true,
        allowedTools: ["ToolSearch", MCP_SDK_TEST_TOOL_NAME],
        mcpServers: mcpServersFor(fixture),
        capabilities: ["winter.mcp"],
      });
      const a = await traceViaQuery(legA, scenarioFor(fixtureA));
      const b = await traceViaQuery(legB, scenarioFor(fixtureB));
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();
      expect(b.thrown).toBeUndefined();

      // Both legs pinned by VALUE, not merely equal to each other -- `compareTraces` diffs the legs
      // against each other and would happily agree on a shared regression.
      for (const [leg, trace] of [[legA, a.trace], [legB, b.trace]] as const) {
        const init = trace[0]!.payload as { tools: string[] };
        // RULING P4-A's partition, on the real wire of a real transport: `ToolSearch` is advertised,
        // and the deferred MCP tool is NOT -- the model has to search for it.
        expect(init.tools, `${leg}: ToolSearch must be advertised when activation is on`).toContain("ToolSearch");
        expect(init.tools, `${leg}: a deferred tool must be withheld from init.tools`).not.toContain(MCP_SDK_TEST_TOOL_NAME);
        expect(init.tools, `${leg}: WaitForMcpServers partitions against ToolSearch`).not.toContain("WaitForMcpServers");

        // The `tool_reference` block -- the emission that had never run off the in-memory leg.
        // Read structurally off the trace, never by substring: an escaped-JSON `toContain` would
        // pass on a block that merely MENTIONED the name somewhere.
        const blocks = trace
          .filter((e) => e.kind === "assistant" || e.kind === "user")
          .flatMap((e) => ((e.payload as { message?: { content?: unknown } }).message?.content ?? []) as Array<Record<string, unknown>>);
        const reference = blocks.find((bl) => bl["type"] === "tool_reference");
        expect(reference, `${leg}: a real tool_reference block must reach the wire`).toBeDefined();
        expect(reference!["tool_names"], `${leg}: the tool_reference must name the selected tool`).toEqual([MCP_SDK_TEST_TOOL_NAME]);

        // ...and the selected name then EXECUTED, rather than being refused by the load-first
        // boundary (which would have produced a `loadFirst` tool_result instead of the echo).
        const echoResult = blocks.find((bl) => bl["type"] === "tool_result" && bl["tool_use_id"] === "ts-call-2");
        expect(echoResult?.["content"], `${leg}: the selected tool must have executed`).toBe('echo:{"x":1}');
        expect(echoResult?.["loadFirst"], `${leg}: nothing may have been refused as unloaded`).toBeUndefined();

        // The `select:` itself came back as a real match against a genuinely deferred pool.
        const searchResult = blocks.find((bl) => bl["type"] === "tool_result" && bl["tool_use_id"] === "ts-call-1");
        const parsed = JSON.parse(String(searchResult?.["content"])) as { matches: string[]; total_deferred_tools: number };
        expect(parsed.matches, `${leg}: select: must resolve the deferred name`).toEqual([MCP_SDK_TEST_TOOL_NAME]);
        expect(parsed.total_deferred_tools, `${leg}: the deferred pool must be non-empty`).toBeGreaterThan(0);
      }

      // The live instance was genuinely invoked on BOTH legs, with the identical (name, arguments) --
      // the fixture object lives in THIS process, so this is proof the whole round-trip happened.
      expect(fixtureA.calls).toEqual([{ name: "echo", args: { x: 1 } }]);
      expect(fixtureB.calls).toEqual(fixtureA.calls);
    });
  });

  // Task 13 (Carry 1, WS-07 §6.1 / Ruling P2-I): the COMPOSED, integration-level proof that a
  // query() with ZERO permission configuration at all (no rules, no canUseTool, no hooks) denies an
  // unmatched tool call under the spec-literal deny-when-unresolved outcome, and the run CONTINUES
  // to completion — never hangs, never throws. The mechanism composes structurally from pieces
  // already proven individually elsewhere in this codebase: no canUseTool means query.ts never
  // registers a "permission" handler, so the runtime's own bridge.request("permission", ...) lands
  // on T2's unconditional per-subtype auto-answer (`{ok:false, code:"unhandled_subtype"}` — the SAME
  // fallback this file's "an unregistered control subtype from the runtime is auto-answered" sibling
  // in query.test.ts proves for the "hook" subtype), which resolves promptStage.ts to a genuine
  // `null` ("no opinion", never a throw), which evaluate() then maps to a denial per Ruling P2-I.
  // scripts/differential.ts's "denied-tool-round" golden pins this exact scenario's frozen wire
  // shape; this is the SAME scenario proven equivalent across REAL transports instead.
  test("Carry 1: a query() with ZERO permission config denies an unmatched tool call (spec-literal deny-when-unresolved), and the run continues to a normal completion", async () => {
    const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "tooluse" });
    const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "tooluse" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "system/permission_denied", "user", "assistant", "result", "exit"]);
    const permissionDeniedMsg = a.trace[2]!.payload as { decision_reason_type?: string; tool_use_id?: string };
    expect(permissionDeniedMsg.decision_reason_type).toBe("mode"); // no rule, no hook -- the mode stage's own fail-closed floor resolved it
    expect(permissionDeniedMsg.tool_use_id).toBe("test-call-1");
    const toolResultMsg = a.trace[3]!.payload as { message: { content: Array<{ denied?: boolean }> } };
    expect(toolResultMsg.message.content[0]?.denied).toBe(true);
    // The run genuinely continued past the denial to a SECOND provider turn and a clean completion.
    const result = a.trace[5]!.payload as { subtype?: string; is_error?: boolean; result?: string };
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(false);
    expect(result.result).toBe("tool round done");
  });

  // Task 13 (WS-07 §2 / §12 "stale-policy-version rejection" / "equivalence completeness check"):
  // ONE session, two turns, a LIVE setPermissionMode() call between them, proven identical across a
  // REAL spawned child process (and, on the "inMemory"/"compiled" pairing above, the compiled
  // binary) — not just the in-memory-only differential golden of the same scenario
  // (scripts/differential.ts's "mode-switch-mid-session"). Turn 1 runs under bypassPermissions (an
  // unmatched call executes unconditionally, WS-07 §6.4); the mode is switched to dontAsk once turn
  // 1's result is OBSERVED and the switch's ack is awaited (never a real-clock guess); turn 2's
  // IDENTICAL unmatched call is then denied outright, canUseTool never invoked (WS-07 §6.3). The
  // "modeswitch" provider (provider/mock.ts, added by this task) supplies the fixed 4-step script
  // both rounds need — "tooluse"'s own 2-step script cannot serve a second round.
  test("mode-switch mid-session: a live setPermissionMode() between two turns changes behavior — bypassPermissions executes an unmatched call unconditionally, dontAsk then denies the identical call", async () => {
    async function runLeg(leg: LegName): Promise<ScenarioResult> {
      let releaseSecondTurn!: () => void;
      const secondTurnGate = new Promise<void>((resolve) => {
        releaseSecondTurn = resolve;
      });
      async function* twoTurns() {
        yield "first";
        await secondTurnGate;
        yield "second";
      }
      let modeSwitchRequested = false;
      return traceViaQuery(leg, {
        prompt: twoTurns(),
        testProviderName: "modeswitch",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        onMessage: (msg, ctx) => {
          if (msg.type === "result" && !modeSwitchRequested) {
            modeSwitchRequested = true;
            ctx.setPermissionMode("dontAsk").then(releaseSecondTurn);
          }
        },
      });
    }
    const a = await runLeg(legA);
    const b = await runLeg(legB);
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual([
      "system/init",
      "assistant",
      "user",
      "assistant",
      "result",
      "assistant",
      "system/permission_denied",
      "user",
      "assistant",
      "result",
      "exit",
    ]);
    // Round 1 (bypassPermissions): the unmatched call executes unconditionally, no rule needed.
    const firstToolResult = a.trace[2]!.payload as { message: { content: unknown } };
    expect(firstToolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "mystery_tool:{}" }]);
    // Round 2 (dontAsk, live-switched): the SAME unmatched shape is now denied, never executed.
    const permissionDeniedMsg = a.trace[6]!.payload as { decision_reason_type?: string; tool_use_id?: string };
    expect(permissionDeniedMsg.decision_reason_type).toBe("mode");
    expect(permissionDeniedMsg.tool_use_id).toBe("c2");
    const secondToolResult = a.trace[7]!.payload as { message: { content: Array<{ type: string; tool_use_id: string; content: string; denied?: boolean }> } };
    expect(secondToolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "c2", content: expect.any(String), denied: true }]);
  });

  // Task 10 (WS-08 §1/§9/§10): a hooked tool round with includeHookEvents — proves the ENTIRE
  // hook-RPC round trip (query.ts's Options.hooks -> RuntimeConfig.hooks -> the real registry ->
  // the bridge -> the real SDK-callback -> back) on every leg, including a REAL spawned child
  // process, and that the public hook_started/hook_response lifecycle frames it triggers are
  // IDENTICAL across legs (hookId is positional/deterministic — the same `${event}:sdk:${group}:
  // ${index}` formula on both sides of the wire — and `uuid`/`session_id` are already in trace.ts's
  // VOLATILE set, so this needs no new normalizer entries). The PreToolUse hook's own "allow" is
  // ADVISORY ONLY (WS-07 §2.1 — evaluate() continues the pipeline regardless), so `allowedTools`
  // still does the actual authorizing at stage 5, exactly like the plain "tool round" scenario
  // above; this scenario's own point is the hook RPC round trip and lifecycle stream, not
  // re-proving stage 1's advisory-only semantics (already covered exhaustively in evaluator.test.ts).
  test("hooked tool round with includeHookEvents: PreToolUse hook allow + the public hook_started/hook_response lifecycle frames are identical across legs", async () => {
    const preToolUseAllow: Options["hooks"] = {
      PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } })] }],
    };
    const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "tooluse", allowedTools: ["test_tool"], hooks: preToolUseAllow, includeHookEvents: true });
    const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "tooluse", allowedTools: ["test_tool"], hooks: preToolUseAllow, includeHookEvents: true });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    // PreToolUse's own hook_started/hook_response fire from WITHIN evaluate(), which engine.ts
    // calls AFTER the tool_use ("assistant") block is already written to the wire (that file's own
    // comment: "the permission gate slots HERE — between this round's tool_use emission ... and
    // execution") — so the lifecycle pair lands between "assistant" and the tool_result ("user").
    expect(a.trace.map((e) => e.kind)).toEqual([
      "system/init",
      "assistant",
      "system/hook_started",
      "system/hook_response",
      "user",
      "assistant",
      "result",
      "exit",
    ]);
    const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "test-call-1", name: "test_tool", input: { probe: true } }]);
    const started = a.trace[2]!.payload as { type: string; subtype: string; hook_id: string; hook_name: string; hook_event: string };
    expect(started).toEqual({ type: "system", subtype: "hook_started", hook_id: "PreToolUse:sdk:0:0", hook_name: "", hook_event: "PreToolUse" });
    const response = a.trace[3]!.payload as { type: string; subtype: string; hook_id: string; hook_name: string; hook_event: string; output: string; stdout: string; stderr: string; outcome: string };
    expect(response).toEqual({
      type: "system",
      subtype: "hook_response",
      hook_id: "PreToolUse:sdk:0:0",
      hook_name: "",
      hook_event: "PreToolUse",
      output: "",
      stdout: "",
      stderr: "",
      outcome: "success",
    });
    // The hook's own allow resolved the call — the SAME tool round shape as the plain "tool round"
    // scenario above, proving the hook answer genuinely authorized execution (mechanism "hook",
    // not merely an ignored/observational hook riding alongside a separate allow).
    const toolResultMsg = a.trace[4]!.payload as { message: { content: unknown } };
    expect(toolResultMsg.message.content).toEqual([{ type: "tool_result", tool_use_id: "test-call-1", content: 'test_tool:{"probe":true}' }]);
  });

  // Controller-advisor-flagged residual (this task's own report, Concerns): the two halves of
  // "SessionEnd is structurally unanswerable in single-shot mode" were each already unit-proven
  // separately (bridge.test.ts's closed-flag fix; engine.ts's own extensive teardown-ordering
  // comment) but never composed end-to-end through the REAL sdk-side query() wrapper. This
  // scenario is that composed proof, on every leg including a real spawned child process.
  test("SessionEnd hook in single-shot mode: callback body never runs, query() still completes cleanly with no throw and no hang", async () => {
    let aRan = false;
    let bRan = false;
    const a = await traceViaQuery(legA, {
      prompt: "hi",
      includeHookEvents: true,
      hooks: { SessionEnd: [{ hooks: [async () => { aRan = true; return {}; }] }] },
    });
    const b = await traceViaQuery(legB, {
      prompt: "hi",
      includeHookEvents: true,
      hooks: { SessionEnd: [{ hooks: [async () => { bRan = true; return {}; }] }] },
    });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    // SessionEnd fires from engine.ts strictly AFTER the terminal `result` frame is written (its
    // own "teardown" call site, only once the turn loop has fully drained) — but a single-shot
    // query() consumer's readLoop deterministically breaks the INSTANT it processes that `result`
    // frame (query.ts: "single-shot prompt: exactly one turn, unchanged"), never asking for
    // another chunk and never processing any further already-decoded frame in the same batch. So
    // this hook's own hook_started/hook_response lifecycle frames can NEVER reach a single-shot
    // consumer, regardless of `includeHookEvents` or leg — the observed trace is byte-identical to
    // an unhooked plain query. This is the sharper, structural half of the advisor's flagged
    // limitation: not merely "the hook's answer arrives late", but "a single-shot consumer can
    // never observe this hook ran at all" — only the server-side audit journal (dialect.ts)
    // records its outcome (as "error"), and nothing reads that journal back yet at P2 (see this
    // task's report).
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "result", "exit"]);
    expect(aRan).toBe(false);
    expect(bRan).toBe(false);
  });

  // Ruling P2-B's own proof, plus Task 8's equivalence-scenario requirement (allow WITH
  // updatedInput) — combined deliberately: answering this RPC at all is only possible once BOTH
  // sides of P2-B are fixed, and the answer's updatedInput is what proves the whole canUseTool
  // result-mapping chain (query.ts -> bridge -> evaluator -> engine execution -> persistence).
  //
  // Deliberately configures ZERO allowedTools — the tool_use call is genuinely unmatched, so it
  // reaches canUseTool for real. Before Ruling P2-B, this exact scenario could not complete AT ALL:
  // the single-shot prompt's wrapper closed stdin immediately after sending end_input, so by the
  // time the tool call needed a permission decision, there was no way left to answer it — the
  // runtime's bridge.request("permission", ...) (no park timeout, WS-04 §3) would park forever and
  // this test would time out rather than fail an assertion. (Contrast the "tool round" scenario
  // just above, which never reaches canUseTool at all — its allowedTools entry pre-approves the
  // call at stage 5, so it could never have exposed this bug or proven this fix.)
  test("Ruling P2-B: a single-shot query's tool call reaches a real permission RPC the host ANSWERS, approved WITH updatedInput — the transformed input executes and persists", async () => {
    const sessionId = randomUUID();
    const approvedInput = { probe: false, approvedVia: "canUseTool" };
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      expect(toolName).toBe("test_tool");
      expect(input).toEqual({ probe: true });
      expect(opts.toolUseID).toBe("test-call-1");
      return { behavior: "allow", updatedInput: approvedInput };
    };

    const a = await traceViaQuery(legA, { prompt: "go", testProviderName: "tooluse", canUseTool, sessionId });
    const b = await traceViaQuery(legB, { prompt: "go", testProviderName: "tooluse", canUseTool });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);

    // the MODEL-visible tool_use still shows the ORIGINAL input (WS-07 §7.2: "the model sees the
    // tool result but is not separately told the input was transformed").
    const toolUseMsg = a.trace[1]!.payload as { message: { content: unknown } };
    expect(toolUseMsg.message.content).toEqual([{ type: "tool_use", id: "test-call-1", name: "test_tool", input: { probe: true } }]);

    // execution reflects the TRANSFORMED input.
    const expectedResultContent = [{ type: "tool_result", tool_use_id: "test-call-1", content: `test_tool:${JSON.stringify(approvedInput)}` }];
    const toolResultMsg = a.trace[2]!.payload as { message: { content: unknown } };
    expect(toolResultMsg.message.content).toEqual(expectedResultContent);

    // persisted transcript (temp WINTER_HOME) shows the SAME transformed execution.
    const store = new WinterCompatibilitySessionStore({ winterHome: TEST_WINTER_HOME });
    const projectKey = compatibilityKeys(FIXTURE_CWD).transcriptProjectKey;
    const loaded = await store.load({ projectKey, sessionId });
    expect(loaded).not.toBeNull();
    const persistedToolResult = loaded!.find(
      (e) => e.type === "user" && Array.isArray((e as { message?: { content?: unknown } }).message?.content),
    ) as { message: { content: unknown } } | undefined;
    expect(persistedToolResult).toBeDefined();
    expect(persistedToolResult!.message.content).toEqual(expectedResultContent);
  });

  // Phase 4 Task 8 (rider 6, Lane A's own OWED recipe verbatim): `system/init.mcp_servers`, across
  // every leg. The config is the SAME `type: "sdk"` shape the MCP SDK-server scenario above already
  // builds; what this adds is the LIFECYCLE half -- engine.ts now constructs a real McpLifecycle from
  // `config.mcpServers`, and RULING P4-C's state-only feed path (`feedSdkSlotConnected`) reports an
  // in-process SDK server as `connected` without any transport at all. Leg-independent BY
  // CONSTRUCTION, not by luck: that feed path is pure and synchronous, with no transport dependency,
  // and it reads the same wire-populated `RuntimeConfig.mcpServers.<name>.tools` field every leg
  // receives identically through `--config-json`.
  test("rider 6: system/init.mcp_servers reports an sdk-configured server as connected, identically on every leg", async () => {
    const makeInstance = (): WinterMcpServerInstance => ({
      listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
      async callTool(_name: string, args: Record<string, unknown>) {
        return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
      },
    });
    const mcpServers = (): Options["mcpServers"] => ({ [MCP_SDK_TEST_SERVER_NAME]: { type: "sdk", name: MCP_SDK_TEST_SERVER_NAME, instance: makeInstance() } });
    const a = await traceViaQuery(legA, { prompt: "hi", mcpServers: mcpServers() });
    const b = await traceViaQuery(legB, { prompt: "hi", mcpServers: mcpServers() });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    // compareTraces already proved the two legs agree; these pin the actual VALUE, so a shared
    // regression (both legs silently dropping mcp_servers) cannot pass.
    const initA = a.trace[0]!.payload as { mcp_servers?: Array<{ name: string; status: string }>; tools: string[] };
    const initB = b.trace[0]!.payload as { mcp_servers?: Array<{ name: string; status: string }> };
    expect(initA.mcp_servers).toEqual([{ name: MCP_SDK_TEST_SERVER_NAME, status: "connected" }]);
    expect(initB.mcp_servers).toEqual(initA.mcp_servers);
    // ...and the SAME session's `winter.mcp`-gated family is advertised, because declaring an MCP
    // server is exactly the session fact that derivation is gated on (registry.ts's
    // SessionCapabilityFacts) -- no host-supplied `capabilities` needed any more.
    expect(initA.tools).toContain("ListMcpResourcesTool");
    expect(initA.tools).toContain(MCP_SDK_TEST_TOOL_NAME);
  });

  // Phase 4 Task 8 (rider 25, Lane C's own "OWED to T8" recipe): a real subagent spawn round, on
  // every leg. Blocked before this task on Lane C's Gap #1 -- a spawned/compiled process shares no
  // module state with this test file, so the factory had to be registered by the ENTRYPOINTS
  // themselves (main.ts AND testing.ts, via subagents/register-default-factory.ts) before any leg
  // but in-memory could spawn at all.
  //
  // FOREGROUND deliberately (`run_in_background` omitted -> foreground per resolveForegroundBackground's
  // own SDK-default branch): a foreground spawn's tool call synchronously awaits handle.result(), so
  // the parent-turn / child-turn / parent-turn interleaving is deterministic under a single-threaded
  // event loop with no synchronization primitive. A background variant is real but inherently harder
  // to pin (fire-and-forget has no ordering guarantee against the parent's remaining turns).
  test("rider 25: a real subagent spawn round (Agent -> child -> result) is identical on every leg, and the child's frames are correlated, never flattened", async () => {
    const a = await traceViaQuery(legA, { prompt: "run the subagent", testProviderName: "subagent", allowedTools: ["Agent"] });
    const b = await traceViaQuery(legB, { prompt: "run the subagent", testProviderName: "subagent", allowedTools: ["Agent"] });
    expect(compareTraces(scrubJsonToolResults(a.trace), scrubJsonToolResults(b.trace))).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);

    const toolUse = a.trace[1]!.payload as { message: { content: Array<{ type: string; name: string }> } };
    expect(toolUse.message.content[0]).toMatchObject({ type: "tool_use", name: "Agent" });

    // WS-10 §4, the load-bearing assertion: the child's OWN init/result frames never surface on the
    // parent's stream (P4-J(c) / rider 23), the child emitted no tool calls of its own, and
    // `forwardSubagentText` is off by default -- so the ONLY thing the parent's stream carries about
    // the child is the Agent tool's own result. "Never flatten child messages into the main stream."
    expect(a.trace.filter((e) => e.kind === "system/init").length).toBe(1);
    expect(a.trace.filter((e) => e.kind === "result").length).toBe(1);

    // The Agent tool genuinely spawned and completed a real child -- not the "no child engine
    // factory is registered" error every leg produced before this task's entrypoint registration.
    const toolResult = a.trace[2]!.payload as { message: { content: Array<{ content: string }> } };
    const payload = JSON.parse(toolResult.message.content[0]!.content) as { agentId: string; content: Array<{ text: string }>; prompt: string };
    expect(payload.content[0]!.text).toBe("child finished");
    expect(payload.prompt).toBe(SUBAGENT_CHILD_PROBE_TEXT);
    expect(typeof payload.agentId).toBe("string");
    // Phase 4 fix wave (T8 review I2): this assertion is a NEGATIVE control -- the Agent tool
    // genuinely spawned rather than answering the "no child engine factory" error. The comment that
    // used to sit here claimed it asserted `parent_tool_use_id` on the wire, which it never did (and
    // could not: this scenario runs with forwardSubagentText OFF and a child that emits no tool
    // calls, so no child frame reaches the wire at all). The real cross-leg proof is the scenario
    // immediately below, added by the fix wave.
    expect(JSON.stringify(a.trace)).not.toContain("no child engine factory");
  }, 20_000);

  // Phase 4 fix wave (task-8 review I2 + whole-branch KNOWN 11): the ONE scenario that closes both
  // halves rider 6 named and the P4-I cross-leg gap.
  //
  //  * `forwardSubagentText: true` -- so the child's own frames actually reach the parent's wire.
  //  * the child makes a REAL tool call of its own ("subagentperm"), under `default` mode with no
  //    matching rule, so it reaches a genuine permission `control_request`.
  //  * that request is answered by the host THROUGH THE WRAPPER (query()'s own canUseTool handler),
  //    and only AFTER twice the (shortened) child stall timeout -- so rider 20's watchdog pause is
  //    load-bearing here rather than trivially beaten, exactly as the in-process test now is.
  //
  // Everything asserted is leg-invariant by construction: `test_tool`'s echo output is byte-
  // identical across the in-memory stand-in and main.ts's stubExecutor fallback, and the ids are the
  // fixture provider's own fixed literals, never uuids.
  test("fix wave: a child's own tool call is forwarded to the wire stamped with parent_tool_use_id, its late permission answer is honoured, identically on every leg", async () => {
    const CHILD_STALL_MS = 120;
    const run = (leg: LegName) =>
      traceViaQuery(leg, {
        prompt: "run the subagent",
        testProviderName: "subagentperm",
        allowedTools: ["Agent"], // the PARENT's own Agent call is pre-approved; only the CHILD's call prompts
        permissionMode: "default",
        forwardSubagentText: true,
        env: { WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: String(CHILD_STALL_MS) },
        canUseTool: async () => {
          // Answer LATE: twice the child's stall timeout, with the request outstanding. Without the
          // rider-20 pause the child would be reaped before this resolves and the tool_result below
          // would never exist.
          await new Promise((r) => setTimeout(r, CHILD_STALL_MS * 2));
          return { behavior: "allow", updatedInput: {} };
        },
      });
    const a = await run(legA);
    const b = await run(legB);
    expect(compareTraces(scrubJsonToolResults(a.trace), scrubJsonToolResults(b.trace))).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();

    // The parent's own Agent tool_use id -- read from the wire, never hardcoded here, so the
    // assertion below compares two values the RUNTIME produced rather than two literals this test
    // chose.
    const parentToolUseId = (a.trace.find((e) => e.kind === "assistant")!.payload as { message: { content: Array<{ type: string; id?: string; name?: string }> } }).message.content.find(
      (blk) => blk.type === "tool_use" && blk.name === "Agent",
    )!.id;
    expect(parentToolUseId).toBe("agent-call-1");

    // The CHILD's own tool_use block, forwarded onto the parent's stream and stamped with the
    // parent's tool_use id (WS-10 §4). Before the fix wave `parent_tool_use_id` appeared in ZERO
    // equivalence scenarios and ZERO goldens.
    const childToolUse = a.trace.find(
      (e) =>
        e.kind === "assistant" &&
        (e.payload as { parent_tool_use_id?: string }).parent_tool_use_id !== undefined &&
        ((e.payload as { message: { content: Array<{ type: string; name?: string }> } }).message.content ?? []).some((blk) => blk.type === "tool_use" && blk.name === "ReadNotifications"),
    );
    expect(childToolUse, "the child's own tool_use must reach the wire").toBeDefined();
    expect((childToolUse!.payload as { parent_tool_use_id?: string }).parent_tool_use_id).toBe(parentToolUseId);

    // ...and the child's tool actually EXECUTED (the late answer was honoured), with its
    // tool_result likewise correlated.
    const childToolResult = a.trace.find(
      (e) =>
        e.kind === "user" &&
        (e.payload as { parent_tool_use_id?: string }).parent_tool_use_id === parentToolUseId &&
        ((e.payload as { message: { content: Array<{ tool_use_id?: string }> } }).message.content ?? []).some((blk) => blk.tool_use_id === "child-call-1"),
    );
    expect(childToolResult, "the child's tool must have executed after the late permission answer").toBeDefined();
    const resultBlock = (childToolResult!.payload as { message: { content: Array<{ tool_use_id?: string; content?: string }> } }).message.content.find((blk) => blk.tool_use_id === "child-call-1")!;
    expect(resultBlock.content).toContain('"notifications":[]');
    // Same on the other leg, pinned by VALUE so a shared regression (both legs dropping the field)
    // cannot pass compareTraces alone.
    expect(JSON.stringify(b.trace)).toContain('"parent_tool_use_id":"agent-call-1"');
  }, 30_000);

  // Phase 4 Task 8: a SendMessage-to-child round, on every leg. Composes THREE things this task
  // wired that no earlier scenario could exercise together: the entrypoint child-engine factory
  // (rider 18), the process-level messaging runtime with this run's roster contributed to it, and
  // the real per-call `ctx.toolUseId` SendMessage derives its retry-stable messageId from (rider 14).
  test("Task 8: SendMessage addressed to this session's own child RESUMES it (WS-10 §10.3), identically on every leg", async () => {
    const run = (leg: LegName) => traceViaQuery(leg, { prompt: "spawn then steer", testProviderName: "childmsg", allowedTools: ["Agent", "SendMessage"] });
    const a = await run(legA);
    const b = await run(legB);
    expect(compareTraces(scrubJsonToolResults(a.trace), scrubJsonToolResults(b.trace))).toEqual([]);
    expect(a.thrown).toBeUndefined();
    expect(b.thrown).toBeUndefined();

    const sendResult = a.trace
      .filter((e) => e.kind === "user")
      .flatMap((e) => ((e.payload as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []))
      .find((blk) => blk.tool_use_id === "sendmsg-call-1");
    expect(sendResult, "the SendMessage call must produce a tool_result").toBeDefined();
    // The tool's own model-visible envelope is `{outcome: DeliveryOutcome, notify?}` (Lane D's
    // send-message.ts) -- not a bare DeliveryOutcome.
    const { outcome } = JSON.parse(sendResult!.content) as { outcome: { status: string; messageId?: string } };
    // The router resolved a REAL child of this session and produced a real DeliveryOutcome -- never
    // "no messaging runtime configured" (the pre-T8 answer) and never "not_found" (which is what a
    // roster the messaging runtime cannot see would produce).
    expect(sendResult!.content).not.toContain("no messaging runtime");
    // WS-10 §10.3's own row for a TERMINAL addressable child: SendMessage resumes it, and
    // `resumed_and_delivered` is claimed only when resume AND delivery both completed.
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(typeof outcome.messageId).toBe("string");
  }, 20_000);

  // --- Phase 6 Task 10: the PROVIDER equivalence scenarios --------------------------------------
  //
  // Every scenario below runs a REAL adapter -- resolved from the compiled catalog by the production
  // selection path -- against ONE loopback fake this harness starts, on every leg this pairing
  // covers. That is the whole claim: an in-memory session, a spawned `winter` child and (when
  // WINTER_COMPILED_BIN is set) the compiled binary all reach the SAME 127.0.0.1 port, and their
  // frame streams are identical.
  //
  // WHY THE FAKE IS STARTED HERE AND NOT PER LEG. Two fakes would prove that two sessions each talked
  // to their own server, which is not the question. One fake means one request log, and that log is
  // the ground truth for what a provider was actually asked -- never adapter intent.
  //
  // `connection.baseUrl` makes this a USER endpoint by definition (R6-11), which is correct and is
  // itself asserted: no privileged header may ride it. `local: true` is required because plain http
  // to a loopback address is refused unless the profile declares a local installation.
  function fakeProvider(fake: ScenarioFake): Options["provider"] {
    return {
      providerId: "unused-when-the-model-is-qualified",
      authRef: { kind: "inline", value: "test" },
      connection: { baseUrl: fake.url, local: true },
    };
  }

  for (const [name, model, path] of [
    ["p6-anthropic-fake", SCENARIO_MODELS.anthropic, "/v1/messages"],
    ["p6-openai-responses-fake", SCENARIO_MODELS.openaiResponses, "/responses"],
    ["p6-openai-chat-fake", SCENARIO_MODELS.openaiChat, "/chat/completions"],
    ["p6-gemini-fake", SCENARIO_MODELS.gemini, ":streamGenerateContent"],
  ] as const) {
    test(`${name}: text -> tool round -> final, on every leg against the SAME loopback fake`, async () => {
      const fake = await startScenarioFake();
      try {
        const scenario = { prompt: "run the provider scenario", model, provider: fakeProvider(fake), allowedTools: [SCENARIO_TOOL_NAME], registryBackedTools: true } satisfies QueryScenarioOptions;
        const a = await traceViaQuery(legA, scenario);
        const b = await traceViaQuery(legB, scenario);
        // GEMINI MINTS ITS OWN CALL IDS. `generateContent`'s `functionCall` carries no id at all, so
        // the adapter has to invent one per call — a genuinely per-run value, like every uuid this
        // file already scrubs, and NOT a cross-leg divergence.
        const scrubCallIds = (entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] =>
          JSON.parse(JSON.stringify(entries).replace(/google-call-[0-9a-f]+-\d+/g, "google-call-SCRUBBED")) as ConformanceTraceEntry[];
        expect(compareTraces(scrubCallIds(a.trace), scrubCallIds(b.trace))).toEqual([]);
        expect(a.thrown).toBeUndefined();
        expect(b.thrown).toBeUndefined();

        // The shape of a real tool round: text+call, the tool result, then the final answer.
        expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "user", "assistant", "result", "exit"]);

        // R6-9: `system/init.model` is WHAT THE CALLER PASSED, and the RESOLVED identity rides the
        // Winter-only extension -- WRITTEN BY PRODUCTION, on a real spawned process, not by a test.
        const init = a.trace[0]!.payload as { model: string; apiKeySource: string; winter_provider?: Record<string, unknown> };
        expect(init.model).toBe(model);
        expect(init.apiKeySource).toBe("none");
        expect(init.winter_provider).toBeDefined();
        expect(init.winter_provider?.modelKey).toBe(model);
        expect(init.winter_provider?.providerId).toBe(model.slice(0, model.indexOf("/")));
        expect(typeof init.winter_provider?.adapterId).toBe("string");
        expect(init.winter_provider?.authRefKind).toBe("inline");

        // The final text came from the FAKE, so the whole chain ran.
        const final = a.trace[3]!.payload as { message: { content: Array<{ type: string; text?: string }> } };
        expect(final.message.content.some((blk) => blk.type === "text" && blk.text === SCENARIO_FINAL_TEXT)).toBe(true);

        // GROUND TRUTH: two requests per leg, on this family's own path, and NO privileged header on
        // a user endpoint.
        const matching = fake.requests.filter((r) => r.path.endsWith(path));
        expect(matching.length).toBe(4); // two legs x (tool turn + final turn)
        expect(matching[0]?.method).toBe("POST");
        for (const request of matching) {
          expect(request.headers["originator"]).toBeUndefined();
          expect(request.headers["openai-organization"]).toBeUndefined();
        }
        // The second request of each leg carries the tool RESULT back -- the round genuinely closed.
        expect(matching.filter((r) => /tool_result|function_call_output|functionResponse|"role":"tool"/.test(r.body)).length).toBe(2);
        // THE WIRE MODEL ID, on EVERY request (review round 1's recommendation). The catalog KEY used
        // to go out here -- `anthropic/claude-sonnet-5`, a name no provider has heard of -- and the
        // goldens are byte-frozen against the fixed version, so without this assertion a regression
        // would only be caught if it happened to move a golden. `wireModel` is the descriptor's own
        // `upstreamId`: the part of the key after the provider prefix.
        // Gemini puts the model in the PATH (`/v1beta/models/<id>:streamGenerateContent`) rather than
        // in the body, so the assertion is "on the request", not "in the body" -- the same claim
        // either way, and phrasing it as the body alone would silently pass for that family.
        const wireModel = model.slice(model.indexOf("/") + 1);
        expect(matching.every((r) => r.body.includes(`"model":"${wireModel}"`) || r.path.includes(wireModel))).toBe(true);
        expect(matching.some((r) => r.body.includes(`"model":"${model}"`) || r.path.includes(encodeURIComponent(model)))).toBe(false);
      } finally {
        await fake.close();
      }
    });
  }

  test("p6-stream-events: `includePartialMessages` forwards the raw stream vocabulary, identically on every leg", async () => {
    const fake = await startScenarioFake();
    try {
      const scenario = {
        prompt: "stream it",
        model: SCENARIO_MODELS.anthropic,
        provider: fakeProvider(fake),
        includePartialMessages: true,
        allowedTools: [SCENARIO_TOOL_NAME],
        registryBackedTools: true,
      } satisfies QueryScenarioOptions;
      const a = await traceViaQuery(legA, scenario);
      const b = await traceViaQuery(legB, scenario);
      // `ttft_ms` is a REAL-CLOCK measurement that rides the first `stream_event` of each forwarded
      // generation (R6-G). Two legs measure two different machines' worth of latency; scrubbing it is
      // the same treatment every other volatile value in this file already gets.
      const scrubTtft = (entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] =>
        JSON.parse(JSON.stringify(entries).replace(/\\?"ttft_ms\\?":\d+/g, '"ttft_ms":0')) as ConformanceTraceEntry[];
      expect(compareTraces(scrubTtft(a.trace), scrubTtft(b.trace))).toEqual([]);
      const streamEvents = a.trace.filter((e) => e.kind === "stream_event");
      expect(streamEvents.length).toBeGreaterThan(0);
      // R6-5: adapters normalize every family onto the PINNED Anthropic-shaped raw vocabulary.
      const names = new Set(streamEvents.map((e) => ((e.payload as { event?: { type?: string } }).event?.type ?? "")));
      expect(names.has("message_start")).toBe(true);
      expect(names.has("content_block_delta")).toBe(true);
      // R6-G: `ping` never reaches the consumer.
      expect(names.has("ping")).toBe(false);
    } finally {
      await fake.close();
    }
  });

  test("p6-stream-events (negative control): WITHOUT includePartialMessages there is not one stream_event", async () => {
    const fake = await startScenarioFake();
    try {
      const scenario = { prompt: "stream it", model: SCENARIO_MODELS.anthropic, provider: fakeProvider(fake), allowedTools: [SCENARIO_TOOL_NAME], registryBackedTools: true } satisfies QueryScenarioOptions;
      const a = await traceViaQuery(legA, scenario);
      const b = await traceViaQuery(legB, scenario);
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.trace.filter((e) => e.kind === "stream_event").length).toBe(0);
    } finally {
      await fake.close();
    }
  });

  test("p6-retry-ratelimit: a 429 becomes `api_retry`, identically on every leg — and NEVER `rate_limit_event` (R6-B)", async () => {
    const fake = await startScenarioFake({ firstAttemptStatus: 429 });
    try {
      const scenario = { prompt: "retry me", model: SCENARIO_MODELS.anthropic, provider: fakeProvider(fake), allowedTools: [SCENARIO_TOOL_NAME], registryBackedTools: true } satisfies QueryScenarioOptions;
      const a = await traceViaQuery(legA, scenario);
      const b = await traceViaQuery(legB, scenario);
      // `retry_delay_ms` is a real-clock figure; everything else about the frame is fixed.
      const scrubDelay = (entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] =>
        JSON.parse(JSON.stringify(entries).replace(/\\?"retry_delay_ms\\?":\d+/g, '"retry_delay_ms":0')) as ConformanceTraceEntry[];
      expect(compareTraces(scrubDelay(a.trace), scrubDelay(b.trace))).toEqual([]);
      expect(a.thrown).toBeUndefined();

      // `system/api_retry`: `kindOfMessage` renders every `type: "system"` frame as `system/<subtype>`.
      const retries = a.trace.filter((e) => e.kind === "system/api_retry");
      expect(retries.length).toBeGreaterThan(0);
      const first = retries[0]!.payload as { attempt: number; error_status: number; error: string; max_retries: number };
      expect(first.error_status).toBe(429);
      expect(first.error).toBe("rate_limit");
      expect(first.attempt).toBe(1);
      // R6-B: an API-KEY 429 is `api_retry`, never `rate_limit_event` — whose vocabulary is
      // subscription/overage-shaped. Header-derived limits never become frames.
      expect(a.trace.filter((e) => e.kind === "system/rate_limit_event").length).toBe(0);
      // The retry actually re-sent: the fake saw a second request on the same path.
      expect(fake.requests.filter((r) => r.path === "/v1/messages").length).toBeGreaterThan(2);
    } finally {
      await fake.close();
    }
  });

  test("p6-provider-failure (R6-F): a terminal provider failure lands on `success`+`is_error`, and query() ALSO throws — on every leg", async () => {
    // 400, not 500: a bad_request is terminal on the FIRST attempt (R6-6 retries only
    // 408/409/429/5xx/network/timeout), so this scenario proves the failure SHAPE without spending a
    // real exponential backoff per leg to get there.
    const fake = await startScenarioFake({ alwaysFailStatus: 400 });
    try {
      const scenario = { prompt: "fail", model: SCENARIO_MODELS.anthropic, provider: fakeProvider(fake), allowedTools: [SCENARIO_TOOL_NAME], registryBackedTools: true } satisfies QueryScenarioOptions;
      const a = await traceViaQuery(legA, scenario);
      const b = await traceViaQuery(legB, scenario);
      const scrubDelay = (entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] =>
        JSON.parse(JSON.stringify(entries).replace(/\\?"retry_delay_ms\\?":\d+/g, '"retry_delay_ms":0')) as ConformanceTraceEntry[];
      expect(compareTraces(scrubDelay(a.trace), scrubDelay(b.trace))).toEqual([]);

      // The PINNED failure shape, capture (I): not a new result subtype.
      const result = a.trace.find((e) => e.kind === "result")!.payload as { subtype: string; is_error?: boolean; terminal_reason?: string; api_error_status?: number | null };
      expect(result.subtype).toBe("success");
      expect(result.is_error).toBe(true);
      expect(result.terminal_reason).toBe("api_error");
      // ...AND `query()` throws after yielding it.
      expect(a.thrown).toBeInstanceOf(ResultError);
      expect(b.thrown).toBeInstanceOf(ResultError);
    } finally {
      await fake.close();
    }
  });

  test("p6-resume-identity: the resolved identity survives a resume, on every leg", async () => {
    const fake = await startScenarioFake();
    try {
      const sessionId = randomUUID();
      const scenario: Omit<QueryScenarioOptions, "prompt"> = { model: SCENARIO_MODELS.anthropic, provider: fakeProvider(fake), allowedTools: [SCENARIO_TOOL_NAME], registryBackedTools: true };
      for (const leg of [legA, legB]) {
        const id = `${sessionId}-${leg}`;
        const first = await traceViaQuery(leg, { ...scenario, prompt: "first", sessionId: id });
        expect(first.thrown).toBeUndefined();
        const resumed = await traceViaQuery(leg, { ...scenario, prompt: "second", resume: id });
        expect(resumed.thrown).toBeUndefined();
        const init = resumed.trace[0]!.payload as { winter_provider?: Record<string, unknown> };
        // THE POINT: a resumed session re-resolves the same identity rather than starting anonymous.
        expect(init.winter_provider?.modelKey).toBe(SCENARIO_MODELS.anthropic);
        expect(init.winter_provider?.providerId).toBe("anthropic");
      }
    } finally {
      await fake.close();
    }
  });

  test("p6-resume-identity (switch half): a DIFFERENT model on resume applies at the first boundary and announces `model_switch`, on every leg", async () => {
    // The brief's second half, and it is a different claim from the one above: resuming with the SAME
    // model must keep the identity, and resuming with ANOTHER must (a) actually switch -- the fake
    // sees the NEW model id on the wire -- and (b) say so on the Winter-only `system/model_switch`
    // frame, at the first quiescent boundary rather than mid-turn. Without the frame a host has no
    // way to tell a switched session from one that silently ignored its own configuration.
    const fake = await startScenarioFake();
    try {
      const sessionId = randomUUID();
      const base: Omit<QueryScenarioOptions, "prompt"> = { provider: fakeProvider(fake), allowedTools: [SCENARIO_TOOL_NAME], registryBackedTools: true };
      const traces: ScenarioResult[] = [];
      for (const leg of [legA, legB]) {
        const id = `${sessionId}-${leg}`;
        const first = await traceViaQuery(leg, { ...base, model: SCENARIO_MODELS.anthropic, prompt: "first", sessionId: id });
        expect(first.thrown).toBeUndefined();
        // Counted BEFORE this leg's resumed turn (fix wave, Lane D's r1 Minor): the assertion below
        // proves THIS leg went out under the new wire id, not merely that some leg did.
        const childWireBefore = fake.requests.filter((r) => r.body.includes(`"model":"${SCENARIO_CHILD_WIRE_ID}"`)).length;
        const switched = await traceViaQuery(leg, { ...base, model: SCENARIO_CHILD_MODEL, prompt: "second", resume: id });
        expect(switched.thrown).toBeUndefined();
        traces.push(switched);
        // GROUND TRUTH, per leg: the resumed turn genuinely went out under the NEW wire id.
        expect(fake.requests.filter((r) => r.body.includes(`"model":"${SCENARIO_CHILD_WIRE_ID}"`)).length).toBeGreaterThan(childWireBefore);

        // (a) The resumed session re-resolved the NEW model, and reports it.
        const init = switched.trace[0]!.payload as { model: string; winter_provider?: Record<string, unknown> };
        expect(init.model).toBe(SCENARIO_CHILD_MODEL);
        expect(init.winter_provider?.modelKey).toBe(SCENARIO_CHILD_MODEL);

        // (b) The switch is ANNOUNCED. `system/model_switch` carries the from/to pair and the reason.
        const switchFrames = switched.trace.filter((e) => e.kind === "system/model_switch");
        expect(switchFrames.length).toBe(1);
        const frame = switchFrames[0]!.payload as { reason: string; from_model: string; to_model: string; provider: string };
        expect(frame.reason).toBe("set_model");
        expect(frame.from_model).toBe(SCENARIO_MODELS.anthropic);
        expect(frame.to_model).toBe(SCENARIO_CHILD_MODEL);
        expect(frame.provider).toBe("anthropic");
      }
      // And the two legs agree frame for frame.
      expect(compareTraces(traces[0]!.trace, traces[1]!.trace)).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  test("p6-resolution-failure: an unresolvable model still emits `system/init`, then R6-F's result shape, then throws — on every leg", async () => {
    // REVIEW ROUND 1, CRITICAL A. R6-9's refusal is "surfaced in T1's captured failure shape", and
    // capture (I)'s shape HAS an init frame in it. Refusing at construction produced zero frames and
    // a `CLIConnectionError`, so a host learned nothing from the stream at all.
    //
    // No fake is needed and none is started: the point is that NOTHING is ever sent. A model no
    // catalog contains cannot produce a request, and the absence of one is part of the claim.
    const scenario = { prompt: "resolve me", model: "anthropic/definitely-not-a-model-t10", provider: { providerId: "anthropic", authRef: { kind: "inline" as const, value: "test" } } } satisfies QueryScenarioOptions;
    const a = await traceViaQuery(legA, scenario);
    const b = await traceViaQuery(legB, scenario);
    expect(compareTraces(a.trace, b.trace)).toEqual([]);

    // (1) THE SESSION STARTED. An init frame, reporting the model the CALLER passed...
    expect(a.trace[0]!.kind).toBe("system/init");
    const init = a.trace[0]!.payload as { model: string; winter_provider?: unknown };
    expect(init.model).toBe("anthropic/definitely-not-a-model-t10");
    // ...and NO `winter_provider`, because nothing resolved. Reporting one would be a fabrication.
    expect(init.winter_provider).toBeUndefined();

    // (2) THE PINNED FAILURE SHAPE (capture (I)): not a new result subtype, and `api_error_status`
    // is null because no request was ever made.
    const result = a.trace.find((e) => e.kind === "result")!.payload as { subtype: string; is_error?: boolean; terminal_reason?: string; api_error_status?: number | null };
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(true);
    expect(result.terminal_reason).toBe("api_error");
    expect(result.api_error_status).toBeNull();

    // (3) ...AND `query()` throws after yielding it.
    expect(a.thrown).toBeInstanceOf(ResultError);
    expect(b.thrown).toBeInstanceOf(ResultError);
  });

  test("p6-child-own-provider (R6-17): a child with its OWN model runs off its OWN provider — the fake saw the CHILD's model id", async () => {
    const fake = await startScenarioFake();
    try {
      // The child's definition names a DIFFERENT model in the same provider. R6-17's whole point is
      // that the field reaching `AgentDefinition.model` proves nothing until something downstream
      // resolves it -- so the assertion is on the wire: a request body carrying the CHILD's model id,
      // which can only be there if a provider was built for it.
      const childModel = SCENARIO_CHILD_MODEL;
      const scenario = {
        prompt: `${SCENARIO_DELEGATE_MARKER}: delegate to the probe`,
        model: SCENARIO_MODELS.anthropic,
        provider: fakeProvider(fake),
        allowedTools: ["Agent", SCENARIO_TOOL_NAME],
        agents: { [SCENARIO_CHILD_AGENT]: { description: "the R6-17 probe", prompt: "you are the probe", model: childModel } },
        registryBackedTools: true,
      } satisfies QueryScenarioOptions;
      const a = await traceViaQuery(legA, scenario);
      expect(a.thrown).toBeUndefined();
      const bodies = fake.requests.map((r) => r.body);
      // The PARENT's model id is on the wire...
      expect(bodies.some((body) => body.includes('"model":"claude-sonnet-5"'))).toBe(true);
      // ...and so is the CHILD's, which is only possible if `resolveChildProvider` built one.
      expect(bodies.some((body) => body.includes(`"model":"${SCENARIO_CHILD_WIRE_ID}"`))).toBe(true);
    } finally {
      await fake.close();
    }
  });

  // ==============================================================================================
  // P6 fix wave: the switch seam (Ruling E-2) and fallback (Ruling E-3), on every leg.
  // ==============================================================================================

  /** A two-turn streaming prompt whose SECOND turn waits for the host's own action between them. */
  function gatedTwoTurns(): { prompt: AsyncIterable<string>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* turns(): AsyncGenerator<string> {
      yield "first";
      await gate;
      yield "second";
    }
    return { prompt: turns(), release };
  }

  /** The provider-state sidecar this leg's session wrote under the shared test home. */
  function sidecarRecords(sessionId: string): Array<Record<string, unknown>> {
    const path = join(TEST_WINTER_HOME, "projects", compatibilityKeys(FIXTURE_CWD).transcriptProjectKey, `${sessionId}${PROVIDER_STATE_FILE_SUFFIX}`);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  test("p6-set-model (R6-I through Ruling E-2): `setModel(supportedModels()[i].value)` between two turns puts the row's WIRE id on the wire, announces the switch with keys, warns about the cross-domain replay and writes the handoff record -- on every leg", async () => {
    const fake = await startScenarioFake();
    try {
      const sessionId = randomUUID();
      for (const leg of [legA, legB]) {
        const id = `${sessionId}-${leg}`;
        const { prompt, release } = gatedTwoTurns();
        let acted = false;
        let pickedValue: string | undefined;
        const result = await traceViaQuery(leg, {
          prompt,
          sessionId: id,
          model: SCENARIO_MODELS.anthropic,
          provider: fakeProvider(fake),
          allowedTools: [SCENARIO_TOOL_NAME],
          registryBackedTools: true,
          onMessage: (msg, ctx) => {
            if (msg.type !== "result" || acted) return;
            acted = true;
            // THE R6-I FLOW, verbatim: a picker row's `value` -- the CATALOG KEY -- into `setModel`.
            void (async () => {
              const rows = await ctx.supportedModels();
              const row = rows.find((r) => r.value === SCENARIO_CHILD_MODEL);
              pickedValue = row?.value;
              if (row !== undefined) await ctx.setModel(row.value);
            })().finally(release);
          },
        });
        expect(result.thrown).toBeUndefined();
        expect(pickedValue).toBe(SCENARIO_CHILD_MODEL);
        // (a) THE WIRE: turn 1 on the session's own wire id, turn 2 on the ROW's wire id -- never the key.
        const wire = fake.requests.filter((r) => r.path === "/v1/messages").map((r) => /"model":"([^"]+)"/.exec(r.body)?.[1]);
        expect(wire.slice(-1)[0]).toBe(SCENARIO_CHILD_WIRE_ID);
        expect(wire.includes(SCENARIO_CHILD_MODEL)).toBe(false);
        // (b) THE FRAMES: the switch announced with BOTH ids as keys, preceded by the cross-domain
        // warning (sonnet-5 declares a single-member continuation domain; the haiku row declares
        // none), which names counts and identities only.
        const kinds = result.trace.map((e) => e.kind);
        expect(kinds.indexOf("system/continuity_warning")).toBeGreaterThan(-1);
        expect(kinds.indexOf("system/continuity_warning")).toBeLessThan(kinds.indexOf("system/model_switch"));
        const switchFrame = result.trace.find((e) => e.kind === "system/model_switch")!.payload as { reason: string; from_model: string; to_model: string; provider: string };
        expect(switchFrame).toMatchObject({ reason: "set_model", from_model: SCENARIO_MODELS.anthropic, to_model: SCENARIO_CHILD_MODEL, provider: "anthropic" });
        const warning = result.trace.find((e) => e.kind === "system/continuity_warning")!.payload as { warning: string; detail: string };
        expect(warning.warning).toBe("cross_domain_replay_dropped");
        expect(warning.detail).toContain(`switching from ${SCENARIO_MODELS.anthropic} to ${SCENARIO_CHILD_MODEL}`);
        // (c) THE SIDECAR: the `handoff` record, anchored at the source's last entry, beside the origins.
        const records = sidecarRecords(id);
        const handoff = records.find((r) => r.kind === "handoff");
        expect(handoff, `${leg}: no handoff record in the sidecar`).toBeDefined();
        expect(handoff!.model).toBe(SCENARIO_MODELS.anthropic);
        expect(records.some((r) => r.kind === "origin" && r.anchorUuid === handoff!.anchorUuid && r.model === SCENARIO_MODELS.anthropic)).toBe(true);
        // Post-switch origins name the NEW model: the second turn's entry.
        expect(records.some((r) => r.kind === "origin" && r.model === SCENARIO_CHILD_MODEL)).toBe(true);
      }
    } finally {
      await fake.close();
    }
  });

  test("p6-set-model (refusal): a key qualified for ANOTHER provider is `invalid_model` on the control response and never parked -- the next turn stays on the session's model, on every leg", async () => {
    const fake = await startScenarioFake();
    try {
      for (const leg of [legA, legB]) {
        const { prompt, release } = gatedTwoTurns();
        let acted = false;
        let rejection: unknown;
        const before = fake.requests.length;
        const result = await traceViaQuery(leg, {
          prompt,
          model: SCENARIO_MODELS.anthropic,
          provider: fakeProvider(fake),
          allowedTools: [SCENARIO_TOOL_NAME],
          registryBackedTools: true,
          onMessage: (msg, ctx) => {
            if (msg.type !== "result" || acted) return;
            acted = true;
            void ctx
              .setModel(SCENARIO_MODELS.openaiResponses)
              .catch((err: unknown) => {
                rejection = err;
              })
              .finally(release);
          },
        });
        expect(result.thrown).toBeUndefined();
        // `Query.setModel()` REJECTS with the control response's own code (R6-K's provider-mismatch).
        expect(rejection).toBeDefined();
        expect((rejection as { code?: string }).code).toBe("invalid_model");
        expect(String((rejection as Error).message)).toContain("provider-mismatch");
        expect(result.trace.filter((e) => e.kind === "system/model_switch")).toHaveLength(0);
        // Every request of both turns went out under the session's own wire id.
        const wire = fake.requests.slice(before).map((r) => /"model":"([^"]+)"/.exec(r.body)?.[1]);
        expect(wire.length).toBeGreaterThan(0);
        expect(wire.every((m) => m === "claude-sonnet-5")).toBe(true);
      }
    } finally {
      await fake.close();
    }
  });

  test("p6-fallback (R6-C through Ruling E-3): the primary fails 503 x(maxRetries+1), the candidate serves the turn, `model_switch{reason:'fallback'}` carries the keys -- on every leg", async () => {
    // A same-domain pair on the real catalog: neither gemini-2.5-flash nor -flash-lite declares a
    // reasoning transport, so both sit in the empty domain and R6-9's init check admits the pair.
    // `retry-after: 1` bounds the scenario at 10 s per leg (R6-6 honours the header verbatim; a
    // jittered schedule would be up to 30 s per step) -- the cost is disclosed in the report.
    const fake = await startScenarioFake({ failModel: { wireModel: "gemini-2.5-flash", status: 503, retryAfter: "1" } });
    try {
      const scenario = {
        prompt: "fall back",
        model: SCENARIO_MODELS.gemini,
        fallbackModel: "google/gemini-2.5-flash-lite",
        provider: fakeProvider(fake),
        allowedTools: [SCENARIO_TOOL_NAME],
        registryBackedTools: true,
      } satisfies QueryScenarioOptions;
      const scrubDelay = (entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] =>
        JSON.parse(JSON.stringify(entries).replace(/\\?"retry_delay_ms\\?":\d+/g, '"retry_delay_ms":0')) as ConformanceTraceEntry[];
      const traces: ConformanceTraceEntry[][] = [];
      for (const leg of [legA, legB]) {
        const before = fake.requests.length;
        const result = await traceViaQuery(leg, scenario);
        expect(result.thrown).toBeUndefined();
        traces.push(result.trace);
        const mine = fake.requests.slice(before);
        // THE WIRE: 11 attempts on the primary (R6-6's 10 retries + the first), then the candidate's
        // own tool round -- Gemini carries the model in the PATH.
        expect(mine.filter((r) => r.path.includes("/models/gemini-2.5-flash:")).length).toBe(11);
        expect(mine.filter((r) => r.path.includes("/models/gemini-2.5-flash-lite:")).length).toBe(2);
        // THE FRAMES: ten `api_retry`s with the 503, then ONE Winter `model_switch{reason:"fallback"}`
        // with the keys, then the candidate's turn to a clean result. No vendor frame (R6-C: silent
        // at parity) -- `model_refusal_*` is for a refusal, never an overload.
        const retries = result.trace.filter((e) => e.kind === "system/api_retry");
        expect(retries).toHaveLength(10);
        expect((retries[0]!.payload as { error_status: number }).error_status).toBe(503);
        const switches = result.trace.filter((e) => e.kind === "system/model_switch");
        expect(switches).toHaveLength(1);
        expect(switches[0]!.payload).toMatchObject({ reason: "fallback", from_model: SCENARIO_MODELS.gemini, to_model: "google/gemini-2.5-flash-lite", provider: "google" });
        expect(result.trace.some((e) => e.kind.startsWith("system/model_refusal"))).toBe(false);
        const final = result.trace.find((e) => e.kind === "result")!.payload as { is_error?: boolean; result?: string };
        expect(final.is_error).toBeFalsy();
        expect(final.result).toBe(SCENARIO_FINAL_TEXT);
      }
      // The two legs agree frame for frame (delays scrubbed: the header makes them 1000 ms, but a
      // real clock is still a real clock; Gemini's self-minted call ids scrubbed, as in
      // `p6-gemini-fake`).
      const scrubGeminiCallIds = (entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] =>
        JSON.parse(JSON.stringify(entries).replace(/google-call-[0-9a-f]+-\d+/g, "google-call-SCRUBBED")) as ConformanceTraceEntry[];
      expect(compareTraces(scrubGeminiCallIds(scrubDelay(traces[0]!)), scrubGeminiCallIds(scrubDelay(traces[1]!)))).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 120_000);

  test("interrupt mid-turn", async () => {
    const a = await traceInterrupt(legA);
    const b = await traceInterrupt(legB);
    expect(compareTraces(a, b)).toEqual([]);
    expect(a.map((e) => e.kind)).toEqual(["init", "system/init", "control_response", "result", "control_response", "exit"]);
  });

  test("split-frame carry (a frame written across two stdin slices decodes correctly)", async () => {
    const a = await traceSplitFrameCarry(legA);
    const b = await traceSplitFrameCarry(legB);
    expect(compareTraces(a, b)).toEqual([]);
    expect(a.map((e) => e.kind)).toEqual(["init", "system/init", "assistant", "result", "control_response", "exit"]);
    const assistantMsg = a[2]!.payload as { message: { content: unknown } };
    expectEchoedPrompt(assistantMsg.message.content, "carried");
  });

  // Task 2 (WS-04 §3.1, direction inversion): the runtime originates its OWN control_request
  // mid-turn (rpcprobe test-provider arm) — proves the round trip (request out, scripted answer in,
  // answer embedded in the reply) is leg-invariant, the same way every other scenario here proves
  // leg-invariance for host-originated control traffic.
  // Phase 6 Task 10 (R6-13): the `rpcprobe` scenario is GONE with the turn kind it drove.
  //
  // Its claim -- "a runtime-originated control_request round-trips identically on every leg" -- is
  // now made by two REAL paths in this same function: the "Ruling P2-B" permission scenario (a
  // genuine `permission` control_request the host answers with an updatedInput) and the
  // hooked-tool-round scenario (a genuine `hook` one, with its public lifecycle frames). Both run on
  // every leg this pairing covers, including the compiled binary. The scaffold was the only reason
  // `rpc_probe` existed on `ProviderTurn`, and a scaffold that duplicates a shipped path is a second
  // implementation of it.

  test("error-result-then-throw (boom)", async () => {
    const a = await traceViaQuery(legA, { prompt: "hi", testProviderName: "boom" });
    const b = await traceViaQuery(legB, { prompt: "hi", testProviderName: "boom" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    // A cross-leg diff alone can't catch a bug shared by both legs — assert the actual contract
    // directly too (report §9: the error result is yielded, THEN the iterator throws).
    expect(a.thrown).toBeInstanceOf(ResultError);
    expect(b.thrown).toBeInstanceOf(ResultError);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "result", "exit"]);
    const resultMsg = a.trace[1]!.payload as { is_error?: boolean; result?: string };
    expect(resultMsg.is_error).toBe(true);
    expect(resultMsg.result).toContain("boom");
  });

  test("EOF-without-result (kill mid-turn)", async () => {
    const killOnSystem = (msg: { type: string }, ctx: { proc: SpawnedRuntimeProcess | undefined }) => {
      if (msg.type === "system") ctx.proc?.kill();
    };
    const a = await traceViaQuery(legA, { prompt: "hi", testProviderName: "hang", onMessage: killOnSystem });
    const b = await traceViaQuery(legB, { prompt: "hi", testProviderName: "hang", onMessage: killOnSystem });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    // Both legs must surface the TYPED WS-04 §6.1 error, never a raw stream error (T2-deferred
    // finding, folded into this scenario per the task brief).
    expect(a.thrown).toBeInstanceOf(ProcessError);
    expect(b.thrown).toBeInstanceOf(ProcessError);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "exit"]);
  });

  test("abort mid-turn (AbortController -> AbortError after drain)", async () => {
    const abortOnSystem = (msg: { type: string }, ctx: { abort: () => void }) => {
      if (msg.type === "system") ctx.abort();
    };
    const a = await traceViaQuery(legA, { prompt: "hi", testProviderName: "hang", useAbortController: true, onMessage: abortOnSystem });
    const b = await traceViaQuery(legB, { prompt: "hi", testProviderName: "hang", useAbortController: true, onMessage: abortOnSystem });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeInstanceOf(AbortError);
    expect(b.thrown).toBeInstanceOf(AbortError);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "exit"]);
  });


  // ==============================================================================================
  // Phase 5 Task 8: the P5 equivalence scenarios.
  // ==============================================================================================
  //
  // Every P5 lane shipped behind a seam that is INERT until `production-wiring.ts` registers it, and
  // that wiring is called from BOTH entrypoints precisely so the three legs cannot diverge. These
  // scenarios are what proves it -- each drives a whole P5 family end to end and compares the two
  // legs' normalized wire traces byte-for-byte.
  //
  // WHAT `compareTraces` DOES AND DOES NOT PROVE, stated once for all six: it compares the legs
  // against EACH OTHER, never against the spec. So each scenario also carries at least one
  // SUBSTANTIVE assertion about the shape itself -- otherwise two legs could agree perfectly on a
  // wrong answer, which is exactly the failure mode the P4 fix wave's own note about `capabilities`
  // records.

  test("P5 assembler round: Lane C's assembled prompt is on the LIVE request, identically on both legs", async () => {
    // GROUND TRUTH IS THE LIVE REQUEST (the phase's Global Constraints, and `context/seam.ts`'s own
    // header): an assembler that returns the right string and an engine that drops it look identical
    // from the assembler's own tests. `assembler.test.ts` proves the single-process half; what only a
    // cross-leg run can prove is that a REAL spawned/compiled `winter` composes the same prompt --
    // the wiring is registered from one shared function precisely so it cannot differ, and this is
    // the assertion that would catch it if it did.
    //
    // Read through `echoProvider`, which echoes the live request's LAST USER MESSAGE -- so the
    // user-context half (R5-9's "always injected as user-context") is directly observable on the
    // wire. The `system` half is not, by design: it never appears in a host-facing frame.
    const a = await traceViaQuery(legA, { prompt: "assembled" });
    const b = await traceViaQuery(legB, { prompt: "assembled" });
    expect(compareTraces(a.trace, b.trace)).toEqual([]);

    const text = ((a.trace.find((e) => e.kind === "assistant")!.payload as { message: { content: Array<{ text: string }> } }).message.content[0]!).text;
    // The auto-memory block is default-on (P5-G's companion: `autoMemoryEnabled` unset means
    // enabled), so a default session's live request carries exactly one user-context block ahead of
    // the prompt -- and the prompt is still last.
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("Auto-memory (injected by the runtime, not typed by the user):");
    expect(text.endsWith("\n\nassembled")).toBe(true);
    // AND IT IS NOT PERSISTED OR REPEATED: the block is re-attached per request, never pushed into
    // the engine's own history, so it appears exactly once even though the assembler ran once per
    // envelope.
    expect(text.split("<system-reminder>").length - 1).toBe(1);
  }, 30_000);

  test("P5 compaction round (auto): a threshold crossing produces ONE compact_boundary on both legs", async () => {
    // FIVE envelopes, not three. `retainedPairs` defaults to 4 and is NOT a `RuntimeConfig` field,
    // so a scenario cannot lower it: with fewer turn starts than `pairs`, Lane K's controller
    // deliberately refuses ("the caller asked to keep N pairs and has fewer than N") and the run
    // reports `compact_result: "failed"` instead of compacting. Five envelopes give turn 5's check a
    // window it can actually fold.
    const prompts = ["one", "two", "three", "four", "five"];
    const streamed = (): AsyncIterable<string> => (async function* () { for (const p of prompts) yield p; })();
    const scenario = { testProviderName: "p5compact" as const, contextWindowTokens: 1000 };
    const a = await traceViaQuery(legA, { prompt: streamed(), ...scenario });
    const b = await traceViaQuery(legB, { prompt: streamed(), ...scenario });
    // `preserved_messages.{anchor_uuid,uuids}` are per-run random uuids minted inside the store --
    // meaningful (a host relinks the kept segment by them) but not comparable ACROSS two independent
    // runs. `trace.ts`'s shared VOLATILE set strips `uuid`, deliberately not `uuids`/`anchor_uuid`.
    expect(compareTraces(scrubPreservedUuids(a.trace), scrubPreservedUuids(b.trace))).toEqual([]);
    expect(a.thrown).toBeUndefined();

    const boundaries = a.trace.filter((e) => e.kind === "system/compact_boundary");
    expect(boundaries.length).toBe(1);
    const meta = (boundaries[0]!.payload as { compact_metadata: { trigger: string; pre_tokens: number } }).compact_metadata;
    expect(meta.trigger).toBe("auto");
    expect(meta.pre_tokens).toBe(950);
    // No FAILED status anywhere: a refusal and a compaction are both "one status message" on the
    // wire, so counting boundaries alone would not tell them apart.
    const failures = a.trace.filter((e) => e.kind === "system/status" && (e.payload as { compact_result?: string }).compact_result === "failed");
    expect(failures.length).toBe(0);
  }, 30_000);

  test("P5 compaction round (manual /compact): its own terminal result, on both legs", async () => {
    const prompts = ["one", "two", "three", "four", "five", "/compact keep the API decisions"];
    const streamed = (): AsyncIterable<string> => (async function* () { for (const p of prompts) yield p; })();
    // NO `contextWindowTokens` override: the manual path must not be entangled with the auto
    // trigger, or a boundary could come from either and the assertion would not discriminate.
    const scenario = { testProviderName: "p5compact" as const };
    const a = await traceViaQuery(legA, { prompt: streamed(), ...scenario });
    const b = await traceViaQuery(legB, { prompt: streamed(), ...scenario });
    expect(compareTraces(scrubPreservedUuids(a.trace), scrubPreservedUuids(b.trace))).toEqual([]);
    expect(a.thrown).toBeUndefined();

    // `/compact` produces a terminal result of its own (WS-04 §4.1: every envelope gets exactly one),
    // and it is the LAST one -- the model never sees the command.
    const results = a.trace.filter((e) => e.kind === "result");
    expect(results.length).toBe(prompts.length);
    const last = results.at(-1)!.payload as { result: string };
    expect(last.result.startsWith("Compacted the conversation.")).toBe(true);
    const boundaries = a.trace.filter((e) => e.kind === "system/compact_boundary");
    expect(boundaries.length).toBe(1);
    expect((boundaries[0]!.payload as { compact_metadata: { trigger: string } }).compact_metadata.trigger).toBe("manual");
  }, 30_000);

  test("P5 structured-output round (success): the validated object ends the turn, on both legs", async () => {
    const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
    const scenario = { prompt: "answer", testProviderName: "p5structured" as const, outputFormat: { type: "json_schema" as const, schema }, allowedTools: ["StructuredOutput"] };
    const a = await traceViaQuery(legA, scenario);
    const b = await traceViaQuery(legB, scenario);
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.thrown).toBeUndefined();

    const result = a.trace.find((e) => e.kind === "result")!.payload as { subtype: string; structured_output?: unknown; terminal_reason?: string };
    expect(result.subtype).toBe("success");
    expect(result.structured_output).toEqual({ answer: 42 });
    expect(result.terminal_reason).toBeUndefined();
    // The host-generated descriptor is only advertised when `outputFormat` is set (WS-11 §8, and
    // capture (4): it is NOT in the default 24) -- which is what makes the round reachable at all.
    expect((a.trace[0]!.payload as { tools: string[] }).tools).toContain("StructuredOutput");
  }, 30_000);

  test("P5 structured-output round (exhaustion): both pinned spellings, on both legs", async () => {
    const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
    const scenario = {
      prompt: "answer",
      testProviderName: "p5structuredfail" as const,
      outputFormat: { type: "json_schema" as const, schema },
      allowedTools: ["StructuredOutput"],
      // Three, not the default five -- the budget is what the scenario is about, and a shorter one
      // proves the override is honoured as well as keeping the round quick.
      env: { MAX_STRUCTURED_OUTPUT_RETRIES: "3" },
    };
    const a = await traceViaQuery(legA, scenario);
    const b = await traceViaQuery(legB, scenario);
    expect(compareTraces(a.trace, b.trace)).toEqual([]);

    const result = a.trace.find((e) => e.kind === "result")!.payload as { subtype: string; terminal_reason?: string; result: string; structured_output?: unknown };
    // Item (d)'s TWO SPELLINGS, on two different fields of the same message -- no type-checker
    // catches either, which is why both are asserted literally.
    expect(result.subtype).toBe("error_max_structured_output_retries");
    expect(result.terminal_reason).toBe("structured_output_retry_exhausted");
    expect("structured_output" in result).toBe(false);
    expect(result.result).toBe("Failed to provide valid structured output after 3 attempts");
  }, 30_000);

  test("P5 skill-invocation round: the tool RESULT is the skill body, on both legs", async () => {
    // The fixture skill lives in the USER tier of the SHARED test home, which every leg's spawnHook
    // already points at -- a project-tier skill would need FIXTURE_CWD to hold a `.winter/` tree,
    // and this suite's cwd is the real repository.
    const skillDir = join(TEST_WINTER_HOME, "skills", P5_FIXTURE_SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${P5_FIXTURE_SKILL_NAME}\ndescription: the T8 cross-leg skill probe\n---\nP5 SKILL BODY MARKER\n`);
    try {
      const scenario = { prompt: "use the skill", testProviderName: "p5skill" as const, allowedTools: ["Skill"], settingSources: ["user" as const] };
      const a = await traceViaQuery(legA, scenario);
      const b = await traceViaQuery(legB, scenario);
      expect(compareTraces(a.trace, b.trace)).toEqual([]);
      expect(a.thrown).toBeUndefined();

      // `init.skills` names it -- the index found it on both legs.
      expect((a.trace[0]!.payload as { skills: string[] }).skills).toContain(P5_FIXTURE_SKILL_NAME);
      // The RESULT IS THE BODY (WS-11 §2.3: inserted into the conversation, no pointer, no second
      // round-trip). A typed refusal would also be a tool_result, so asserting the marker is what
      // distinguishes "resolved and loaded" from "answered politely".
      const toolResult = a.trace.find((e) => e.kind === "user")!.payload as { message: { content: Array<{ tool_use_id: string; content: string }> } };
      const block = toolResult.message.content.find((bl) => bl.tool_use_id === "p5-skill-1")!;
      expect(block.content).toContain("P5 SKILL BODY MARKER");
    } finally {
      rmSync(join(TEST_WINTER_HOME, "skills"), { recursive: true, force: true });
    }
  }, 30_000);

  test("P5 workflow round: a real sandboxed worker subprocess runs the script, on both legs", async () => {
    // DARWIN-GATED, and this is a property of the feature rather than of the test: the workflow
    // runtime refuses to launch outright when `sandbox-exec` is unavailable (`WorkflowRuntime.launch`,
    // fail-closed by design), so on linux there is nothing to compare. The COMPILED leg's own proof
    // is `verify:workflow`, which drives the binary's `__workflow-worker` argv dispatch directly and
    // is a CI step.
    if (process.platform !== "darwin") return;
    const scenario = { prompt: "run the workflow", testProviderName: "p5workflow" as const, allowedTools: ["Workflow", "Agent"] };
    const a = await traceViaQuery(legA, scenario);
    const b = await traceViaQuery(legB, scenario);

    // `runId`, `taskId` and the two paths embed a random run id and the session uuid -- normalized
    // by value, exactly as the bash-background golden normalizes its own task id, before comparing.
    const scrub = (t: ConformanceTraceEntry[]): ConformanceTraceEntry[] => {
      // The run id first (it is a SUBSTRING of the two paths and of the task's own output file), then
      // the remaining per-run identifiers by key. Both quote forms, because every one of these also
      // appears inside the JSON-encoded tool_result string.
      const withoutRunIds = JSON.parse(JSON.stringify(t).replace(/wf_[0-9a-f]+/g, "wf_RUNID")) as ConformanceTraceEntry[];
      return scrubVolatileText(withoutRunIds, [volatileKey("taskId"), volatileKey("task_id"), volatileKey("transcriptDir"), volatileKey("scriptPath"), volatileKey("output_file"), volatileKey("tool_use_id")]);
    };
    expect(compareTraces(scrub(a.trace), scrub(b.trace))).toEqual([]);
    expect(a.thrown).toBeUndefined();

    // The pinned `task_started` literals (capture (3)), and the `WorkflowOutput` field set.
    const started = a.trace.find((e) => e.kind === "system/task_started")!.payload as { task_type: string; workflow_name: string };
    expect(started.task_type).toBe("local_workflow");
    expect(started.workflow_name).toBe("p5equiv");
    const toolResult = a.trace.find((e) => e.kind === "user")!.payload as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const output = JSON.parse(toolResult.message.content.find((bl) => bl.tool_use_id === "p5-workflow-1")!.content) as Record<string, unknown>;
    expect(output.status).toBe("async_launched");
    expect(output.taskType).toBe("local_workflow");
    expect(output.workflowName).toBe("p5equiv");
    expect(typeof output.runId).toBe("string");
  }, 60_000);


  test("P5 checkpoint-rewind round: a real Write is undone, a Bash-created file is not, on both legs", async () => {
    // RAW-DRIVEN, not through query(): `rewind_files` is a protocol-level control_request the
    // wrapper has no API for (the same reason `traceInterrupt` is raw), and the request has to be
    // sent to a SECOND run over the same home and session id -- a rewind of the run that is still
    // writing would be a different scenario.
    async function runLeg(leg: LegName): Promise<{ trace: ConformanceTraceEntry[]; restored: string; bashSurvived: boolean; bashContent: string; result: Record<string, unknown>; workDir: string; workDirReal: string }> {
      const workDir = mkdtempSync(join(tmpdir(), "winter-p5-ckpt-"));
      // Captured while the directory still EXISTS -- the comparison below runs after the `finally`
      // has removed it, and `realpathSync` on a deleted path throws ENOENT.
      const workDirReal = realpathSync(workDir);
      const target = join(workDir, "tracked.txt");
      writeFileSync(target, "BEFORE\n");
      const sessionId = `p5-ckpt-${leg}-${randomUUID()}`;
      const entries: ConformanceTraceEntry[] = [];
      try {
        // --- run 1: the mutating turn -------------------------------------------------------------
        const first = buildRawProc(leg, "p5checkpoint", sessionId, { cwd: workDir, enableFileCheckpointing: true, allowedTools: ["Read", "Write", "Bash"], sandbox: { enabled: false } });
        const d1 = createDriver(first);
        let userMessageUuid = "";
        try {
          await d1.nextFrame(); // init
          await d1.nextFrame(); // system/init
          d1.send({ type: "user", text: target });
          for (;;) {
            const frame = await d1.nextFrame();
            if (!frame) break;
            pushFrame(entries, frame);
            const msg = frame.type === "data" ? (frame as { message: { type: string; user_message_uuid?: string } }).message : undefined;
            if (msg?.type === "result") {
              // The ONLY channel the id travels on (T3's concern 2), and conditional on
              // `enableFileCheckpointing` -- which is why the option is on the config above.
              userMessageUuid = msg.user_message_uuid ?? "";
              break;
            }
          }
          d1.send({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
        } finally {
          first.kill();
          await first.exited;
        }
        expect(userMessageUuid, `${leg}: the terminal result must disclose user_message_uuid`).not.toBe("");
        expect(readFileSync(target, "utf8")).toBe("AFTER\n"); // the Write really happened
        const bashFile = `${target}.bash`;
        expect(existsSync(bashFile)).toBe(true); // and so did the Bash round

        // --- run 2: the rewind --------------------------------------------------------------------
        const second = buildRawProc(leg, "p5checkpoint", sessionId, { cwd: workDir, enableFileCheckpointing: true, resume: sessionId });
        const d2 = createDriver(second);
        let result: Record<string, unknown> = {};
        try {
          await d2.nextFrame();
          await d2.nextFrame();
          d2.send({ type: "control_request", requestId: "rewind-1", subtype: "rewind_files", payload: { user_message_id: userMessageUuid } });
          for (;;) {
            const frame = await d2.nextFrame();
            if (!frame) break;
            if (frame.type === "control_response" && (frame as { requestId: string }).requestId === "rewind-1") {
              result = (frame as { payload?: Record<string, unknown> }).payload ?? {};
              pushFrame(entries, frame);
              break;
            }
          }
          d2.send({ type: "control_request", requestId: "end-2", subtype: "end_input", payload: undefined });
        } finally {
          second.kill();
          await second.exited;
        }
        // READ BEFORE THE `finally` REMOVES THE TREE. An `existsSync` at the call site would be
        // testing this fixture's own cleanup, not the rewind -- it read `false` for exactly that
        // reason on the first run.
        return { trace: normalizeTrace(entries), restored: readFileSync(target, "utf8"), bashSurvived: existsSync(bashFile), bashContent: existsSync(bashFile) ? readFileSync(bashFile, "utf8") : "", result, workDir, workDirReal };
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }

    const a = await runLeg(legA);
    const b = await runLeg(legB);
    // THE TWO LEGS USE DIFFERENT TEMP WORK DIRECTORIES BY CONSTRUCTION -- each run writes real files,
    // and sharing one directory would make leg B's own Write land on the file leg A had already
    // rewound. That difference reaches the wire in three places at once: `file_path` on the tool
    // call, the restored path inside `filesChanged`, and -- because the session's cwd is the memory
    // KEY -- the auto-memory user-context block that `echoProvider`'s successor echoes back.
    //
    // Scrubbed BY EXACT VALUE, the same design `traceWinterBashBackgroundRound`'s own task-id scrub
    // uses and for the same reason: a key-shaped regex cannot reach a path embedded in an escaped
    // JSON string, and a path-shaped one would eat meaningful literals. `realpathSync` too, because
    // every macOS mkdtemp path is a `/var` -> `/private/var` symlink and the two spellings both
    // appear (the tool call carries what it was handed; the runtime reports what it resolved).
    const scrubWorkDir = (t: ConformanceTraceEntry[], spellings: string[]): ConformanceTraceEntry[] => {
      let text = JSON.stringify(t);
      // FOUR SPELLINGS, not two. The cwd reaches the wire as a PATH (the tool call, `filesChanged`)
      // and, because it is the auto-memory KEY, as the pinned project-directory SANITISATION of
      // itself -- separators and dots replaced by `-`. A scrub that only handled the path form left
      // the memory block's own directory line diverging, which is what `payload@7` was.
      //
      // LONGEST FIRST: `/private/var/...` and `/var/...` overlap, and replacing the short one first
      // would leave a `/private` orphan behind. Sorting removes the ordering question entirely.
      const all = [...new Set(spellings.flatMap((sp) => [sp, sp.replace(/[/.]/g, "-")]))];
      for (const spelling of all.sort((x, y) => y.length - x.length)) text = text.split(spelling).join("/WORKDIR");
      // `user_message_uuid` is the rewind DISCOVERY channel (T3's concern 2) -- a real per-run uuid,
      // and deliberately NOT in `trace.ts`'s shared VOLATILE set, which strips only the bare `uuid`.
      text = text.replace(/"user_message_uuid":"[^"]*"/g, '"user_message_uuid":"UMU"');
      return JSON.parse(text) as ConformanceTraceEntry[];
    };
    expect(compareTraces(scrubWorkDir(a.trace, [a.workDir, a.workDirReal]), scrubWorkDir(b.trace, [b.workDir, b.workDirReal]))).toEqual([]);

    for (const [leg, r] of [[legA, a] as const, [legB, b] as const]) {
      // THE TRACKED FILE IS RESTORED...
      expect(r.restored, `${leg}: the tracked file must be restored`).toBe("BEFORE\n");
      // ...AND THE BASH-CREATED FILE IS NOT TOUCHED. This is the honest scope boundary WS-11 §9
      // pins (Write/Edit/NotebookEdit only), and asserting only the first half would leave a rewind
      // that silently swept the whole directory looking correct.
      expect(r.bashSurvived, `${leg}: a Bash-created file is outside the checkpoint scope`).toBe(true);
      expect(r.bashContent, `${leg}`).toBe("bash-made\n");
      const payload = (r.result as { response?: { canRewind?: boolean; filesChanged?: string[]; skippedLinks?: number } }).response ?? (r.result as { canRewind?: boolean; filesChanged?: string[]; skippedLinks?: number });
      expect(payload.canRewind, `${leg}`).toBe(true);
      expect(payload.filesChanged?.length, `${leg}`).toBe(1);
      expect(payload.filesChanged?.[0]?.endsWith("tracked.txt"), `${leg}`).toBe(true);
      expect(payload.skippedLinks, `${leg}`).toBe(0);
    }
  }, 60_000);

  // Task 9 (WS-05 §7): run a session to completion, then resume the SAME sessionId in a NEW
  // process/instance over the SAME leg — the provider sees the prior messages (proven via the
  // "reflect" test provider's JSON-encoded reply) and the transcript chain continues from the last
  // uuid (proven by inspecting the shared TEST_WINTER_HOME's store directly).
  test("resume: a new process/instance continues the same session — provider sees prior messages, transcript chain continues", async () => {
    const a = await traceResumeScenario(legA);
    const b = await traceResumeScenario(legB);
    expect(compareTraces(a.trace, b.trace)).toEqual([]);
    expect(a.trace.map((e) => e.kind)).toEqual(["system/init", "assistant", "result", "system/init", "assistant", "result", "exit"]);

    // The SECOND run's provider call received the FIRST run's history — assert containment (the
    // second run's reflected JSON necessarily nests the first run's own reflected text inside it),
    // never equality against a fixed string.
    for (const result of [a, b]) {
      const reflected = JSON.parse(result.secondAssistantText) as Array<{ role: string; content: unknown }>;
      expect(reflected).toContainEqual({ role: "user", content: "first" });
      expect(reflected.some((m) => m.role === "assistant")).toBe(true); // the first run's OWN reply is present too
      // Phase 5 Task 8: the LIVE request's last user message carries this session's user-context
      // blocks ahead of the prompt (R5-9), so this asserts the composition rather than a byte-exact
      // string -- the prompt is still last, which is what "the second run's own envelope" means.
      const last = reflected.at(-1) as { role: string; content: string };
      expect(last.role).toBe("user");
      expect(last.content === "second" || last.content.endsWith("\n\nsecond")).toBe(true);
    }

    // Chain continuity: one continuous parentUuid graph, first entry's parent null, every later
    // entry's parent its immediate predecessor's uuid — spanning BOTH runs, on both legs.
    for (const [scenarioLeg, result] of [[legA, a] as const, [legB, b] as const]) {
      const store = new WinterCompatibilitySessionStore({ winterHome: TEST_WINTER_HOME });
      const projectKey = compatibilityKeys(FIXTURE_CWD).transcriptProjectKey;
      const loaded = await store.load({ projectKey, sessionId: result.sessionId });
      expect(loaded, `${scenarioLeg}: expected a persisted transcript for the resumed session`).not.toBeNull();
      expect(loaded!.length).toBe(4); // user(first) + assistant(reflect) + user(second) + assistant(reflect)
      expect(loaded![0]!.parentUuid).toBeNull();
      for (let i = 1; i < loaded!.length; i++) {
        expect(loaded![i]!.parentUuid).toBe(loaded![i - 1]!.uuid);
      }
    }
  });
}

describe("transport equivalence: inMemoryProcess vs the real winter child (main.ts, dev leg)", () => {
  registerEquivalenceScenarios("inMemory", "child");
});

// --- child-leg-only plumbing: stderr, and the T2 finding-7 observation --------------------------
//
// Neither of these is a cross-leg comparison: the in-memory leg has no real OS stderr (its
// SpawnedRuntimeProcess has no `stderr` field at all — WS-04 §1.1 virtual handle), and finding 7 is
// an OBSERVE-AND-REPORT item (task brief), not a behavior either leg is expected to differ on.

describe("child leg: stderr plumbing", () => {
  test("stderr routes to options.stderr; an unrecognized WINTER_TEST_PROVIDER fails before init (CLIConnectionError)", async () => {
    const stderrChunks: string[] = [];
    const capture: { proc?: SpawnedRuntimeProcess } = {};
    const hook: SpawnClaudeCodeProcess = (opts) => {
      const proc = defaultSpawn({
        ...opts,
        command: process.execPath,
        args: [mainPath, ...opts.args],
        // WINTER_HOME included defensively (Task 8 HARD CONSTRAINT) even though this scenario's
        // child exits in main.ts's resolveProvider() throw, before a store is ever constructed.
        env: { ...opts.env, WINTER_HOME: TEST_WINTER_HOME, WINTER_TEST_PROVIDER: "definitely-not-a-real-provider" },
      });
      capture.proc = proc;
      return proc;
    };
    let thrown: unknown;
    try {
      for await (const _msg of query({
        prompt: "hi",
        options: { cwd: FIXTURE_CWD, spawnClaudeCodeProcess: hook, stderr: (chunk) => stderrChunks.push(chunk) },
      })) {
        /* main.ts exits before writing a single frame — this body should never run */
      }
    } catch (e) {
      thrown = e;
    }
    if (capture.proc) await capture.proc.exited;

    // Stderr forwarding is a detached async task in query.ts, independent of the consumer's own
    // iteration — give it a brief settle window after the child has fully exited rather than
    // asserting the instant the loop above returns (flake risk flagged pre-implementation).
    const deadline = Date.now() + 1000;
    while (stderrChunks.join("").length === 0 && Date.now() < deadline) {
      await sleep(10);
    }

    expect(thrown).toBeInstanceOf(CLIConnectionError); // exited before init -> WS-04 §6.1
    expect(stderrChunks.join("")).toContain("WINTER_TEST_PROVIDER");
  });
});

describe("Finding 7 (T2, tracked — observe only, no fix): abort BEFORE query() runs still spawns eagerly", () => {
  for (const leg of LEG_NAMES) {
    test(`${leg} leg`, async () => {
      const controller = new AbortController();
      controller.abort(); // aborted BEFORE query() is ever called
      const capture: { proc?: SpawnedRuntimeProcess } = {};
      let invoked = false;
      const inner = spawnHook(leg, "hang", capture);
      const hook: SpawnClaudeCodeProcess = (opts) => {
        invoked = true;
        return inner(opts);
      };
      let thrown: unknown;
      try {
        for await (const _msg of query({ prompt: "hi", options: { cwd: FIXTURE_CWD, spawnClaudeCodeProcess: hook, abortController: controller } })) {
          /* observe only */
        }
      } catch (e) {
        thrown = e;
      }
      if (capture.proc) await capture.proc.exited;
      // OBSERVED, not fixed: query() spawns the process even though the AbortSignal was already
      // aborted before query() was ever called (see this task's report for the full note).
      expect(invoked).toBe(true);
      expect(thrown).toBeInstanceOf(AbortError);
    });
  }
});

// --- Task 5: the compiled `winter` binary as a third leg (WS-02 §7.4) --------------------------
//
// Gated behind WINTER_COMPILED_BIN (verify-protocol-compiled.ts sets it after building to a temp
// path) so the plain `bun test` job (no env var — CI's default job) registers NOTHING here: a
// plain `if` around the `describe` call, not `.skip`/`.skipIf`, so there is no skip marker either —
// the block above this comment is byte-unchanged from before this task, and without the env var it
// is the ENTIRE suite, exactly as today (brief: "the suite adds the leg when the env var is set").
//
// Item 7 (P2 fix-wave) staleness correction: this used to say "Same 9 scenarios" -- true when Task
// 5 wrote it, false since (16 as of this fix wave, after Task 13's own Carry-1/mode-switch
// additions and others along the way). Deliberately NOT re-pinning a fresh number here either --
// that would just go stale again the next time a scenario is added. The load-bearing fact is
// count-independent: EVERY scenario "transport equivalence: inMemoryProcess vs the real winter
// child" (above) registers via registerEquivalenceScenarios ALSO runs here, against the
// compiled-binary leg — registerEquivalenceScenarios is the ONLY copy of their bodies/assertions
// (Task 5 rider: a second, hand-copied test list here was rejected specifically because two such
// lists WILL drift).
if (process.env.WINTER_COMPILED_BIN) {
  describe("transport equivalence: inMemoryProcess vs the compiled winter binary (Task 5)", () => {
    registerEquivalenceScenarios("inMemory", "compiled");
  });
}

// P3 fix round 1 (RULING P3-C) CLOSURE NOTE: Task 2's own background-task message family proof used
// to live here, scoped to the in-memory leg only, with a documented STRUCTURAL GAP explaining why it
// could not join registerEquivalenceScenarios's cross-leg pattern (main.ts hard-coded
// `tools: stubExecutor` unconditionally, so ctx.emitFrame was unreachable on a real spawned/compiled
// process by construction). That gap is closed as of this fix round -- main.ts's tools executor is
// now registry-backed-by-default (see main.ts's own runEngine call site), so the SAME proof now runs
// as "background-task message family (WS-06 §3.5): ctx.emitFrame -> the wire, identically on every
// leg" INSIDE registerEquivalenceScenarios above (both the inMemory-vs-child and, when
// WINTER_COMPILED_BIN is set, inMemory-vs-compiled pairings), rather than as its own standalone,
// single-leg describe block.
