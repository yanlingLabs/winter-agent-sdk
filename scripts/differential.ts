import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, encodeFrame, splitFrames, ResultError, type RuntimeConfig, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { testProviderByName, scriptedProvider, registerTool, MCP_SDK_TEST_SERVER_NAME, MCP_SDK_TEST_TOOL_NAME, P5_FIXTURE_SKILL_NAME, SCENARIO_MODELS, SCENARIO_TOOL_NAME, startScenarioFake } from "winter-agent-runtime";
import { normalizeTrace, compareTraces, type ConformanceTraceEntry } from "@yanlinglabs/winter-conformance/trace";

// A pinned, synthetic cwd (never process.cwd()) so every recorded trace — and the committed golden
// compared against it — is byte-identical across machines and CI runners, whose checkout paths
// differ (WS-17 §4: differential traces must be deterministic). Shared by every scenario below, not
// just the original plain-query one, for the same reason.
//
// CORRECTED BY Phase 5 Task 8: this comment used to add "the in-memory runtime never touches the
// filesystem with it", and that is no longer true. `production-wiring.ts` runs on every leg now and
// parent-walks this cwd for skills, command files, the instructions file and the project mcp config, and
// `context/memory-key.ts` spawns `git --git-common-dir` in it. All of that TOLERATES a nonexistent
// directory -- verified by probing each builder against this exact path before the wiring landed --
// which is what keeps the determinism guarantee intact: a path that does not exist has no contents
// to vary by machine. It is no longer an untouched string, and a future reader must not assume it.
const FIXTURE_CWD = "/winter-fixture";
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

// --- Phase 5 Task 8: the injected-context scrub ---------------------------------------------------
//
// With Lane C's assembler wired in production (production-wiring.ts, on every leg), every provider
// request's last user message carries this session's user-context blocks ahead of the prompt (R5-9,
// "always injected as user-context"). The default session's one block is the auto-memory guidance,
// and its text NAMES the resolved memory directory -- `<winterHome>/projects/<key>/memory`, where
// `winterHome` is this scenario's own `mkdtemp` root.
//
// Every scenario here uses `echoProvider` or a `reflect`-style double that puts the user message
// back on the wire, so that absolute path reaches the recorded trace. It is machine- AND run-
// specific, which a byte-frozen golden cannot hold: without this scrub `--update` would write a
// different file on every run, which is the exact regenerate-twice determinism WS-17 §4 requires.
//
// SCRUBBED BY EXACT VALUE, never by pattern -- the same design `traceWinterBashBackgroundRound`'s
// own task-id scrub already uses, and for the same reason: this replaces THIS run's own known home
// string, so it can never accidentally eat a meaningful literal that merely looks path-shaped. The
// memory guidance TEXT itself is deliberately left in the goldens: it is stable authored prose, and
// pinning it is how a silent change to what every session tells the model becomes visible.
const FIXTURE_WINTER_HOME = "/winter-home";

/**
 * A compaction boundary names the preserved segment BY UUID -- minted per run inside the store, so
 * two runs of the same scenario never agree on them. `trace.ts`'s shared VOLATILE set strips the
 * bare `uuid` and deliberately not `uuids`/`anchor_uuid` (the `resume` golden's own chain assertion
 * depends on that). Replaced by POSITION here, which keeps what a golden should pin -- the NUMBER of
 * preserved messages and the fact that they are anchored -- without a value that changes per run.
 */
function scrubPreservedUuids(entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] {
  return entries.map((e) => {
    const meta = (e.payload as { compact_metadata?: { preserved_messages?: { anchor_uuid: string; uuids: string[] } } } | undefined)?.compact_metadata;
    if (meta?.preserved_messages === undefined) return e;
    return { ...e, payload: { ...(e.payload as object), compact_metadata: { ...meta, preserved_messages: { anchor_uuid: "ANCHOR", uuids: meta.preserved_messages.uuids.map((_, i) => `PRESERVED_${i}`) } } } };
  });
}

function scrubWinterHome(entries: ConformanceTraceEntry[], winterHome: string): ConformanceTraceEntry[] {
  return JSON.parse(JSON.stringify(entries).split(winterHome).join(FIXTURE_WINTER_HOME)) as ConformanceTraceEntry[];
}

function kindOf(msg: { type: string; subtype?: string }): string {
  return msg.type === "system" ? `system/${msg.subtype}` : msg.type;
}

