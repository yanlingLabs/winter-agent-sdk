import { describe, expect, test } from "bun:test";
import { createRegistry, type ProviderRegistry } from "../registry.ts";
import type { ContentBlockLike, ProviderMessageLike } from "../types.ts";
import { RECOVERED_REASONING_TAG } from "./decoration.ts";
import { fixtureCatalog, fixtureModel, fixtureProvider, fixtureReasoning, scriptedAdapter } from "./fixtures.ts";
import { applyDecorationToContent, createHistoryRenderer, type ContinuationChainLike, type ContinuationLinkLike, type HistoryTarget } from "./renderer.ts";

// Four models across three families. The two Claude rows declare NO domain evidence, so each is its
// own single-member domain -- which is what makes "Claude model A -> Claude model B" a real boundary
// rather than a same-provider free pass.
function buildRegistry(): ProviderRegistry {
  const catalog = fixtureCatalog(
    [
      fixtureProvider({ id: "anthropic", family: "anthropic", adapterId: "anthropic-adapter" }),
      fixtureProvider({ id: "openai", family: "openai", adapterId: "openai-adapter" }),
      fixtureProvider({ id: "deepseek", family: "openai", adapterId: "deepseek-adapter" }),
    ],
    [
      fixtureModel({ key: "anthropic/claude-a", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "display", values: ["summarized"] } }) }),
      fixtureModel({ key: "anthropic/claude-b", providerId: "anthropic", reasoning: fixtureReasoning({ readableState: "summary", summaryRequest: { field: "display", values: ["summarized"] } }) }),
      fixtureModel({ key: "openai/o-reason", providerId: "openai", reasoning: fixtureReasoning({ readableState: "summary", domain: ["openai/o-reason"], summaryRequest: { field: "reasoning.summary", values: ["detailed"] } }) }),
      fixtureModel({ key: "deepseek/r-reason", providerId: "deepseek", reasoning: fixtureReasoning({ readableState: "full-exposed", domain: ["deepseek/r-reason"] }) }),
    ],
  );
  const registry = createRegistry(catalog);
  registry.register(scriptedAdapter({ id: "anthropic-adapter", family: "anthropic" }));
  registry.register(scriptedAdapter({ id: "openai-adapter" }));
  registry.register(scriptedAdapter({ id: "deepseek-adapter" }));
  return registry;
}

const CLAUDE_A: HistoryTarget = { family: "anthropic", continuationDomain: "anthropic/claude-a", readableState: "summary" };
const OPENAI: HistoryTarget = { family: "openai", continuationDomain: "openai/o-reason", readableState: "summary" };
const DEEPSEEK: HistoryTarget = { family: "openai", continuationDomain: "deepseek/r-reason", readableState: "full-exposed" };

const chainOf = (entries: Record<string, ContinuationLinkLike>): ContinuationChainLike => new Map(Object.entries(entries));

const claudeMessage = (uuid: string, extra: Partial<ProviderMessageLike> = {}): ProviderMessageLike => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "private claude reasoning", signature: "SIG-OPAQUE" },
    { type: "redacted_thinking", data: "REDACTED-OPAQUE" },
    { type: "text", text: "the visible answer" },
  ],
  uuid,
  origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
  ...extra,
});

const openaiMessage = (uuid: string): ProviderMessageLike => ({
  role: "assistant",
  content: [{ type: "text", text: "openai visible answer" }],
  uuid,
  origin: { providerId: "openai", modelKey: "openai/o-reason", family: "openai", continuationDomain: "openai/o-reason" },
  nativeState: { family: "openai", continuationDomain: "openai/o-reason", items: [{ encrypted_content: "OPENAI-OPAQUE" }] },
});

