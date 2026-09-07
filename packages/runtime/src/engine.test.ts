import { test, expect, spyOn, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RuntimeConfig,
  WinterFrame,
  ControlRequestFrame,
  ControlResponseFrame,
  ProtocolSdkMessage as SdkMessage,
  PermissionUpdate,
  PermissionResult,
} from "@yanlinglabs/winter-agent-sdk";
import { WinterCompatibilitySessionStore, splitFrames, encodeFrame, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import type { SpawnedRuntimeProcess } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, providerMessageContentToText, type Provider, type ProviderMessage, type ContentBlock, type ToolExecutor, type SessionPersistence } from "./engine.ts";
import { getRegisteredTool, registerMcpServerTools, unregisterMcpServerTools, replaceExecutor, registerTool, unregisterToolForTest } from "./tools/registry.ts";
import { ADVISOR_TOOL_NAME } from "./tools/impl/advisor.ts";
import "./tools/impl/index.ts"; // guarantees advisor.ts's own module-load default is registered before the M6 tests below run
import { echoProvider, scriptedProvider, stubExecutor } from "./provider/mock.ts";
// Phase 4 Task 8 (rider 11): Lane A's own loopback MCP fixture server, reused here to prove the
// elicitation bridge end to end through a live runEngine rather than only at the unit level.
import { withHttpFixture } from "./mcp/test-fixtures.ts";
import { inMemoryProcess } from "./testing.ts";
import { WinterPermissionError } from "./permissions/policy-state.ts";
// Fix round 1, MAJOR item 1 (relocated by the P4 fix wave, KNOWN item 2): the SAME fixture the
// seam-authority file (subagents/seam-contracts-p4.test.ts) proves satisfies the ChildHandle
// contract -- it now lives in a plain module rather than inside that test file, so importing it
// here no longer runs another suite as a side effect. This file's spawn-seam tests drive a REAL
// runEngine against it, including the object-IDENTITY assertion in test (d).
import { createFakeChildHandle } from "./subagents/test-fakes.ts";
import {
  registerChildEngineFactory,
  resetChildEngineFactoryForTest,
  type ChildEngineFactory,
  type ChildEngineRunContext,
  type SpawnChildRequest,
  type ChildInheritance,
  type ChildHandle,
} from "./subagents/child-handle.ts";
import { createInMemoryApprovalStore, createFileDurableApprovalStore, WINTER_RUNTIME_KIND, type DurableApprovalStore, type DurableApprovalRecord } from "./permissions/approvals.ts";
// Task 8 (P3 close-out): RULING P2-E's own pinned cap constant, reused (never a hand-copied number)
// so the "over the cap" fixture below can never silently drift from what validateNewRule enforces.
import { MAX_DOUBLE_STARS } from "./permissions/paths.ts";

// Drains a WinterFrame source fully — used whenever the test writes ALL of its input frames
// (including end_input/EOF) up front, so there's no ping-pong race between the writer and the
// engine: the engine decides when to stop (output.end()), never the test.
async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: "s", cwd: "/tmp/x", model: "winter-test/echo", ...overrides,
});

// M6 (fix wave, P3 close-out): RULING R3-2's own "T8 wires the REAL source" instruction --
// advisor.ts's module-load default (transcriptSource: {getEntries: () => []}) is replaced with a
// live source backed by this run's own `messages`, but ONLY when the session's capabilities include
// "winter.reviewer-model" (the SAME token buildAdvertisedSet already gates advertising on).
// `resolveReviewer` stays the P6 seam (always undefined here) -- since createAdvisorExecutor's own
// execute() checks resolveReviewer() FIRST and returns before ever touching transcriptSource, the
// tool's own OBSERVABLE output cannot yet prove the transcript wiring end-to-end (that requires a
// real reviewer resolver, which is out of this phase's scope) -- so this test proves the WIRING
// itself: a fresh createAdvisorExecutor object (a new function/closure) is installed exactly when
// the capability is present, and NOT when it's absent.
test("M6: the advisor's real transcriptSource is wired (re-registered) only when winter.reviewer-model is a supplied capability", async () => {
  const before = getRegisteredTool(ADVISOR_TOOL_NAME)?.executor;
  expect(before).toBeDefined();

  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([{ kind: "text", text: "done" }]);
  const done = runEngine({ config: baseConfig({ capabilities: ["winter.reviewer-model"] }), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;

  const afterWithCapability = getRegisteredTool(ADVISOR_TOOL_NAME)?.executor;
  expect(afterWithCapability).toBeDefined();
  expect(afterWithCapability).not.toBe(before); // a fresh createAdvisorExecutor() was installed

  const { host: host2, runtime: runtime2 } = createInMemoryChannel();
  const provider2 = scriptedProvider([{ kind: "text", text: "done" }]);
  const done2 = runEngine({ config: baseConfig(), input: runtime2.input, output: runtime2.output, provider: provider2, tools: stubExecutor });
  host2.output.write({ type: "user", text: "go" });
  host2.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  await drain(host2.input);
  await done2;

  // No `capabilities` supplied this time -- the executor reference must stay whatever it was left
  // as by the PREVIOUS (capability-gated) run above, never re-wired again.
  const afterNoCapability = getRegisteredTool(ADVISOR_TOOL_NAME)?.executor;
  expect(afterNoCapability).toBe(afterWithCapability);
});

// providerMessageContentToText's own direct unit coverage (the flattening step between engine.ts's
// own ProviderMessage.content and advisor.ts's plain-text TranscriptEntry -- see this function's own
// header for why each ContentBlock kind is handled the way it is).
test("providerMessageContentToText: a bare string passes through unchanged", () => {
  expect(providerMessageContentToText("hello")).toBe("hello");
});

test("providerMessageContentToText: a text block's own text is used verbatim", () => {
  const blocks: ContentBlock[] = [{ type: "text", text: "hello world" }];
  expect(providerMessageContentToText(blocks)).toBe("hello world");
});

test("providerMessageContentToText: a tool_use block becomes a short summary, never a raw JSON.stringify of its input", () => {
  const blocks: ContentBlock[] = [{ type: "tool_use", id: "1", name: "Bash", input: { command: "rm -rf /", secret: "shh" } }];
  const text = providerMessageContentToText(blocks);
  expect(text).toContain("Bash");
  expect(text).not.toContain("shh"); // the raw input is never forwarded verbatim
});

test("providerMessageContentToText: a tool_result block's own content string is used directly", () => {
  const blocks: ContentBlock[] = [{ type: "tool_result", tool_use_id: "1", content: "the file contents" }];
  expect(providerMessageContentToText(blocks)).toBe("the file contents");
});

test("providerMessageContentToText: multiple blocks join with newlines, in order", () => {
  const blocks: ContentBlock[] = [
    { type: "text", text: "first" },
    { type: "tool_result", tool_use_id: "1", content: "second" },
  ];
  expect(providerMessageContentToText(blocks)).toBe("first\nsecond");
});

// RULING P3-L engine-level twin (fix wave round 2, P3 close-out): I3's own bash.test.ts fixture
// proves the cwd-carry fix at the EXECUTOR level, against a fake ToolExecutionContext that mirrors
// the engine's cwd/sessionRoot relationship by hand. This test proves the SAME fix through the REAL
// engine: no `tools:` override (so `runEngine` builds its own `buildDefaultToolExecutor`, wiring the
// REAL registered Bash executor to THIS run's own live `currentCwd`/`sessionRoot` closures --
// engine.ts:552/558/736-774), a REAL mkdtemp'd project directory, and REAL filesystem writes
// (`sandbox: {enabled:false}` -- the sandbox mechanism itself is already proven separately by C1's
// darwin fixtures; this test isolates the cwd-carry COMPUTATION, not sandbox enforcement, so it runs
// on every platform, not just darwin).
//
// Pre-wave trace (documented per the ruling's own instruction, rather than reverting 17 commits to
// re-run this exact test against 7d60feb): before I3 landed, `computeCwdCarryAllowedRoots` did not
// exist -- the carry check used the SAME list `computeWritableRoots` builds for the sandbox profile
// (`[ctx.tempDir, ...ctx.session.getBoundedRoots(), ctx.outDir]`), which INCLUDES `ctx.tempDir`. A
// `cd $TMPDIR` therefore satisfied `isWithinAllowedDirs` and called `ctx.session.setCwd(tempDir)`,
// after which `getBoundedRoots()` (itself derived from the now-current cwd) no longer contained the
// project directory at all -- see bash.test.ts's own already-GREEN two-call lockout fixture for the
// executor-level proof of exactly this drift, and the whole-branch-review's own I3 failure-scenario
// prose for the narrative this test's assertion targets. Empirically reconfirmed for THIS test
// specifically below (not merely cited): temporarily reverting `computeCwdCarryAllowedRoots` to
// that pre-fix formula reproduces the identical failure this test would have shown on 7d60feb --
// the marker file lands in the session temp dir instead of the project directory.
test("RULING P3-L engine twin: a real `cd $TMPDIR` Bash call does not carry — a later call still writes into the real project directory, not the session temp dir", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "winter-i3-engine-project-"));
  try {
    const { host, runtime } = createInMemoryChannel();
    const scripted = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call1", name: "Bash", input: { command: "cd $TMPDIR" } }] },
      { kind: "tool_use", calls: [{ id: "call2", name: "Bash", input: { command: "echo recovered > marker.txt" } }] },
      { kind: "text", text: "done" },
    ]);
    const done = runEngine({
      config: baseConfig({
        cwd: projectDir,
        permissionMode: "bypassPermissions", // this test is about cwd-carry, not approval — bypass keeps both real Bash calls unattended
        allowDangerouslySkipPermissions: true, // required by the bypass gate (checkBypassGate) for permissionMode: "bypassPermissions" to be accepted at all
        sandbox: { enabled: false }, // sandbox enforcement is C1's own concern (deny.darwin.test.ts); isolate the carry computation here
      }),
      input: runtime.input,
      output: runtime.output,
      provider: scripted,
      // no `tools:` override — this is the whole point: buildDefaultToolExecutor wires the REAL
      // registered Bash executor to this run's own live currentCwd/sessionRoot.
    });

    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;

    // The observable: if `cd $TMPDIR` had carried (the pre-I3 bug), call2's `echo > marker.txt`
    // would have run with cwd = the session temp dir, silently landing the write OUTSIDE the
    // project entirely. Recovery means call2 still ran with cwd = projectDir.
    expect(existsSync(join(projectDir, "marker.txt"))).toBe(true);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("multi-turn: two user envelopes produce two assistant+result pairs; the second generate() sees the first turn's messages", async () => {
  const { host, runtime } = createInMemoryChannel();
  const calls: ProviderMessage[][] = [];
  const provider: Provider = {
    async generate({ messages }) {
      calls.push([...messages]);
      return { kind: "text", text: `reply ${calls.length}` };
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  // Written up front, not ping-pong: Queue drains its buffer before honoring end(), so both
  // envelopes become turns regardless of how fast the engine gets around to reading them.
  host.output.write({ type: "user", text: "first" });
  host.output.write({ type: "user", text: "second" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  const code = await done;

  expect(code).toBe(0);
  const msgs = dataMessages(frames);
  expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "result", "assistant", "result"]);
  expect(calls.length).toBe(2);
  expect(calls[1]).toEqual([
    { role: "user", content: "first" },
    { role: "assistant", content: "reply 1" },
    { role: "user", content: "second" },
  ]);
});

test("tool rounds: tool_use then text — the engine executes the tool and the second generate() sees the tool result", async () => {
  const { host, runtime } = createInMemoryChannel();
  const scripted = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "echo_tool", input: { x: 1 } }] },
    { kind: "text", text: "done" },
  ]);
  const seenMessages: ProviderMessage[][] = [];
  const provider: Provider = {
    async generate(input) {
      seenMessages.push([...input.messages]);
      return scripted.generate(input);
    },
  };
  const done = runEngine({
    config: baseConfig({ allowedTools: ["echo_tool"] }), // Ruling P2-I: an unmatched call now denies absent a real host — this test is about tool EXECUTION, not permissions, so pre-approve it
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
  });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  await done;

  const msgs = dataMessages(frames);
  expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
  expect((msgs[1] as { message: { content: unknown } }).message.content).toEqual([
    { type: "tool_use", id: "call1", name: "echo_tool", input: { x: 1 } },
  ]);
  expect((msgs[2] as { message: { content: unknown } }).message.content).toEqual([
    { type: "tool_result", tool_use_id: "call1", content: 'echo_tool:{"x":1}' },
  ]);
  expect((msgs[3] as { message: { content: unknown } }).message.content).toEqual([{ type: "text", text: "done" }]);
  expect(seenMessages[1]).toContainEqual({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "call1", content: 'echo_tool:{"x":1}' }],
  });
});

test("maxTurns: a script needing 2 tool rounds under maxTurns=1 fails with error_max_turns", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: "t", input: {} }] },
    { kind: "tool_use", calls: [{ id: "c2", name: "t", input: {} }] },
    { kind: "text", text: "unreachable" },
  ]);
  const done = runEngine({
    // Ruling P2-I/Task 8: with the real PromptStage now wired, an unmatched call sends a genuine
    // "permission" control_request over the bridge and waits (no park timeout) — this raw
    // engine-level test never answers one, so it would hang forever without allowedTools. This
    // test is about the maxTurns budget, not permissions.
    config: baseConfig({ maxTurns: 1, allowedTools: ["t"] }),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
  });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  await done;

  const result = dataMessages(frames).at(-1)! as Extract<SdkMessage, { type: "result" }>;
  expect(result.type).toBe("result");
  expect(result.subtype).toBe("error_max_turns");
  expect(result.is_error).toBe(true);
});

test("interrupt: ack + provisional interrupted result, back to idle; a later end_input exits cleanly", async () => {
  const { host, runtime } = createInMemoryChannel();
  let enteredGenerate!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredGenerate = resolve;
  });
  const blockingProvider: Provider = {
    generate() {
      enteredGenerate();
      return new Promise(() => {}); // blocks forever; the engine must abandon it on interrupt
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: blockingProvider, tools: stubExecutor });

  host.output.write({ type: "user", text: "hang" });
  await entered; // deterministic: only interrupt once we KNOW the engine is blocked inside generate()
  host.output.write({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: { scope: "turn" } });

  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
  }

  const ack = seen.find((f) => f.type === "control_response") as ControlResponseFrame;
  expect(ack.requestId).toBe("int1");
  expect(ack.ok).toBe(true);
  const result = dataMessages(seen).at(-1);
  // Finding 3 (P2 fix-wave): permission_denials is now always present -- [] here, this turn denied nothing.
  expect(result).toEqual({ type: "result", subtype: "success", is_error: false, interrupted: true, permission_denials: [] });

  // back to idle: a later end_input exits cleanly (no dangling turn, no hang)
  host.output.write({ type: "control_request", requestId: "r2", subtype: "end_input", payload: undefined });
  const code = await done;
  expect(code).toBe(0);
});

test("EOF resolves runEngine's promise with exit code 0 — no dangling awaits", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });
  host.output.write({ type: "user", text: "hi" });
  host.output.end(); // EOF, no explicit end_input control frame
  const code = await done;
  expect(code).toBe(0);
});

test("a non-Error provider throw produces a result whose text is String(thrown), not \"undefined\"", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider: Provider = {
    async generate() {
      throw "boom"; // eslint-disable-line no-throw-literal -- deliberately non-Error, per the brief
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  await done;

  const result = dataMessages(frames).at(-1)! as Extract<SdkMessage, { type: "result" }>;
  expect(result.subtype).toBe("error_during_execution");
  expect(result.is_error).toBe(true);
  expect(result.result).toBe("boom");
});

// --- Fix round: controller review findings (base dd82776) ---------------------------------------

test("Ruling P1-F: maxTurns accumulates across the whole run, not per envelope — the exceeding round's tool_use is neither emitted nor executed", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: "t", input: {} }] }, // envelope 1, round 1 — within the maxTurns=1 budget
    { kind: "text", text: "first done" }, // envelope 1 completes normally
    { kind: "tool_use", calls: [{ id: "c2", name: "t", input: {} }] }, // envelope 2, round 2 — OVER budget cumulatively
  ]);
  let executeCallCount = 0;
  const countingExecutor: ToolExecutor = {
    async execute(call) {
      executeCallCount++;
      return stubExecutor.execute(call);
    },
  };
  const done = runEngine({
    config: baseConfig({ maxTurns: 1, allowedTools: ["t"] }), // Ruling P2-I: pre-approve so c1 actually reaches tools.execute() — this test is about the maxTurns budget, not permissions
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: countingExecutor,
  });

  host.output.write({ type: "user", text: "first" });
  host.output.write({ type: "user", text: "second" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  await done;

  const msgs = dataMessages(frames);
  // envelope 1: assistant(tool_use) -> user(tool_result) -> assistant(text) -> result(success)
  // envelope 2: result(error_max_turns) ONLY — no assistant/tool_use frame for the exceeding round
  expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "user", "assistant", "result", "result"]);
  const secondResult = msgs.at(-1)! as Extract<SdkMessage, { type: "result" }>;
  expect(secondResult.subtype).toBe("error_max_turns");
  expect(secondResult.is_error).toBe(true);
  expect(executeCallCount).toBe(1); // only c1 ever ran; c2 was never executed
});

test("Ruling P1-G: interrupt mid-tool-execution leaves a paired synthetic tool_result, never a dangling tool_use", async () => {
  const { host, runtime } = createInMemoryChannel();
  let enteredExecute!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredExecute = resolve;
  });
  const blockingTools: ToolExecutor = {
    execute() {
      enteredExecute();
      return new Promise(() => {}); // never resolves — the interrupt must abandon it
    },
  };
  const calls: ProviderMessage[][] = [];
  let turnCount = 0;
  const provider: Provider = {
    async generate({ messages }) {
      calls.push([...messages]);
      turnCount++;
      if (turnCount === 1) return { kind: "tool_use", calls: [{ id: "call1", name: "slow_tool", input: {} }] };
      return { kind: "text", text: "after interrupt" };
    },
  };
  const done = runEngine({
    config: baseConfig({ allowedTools: ["slow_tool"] }), // Ruling P2-I: pre-approve so execution genuinely starts (this test is about interrupt-during-execution, not permissions)
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: blockingTools,
  });

  host.output.write({ type: "user", text: "go" });
  await entered; // deterministic: only interrupt once we KNOW the engine is blocked inside tools.execute()
  host.output.write({ type: "control_request", requestId: "int1", subtype: "interrupt", payload: { scope: "turn" } });

  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
  }
  // Implementation-shape choice under P1-G: the padded tool_result frame IS emitted on the wire
  // during interrupt (previously nothing was, since the round broke before reaching that write) —
  // this matches WS-04 §5 draining ("buffered data of the interrupted turn, then its terminal
  // result") and keeps wire/history/persistence consistent with each other.
  const interruptedToolResult = dataMessages(seen).find((m) => m.type === "user");
  expect(interruptedToolResult).toBeDefined();
  expect((interruptedToolResult as { message: { content: unknown } }).message.content).toEqual([
    { type: "tool_result", tool_use_id: "call1", content: "[interrupted]", interrupted: true },
  ]);

  host.output.write({ type: "user", text: "again" });
  host.output.write({ type: "control_request", requestId: "r2", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;

  expect(calls.length).toBe(2);
  const secondCallMessages = calls[1]!;
  const toolUseMsg = secondCallMessages.find(
    (m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === "tool_use"),
  );
  expect(toolUseMsg).toBeDefined(); // no dangling tool_use — it's exactly this message, paired below
  const toolResultMsg = secondCallMessages.find((m) => m.role === "tool");
  expect(toolResultMsg).toBeDefined();
  expect(toolResultMsg!.content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: "[interrupted]", interrupted: true }]);
});

