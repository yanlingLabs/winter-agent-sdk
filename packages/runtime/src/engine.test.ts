import { test, expect } from "bun:test";
import type { RuntimeConfig, WinterFrame, ControlResponseFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runEngine, type Provider, type ProviderMessage } from "./engine.ts";
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
