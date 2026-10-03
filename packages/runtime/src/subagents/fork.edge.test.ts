// Edge cases of `buildForkInitialMessages`' history filter: which messages count as carrying an
// unanswered tool_use, where an answer may sit, and which dropped message the clone is taken from.
// Every expectation here is the current behaviour, recorded.
import { describe, expect, test } from "bun:test";
import type { ContentBlock, ProviderMessage } from "../engine.ts";
import { FORK_PLACEHOLDER_TOOL_RESULT, buildForkInitialMessages } from "./fork.ts";

const use = (id: string, name = "Agent"): Extract<ContentBlock, { type: "tool_use" }> => ({ type: "tool_use", id, name, input: {} });
const result = (id: string): ContentBlock => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const placeholder = (id: string): ProviderMessage => ({ role: "tool", content: [{ type: "tool_result", tool_use_id: id, content: FORK_PLACEHOLDER_TOOL_RESULT }] });

describe("buildForkInitialMessages: what is dropped", () => {
  test("only ASSISTANT messages with array content are ever dropped -- a user or tool message carrying an unanswered tool_use is kept", () => {
    const messages: ProviderMessage[] = [
      { role: "user", content: [use("u1")] },
      { role: "tool", content: [use("t1")] },
      { role: "assistant", content: "plain text" },
    ];
    expect(buildForkInitialMessages({ messages }, "u1")).toEqual(messages);
  });

  test("an assistant message with no tool_use at all is kept", () => {
    const messages: ProviderMessage[] = [{ role: "assistant", content: [{ type: "text", text: "thinking aloud" }] }];
    expect(buildForkInitialMessages({ messages }, "x")).toEqual(messages);
  });

  test("an answer anywhere in the list counts -- before the call, or inside a user-role message", () => {
    const messages: ProviderMessage[] = [
      { role: "tool", content: [result("a")] },
      { role: "assistant", content: [use("a")] },
      { role: "assistant", content: [use("b")] },
      { role: "user", content: [result("b")] },
    ];
    expect(buildForkInitialMessages({ messages }, "a")).toEqual(messages);
  });

  test("one unanswered tool_use among answered ones drops the whole message", () => {
    const messages: ProviderMessage[] = [
      { role: "assistant", content: [use("done"), use("fork")] },
      { role: "tool", content: [result("done")] },
    ];
    expect(buildForkInitialMessages({ messages }, "fork")).toEqual([messages[1]!, { role: "assistant", content: [use("fork")] }, placeholder("fork")]);
  });

  test("every unanswered assistant message is dropped, not only the last", () => {
    const messages: ProviderMessage[] = [
      { role: "assistant", content: [use("old")] },
      { role: "user", content: "next" },
      { role: "assistant", content: [use("fork")] },
    ];
    expect(buildForkInitialMessages({ messages }, "fork")).toEqual([messages[1]!, { role: "assistant", content: [use("fork")] }, placeholder("fork")]);
  });

  test("kept messages are the same objects, in their original order", () => {
    const first: ProviderMessage = { role: "user", content: "a" };
    const second: ProviderMessage = { role: "assistant", content: "b" };
    const out = buildForkInitialMessages({ messages: [first, { role: "assistant", content: [use("f")] }, second] }, "f");
    expect(out[0]).toBe(first);
    expect(out[1]).toBe(second);
  });
});

describe("buildForkInitialMessages: the clone", () => {
  test("an already-answered fork id is not cloned: the filtered history comes back with nothing appended", () => {
    const messages: ProviderMessage[] = [
      { role: "assistant", content: [use("fork")] },
      { role: "tool", content: [result("fork")] },
      { role: "assistant", content: [use("other")] },
    ];
    expect(buildForkInitialMessages({ messages }, "fork")).toEqual(messages.slice(0, 2));
  });

  test("when two dropped messages both carry the fork id, the FIRST supplies the clone (and its origin)", () => {
    const origin1 = { providerId: "p1", modelKey: "p1/m", family: "f1" } as NonNullable<ProviderMessage["origin"]>;
    const origin2 = { providerId: "p2", modelKey: "p2/m", family: "f2" } as NonNullable<ProviderMessage["origin"]>;
    const firstUse = { ...use("dup"), name: "First" };
    const messages: ProviderMessage[] = [
      { role: "assistant", content: [firstUse], origin: origin1 },
      { role: "assistant", content: [use("dup", "Second")], origin: origin2 },
    ];
    expect(buildForkInitialMessages({ messages }, "dup")).toEqual([{ role: "assistant", content: [firstUse], origin: origin1 }, placeholder("dup")]);
  });

  test("a duplicated id inside one message: the first matching block is cloned", () => {
    const a = { ...use("dup"), name: "A" };
    const b = { ...use("dup"), name: "B" };
    expect(buildForkInitialMessages({ messages: [{ role: "assistant", content: [a, b] }] }, "dup")).toEqual([{ role: "assistant", content: [a] }, placeholder("dup")]);
  });

  test("a clone of a message with no origin has no origin key at all", () => {
    const out = buildForkInitialMessages({ messages: [{ role: "assistant", content: [use("f")] }] }, "f");
    expect(Object.keys(out[0]!).sort()).toEqual(["content", "role"]);
  });

  test("an empty history yields an empty array", () => {
    expect(buildForkInitialMessages({ messages: [] }, "f")).toEqual([]);
  });
});