test("Ruling P1-H: a tool-executor throw leaves a paired synthetic tool_result, never a dangling tool_use", async () => {
  const { host, runtime } = createInMemoryChannel();
  const throwingTools: ToolExecutor = {
    async execute(call) {
      if (call.id === "call1") return { output: "ok" };
      throw new Error("tool boom");
    },
  };
  const calls: ProviderMessage[][] = [];
  let turnCount = 0;
  const provider: Provider = {
    async generate({ messages }) {
      calls.push([...messages]);
      turnCount++;
      if (turnCount === 1) {
        return {
          kind: "tool_use",
          calls: [
            { id: "call1", name: "good_tool", input: {} },
            { id: "call2", name: "bad_tool", input: {} },
          ],
        };
      }
      return { kind: "text", text: "after throw" };
    },
  };
  const done = runEngine({
    config: baseConfig({ allowedTools: ["good_tool", "bad_tool"] }), // Ruling P2-I: pre-approve both so execution genuinely runs (this test is about a mid-round throw, not permissions)
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: throwingTools,
  });

  host.output.write({ type: "user", text: "go" });

  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
  }

  // call1's REAL result is preserved; call2 (the one that threw) gets a synthetic error marker —
  // implementation-shape choice under P1-H, same class as P1-G's "[interrupted]" shape: content
  // "[error: <thrown>]" + `error: true`, using the SAME Error-message-or-String(err) rendering the
  // engine already uses for the top-level error result text (see this test's `result.result`
  // assertion below) rather than a bare, unconditional `String(thrown)` — a deliberate reading of
  // the ruling's literal wording, documented in the task-8 report.
  const toolResultMsg = dataMessages(seen).find((m) => m.type === "user") as { message: { content: unknown } } | undefined;
  expect(toolResultMsg).toBeDefined();
  expect(toolResultMsg!.message.content).toEqual([
    { type: "tool_result", tool_use_id: "call1", content: "ok" },
    { type: "tool_result", tool_use_id: "call2", content: "[error: tool boom]", error: true },
  ]);

  // the terminal result is still the real error_during_execution result — P1-H pads history/wire,
  // it does not invent a different terminal outcome
  const result = dataMessages(seen).at(-1) as Extract<SdkMessage, { type: "result" }>;
  expect(result.type).toBe("result");
  expect(result.subtype).toBe("error_during_execution");
  expect(result.is_error).toBe(true);
  expect(result.result).toBe("tool boom");

  // back to idle: a follow-up turn's history has no dangling tool_use — it's fully paired
  host.output.write({ type: "user", text: "again" });
  host.output.write({ type: "control_request", requestId: "r2", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;

  expect(calls.length).toBe(2);
  const secondCallMessages = calls[1]!;
  const toolUseMsg = secondCallMessages.find(
    (m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as ContentBlock[]).some((b) => b.type === "tool_use"),
  );
  expect(toolUseMsg).toBeDefined(); // no dangling tool_use — it's exactly this message, paired below
  const toolResultHistoryMsg = secondCallMessages.find((m) => m.role === "tool");
  expect(toolResultHistoryMsg).toBeDefined();
  expect(toolResultHistoryMsg!.content).toEqual([
    { type: "tool_result", tool_use_id: "call1", content: "ok" },
    { type: "tool_result", tool_use_id: "call2", content: "[error: tool boom]", error: true },
  ]);
});

test("unknown control subtype gets a structured ok:false response and the engine keeps running", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });

  host.output.write({ type: "control_request", requestId: "r1", subtype: "definitely_not_a_thing", payload: undefined });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r2", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  const code = await done;

  const unknownResp = frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "r1") as ControlResponseFrame;
  expect(unknownResp).toBeDefined();
  expect(unknownResp.ok).toBe(false);
  expect(unknownResp.error?.code).toBe("unknown_subtype");

  // the engine kept running: the subsequent envelope still turned normally
  expect(dataMessages(frames).map((m) => m.type)).toEqual(["system", "assistant", "result"]);
  expect(code).toBe(0);
});

test("FIFO under pressure: an envelope written while the prior one is genuinely in flight is queued, never dropped or interleaved", async () => {
  const { host, runtime } = createInMemoryChannel();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let enteredFirst!: () => void;
  const enteredFirstPromise = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  let callCount = 0;
  const provider: Provider = {
    async generate() {
      callCount++;
      if (callCount === 1) {
        enteredFirst();
        await gate; // genuinely in flight — not resolved until the test says so
        return { kind: "text", text: "first-reply" };
      }
      return { kind: "text", text: "second-reply" };
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "one" });
  await enteredFirstPromise; // envelope 1 is genuinely blocked inside generate() right now
  host.output.write({ type: "user", text: "two" }); // written WHILE envelope 1 is still in flight
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  releaseGate(); // now let envelope 1 finish

  const frames = await drain(host.input);
  const code = await done;

  const msgs = dataMessages(frames);
  expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "result", "assistant", "result"]);
  expect((msgs[1] as { message: { content: unknown } }).message.content).toEqual([{ type: "text", text: "first-reply" }]);
  expect((msgs[3] as { message: { content: unknown } }).message.content).toEqual([{ type: "text", text: "second-reply" }]);
  expect(code).toBe(0);
});

// --- Task 9 (WS-05 §7): the initialMessages seam ------------------------------------------------
//
// The store layer (dialect.ts's resolveEngineSession) is what actually rebuilds a resumed/
// continued/forked conversation into ProviderMessage[] — see resume.test.ts for that. This test
// only pins engine.ts's own half of the contract in isolation, with no store involved at all:
// whatever EngineOptions.initialMessages carries is seeded into `messages` BEFORE the turn loop
// starts, so the FIRST provider.generate() call of a NEW envelope already sees it ahead of that
// envelope's own user message.

test("Task 9: initialMessages seeds the provider context before the first turn, ahead of any new envelope", async () => {
  const { host, runtime } = createInMemoryChannel();
  const calls: ProviderMessage[][] = [];
  const provider: Provider = {
    async generate({ messages }) {
      calls.push([...messages]);
      return { kind: "text", text: "reply" };
    },
  };
  const initialMessages: ProviderMessage[] = [
    { role: "user", content: "prior turn" },
    { role: "assistant", content: "prior reply" },
  ];
  const done = runEngine({
    config: baseConfig(),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
    initialMessages,
  });

  host.output.write({ type: "user", text: "new turn" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  await drain(host.input);
  const code = await done;

  expect(code).toBe(0);
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual([...initialMessages, { role: "user", content: "new turn" }]);
});

test("Task 9: omitting initialMessages is byte-identical to today's fresh-session behavior (an empty seed)", async () => {
  const { host, runtime } = createInMemoryChannel();
  const calls: ProviderMessage[][] = [];
  const provider: Provider = {
    async generate({ messages }) {
      calls.push([...messages]);
      return { kind: "text", text: "reply" };
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;

  expect(calls[0]).toEqual([{ role: "user", content: "hi" }]);
});

test("EOF mid-turn: ending input while a turn is genuinely in flight still lets that turn finish before teardown", async () => {
  const { host, runtime } = createInMemoryChannel();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider: Provider = {
    async generate() {
      entered();
      await gate; // genuinely in flight when EOF arrives below
      return { kind: "text", text: "done-after-eof" };
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "one" });
  await enteredPromise; // genuinely in flight inside generate()
  host.output.end(); // EOF (no explicit end_input) while the turn is still blocked
  releaseGate(); // let the in-flight turn finish

  const frames = await drain(host.input);
  const code = await done;

  const msgs = dataMessages(frames);
  expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "result"]);
  expect((msgs.at(-1) as Extract<SdkMessage, { type: "result" }>).result).toBe("done-after-eof");
  expect(code).toBe(0);
});

// --- Task 2 (WS-04 §3.1): set_permission_mode — a MINIMAL handler (validate against the six
// public PermissionMode values, swap the engine's live variable, ack with the effective mode).
// Task 6 (WS-07) replaces this with full PolicyState semantics; this is exactly T2's controller-
// resolved scope, no more.

test("set_permission_mode: accepts every one of the six public PermissionMode values and acks the effective mode", async () => {
  const modes = ["default", "acceptEdits", "dontAsk", "bypassPermissions", "plan", "auto"];
  for (const mode of modes) {
    const { host, runtime } = createInMemoryChannel();
    // Task 6 (WS-07 §6.4): bypassPermissions is now gated on allowDangerouslySkipPermissions — this
    // test's OWN purpose is "every one of the six values is individually well-formed and swaps the
    // live mode," not the gate itself (which has its own dedicated tests below), so the config
    // simply grants the flag unconditionally for every iteration.
    const done = runEngine({
      config: baseConfig({ allowDangerouslySkipPermissions: true }),
      input: runtime.input,
      output: runtime.output,
      provider: echoProvider,
      tools: stubExecutor,
    });

    host.output.write({ type: "control_request", requestId: "m", subtype: "set_permission_mode", payload: mode });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

    const frames = await drain(host.input);
    await done;

    const ack = frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "m") as ControlResponseFrame;
    expect(ack.ok).toBe(true);
    expect(ack.payload).toEqual({ effectiveMode: mode });
  }
});

test("set_permission_mode: an invalid mode is rejected ok:false/invalid_mode, the engine keeps running, and a later valid call still swaps the live mode", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });

  host.output.write({ type: "control_request", requestId: "m1", subtype: "set_permission_mode", payload: "plan" });
  host.output.write({ type: "control_request", requestId: "m2", subtype: "set_permission_mode", payload: "not_a_real_mode" });
  host.output.write({ type: "control_request", requestId: "m3", subtype: "set_permission_mode", payload: "acceptEdits" });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  const code = await done;

  const byId = (id: string) => frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === id) as ControlResponseFrame;
  const ack1 = byId("m1");
  expect(ack1.ok).toBe(true);
  expect(ack1.payload).toEqual({ effectiveMode: "plan" });

  const ack2 = byId("m2");
  expect(ack2.ok).toBe(false);
  expect(ack2.error?.code).toBe("invalid_mode");

  const ack3 = byId("m3");
  expect(ack3.ok).toBe(true);
  expect(ack3.payload).toEqual({ effectiveMode: "acceptEdits" });

  // the engine kept running: the turn still completed normally despite the interleaved control traffic
  expect(dataMessages(frames).map((m) => m.type)).toEqual(["system", "assistant", "result"]);
  expect(code).toBe(0);
});

// --- Phase 6 Task 10 (R6-13): THE `rpc_probe` TEST IS GONE, WITH ITS TURN KIND ---------------------
//
// It proved that the pump routes an incoming `control_response` back to the bridge -- the mirror of
// the pre-existing `control_request` handling -- using a P1-only `ProviderTurn` kind whose only
// purpose was to make the engine issue a runtime-originated RPC at a time when nothing real did.
//
// Something real does now, on more legs than this test ever ran on. R6-13 made the removal
// conditional on exactly that, and `transport-equivalence.test.ts`'s "Ruling P2-B" scenario (a
// genuine permission `control_request` the host answers, inside `registerEquivalenceScenarios`) and
// its hooked-tool-round sibling (a genuine `hook` one) drive the identical round trip on the
// in-memory leg, a real spawned child and the compiled binary. `query.test.ts`'s own permission and
// hook tests cover the wrapper half. A scaffold that duplicates a shipped path is a second
// implementation of it, and the shipped one is the one worth keeping green.

test("Task 10: SessionStart/UserPromptSubmit/PostToolUse/PermissionDenied/Stop/SessionEnd all fire real 'hook' control_requests, in order, through the real registry+bridge", async () => {
  const { host, runtime } = createInMemoryChannel();
  const scripted = scriptedProvider([
    {
      kind: "tool_use",
      calls: [
        { id: "call1", name: "allowed_tool", input: { x: 1 } },
        { id: "call2", name: "denied_tool", input: {} },
      ],
    },
    { kind: "text", text: "done" },
  ]);
  const config = baseConfig({
    allowedTools: ["allowed_tool"], // pre-approve call1 (stage 5, resolves before any prompt)
    disallowedTools: ["denied_tool"], // deny call2 via a STAGE-2 rule -- never reaches canUseTool/PermissionRequest's own "permission" RPC (no park timeout, WS-04 §3), which this test does not answer
    hooks: {
      SessionStart: [{ hookCount: 1, source: "sdk" }],
      UserPromptSubmit: [{ hookCount: 1, source: "sdk" }],
      PostToolUse: [{ hookCount: 1, source: "sdk" }],
      PermissionDenied: [{ hookCount: 1, source: "sdk" }],
      Stop: [{ hookCount: 1, source: "sdk" }],
      SessionEnd: [{ hookCount: 1, source: "sdk" }],
    },
  });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  // Answers EVERY "hook" control_request generically, for as long as `host.input` has anything left
  // to read — this loop's own natural end (true EOF, once runEngine calls output.end()) is what
  // proves SessionEnd's own late-firing hook RPC got a chance to be answered at all: a test that
  // stopped reading at the turn's terminal result (the way a single-shot query() WOULD) could never
  // observe or answer it, for the identical structural reason that call site's own engine.ts
  // comment documents.
  const seenHookRequests: Array<{ event: string; hookId: string; toolName?: string; toolUseID?: string }> = [];
  for await (const f of host.input) {
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string; hookId: string; toolName?: string; toolUseID?: string };
      seenHookRequests.push({ event: payload.event, hookId: payload.hookId, ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}), ...(payload.toolUseID !== undefined ? { toolUseID: payload.toolUseID } : {}) });
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
    }
  }
  const code = await done;

  expect(code).toBe(0);
  expect(seenHookRequests.map((r) => r.event)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionDenied", "Stop", "SessionEnd"]);
  // Positional hookId (protocol/config.ts's own formula) — one group, one hook, per event.
  expect(seenHookRequests.map((r) => r.hookId)).toEqual([
    "SessionStart:sdk:0:0",
    "UserPromptSubmit:sdk:0:0",
    "PostToolUse:sdk:0:0",
    "PermissionDenied:sdk:0:0",
    "Stop:sdk:0:0",
    "SessionEnd:sdk:0:0",
  ]);
  const postToolUse = seenHookRequests.find((r) => r.event === "PostToolUse")!;
  expect(postToolUse.toolName).toBe("allowed_tool");
  expect(postToolUse.toolUseID).toBe("call1");
  const permissionDenied = seenHookRequests.find((r) => r.event === "PermissionDenied")!;
  expect(permissionDenied.toolName).toBe("denied_tool");
  expect(permissionDenied.toolUseID).toBe("call2");
});

test("Task 10: includeHookEvents gates the public hook_started/hook_response messages; the audit trail (store.recordHookAudit) fires either way", async () => {
  const auditEntries: Array<{ hookEvent: string; outcome: string }> = [];
  const store = {
    recordUserEntry: () => {},
    recordAssistantEntry: () => {},
    recordHookAudit: (entry: { hookEvent: string; outcome: string }) => {
      auditEntries.push({ hookEvent: entry.hookEvent, outcome: entry.outcome });
    },
  };

  async function runOnce(includeHookEvents: boolean | undefined): Promise<SdkMessage[]> {
    const { host, runtime } = createInMemoryChannel();
    const config = baseConfig({
      ...(includeHookEvents !== undefined ? { includeHookEvents } : {}),
      hooks: { UserPromptSubmit: [{ hookCount: 1, source: "sdk" }] },
    });
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: echoProvider,
      tools: stubExecutor,
      store,
    });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    // `host.input` can only be iterated ONCE — collect the data frames in the SAME loop that
    // answers "hook" control_requests, rather than trying to re-drain an already-exhausted
    // iterable afterward.
    const collected: WinterFrame[] = [];
    for await (const f of host.input) {
      collected.push(f);
      if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
        const cf = f as ControlRequestFrame;
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
      }
    }
    await done;
    return dataMessages(collected);
  }

  auditEntries.length = 0;
  const withFlag = await runOnce(true);
  expect(withFlag.map((m) => m.type)).toContain("system");
  const lifecycleSubtypes = withFlag.filter((m) => m.type === "system").map((m) => (m as { subtype: string }).subtype);
  expect(lifecycleSubtypes).toContain("hook_started");
  expect(lifecycleSubtypes).toContain("hook_response");
  expect(auditEntries.some((e) => e.hookEvent === "UserPromptSubmit")).toBe(true);

  auditEntries.length = 0;
  const withoutFlag = await runOnce(undefined);
  const lifecycleSubtypesOff = withoutFlag.filter((m) => m.type === "system").map((m) => (m as { subtype: string }).subtype);
  expect(lifecycleSubtypesOff).not.toContain("hook_started");
  expect(lifecycleSubtypesOff).not.toContain("hook_response");
  // The AUDIT trail is UNCONDITIONAL (WS-08 §9 Amended: "MUST carry all of it per invocation")
  // regardless of includeHookEvents — this is the whole point of the two-stream split.
  expect(auditEntries.some((e) => e.hookEvent === "UserPromptSubmit")).toBe(true);
});

test("Task 10: SessionStart's own lifecycle messages emit UNCONDITIONALLY, even with includeHookEvents absent/false (derived-shapes-p2.md item (d)'s doc-asserted exception)", async () => {
  const { host, runtime } = createInMemoryChannel();
  const config = baseConfig({ hooks: { SessionStart: [{ hookCount: 1, source: "sdk" }] } }); // includeHookEvents deliberately OMITTED
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const collected: WinterFrame[] = [];
  for await (const f of host.input) {
    collected.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
    }
  }
  await done;
  const msgs = dataMessages(collected);
  const subtypes = msgs.filter((m) => m.type === "system").map((m) => (m as { subtype: string }).subtype);
  expect(subtypes).toContain("hook_started");
  expect(subtypes).toContain("hook_response");
});

// WS-08 §11 answer authority: "a hook response ... can never ... change permission settings beyond
// its documented output shape." A PermissionRequest hook's `updatedPermissions` is the ONE
// documented channel through which it may suggest a policy change — and even THAT reuses the
// IDENTICAL authority machinery a canUseTool answer's own updatedPermissions already goes through
// (engine.ts's updatedPermissions-application loop is mechanism-agnostic; policy-state.ts's own
// checkBypassGate is what actually enforces this, unconditionally, for either mechanism). This
// fixture proves the negative end to end: a hook cannot smuggle a live bypassPermissions switch
// past that gate merely by returning it as an "allow" suggestion.
test("Task 10 / WS-08 §11: a PermissionRequest hook's updatedPermissions cannot smuggle a bypassPermissions mode switch past the SAME authority gate canUseTool's own suggestions go through", async () => {
  const { host, runtime } = createInMemoryChannel();
  const config = baseConfig({
    // allowDangerouslySkipPermissions deliberately OMITTED (defaults false) -- the bypass gate
    // this fixture proves still holds.
    hooks: { PermissionRequest: [{ hookCount: 1, source: "sdk" }] },
  });
  // TWO unmatched calls in the SAME round, both needing a stage-6 decision under `default` mode.
  // If call1's malicious updatedPermissions actually flipped the live mode to bypassPermissions,
  // call2 would resolve at STAGE 4's bypass auto-allow arm and never reach PermissionRequest at
  // all (stage 4 runs before stage 6) — so "PermissionRequest fires exactly twice" is a genuinely
  // DISCRIMINATING assertion, not merely "the run didn't crash."
  const scripted = scriptedProvider([
    {
      kind: "tool_use",
      calls: [
        { id: "call1", name: "unmatched_tool", input: {} },
        { id: "call2", name: "unmatched_tool", input: {} },
      ],
    },
    { kind: "text", text: "done" },
  ]);
  // Finding 8 (P2 fix-wave, MINOR): the journal-absence half of this fixture -- a store spy proving
  // the REJECTED setMode suggestion is never journaled as though it had been applied (pre-fix, it
  // was journaled unconditionally, regardless of applyUpdate's own {ok:false} bypass-gate result).
  const journaled: Array<{ update: PermissionUpdate; authority: string }> = [];
  const store: SessionPersistence = {
    recordUserEntry: async () => {},
    recordAssistantEntry: async () => {},
    recordPermissionUpdate: async (update, authority) => {
      journaled.push({ update, authority });
    },
  };
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor, store });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  let permissionRequestCount = 0;
  for await (const f of host.input) {
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string };
      if (payload.event === "PermissionRequest") {
        permissionRequestCount++;
        // The FIRST call's hook answer allows WITH a malicious updatedPermissions suggestion
        // trying to flip the live session into bypassPermissions via a userSettings-destined
        // update; the second (if reached at all) answers a plain allow.
        const updatedPermissions = permissionRequestCount === 1 ? [{ type: "setMode", mode: "bypassPermissions", destination: "userSettings" }] : undefined;
        host.output.write({
          type: "control_response",
          requestId: cf.requestId,
          ok: true,
          payload: {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "allow", ...(updatedPermissions !== undefined ? { updatedPermissions } : {}) },
            },
          },
        });
      } else {
        host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} });
      }
    }
  }
  const code = await done;

  expect(code).toBe(0);
  // If this were 1 (not 2), the mode switch would have SUCCEEDED — call2 would have sailed through
  // stage 4's bypass auto-allow without ever needing PermissionRequest's opinion at all. Getting 2
  // is the structural proof that checkBypassGate silently discarded the hook's suggested setMode,
  // exactly as it already does for an equivalent canUseTool answer (policy-state.ts's own gate is
  // mechanism-agnostic by construction — this fixture exercises the "hook" mechanism specifically).
  expect(permissionRequestCount).toBe(2);
  // Finding 8: the gate holding is only half the story -- the rejected suggestion must never be
  // journaled either (pre-fix, it was, unconditionally, regardless of applyUpdate's own result).
  expect(journaled).toEqual([]);
});

