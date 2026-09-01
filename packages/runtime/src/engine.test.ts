import { test, expect } from "bun:test";
import type { RuntimeConfig, WinterFrame, ControlResponseFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type Provider, type ProviderMessage, type ContentBlock, type ToolExecutor } from "./engine.ts";
import { echoProvider, scriptedProvider, stubExecutor } from "./provider/mock.ts";

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
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

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
  const done = runEngine({ config: baseConfig({ maxTurns: 1 }), input: runtime.input, output: runtime.output, provider, tools: stubExecutor });

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
  expect(result).toEqual({ type: "result", subtype: "success", is_error: false, interrupted: true });

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
  const done = runEngine({ config: baseConfig({ maxTurns: 1 }), input: runtime.input, output: runtime.output, provider, tools: countingExecutor });

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
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: blockingTools });

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
  const done = runEngine({ config: baseConfig(), input: runtime.input, output: runtime.output, provider, tools: throwingTools });

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
