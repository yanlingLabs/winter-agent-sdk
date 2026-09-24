import { describe, expect, test } from "bun:test";
import { scriptedProvider } from "./mock.ts";
import type { ProviderRequest } from "../engine.ts";

// Fix round 22: the mock family's synthetic usage (`syntheticUsage`, a chars/4 estimate) claims to be
// "deterministic by construction: the same request and the same turn always produce the same numbers,
// on every leg and every run". An Agent tool result carries the child's wall-clock `totalDurationMs`
// (claude's own result shape), so two otherwise-identical requests differed only in that number's digit
// count -- and a child finishing in 96 ms on one transport leg and 101 ms on another moved
// `usage.input_tokens` by one. That surfaced as sdk transport-equivalence.test.ts's "rider 25"
// (`payload@7 (result) differs`, 2909 vs 2908) and its "Task 8: SendMessage ... RESUMES" flake.
describe("mock provider synthetic usage (fix round 22)", () => {
  const agentResult = (durationMs: number): string =>
    JSON.stringify({ agentId: "00000000-0000-4000-8000-000000000000", agentType: "general-purpose", content: [{ type: "text", text: "child finished" }], totalToolUseCount: 0, totalDurationMs: durationMs, resolvedModel: "winter-test/echo", prompt: "child probe text" });
  const requestWith = (durationMs: number): ProviderRequest =>
    ({
      system: "system prompt",
      messages: [
        { role: "user", content: "run the subagent" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: agentResult(durationMs) }] },
      ],
    }) as unknown as ProviderRequest;

  test("an Agent result's wall-clock totalDurationMs does not change the synthetic usage (96 ms vs 101 ms vs 12345 ms)", async () => {
    const usageFor = async (durationMs: number) => (await scriptedProvider([{ kind: "text", text: "parent finished" }]).generate(requestWith(durationMs))).usage;
    const base = await usageFor(96);
    expect(await usageFor(101)).toEqual(base);
    expect(await usageFor(12345)).toEqual(base);
  });

  test("control: any OTHER change to the request still changes the synthetic usage", async () => {
    const provider = () => scriptedProvider([{ kind: "text", text: "parent finished" }]);
    const a = (await provider().generate(requestWith(96))).usage;
    const longer = requestWith(96);
    (longer.messages as Array<{ role: string; content: unknown }>)[0]!.content = "run the subagent, and then some more words to lengthen the request";
    const b = (await provider().generate(longer)).usage;
    expect(b).not.toEqual(a);
  });
});