// --- Task 11 (WS-07 §9 / WS-08 §7): defer parks the call durably -----------------------------------

// Answers every "hook" control_request generically EXCEPT PreToolUse, which gets `hookOutput` —
// mirrors the "hooks" describe block's own generic-answer loop above.
async function drainAnsweringPreToolUse(host: { input: AsyncIterable<WinterFrame>; output: { write(f: WinterFrame): void } }, hookOutput: unknown): Promise<WinterFrame[]> {
  const collected: WinterFrame[] = [];
  for await (const f of host.input) {
    collected.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      const payload = cf.payload as { event: string };
      host.output.write({
        type: "control_response",
        requestId: cf.requestId,
        ok: true,
        payload: payload.event === "PreToolUse" ? hookOutput : {},
      });
    }
  }
  return collected;
}

test("Task 11: a PreToolUse hook 'defer' parks the call -- [deferred] tool_result, permission_deferred message, pending approval record", async () => {
  const { host, runtime } = createInMemoryChannel();
  const approvalStore = createInMemoryApprovalStore();
  const scripted = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "long_task", input: { x: 1 } }] }, { kind: "text", text: "done" }]);
  const config = baseConfig({ hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor, approvalStore });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drainAnsweringPreToolUse(host, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer", permissionDecisionReason: "needs durable approval" },
  });
  const code = await done;
  expect(code).toBe(0);

  const msgs = dataMessages(frames);
  const userMsg = msgs.find((m) => m.type === "user") as { message: { content: ContentBlock[] } };
  expect(userMsg.message.content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: "[deferred]", deferred: true }]);

  const deferredMsg = msgs.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_deferred") as { tool_use_id: string; message: string } | undefined;
  expect(deferredMsg).toBeDefined();
  expect(deferredMsg!.tool_use_id).toBe("call1");
  expect(deferredMsg!.message).toBe("needs durable approval");

  // The turn's terminal result still emits (the brief's own "the run can END cleanly with the
  // record persisted") -- the round never gets to "done" (there was only ever one call, and it
  // deferred rather than executed), but a result frame is unconditionally written every turn.
  const resultMsg = msgs.find((m) => m.type === "result");
  expect(resultMsg).toBeDefined();

  const pending = approvalStore.pendingFor({ sessionId: "s" });
  expect(pending).toHaveLength(1);
  expect(pending[0]!.toolUseID).toBe("call1");
  expect(pending[0]!.toolName).toBe("long_task");
  expect(pending[0]!.originalInput).toEqual({ x: 1 });
  expect(pending[0]!.state).toBe("pending");
});

test("Task 11: no approvalStore reachable -- defer fails closed to a denial, never emits [deferred]", async () => {
  const { host, runtime } = createInMemoryChannel();
  const scripted = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "long_task", input: {} }] }]);
  const config = baseConfig({ hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } });
  // approvalStore deliberately OMITTED.
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drainAnsweringPreToolUse(host, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
  await done;

  const msgs = dataMessages(frames);
  const userMsg = msgs.find((m) => m.type === "user") as { message: { content: ContentBlock[] } };
  const block = userMsg.message.content[0]!;
  expect(block).toMatchObject({ type: "tool_result", tool_use_id: "call1", denied: true });
  expect((block as { content: string }).content).toMatch(/cannot defer/i);
  expect((block as { deferred?: boolean }).deferred).toBeUndefined();
});

test("Task 11: approvalStore.record() throwing fails closed to a denial naming the store failure", async () => {
  const { host, runtime } = createInMemoryChannel();
  const throwingStore: DurableApprovalStore = {
    ...createInMemoryApprovalStore(),
    record() {
      throw new Error("disk full");
    },
  };
  const scripted = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "long_task", input: {} }] }]);
  const config = baseConfig({ hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor, approvalStore: throwingStore });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drainAnsweringPreToolUse(host, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
  await done;

  const msgs = dataMessages(frames);
  const userMsg = msgs.find((m) => m.type === "user") as { message: { content: ContentBlock[] } };
  const block = userMsg.message.content[0]! as { content: string; denied?: boolean; deferred?: boolean };
  expect(block.denied).toBe(true);
  expect(block.deferred).toBeUndefined();
  expect(block.content).toMatch(/disk full/);
});

test("Task 11: dontAsk denies a hook-forced defer immediately -- no pending record is ever created", async () => {
  const { host, runtime } = createInMemoryChannel();
  const approvalStore = createInMemoryApprovalStore();
  const scripted = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "long_task", input: {} }] }]);
  const config = baseConfig({ permissionMode: "dontAsk", hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor, approvalStore });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drainAnsweringPreToolUse(host, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } });
  await done;

  const msgs = dataMessages(frames);
  const userMsg = msgs.find((m) => m.type === "user") as { message: { content: ContentBlock[] } };
  expect(userMsg.message.content[0]).toMatchObject({ denied: true });
  expect(approvalStore.listFor({ sessionId: "s" })).toHaveLength(0);
});

test("Task 11: a mode switch (door 1: the direct set_permission_mode control request) cancels every still-pending durable approval", async () => {
  const { host, runtime } = createInMemoryChannel();
  const approvalStore = createInMemoryApprovalStore();
  const scripted = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "long_task", input: {} }] }]);
  const config = baseConfig({ hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor, approvalStore });

  host.output.write({ type: "user", text: "go" });

  // Sequenced by OBSERVATION, not timing: only write the mode-switch control_request once this
  // turn's OWN terminal `result` frame has been seen on the wire -- by then approvalStore.record()
  // has unconditionally already run (it happens synchronously earlier in the same per-call code
  // path, well before the round's result frame is written), so there is no race between "the
  // approval exists" and "the switch fires".
  let sawResult = false;
  const collected: WinterFrame[] = [];
  for await (const f of host.input) {
    collected.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "hook") {
      const cf = f as ControlRequestFrame;
      host.output.write({
        type: "control_response",
        requestId: cf.requestId,
        ok: true,
        payload: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } },
      });
    }
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result" && !sawResult) {
      sawResult = true;
      expect(approvalStore.pendingFor({ sessionId: "s" })).toHaveLength(1); // the record already exists by now
      host.output.write({ type: "control_request", requestId: "r2", subtype: "set_permission_mode", payload: "plan" });
      host.output.write({ type: "control_request", requestId: "r3", subtype: "end_input", payload: undefined });
    }
  }
  await done;

  expect(sawResult).toBe(true);
  const all = approvalStore.listFor({ sessionId: "s" });
  expect(all).toHaveLength(1);
  expect(all[0]!.state).toBe("cancelled");
  expect(all[0]!.resolution?.reason).toMatch(/mode switched from default to plan/);
});

test("Task 11: a mode switch (door 2: updatedPermissions' own type:'setMode', reached mid-turn via a PermissionRequest hook answer) also cancels every still-pending durable approval", async () => {
  const { host, runtime } = createInMemoryChannel();
  const approvalStore = createInMemoryApprovalStore();
  // call1 defers (parks); call2 is unmatched and its own PermissionRequest hook answers "allow"
  // WITH a setMode suggestion -- policy-state.ts's own "second door into the same room." Per-call
  // evaluation within one round is SEQUENTIAL (engine.ts's own comment on this loop), so call1's
  // approvalStore.record() has already completed by the time call2's updatedPermissions applies.
  const scripted = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "long_task", input: {} }, { id: "call2", name: "unmatched_tool", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const config = baseConfig({ hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }], PermissionRequest: [{ hookCount: 1, source: "sdk" }] } });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor, approvalStore });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  for await (const f of host.input) {
    if (f.type !== "control_request" || (f as ControlRequestFrame).subtype !== "hook") continue;
    const cf = f as ControlRequestFrame;
    const payload = cf.payload as { event: string; toolUseID?: string };
    if (payload.event === "PreToolUse" && payload.toolUseID === "call1") {
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } } });
    } else if (payload.event === "PermissionRequest") {
      host.output.write({
        type: "control_response",
        requestId: cf.requestId,
        ok: true,
        payload: {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] },
          },
        },
      });
    } else {
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: {} }); // call2's own PreToolUse: no opinion
    }
  }
  await done;

  const all = approvalStore.listFor({ sessionId: "s" });
  expect(all).toHaveLength(1);
  expect(all[0]!.state).toBe("cancelled");
  expect(all[0]!.resolution?.reason).toMatch(/default to acceptEdits/);
});

// --- Task 6 (WS-07 §2/§6.1/§6.3/§6.4): the permission gate — engine integration --------------------
//
// Unlike every test above, these drive `inMemoryProcess` (winter-agent-runtime/testing) rather than
// `createInMemoryChannel` directly, over a fresh mkdtemp WINTER_HOME — mirroring the established
// "T8/P1 dialect test pattern" (packages/runtime/src/store/resume.test.ts's own runOneEnvelope/
// drainAll helpers) so persistence (via WinterCompatibilitySessionStore) can be read back and
// compared against the wire. Every winterHome below is a fresh mkdtemp, never ~/.winter/~/.norma.

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "winter-permissions-test-"));
}

async function drainProcess(proc: SpawnedRuntimeProcess): Promise<WinterFrame[]> {
  const frames: WinterFrame[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    frames.push(...split.frames);
  }
  return frames;
}

test("Task 6: a denied tool call produces a synthetic tool_result with denied:true on the wire, and the round continues to the other call + the next provider turn", async () => {
  const home = freshHome();
  try {
    const sessionId = randomUUID();
    const cwd = "/winter-fixture-permissions";
    // Ruling P2-I: allowedTools:["other_tool"] added so call2 keeps executing normally (an
    // UNMATCHED call now denies absent a real host too) — this test's own point is that call1's
    // EXPLICIT disallow-rule denial does not stop the round from reaching call2, which this fixture
    // change preserves exactly as originally intended.
    const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", disallowedTools: ["test_tool"], allowedTools: ["other_tool"] };
    // Fix round 1, item 3 (LOW — history-leg direct capture): the established P1-G/P1-H-pattern
    // capturing provider, in place of scriptedProvider's plain queue, so the SECOND generate()
    // call's `messages` snapshot (the engine's own internal history accumulator) can be inspected
    // directly — not just inferred from wire/persistence agreement.
    const calls: ProviderMessage[][] = [];
    let turnCount = 0;
    const provider: Provider = {
      async generate({ messages }) {
        calls.push([...messages]);
        turnCount++;
        if (turnCount === 1) {
          return {
            kind: "tool_use",
            calls: [
              { id: "call1", name: "test_tool", input: { probe: true } },
              { id: "call2", name: "other_tool", input: { x: 1 } },
            ],
          };
        }
        return { kind: "text", text: "done" };
      },
    };
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, stubExecutor, { WINTER_HOME: home });
    proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));

    const frames = await drainProcess(proc);
    await proc.exited;

    const msgs = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
    // T10: the unconditional PermissionDenied "system"/permission_denied message (WS-08 §6 /
    // derived-shapes-p2.md item (d)) now lands between the assistant's tool_use batch and the
    // user's tool_result batch — it fires for call1's denial before call2 is even evaluated.
    expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "system", "user", "assistant", "result"]);
    const permissionDeniedMsg = msgs[2] as { subtype: string; tool_name: string; tool_use_id: string };
    expect(permissionDeniedMsg.subtype).toBe("permission_denied");
    expect(permissionDeniedMsg.tool_name).toBe("test_tool");
    expect(permissionDeniedMsg.tool_use_id).toBe("call1");
    const toolResultMsg = msgs[3] as { message: { content: unknown } };
    expect(toolResultMsg.message.content).toEqual([
      { type: "tool_result", tool_use_id: "call1", content: expect.any(String), denied: true },
      { type: "tool_result", tool_use_id: "call2", content: "other_tool:{\"x\":1}" }, // never denied — the round continues past the deny
    ]);
    const deniedBlock = (toolResultMsg.message.content as Array<{ tool_use_id: string; content: string }>)[0]!;
    expect(deniedBlock.content.length).toBeGreaterThan(0);
    // the round genuinely continued: the SECOND provider turn ("done") still ran and completed
    expect((msgs.at(-1) as Extract<SdkMessage, { type: "result" }>).result).toBe("done");

    // persistence: the SAME content the wire showed is what's on disk (wire/history/persistence agreement)
    const store = new WinterCompatibilitySessionStore({ winterHome: home });
    const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
    const loaded = await store.load({ projectKey, sessionId });
    expect(loaded).not.toBeNull();
    const persistedUserEntry = loaded!.find(
      (e) => e.type === "user" && Array.isArray((e as { message?: { content?: unknown } }).message?.content),
    ) as { message: { content: unknown } } | undefined;
    expect(persistedUserEntry).toBeDefined();
    expect(persistedUserEntry!.message.content).toEqual(toolResultMsg.message.content);

    // Fix round 1, item 3: the INTERNAL history leg — the denied tool_result appears in the
    // engine's own `messages` accumulator (what the NEXT provider.generate() call actually sees)
    // exactly as it appeared on the wire and in persistence above. Mirrors the P1-G/P1-H tests'
    // own toolResultMsg-in-calls[1] pattern (role "tool", not "user" — internal history keeps tool
    // results on their own role; see engine.ts's ProviderMessage comment).
    expect(calls.length).toBe(2);
    const secondCallMessages = calls[1]!;
    const internalToolMsg = secondCallMessages.find((m) => m.role === "tool");
    expect(internalToolMsg).toBeDefined();
    expect(internalToolMsg!.content).toEqual(toolResultMsg.message.content as string | ContentBlock[]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- Task 8 (WS-07 §7.2): a real canUseTool allow with updatedPermissions ---------------------------

test("Task 8: a real canUseTool allow with updatedPermissions applies LIVE (a second matching call is auto-approved, no second RPC) and journals durably", async () => {
  const home = freshHome();
  try {
    const sessionId = randomUUID();
    const cwd = "/winter-fixture-permissions-journal";
    const config: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo" }; // zero rules: BOTH calls start unmatched
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
      { kind: "tool_use", calls: [{ id: "call2", name: "mystery_tool", input: {} }] },
      { kind: "text", text: "done" },
    ]);
    const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, stubExecutor, { WINTER_HOME: home });

    // A manual, per-frame driver (mirrors transport-equivalence.test.ts's own createDriver) — needed
    // here (unlike drainProcess above) because this test must ANSWER a runtime-originated
    // "permission" control_request mid-drain, not just read everything to EOF.
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

    // "userSettings" deliberately, not "localSettings"/"projectSettings": those map to
    // source:"local"/"project", which resolveRules'/findMatchingRuleEntry's own trust gate excludes
    // from ALLOW resolution while trustedWorkspace is false (a P2-wide constant — no settings-file
    // loader exists yet to have established real trust, P5) — an update landing there would be
    // journaled but stay LIVE-INERT, silently defeating this test's own "applies LIVE" claim.
    // "userSettings" (source "user") is untrusted-gate-exempt AND still a FILE_DESTINATIONS member
    // (ruleset.ts), so it is both durably journaled and immediately effective — proving both halves
    // of Phase ruling 2 ("applies session-effective immediately AND appends to the journal") at once.
    const suggestedRule: PermissionUpdate = { type: "addRules", rules: [{ toolName: "mystery_tool" }], behavior: "allow", destination: "userSettings" };

    proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));

    const seen: WinterFrame[] = [];
    let permissionRequestCount = 0;
    while (true) {
      const frame = await nextFrame();
      if (!frame) break; // natural EOF — the engine terminated on its own (P2-B's own termination proof, reused here)
      seen.push(frame);
      if (frame.type === "control_request" && (frame as ControlRequestFrame).subtype === "permission") {
        permissionRequestCount++;
        const cf = frame as ControlRequestFrame;
        // call2 must NEVER reach here — that's the whole "applies LIVE" claim under test.
        expect((cf.payload as { toolUseID: string }).toolUseID).toBe("call1");
        const result: PermissionResult = { behavior: "allow", updatedPermissions: [suggestedRule] };
        proc.stdin.write(encodeFrame({ type: "control_response", requestId: cf.requestId, ok: true, payload: result }));
      }
    }
    await proc.exited;

    expect(permissionRequestCount).toBe(1); // call2 was auto-approved via the LIVE rule — never a second RPC

    const msgs = seen.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
    expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "user", "assistant", "user", "assistant", "result"]);
    const firstToolResult = msgs[2] as { message: { content: unknown } };
    expect(firstToolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: "mystery_tool:{}" }]);
    // call2: ALSO executed — resolved via the newly-added rule, not a second canUseTool round trip.
    const secondToolResult = msgs[4] as { message: { content: unknown } };
    expect(secondToolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "call2", content: "mystery_tool:{}" }]);

    // Phase ruling 2: the SAME update durably journaled, envelope-wrapped with authority "session".
    const projectKey = compatibilityKeys(cwd).transcriptProjectKey;
    const journalPath = join(home, "projects", projectKey, `${sessionId}.permission-journal.jsonl`);
    expect(existsSync(journalPath)).toBe(true);
    const envelope = JSON.parse(readFileSync(journalPath, "utf8").trim()) as { authority: string; update: PermissionUpdate; at: string };
    expect(envelope.authority).toBe("session");
    expect(envelope.update).toEqual(suggestedRule);
    expect(typeof envelope.at).toBe("string");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Finding 8 (P2 fix-wave, MINOR): the engine ignored policyStateStore.applyUpdate's own {ok:false}
// result and journaled the update anyway; a malformed suggestion's typed throw escaped uncaught,
// converting an ALREADY-APPROVED call into a whole-turn error_during_execution. Both fixed: the
// approved call always executes; only the suggestion is ever dropped.

test("Finding 8(a): a real canUseTool allow suggesting bypassPermissions (bypass gate OFF) executes the call, journals NOTHING, and leaves the live mode unchanged", async () => {
  const { host, runtime } = createInMemoryChannel();
  const journaled: Array<{ update: PermissionUpdate; authority: string }> = [];
  const store: SessionPersistence = {
    recordUserEntry: async () => {},
    recordAssistantEntry: async () => {},
    recordPermissionUpdate: async (update, authority) => {
      journaled.push({ update, authority });
    },
  };
  // allowDangerouslySkipPermissions deliberately OMITTED -- the bypass gate this fixture proves still holds.
  // TWO unmatched calls in the SAME round -- if the malicious setMode actually flipped the live
  // mode, call2 would sail through stage 4's bypass auto-allow without a second canUseTool RPC.
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [
      { id: "call1", name: "unmatched_tool", input: {} },
      { id: "call2", name: "unmatched_tool", input: {} },
    ] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor, store });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  let permissionRequestCount = 0;
  for await (const f of host.input) {
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      permissionRequestCount++;
      const cf = f as ControlRequestFrame;
      const updatedPermissions: PermissionUpdate[] | undefined =
        permissionRequestCount === 1 ? [{ type: "setMode", mode: "bypassPermissions", destination: "userSettings" }] : undefined;
      const result: PermissionResult = { behavior: "allow", ...(updatedPermissions !== undefined ? { updatedPermissions } : {}) };
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: result });
    }
  }
  const code = await done;

  expect(code).toBe(0);
  // 2, not 1 -- the mode switch never took effect (mirrors the PermissionRequest-hook smuggle
  // fixture's own discriminating trick, exercised here via canUseTool instead).
  expect(permissionRequestCount).toBe(2);
  expect(journaled).toEqual([]);
});

