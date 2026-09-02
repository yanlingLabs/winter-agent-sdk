import { test, expect, spyOn } from "bun:test";
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
import { runEngine, type Provider, type ProviderMessage, type ContentBlock, type ToolExecutor } from "./engine.ts";
import { echoProvider, scriptedProvider, stubExecutor } from "./provider/mock.ts";
import { inMemoryProcess } from "./testing.ts";
import { WinterPermissionError } from "./permissions/policy-state.ts";
import { createInMemoryApprovalStore, createFileDurableApprovalStore, WINTER_RUNTIME_KIND, type DurableApprovalStore, type DurableApprovalRecord } from "./permissions/approvals.ts";

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
  sessionId: "s", cwd: "/tmp/x", model: "sonnet", ...overrides,
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

// --- Task 2 (WS-04 §3.1, direction inversion): the pump now ALSO routes incoming control_response
// frames (host->runtime) to the bridge's handleResponse — the mirror of the pre-existing
// control_request handling. rpc_probe is the P1-only ProviderTurn kind that exercises this: the
// engine performs bridge.request() on the scripted provider's behalf and embeds the host's answer
// in the turn's reply (see engine.ts's round loop, and provider/mock.ts's "rpcprobe" arm / the
// transport-equivalence suite's cross-leg scenario for the same round trip on a real/compiled
// child).

test("Task 2: a rpc_probe turn writes a runtime-originated control_request; the pump routes the host's control_response back to it and the reply embeds the answer", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider: Provider = {
    async generate() {
      return { kind: "rpc_probe", subtype: "test_rpc_probe", payload: { probe: "ping" } };
    },
  };
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

  host.output.write({ type: "user", text: "go" });

  const seen: WinterFrame[] = [];
  let reqId: string | undefined;
  let reqPayload: unknown;
  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "control_request") {
      reqId = (f as ControlRequestFrame).requestId;
      reqPayload = (f as ControlRequestFrame).payload;
      break;
    }
  }
  expect(reqId).toBeDefined();
  expect(reqPayload).toEqual({ probe: "ping" });

  host.output.write({ type: "control_response", requestId: reqId!, ok: true, payload: { text: "pong" } });
  host.output.write({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined });

  for await (const f of host.input) {
    seen.push(f);
    if (f.type === "data" && (f as { message: SdkMessage }).message.type === "result") break;
  }
  const rest = await drain(host.input);
  seen.push(...rest);
  const code = await done;

  const msgs = dataMessages(seen);
  const assistantMsg = msgs.find((m) => m.type === "assistant") as { message: { content: unknown } };
  expect(assistantMsg.message.content).toEqual([{ type: "text", text: "rpc reply: pong" }]);
  const result = msgs.find((m) => m.type === "result");
  // Finding 3 (P2 fix-wave): permission_denials is now always present -- [] here, this turn denied nothing.
  expect(result).toEqual({ type: "result", subtype: "success", is_error: false, result: "rpc reply: pong", permission_denials: [] });
  expect(code).toBe(0);
});

// --- Task 10 (WS-08 §1/§9/§10): the real hooks engine wired into engine.ts --------------------
//
// Proves each of the seven engine-lifecycle call sites actually fires a REAL "hook"
// control_request through the real registry (built from config.hooks) + the real bridge — not
// merely at the runner.ts/hook-stage.ts layer, which already covers interpretation of a hook's
// ANSWER exhaustively. One hook per event, answered generically ({ok:true, payload:{}}); this
// test's own job is "did the right RPC fire, in the right order, with the right identity."

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
  const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: scripted, tools: stubExecutor });

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
    const config: RuntimeConfig = { sessionId, cwd, model: "sonnet", disallowedTools: ["test_tool"], allowedTools: ["other_tool"] };
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
    const config: RuntimeConfig = { sessionId, cwd, model: "sonnet" }; // zero rules: BOTH calls start unmatched
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

// WS-07 §2's stale-policy-rejection contract, exercised for the first time with a GENUINE async
// window: evaluateWithFreshPolicy (T6, unchanged by Task 8) already re-evaluates when
// policyStateStore's version moved on while an evaluate() call was in flight — but with the T6/T7
// stub PromptStage (a synchronous null, no real await), there was no real-world window during which
// a permission RPC specifically could straddle a policy change. The real, bridge-backed PromptStage
// is what makes this scenario possible to construct at all.
test("Task 8/WS-07 §2: a permission answer computed under a policy that changed WHILE the RPC was in flight is discarded and re-evaluated fresh", async () => {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] }]);
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
  const provider = scriptedProvider([{ kind: "tool_use", calls: [{ id: "call1", name: "mystery_tool", input: {} }] }]);
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
  const config1: RuntimeConfig = { sessionId, cwd, model: "sonnet", winterHome: home, hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } };
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
  const config2: RuntimeConfig = { sessionId, resume: sessionId, cwd, model: "sonnet", winterHome: home };
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
  const config3: RuntimeConfig = { sessionId, resume: sessionId, cwd, model: "sonnet", winterHome: home };
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

  const config1: RuntimeConfig = { sessionId, cwd, model: "sonnet", winterHome: home, hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } };
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
  const config2: RuntimeConfig = { sessionId, resume: sessionId, cwd, model: "sonnet", winterHome: home, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
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

  const config1: RuntimeConfig = { sessionId, cwd: workDir, model: "sonnet", winterHome: home, hooks: { PreToolUse: [{ hookCount: 1, source: "sdk" }] } };
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
  const config2: RuntimeConfig = { sessionId, resume: sessionId, cwd: workDir, model: "sonnet", winterHome: home };
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
