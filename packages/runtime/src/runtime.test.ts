import { test, expect } from "bun:test";
import { createInMemoryChannel } from "./protocol/channel.ts";
import { runWinterRuntime } from "./runtime.ts";
import { echoProvider } from "./provider/mock.ts";
import type { ProviderTurn } from "./engine.ts";
import type { ProtocolSdkMessage as SdkMessage, WinterFrame } from "@yanlinglabs/winter-agent-sdk";

async function collect(source: AsyncIterable<WinterFrame>, until: (f: WinterFrame) => boolean): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) { out.push(f); if (until(f)) break; }
  return out;
}

test("runtime emits init, then assistant + success result for a user turn", async () => {
  const { host, runtime } = createInMemoryChannel();
  const done = runWinterRuntime({ input: runtime.input, output: runtime.output, provider: echoProvider, sessionId: "s1", cwd: "/tmp/x", model: "sonnet" });
  host.output.write({ type: "user", text: "ping" });
  const frames = await collect(host.input, (f) => f.type === "data" && (f as { message: SdkMessage }).message.type === "result");
  host.output.end();
  await done;

  expect(frames[0]!.type).toBe("init");
  const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
  expect(messages.map((m) => m.type)).toEqual(["system", "assistant", "result"]);
  const assistant = messages[1] as Extract<SdkMessage, { type: "assistant" }>;
  expect(assistant.message.content[0]).toEqual({ type: "text", text: "echo: ping" });
  const result = messages[2] as Extract<SdkMessage, { type: "result" }>;
  expect(result.subtype).toBe("success");
  expect(result.is_error).toBeFalsy();
});

test("a provider throw yields a single error result, not a crash", async () => {
  const { host, runtime } = createInMemoryChannel();
  // Task 3: Provider moved from prompt-based to messages-based (ProviderTurn return) — this test's
  // shape updates to match; its assertions (subtype/is_error, not exact text) are unaffected.
  const boom = { async generate(): Promise<ProviderTurn> { throw new Error("provider down"); } };
  const done = runWinterRuntime({ input: runtime.input, output: runtime.output, provider: boom, sessionId: "s2", cwd: "/tmp/x", model: "sonnet" });
  host.output.write({ type: "user", text: "ping" });
  const frames = await collect(host.input, (f) => f.type === "data" && (f as { message: SdkMessage }).message.type === "result");
  host.output.end(); await done;
  const result = (frames.at(-1) as { message: SdkMessage }).message as Extract<SdkMessage, { type: "result" }>;
  expect(result.type).toBe("result");
  expect(result.is_error).toBe(true);
  expect(result.subtype).toBe("error_during_execution");
});