test("Finding 8(b): a real canUseTool allow suggesting a MALFORMED addRules entry (an MCP tool with a rejected parenthetical specifier) still executes the call and ends the turn 'success' -- the bad suggestion is dropped, not a whole-turn error_during_execution", async () => {
  const { host, runtime } = createInMemoryChannel();
  let executed = false;
  const tools: ToolExecutor = {
    async execute() {
      executed = true;
      return { output: "ok" };
    },
  };
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "unmatched_tool", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      const cf = f as ControlRequestFrame;
      // WS-07 §3: "parenthetical parameter rules ... are rejected" for MCP tools -- ruleset.ts's
      // validateNewRule (via sourceRule) throws PermissionRuleValidationError for this exact shape.
      const badRule: PermissionUpdate = {
        type: "addRules",
        rules: [{ toolName: "mcp__github__get_issue", ruleContent: "anything" }],
        behavior: "allow",
        destination: "userSettings",
      };
      const result: PermissionResult = { behavior: "allow", updatedPermissions: [badRule] };
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: result });
    }
  }
  await done;

  expect(executed).toBe(true); // the already-approved call still ran
  const msgs = dataMessages(seen);
  const result = msgs.find((m) => m.type === "result") as Extract<SdkMessage, { type: "result" }>;
  expect(result.subtype).toBe("success"); // NOT error_during_execution
  expect(result.is_error).toBe(false);
});

test("Task 8 (P3 close-out): a real canUseTool allow suggesting an addRules entry whose Read pattern exceeds RULING P2-E's glob-depth cap still executes the call and ends the turn 'success' -- the SAME drop-not-crash mechanism as Finding 8(b) above, now proven for the OTHER validateNewRule rejection class (the glob-depth cap), not just the MCP-parenthetical one", async () => {
  const { host, runtime } = createInMemoryChannel();
  let executed = false;
  const tools: ToolExecutor = {
    async execute() {
      executed = true;
      return { output: "ok" };
    },
  };
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "unmatched_tool", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  // RULING P2-E: MAX_DOUBLE_STARS+1 "**" segments -- ruleset.ts's validateNewRule (via sourceRule)
  // throws PermissionRuleValidationError for this exact shape, Read/Edit/Write/NotebookEdit alike.
  const overCapPattern = Array.from({ length: MAX_DOUBLE_STARS + 1 }, () => "**").join("/a/");

  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      const cf = f as ControlRequestFrame;
      const badRule: PermissionUpdate = {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: overCapPattern }],
        behavior: "deny",
        destination: "userSettings",
      };
      const result: PermissionResult = { behavior: "allow", updatedPermissions: [badRule] };
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: result });
    }
  }
  await done;

  expect(executed).toBe(true); // the already-approved call still ran
  const msgs = dataMessages(seen);
  const result = msgs.find((m) => m.type === "result") as Extract<SdkMessage, { type: "result" }>;
  expect(result.subtype).toBe("success"); // NOT error_during_execution
  expect(result.is_error).toBe(false);
});

// WS-07 §2's stale-policy-rejection contract, exercised for the first time with a GENUINE async
// window: evaluateWithFreshPolicy (T6, unchanged by Task 8) already re-evaluates when
// policyStateStore's version moved on while an evaluate() call was in flight — but with the T6/T7
// stub PromptStage (a synchronous null, no real await), there was no real-world window during which
// a permission RPC specifically could straddle a policy change. The real, bridge-backed PromptStage
// is what makes this scenario possible to construct at all.
test("Task 8/WS-07 §2: a permission answer computed under a policy that changed WHILE the RPC was in flight is discarded and re-evaluated fresh", async () => {
  const { host, runtime } = createInMemoryChannel();
  // Item 7 (P2 fix-wave) narrative fix: a SECOND scripted turn is required here -- a deny does not
  // stop the round loop (only a throw/interrupt does), so this run's real second provider.generate()
  // call is NOT hypothetical: pre-fix, a single-item script left it unscripted, and
  // scriptedProvider's own exhaustion throw silently became this run's ACTUAL terminal result
  // (error_during_execution), papered over because runEngine always returns code 0 either way and
  // neither this test's own assertions (nor the deny-check below) ever looked at `finalResult`'s own
  // subtype. This test's real claim -- "discarded and re-evaluated fresh," a CLEAN outcome -- is now
  // actually verified via the explicit "success" assertion further down, not merely assumed.
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });

  const seen: WinterFrame[] = [];
  let permissionReq: ControlRequestFrame | undefined;
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      permissionReq = f as ControlRequestFrame;
      break;
    }
  }
  expect(permissionReq).toBeDefined();

  // WHILE the permission RPC is still unanswered, switch the live mode — this bumps policyVersion.
  // Its own ack is awaited before answering the stale RPC, so the version bump is guaranteed to
  // have already landed by the time the late answer arrives.
  host.output.write({ type: "control_request", requestId: "m1", subtype: "set_permission_mode", payload: "dontAsk" });
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_response" && (f as ControlResponseFrame).requestId === "m1") break;
  }

  // NOW answer the original (now-stale) request with an allow — it must be discarded, never executed.
  const staleResult: PermissionResult = { behavior: "allow" };
  host.output.write({ type: "control_response", requestId: permissionReq!.requestId, ok: true, payload: staleResult });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const rest = await drain(host.input);
  seen.push(...rest);
  const code = await done;
  expect(code).toBe(0);

  // Never a second "permission" RPC: dontAsk's re-evaluation denies outright at stage 4/5's own
  // fallback, mechanism "mode" — it never reaches canUseTool again (WS-07 §6.3).
  const firstReqIndex = seen.indexOf(permissionReq!);
  const secondPermissionReq = seen
    .slice(firstReqIndex + 1)
    .find((f) => f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission");
  expect(secondPermissionReq).toBeUndefined();

  const msgs = dataMessages(seen);
  const toolResult = msgs.find((m) => m.type === "user") as { message: { content: unknown } };
  expect(toolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: expect.any(String), denied: true }]);
  // Item 7: the run's REAL terminal result is a clean success (the second scripted turn), not the
  // scriptedProvider-exhaustion error_during_execution the pre-fix single-item script silently produced.
  const result = msgs.find((m) => m.type === "result") as Extract<SdkMessage, { type: "result" }>;
  expect(result.subtype).toBe("success");
  expect(result.is_error).toBe(false);
});

// Termination re-argument, the gap found by review: P2-B's own header argues "the pump always
// ends" via stopReading() — but that argument only fires once the turn loop has ALREADY drained,
// which cannot happen while a turn is genuinely blocked awaiting a no-park-timeout bridge.request()
// (WS-04 §3). True EOF (host death, or a consumer that stops reading/writing without an explicit
// end_input) races ahead of that instead: `input` ends on its own while the permission RPC is still
// pending, and nothing can ever deliver its control_response. Without bridge.rejectAllPending(...)
// in the pump's own `finally`, this specific request — and therefore runEngine itself — would park
// forever. This test is the proof: it deliberately never answers the permission RPC at all.
test("Task 8 (termination edge, review finding): true EOF with a permission RPC still in flight resolves the RPC to a denial and lets runEngine return, instead of parking forever", async () => {
  const { host, runtime } = createInMemoryChannel();
  // Item 7 (P2 fix-wave) narrative fix: a SECOND scripted turn is required here too, for the
  // identical reason as the fixture above -- the round loop calls provider.generate() again after
  // the deny (nothing about a plain deny stops the round), and pre-fix that second, unscripted call
  // silently threw scriptedProvider's own exhaustion error, becoming this run's REAL terminal result
  // (error_during_execution) rather than the clean completion this test's own title claims ("lets
  // runEngine return" reads as success, and code 0 alone cannot distinguish the two).
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });

  const seen: WinterFrame[] = [];
  let sawPermissionReq = false;
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      sawPermissionReq = true;
      break;
    }
  }
  expect(sawPermissionReq).toBe(true);

  // True EOF: no end_input, and — the whole point — NO control_response for the pending permission
  // request either. Pre-fix this is exactly the shape that parks `done` forever.
  host.output.end();

  const rest = await drain(host.input);
  seen.push(...rest);
  const code = await done; // must actually resolve — this await is the test
  expect(code).toBe(0);

  const msgs = dataMessages(seen);
  const toolResult = msgs.find((m) => m.type === "user") as { message: { content: unknown } };
  expect(toolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: expect.any(String), denied: true }]);
  // Item 7: the run's REAL terminal result is a clean success (the second scripted turn), not the
  // scriptedProvider-exhaustion error_during_execution the pre-fix single-item script silently produced.
  const result = msgs.find((m) => m.type === "result") as Extract<SdkMessage, { type: "result" }>;
  expect(result.subtype).toBe("success");
  expect(result.is_error).toBe(false);
});

// WS-07 §7.2: deny.interrupt === true means "more than just this call is refused" — it additionally
// fires the SAME turn-wide interrupt signal a host-originated `interrupt` control request fires.
// Wired in engine.ts's tool loop (the deny branch, right after the denied call's own tool_result is
// pushed) but — found by review — never previously exercised by a test; this is that dedicated
// coverage, modeled on the file's own host-originated-interrupt test above (same provisional-result
// shape, same "back to idle cleanly afterward" follow-up).
test("Task 8 (WS-07 §7.2): a deny answer with interrupt:true stops the round AND produces the same provisional interrupted result as a host-originated interrupt", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "unreachable — the round was interrupted before a second provider call" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });

  let permissionReq: ControlRequestFrame | undefined;
  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      permissionReq = f as ControlRequestFrame;
      break;
    }
  }
  expect(permissionReq).toBeDefined();

  const denyInterrupt: PermissionResult = { behavior: "deny", message: "blocked, and stop the turn", interrupt: true };
  host.output.write({ type: "control_response", requestId: permissionReq!.requestId, ok: true, payload: denyInterrupt });

  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
  }

  const msgs = dataMessages(seen);
  const toolResultMsg = msgs.find((m) => m.type === "user") as { message: { content: unknown } };
  expect(toolResultMsg.message.content).toEqual([{ type: "tool_result", tool_use_id: "call1", content: "blocked, and stop the turn", denied: true }]);
  const result = msgs.at(-1);
  // Finding 3 (P2 fix-wave): this turn's one real denial (the interrupt-triggering deny above) lands here.
  expect(result).toEqual({
    type: "result",
    subtype: "success",
    is_error: false,
    interrupted: true,
    permission_denials: [{ tool_name: "mystery_tool", tool_use_id: "call1", tool_input: {} }],
  });

  // Back to idle cleanly afterward — a deny-triggered interrupt is not a stuck/half-torn-down state.
  host.output.write({ type: "control_request", requestId: "r2", subtype: "end_input", payload: undefined });
  const code = await done;
  expect(code).toBe(0);
});

test("Task 6: bypassPermissions at startup without allowDangerouslySkipPermissions is a typed config error before init is ever written", async () => {
  const { runtime } = createInMemoryChannel();
  // A synchronous throw at the very top of runEngine (before the pump/turn-loop ever starts) settles
  // this promise immediately — no input frame is needed either way (WinterPermissionError's throw
  // point precedes the very first `await`).
  const donePromise = runEngine({
    config: baseConfig({ permissionMode: "bypassPermissions" }),
    input: runtime.input,
    output: runtime.output,
    provider: echoProvider,
    tools: stubExecutor,
  });
  await expect(donePromise).rejects.toThrow(WinterPermissionError);
});

test("Task 6: an unrecognized permissionMode in RuntimeConfig is a typed config error, not a parse failure", async () => {
  const { runtime } = createInMemoryChannel();
  const donePromise = runEngine({
    config: baseConfig({ permissionMode: "not_a_real_mode" }),
    input: runtime.input,
    output: runtime.output,
    provider: echoProvider,
    tools: stubExecutor,
  });
  await expect(donePromise).rejects.toThrow(WinterPermissionError);
});

test("Task 6: bypassPermissions IS reachable at startup once allowDangerouslySkipPermissions is true", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
    input: runtime.input,
    output: runtime.output,
    provider: echoProvider,
    tools: stubExecutor,
  });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  const code = await done;
  expect(code).toBe(0);
  expect(dataMessages(frames).map((m) => m.type)).toEqual(["system", "assistant", "result"]);
});

test("Task 6: disableBypassPermissionsMode vetoes bypassPermissions at startup even with allowDangerouslySkipPermissions:true", async () => {
  const { runtime } = createInMemoryChannel();
  const donePromise = runEngine({
    config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, permissions: { disableBypassPermissionsMode: true } }),
    input: runtime.input,
    output: runtime.output,
    provider: echoProvider,
    tools: stubExecutor,
  });
  await expect(donePromise).rejects.toThrow(WinterPermissionError);
});

test("Task 6: switching INTO bypassPermissions mid-run without allowDangerouslySkipPermissions is rejected ok:false, and the mode stays unchanged", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });

  host.output.write({ type: "control_request", requestId: "m1", subtype: "set_permission_mode", payload: "bypassPermissions" });
  host.output.write({ type: "user", text: "hi" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  const code = await done;

  const ack = frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "m1") as ControlResponseFrame;
  expect(ack.ok).toBe(false);
  expect(ack.error?.code).toBe("bypass_not_allowed");
  expect(code).toBe(0);
});

test("Task 6: live set_permission_mode flips behavior between two rounds — bypassPermissions allows an unmatched call, dontAsk then denies the same shape (Ruling P2-I retired the old default-allows contrast: default now denies unmatched actions too, absent a real host)", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "first done" },
    { kind: "tool_use", calls: [{ id: "c2", name: "mystery_tool", input: {} }] },
    { kind: "text", text: "unreachable — c2 is denied before a second provider call would matter" },
  ]);
  const done = runEngine({
    config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
  });

  // Sequenced deliberately (NOT all written up front): writing every frame synchronously would let
  // the pump race the mode switch and envelope 2 ahead of envelope 1 ever reaching its own
  // evaluate() call (control_request frames are drained by the pump independently of how fast the
  // round loop consumes `userFrames`) — the SAME class of race the file's own "FIFO under pressure"
  // test above exists to guard against, just triggered from the opposite direction here. Round 1
  // must OBSERVABLY complete (its result frame seen) before the mode switch is even sent.
  host.output.write({ type: "user", text: "first" }); // round 1: bypassPermissions

  const round1Frames: WinterFrame[] = [];
  for await (const f of host.input) {
    round1Frames.push(f);
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
  }
  const firstToolResult = dataMessages(round1Frames).find((m) => m.type === "user") as { message: { content: unknown } };
  // envelope 1 (bypassPermissions): mystery_tool executes unconditionally, no rule needed (WS-07 §6.4)
  expect(firstToolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "mystery_tool:{}" }]);

  host.output.write({ type: "control_request", requestId: "m1", subtype: "set_permission_mode", payload: "dontAsk" });
  const modeAck = await (async () => {
    for await (const f of host.input) {
      if (f.type === "control_response" && (f as ControlResponseFrame).requestId === "m1") return f as ControlResponseFrame;
    }
    throw new Error("never saw the set_permission_mode ack");
  })();
  expect(modeAck.ok).toBe(true);

  host.output.write({ type: "user", text: "second" }); // round 2: now genuinely under dontAsk
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const round2Frames = await drain(host.input);
  const code = await done;
  expect(code).toBe(0);

  const secondToolResult = dataMessages(round2Frames).find((m) => m.type === "user") as { message: { content: unknown } };
  // envelope 2 (dontAsk): the SAME unmatched call is now denied, never executed
  expect(secondToolResult.message.content).toEqual([{ type: "tool_result", tool_use_id: "c2", content: expect.any(String), denied: true }]);
});

test("Task 2: a control_response with no matching pending request is dropped (bridge logs to stderr) — never crashes the engine", async () => {
  const errSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });

    host.output.write({ type: "control_response", requestId: "nobody-asked", ok: true, payload: {} });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

    const frames = await drain(host.input);
    const code = await done;

    expect(dataMessages(frames).map((m) => m.type)).toEqual(["system", "assistant", "result"]);
    expect(code).toBe(0);
  } finally {
    errSpy.mockRestore();
  }
});

// --- Task 11 (WS-07 §9): resume-consumption — a deferred call resolved on a LATER run --------------
//
// Drives `inMemoryProcess` across MULTIPLE separate calls against the SAME temp WINTER_HOME (never
// sharing engine state) — each call is its own independent "process," exactly like a real
// `winter --resume <id>` invocation after the first one exited. Between runs, `respond()` is called
// directly against a freshly-constructed FileDurableApprovalStore over the same location, exactly
// as an out-of-band host mechanism would (this task's own documented resume design).

function frameReader(proc: SpawnedRuntimeProcess): () => Promise<WinterFrame | null> {
  const it = proc.stdout[Symbol.asyncIterator]();
  let carry = "";
  const pending: WinterFrame[] = [];
  return async function nextFrame(): Promise<WinterFrame | null> {
    while (pending.length === 0) {
      const { value, done } = await it.next();
      if (done) return null;
      const split = splitFrames(value, carry);
      carry = split.carry;
      pending.push(...split.frames);
    }
    return pending.shift() ?? null;
  };
}

test("Task 11: a deferred call's approval, consumed 'allowed' on a LATER run, executes exactly once across two resumes", async () => {
  const home = freshHome();
  const sessionId = randomUUID();
  const cwd = "/winter-fixture-defer-resume";
  const projectKey = compatibilityKeys(cwd).transcriptProjectKey;

  let executionCount = 0;
  const countingExecutor: ToolExecutor = {
    async execute({ name, input }) {
      if (name === "slow_task") executionCount++;
      return { output: `executed:${JSON.stringify(input)}` };
    },
  };

  // --- Run 1: defers the call, exits with the record "pending" -----------------------------------
  const config1: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", winterHome: home, hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } };
  const provider1 = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "slow_task", input: { payload: "x" } }] },
    { kind: "text", text: "waiting for approval" },
  ]);
  const proc1 = inMemoryProcess(["--config-json", JSON.stringify(config1)], provider1, countingExecutor);
  const nextFrame1 = frameReader(proc1);
  proc1.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc1.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  while (true) {
    const frame = await nextFrame1();
    if (!frame) break;
    if (frame.type === "control_request" && (frame as ControlRequestFrame).subtype === "hook") {
      const cf = frame as ControlRequestFrame;
      const payload = cf.payload as { event: string };
      proc1.stdin.write(
        encodeFrame({
          type: "control_response",
          requestId: cf.requestId,
          ok: true,
          payload: payload.event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer", permissionDecisionReason: "needs durable approval" } } : {},
        }),
      );
    }
  }
  await proc1.exited;
  expect(executionCount).toBe(0); // never executed while merely deferred

  // --- Out-of-band: a host answers the pending approval while no engine process is running -------
  const storeBetweenRuns = createFileDurableApprovalStore({ winterHome: home, projectKey, sessionId });
  const pending = storeBetweenRuns.pendingFor({ sessionId });
  expect(pending).toHaveLength(1);
  expect(pending[0]!.toolName).toBe("slow_task");
  const requestId = pending[0]!.requestId;
  const respondResult = storeBetweenRuns.respond(requestId, { outcome: "allowed", mechanism: "canUseTool", decisionClassification: "user_temporary" });
  expect(respondResult.applied).toBe(true);

  // --- Run 2 (first resume): the allowed record is revalidated and executed exactly once ----------
  const config2: RuntimeConfig = { sessionId, resume: sessionId, cwd, model: "winter-test/echo", winterHome: home };
  const proc2 = inMemoryProcess(["--config-json", JSON.stringify(config2)], echoProvider, countingExecutor);
  proc2.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  await drainProcess(proc2);
  await proc2.exited;
  expect(executionCount).toBe(1); // executed exactly once, on this first resume

  const afterRun2 = createFileDurableApprovalStore({ winterHome: home, projectKey, sessionId }).get(requestId);
  expect(afterRun2?.consumedResult).toBe('executed:{"payload":"x"}');

  // --- Run 3 (second resume): NEVER re-executes; a fresh turn's own provider call sees the cached
  // result substituted into history, not the original "[deferred]" marker -------------------------
  const capturedMessages: ProviderMessage[][] = [];
  const capturingProvider: Provider = {
    async generate({ messages }) {
      capturedMessages.push([...messages]);
      return { kind: "text", text: "ok" };
    },
  };
  const config3: RuntimeConfig = { sessionId, resume: sessionId, cwd, model: "winter-test/echo", winterHome: home };
  const proc3 = inMemoryProcess(["--config-json", JSON.stringify(config3)], capturingProvider, countingExecutor);
  proc3.stdin.write(encodeFrame({ type: "user", text: "how did it go?" }));
  proc3.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  await drainProcess(proc3);
  await proc3.exited;

  expect(executionCount).toBe(1); // STILL 1 -- the second resume never re-executes
  expect(capturedMessages[0]).toContainEqual({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "call1", content: 'executed:{"payload":"x"}' }],
  });
  // The deferred marker itself never survives into the resumed run's live context -- only the
  // corrected value does (the persisted "[deferred]" line stays on disk, untouched, as history).
  expect(JSON.stringify(capturedMessages[0])).not.toContain("[deferred]");
});

