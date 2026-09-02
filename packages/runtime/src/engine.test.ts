import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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
  expect(result).toEqual({ type: "result", subtype: "success", is_error: false, result: "rpc reply: pong" });
  expect(code).toBe(0);
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
    expect(msgs.map((m) => m.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
    const toolResultMsg = msgs[2] as { message: { content: unknown } };
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
  expect(result).toEqual({ type: "result", subtype: "success", is_error: false, interrupted: true });

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