const deepseekMessage = (uuid: string): ProviderMessageLike => ({
  role: "assistant",
  content: [{ type: "text", text: "deepseek visible answer" }],
  uuid,
  origin: { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai", continuationDomain: "deepseek/r-reason" },
});

describe("the matrix: same domain", () => {
  test("EXACT REPLAY -- native state, in-dialect blocks and content all ride unchanged, and NOTHING is decorated", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["A-OPAQUE"] } });
    const { messages, report } = renderer.renderWithReport([message], chainOf({ m1: { summary: "claude summary" } }), CLAUDE_A);
    expect(messages[0]).toBe(message); // the same object: untouched, not rebuilt
    expect(messages[0]!.decoration).toBeUndefined();
    expect(report.replayedNatively).toBe(1);
    expect(report.decorations).toHaveLength(0);
    expect(report.truncated).toBe(false);
  });

  test("a message with NO origin is passed through untouched even when the chain has a link for it", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message: ProviderMessageLike = { role: "assistant", content: "pre-P6 history", uuid: "m1" };
    const { messages, report } = renderer.renderWithReport([message], chainOf({ m1: { summary: "s" } }), OPENAI);
    expect(messages[0]).toBe(message);
    expect(report.decorations).toHaveLength(0);
    expect(report.withoutMaterial).toBe(0);
  });

  test("user and tool messages are never touched", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const user: ProviderMessageLike = { role: "user", content: "do the thing" };
    const tool: ProviderMessageLike = { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] };
    const { messages } = renderer.renderWithReport([user, tool], chainOf({}), OPENAI);
    expect(messages[0]).toBe(user);
    expect(messages[1]).toBe(tool);
  });
});