test("Task 11: a policyMode mismatch on resume expires the pending approval instead of executing it", async () => {
  const home = freshHome();
  const sessionId = randomUUID();
  const cwd = "/winter-fixture-defer-resume-mismatch";
  const projectKey = compatibilityKeys(cwd).transcriptProjectKey;

  let executionCount = 0;
  const countingExecutor: ToolExecutor = {
    async execute() {
      executionCount++;
      return { output: "should never run" };
    },
  };

  const config1: RuntimeConfig = { sessionId, cwd, model: "winter-test/echo", winterHome: home, hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } };
  const provider1 = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "slow_task", input: {} }] }, { kind: "text", text: "waiting" }]);
  const proc1 = inMemoryProcess(["--config-json", JSON.stringify(config1)], provider1, countingExecutor);
  const nextFrame1 = frameReader(proc1);
  proc1.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc1.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  while (true) {
    const frame = await nextFrame1();
    if (!frame) break;
    if (frame.type === "control_request" && (frame as ControlRequestFrame).subtype === "hook") {
      const cf = frame as ControlRequestFrame;
      proc1.stdin.write(
        encodeFrame({ type: "control_response", requestId: cf.requestId, ok: true, payload: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } } }),
      );
    }
  }
  await proc1.exited;

  const storeBetweenRuns = createFileDurableApprovalStore({ winterHome: home, projectKey, sessionId });
  const requestId = storeBetweenRuns.pendingFor({ sessionId })[0]!.requestId;
  storeBetweenRuns.respond(requestId, { outcome: "allowed", mechanism: "canUseTool" });

  // Resumes under a DIFFERENT permissionMode than the original run used (default) -- the "policy"
  // revalidation axis mismatches even though policyVersion itself is 0 in both runs.
  const capturedMessages: ProviderMessage[][] = [];
  const capturingProvider: Provider = {
    async generate({ messages }) {
      capturedMessages.push([...messages]);
      return { kind: "text", text: "ok" };
    },
  };
  const config2: RuntimeConfig = { sessionId, resume: sessionId, cwd, model: "winter-test/echo", winterHome: home, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  const proc2 = inMemoryProcess(["--config-json", JSON.stringify(config2)], capturingProvider, countingExecutor);
  proc2.stdin.write(encodeFrame({ type: "user", text: "resuming" }));
  proc2.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  await drainProcess(proc2);
  await proc2.exited;

  expect(executionCount).toBe(0); // never executed -- the mismatch was caught before tools.execute()
  const finalRecord = createFileDurableApprovalStore({ winterHome: home, projectKey, sessionId }).get(requestId);
  expect(finalRecord?.state).toBe("expired");
  expect(capturedMessages[0]).toContainEqual({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "call1", content: expect.stringMatching(/Approval expired/), denied: true }],
  });
});

// --- Fix round 1 (reviewer findings) --------------------------------------------------------------

test("Fix round 1, Ruling P2-K: a symlink retargeted DURING the defer window is caught on resume -- never executed", async () => {
  const home = freshHome();
  const sessionId = randomUUID();
  // A REAL directory structure outside winterHome, realpath-wrapped (macOS's own /tmp -> /private/tmp
  // symlink would otherwise confuse the comparison this test is specifically about) -- mirrors
  // approvals.test.ts's own established convention for symlink-sensitive fixtures.
  const workDir = realpathSync(mkdtempSync(join(tmpdir(), "winter-defer-symlink-")));
  mkdirSync(join(workDir, "real-a"));
  writeFileSync(join(workDir, "real-a", "target.txt"), "original");
  symlinkSync(join(workDir, "real-a"), join(workDir, "link"));
  const projectKey = compatibilityKeys(workDir).transcriptProjectKey;

  let executionCount = 0;
  const countingExecutor: ToolExecutor = {
    async execute() {
      executionCount++;
      return { output: "should never run" };
    },
  };

  const config1: RuntimeConfig = { sessionId, cwd: workDir, model: "winter-test/echo", winterHome: home, hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } };
  const provider1 = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "Edit", input: { file_path: "link/target.txt", old_string: "original", new_string: "changed" } }] },
    { kind: "text", text: "waiting" },
  ]);
  const proc1 = inMemoryProcess(["--config-json", JSON.stringify(config1)], provider1, countingExecutor);
  const nextFrame1 = frameReader(proc1);
  proc1.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc1.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  while (true) {
    const frame = await nextFrame1();
    if (!frame) break;
    if (frame.type === "control_request" && (frame as ControlRequestFrame).subtype === "hook") {
      const cf = frame as ControlRequestFrame;
      proc1.stdin.write(
        encodeFrame({ type: "control_response", requestId: cf.requestId, ok: true, payload: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" } } }),
      );
    }
  }
  await proc1.exited;

  const storeBetweenRuns = createFileDurableApprovalStore({ winterHome: home, projectKey, sessionId });
  const requestId = storeBetweenRuns.pendingFor({ sessionId })[0]!.requestId;
  storeBetweenRuns.respond(requestId, { outcome: "allowed", mechanism: "canUseTool" });

  // Retarget the symlink DURING the (simulated) defer window -- same "link/target.txt" string,
  // same cwd, DIFFERENT real destination. This is exactly what defer's own core window (an
  // intentionally long wait) exists to make possible for an attacker to attempt.
  unlinkSync(join(workDir, "link"));
  mkdirSync(join(workDir, "real-b"));
  writeFileSync(join(workDir, "real-b", "target.txt"), "attacker-controlled");
  symlinkSync(join(workDir, "real-b"), join(workDir, "link"));

  const capturedMessages: ProviderMessage[][] = [];
  const capturingProvider: Provider = {
    async generate({ messages }) {
      capturedMessages.push([...messages]);
      return { kind: "text", text: "ok" };
    },
  };
  const config2: RuntimeConfig = { sessionId, resume: sessionId, cwd: workDir, model: "winter-test/echo", winterHome: home };
  const proc2 = inMemoryProcess(["--config-json", JSON.stringify(config2)], capturingProvider, countingExecutor);
  proc2.stdin.write(encodeFrame({ type: "user", text: "how did it go?" }));
  proc2.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  await drainProcess(proc2);
  await proc2.exited;

  expect(executionCount).toBe(0); // NEVER executed -- the retarget was caught before tools.execute()
  const finalRecord = createFileDurableApprovalStore({ winterHome: home, projectKey, sessionId }).get(requestId);
  expect(finalRecord?.state).toBe("expired");
  expect(capturedMessages[0]).toContainEqual({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "call1", content: expect.stringMatching(/Approval expired/), denied: true }],
  });
});

test("Fix round 1, Ruling P2-L: a crashed mid-execution attempt (consumingAt with no consumedAt) expires on the next resume, never re-executes", async () => {
  const { host, runtime } = createInMemoryChannel();
  const approvalStore = createInMemoryApprovalStore();
  const approval: DurableApprovalRecord = {
    runtimeKind: WINTER_RUNTIME_KIND,
    sessionId: "s",
    backendSessionId: "s",
    requestId: "req-1",
    toolUseID: "call1",
    toolName: "long_task",
    originalInput: {},
    displayMetadata: { decisionReason: "x" },
    policyMode: "default",
    policyVersion: 0,
    issuedAt: new Date().toISOString(),
    state: "pending",
    issuedCwd: "/tmp/x",
    issuedHome: "/synthetic/home",
  };
  approvalStore.record(approval);
  approvalStore.respond("req-1", { outcome: "allowed", mechanism: "hook" });
  // Simulates: a PRIOR resume already started executing this call and died before persisting an
  // outcome -- exactly the write-ahead marker markConsuming() leaves behind for this reason.
  approvalStore.markConsuming("req-1");
  expect(approvalStore.get("req-1")!.consumedAt).toBeUndefined(); // sanity: genuinely no result recorded

  let executionCount = 0;
  const countingExecutor: ToolExecutor = {
    async execute() {
      executionCount++;
      return { output: "should never run" };
    },
  };
  const initialMessages: ProviderMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "long_task", input: {} }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "call1", content: "[deferred]", deferred: true }] },
  ];
  const config = baseConfig({ cwd: "/tmp/x" });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: echoProvider, tools: countingExecutor, approvalStore, initialMessages });

  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;

  expect(executionCount).toBe(0); // never re-executed despite the record being "allowed"
  expect(approvalStore.get("req-1")!.state).toBe("expired");
});

test("Fix round 1 coverage rider: a still-PENDING record also revalidates and expires on a mismatch (shares the allowed+mismatch branch)", async () => {
  const { host, runtime } = createInMemoryChannel();
  const approvalStore = createInMemoryApprovalStore();
  const approval: DurableApprovalRecord = {
    runtimeKind: WINTER_RUNTIME_KIND,
    sessionId: "s",
    backendSessionId: "s",
    requestId: "req-1",
    toolUseID: "call1",
    toolName: "long_task",
    originalInput: {},
    displayMetadata: { decisionReason: "x" },
    policyMode: "default", // the recorded mode -- config below resumes under a DIFFERENT one
    policyVersion: 0,
    issuedAt: new Date().toISOString(),
    state: "pending",
    issuedCwd: "/tmp/x",
    issuedHome: "/synthetic/home",
  };
  approvalStore.record(approval);
  // Deliberately NEVER responded to -- still "pending" when this "resume" runs, unlike every other
  // mismatch fixture in this file (which all respond "allowed" first). The mismatch-handling branch
  // is SHARED between "pending" and "allowed" in engine.ts's own resume-consumption step; this
  // fixture pins the "pending" half specifically, which no other test in this suite exercises.

  let executionCount = 0;
  const countingExecutor: ToolExecutor = {
    async execute() {
      executionCount++;
      return { output: "should never run" };
    },
  };
  const initialMessages: ProviderMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "call1", name: "long_task", input: {} }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "call1", content: "[deferred]", deferred: true }] },
  ];
  // bypassPermissions !== the recorded "default" -- a clean, single-axis (policy) mismatch.
  const config = baseConfig({ cwd: "/tmp/x", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: echoProvider, tools: countingExecutor, approvalStore, initialMessages });

  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  await drain(host.input);
  await done;

  expect(executionCount).toBe(0);
  const finalRecord = approvalStore.get("req-1")!;
  expect(finalRecord.state).toBe("expired"); // NOT left "pending" -- the mismatch was caught even though it never reached "allowed"
});

// Finding 3 (P2 fix-wave, IMPORTANT): result.permission_denials -- the array the frozen
// derived-shapes doc calls "the record to trust ... the array is the ledger." Pin-verified
// ALWAYS-PRESENT on the real declaration (ephemeral fetch, this fix wave's own capture check) --
// every terminal result carries it, [] when this turn denied nothing.
test("Finding 3: a denied-tool round's terminal result carries permission_denials with the exact {tool_name, tool_use_id, tool_input} triple", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "test-call-1", name: "test_tool", input: { probe: true } }] },
    { kind: "text", text: "tool round done" },
  ]);
  // Zero permission config: the real bridge-backed promptStage sends a genuine "permission" RPC and
  // waits (no park timeout, WS-04 §3) -- true EOF (never end_input alone) is what makes
  // bridge.rejectAllPending resolve it to Ruling P2-I's fail-closed denial, mirroring this file's
  // own "termination edge" precedent (never answering the permission RPC at all).
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });
  const seen: WinterFrame[] = [];
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") break;
  }
  host.output.end();
  const rest = await drain(host.input);
  seen.push(...rest);
  await done;

  const msgs = dataMessages(seen);
  const result = msgs.find((m) => m.type === "result") as Extract<SdkMessage, { type: "result" }>;
  expect((result as { permission_denials?: unknown }).permission_denials).toEqual([{ tool_name: "test_tool", tool_use_id: "test-call-1", tool_input: { probe: true } }]);
});

test("Finding 3: a fully-approved round's terminal result carries permission_denials: [] -- the empty form, not absent, per the verified always-present pin", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "test-call-1", name: "test_tool", input: { probe: true } }] },
    { kind: "text", text: "tool round done" },
  ]);
  const done = runEngine({
    config: baseConfig({ allowedTools: ["test_tool"] }),
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
  });

  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const frames = await drain(host.input);
  await done;

  const msgs = dataMessages(frames);
  const result = msgs.find((m) => m.type === "result") as Extract<SdkMessage, { type: "result" }>;
  expect((result as { permission_denials?: unknown }).permission_denials).toEqual([]);
});

test("Finding 3: multiple denials within the SAME turn all accumulate, in call order; a SUBSEQUENT turn starts a fresh array (per-turn, never cross-turn)", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [
      { id: "call-a", name: "mystery_a", input: { x: 1 } },
      { id: "call-b", name: "mystery_b", input: { y: 2 } },
    ] },
    { kind: "text", text: "first done" },
    { kind: "text", text: "second done" },
  ]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  const seen: WinterFrame[] = [];
  host.output.write({ type: "user", text: "go" });

  // Explicitly deny both of turn 1's permission RPCs (rather than relying on true EOF, this file's
  // own "termination edge" precedent) -- this test wants turn 2 to complete NORMALLY afterward, not
  // be cut off.
  for (let i = 0; i < 2; i++) {
    for await (const f of host.input) {
      seen.push(f);
      if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
        const req = f as ControlRequestFrame;
        const deny: PermissionResult = { behavior: "deny", message: "no" };
        host.output.write({ type: "control_response", requestId: req.requestId, ok: true, payload: deny });
        break;
      }
    }
  }

  host.output.write({ type: "user", text: "again" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  const rest = await drain(host.input);
  seen.push(...rest);
  await done;

  const results = dataMessages(seen).filter((m) => m.type === "result") as Array<Extract<SdkMessage, { type: "result" }>>;
  expect(results).toHaveLength(2);
  expect((results[0] as { permission_denials?: unknown }).permission_denials).toEqual([
    { tool_name: "mystery_a", tool_use_id: "call-a", tool_input: { x: 1 } },
    { tool_name: "mystery_b", tool_use_id: "call-b", tool_input: { y: 2 } },
  ]);
  // Turn 2 denied nothing of its own -- turn 1's denials must never leak forward.
  expect((results[1] as { permission_denials?: unknown }).permission_denials).toEqual([]);
});

// Finding 6 (P2 fix-wave, IMPORTANT): config.additionalDirectories (RuntimeConfig's own wire mirror
// of Options.additionalDirectories) threads into EvaluationContext.additionalDirectories, which
// evaluator.ts's boundedRoots() already unions into acceptEdits' own edit-bounding check --
// evaluator.test.ts's own "additionalDirectories (EvaluationContext's own config field) widen the
// bound" fixture already proves boundedRoots' OWN logic; this proves the ENGINE-LEVEL wiring that
// makes a real config field reach it at all (pre-fix-wave, no such wire field existed to configure).
test("Finding 6: config.additionalDirectories threads into the evaluator -- acceptEdits + an Edit inside a granted directory OUTSIDE cwd auto-approves", async () => {
  const { host, runtime } = createInMemoryChannel();
  const tmpB = realpathSync(mkdtempSync(join(tmpdir(), "winter-engine-additional-dir-")));
  try {
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call1", name: "Edit", input: { file_path: join(tmpB, "file.txt") } }] },
      { kind: "text", text: "done" },
    ]);
    let executed = false;
    const tools: ToolExecutor = {
      async execute() {
        executed = true;
        return { output: "ok" };
      },
    };
    const config = baseConfig({ permissionMode: "acceptEdits", additionalDirectories: [tmpB] });
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, tools });

    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    const msgs = dataMessages(frames);
    const toolResult = msgs.find((m) => m.type === "user") as { message: { content: Array<{ denied?: boolean }> } };
    expect(toolResult.message.content[0]?.denied).toBeUndefined();
    expect(executed).toBe(true);
  } finally {
    rmSync(tmpB, { recursive: true, force: true });
  }
});

// Phase 4 Task 3 (MUST 7, WS-09 §6): the end-to-end wiring proof -- evaluator.test.ts already
// proves the stage-3 gate logic in isolation with a fake `requiresInteraction`; this proves
// engine.ts's own makeEvalCtx() actually fills that seam from the REAL, live tool registry (a
// same-server registerMcpServerTools call, exactly like a real MCP connection would make).
test("Phase 4 Task 3: an MCP tool marked requiresUserInteraction is denied under dontAsk through the REAL engine + registry wiring (WS-09 §6)", async () => {
  const SRV = "t3-interaction-fixture";
  registerMcpServerTools(SRV, [{ name: "delete_repo", inputSchema: { type: "object" }, _meta: { "anthropic/requiresUserInteraction": true } }], { deferredDefault: false });
  try {
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: `mcp__${SRV}__delete_repo`, input: {} }] },
      { kind: "text", text: "done" },
    ]);
    const done = runEngine({
      config: baseConfig({ permissionMode: "dontAsk", capabilities: ["winter.mcp"] }),
      input: runtime.input,
      output: runtime.output,
      provider,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    const messages = dataMessages(frames);
    const toolResultMsg = messages.find((m) => m.type === "user") as { message: { content: Array<{ tool_use_id: string; denied?: boolean; content: string }> } } | undefined;
    expect(toolResultMsg).toBeDefined();
    const block = toolResultMsg!.message.content.find((b) => b.tool_use_id === "call-1");
    expect(block?.denied).toBe(true);
    expect(block?.content).toContain("requiresUserInteraction");
  } finally {
    unregisterMcpServerTools(SRV);
  }
});

// Same fixture, opposite mode -- an ordinary MCP tool with NO requiresUserInteraction metadata is
// completely unaffected by this wiring (the seam only fires for descriptors the registry itself
// marked `interaction: "required"`).
test("Phase 4 Task 3: an ordinary MCP tool (no requiresUserInteraction) is unaffected by the new wiring", async () => {
  const SRV = "t3-interaction-control-fixture";
  registerMcpServerTools(SRV, [{ name: "list_repos", inputSchema: { type: "object" } }], { deferredDefault: false });
  try {
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: `mcp__${SRV}__list_repos`, input: {} }] },
      { kind: "text", text: "done" },
    ]);
    const done = runEngine({
      config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, capabilities: ["winter.mcp"] }),
      input: runtime.input,
      output: runtime.output,
      provider,
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    const messages = dataMessages(frames);
    const toolResultMsg = messages.find((m) => m.type === "user") as { message: { content: Array<{ tool_use_id: string; denied?: boolean }> } } | undefined;
    const block = toolResultMsg!.message.content.find((b) => b.tool_use_id === "call-1");
    expect(block?.denied).toBeUndefined(); // bypassPermissions executes an ordinary MCP tool unconditionally
  } finally {
    unregisterMcpServerTools(SRV);
  }
});

// ================================================================================================
// Phase 4 Task 3: MCP control subtypes, mcp_servers on init, deferral activation, sdk_mcp_call
// runtime-side registration, agentID threading (MUSTs 3/4/6/9).
// ================================================================================================
import { createFakeMcpServerStateSource, type McpServerStateSource } from "./mcp/state.ts";
import { createFakeMcpControlSeam } from "./mcp/control-seam.ts";

function sendAndCollectUntilResult(host: { output: { write(f: WinterFrame): void } }): void {
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
}

