// Phase 5 Task 7 (Lane K, R5-4): retention selection -- "the last N user/assistant pairs with their
// tool results intact". The seam authority (compaction/seam.contract.test.ts) pins that the engine
// takes `retained` LITERALLY, so everything a compaction keeps is decided HERE.
import { test, expect, describe } from "bun:test";
import type { ProviderMessage } from "../engine.ts";
import { DEFAULT_RETAINED_PAIRS, evidencedToolNames, selectRetention } from "./retention.ts";

const user = (text: string): ProviderMessage => ({ role: "user", content: text });
const assistant = (text: string): ProviderMessage => ({ role: "assistant", content: text });
const toolUse = (id: string, name: string): ProviderMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] });
const toolResult = (id: string, out: string): ProviderMessage => ({ role: "tool", content: [{ type: "tool_result", tool_use_id: id, content: out }] });

/** Four complete turns, the last one still mid-flight (its prompt has no reply yet). */
function conversation(): ProviderMessage[] {
  return [
    user("turn one"),
    assistant("reply one"),
    user("turn two"),
    assistant("reply two"),
    user("turn three"),
    assistant("reply three"),
    user("turn four"),
  ];
}

describe("compaction/retention.ts -- selectRetention", () => {
  test("the default window is 4 pairs", () => {
    expect(DEFAULT_RETAINED_PAIRS).toBe(4);
  });

  test("retains the last N turns and hands everything before them to the summarizer", () => {
    const messages = [user("t1"), assistant("r1"), user("t2"), assistant("r2"), user("t3"), assistant("r3"), user("t4"), assistant("r4"), user("t5")];
    const plan = selectRetention(messages, { pairs: 2 });
    // Two turn STARTS from the end: "t4" opens one, "t5" opens the other.
    expect(plan.retained.map((m) => m.content)).toEqual(["t4", "r4", "t5"]);
    expect(plan.summarized.map((m) => m.content)).toEqual(["t1", "r1", "t2", "r2", "t3", "r3"]);
  });

  test("a tool round is never split: the results stay with the assistant message that called them", () => {
    const messages = [
      user("t1"),
      assistant("r1"),
      user("t2"),
      toolUse("c1", "Bash"),
      toolResult("c1", "ok"),
      assistant("r2"),
      user("t3"),
    ];
    const plan = selectRetention(messages, { pairs: 2 });
    // The cut lands on "t2" -- a turn start -- so `c1`'s tool_use and its tool_result are on the
    // SAME side. A cut that landed on the tool_result would hand the provider an orphan.
    expect(plan.retained[0]).toEqual(user("t2"));
    expect(plan.retained).toHaveLength(5);
    expect(plan.summarized.map((m) => m.content)).toEqual(["t1", "r1"]);
  });

  test("the cut NEVER lands on a tool message, whatever the window", () => {
    const messages = [user("t1"), toolUse("c1", "Bash"), toolResult("c1", "ok"), toolUse("c2", "Read"), toolResult("c2", "ok"), assistant("done"), user("t2")];
    for (const pairs of [1, 2, 3, 4, 5, 6]) {
      const plan = selectRetention(messages, { pairs });
      expect(plan.retained[0]?.role).not.toBe("tool");
    }
  });

  test("with fewer turns than the window it degrades to ROUND starts rather than folding nothing", () => {
    // One long agentic turn -- exactly where a context window actually fills. There is only one
    // turn start (index 0), so a turn-start-only rule could never compact this at all.
    const messages = [user("go"), toolUse("c1", "Bash"), toolResult("c1", "a"), toolUse("c2", "Bash"), toolResult("c2", "b"), toolUse("c3", "Bash"), toolResult("c3", "c")];
    const plan = selectRetention(messages, { pairs: 2 });
    expect(plan.summarized.length).toBeGreaterThan(0);
    expect(plan.retained[0]?.role).toBe("assistant");
    expect(plan.retained.length).toBeLessThan(messages.length);
  });

  test("nothing foldable is reported as such -- retention never returns the whole input", () => {
    // A conversation that is only the envelope's own un-answered prompt. Summarizing it and
    // retaining it would leave the history LONGER than it started.
    expect(selectRetention([user("only the prompt")], { pairs: 4 }).foldable).toBe(false);
    expect(selectRetention([], { pairs: 4 }).foldable).toBe(false);
    expect(selectRetention(conversation(), { pairs: 4 }).foldable).toBe(false); // exactly 4 turns, nothing older
    expect(selectRetention([...conversation(), assistant("reply four"), user("turn five")], { pairs: 4 }).foldable).toBe(true);
  });

  test("a user message carrying only tool_result blocks is NOT a turn start", () => {
    // Defensive: the engine puts tool results on `role: "tool"`, but a future producer that put
    // them on `user` must not make every tool round look like a new conversational turn.
    const carrier: ProviderMessage = { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] };
    const messages = [user("t1"), assistant("r1"), user("t2"), toolUse("c1", "Bash"), carrier, assistant("r2"), user("t3")];
    const plan = selectRetention(messages, { pairs: 2 });
    expect(plan.retained[0]).toEqual(user("t2"));
  });
});

describe("compaction/retention.ts -- evidencedToolNames", () => {
  test("names every tool the retained messages still show being called, first-appearance order", () => {
    const retained = [user("t"), toolUse("c1", "Bash"), toolResult("c1", "ok"), toolUse("c2", "Read"), toolResult("c2", "ok"), toolUse("c3", "Bash")];
    expect(evidencedToolNames(retained)).toEqual(["Bash", "Read"]);
  });

  test("a tool whose evidence was summarized away is NOT evidenced", () => {
    const messages = [user("t1"), toolUse("c1", "Grep"), toolResult("c1", "ok"), assistant("r1"), user("t2"), toolUse("c2", "Bash"), toolResult("c2", "ok"), assistant("r2"), user("t3")];
    const plan = selectRetention(messages, { pairs: 2 });
    expect(evidencedToolNames(plan.retained)).toEqual(["Bash"]);
    expect(evidencedToolNames(plan.retained)).not.toContain("Grep");
  });

  test("no tool evidence at all is an empty list, never undefined", () => {
    expect(evidencedToolNames([user("a"), assistant("b")])).toEqual([]);
  });
});