describe("the matrix: cross domain", () => {
  test("Claude -> OpenAI: BOTH carriers of opaque state come off, and the message's OWN summary rides the tag door", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["A-OPAQUE"] } });
    const { messages, report } = renderer.renderWithReport([message], chainOf({ m1: { summary: "claude's own summary" } }), OPENAI);

    const rendered = messages[0]!;
    expect(rendered.nativeState).toBeUndefined();
    const blocks = rendered.content as ContentBlockLike[];
    expect(blocks.map((b) => b.type)).toEqual(["text"]);
    // The signature and the redacted payload are gone from EVERY carrier, and from the whole frame.
    const serialized = JSON.stringify(rendered);
    expect(serialized).not.toContain("SIG-OPAQUE");
    expect(serialized).not.toContain("REDACTED-OPAQUE");
    expect(serialized).not.toContain("A-OPAQUE");
    // ... and the private thinking TEXT is not forwarded either: only the provider's own summary is.
    expect(serialized).not.toContain("private claude reasoning");
    expect(rendered.decoration).toEqual({
      text: `<${RECOVERED_REASONING_TAG} provider="anthropic" model="anthropic/claude-a">claude's own summary</${RECOVERED_REASONING_TAG}>`,
      door: "tag",
    });
    expect(report).toMatchObject({ droppedNativeState: 1, strippedInDialectBlocks: 2, withoutMaterial: 0, truncated: false });
    expect(report.decorations[0]).toEqual({ anchorUuid: "m1", source: { providerId: "anthropic", modelKey: "anthropic/claude-a" }, kind: "summary", door: "tag", truncated: false });
  });

  test("Claude model A -> Claude model B is a real boundary: same family, same provider, different domain", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1");
    const target: HistoryTarget = { family: "anthropic", continuationDomain: "anthropic/claude-b", readableState: "summary" };
    const { messages, report } = renderer.renderWithReport([message], chainOf({ m1: { summary: "s" } }), target);
    expect(report.strippedInDialectBlocks).toBe(2);
    expect(messages[0]!.decoration?.door).toBe("tag");
  });

  test("DeepSeek -> an exposed-reasoning target: the thinking-channel door, and the material is `exposed`", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([deepseekMessage("m1")], chainOf({ m1: { summary: "full readable chain: step 1, step 2" } }), OPENAI);
    // The TARGET here is OpenAI (hidden reasoning) -> tag door even though the SOURCE is exposed.
    expect(messages[0]!.decoration?.door).toBe("tag");
    expect(report.decorations[0]!.kind).toBe("exposed");

    const toExposed = createHistoryRenderer(buildRegistry()).renderWithReport([openaiMessage("m1")], chainOf({ m1: { summary: "openai summary" } }), DEEPSEEK);
    expect(toExposed.messages[0]!.decoration?.door).toBe("thinking-channel");
    expect(toExposed.messages[0]!.decoration?.text).toContain("openai/o-reason");
    expect(toExposed.report.decorations[0]!.kind).toBe("summary");
  });

  test("no captured summary -> NO decoration and a counted gap (never a fabricated one)", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([claudeMessage("m1")], chainOf({ m1: {} }), OPENAI);
    expect(messages[0]!.decoration).toBeUndefined();
    expect(report.withoutMaterial).toBe(1);
    expect(report.decorations).toHaveLength(0);
  });

  test("policy may forbid forwarding exposed reasoning -- summaries are unaffected", () => {
    const blocked = createHistoryRenderer(buildRegistry(), { allowExposedForwarding: false });
    const exposed = blocked.renderWithReport([deepseekMessage("m1")], chainOf({ m1: { summary: "raw chain" } }), OPENAI);
    expect(exposed.messages[0]!.decoration).toBeUndefined();
    expect(exposed.report.withoutMaterial).toBe(1);
    const summarized = blocked.renderWithReport([claudeMessage("m2")], chainOf({ m2: { summary: "a summary" } }), OPENAI);
    expect(summarized.messages[0]!.decoration).toBeDefined();
  });

  test("AT MOST ONE decoration per message: an incoming decoration is replaced, never appended to", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1", { decoration: { text: "STALE", door: "tag" } });
    const { messages } = renderer.renderWithReport([message], chainOf({ m1: { summary: "fresh" } }), OPENAI);
    expect(messages[0]!.decoration?.text).toContain("fresh");
    expect(JSON.stringify(messages[0])).not.toContain("STALE");
  });

  test("a stale decoration on a message that now REPLAYS NATIVELY is removed, not carried", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const message = claudeMessage("m1", { decoration: { text: "STALE foreign material", door: "tag" } });
    const { messages } = renderer.renderWithReport([message], chainOf({ m1: { summary: "s" } }), CLAUDE_A);
    expect(messages[0]!.decoration).toBeUndefined();
    expect(JSON.stringify(messages[0])).not.toContain("STALE");
    // Everything else is intact -- including the in-dialect blocks the target itself authored.
    expect((messages[0]!.content as ContentBlockLike[]).map((b) => b.type)).toEqual(["thinking", "redacted_thinking", "text"]);
  });
});

describe("compaction stops the carriage", () => {
  test("a rebuilt post-compaction message (annotations dropped, anchor gone) is never decorated", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    // What the compaction summariser's positive rebuild produces: content only.
    const compacted: ProviderMessageLike = { role: "assistant", content: "summary of the earlier conversation" };
    const { messages, report } = renderer.renderWithReport([compacted], chainOf({ m1: { summary: "pre-compaction summary" } }), OPENAI);
    expect(messages[0]).toBe(compacted);
    expect(report.decorations).toHaveLength(0);
  });

  test("an anchor that survives but whose sidecar record is gone carries nothing", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([claudeMessage("m1")], chainOf({}), OPENAI);
    expect(messages[0]!.decoration).toBeUndefined();
    expect(report.withoutMaterial).toBe(1);
  });
});