describe("Phase 4 Task 3: mcp_status / mcp_reconnect / mcp_toggle / mcp_set_servers (MUST 4)", () => {
  test("mcp_status reflects the configured McpServerStateSource, with the pinned needs-auth wire spelling", async () => {
    const { host, runtime } = createInMemoryChannel();
    const stateSource = createFakeMcpServerStateSource([
      { name: "gh", state: "connected", toolNames: ["list_issues"] },
      { name: "priv", state: "needsAuth", toolNames: [] },
    ]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor, mcpServerStateSource: stateSource });

    host.output.write({ type: "control_request", requestId: "mcp1", subtype: "mcp_status", payload: undefined });
    let response: ControlResponseFrame | undefined;
    for await (const f of host.input) {
      if (f.type === "control_response" && (f as ControlResponseFrame).requestId === "mcp1") {
        response = f as ControlResponseFrame;
        break;
      }
    }
    expect(response?.ok).toBe(true);
    expect(response?.payload).toEqual({
      servers: [
        { name: "gh", status: "connected" },
        { name: "priv", status: "needs-auth" },
      ],
    });

    sendAndCollectUntilResult(host);
    await drain(host.input);
    await done;
  });

  test("mcp_status with no state source configured answers an empty list, never an error", async () => {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });
    host.output.write({ type: "control_request", requestId: "mcp1", subtype: "mcp_status", payload: undefined });
    let response: ControlResponseFrame | undefined;
    for await (const f of host.input) {
      if (f.type === "control_response" && (f as ControlResponseFrame).requestId === "mcp1") {
        response = f as ControlResponseFrame;
        break;
      }
    }
    expect(response).toEqual({ type: "control_response", requestId: "mcp1", ok: true, payload: { servers: [] } });
    sendAndCollectUntilResult(host);
    await drain(host.input);
    await done;
  });

  test("mcp_reconnect/mcp_toggle/mcp_set_servers delegate to the configured McpControlSeam and ack", async () => {
    const { host, runtime } = createInMemoryChannel();
    const seam = createFakeMcpControlSeam();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor, mcpControlSeam: seam });

    async function roundTrip(requestId: string, subtype: string, payload: unknown): Promise<ControlResponseFrame> {
      host.output.write({ type: "control_request", requestId, subtype, payload });
      for await (const f of host.input) {
        if (f.type === "control_response" && (f as ControlResponseFrame).requestId === requestId) return f as ControlResponseFrame;
      }
      throw new Error("host.input ended before the response arrived");
    }

    expect(await roundTrip("r1", "mcp_reconnect", { serverName: "gh" })).toEqual({ type: "control_response", requestId: "r1", ok: true });
    expect(await roundTrip("r2", "mcp_toggle", { serverName: "gh", enabled: false })).toEqual({ type: "control_response", requestId: "r2", ok: true });
    seam.setServersResult = { added: ["gh"], removed: [], errors: {} };
    const setServersResponse = await roundTrip("r3", "mcp_set_servers", { servers: { gh: { command: "gh-mcp" } } });
    expect(setServersResponse).toEqual({ type: "control_response", requestId: "r3", ok: true, payload: { added: ["gh"], removed: [], errors: {} } });

    expect(seam.calls.reconnect).toEqual(["gh"]);
    expect(seam.calls.toggle).toEqual([{ serverName: "gh", enabled: false }]);
    expect(seam.calls.setServers).toEqual([{ gh: { command: "gh-mcp" } }]);

    sendAndCollectUntilResult(host);
    await drain(host.input);
    await done;
  });

  // REWRITTEN in the fix wave's follow-up round (item 3, whole-branch M2). This test used to drive a
  // plain `baseConfig()` session -- which declared no MCP servers and therefore had NO lifecycle and
  // no control seam at all. M2 makes the lifecycle unconditional (that "no way to ever gain a server"
  // state was the finding), so a bare session now HAS a seam and an unknown server name gets the
  // precise `mcp_reconnect_failed` instead of the blanket `mcp_unavailable`. Both codes are still
  // reachable and both are pinned here; only which INPUT produces which changed.
  async function reconnectUnknownServer(extra: { mcpServerStateSource?: McpServerStateSource } = {}): Promise<{ ok: boolean; error?: { code: string } }> {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor, ...extra });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "mcp_reconnect", payload: { serverName: "gh" } });
    let response: ControlResponseFrame | undefined;
    for await (const f of host.input) {
      if (f.type === "control_response" && (f as ControlResponseFrame).requestId === "r1") {
        response = f as ControlResponseFrame;
        break;
      }
    }
    sendAndCollectUntilResult(host);
    await drain(host.input);
    await done;
    return response as unknown as { ok: boolean; error?: { code: string } };
  }

  test("mcp_reconnect for an UNKNOWN server answers the precise mcp_reconnect_failed, never unknown_subtype (M2: a bare session now has a seam)", async () => {
    const response = await reconnectUnknownServer();
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("mcp_reconnect_failed");
  });

  test("mcp_unavailable is still the answer when the caller genuinely configured no control seam", async () => {
    // A host that owns its own MCP stack supplies a state source and (here) no control seam: the
    // engine's own dial is suppressed, so there is no seam to fall back to -- the one input that
    // still produces `mcp_unavailable` after M2.
    const response = await reconnectUnknownServer({ mcpServerStateSource: createFakeMcpServerStateSource([]) });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("mcp_unavailable");
  });
});

describe("Phase 4 Task 3: system/init.mcp_servers (MUST 3)", () => {
  test("both init frames carry mcp_servers when a state source is configured", async () => {
    const { host, runtime } = createInMemoryChannel();
    const stateSource = createFakeMcpServerStateSource([{ name: "gh", state: "connected", toolNames: [] }]);
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor, mcpServerStateSource: stateSource });
    sendAndCollectUntilResult(host);
    const frames = await drain(host.input);
    await done;
    const initFrame = frames.find((f) => f.type === "init") as { mcp_servers?: unknown } | undefined;
    expect(initFrame?.mcp_servers).toEqual([{ name: "gh", status: "connected" }]);
    const systemInit = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "init") as { mcp_servers?: unknown } | undefined;
    expect(systemInit?.mcp_servers).toEqual([{ name: "gh", status: "connected" }]);
  });

  test("mcp_servers is absent from both init frames when no state source is configured (every pre-existing scenario)", async () => {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });
    sendAndCollectUntilResult(host);
    const frames = await drain(host.input);
    await done;
    const initFrame = frames.find((f) => f.type === "init") as object;
    expect(Object.keys(initFrame)).not.toContain("mcp_servers");
  });
});

describe("Phase 4 Task 3: deferral activation end-to-end (MUST 6, RULING P4-A)", () => {
  test("a live-registered deferred+eligible MCP tool is excluded from system/init.tools while Tool Search is active, and included when it is not", async () => {
    const SRV = "t3-engine-deferral-fixture";
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    try {
      const canonicalName = `mcp__${SRV}__search_docs`;

      const { host: hostA, runtime: runtimeA } = createInMemoryChannel();
      const doneA = runEngine({
        config: baseConfig({ toolSearchEnabled: true, capabilities: ["winter.mcp"] }),
        input: runtimeA.input,
        output: runtimeA.output,
        provider: echoProvider,
        tools: stubExecutor,
        providerSupportsToolSearch: true,
        deferrableContextShare: 100,
      });
      sendAndCollectUntilResult(hostA);
      const framesA = await drain(hostA.input);
      await doneA;
      const initFrameA = framesA.find((f) => f.type === "init") as { tools: string[] };
      expect(initFrameA.tools).not.toContain(canonicalName); // deferred + never loaded -- absent from init.tools

      const { host: hostB, runtime: runtimeB } = createInMemoryChannel();
      const doneB = runEngine({
        config: baseConfig({ toolSearchEnabled: false, capabilities: ["winter.mcp"] }),
        input: runtimeB.input,
        output: runtimeB.output,
        provider: echoProvider,
        tools: stubExecutor,
      });
      sendAndCollectUntilResult(hostB);
      const framesB = await drain(hostB.input);
      await doneB;
      const initFrameB = framesB.find((f) => f.type === "init") as { tools: string[] };
      expect(initFrameB.tools).toContain(canonicalName); // Tool Search off -- fully injected (eager)
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("config.toolSearchEnabled folds in as an override of the ambient ENABLE_TOOL_SEARCH env var (RULING P4-A closes T2's Concern 8)", async () => {
    const SRV = "t3-engine-override-fixture";
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    try {
      const canonicalName = `mcp__${SRV}__search_docs`;
      const { host, runtime } = createInMemoryChannel();
      // Ambient env says Tool Search is OFF; the host's own explicit wire boolean says ON -- the
      // host's explicit choice must win (never a contradiction between the two signals).
      const done = runEngine({
        config: baseConfig({ toolSearchEnabled: true, capabilities: ["winter.mcp"] }),
        input: runtime.input,
        output: runtime.output,
        provider: echoProvider,
        tools: stubExecutor,
        env: { ENABLE_TOOL_SEARCH: "false" },
        providerSupportsToolSearch: true,
        deferrableContextShare: 100,
      });
      sendAndCollectUntilResult(host);
      const frames = await drain(host.input);
      await done;
      const initFrame = frames.find((f) => f.type === "init") as { tools: string[] };
      expect(initFrame.tools).not.toContain(canonicalName); // the host's explicit "on" won -- deferred, not injected
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});

describe("Phase 4 Task 3: sdk_mcp_call runtime-side forwarding (MUST 4, WS-04 addendum)", () => {
  test("a call to a registered SDK-server tool forwards {server,tool,arguments} as sdk_mcp_call and folds the host's CallToolResult into the tool_result text", async () => {
    const { host, runtime } = createInMemoryChannel();
    // scriptedProvider (provider/mock.ts), NOT a raw stateless Provider object -- a bare
    // `async generate() { return {kind:"tool_use", ...} }` re-returns the SAME tool_use on EVERY
    // round (found empirically: the round loop calls provider.generate() again after each round,
    // so a provider with no "then finish" turn loops forever, unlike the rpc_probe turn kind, which
    // terminates its own round immediately regardless of how many times generate() is called).
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "mcp__fixture__echo", input: { x: 1 } }] },
      { kind: "text", text: "done" },
    ]);
    const config = baseConfig({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: { fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
    });
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });

    host.output.write({ type: "user", text: "go" });
    const seen: WinterFrame[] = [];
    let reqId: string | undefined;
    let reqPayload: unknown;
    for await (const f of host.input) {
      seen.push(f);
      if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "sdk_mcp_call") {
        reqId = (f as ControlRequestFrame).requestId;
        reqPayload = (f as ControlRequestFrame).payload;
        break;
      }
    }
    expect(reqPayload).toEqual({ server: "fixture", tool: "echo", arguments: { x: 1 } });
    host.output.write({ type: "control_response", requestId: reqId!, ok: true, payload: { content: [{ type: "text", text: "echoed" }] } });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });

    for await (const f of host.input) {
      seen.push(f);
      if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
    }
    seen.push(...(await drain(host.input)));
    await done;

    const msgs = dataMessages(seen);
    const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    expect(toolResultMsg.message.content.find((b) => b.tool_use_id === "call-1")?.content).toBe("echoed");

    // Registry singleton hygiene: this run's own SDK-server registration does not survive teardown.
    expect(getRegisteredTool("mcp__fixture__echo")).toBeUndefined();
  });

  test("a rejected sdk_mcp_call (e.g. the host has no responder) folds into an error tool_result, never a hung round or a crashed run", async () => {
    const { host, runtime } = createInMemoryChannel();
    const provider = scriptedProvider([
      { kind: "tool_use", calls: [{ id: "call-1", name: "mcp__fixture__echo", input: {} }] },
      { kind: "text", text: "done" },
    ]);
    const config = baseConfig({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: { fixture: { type: "sdk", name: "fixture", tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
    });
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });

    host.output.write({ type: "user", text: "go" });
    const seen: WinterFrame[] = [];
    let reqId: string | undefined;
    for await (const f of host.input) {
      seen.push(f);
      if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "sdk_mcp_call") {
        reqId = (f as ControlRequestFrame).requestId;
        break;
      }
    }
    // Mirrors query.ts's own generic "no handler registered" fallback -- never a hang.
    host.output.write({ type: "control_response", requestId: reqId!, ok: false, error: { code: "unhandled_subtype", message: "no handler" } });
    host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });

    for await (const f of host.input) {
      seen.push(f);
      if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
    }
    seen.push(...(await drain(host.input)));
    await done;

    const msgs = dataMessages(seen);
    const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } };
    const block = toolResultMsg.message.content.find((b) => b.tool_use_id === "call-1");
    expect(block?.content).toContain("sdk_mcp_call failed");
  });
});

describe("Phase 4 Task 3: SDK-server registration failure cleanup (registry singleton hygiene, robustness)", () => {
  test("a later server's registration collision throws, but an EARLIER server's own already-registered tools from the same run are still unregistered", async () => {
    // A static stub sitting under the EXACT canonical name a live registration would compute --
    // mirrors registry.test.ts's own "colliding with a name registered by a non-live-MCP mechanism"
    // fixture (registerMcpServerTools's own guard, proven there in isolation). This test is at the
    // ENGINE level instead: runEngine's own try/catch around its SDK-server registration loop (added
    // this task) is what's under test -- without it, "earlyok"'s tools (fully registered and pushed
    // to sdkMcpServerNames BEFORE "t3collide" ever throws) would never reach the teardown loop at
    // all, because a thrown exception here aborts runEngine before that teardown code is reached
    // (there is no top-level try/finally around the rest of the function body).
    const collideCanonical = "mcp__t3collide__blocked";
    registerTool({
      descriptor: {
        canonicalName: collideCanonical,
        advertisedName: collideCanonical,
        source: "builtin",
        inputSchema: { type: "object" },
        description: "fixture",
        exposure: "eager",
        permissionClass: "read",
        availability: {},
        capabilityRequirements: [],
        disposition: "implement-now",
      },
    });
    try {
      const { runtime } = createInMemoryChannel();
      const provider = scriptedProvider([{ kind: "text", text: "unreachable" }]);
      // Object key order is insertion order for non-numeric string keys (ECMA-262) -- "earlyok"
      // registers (and is pushed) BEFORE "t3collide" ever runs, which is the exact ordering this
      // test needs to prove cleanup of an EARLIER success when a LATER entry fails.
      const config = baseConfig({
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: {
          earlyok: { type: "sdk", name: "earlyok", tools: [{ name: "foo", inputSchema: { type: "object" } }] },
          t3collide: { type: "sdk", name: "t3collide", tools: [{ name: "blocked", inputSchema: { type: "object" } }] },
        },
      });
      const donePromise = runEngine({ config, input: runtime.input, output: runtime.output, provider });
      await expect(donePromise).rejects.toThrow();
      // The point of this test: "earlyok"'s tool must not have leaked into the process-wide registry
      // singleton just because THIS run aborted on a later, unrelated server's collision.
      expect(getRegisteredTool("mcp__earlyok__foo")).toBeUndefined();
    } finally {
      unregisterToolForTest(collideCanonical);
      unregisterMcpServerTools("earlyok"); // defensive no-op if the fix under test already cleaned it up
      unregisterMcpServerTools("t3collide"); // defensive no-op: the throw prevented any real ownership
    }
  });
});

describe("Phase 4 Task 3: agentID threading (MUST 9)", () => {
  // Scope note: this proves PermissionCall.agentId's own threading end-to-end (config.agentId ->
  // the permission_denied stream message's own agent_id field) -- the ONE agentID call site
  // reachable from a raw runEngine harness without also standing up a full interactive hook-RPC
  // responder (createHookStage's/fireObservationalHook's own agentID spread fires only inside a
  // real hook invocation round trip, which needs its own "hook" control_request answered by the
  // test acting as host, on top of the permission RPC this test already handles by using dontAsk to
  // avoid it). Both call sites use the IDENTICAL one-line conditional-spread pattern
  // (`...(config.agentId !== undefined ? {agentID: config.agentId} : {})`) against the SAME
  // pre-existing seams (HookStageDeps.agentID/RunHooksContext.agentID, established by T8/T9/T10,
  // WS-08's own agentID plumbing) this exact PermissionCall.agentId pattern already proves works --
  // recorded here rather than silently assumed; see the task report's own concerns section.
  test("config.agentId populates permission_denied's agent_id field -- absent for the main engine", async () => {
    async function runWithAgentId(agentId: string | undefined): Promise<WinterFrame[]> {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "call-1", name: "unmatched_tool_t3_agentid", input: {} }] },
        { kind: "text", text: "done" },
      ]);
      const done = runEngine({
        // dontAsk: an unmatched tool call denies via the mode-4 fallback WITHOUT ever reaching
        // canUseTool (WS-07 §6.3) -- calling runEngine directly (bypassing query()) means there is
        // no host-side "auto-answer an unhandled subtype" mechanism at all (that's a query.ts-only
        // convenience); `default` mode would issue a REAL, never-answered `permission` bridge
        // request here and hang forever (WS-04 §3's own "no park timeout," confirmed empirically).
        config: baseConfig({ permissionMode: "dontAsk", ...(agentId !== undefined ? { agentId } : {}) }),
        input: runtime.input,
        output: runtime.output,
        provider,
        tools: stubExecutor,
      });
      sendAndCollectUntilResult(host);
      const frames = await drain(host.input);
      await done;
      return frames;
    }

    const withChildFrames = await runWithAgentId("agent-xyz");
    const permissionDeniedMsgWithChild = dataMessages(withChildFrames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") as
      | { agent_id?: string }
      | undefined;
    expect(permissionDeniedMsgWithChild?.agent_id).toBe("agent-xyz");

    const mainOnlyFrames = await runWithAgentId(undefined);
    const permissionDeniedMsgMain = dataMessages(mainOnlyFrames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") as
      | { agent_id?: string }
      | undefined;
    expect(permissionDeniedMsgMain?.agent_id).toBeUndefined();
  });
});

describe("Phase 4 Task 3: load-first execution boundary (MUST 6, WS-09 §8.2/§8.5)", () => {
  test("a call to a deferred, unloaded tool is rejected with a typed loadFirst result -- never executed; the round continues to a normal completion", async () => {
    const SRV = "t3-loadfirst-fixture";
    let executed = false;
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    replaceExecutor(`mcp__${SRV}__search_docs`, {
      async execute() {
        executed = true;
        return { output: "should never run" };
      },
    });
    try {
      const canonicalName = `mcp__${SRV}__search_docs`;
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "call-1", name: canonicalName, input: {} }] },
        { kind: "text", text: "done" },
      ]);
      const done = runEngine({
        config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, toolSearchEnabled: true, capabilities: ["winter.mcp"] }),
        input: runtime.input,
        output: runtime.output,
        provider,
        providerSupportsToolSearch: true,
        deferrableContextShare: 100,
      });
      sendAndCollectUntilResult(host);
      const frames = await drain(host.input);
      await done;

      expect(executed).toBe(false); // the real executor never ran
      const msgs = dataMessages(frames);
      const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; loadFirst?: boolean; content: string }> } };
      const block = toolResultMsg.message.content.find((b) => b.tool_use_id === "call-1");
      expect(block?.loadFirst).toBe(true);
      expect(block?.content).toContain("has not been loaded");
      // The run continued to a normal completion -- never hung, never aborted the whole turn.
      const result = msgs.find((m) => m.type === "result") as { subtype?: string; is_error?: boolean };
      expect(result?.subtype).toBe("success");
      expect(result?.is_error).toBe(false);
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });

  test("the SAME deferred tool executes normally once marked loaded (proves load-first is a session-state check, not a permanent ban)", async () => {
    const SRV = "t3-loadfirst-loaded-fixture";
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    const canonicalName = `mcp__${SRV}__search_docs`;
    replaceExecutor(canonicalName, {
      async execute() {
        return { output: "real result" };
      },
    });
    try {
      // No public engine-level seam exists yet to mark a tool loaded from OUTSIDE the engine (Lane
      // B's own ToolSearch executor is the real future caller, via ctx.emitToolReference or
      // equivalent) -- this proves the ESCAPE HATCH the boundary check itself depends on
      // (loadedToolSet.isLoaded) by using a session where Tool Search is OFF, which resolveDeferral
      // itself resolves to "eager" regardless of the loaded set (see resolveDeferral's own
      // provider/enableToolSearch floors) -- a complementary proof to the "deferred + active"
      // case above, not a duplicate of it.
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "call-1", name: canonicalName, input: {} }] },
        { kind: "text", text: "done" },
      ]);
      const done = runEngine({
        config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, toolSearchEnabled: false, capabilities: ["winter.mcp"] }),
        input: runtime.input,
        output: runtime.output,
        provider,
      });
      sendAndCollectUntilResult(host);
      const frames = await drain(host.input);
      await done;
      const msgs = dataMessages(frames);
      const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; loadFirst?: boolean; content: string }> } };
      const block = toolResultMsg.message.content.find((b) => b.tool_use_id === "call-1");
      expect(block?.loadFirst).toBeUndefined();
      expect(block?.content).toBe("real result");
    } finally {
      unregisterMcpServerTools(SRV);
    }
  });
});

