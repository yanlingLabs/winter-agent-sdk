// Phase 5 Task 7 (Lane K, R5-4): the real CompactionController -- threshold policy, Winter's own
// summary instruction over the SESSION's provider, retention, and the evidenced-tool report.
//
// The seam authority is `compaction/seam.contract.test.ts` (the engine owns the sequence around
// this); what is proven here is everything the seam deliberately left to the lane.
import { test, expect, describe } from "bun:test";
import { createContextAccountant, type ProviderMessage, type ProviderRequest, type Provider, type ProviderTurn } from "../engine.ts";
import { createCompactionController, DEFAULT_COMPACTION_THRESHOLD } from "./controller.ts";
import { WINTER_SUMMARY_INSTRUCTION } from "./summarizer.ts";

const user = (text: string): ProviderMessage => ({ role: "user", content: text });
const assistant = (text: string): ProviderMessage => ({ role: "assistant", content: text });
const toolUse = (id: string, name: string, input: unknown = {}): ProviderMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const toolResult = (id: string, out: string): ProviderMessage => ({ role: "tool", content: [{ type: "tool_result", tool_use_id: id, content: out }] });

/** Records every request it is handed and answers with the next scripted summary. */
function recordingProvider(...texts: string[]): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const scripted = texts.length > 0 ? texts : ["THE SUMMARY"];
  let i = 0;
  return {
    requests,
    provider: {
      async generate(input: ProviderRequest): Promise<ProviderTurn> {
        requests.push(input);
        return { kind: "text", text: scripted[Math.min(i++, scripted.length - 1)]! };
      },
    },
  };
}

/** Six turns: enough that a 4-pair window still leaves something to fold. */
function longConversation(): ProviderMessage[] {
  return [
    user("turn one"),
    assistant("reply one"),
    user("turn two"),
    assistant("reply two"),
    user("turn three"),
    toolUse("c1", "Grep", { pattern: "x" }),
    toolResult("c1", "no matches"),
    assistant("reply three"),
    user("turn four"),
    assistant("reply four"),
    user("turn five"),
    toolUse("c2", "Bash", { command: "ls" }),
    toolResult("c2", "a.ts"),
    assistant("reply five"),
    user("turn six"),
  ];
}

describe("compaction/controller.ts -- shouldCompact (R5-4's formula, the lane's to own)", () => {
  test("fires at exactly `compactionThreshold x limit()` and not one token before", () => {
    const controller = createCompactionController({ compactionThreshold: 0.5 });
    const accountant = createContextAccountant({ limit: 1000 });
    accountant.record({ inputTokens: 499, outputTokens: 0 });
    expect(controller.shouldCompact(accountant)).toBe(false);
    accountant.record({ inputTokens: 500, outputTokens: 0 });
    expect(controller.shouldCompact(accountant)).toBe(true);
  });

  test("the default threshold is 0.92 and comes from the SDK's own declared constant", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.92);
    const controller = createCompactionController();
    const accountant = createContextAccountant({ limit: 100_000 });
    accountant.record({ inputTokens: 91_999, outputTokens: 0 });
    expect(controller.shouldCompact(accountant)).toBe(false);
    accountant.record({ inputTokens: 92_000, outputTokens: 0 });
    expect(controller.shouldCompact(accountant)).toBe(true);
  });

  test("a threshold outside (0, 1] is IGNORED -- the default stands rather than a session that compacts every round or never", () => {
    const accountant = createContextAccountant({ limit: 1000 });
    accountant.record({ inputTokens: 500, outputTokens: 0 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createCompactionController({ compactionThreshold: bad }).shouldCompact(accountant)).toBe(false);
    }
    // 1 is legal -- "compact only when the window is genuinely full".
    accountant.record({ inputTokens: 1000, outputTokens: 0 });
    expect(createCompactionController({ compactionThreshold: 1 }).shouldCompact(accountant)).toBe(true);
  });

  test("NO hysteresis of its own: an unchanged reading over the threshold still answers true", () => {
    // The engine already suppresses the ASK while the accountant has not moved since the last
    // compaction (compaction/seam.contract.test.ts's re-entrancy case). A second guard here would
    // stack with it and silently skip a legitimate second compaction in one turn.
    const controller = createCompactionController({ compactionThreshold: 0.5 });
    const accountant = createContextAccountant({ limit: 1000 });
    accountant.record({ inputTokens: 900, outputTokens: 0 });
    expect(controller.shouldCompact(accountant)).toBe(true);
    expect(controller.shouldCompact(accountant)).toBe(true);
    expect(controller.shouldCompact(accountant)).toBe(true);
  });
});