describe("the multi-hop chain (Claude -> OpenAI -> DeepSeek -> Claude)", () => {
  test("the returning provider's native state lights up again, and each message carries ONLY its own decoration", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const history = [
      claudeMessage("m1", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["CLAUDE-OPAQUE"] } }),
      openaiMessage("m2"),
      deepseekMessage("m3"),
      claudeMessage("m4", { nativeState: { family: "anthropic", continuationDomain: "anthropic/claude-a", items: ["CLAUDE-OPAQUE-2"] } }),
    ];
    const chain = chainOf({
      m1: { summary: "claude summary one" },
      m2: { summary: "openai summary" },
      m3: { summary: "deepseek exposed chain" },
      m4: { summary: "claude summary two" },
    });

    // The hop BACK to Claude: its own two messages replay natively; the two intervening families
    // carry one decoration each, their own.
    const { messages, report } = renderer.renderWithReport(history, chain, CLAUDE_A);
    expect(messages[0]!.nativeState?.items).toEqual(["CLAUDE-OPAQUE"]);
    expect(messages[3]!.nativeState?.items).toEqual(["CLAUDE-OPAQUE-2"]);
    expect(messages[0]!.decoration).toBeUndefined();
    expect(messages[3]!.decoration).toBeUndefined();
    expect(messages[1]!.nativeState).toBeUndefined();
    expect(messages[1]!.decoration?.text).toContain("openai summary");
    expect(messages[1]!.decoration?.text).toContain(`model="openai/o-reason"`);
    expect(messages[2]!.decoration?.text).toContain("deepseek exposed chain");
    expect(messages[2]!.decoration?.text).toContain(`model="deepseek/r-reason"`);
    // Nobody carries anybody else's material.
    expect(messages[1]!.decoration!.text).not.toContain("deepseek");
    expect(messages[2]!.decoration!.text).not.toContain("openai");
    expect(report.replayedNatively).toBe(2);
    expect(report.decorations).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain("OPENAI-OPAQUE");

    // The same history rendered for OPENAI: its own message replays, and BOTH Claude messages plus
    // the DeepSeek one decorate -- the identical per-message rule, no session-level state.
    const forOpenai = renderer.renderWithReport(history, chain, OPENAI);
    expect(forOpenai.messages[1]!.nativeState?.items).toEqual([{ encrypted_content: "OPENAI-OPAQUE" }]);
    expect(forOpenai.report.decorations.map((d) => d.source.modelKey).sort()).toEqual(["anthropic/claude-a", "anthropic/claude-a", "deepseek/r-reason"]);
    expect(JSON.stringify(forOpenai.messages)).not.toContain("CLAUDE-OPAQUE");
    expect(JSON.stringify(forOpenai.messages)).not.toContain("SIG-OPAQUE");
  });
});

describe("§9.6 budgets", () => {
  test("a per-decoration budget truncates and FLIPS the report to lossy", () => {
    const renderer = createHistoryRenderer(buildRegistry(), { maxDecorationChars: 200 });
    const { messages, report } = renderer.renderWithReport([openaiMessage("m1")], chainOf({ m1: { summary: "z".repeat(400) } }), CLAUDE_A);
    expect(report.truncated).toBe(true);
    expect(report.decorations[0]!.truncated).toBe(true);
    expect(messages[0]!.decoration!.text).toContain("trimmed to fit");
  });

  test("a total budget is spent NEWEST FIRST, and exhaustion drops the OLDEST material -- reported, never silent", () => {
    const renderer = createHistoryRenderer(buildRegistry(), { decorationCharBudget: 300 });
    const history = [openaiMessage("m1"), openaiMessage("m2"), openaiMessage("m3")];
    const chain = chainOf({ m1: { summary: "OLDEST material" }, m2: { summary: "MIDDLE material" }, m3: { summary: "NEWEST material" } });
    const { messages, report } = renderer.renderWithReport(history, chain, CLAUDE_A);
    expect(messages[2]!.decoration?.text).toContain("NEWEST material");
    expect(messages[0]!.decoration).toBeUndefined();
    expect(report.budgetDropped).toBeGreaterThan(0);
    expect(report.truncated).toBe(true);
  });

  test("no budget configured -> nothing is truncated and the report says so", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { report } = renderer.renderWithReport([openaiMessage("m1")], chainOf({ m1: { summary: "y".repeat(10_000) } }), CLAUDE_A);
    expect(report.truncated).toBe(false);
  });

  test("`onReport` sees every render (the side channel through the frozen seam's message-only return)", () => {
    const seen: number[] = [];
    const renderer = createHistoryRenderer(buildRegistry(), { onReport: (report) => seen.push(report.decorations.length) });
    renderer.render([openaiMessage("m1")], chainOf({ m1: { summary: "s" } }), CLAUDE_A);
    renderer.render([openaiMessage("m1")], chainOf({}), CLAUDE_A);
    expect(seen).toEqual([1, 0]);
  });
});