describe("Phase 4 Task 3: ctx.emitToolReference (MUST 6, WS-09 §8.2/§8.3)", () => {
  test("emits a tool_reference block on the wire AND marks the names loaded, making a previously load-first-rejected call succeed on a later turn", async () => {
    const SRV = "t3-toolref-fixture";
    registerMcpServerTools(SRV, [{ name: "search_docs", inputSchema: { type: "object" } }], { deferredDefault: true });
    const canonicalName = `mcp__${SRV}__search_docs`;
    replaceExecutor(canonicalName, { async execute() { return { output: "real result" }; } });
    const SELECT_TOOL = "__t3_select_stand_in__";
    registerTool({
      descriptor: {
        canonicalName: SELECT_TOOL,
        advertisedName: SELECT_TOOL,
        source: "sdk",
        inputSchema: { type: "object" },
        description: "test-only stand-in for Lane B's own ToolSearch executor",
        exposure: "hidden",
        permissionClass: "read",
        availability: {},
        capabilityRequirements: [],
        disposition: "implement-now",
      },
      executor: {
        async execute(_input, ctx) {
          ctx.emitToolReference?.([canonicalName]);
          return { output: "selected" };
        },
      },
    });
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "call-1", name: SELECT_TOOL, input: {} }] },
        { kind: "tool_use", calls: [{ id: "call-2", name: canonicalName, input: {} }] },
        { kind: "text", text: "done" },
      ]);
      const done = runEngine({
        config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, toolSearchEnabled: true, capabilities: ["winter.mcp"] }),
        input: runtime.input,
        output: runtime.output,
        provider,
        providerSupportsToolSearch: true,
        deferrableContextShare: 100,
      });
      sendAndCollectUntilResult(host);
      const frames = await drain(host.input);
      await done;

      const msgs = dataMessages(frames);
      const toolRefMsg = msgs.find((m) => m.type === "assistant" && Array.isArray((m as { message: { content: Array<{ type: string }> } }).message.content) && (m as { message: { content: Array<{ type: string }> } }).message.content[0]?.type === "tool_reference") as
        | { message: { content: Array<{ type: string; tool_names: string[] }> } }
        | undefined;
      expect(toolRefMsg?.message.content[0]?.tool_names).toEqual([canonicalName]);

      const userMsgs = msgs.filter((m) => m.type === "user") as unknown as Array<{ message: { content: Array<{ tool_use_id: string; loadFirst?: boolean; content: string }> } }>;
      const call2Result = userMsgs.flatMap((m) => m.message.content).find((b) => b.tool_use_id === "call-2");
      expect(call2Result?.loadFirst).toBeUndefined();
      expect(call2Result?.content).toBe("real result");
    } finally {
      unregisterMcpServerTools(SRV);
      unregisterToolForTest(SELECT_TOOL);
    }
  });
});

// ==================================================================================================
// Fix round 1, MAJOR item 1: the spawn seam ENGINE-LEVEL proof (WS-10 §1/§3.5, R4-4, MUST 5).
//
// The original task-3-report.md claimed "MUST 5 proven in 39b1c44" -- that commit's own tests
// exercise MCP control subtypes, mcp_servers on init, deferral activation, sdk_mcp_call, and agentID
// ONLY. None of them ever call ctx.session.spawnChild, register a ChildEngineFactory, exercise
// buildChildInheritance's model-chain precedence, observe the childRoster, or drive
// forwardChildFrame's own wiring to the REAL host stream. That claim was false; this section is the
// actual proof (see task-3-report.md's fix-round section for the correction).
//
// Every test below drives a REAL runEngine with a scripted provider -- never a unit-level call into
// buildChildInheritance/resolveChildModel directly -- so what's proven is the WIRING (tool call ->
// registry dispatch -> ctx.session.spawnChild -> the registered factory -> the real host stream),
// not just the pure functions underneath it (already unit-provable, and beside the point: the
// report's false claim was specifically about END-TO-END engine coverage).
// ==================================================================================================

const SPAWN_PROBE_TOOL_NAME = "t3fix1_spawn_probe";

// A fixture tool whose executor does the ONE thing every test below needs: call
// ctx.session.spawnChild with EXACTLY the SpawnChildRequest the scripted tool_use's own `input`
// specifies, and report back which child it got. Registered/unregistered per-test (mirrors this
// file's own "collideCanonical" precedent, commit 95a27c7) rather than once at module scope, since
// different tests need no different DESCRIPTOR, only different scripted `input` per call.
function registerSpawnProbeTool(): void {
  registerTool({
    descriptor: {
      canonicalName: SPAWN_PROBE_TOOL_NAME,
      advertisedName: SPAWN_PROBE_TOOL_NAME,
      source: "builtin",
      inputSchema: { type: "object" },
      description: "fixture: calls ctx.session.spawnChild with its own input as the SpawnChildRequest",
      exposure: "eager",
      permissionClass: "read",
      availability: {},
      capabilityRequirements: [],
      disposition: "implement-now",
    },
    executor: {
      async execute(input: unknown, ctx) {
        if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
        const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
        return { output: JSON.stringify({ id: handle.record.id, status: handle.status() }) };
      },
    },
  });
}

// Captures every (req, inherit, runCtx) triple the registered factory is called with, in call
// order, and hands back the SAME createFakeChildHandle() instance every time (assertion (d) checks
// object IDENTITY against this, not merely a structurally-similar handle).
// NEW-3 (residual round): the return type now names `simulateCompletion` (already present on the
// fake, `subagents/test-fakes.ts`) instead of widening it away to bare `ChildHandle` -- a test that
// needs to settle the child had no typed way to say so.
function installCapturingFactory(): {
  calls: Array<{ req: SpawnChildRequest; inherit: ChildInheritance; runCtx: ChildEngineRunContext }>;
  handleToReturn: ReturnType<typeof createFakeChildHandle>;
} {
  const calls: Array<{ req: SpawnChildRequest; inherit: ChildInheritance; runCtx: ChildEngineRunContext }> = [];
  const handleToReturn = createFakeChildHandle();
  const factory: ChildEngineFactory = (runCtx) => ({
    async spawn(req: SpawnChildRequest, inherit: ChildInheritance) {
      calls.push({ req, inherit, runCtx });
      return handleToReturn;
    },
  });
  registerChildEngineFactory(factory);
  return { calls, handleToReturn };
}

describe("Fix round 1, MAJOR item 1: spawn seam engine-level proof (MUST 5, WS-10 R4-4)", () => {
  test("(a) no factory registered: the typed throw surfaces as a legible tool_result AND the run's own terminal error -- never a crash, never a hang", async () => {
    resetChildEngineFactoryForTest(); // clean slate regardless of test execution order
    registerSpawnProbeTool();
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "spawn-a", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-a", prompt: "go", runInBackground: false } }] },
        { kind: "text", text: "unreachable" },
      ]);
      const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      const code = await done;
      expect(code).toBe(0); // graceful completion -- a tool-executor throw is a normal exit, never a rejected runEngine promise

      const msgs = dataMessages(frames);
      const toolResultMsg = msgs.find((m) => m.type === "user") as unknown as { message: { content: Array<{ tool_use_id: string; content: string; error?: boolean }> } };
      const block = toolResultMsg.message.content.find((b) => b.tool_use_id === "spawn-a");
      expect(block?.error).toBe(true);
      expect(block?.content).toContain("no child engine factory is registered");

      const resultMsg = msgs.find((m) => m.type === "result") as unknown as { subtype: string; is_error: boolean; result: string };
      expect(resultMsg.subtype).toBe("error_during_execution");
      expect(resultMsg.is_error).toBe(true);
      expect(resultMsg.result).toContain("no child engine factory is registered");
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  test("(b) inherit.messages is present iff fork:true, both directions, within the same run", async () => {
    resetChildEngineFactoryForTest();
    registerSpawnProbeTool();
    const { calls } = installCapturingFactory();
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "spawn-b1", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-b1", prompt: "go", runInBackground: false } }] },
        { kind: "tool_use", calls: [{ id: "spawn-b2", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-b2", prompt: "go", runInBackground: false, fork: true } }] },
        { kind: "text", text: "done" },
      ]);
      const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;

      expect(calls.length).toBe(2);
      expect(calls[0]!.req.fork).toBeUndefined();
      expect(calls[0]!.inherit.messages).toBeUndefined();
      expect(calls[1]!.req.fork).toBe(true);
      expect(calls[1]!.inherit.messages).toBeDefined();
      expect(calls[1]!.inherit.messages!.length).toBeGreaterThan(0); // genuinely the live turn history, not an accidental empty array
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  test("(c) model chain: WINTER_SUBAGENT_MODEL wins when set to a real value", async () => {
    resetChildEngineFactoryForTest();
    registerSpawnProbeTool();
    const { calls } = installCapturingFactory();
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        {
          kind: "tool_use",
          calls: [
            {
              id: "spawn-c1",
              name: SPAWN_PROBE_TOOL_NAME,
              input: { parentToolUseId: "spawn-c1", prompt: "go", runInBackground: false, model: "invocation-model", definition: { description: "d", prompt: "p", model: "definition-model" } },
            },
          ],
        },
        { kind: "text", text: "done" },
      ]);
      const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, model: "session-model" });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: { WINTER_SUBAGENT_MODEL: "env-model" } });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      expect(calls.length).toBe(1);
      expect(calls[0]!.inherit.model).toBe("env-model");
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  test("(c) model chain: WINTER_SUBAGENT_MODEL=inherit is treated as absent -- falls through to the invocation model", async () => {
    resetChildEngineFactoryForTest();
    registerSpawnProbeTool();
    const { calls } = installCapturingFactory();
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "spawn-c2", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-c2", prompt: "go", runInBackground: false, model: "invocation-model" } }] },
        { kind: "text", text: "done" },
      ]);
      const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, model: "session-model" });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: { WINTER_SUBAGENT_MODEL: "inherit" } });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      expect(calls.length).toBe(1);
      expect(calls[0]!.inherit.model).toBe("invocation-model");
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  test("(c) model chain: with no env override, invocation > definition > session, and fork ignores the invocation override entirely", async () => {
    resetChildEngineFactoryForTest();
    registerSpawnProbeTool();
    const { calls } = installCapturingFactory();
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        // (i) invocation beats definition
        {
          kind: "tool_use",
          calls: [
            {
              id: "spawn-c3a",
              name: SPAWN_PROBE_TOOL_NAME,
              input: { parentToolUseId: "spawn-c3a", prompt: "go", runInBackground: false, model: "invocation-model", definition: { description: "d", prompt: "p", model: "definition-model" } },
            },
          ],
        },
        // (ii) definition beats session, when no invocation override
        {
          kind: "tool_use",
          calls: [{ id: "spawn-c3b", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-c3b", prompt: "go", runInBackground: false, definition: { description: "d", prompt: "p", model: "definition-model" } } }],
        },
        // (iii) session is the final fallback, nothing else set
        { kind: "tool_use", calls: [{ id: "spawn-c3c", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-c3c", prompt: "go", runInBackground: false } }] },
        // (iv) fork ignores the invocation override (and definition) entirely -- always session
        {
          kind: "tool_use",
          calls: [
            {
              id: "spawn-c3d",
              name: SPAWN_PROBE_TOOL_NAME,
              input: { parentToolUseId: "spawn-c3d", prompt: "go", runInBackground: false, fork: true, model: "invocation-model", definition: { description: "d", prompt: "p", model: "definition-model" } },
            },
          ],
        },
        { kind: "text", text: "done" },
      ]);
      // env: {} (never process.env) -- resolveChildModel's own (engineEnv ?? process.env) reads THIS
      // empty object, not the real process's own environment, so this test can never flake on
      // whatever WINTER_SUBAGENT_MODEL happens to be set to on the machine running it.
      const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, model: "session-model" });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: {} });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      expect(calls.length).toBe(4);
      expect(calls[0]!.inherit.model).toBe("invocation-model");
      expect(calls[1]!.inherit.model).toBe("definition-model");
      expect(calls[2]!.inherit.model).toBe("session-model");
      expect(calls[3]!.inherit.model).toBe("session-model"); // fork -- invocation/definition both ignored
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  test("(d) the childRoster is visible via onChildRosterReady, by identity, after a spawn completes", async () => {
    resetChildEngineFactoryForTest();
    registerSpawnProbeTool();
    const { handleToReturn } = installCapturingFactory();
    let getChildren: (() => readonly ChildHandle[]) | undefined;
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "spawn-d", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-d", prompt: "go", runInBackground: false } }] },
        { kind: "text", text: "done" },
      ]);
      const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
      const done = runEngine({
        config,
        input: runtime.input,
        output: runtime.output,
        provider,
        onChildRosterReady: (fn) => {
          getChildren = fn;
        },
      });
      // onChildRosterReady is called synchronously, near the start of setup -- available immediately,
      // well before any tool round runs, but the roster itself is empty until a spawn actually happens.
      expect(getChildren).toBeDefined();
      expect(getChildren!()).toEqual([]);
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;
      const children = getChildren!();
      expect(children.length).toBe(1);
      expect(children[0]).toBe(handleToReturn); // identity, not merely structural equality
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  // NEW-3 (P4 residual round): the foreground set is pruned when a child SETTLES, not only when an
  // interrupt clears it. It exists so an interrupt can stop the children a turn still owns (fix wave
  // I5); a finished child is not one of those, and keeping it grew the set by one per foreground
  // spawn for the life of the session. Invisible by any other route -- a settled child's `stop()` is
  // already a no-op -- which is why the set gets the same live-getter exposure the roster has.
  test("NEW-3: a COMPLETED foreground child is removed from the interrupt set, while staying in the roster", async () => {
    resetChildEngineFactoryForTest();
    registerSpawnProbeTool();
    const { handleToReturn } = installCapturingFactory();
    let getChildren: (() => readonly ChildHandle[]) | undefined;
    let getForeground: (() => readonly ChildHandle[]) | undefined;
    // `createFakeChildHandle`'s `result()` parks until `simulateCompletion` -- which is what lets
    // this test observe BOTH sides of the invariant on one handle: still tracked while running,
    // gone once settled.
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [{ id: "spawn-fg", name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: "spawn-fg", prompt: "go", runInBackground: false } }] },
        { kind: "text", text: "done" },
      ]);
      const done = runEngine({
        config: baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
        input: runtime.input,
        output: runtime.output,
        provider,
        onChildRosterReady: (fn) => {
          getChildren = fn;
        },
        onForegroundChildrenReady: (fn) => {
          getForeground = fn;
        },
      });
      expect(getForeground!()).toEqual([]);
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "end-fg", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;

      // Still RUNNING (the fake never resolved its result), so it is still a child an interrupt owns.
      // This is the half that makes the assertion below mean "pruned", not "never added".
      expect(getChildren!()).toEqual([handleToReturn]);
      expect(getForeground!(), "a still-running foreground child must stay in the interrupt set").toEqual([handleToReturn]);

      handleToReturn.simulateCompletion("child done");
      // The settle observer is a `.catch().finally()` chain on the child's own result promise --
      // several microtask hops. Polled with a short deadline rather than a fixed sleep so this can
      // never flake on a loaded box, and so a NON-pruning build fails on the assertion rather than
      // on a timeout.
      const deadline = Date.now() + 1000;
      while (getForeground!().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));

      expect(getChildren!(), "the ROSTER keeps every child it ever spawned").toEqual([handleToReturn]);
      expect(getForeground!(), "a settled foreground child must not be retained for the session's life").toEqual([]);
    } finally {
      unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
      resetChildEngineFactoryForTest();
    }
  });

  test("(e) forwardChildFrame lands on the REAL host stream, parent_tool_use_id-stamped -- tool_use/tool_result always forward, text only when forwardSubagentText is on", async () => {
    async function runOnce(forwardSubagentText: boolean, toolUseId: string): Promise<SdkMessage[]> {
      resetChildEngineFactoryForTest();
      registerSpawnProbeTool();
      try {
        const { host, runtime } = createInMemoryChannel();
        const factory: ChildEngineFactory = (runCtx: ChildEngineRunContext) => ({
          async spawn() {
            // Simulates the child's OWN frame stream -- forwarded through THIS run's real host
            // connection via the exact closure engine.ts built and handed to this factory (the
            // wiring under test; transformChildFrame's own pure-function correctness is already
            // unit-proven separately in child-handle.test.ts).
            runCtx.forwardChildFrame(
              { type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: "child thinking out loud" }] } } } as WinterFrame,
              { parentToolUseId: toolUseId, agentId: "child-e" },
            );
            runCtx.forwardChildFrame(
              { type: "data", message: { type: "assistant", message: { content: [{ type: "tool_use", id: "childcall-1", name: "Read", input: {} }] } } } as WinterFrame,
              { parentToolUseId: toolUseId, agentId: "child-e" },
            );
            runCtx.forwardChildFrame(
              { type: "data", message: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "childcall-1", content: "ok" }] } } } as WinterFrame,
              { parentToolUseId: toolUseId, agentId: "child-e" },
            );
            return createFakeChildHandle();
          },
        });
        registerChildEngineFactory(factory);
        const provider = scriptedProvider([
          { kind: "tool_use", calls: [{ id: toolUseId, name: SPAWN_PROBE_TOOL_NAME, input: { parentToolUseId: toolUseId, prompt: "go", runInBackground: false } }] },
          { kind: "text", text: "done" },
        ]);
        const config = baseConfig({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, forwardSubagentText });
        const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
        host.output.write({ type: "user", text: "go" });
        host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
        const frames = await drain(host.input);
        await done;
        return dataMessages(frames);
      } finally {
        unregisterToolForTest(SPAWN_PROBE_TOOL_NAME);
        resetChildEngineFactoryForTest();
      }
    }

    // forwardSubagentText: false (default) -- the child's own text block is SWALLOWED entirely
    // (transformChildFrame filters to tool_use-only, and an all-filtered assistant frame returns
    // null); tool_use/tool_result still forward, both parent_tool_use_id-stamped.
    const msgsOff = await runOnce(false, "spawn-e-off");
    const childAssistantsOff = msgsOff.filter((m) => m.type === "assistant" && (m as unknown as { parent_tool_use_id?: string }).parent_tool_use_id === "spawn-e-off");
    expect(childAssistantsOff.length).toBe(1); // only the tool_use frame -- the text-only frame was swallowed
    const childToolUseOff = childAssistantsOff[0] as unknown as { message: { content: Array<{ type: string; id: string; name: string; input: unknown }> } };
    expect(childToolUseOff.message.content).toEqual([{ type: "tool_use", id: "childcall-1", name: "Read", input: {} }]);
    const childUsersOff = msgsOff.filter((m) => m.type === "user" && (m as unknown as { parent_tool_use_id?: string }).parent_tool_use_id === "spawn-e-off");
    expect(childUsersOff.length).toBe(1);

    // forwardSubagentText: true -- the text frame now forwards too, still stamped.
    const msgsOn = await runOnce(true, "spawn-e-on");
    const childAssistantsOn = msgsOn.filter((m) => m.type === "assistant" && (m as unknown as { parent_tool_use_id?: string }).parent_tool_use_id === "spawn-e-on");
    expect(childAssistantsOn.length).toBe(2); // text frame AND tool_use frame, both forwarded
    const textFrame = childAssistantsOn.find((m) => (m as unknown as { message: { content: Array<{ type: string }> } }).message.content[0]?.type === "text") as unknown as {
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(textFrame.message.content).toEqual([{ type: "text", text: "child thinking out loud" }]);
  });
});