describe("compaction/controller.ts -- compact()", () => {
  test("summarizes through the SESSION's provider, with Winter's own instruction as the system prompt", async () => {
    const { provider, requests } = recordingProvider("A SUMMARY");
    const controller = createCompactionController();
    const accountant = createContextAccountant({ limit: 1000 });
    accountant.record({ inputTokens: 700, outputTokens: 60 });

    const result = await controller.compact({ messages: longConversation(), trigger: "auto", customInstructions: null, accountant, provider });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.system).toBe(WINTER_SUMMARY_INSTRUCTION);
    expect(result.summary).toBe("A SUMMARY");
    // `preTokens` is the reading BEFORE the summarizer ran -- lands on compact_metadata.pre_tokens.
    expect(result.preTokens).toBe(760);
  });

  test("retention keeps the last 4 turns by default, with their tool rounds intact", async () => {
    const { provider } = recordingProvider();
    const controller = createCompactionController();
    const accountant = createContextAccountant({ limit: 1000 });
    const result = await controller.compact({ messages: longConversation(), trigger: "auto", customInstructions: null, accountant, provider });

    // Turns three, four, five and six survive; turns one and two are what the summary replaces.
    expect(result.retained[0]).toEqual(user("turn three"));
    expect(result.retained.map((m) => (typeof m.content === "string" ? m.content : m.content[0]!.type))).toEqual([
      "turn three",
      "tool_use",
      "tool_result",
      "reply three",
      "turn four",
      "reply four",
      "turn five",
      "tool_use",
      "tool_result",
      "reply five",
      "turn six",
    ]);
    // The retained list is never the whole input -- the engine takes it literally and would grow.
    expect(result.retained.length).toBeLessThan(longConversation().length);
  });

  test("`retainedPairs` is an option", async () => {
    const { provider } = recordingProvider();
    const result = await createCompactionController({ retainedPairs: 1 }).compact({
      messages: longConversation(),
      trigger: "auto",
      customInstructions: null,
      accountant: createContextAccountant({ limit: 1000 }),
      provider,
    });
    expect(result.retained).toEqual([user("turn six")]);
  });

  test("evidencedToolNames names the deferred tools the RETAINED messages still show being called", async () => {
    const { provider } = recordingProvider();
    const result = await createCompactionController({ retainedPairs: 2 }).compact({
      messages: longConversation(),
      trigger: "auto",
      customInstructions: null,
      accountant: createContextAccountant({ limit: 1000 }),
      provider,
    });
    // Turn five's Bash call survives; turn three's Grep was summarized away, so the model can no
    // longer see evidence of having loaded it (WS-09 §8.5).
    expect(result.evidencedToolNames).toEqual(["Bash"]);
  });

  test("OPAQUE PROVIDER STATE never reaches the summarizer -- not the fields, not the blocks", async () => {
    const { provider, requests } = recordingProvider();
    // Two shapes a future provider phase could introduce (Global Constraints): an opaque field on
    // the message object itself, and a reasoning/thinking block inside the content array. Neither
    // exists on ProviderMessage today, which is exactly why this must be pinned NOW -- a summary is
    // model-readable text and is persisted as such, so the redaction has to be a positive rebuild
    // from known shapes, never a denylist of the ones that happen to exist.
    const opaqueField = { role: "assistant", content: "reply one", encrypted_content: "OPAQUE-ENCRYPTED-BLOB" } as unknown as ProviderMessage;
    const opaqueBlock = { role: "assistant", content: [{ type: "reasoning_item", itemJson: "OPAQUE-REASONING-JSON" }, { type: "text", text: "visible reply" }] } as unknown as ProviderMessage;
    const messages: ProviderMessage[] = [user("turn one"), opaqueField, opaqueBlock, user("turn two"), assistant("reply two"), user("turn three"), assistant("reply three"), user("turn four"), assistant("reply four"), user("turn five")];

    await createCompactionController({ retainedPairs: 2 }).compact({ messages, trigger: "auto", customInstructions: null, accountant: createContextAccountant({ limit: 1000 }), provider });

    const wire = JSON.stringify(requests[0]!.messages);
    expect(wire).not.toContain("OPAQUE-ENCRYPTED-BLOB");
    expect(wire).not.toContain("OPAQUE-REASONING-JSON");
    expect(wire).not.toContain("encrypted_content");
    expect(wire).not.toContain("reasoning_item");
    // ...and the legible half of the same message DID survive, so this is redaction, not a drop.
    expect(wire).toContain("visible reply");
  });

  test("the summarizer input carries only user/assistant roles and flattened text", async () => {
    const { provider, requests } = recordingProvider();
    await createCompactionController({ retainedPairs: 1 }).compact({
      messages: longConversation(),
      trigger: "auto",
      customInstructions: null,
      accountant: createContextAccountant({ limit: 1000 }),
      provider,
    });
    const sent = requests[0]!.messages;
    expect(sent.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    expect(sent.every((m) => typeof m.content === "string")).toBe(true);
    // A tool round is legible in the summarizer's input rather than erased: the call names its tool
    // and the result contributes its own text.
    const joined = sent.map((m) => m.content as string).join("\n");
    expect(joined).toContain("Grep");
    expect(joined).toContain("no matches");
  });

  test("customInstructions are FOLDED INTO the instruction on a manual run, never dropped", async () => {
    const { provider, requests } = recordingProvider();
    await createCompactionController().compact({
      messages: longConversation(),
      trigger: "manual",
      customInstructions: "keep the API decisions",
      accountant: createContextAccountant({ limit: 1000 }),
      provider,
    });
    const system = requests[0]!.system!;
    expect(system).toContain(WINTER_SUMMARY_INSTRUCTION);
    expect(system).toContain("keep the API decisions");
    // The caller's text is clearly attributed, not spliced into Winter's own sentences.
    expect(system.indexOf("keep the API decisions")).toBeGreaterThan(system.indexOf(WINTER_SUMMARY_INSTRUCTION));
  });

  test("a null customInstructions leaves the instruction byte-identical to the auto path", async () => {
    const { provider, requests } = recordingProvider();
    const controller = createCompactionController();
    const common = { messages: longConversation(), accountant: createContextAccountant({ limit: 1000 }), provider };
    await controller.compact({ ...common, trigger: "auto", customInstructions: null });
    await controller.compact({ ...common, trigger: "manual", customInstructions: null });
    expect(requests[0]!.system).toBe(requests[1]!.system);
    expect(requests[0]!.system).toBe(WINTER_SUMMARY_INSTRUCTION);
  });

  test("NOTHING FOLDABLE throws, so the engine reports it -- it never returns the input unchanged", async () => {
    const { provider, requests } = recordingProvider();
    // The engine swaps its history for `[summary, ...retained]`; a controller that returned the
    // whole input as `retained` would make the history LONGER than it was, every round, forever.
    await expect(
      createCompactionController().compact({ messages: [user("only the prompt")], trigger: "auto", customInstructions: null, accountant: createContextAccountant({ limit: 1000 }), provider }),
    ).rejects.toThrow(/nothing to compact/i);
    // ...and no tokens were spent finding that out.
    expect(requests).toHaveLength(0);
  });

  test("a summarizer that answers with a tool call, or with nothing, is a FAILED compaction", async () => {
    const toolCalling: Provider = { async generate() { return { kind: "tool_use", calls: [{ id: "x", name: "Bash", input: {} }] }; } };
    await expect(
      createCompactionController().compact({ messages: longConversation(), trigger: "auto", customInstructions: null, accountant: createContextAccountant({ limit: 1000 }), provider: toolCalling }),
    ).rejects.toThrow(/summar/i);

    const blank: Provider = { async generate() { return { kind: "text", text: "   \n  " }; } };
    await expect(
      createCompactionController().compact({ messages: longConversation(), trigger: "auto", customInstructions: null, accountant: createContextAccountant({ limit: 1000 }), provider: blank }),
    ).rejects.toThrow(/empty/i);
  });

  test("a provider that throws propagates -- the engine's own failure arm owns the reporting", async () => {
    const exploding: Provider = { async generate() { throw new Error("provider is down"); } };
    await expect(
      createCompactionController().compact({ messages: longConversation(), trigger: "auto", customInstructions: null, accountant: createContextAccountant({ limit: 1000 }), provider: exploding }),
    ).rejects.toThrow("provider is down");
  });

  test("a PRIOR summary is carried forward VERBATIM and never re-summarized", async () => {
    // Norma's shipped compactor (the R5-4 vehicle) established this: under repeated re-compression a
    // model reliably drops facts from a folded-in summary. So the earlier summary is concatenated,
    // not re-fed -- the cumulative summary only ever grows.
    const { provider, requests } = recordingProvider("FIRST PASS", "SECOND PASS");
    const controller = createCompactionController({ retainedPairs: 1 });
    const accountant = createContextAccountant({ limit: 1000 });
    const first = await controller.compact({ messages: longConversation(), trigger: "auto", customInstructions: null, accountant, provider });

    // Exactly what the engine does with the result.
    const afterFirst: ProviderMessage[] = [{ role: "user", content: first.summary }, ...first.retained, assistant("reply six"), user("turn seven"), assistant("reply seven"), user("turn eight")];
    const second = await controller.compact({ messages: afterFirst, trigger: "auto", customInstructions: null, accountant, provider });

    expect(second.summary).toContain(first.summary);
    expect(second.summary).toContain("SECOND PASS");
    // The prior summary was NOT part of what the second pass asked the model to summarize.
    expect(JSON.stringify(requests[1]!.messages)).not.toContain(first.summary);
  });
});