describe("applyDecorationToContent: the adapter's half of the tag door", () => {
  test("a tag decoration becomes an ordinary text block on the message it belongs to", () => {
    const message: ProviderMessageLike = { role: "assistant", content: [{ type: "text", text: "answer" }], decoration: { text: "<tagged/>", door: "tag" } };
    expect(applyDecorationToContent(message)).toEqual({ applied: true, content: [{ type: "text", text: "answer" }, { type: "text", text: "<tagged/>" }] });
    expect(applyDecorationToContent({ role: "assistant", content: "answer", decoration: { text: "<tagged/>", door: "tag" } })).toEqual({ applied: true, content: "answer\n\n<tagged/>" });
  });

  test("MINOR 3: a thinking-channel decoration is refused with a REASON, never dropped silently", () => {
    // An adapter that got its own content back with no signal would have dropped the decoration and
    // had no way to know.
    const message: ProviderMessageLike = { role: "assistant", content: "answer", decoration: { text: "prior-model reasoning", door: "thinking-channel" } };
    const placement = applyDecorationToContent(message);
    expect(placement).toEqual({ applied: false, reason: "thinking-channel-door", content: "answer" });
  });

  test("no decoration -> `applied: false` with its own reason, and the content unchanged", () => {
    const content: ContentBlockLike[] = [{ type: "text", text: "answer" }];
    const placement = applyDecorationToContent({ role: "assistant", content });
    expect(placement.applied).toBe(false);
    expect(placement).toMatchObject({ reason: "no-decoration" });
    expect(placement.content).toBe(content);
  });

  test("MINOR 3: the render report COUNTS the decorations that need adapter-side placement", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const toTag = renderer.renderWithReport([openaiMessage("m1")], chainOf({ m1: { summary: "s" } }), CLAUDE_A);
    expect(toTag.report.thinkingChannelDecorations).toBe(0);
    const toChannel = renderer.renderWithReport([openaiMessage("m1")], chainOf({ m1: { summary: "s" } }), DEEPSEEK);
    expect(toChannel.report.thinkingChannelDecorations).toBe(1);
  });
});

describe("MINOR 6: stale-decoration symmetry on the no-origin path", () => {
  test("an ASSISTANT message with a decoration but no origin has the stale annotation stripped", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const orphan: ProviderMessageLike = { role: "assistant", content: "rebuilt by compaction", decoration: { text: "STALE foreign material", door: "tag" } };
    const { messages } = renderer.renderWithReport([orphan], chainOf({}), OPENAI);
    expect(messages[0]!.decoration).toBeUndefined();
    expect(JSON.stringify(messages[0])).not.toContain("STALE");
  });

  test("a USER message's decoration is LEFT ALONE -- it is the switch point's handoff note", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const carrier: ProviderMessageLike = { role: "user", content: "carry on", decoration: { text: "<prior_model_handoff …>", door: "tag" } };
    const { messages } = renderer.renderWithReport([carrier], chainOf({}), OPENAI);
    expect(messages[0]).toBe(carrier);
    expect(messages[0]!.decoration?.text).toContain("prior_model_handoff");
  });

  test("an assistant message with no origin AND no decoration is still passed through by identity", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const plain: ProviderMessageLike = { role: "assistant", content: "pre-P6" };
    expect(renderer.render([plain], chainOf({}), OPENAI)[0]).toBe(plain);
  });
});