// ================================================================================================
// Phase 4 Task 8 (riders 1/3/4/15): runtime-derived capability tokens, the ToolSearch activation
// gate, and WS-09 §10 duplicate suppression -- all observed on the REAL wire, at system/init.tools.
// ================================================================================================
describe("Phase 4 Task 8: init.tools reflects derived capabilities, the activation gate, and alias suppression", () => {
  async function initTools(overrides: Partial<RuntimeConfig> = {}): Promise<string[]> {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig(overrides), input: runtime.input, output: runtime.output, provider: echoProvider });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const init = frames.find((f) => f.type === "init") as { tools: string[] } | undefined;
    return init?.tools ?? [];
  }

  // A session with at least one MCP server declared -- the `hasMcpServers` fact `winter.mcp`'s own
  // derivation is gated on (registry.ts's SessionCapabilityFacts, and the capture evidence there).
  const withMcp = { mcpServers: { probe: { type: "sdk" as const, name: "probe", tools: [{ name: "echo", inputSchema: { type: "object" } }] } } };

  test("rider 1: the subagent + messaging families are advertised with NO host-supplied capabilities at all", async () => {
    const tools = await initTools();
    for (const n of ["Agent", "SendMessage", "ListAgents", "ReadNotifications"]) {
      expect(tools, `"${n}" should be advertised once its family token is runtime-derived`).toContain(n);
    }
    // A token that is NOT derived stays host-supplied-only -- proves the union is additive, not a
    // blanket "advertise everything".
    expect(tools).not.toContain("mcp__winter__advisor");
    expect(await initTools({ capabilities: ["winter.reviewer-model"] })).toContain("mcp__winter__advisor");
  });

  // The session-scoped half of the derivation, on the real wire. Capture evidence
  // (capture-official-golden.ts Scenario D against the pinned 0.3.250 runtime): the OFFICIAL default
  // session advertises none of the MCP-family tools, and does advertise Agent/SendMessage/ListAgents.
  test("rider 1: the MCP family appears ONLY when this session actually declares an MCP server", async () => {
    const none = await initTools();
    for (const n of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "RefreshMcpTools", "WaitForMcpServers"]) {
      expect(none, `"${n}" must not be advertised in a session with no MCP servers`).not.toContain(n);
    }
    const some = await initTools(withMcp);
    for (const n of ["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "RefreshMcpTools", "WaitForMcpServers"]) {
      expect(some, `"${n}" should be advertised once this session declares an MCP server`).toContain(n);
    }
  });

  test("rider 4: ToolSearch is advertised iff activation is ON; WaitForMcpServers iff it is OFF (both need winter.mcp)", async () => {
    const off = await initTools(withMcp);
    expect(off).toContain("WaitForMcpServers");
    expect(off).not.toContain("ToolSearch");

    const on = await initTools({ ...withMcp, toolSearchEnabled: true });
    expect(on).toContain("ToolSearch");
    expect(on).not.toContain("WaitForMcpServers");
  });

  test("riders 3/15: WS-09 §10 duplicate suppression -- the model sees ONE SendMessage and ONE ListAgents, never the canonical duplicate", async () => {
    for (const toolSearchEnabled of [false, true]) {
      const tools = await initTools({ toolSearchEnabled });
      expect(tools).toContain("SendMessage");
      expect(tools).toContain("ListAgents");
      expect(tools, `canonical duplicate leaked with toolSearchEnabled=${toolSearchEnabled}`).not.toContain("mcp__winter__send_message");
      expect(tools).not.toContain("mcp__winter__list_agents");
    }
  });

  // RULING P4-E precision, VERBATIM: "The unresolved call name drives registry lookup, execution,
  // and the load-first predicate; resolveToolAlias(call.name) computes ONLY the hook/permission
  // identity." Both halves are asserted here against a REAL host-configured alias table.
  test("rider 3 / P4-E: an alias changes the PERMISSION identity only -- lookup and execution still use the unresolved call name", async () => {
    const srcName = "__t8_alias_source__";
    const targetName = "__t8_alias_target__";
    registerTool({
      descriptor: {
        canonicalName: srcName, advertisedName: srcName, source: "sdk", inputSchema: { type: "object" },
        description: "alias source fixture", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
    });
    replaceExecutor(srcName, { async execute() { return { output: "SOURCE EXECUTOR RAN" }; } });
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "c1", name: srcName, input: {} }] }, { kind: "text", text: "done" }]);
      const config = baseConfig({
        // `dontAsk` so an UNMATCHED call is denied outright by the mode floor (WS-07 §6.3) instead
        // of parking on an unanswerable permission RPC -- this makes the control test below a fair
        // comparison (identical config, alias table removed) rather than a hang.
        permissionMode: "dontAsk",
        toolAliases: { [srcName]: targetName },
        // The DENY is written against the ALIAS TARGET, a name the model never emitted. It can only
        // match if the permission identity was resolved through the alias -- which is exactly
        // WS-09 §10's "hook and permission matching run on the canonical post-alias identity".
        permissions: { deny: [`${targetName}`] },
      });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      await done;
      const denied = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") as
        | { tool_name?: string; decision_reason_type?: string }
        | undefined;
      expect(denied).toBeDefined();
      // THE DISCRIMINATING ASSERTION: `decision_reason_type` is "rule", not "mode". A denial alone
      // proves nothing here -- an unmatched call under `default` mode is denied by the mode floor
      // anyway (Ruling P2-I). Only a RULE match can produce "rule", and the only rule configured is
      // written against the ALIAS TARGET, a name the model never emitted -- so this is exactly
      // WS-09 §10's "hook and permission matching run on the canonical post-alias identity",
      // and it fails (falling back to "mode") the moment alias resolution is removed.
      expect(denied!.decision_reason_type).toBe("rule");
      // The MODEL-FACING report still names the tool the MODEL actually called (the unresolved
      // name) -- engine.ts's `denyCall` uses `call.name` for the stream message on purpose: the
      // alias is an internal identity mapping, not something to re-label the model's own call with.
      expect(denied!.tool_name).toBe(srcName);
      // ...and no dispatch redirection happened: the target name has no descriptor at all, so a
      // redirected call would have failed as "unknown tool" -- P4-E's "the unresolved call name
      // drives registry lookup [and] execution".
      const toolResults = dataMessages(frames).filter((m) => m.type === "user");
      expect(JSON.stringify(toolResults)).not.toContain("unknown tool");
      expect(JSON.stringify(toolResults)).not.toContain("SOURCE EXECUTOR RAN"); // the deny stopped it
    } finally {
      unregisterToolForTest(srcName);
    }
  });

  // The control for the test above: the IDENTICAL config with NO alias table denies by the MODE
  // floor instead of the rule -- which is what makes "rule" above a real, falsifiable signal rather
  // than an incidental value.
  test("rider 3 / P4-E control: without the alias table, the same target-name rule cannot match (mode floor instead)", async () => {
    const srcName = "__t8_alias_control_source__";
    const targetName = "__t8_alias_control_target__";
    registerTool({
      descriptor: {
        canonicalName: srcName, advertisedName: srcName, source: "sdk", inputSchema: { type: "object" },
        description: "alias control fixture", exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
    });
    replaceExecutor(srcName, { async execute() { return { output: "SOURCE EXECUTOR RAN" }; } });
    try {
      const { host, runtime } = createInMemoryChannel();
      const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "c1", name: srcName, input: {} }] }, { kind: "text", text: "done" }]);
      const config = baseConfig({ permissionMode: "dontAsk", permissions: { deny: [`${targetName}`] } });
      const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
      host.output.write({ type: "user", text: "go" });
      host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      await done;
      const denied = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "permission_denied") as
        | { decision_reason_type?: string }
        | undefined;
      expect(denied?.decision_reason_type).toBe("mode");
    } finally {
      unregisterToolForTest(srcName);
    }
  });
});

// ================================================================================================
// Phase 4 Task 8 (rider 11): the REAL MCP lifecycle, wired into a live session.
// ================================================================================================
describe("Phase 4 Task 8 (rider 11): live MCP lifecycle wiring", () => {
  test("an sdk-configured server appears in system/init.mcp_servers as connected (RULING P4-C, state-only feed)", async () => {
    const { host, runtime } = createInMemoryChannel();
    const config = baseConfig({
      sessionId: "t8-mcp-init",
      mcpServers: { probe: { type: "sdk", name: "probe", tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
    });
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: echoProvider });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const init = frames.find((f) => f.type === "init") as { mcp_servers?: Array<{ name: string; status: string }> } | undefined;
    expect(init?.mcp_servers).toEqual([{ name: "probe", status: "connected" }]);
    // BOTH init shapes carry it -- one computation, two wire shapes (the same invariant
    // conformance.test.ts pins for `tools`).
    const sysInit = dataMessages(frames).find((m) => m.type === "system") as { mcp_servers?: unknown } | undefined;
    expect(sysInit?.mcp_servers).toEqual(init!.mcp_servers);
  });

  test("a session with NO mcpServers builds no lifecycle at all -- mcp_servers stays absent from both init frames", async () => {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({ config: baseConfig({ sessionId: "t8-mcp-none" }), input: runtime.input, output: runtime.output, provider: echoProvider });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const init = frames.find((f) => f.type === "init") as Record<string, unknown>;
    expect("mcp_servers" in init).toBe(false); // conditional presence, never an unconditional []
  });

  test("a CALLER-SUPPLIED mcpServerStateSource still wins over the engine-built lifecycle", async () => {
    const { host, runtime } = createInMemoryChannel();
    const config = baseConfig({
      sessionId: "t8-mcp-precedence",
      mcpServers: { probe: { type: "sdk", name: "probe", tools: [{ name: "echo", inputSchema: { type: "object" } }] } },
    });
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: echoProvider,
      mcpServerStateSource: {
        snapshot: () => [{ name: "injected", state: "failed", toolNames: [] }],
        subscribe: () => () => {},
        waitForPending: async () => [{ name: "injected", state: "failed", toolNames: [] }],
      },
    });
    host.output.write({ type: "user", text: "hi" });
    host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const init = frames.find((f) => f.type === "init") as { mcp_servers?: Array<{ name: string; status: string }> };
    expect(init.mcp_servers).toEqual([{ name: "injected", status: "failed" }]);
  });

  // The end-to-end proof that WS-09 §5's elicitation bridge is genuinely wired to THIS run's own
  // RpcBridge -- the one piece of rider 11 no unit test could cover, because `bridge` is a
  // closure-local inside runEngine with no seam exposing it (which is precisely why Lane A could not
  // perform this integration itself). A REAL http MCP server's tool handler calls
  // `server.elicitInput(...)` mid-call; the host observes a real `mcp_elicitation` control_request
  // on the wire and answers it; the server's own tool result reflects the answer.
  test("a real MCP server's mid-call elicitation reaches the host as an mcp_elicitation control_request, and the answer flows back", async () => {
    await withHttpFixture(
      {
        tools: [
          {
            name: "ask",
            inputSchema: { type: "object", properties: {} },
            handler: async (_args, server) => {
              const answered = await server.elicitInput({
                message: "what is your name?",
                requestedSchema: { type: "object", properties: { name: { type: "string" } } },
              });
              return { content: [{ type: "text", text: `elicited:${answered.action}:${String((answered.content as Record<string, unknown> | undefined)?.name)}` }] };
            },
          },
        ],
      },
      async (url) => {
        const { host, runtime } = createInMemoryChannel();
        const provider = scriptedProvider([
          { kind: "tool_use", calls: [{ id: "c1", name: "mcp__elic__ask", input: {} }] },
          { kind: "text", text: "done" },
        ]);
        const config = baseConfig({
          sessionId: "t8-mcp-elicitation",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          mcpServers: { elic: { type: "http", url: url.href } },
        });
        // MCP_CONNECTION_NONBLOCKING=0 (WS-09 §2): startup WAITS for the connection batch, so the
        // server's tools are registered before the first turn's tool call is dispatched. Without it
        // the nonblocking default returns from start() immediately and this scenario races a
        // background connect -- a real, spec'd behaviour (and precisely why WS-09 §2's `-p`
        // first-turn wait and §8.2's 5 s pending-server wait exist), not a test artifact.
        const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, env: { MCP_CONNECTION_NONBLOCKING: "0" } });
        host.output.write({ type: "user", text: "go" });

        const seen: WinterFrame[] = [];
        let elicitation: ControlRequestFrame | undefined;
        for await (const f of host.input) {
          seen.push(f);
          if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "mcp_elicitation") {
            elicitation = f as ControlRequestFrame;
            break;
          }
          // Fail FAST rather than hanging to the suite timeout if the elicitation never comes: the
          // turn's terminal result means the round finished without one.
          if (f.type === "data" && (f as { message: { type: string } }).message.type === "result") break;
        }
        expect(elicitation, "the engine must forward a server's elicitation to the host over the RpcBridge").toBeDefined();
        expect(elicitation!.payload).toMatchObject({ serverName: "elic", message: "what is your name?" });
        host.output.write({ type: "control_response", requestId: elicitation!.requestId, ok: true, payload: { action: "accept", content: { name: "winter" } } });
        host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
        for await (const f of host.input) seen.push(f);
        await done;

        const toolResult = dataMessages(seen).find((m) => m.type === "user") as { message: { content: Array<{ content: string }> } } | undefined;
        expect(toolResult?.message.content[0]?.content).toBe("elicited:accept:winter");
      },
    );
  }, 20_000);
});

// ================================================================================================
// Phase 4 Task 8: Lane D's messaging tools reach a real runtime in a live session.
// ================================================================================================
test("Phase 4 Task 8: a live session's ListAgents call reaches the real messaging runtime, not the 'no messaging runtime' error", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "c1", name: "ListAgents", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const config = baseConfig({ sessionId: "t8-messaging-live", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider });
  host.output.write({ type: "user", text: "who is around" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;

  const toolResult = dataMessages(frames).find((m) => m.type === "user") as { message: { content: Array<{ content: string }> } } | undefined;
  const text = toolResult?.message.content[0]?.content ?? "";
  expect(text).not.toContain("no messaging runtime");
  expect(text).not.toContain("not yet executable");
  // WS-10 §10.2's pinned output shape: exactly `{ listing: string }`.
  expect(Object.keys(JSON.parse(text))).toEqual(["listing"]);
});

// --- Phase 5 Task 2 (R5-6 -> RULING P5-A): the workspace-trust seam replaces `const
// trustedWorkspace = false` ------------------------------------------------------------------------
//
// engine.ts has carried a hard-`false` trust constant since P2, shared by the permission evaluator,
// the hook registry, the MCP source resolver and the child-rule mirror precisely so those four can
// never disagree. It is now DERIVED, through settings/trust.ts's `defaultTrustSource`, from
// `RuntimeConfig.trustedWorkspace` -- the one disclosed Winter option RULING P5-A adds.
//
// The discriminator is the same one the Phase-ruling-2 test above documents in its own comment: a
// `canUseTool` answer whose `addRules` lands on `projectSettings` becomes a `source: "project"`
// ALLOW rule, which resolveRules'/findMatchingRuleEntry's trust gate makes LIVE-INERT while the
// workspace is untrusted. Two prompts means the project rule never widened; one means it did.
async function countPermissionPromptsWithProjectAllow(config: RuntimeConfig): Promise<number> {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "unmatched_tool", input: {} }] },
    { kind: "tool_use", calls: [{ id: "call2", name: "unmatched_tool", input: {} }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  let prompts = 0;
  for await (const f of host.input) {
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      prompts++;
      const cf = f as ControlRequestFrame;
      const projectAllow: PermissionUpdate = { type: "addRules", rules: [{ toolName: "unmatched_tool" }], behavior: "allow", destination: "projectSettings" };
      const result: PermissionResult = { behavior: "allow", updatedPermissions: [projectAllow] };
      host.output.write({ type: "control_response", requestId: cf.requestId, ok: true, payload: result });
    }
  }
  await done;
  return prompts;
}

test("P5 T2: with no trustedWorkspace declared, a project-sourced ALLOW stays live-inert -- byte-identical to the P2 hard-false constant", async () => {
  expect(await countPermissionPromptsWithProjectAllow(baseConfig())).toBe(2);
});

test("P5 T2: RuntimeConfig.trustedWorkspace:false is the same fail-closed verdict as omitting it", async () => {
  expect(await countPermissionPromptsWithProjectAllow(baseConfig({ trustedWorkspace: false }))).toBe(2);
});

test("P5 T2: RuntimeConfig.trustedWorkspace:true makes the project-sourced ALLOW live -- the seam really is wired into the engine's one trust constant", async () => {
  expect(await countPermissionPromptsWithProjectAllow(baseConfig({ trustedWorkspace: true }))).toBe(1);
});

// --- Phase 5 Task 2 (derived-shapes-p5.md item (b)): system/init's pinned loaded-surface fields ----
//
// `sdk.d.ts:4853-4913`: `slash_commands: string[]`, `terminal_slash_commands?: string[]`,
// `output_style: string` (REQUIRED), `skills: string[]` (REQUIRED), `plugins: {name,path,version?}[]`.
// Task 1's item (b) is explicit that a Winter init frame omitting the two required ones DIVERGES --
// so they are emitted now, with Winter defaults, and Task 8 populates them once the skill/command/
// plugin registries exist.
test("P5 T2: system/init carries the pinned slash_commands/output_style/skills/plugins fields", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;

  const init = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "init") as Record<string, unknown>;
  expect(init["slash_commands"]).toEqual([]);
  expect(init["skills"]).toEqual([]);
  expect(init["plugins"]).toEqual([]);
  expect(init["output_style"]).toBe("default");
  // Optional on the pin, and Winter has no terminal-bound command surface -- absent, not `[]`.
  expect(init).not.toHaveProperty("terminal_slash_commands");
});

test("P5 T2: a configured outputStyle is what system/init.output_style reports", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({ config: baseConfig({ outputStyle: "explanatory" }), input: runtime.input, output: runtime.output, provider: echoProvider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;

  const init = dataMessages(frames).find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "init") as Record<string, unknown>;
  expect(init["output_style"]).toBe("explanatory");
});

// --- WS-13c §7 (P6.6 spine): the `list_model_families` control handler ----------------------------
//
// The handler is payload-free and Winter-only, beside `list_models`. What this pins is the ABSENT
// case, which is the one a scripted double actually hits: an engine wired with no producer must
// still ANSWER, and answer with the shape `Query.listModelFamilies()` decodes — `active: undefined`
// (no effective model to derive a family from) beside an empty `families` array. A handler that
// answered `ok: false`, or that was simply missing and left the request unanswered, would hang the
// caller's control-request promise rather than telling it there is nothing to list.
test("WS-13c: `list_model_families` answers `{ active: undefined, families: [] }` when no producer is wired", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([{ kind: "text", text: "done" }]);
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
  host.output.write({ type: "control_request", requestId: "fam1", subtype: "list_model_families", payload: undefined });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;

  const reply = frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "fam1") as ControlResponseFrame | undefined;
  expect(reply).toBeDefined();
  expect(reply!.ok).toBe(true);
  // `active: undefined` and `families: []` are DIFFERENT statements — the first is "this session has
  // no effective model", the second "there are no families" — so both are asserted, not just the key set.
  expect((reply as unknown as { payload: { active: unknown; families: unknown[] } }).payload.active).toBeUndefined();
  expect((reply as unknown as { payload: { active: unknown; families: unknown[] } }).payload.families).toEqual([]);
});

test("WS-13c: a wired `listModelFamilies` producer is what the handler answers with", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([{ kind: "text", text: "done" }]);
  const listing = {
    active: { family: "gpt", source: "family-default" as const, slots: [{ name: "astra", canonicalModelId: "gpt-6-astra", description: "d", reason: "r" }] },
    families: [{ id: "gpt", displayName: "GPT", vendor: "OpenAI", slots: [], models: [] }],
  };
  const done = runEngine({
    config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor,
    listModelFamilies: () => listing,
  });
  host.output.write({ type: "control_request", requestId: "fam2", subtype: "list_model_families", payload: undefined });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });
  const frames = await drain(host.input);
  await done;

  const reply = frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "fam2") as ControlResponseFrame | undefined;
  expect(reply?.ok).toBe(true);
  expect((reply as unknown as { payload: unknown }).payload).toEqual(listing);
});
