import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, encodeFrame, splitFrames, type RuntimeConfig, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "winter-agent-runtime/testing";
import { testProviderByName } from "winter-agent-runtime";
import { normalizeTrace, compareTraces, type ConformanceTraceEntry } from "winter-conformance/trace";

// A pinned, synthetic cwd (never process.cwd()) so every recorded trace — and the committed golden
// compared against it — is byte-identical across machines and CI runners, whose checkout paths
// differ. The in-memory runtime never touches the filesystem with it (WS-17 §4: differential
// traces must be deterministic). Shared by every scenario below, not just the original plain-query
// one, for the same reason.
const FIXTURE_CWD = "/winter-fixture";
const FIXTURE_MODEL = "sonnet";

function kindOf(msg: { type: string; subtype?: string }): string {
  return msg.type === "system" ? `system/${msg.subtype}` : msg.type;
}

export async function traceWinterPlainQuery(): Promise<ConformanceTraceEntry[]> {
  const entries: ConformanceTraceEntry[] = [];
  let seq = 0;
  // cwd is pinned to a synthetic constant (never process.cwd()'s default) so the recorded trace —
  // and the committed golden compared against it — is byte-identical across machines and CI
  // runners, whose checkout paths differ. The in-memory runtime never touches the filesystem with
  // it (WS-17 §4: differential traces must be deterministic).
  for await (const msg of query({
    prompt: "hi",
    options: { model: "sonnet", cwd: "/winter-fixture", spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args) },
  })) {
    const kind = msg.type === "system" ? `system/${(msg as { subtype: string }).subtype}` : msg.type;
    entries.push({ sequence: seq++, direction: "runtime-to-host", kind, payload: msg });
  }
  return normalizeTrace(entries);
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
    return normalizeTrace(entries);
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
    return normalizeTrace(entries);
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
    return normalizeTrace(entries);
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

    return normalizeTrace(entries);
  } finally {
    proc.kill();
    await proc.exited;
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

    return normalizeTrace(entries);
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
];

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