export async function traceWinterPlainQuery(): Promise<ConformanceTraceEntry[]> {
  // Phase 5 Task 8: an OWNED temp WINTER_HOME, where this scenario used to rely on inMemoryProcess's
  // own per-call mkdtemp fallback. The fallback was always hermetic, but this scenario now needs the
  // home's VALUE (to scrub the memory directory out of the recorded trace), and only an injected one
  // is knowable from here. Every sibling scenario below already did this.
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-plainquery-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    let seq = 0;
    // cwd is pinned to a synthetic constant (never process.cwd()'s default) so the recorded trace —
    // and the committed golden compared against it — is byte-identical across machines and CI
    // runners, whose checkout paths differ (WS-17 §4). See FIXTURE_CWD's own header for what the
    // P5 wiring now does with this path, and why a nonexistent one is still deterministic.
    for await (const msg of query({
      prompt: "hi",
      options: {
        model: FIXTURE_MODEL,
        cwd: "/winter-fixture",
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, undefined, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      const kind = msg.type === "system" ? `system/${(msg as { subtype: string }).subtype}` : msg.type;
      entries.push({ sequence: seq++, direction: "runtime-to-host", kind, payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// --- Task 11: multi-turn / tool-round / interrupt / resume ---------------------------------------
//
// Each new scenario below drives the SAME in-memory transport the plain-query scenario above does
// (never a real spawned child — this harness is a lightweight, hermetic, CI-safe gate, not the
// cross-leg transport-equivalence suite, which already covers these same choreographies against a
// real child/compiled process in packages/sdk/src/transport-equivalence.test.ts). Each gets its own
// FRESH, OWNED temp WINTER_HOME (Task 8 pattern: injected via inMemoryProcess's `env` param so a
// run can never fall through to a real user's ~/.winter) even where a single query() call would be
// safe without one (inMemoryProcess's own per-call-mkdtemp fallback), so the hermeticity guarantee
// is explicit in every scenario here rather than resting on an implicit default. The resume
// scenario is the one where a SHARED WINTER_HOME across two separate query() calls is load-bearing,
// not just defensive — the second run must observe the first run's persisted transcript.

// Task 4 (WS-04 §4.1): a streaming-input prompt sends each item as its own `user` frame, closing
// with `end_input` once the iterable completes — the wrapper's query() runs to that natural EOF in
// this mode (mode-aware termination, controller Ruling P1-I), yielding every turn's result.
export async function traceWinterMultiTurn(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-multiturn-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    const twoTurns = (async function* () {
      yield "first";
      yield "second";
    })();
    for await (const msg of query({
      prompt: twoTurns,
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, undefined, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// One tool_use round (the "tooluse" test provider, WS-03 §11) then a closing text turn — exercises
// the engine's tool-call/tool-result round trip via query()'s own public surface.
export async function traceWinterToolRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-toolround-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        // Ruling P2-I: with the real PromptStage wired, an unmatched tool call with zero permission
        // configuration now denies (WS-07 §6.1 "never implicitly allowed") instead of falling
        // through the retired T6 interim-allow fallback — allowedTools pre-approves the "tooluse"
        // provider's own call so this scenario's traced wire stays byte-identical to before.
        allowedTools: ["test_tool"],
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("tooluse"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 10 (WS-08 §1/§9/§10): the SAME "tooluse" tool round as traceWinterToolRound above, but with
// a real SDK-callback PreToolUse hook (allow, advisory-only per WS-07 §2.1 — allowedTools still
// does the actual authorizing, exactly like that scenario) and includeHookEvents:true, so the
// committed golden also pins the public hook_started/hook_response lifecycle frames byte-for-byte
// (hookId is positional/deterministic; uuid/session_id are already normalizeTrace's own VOLATILE
// fields — see transport-equivalence.test.ts's own identical scenario, which this mirrors, for the
// full design rationale).
export async function traceWinterHookedToolRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-hookedtoolround-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: ["test_tool"],
        includeHookEvents: true,
        hooks: {
          PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } })] }],
        },
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("tooluse"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Matches transport-equivalence.test.ts's own settle window (its INTERRUPT_SETTLE_MS): a real-clock
// wait is the only mechanism available to synchronize with "the engine has genuinely started the
// turn and is blocked inside provider.generate()" — a provider-level hang emits no observable frame
// first, so there is no wire event to wait on instead.
const INTERRUPT_SETTLE_MS = 150;

// WS-04 §5's interrupt is a protocol-level control_request the query() WRAPPER has no API to send
// yet (Query.interrupt() is still a documented stub) — this scenario drives the raw frame stream
// directly, the same way transport-equivalence.test.ts's traceInterrupt does, bypassing query().
export async function traceWinterInterrupt(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-interrupt-"));
  const config: RuntimeConfig = { sessionId: "differential-interrupt-fixture", cwd: FIXTURE_CWD, model: FIXTURE_MODEL };
  const proc = inMemoryProcess(
    ["--run", "--config-json", JSON.stringify(config)],
    testProviderByName("hang"),
    undefined,
    { WINTER_HOME: winterHome },
  );
  try {
    let carry = "";
    const pending: WinterFrame[] = [];
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
    const send = (frame: WinterFrame): void => {
      proc.stdin.write(encodeFrame(frame));
    };

    const entries: ConformanceTraceEntry[] = [];
    const push = (frame: WinterFrame): void => {
      if (frame.type === "data") {
        const message = (frame as { message: { type: string; subtype?: string } }).message;
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(message), payload: message });
      } else {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: frame.type, payload: frame });
      }
    };
    const need = async (label: string): Promise<WinterFrame> => {
      const frame = await nextFrame();
      if (!frame) throw new Error(`differential interrupt: expected ${label}, got EOF`);
      return frame;
    };

    push(await need("the init frame"));
    push(await need("the system/init data frame"));

    send({ type: "user", text: "please hang" });
    await new Promise((resolve) => setTimeout(resolve, INTERRUPT_SETTLE_MS));
    send({ type: "control_request", requestId: "interrupt-1", subtype: "interrupt", payload: { scope: "turn" } });

    push(await need("the interrupt ack")); // control_response
    push(await need("the interrupted result")); // data(result)

    send({ type: "control_request", requestId: "end-input-1", subtype: "end_input", payload: undefined });
    push(await need("the end_input ack")); // control_response

    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 13 (Carry 1 / WS-07 §6.1, Ruling P2-I): ZERO permission configuration at all -- no rules, no
// canUseTool, no hooks, no allowedTools. The "tooluse" provider's own unmatched tool call has no
// prompt handler to resolve it, so it is DENIED under the spec-literal "never implicitly allowed"
// outcome (the T6 interim-allow fallback Ruling P2-I retired) -- and the run CONTINUES to a second
// provider turn and a normal completion, never hanging and never throwing. This differential golden
// pins the exact wire shape of that outcome (the denied tool_result AND the unconditional
// system/permission_denied stream message, WS-08 §6 / derived-shapes-p2.md item (d)) byte-for-byte.
// The INTEGRATION-level proof that this composes correctly through the full query() wrapper lives in
// transport-equivalence.test.ts's own "Carry 1" scenario (registered on all three legs); this
// scenario is the frozen, hermetic, in-memory-only golden half of the same finding.
export async function traceWinterDeniedToolRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-deniedtoolround-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        // Deliberately NOTHING else -- no allowedTools/disallowedTools/permissions/canUseTool/hooks.
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("tooluse"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 13 (WS-07 §12 "canUseTool"): the SAME unmatched "tooluse" call as the denied round above, but
// this time a REAL canUseTool callback answers it directly (allow) -- zero allowedTools/rules, so
// the callback is the ONLY thing resolving the call. Distinct from Task 8's own equivalence-suite
// "Ruling P2-B" scenario (which additionally proves updatedInput's transform channel across three
// real transports): this is the frozen, hermetic, in-memory-only golden for the plain-allow shape.
export async function traceWinterCanUseToolApprovedRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-canusetoolapproved-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        canUseTool: async () => ({ behavior: "allow" }),
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("tooluse"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 13 (WS-08 §12 items 1/8: "hooked round w/ lifecycle"): deliberately the DENY half of the
// hooked-lifecycle shape, not a duplicate of Task 10's existing hooked-tool-round golden (which
// pins a PreToolUse hook ALLOW). A PreToolUse hook that denies, with includeHookEvents:true, pins a
// genuinely different wire path: the public hook_started/hook_response lifecycle pair (outcome
// "success" -- the HOOK ran successfully and produced a decision; the DECISION it produced was
// "deny") immediately followed by the denied tool_result and the unconditional
// system/permission_denied message, and the run still continues to completion. Task 10's own golden
// stays cited for the allow half; this one is cited for the deny half -- see this task's report for
// the one-line justification.
export async function traceWinterHookDeniedRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-hookdeniedround-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        includeHookEvents: true,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => ({
                  hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "differential: hook says no" },
                }),
              ],
            },
          ],
        },
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("tooluse"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 13 (WS-07 §2 / §12 "stale-policy-version"; mirrors engine.test.ts's own raw-engine Task 6
// fixture, driven here through the full query() wrapper): ONE session, two turns, a LIVE
// setPermissionMode() call between them. Turn 1 runs under bypassPermissions (an unmatched call
// executes unconditionally, WS-07 §6.4); the mode is switched to dontAsk once turn 1's result is
// observed and its ack awaited; turn 2's IDENTICAL unmatched call is now denied outright, canUseTool
// never invoked (WS-07 §6.3). Streaming-input prompt, gated on the mode-switch ack, so the second
// envelope can never race ahead of the switch actually taking effect.
export async function traceWinterModeSwitchMidSession(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-modeswitch-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    let releaseSecondTurn!: () => void;
    const secondTurnGate = new Promise<void>((resolve) => {
      releaseSecondTurn = resolve;
    });
    async function* twoTurns() {
      yield "first";
      await secondTurnGate;
      yield "second";
    }
    const gen = query({
      prompt: twoTurns(),
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // "modeswitch" (provider/mock.ts, added by this task): the SAME fixed 4-step script
        // (tool_use c1 -> text -> tool_use c2 -> text) transport-equivalence.test.ts's own
        // mode-switch scenario selects by name on the child/compiled legs -- one source of truth.
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("modeswitch"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    });
    let modeSwitchPromise: Promise<void> | undefined;
    for await (const msg of gen) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
      if (msg.type === "result" && modeSwitchPromise === undefined) {
        modeSwitchPromise = gen.setPermissionMode("dontAsk");
        modeSwitchPromise.then(releaseSecondTurn);
      }
    }
    await modeSwitchPromise;
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 9 (WS-05 §7): two SEPARATE query() calls sharing one sessionId over the SAME (shared, this
// time load-bearing) temp WINTER_HOME — a real cross-process-shaped resume in spirit, even though
// the in-memory transport never spawns a second OS process the way the child/compiled legs of
// transport-equivalence.test.ts do for the identical choreography. The "reflect" test provider lets
// the second run's reply prove it saw the first run's history.
export async function traceWinterResume(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-resume-"));
  const sessionId = randomUUID();
  try {
    const entries: ConformanceTraceEntry[] = [];
    async function runLeg(prompt: string, extra: { sessionId?: string; resume?: string }): Promise<void> {
      for await (const msg of query({
        prompt,
        options: {
          model: FIXTURE_MODEL,
          cwd: FIXTURE_CWD,
          spawnClaudeCodeProcess: (opts) =>
            inMemoryProcess(opts.args, testProviderByName("reflect"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
          ...(extra.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
          ...(extra.resume !== undefined ? { resume: extra.resume } : {}),
        },
      })) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
      }
    }

    await runLeg("first", { sessionId }); // establishes history under a pre-allocated sessionId
    await runLeg("second", { resume: sessionId }); // a NEW query()/process-shaped instance resumes it

    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 2 (P3, WS-06 §3.5): the background-task message family, end-to-end through a real registered
// tool's ctx.emitFrame call — proves engine.ts's plumbing (buildDefaultToolExecutor's emitFrame
// closure -> output.write) against a committed golden, complementing transport-equivalence.test.ts's
// own in-memory-scoped RED->GREEN proof of the same seam (see that file's own header comment on this
// same scenario shape for why this phase's proof stops at the in-memory leg — main.ts's stubExecutor
// is a structural gap outside this task's named scope, per Task 1's own "main.ts is untouched"
// invariant; this script is in-memory-only BY DESIGN regardless, per its own file header above, so
// that gap does not even apply here).
//
// Framed as a single backgrounded bash task's own lifecycle (WS-06 §3.5's own motivating case,
// background-tasks.ts's task-id namespace) — but the registered tool also emits task_updated,
// background_tasks_changed, and local_command_output back-to-back so this ONE new golden (this
// task's own "one new differential scenario" scope) covers the full closed six-shape family in a
// single run, rather than pinning three of six here and leaving the rest to type-check alone.
// task_id/output_file/description/summary/usage counters are all FIXED literals, never
// randomUUID()/createBackgroundTask() output or a real timestamp — regenerate-twice determinism
// (WS-17 §4) depends on it, since `end_time` (task_updated's patch) is NOT one of normalizeTrace's
// VOLATILE fields the way uuid/session_id/duration_ms already are.
const DIFFERENTIAL_BGTASK_TOOL = "differential_bgtask_probe"; // throwaway snake_case test double, distinct from transport-equivalence.test.ts's own test_bgtask_probe (separate process, but named apart for clarity) -- never a real WS-06 name

registerTool({
  descriptor: {
    canonicalName: DIFFERENTIAL_BGTASK_TOOL,
    advertisedName: DIFFERENTIAL_BGTASK_TOOL,
    source: "sdk",
    inputSchema: { type: "object" },
    description: "Test-only background-task-frame emitter (scripts/differential.ts) -- not a WS-06 tool.",
    exposure: "hidden",
    permissionClass: "execute",
    availability: {},
    capabilityRequirements: [],
    disposition: "implement-now",
  },
  executor: {
    async execute(_input, ctx) {
      const taskId = "bgtask-differential-1";
      const toolUseId = "bgtask-call-1";
      const description = "sleep 100 &";
      ctx.emitFrame({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        tool_use_id: toolUseId,
        description,
        task_type: "local_bash",
        is_backgrounded: true,
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: taskId, task_type: "local_bash", description, ambient: false }],
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "task_progress",
        task_id: taskId,
        tool_use_id: toolUseId,
        description,
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
        last_tool_name: "Bash",
        summary: "still running",
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "task_updated",
        task_id: taskId,
        patch: { status: "completed", end_time: 0 },
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        tool_use_id: toolUseId,
        status: "completed",
        output_file: "/winter-fixture/tasks/bgtask-differential-1.output",
        summary: "background bash task finished",
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      ctx.emitFrame({
        type: "system",
        subtype: "local_command_output",
        content: "[background] sleep 100 & -> completed",
        uuid: randomUUID(),
        session_id: ctx.sessionId,
      });
      return { output: "backgrounded" };
    },
  },
});

export async function traceWinterBackgroundTaskRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-bgtask-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "run it in the background",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: [DIFFERENTIAL_BGTASK_TOOL],
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(
            opts.args,
            scriptedProvider([
              { kind: "tool_use", calls: [{ id: "bgtask-call-1", name: DIFFERENTIAL_BGTASK_TOOL, input: { command: "sleep 100 &" } }] },
              { kind: "text", text: "backgrounded" },
            ]),
            undefined,
            { ...opts.env, WINTER_HOME: winterHome },
          ),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Task 8 (Phase 3 close-out): a REAL "Bash" tool round_in_background call, end-to-end through the
// engine's DEFAULT registry-backed executor (no scripted/fake tool double this time, unlike
// traceWinterBackgroundTaskRound above) -- proves the real production wiring this task's own
// production-wiring MUST covers reaches the differential harness too, not just
// transport-equivalence.test.ts's own equivalence proof and bash.test.ts's own unit coverage.
//
// Scope, stated plainly (advisor-reviewed design, "closest correct variant"): this golden pins ONLY
// the SYNCHRONOUS half of a backgrounded call -- task_started + background_tasks_changed (emitted
// before execute() even returns, per bash.test.ts's own "emits task_started and
// background_tasks_changed synchronously before returning") and the immediate tool_result carrying
// the sandbox tag + "output_file: <path>" text. The command (`sleep 10`) is deliberately chosen to
// run far longer than this scenario's own single query() pass, so the ASYNC completion half
// (task_notification, once the detached child actually exits) is deterministically ABSENT from the
// captured trace -- a wall-clock race between that frame and query()'s own single-shot termination at
// `result` (Ruling P1-I) has no scrub that could fix it, and bash.test.ts's own background fixtures
// already cover that half by POLLING (`for (let i = 0; i < 50 && !frames.some(...))`), a strategy a
// byte-exact committed golden cannot use. `sandbox: {enabled:false}` (matching the equivalence
// suite's own identical Lane C scenario) so this passes on non-darwin CI too, where a real sandboxed
// path would throw SandboxUnavailableError (spawn.test.ts pins that failure mode).
export async function traceWinterBashBackgroundRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-bashbg-"));
  // Fixed literal, not randomUUID() -- this IS the D18 session-temp root's own `backendUuid` path
  // segment (engine.ts's resolveSessionTempPaths: `backendUuid: config.sessionId`). Pinning it here
  // removes ONE of the two machine-independent-in-principle-but-otherwise-computed components of that
  // path from the non-determinism this scenario has to scrub below (cwd is already FIXTURE_CWD,
  // pinning the OTHER component, tempProjectKey). What's left after both are pinned -- the real OS
  // user id and the resolved TMPDIR base, both genuinely machine-dependent -- is handled by the
  // value-based scrub below, not by trying to pin those too.
  const sessionId = "differential-bash-background-fixture";
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        sessionId,
        allowedTools: ["Bash"],
        sandbox: { enabled: false },
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(
            opts.args,
            scriptedProvider([
              { kind: "tool_use", calls: [{ id: "bash-bg-call-1", name: "Bash", input: { command: "sleep 10", run_in_background: true } }] },
              { kind: "text", text: "backgrounded" },
            ]),
            undefined,
            { ...opts.env, WINTER_HOME: winterHome },
          ),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }

    // Value-based scrub (advisor-reviewed design; NOT a change to normalizeTrace's shared VOLATILE
    // set -- that would silently strip traceWinterBackgroundTaskRound's own MEANINGFUL fixed-literal
    // task_id/output_file pins above). The real Bash executor's own createBackgroundTask generates a
    // genuine randomUUID() task id and embeds the real, machine-dependent D18 session-temp root
    // (unpinned uid/TMPDIR-base) into both a structured field (task_started.task_id) and free text
    // (the tool_result's own "output_file: <path>" line, bash.test.ts's own regex reused verbatim
    // here) -- extracted from THIS run's own actual output, never predicted in advance, and replaced
    // by exact value: the path first (it contains the task id as a substring), then the bare id.
    const serialized = JSON.stringify(entries);
    // [^\s\\]+, not bash.test.ts's own \S+ -- JSON.stringify renders the tool_result's real newline
    // (bash.ts's own template: "output_file: <path>\n[sandbox: ...]") as the two literal characters
    // `\` `n`, neither of which is regex whitespace, so a plain \S+ over-captures straight through
    // the escape and into "[sandbox:" up to its own next real space. A POSIX path never contains a
    // backslash, so excluding it here (in addition to real whitespace) stops the match exactly where
    // bash.test.ts's own \S+ stops when run against the UN-escaped in-memory string instead.
    const outputFileMatch = /output_file: ([^\s\\]+)/.exec(serialized);
    const taskIdMatch = /"task_id":"([^"]+)"/.exec(serialized);
    let scrubbed = serialized;
    if (outputFileMatch) scrubbed = scrubbed.split(outputFileMatch[1]!).join("/winter-fixture-tasks/TASKID.output");
    if (taskIdMatch) scrubbed = scrubbed.split(taskIdMatch[1]!).join("TASKID");
    const scrubbedEntries = JSON.parse(scrubbed) as ConformanceTraceEntry[];

    return normalizeTrace(scrubWinterHome(scrubbedEntries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
    // Known, accepted leak (same structural shape as transport-equivalence.test.ts's own real-process
    // legs): the D18 session-temp root itself (OS-tempdir-rooted -- WS-01 §2.3's "engine-sibling"
    // layout is NOT under WINTER_HOME, so the rmSync above never touches it) is not cleaned up here.
    // The `sleep 10` child is spawned detached (bash.test.ts's own "background task" framing) and
    // outlives this function's return by design -- a harmless, self-terminating ~10s orphan process,
    // not a resource that accumulates across repeated runs.
  }
}

// Task 8 (Phase 3 close-out, WS-06 §6 obligation 1's own "system/init.tools snapshot" MUST): proves
// the buildAdvertisedSet wiring (previous commit; conformance.test.ts's own engine-level unit proof)
// also survives the FULL query() wrapper, pinned byte-exact -- disallowedTools:["Bash"] is one of
// the TWO config axes RuntimeConfig actually threads to the real call today (mode is the other,
// exercised implicitly here via the ordinary default permissionMode; see conformance.test.ts's own
// WS06-01b note for the other four axes' scope carve-out). Note: like every other scenario's golden after
// the previous commit's regeneration, this one CHURNS whenever a descriptor is added/removed from the
// registry -- not a new fragility this scenario introduces, the same property the other 11 already
// have now.
export async function traceWinterAdvertisedSetRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-advertisedset-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "hi",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        disallowedTools: ["Bash"],
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, undefined, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}


// --- Phase 4 Task 8: the four P4-family differential scenarios ----------------------------------
//
// Each is the hermetic, in-memory-only, byte-frozen half of a shape the equivalence suite proves
// across real transports (packages/sdk/src/transport-equivalence.test.ts) -- the same division of
// labour every scenario above already follows.
//
// SCRUBBING: three of the four carry values that are genuinely non-deterministic across runs and
// live inside a JSON-ENCODED tool_result string, which normalizeTrace's own VOLATILE stripping (a
// recursive walk over OBJECT keys) structurally cannot reach. Handled by the scenario-local
// `scrubJsonToolResults` below rather than by widening trace.ts's shared VOLATILE set -- widening it
// would silently strip `task_id`/`output_file` from the background-task golden above, whose FIXED
// LITERAL values are the whole point of that scenario.
// Phase 4 fix wave (whole-branch N5): `totalToolUseCount` is deliberately NOT in this set. It is
// the one key here that could MASK a real cross-leg divergence (a child counting its own tool calls
// differently on two transports is exactly the kind of drift this corpus exists to catch), and it
// is not volatile at all for these fixtures -- every scenario's child makes a fixed number of tool
// calls. The rest genuinely are volatile: uuids, wall-clock durations, and machine-specific paths.
const P4_RESULT_VOLATILE_KEYS = new Set(["agentId", "totalDurationMs", "taskId", "messageId", "transcript"]);

function scrubJsonToolResults(entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] {
  const scrubValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrubValue);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = P4_RESULT_VOLATILE_KEYS.has(k) ? "<scrubbed>" : scrubValue(v);
    return out;
  };
  return entries.map((entry) => {
    const message = (entry.payload as { message?: { content?: unknown } } | undefined)?.message;
    if (!message || !Array.isArray(message.content)) return entry;
    const content = message.content.map((block) => {
      const b = block as { type?: string; content?: unknown; name?: string; input?: unknown };
      if (b.type === "tool_use" && b.name === "SendMessage" && typeof b.input === "object" && b.input !== null) {
        return { ...b, input: { ...(b.input as Record<string, unknown>), to: "<scrubbed>" } };
      }
      if (b.type !== "tool_result" || typeof b.content !== "string") return block;
      try {
        return { ...b, content: JSON.stringify(scrubValue(JSON.parse(b.content))) };
      } catch {
        return block;
      }
    });
    return { ...entry, payload: { ...(entry.payload as object), message: { ...message, content } } };
  });
}

// (1) WS-09 §1.1/§2.1 + RULING P4-C: an in-process SDK MCP server -- its tool round AND the
// `system/init.mcp_servers` snapshot the real McpLifecycle now feeds, byte-frozen. Note what the
// golden pins beyond the tool call itself: `mcp_servers: [{name, status:"connected"}]`, and the
// MCP-family tools appearing in `init.tools` because declaring a server is exactly the session fact
// `winter.mcp`'s derivation is gated on (registry.ts's SessionCapabilityFacts).
export async function traceWinterMcpToolRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-mcp-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "go",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: [MCP_SDK_TEST_TOOL_NAME],
        mcpServers: {
          [MCP_SDK_TEST_SERVER_NAME]: {
            type: "sdk",
            name: MCP_SDK_TEST_SERVER_NAME,
            instance: {
              listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
              async callTool(_name: string, args: Record<string, unknown>) {
                return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
              },
            },
          },
        },
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("mcpsdk"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// (2) WS-09 §8.2/§8.5: a ToolSearch `select:` round, then a CALL of the just-selected tool. Pins the
// whole load-first mechanic on the wire: with activation ON the MCP tool is DEFERRED, so it is
// absent from `init.tools` (the ground-truth array, §8.5) and a bare call would be load-first
// rejected; the `select:` emits a real `tool_reference` block and marks it loaded; the following
// call then executes for real. `total_deferred_tools` and the ToolSearch result shape are pinned
// byte-exact in the same trace.
// A DISTINCT server name from the mcp-tool-round scenario above, deliberately. Found empirically:
// this script runs every scenario sequentially in ONE process over a process-wide tool registry, and
// `query()` returns at the terminal `result` frame -- which the engine writes BEFORE its own teardown
// runs. So the previous scenario's `unregisterMcpServerTools(<name>)` can fire AFTER the next
// scenario has already registered the same name, silently deleting it (observed: an "unknown tool"
// tool_result and `total_deferred_tools` counting only the two standing canonical entries). Distinct
// names make the two scenarios independent regardless of teardown timing.
const TOOLSEARCH_FIXTURE_SERVER = "t8toolsearch";
const TOOLSEARCH_FIXTURE_TOOL = `mcp__${TOOLSEARCH_FIXTURE_SERVER}__echo`;

export async function traceWinterToolSearchSelectRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-toolsearch-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "find and call it",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        toolSearchEnabled: true,
        allowedTools: ["ToolSearch", TOOLSEARCH_FIXTURE_TOOL],
        mcpServers: {
          [TOOLSEARCH_FIXTURE_SERVER]: {
            type: "sdk",
            name: TOOLSEARCH_FIXTURE_SERVER,
            instance: {
              listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
              async callTool(_name: string, args: Record<string, unknown>) {
                return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }] };
              },
            },
          },
        },
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(
            opts.args,
            scriptedProvider([
              { kind: "tool_use", calls: [{ id: "ts-call-1", name: "ToolSearch", input: { query: `select:${TOOLSEARCH_FIXTURE_TOOL}` } }] },
              { kind: "tool_use", calls: [{ id: "mcp-call-1", name: TOOLSEARCH_FIXTURE_TOOL, input: { x: 1 } }] },
              { kind: "text", text: "tool search done" },
            ]),
            undefined,
            { ...opts.env, WINTER_HOME: winterHome },
          ),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// (3) WS-10 §1/§4: a real subagent spawn -> child turn -> result round through the full query()
// wrapper. The equivalence suite proves the SAME choreography across real transports; this is its
// frozen half. Deliberately FOREGROUND (see provider/mock.ts's "subagent" case for why a background
// spawn cannot be pinned deterministically).
export async function traceWinterSubagentSpawnRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-subagent-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "run the subagent",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: ["Agent"],
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("subagent"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(scrubJsonToolResults(entries), winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Phase 4 fix wave (task-8 review I2 + whole-branch KNOWN 11): the spawn round in which the CHILD
// itself makes a tool call, with `forwardSubagentText` ON so the child's own frames reach the wire.
//
// What this golden pins, frame by frame (17 -> 18 goldens; the ONLY new one this wave adds):
//   [0] system/init            -- one, and only one (P4-J(c)): a child's own init never surfaces.
//   [1] assistant              -- the PARENT's `Agent` tool_use, id `agent-call-1`, NO
//                                 parent_tool_use_id (it is the top-level turn's own block).
//   [2] assistant              -- the CHILD's `ReadNotifications` tool_use, id `child-call-1`,
//                                 stamped `parent_tool_use_id: "agent-call-1"`. THE point of this
//                                 golden: before it, `parent_tool_use_id` appeared in no committed
//                                 golden at all.
//   [3] user                   -- the CHILD's own tool_result, same stamp, carrying the fixed
//                                 `{"notifications":[],"remaining":0}` -- proof the child's call was
//                                 genuinely EXECUTED after its permission request was answered
//                                 (`canUseTool` here answers immediately; the LATE-answer half,
//                                  which needs a real clock, is the equivalence scenario's job --
//                                  a golden must not depend on a timer).
//   [4] assistant              -- the CHILD's own text, forwarded only because forwardSubagentText
//                                 is on, same stamp (WS-10 §4's own gate, in a committed artifact).
//   [5] user                   -- the PARENT's tool_result for `agent-call-1` (the Agent tool's own
//                                 JSON envelope; its volatile agentId/duration/counters are scrubbed
//                                 by scrubJsonToolResults, exactly as in the sibling spawn golden).
//   [6] assistant + [7] result -- the parent's final turn: exactly ONE terminal result (P4-J(c)).
export async function traceWinterSubagentPermissionRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-subagentperm-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "run the subagent",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: ["Agent"], // only the CHILD's own call is left unresolved
        permissionMode: "default",
        forwardSubagentText: true,
        canUseTool: async () => ({ behavior: "allow" }),
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("subagentperm"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(scrubJsonToolResults(entries), winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// (4) WS-10 §10.3: SendMessage addressed to this session's own (now terminal) child -- a RESUME,
// with `resumed_and_delivered` claimed only because resume and delivery both completed.
// Whole-branch N4 (P4 fix wave, a note on this golden's own fragility -- not a change): this trace
// is deterministic only because the RESUMED child emits nothing forwardable. `forwardSubagentText`
// is off here, so the resumed generation's text is swallowed, and its `init`/`result` frames are
// swallowed unconditionally (child-handle.ts's transformChildFrame). Flip that default, or give the
// resumed child a tool call of its own, and its frames would interleave NONDETERMINISTICALLY with
// the parent's remaining turn -- a resume is fire-and-forget from the parent's point of view, with
// no ordering guarantee against it. A scenario that WANTS a child's own frames on the wire should
// follow `subagent-permission-round` instead, which is deterministic because the parent's Agent call
// synchronously awaits the child's result.
export async function traceWinterSendMessageToChildRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-childmsg-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "spawn then steer",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: ["Agent", "SendMessage"],
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("childmsg"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(scrubJsonToolResults(entries), winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}


/**
 * A queued notification carries a real wall-clock `queued_at` (ISO 8601, minted at push time), which
 * a byte-frozen golden cannot hold -- `--update` would write a different file on every run, failing
 * the regenerate-twice determinism WS-17 §4 requires.
 *
 * Replaced by a fixed token rather than stripped: the FIELD's presence is part of the shape a host
 * reads, and a golden that dropped it would stop pinning that the notice is timestamped at all.
 * Applied to both places one appears -- the live `messaging.idle_notice` frame and the
 * `read_notifications` page -- since they are deliberately the same record.
 */
function scrubIdleNoticeTimestamps(entries: ConformanceTraceEntry[]): ConformanceTraceEntry[] {
  return JSON.parse(JSON.stringify(entries).replace(/"queued_at":"[^"]*"/g, '"queued_at":"QUEUED_AT"')) as ConformanceTraceEntry[];
}

// (5) Phase 7b (R-7b-4): the per-session MESSAGING FACET's own frame vocabulary, byte-frozen.
//
// All six `messaging.*` control subtypes plus the malformed-request refusal, driven on the RAW frame
// stream (the `interrupt` scenario's shape) rather than through `query()`, because a facet exchange
// IS a pair of control frames and `query()`'s iteration only ever yields SdkMessages -- a
// `for await` scenario would record none of it.
//
// DELIBERATELY CHILDLESS, and that is what makes it a golden. A session with a real child would put
// its per-run minted child id inside `agent:<session>:<child>` in three of these seven payloads, and
// a golden cannot hold a value that changes every run (the sibling `sendmessage-child-round` scrubs
// exactly that id out of the Agent tool_result for the same reason). What this file CAN pin
// perfectly is the shape of every frame and the exact typed answer for every miss -- which is the
// half a router integrating against this wire reads first. The WITH-A-CHILD behaviour is proven
// where it belongs: `packages/sdk/src/messaging-facet.test.ts` (a real child, running and terminal)
// and `transport-equivalence.test.ts`'s own facet scenario (the same, on every leg including the
// compiled binary).
//
// Every requestId is a fixed literal, like the interrupt scenario's, so nothing in the recorded
// trace is minted per run.
export async function traceWinterMessagingFacetRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-facet-"));
  const sessionId = "differential-facet-fixture";
  const config: RuntimeConfig = { sessionId, cwd: FIXTURE_CWD, model: FIXTURE_MODEL };
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], undefined, undefined, { WINTER_HOME: winterHome });
  try {
    let carry = "";
    const pending: WinterFrame[] = [];
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
    const entries: ConformanceTraceEntry[] = [];
    const push = (frame: WinterFrame): void => {
      if (frame.type === "data") {
        const message = (frame as { message: { type: string; subtype?: string } }).message;
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(message), payload: message });
      } else {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: frame.type, payload: frame });
      }
    };
    const need = async (label: string): Promise<WinterFrame> => {
      const frame = await nextFrame();
      if (!frame) throw new Error(`differential messaging facet: expected ${label}, got EOF`);
      return frame;
    };
    // Reads until THIS request's own `control_response` arrives, pushing every frame seen on the way.
    //
    // Not "read exactly one frame" (the interrupt scenario's shape), because this facet can emit a
    // RUNTIME-ORIGINATED frame in the middle of an exchange: `subscribe_idle` on an already-idle
    // target sends its notice immediately (WS-10 §14), so a `messaging.idle_notice` control_request
    // arrives before the subscribe answer. A one-frame-per-ask reader mislabels every frame after
    // that point and silently drops the last -- which is exactly what happened on the first run of
    // this scenario.
    const ask = async (requestId: string, subtype: string, payload: unknown, label: string): Promise<void> => {
      proc.stdin.write(encodeFrame({ type: "control_request", requestId, subtype, payload } as WinterFrame));
      for (;;) {
        const frame = await need(label);
        push(frame);
        if (frame.type === "control_response" && (frame as { requestId?: string }).requestId === requestId) return;
      }
    };

    push(await need("the init frame"));
    push(await need("the system/init data frame"));

    // A synthetic envelope from a HOST-side router session -- the exact shape `Query.messaging` puts
    // on the wire, with a target this session genuinely does not have.
    const missingChild = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: sessionId, parentWinterSessionId: sessionId, childId: "no-such-child" };
    const message = (messageId: string, to: unknown) => ({
      messageId,
      from: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_host_router" },
      fromGeneration: 0,
      to,
      toGeneration: 0,
      body: "from the host router",
      notifyWhenIdle: false,
      createdAt: 0,
      expiresAt: 0,
      hopCount: 0,
      senderPermissionClass: "prompts",
    });

    // 1. list_reachable on a childless session: an empty listing, never an error.
    await ask("facet-1", "messaging.list_reachable", undefined, "the list_reachable answer");
    // 2. sender_class: WS-10 §13's matrix input, read from this session's LIVE permission mode.
    await ask("facet-2", "messaging.sender_class", undefined, "the sender_class answer");
    // 3/4. steer/resume a child that does not exist: the typed `not_found` that tells a router its
    //      directory entry is stale -- never a throw, and never each other's answer.
    await ask("facet-3", "messaging.steer_child", { id: "no-such-child", message: message("host-1", missingChild) }, "the steer_child answer");
    await ask("facet-4", "messaging.resume_child", { id: "no-such-child", message: message("host-2", missingChild) }, "the resume_child answer");
    // 5. subscribe_idle on an AGENT: WS-10 §14 refuses the entire call for a subagent target.
    await ask("facet-5", "messaging.subscribe_idle", { id: "no-such-child", messageId: "host-3", subscriberSessionId: "s_host_router" }, "the subscribe_idle answer");
    // 6. deliver to a session this process does not hold: `unavailable`, non-retryable.
    await ask(
      "facet-6",
      "messaging.deliver",
      { message: message("host-4", { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_not_here" }) },
      "the deliver answer",
    );
    // 7. THE VALIDATION REFUSAL: a malformed request is `ok:false` with a typed code, never a
    //    fabricated DeliveryOutcome -- the negative control for every guard above.
    await ask("facet-7", "messaging.deliver", { message: { messageId: "" } }, "the malformed-request refusal");
    // 8. ...and the WRONG-DOOR refusal: `deliver` addressed at an AGENT is a malformed call, not an
    //    `unavailable` outcome a router would retry its way around (WS-10 §10.3 gives an agent its
    //    own two doors).
    await ask("facet-8", "messaging.deliver", { message: message("host-5", missingChild) }, "the wrong-door refusal");
    // 9. ...and the OWNING-PARENT fence (WS-10 §10.3): a child of ANOTHER session is refused before
    //    any adapter call. The reference adapter cannot enforce this -- `findChild` matches the
    //    process-wide roster against the address's own claimed parent -- so the handler does, and
    //    this step is what keeps that fence from being deleted by someone who reads only the adapter.
    const foreignChild = { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s_other", parentWinterSessionId: "s_other", childId: "c1" };
    await ask("facet-9", "messaging.steer_child", { id: "agent:s_other:c1", message: message("host-6", foreignChild) }, "the owning-parent refusal");

    // 10/11. THE notify_when_idle RETURN PATH, both halves, on the wire.
    //
    //  * `subscribe_idle` on THIS SESSION is accepted -- WS-10 §14 refuses a subagent target
    //    outright, so the session is the only legitimate target inside a spawned runtime, and the
    //    run's own self-peer registration is what makes it one.
    //  * the session is ALREADY IDLE here (this scenario sends no user envelope, so no turn is ever
    //    in flight), which is WS-10 §14's "send the notice immediately when the target is already
    //    idle" row -- so the LIVE `messaging.idle_notice` frame arrives BEFORE the subscribe answer,
    //    and both are in the golden. That interleaving is why `ask` reads until its own requestId
    //    rather than exactly one frame.
    //  * `read_notifications` then returns the SAME record -- same `notification_id` -- because the
    //    live forward deliberately does not consume the queue entry. That equality, frozen here, is
    //    the whole contract between the two halves: a host that missed the frame still collects it,
    //    and a host that got both dedupes on the id.
    await ask("facet-10", "messaging.subscribe_idle", { id: `session:${sessionId}`, messageId: "host-7", subscriberSessionId: sessionId }, "the self-session subscribe answer");
    await ask("facet-11", "messaging.read_notifications", { max: 10 }, "the notifications page");

    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "facet-end", subtype: "end_input", payload: undefined }));
    push(await need("the end_input ack"));

    return normalizeTrace(scrubIdleNoticeTimestamps(scrubWinterHome(entries, winterHome)));
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// --- Phase 5 Task 8: the P5-family differential scenarios ----------------------------------------
//
// Each is the hermetic, in-memory-only, byte-frozen half of a shape `transport-equivalence.test.ts`
// proves across real transports -- the same division of labour every scenario above follows.
//
// TWO OF THE SIX P5 EQUIVALENCE ROUNDS DELIBERATELY HAVE NO GOLDEN HERE, and the reasons are
// properties of the features rather than of this harness:
//
//   * WORKFLOW. Its run id is random (`wf_<hex>`), its persisted script path and transcript
//     directory embed both that id and the session uuid, and `WorkflowRuntime.launch` refuses
//     outright on a host without `sandbox-exec` -- so the round is darwin-only and its wire output
//     is unpinnable without scrubbing away most of what a golden would be pinning. Its
//     compiled-binary proof is `verify:workflow`, a CI step; its cross-leg proof is the equivalence
//     scenario.
//   * CHECKPOINT-REWIND. It needs a real temp work tree, a second run, and a raw `rewind_files`
//     control request; every path in the resulting trace is machine-specific. Proven cross-leg
//     instead, where the comparison is two runs against each other rather than against a file.
//
// The four below are fully deterministic once the winterHome scrub above is applied.

export async function traceWinterCompactionAutoRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-compactauto-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    // FIVE envelopes: `retainedPairs` defaults to 4 and is not a RuntimeConfig field, so a shorter
    // conversation is REFUSED by the controller rather than compacted (see provider/mock.ts's
    // "p5compact" case for the full note, and for why its usage ramps rather than sitting flat).
    const fiveTurns = (async function* () {
      for (const t of ["one", "two", "three", "four", "five"]) yield t;
    })();
    for await (const msg of query({
      prompt: fiveTurns,
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        contextWindowTokens: 1000,
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("p5compact"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubPreservedUuids(scrubWinterHome(entries, winterHome)));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

export async function traceWinterCompactionManualRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-compactmanual-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    // NO `contextWindowTokens` override, deliberately: the manual path must not be entangled with the
    // auto trigger, or a boundary in this golden could have come from either and the file would stop
    // discriminating between them.
    const withCommand = (async function* () {
      for (const t of ["one", "two", "three", "four", "five", "/compact keep the API decisions"]) yield t;
    })();
    for await (const msg of query({
      prompt: withCommand,
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("p5compact"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubPreservedUuids(scrubWinterHome(entries, winterHome)));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

const P5_STRUCTURED_SCHEMA = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };

export async function traceWinterStructuredOutputRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-structured-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "answer",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        outputFormat: { type: "json_schema", schema: P5_STRUCTURED_SCHEMA },
        allowedTools: ["StructuredOutput"],
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("p5structured"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

export async function traceWinterStructuredExhaustionRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-structuredfail-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    // THE ERROR RESULT IS THE POINT, AND `query()` THROWS ON IT. `iterate` yields the terminal
    // `result` frame and then raises `ResultError` for any error subtype (query.ts's own
    // error-result-then-throw contract, report §9) -- so the frame this golden exists to pin is
    // already recorded by the time the throw lands. Caught rather than propagated, and the CLASS is
    // asserted, so a scenario that started failing for a different reason cannot pass silently.
    try {
      for await (const msg of query({
        prompt: "answer",
        options: {
          model: FIXTURE_MODEL,
          cwd: FIXTURE_CWD,
          outputFormat: { type: "json_schema", schema: P5_STRUCTURED_SCHEMA },
          allowedTools: ["StructuredOutput"],
          spawnClaudeCodeProcess: (opts) =>
            // Three attempts rather than the default five -- the shorter budget is itself the proof
            // that `MAX_STRUCTURED_OUTPUT_RETRIES` is honoured, and it is what makes the retry COUNT
            // visible in the committed file rather than merely the terminal shape.
            inMemoryProcess(opts.args, testProviderByName("p5structuredfail"), undefined, { ...opts.env, WINTER_HOME: winterHome, MAX_STRUCTURED_OUTPUT_RETRIES: "3" }),
        },
      })) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
      }
      throw new Error("structured-exhaustion-round: expected query() to raise ResultError on the error result");
    } catch (err) {
      if (!(err instanceof ResultError)) throw err;
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

export async function traceWinterSkillInvocationRound(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-skill-"));
  try {
    // The USER tier of this scenario's own home. A project-tier skill would need FIXTURE_CWD to hold
    // a project dot-dir tree, and FIXTURE_CWD is a synthetic path that deliberately does not exist.
    const skillDir = join(winterHome, "skills", P5_FIXTURE_SKILL_NAME);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${P5_FIXTURE_SKILL_NAME}\ndescription: the T8 cross-leg skill probe\n---\nP5 SKILL BODY MARKER\n`);
    const entries: ConformanceTraceEntry[] = [];
    for await (const msg of query({
      prompt: "use the skill",
      options: {
        model: FIXTURE_MODEL,
        cwd: FIXTURE_CWD,
        allowedTools: ["Skill"],
        settingSources: ["user"],
        spawnClaudeCodeProcess: (opts) =>
          inMemoryProcess(opts.args, testProviderByName("p5skill"), undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: kindOf(msg), payload: msg });
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// --- registry-driven check: every scenario against its committed golden --------------------------

interface Scenario {
  name: string;
  trace: () => Promise<ConformanceTraceEntry[]>;
  goldenFile: string;
}

const SCENARIOS: Scenario[] = [
  { name: "plain-query", trace: traceWinterPlainQuery, goldenFile: "plain-query.trace.json" },
  { name: "multi-turn", trace: traceWinterMultiTurn, goldenFile: "multi-turn.trace.json" },
  { name: "tool-round", trace: traceWinterToolRound, goldenFile: "tool-round.trace.json" },
  { name: "interrupt", trace: traceWinterInterrupt, goldenFile: "interrupt.trace.json" },
  { name: "resume", trace: traceWinterResume, goldenFile: "resume.trace.json" },
  // Task 10: NEW golden — hooks are default-off in every scenario above (none sets config.hooks),
  // so none of them could have exercised this code path; this is the one scenario in this file that
  // opts into includeHookEvents + a real SDK-callback hook.
  { name: "hooked-tool-round", trace: traceWinterHookedToolRound, goldenFile: "hooked-tool-round.trace.json" },
  // Task 13: four new goldens closing the phase's own conformance sweep (Carry 1 + the brief's own
  // scenario list) — see this task's report for the one-line justification of each.
  { name: "denied-tool-round", trace: traceWinterDeniedToolRound, goldenFile: "denied-tool-round.trace.json" },
  { name: "canusetool-approved-round", trace: traceWinterCanUseToolApprovedRound, goldenFile: "canusetool-approved-round.trace.json" },
  { name: "hook-denied-round", trace: traceWinterHookDeniedRound, goldenFile: "hook-denied-round.trace.json" },
  { name: "mode-switch-mid-session", trace: traceWinterModeSwitchMidSession, goldenFile: "mode-switch-mid-session.trace.json" },
  // Task 2 (P3, WS-06 §3.5): the one new golden this task adds -- see traceWinterBackgroundTaskRound's
  // own header comment for the one-line justification (full closed background-task message family,
  // proved end-to-end through a real registered tool's ctx.emitFrame -> engine.ts -> output.write).
  { name: "background-task-round", trace: traceWinterBackgroundTaskRound, goldenFile: "background-task-round.trace.json" },
  // Task 8 (Phase 3 close-out): two new goldens -- see each trace function's own header comment for
  // scope and design (the bash-background one is deliberately scoped to the synchronous half only;
  // the advertised-set one closes the loop from the previous commit's buildAdvertisedSet wiring
  // through the full query() wrapper, not just runEngine() directly).
  { name: "bash-background-round", trace: traceWinterBashBackgroundRound, goldenFile: "bash-background-round.trace.json" },
  { name: "advertised-set-round", trace: traceWinterAdvertisedSetRound, goldenFile: "advertised-set-round.trace.json" },
  // Phase 4 Task 8: four new goldens, one per P4 family -- see each trace function's own header for
  // its scope and for why it is the frozen half of a shape the equivalence suite proves across real
  // transports.
  { name: "mcp-tool-round", trace: traceWinterMcpToolRound, goldenFile: "mcp-tool-round.trace.json" },
  { name: "toolsearch-select-round", trace: traceWinterToolSearchSelectRound, goldenFile: "toolsearch-select-round.trace.json" },
  { name: "subagent-spawn-round", trace: traceWinterSubagentSpawnRound, goldenFile: "subagent-spawn-round.trace.json" },
  { name: "subagent-permission-round", trace: traceWinterSubagentPermissionRound, goldenFile: "subagent-permission-round.trace.json" },
  { name: "sendmessage-child-round", trace: traceWinterSendMessageToChildRound, goldenFile: "sendmessage-child-round.trace.json" },
  { name: "messaging-facet-round", trace: traceWinterMessagingFacetRound, goldenFile: "messaging-facet-round.trace.json" },
  // Phase 5 Task 8: five new goldens, one per deterministic P5 family -- see each trace function's
  // own header for its scope, and the block header above for why the workflow and checkpoint rounds
  // are proved cross-leg instead of frozen here.
  { name: "compaction-auto-round", trace: traceWinterCompactionAutoRound, goldenFile: "compaction-auto-round.trace.json" },
  { name: "compaction-manual-round", trace: traceWinterCompactionManualRound, goldenFile: "compaction-manual-round.trace.json" },
  { name: "structured-output-round", trace: traceWinterStructuredOutputRound, goldenFile: "structured-output-round.trace.json" },
  { name: "structured-exhaustion-round", trace: traceWinterStructuredExhaustionRound, goldenFile: "structured-exhaustion-round.trace.json" },
  { name: "skill-invocation-round", trace: traceWinterSkillInvocationRound, goldenFile: "skill-invocation-round.trace.json" },
  // Phase 6 Task 10: one golden per shipped protocol FAMILY, each a real adapter driven against the
  // shared loopback fake. Four families, four wire mappings, four frozen frame streams.
  { name: "p6-anthropic-fake", trace: () => traceProviderScenario("p6-anthropic", SCENARIO_MODELS.anthropic), goldenFile: "p6-anthropic-fake.trace.json" },
  { name: "p6-openai-responses-fake", trace: () => traceProviderScenario("p6-openai-responses", SCENARIO_MODELS.openaiResponses), goldenFile: "p6-openai-responses-fake.trace.json" },
  { name: "p6-openai-chat-fake", trace: () => traceProviderScenario("p6-openai-chat", SCENARIO_MODELS.openaiChat), goldenFile: "p6-openai-chat-fake.trace.json" },
  { name: "p6-gemini-fake", trace: () => traceProviderScenario("p6-gemini", SCENARIO_MODELS.gemini), goldenFile: "p6-gemini-fake.trace.json" },
  // Review round 1 (Critical A): the RESOLUTION-FAILURE shape, byte-frozen. This is the golden that
  // makes the ruling durable -- an init frame with no `winter_provider`, then R6-F's result with
  // `api_error_status: null`. A regression back to "refuse at construction" produces zero frames and
  // cannot match it.
  { name: "p6-resolution-failure", trace: traceWinterResolutionFailure, goldenFile: "p6-resolution-failure.trace.json" },
];

// --- Phase 6 Task 10: the provider-layer goldens -------------------------------------------------
//
// The BYTE-FROZEN half of the equivalence scenarios. `transport-equivalence.test.ts` proves the same
// choreographies are identical ACROSS transports; these freeze what one of them actually looks like,
// which is the only thing that catches a change every leg makes together.
//
// DETERMINISTIC DESPITE A LIVE SERVER, and that is worth stating because it is not obvious: the fake
// binds an EPHEMERAL port, but nothing about the port reaches the frame stream — the base URL is
// configuration, not output. What does reach it is the init frame's `model` (the caller's own string),
// the `winter_provider` identity block (catalog data), the assistant blocks and the tool result — all
// fixed. The tool's own pattern matches nothing in any checkout, so its result is the empty string on
// every machine.
async function traceProviderScenario(name: string, model: string): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), `winter-differential-${name}-`));
  const fake = await startScenarioFake();
  try {
    const entries: ConformanceTraceEntry[] = [];
    let seq = 0;
    for await (const msg of query({
      prompt: "run the provider scenario",
      options: {
        model,
        cwd: FIXTURE_CWD,
        // A USER endpoint (R6-11), declared local because plain http to a loopback address is
        // otherwise refused. `inline` because a golden may never touch a real credential store.
        provider: { providerId: model.slice(0, model.indexOf("/")), authRef: { kind: "inline", value: "test" }, connection: { baseUrl: fake.url, local: true } },
        allowedTools: [SCENARIO_TOOL_NAME],
        // `undefined` tools -> the REAL registry-backed executor, which is what every spawned leg
        // uses. `stubExecutor` here would freeze an echo instead of the tool the scenario ran.
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, undefined, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      const kind = msg.type === "system" ? `system/${(msg as { subtype: string }).subtype}` : msg.type;
      entries.push({ sequence: seq++, direction: "runtime-to-host", kind, payload: msg });
    }
    // Gemini mints its own call ids (its wire carries none), so they are per-run by construction.
    const scrubbed = JSON.parse(JSON.stringify(scrubWinterHome(entries, winterHome)).replace(/google-call-[0-9a-f]+-\d+/g, "google-call-SCRUBBED")) as ConformanceTraceEntry[];
    return normalizeTrace(scrubbed);
  } finally {
    await fake.close();
    rmSync(winterHome, { recursive: true, force: true });
  }
}

/**
 * The RESOLUTION-FAILURE shape (review round 1, Critical A).
 *
 * NO FAKE IS STARTED, and that is part of the claim: a model no catalog contains cannot produce a
 * request, so there is nothing for a server to receive. What the host gets instead is a session that
 * started (`system/init`, carrying the model the caller passed and NO `winter_provider`) and a first
 * generation that lands on R6-F's pinned failure shape with `api_error_status: null`.
 */
async function traceWinterResolutionFailure(): Promise<ConformanceTraceEntry[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-differential-p6-resolution-"));
  try {
    const entries: ConformanceTraceEntry[] = [];
    let seq = 0;
    try {
      for await (const msg of query({
        prompt: "resolve me",
        options: {
          model: "anthropic/definitely-not-a-model-t10",
          cwd: FIXTURE_CWD,
          provider: { providerId: "anthropic", authRef: { kind: "inline", value: "test" } },
          spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, undefined, undefined, { ...opts.env, WINTER_HOME: winterHome }),
        },
      })) {
        const kind = msg.type === "system" ? `system/${(msg as { subtype: string }).subtype}` : msg.type;
        entries.push({ sequence: seq++, direction: "runtime-to-host", kind, payload: msg });
      }
    } catch (err) {
      // `query()` throws AFTER yielding the terminal result -- that is the pinned behaviour, so the
      // throw is expected and the FRAMES above are the golden. Rethrowing anything else would hide a
      // real regression behind an expected one.
      if (!(err instanceof ResultError)) throw err;
    }
    return normalizeTrace(scrubWinterHome(entries, winterHome));
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
  }
}

// Sign-off 3 directive (whole-branch review): `--update` turns this script from a comparator into
// checked-in golden-regeneration tooling — the project had none (T11 review F5 closed the loop: an
// earlier "gen-goldens.ts" reference was an ephemeral-editor-view artifact of an earlier session,
// never a real committed file). Writes every scenario's freshly-traced output straight over its
// golden file, UNCONDITIONALLY, with no comparison step at all — a deliberate "last write wins"
// regeneration, not a merge or a diff-and-ask.
//
// Byte format matches the committed goldens EXACTLY: `JSON.stringify(winter, null, 2) + "\n"` —
// verified byte-for-byte against the committed plain-query.trace.json before this flag was written
// (parsing it and re-serializing this exact way round-trips to the identical bytes). `winter` here
// is ALREADY normalizeTrace()'d (every traceWinter* function above returns it pre-normalized) — the
// exact same shape every committed golden already holds serialized, never sortKeysDeep'd (that
// canonicalization is comparison-time-only, per trace.ts's own comment — a committed golden keeps
// whatever key order its producer emitted).
//
// The acceptance test for this flag is behavioral, not a unit test: running `--update` against an
// UNCHANGED runtime must produce a completely EMPTY `git diff --stat` on every golden it touches —
// see the fix-wave report for that proof. The byte-frozen plain-query golden is not specially
// exempted from being rewritten here (an --update run always writes all five) — it only ever stays
// byte-frozen in practice because nothing about its own scenario's traced output has changed.
if (import.meta.main) {
  const update = process.argv.includes("--update");
  let anyFail = false;
  for (const scenario of SCENARIOS) {
    const winter = await scenario.trace();
    const goldenUrl = new URL(`../packages/conformance/goldens/${scenario.goldenFile}`, import.meta.url);
    if (update) {
      writeFileSync(goldenUrl, JSON.stringify(winter, null, 2) + "\n");
      console.log(`differential --update: wrote ${scenario.name} -> ${scenario.goldenFile}`);
      continue;
    }
    const golden = JSON.parse(readFileSync(goldenUrl, "utf8"));
    const diffs = compareTraces(winter, golden);
    if (diffs.length) {
      anyFail = true;
      console.error(`DIFFERENTIAL FAIL (${scenario.name}):\n` + diffs.join("\n"));
    } else {
      console.log(`differential OK: winter ${scenario.name} matches golden`);
    }
  }
  if (anyFail) process.exit(1);
}
