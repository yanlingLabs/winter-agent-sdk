import { describe, expect, test } from "bun:test";
import { createRegistry, type ProviderRegistry } from "../registry.ts";
import type { ContentBlockLike, ProviderMessageLike } from "../types.ts";
import { toWireMessages } from "../adapters/anthropic/messages.ts";
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
      text: `<${RECOVERED_REASONING_TAG} kind="summary" provider="anthropic" model="anthropic/claude-a">claude's own summary</${RECOVERED_REASONING_TAG}>`,
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

  // Phase 10b Lane S, S5 (W18-17, G1): a Claude message with no sidecar summary is no longer a gap --
  // its own VISIBLE thinking text (never `signature`) becomes its summary. `claudeMessage()`'s own
  // fixture always carries real visible thinking, so this is real, first-party material, not a
  // fabrication; the true "nothing to carry" case (no summary AND no visible thinking) is the next test.
  test("no captured summary -> falls back to the message's OWN visible thinking text (G1)", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([claudeMessage("m1")], chainOf({ m1: {} }), OPENAI);
    expect(messages[0]!.decoration).toEqual({
      text: `<${RECOVERED_REASONING_TAG} kind="summary" provider="anthropic" model="anthropic/claude-a">private claude reasoning</${RECOVERED_REASONING_TAG}>`,
      door: "tag",
    });
    // The signature and the redacted payload never enter the decoration, even though the visible
    // thinking text this decoration IS built from rode right beside them in the same content array.
    expect(messages[0]!.decoration!.text).not.toContain("SIG-OPAQUE");
    expect(messages[0]!.decoration!.text).not.toContain("REDACTED-OPAQUE");
    expect(report.withoutMaterial).toBe(0);
    expect(report.decorations).toHaveLength(1);
  });

  test("truly no material -- no sidecar summary AND no visible thinking blocks -- is still a counted gap, never a fabricated decoration", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const bareClaudeMessage: ProviderMessageLike = {
      role: "assistant",
      content: [{ type: "text", text: "the visible answer" }],
      uuid: "m1",
      origin: { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a" },
    };
    const { messages, report } = renderer.renderWithReport([bareClaudeMessage], chainOf({ m1: {} }), OPENAI);
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

  // W18-17 (G1): an anchor whose sidecar record is GONE ENTIRELY (`chainOf({})`, not merely empty)
  // no longer carries nothing either -- the message's own visible thinking is still right there in
  // its content, independent of whatever the sidecar did or didn't keep.
  test("an anchor that survives but whose sidecar record is gone still carries the message's OWN visible thinking", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([claudeMessage("m1")], chainOf({}), OPENAI);
    expect(messages[0]!.decoration).toEqual({
      text: `<${RECOVERED_REASONING_TAG} kind="summary" provider="anthropic" model="anthropic/claude-a">private claude reasoning</${RECOVERED_REASONING_TAG}>`,
      door: "tag",
    });
    expect(report.withoutMaterial).toBe(0);
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

// --- Phase 10b Lane S, S5 (W18-17 renderer half, R-10b-9, G1): Claude's reasoning crosses ----------
//
// An OFFICIAL-written assistant entry has NO sidecar record at all (the official leg's own child
// never goes through Winter's `recordAssistant`), so `message.origin` and the chain lookup are BOTH
// always absent -- the only provenance it carries is claude's own `message.model`, read here
// structurally (never added to `ProviderMessageLike` itself). Fix round 3 (P10b-6): the real dialect
// reader that actually attaches it is `winter-agent-runtime`'s `resume.ts` -- `toDialectEntries`
// carries a binary-shaped entry's `message.model` through its projection, and
// `rebuildProviderMessages` spreads it, structurally, onto the rebuilt assistant message (see that
// package's `resume.test.ts` for the round trip and `resume-renderer.test.ts` for this exact
// reader-to-renderer path proven end to end against the real catalog).
describe("W18-17 (G1): an official-written entry with no sidecar origin", () => {
  // Two thinking blocks (never merged into one on the wire) to prove ORDER, not just presence.
  function officialClaudeMessage(): ProviderMessageLike & { model: string } {
    return {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first, weigh option A", signature: "SIG-FIRST-OPAQUE" },
        { type: "thinking", thinking: "then, decide on option B", signature: "SIG-SECOND-OPAQUE" },
        { type: "redacted_thinking", data: "REDACTED-PAYLOAD-OPAQUE" },
        { type: "text", text: "the visible final answer" },
      ],
      model: "anthropic/claude-a",
    };
  }

  test("takes its origin from message.model (provider anthropic) and decorates a foreign target from it", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([officialClaudeMessage()], chainOf({}), OPENAI);
    expect(messages[0]!.decoration).toBeDefined();
    expect(messages[0]!.decoration!.door).toBe("tag");
    expect(report.decorations[0]).toMatchObject({ source: { providerId: "anthropic", modelKey: "anthropic/claude-a" }, kind: "summary" });
  });

  test("its visible thinking text, JOINED IN ORDER, is rendered for an OpenAI target as kind=\"summary\"", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([officialClaudeMessage()], chainOf({}), OPENAI);
    expect(messages[0]!.decoration!.text).toBe(
      `<${RECOVERED_REASONING_TAG} kind="summary" provider="anthropic" model="anthropic/claude-a">first, weigh option A\n\nthen, decide on option B</${RECOVERED_REASONING_TAG}>`,
    );
    expect(report.decorations[0]!.kind).toBe("summary");
  });

  test("its visible thinking text is rendered for a DeepSeek (exposed-reasoning) target ALSO as kind=\"summary\" -- Claude's own material is never relabelled exposed", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([officialClaudeMessage()], chainOf({}), DEEPSEEK);
    expect(messages[0]!.decoration!.door).toBe("thinking-channel");
    expect(messages[0]!.decoration!.text).toContain("first, weigh option A");
    expect(messages[0]!.decoration!.text).toContain("then, decide on option B");
    expect(report.decorations[0]!.kind).toBe("summary");
  });

  test("signature and redacted_thinking.data NEVER appear in any rendered string, for either target (byte-grep assertion)", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    for (const target of [OPENAI, DEEPSEEK]) {
      const { messages } = renderer.renderWithReport([officialClaudeMessage()], chainOf({}), target);
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("SIG-FIRST-OPAQUE");
      expect(serialized).not.toContain("SIG-SECOND-OPAQUE");
      expect(serialized).not.toContain("REDACTED-PAYLOAD-OPAQUE");
      expect(serialized).not.toContain("signature");
    }
  });

  test("a Claude target replays it NATIVELY -- same domain, no decoration, the real thinking blocks (with their real signatures) ride unchanged", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([officialClaudeMessage()], chainOf({}), CLAUDE_A);
    expect(messages[0]!.decoration).toBeUndefined();
    const content = messages[0]!.content as ContentBlockLike[];
    expect(content.map((b) => b.type)).toEqual(["thinking", "thinking", "redacted_thinking", "text"]);
    // Native replay keeps the REAL signature -- this is the one leg where it is legitimate for it to
    // still be present, because the target is claude itself.
    expect(JSON.stringify(content)).toContain("SIG-FIRST-OPAQUE");
    expect(report.replayedNatively).toBe(0); // no nativeState on this message -- the counter is for THAT carrier, not for the thinking blocks
  });
});

// --- fix round 3 (P10b-6, controller ruling, LOAD-BEARING): FAIL CLOSED on unresolved origin ------
describe("fail-closed: a message whose origin cannot be resolved at all never rides its opaque state onto an ANTHROPIC-dialect wire body", () => {
  test("no message.origin, no sidecar chain record, no usable structural model -- and REAL wire serialization (toWireMessages) proves no signature, no redacted_thinking reach it", () => {
    // This is the ONE destination family where failing to strip is not silently swallowed by an
    // adapter's own unrecognized-block-type default: Anthropic's `toWireMessages` passes `thinking`/
    // `redacted_thinking` through VERBATIM, signature and opaque data intact (messages.ts's own
    // comment). So this is the test that actually proves the wire body, not just the intermediate
    // ProviderMessage shape.
    const unresolved: ProviderMessageLike = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret unattributed reasoning", signature: "SIG-SHOULD-NEVER-REACH-THE-WIRE" },
        { type: "redacted_thinking", data: "REDACTED-SHOULD-NEVER-REACH-THE-WIRE" },
        { type: "text", text: "the visible final answer" },
      ],
      // Deliberately NO origin, NO uuid (so the chain lookup finds nothing), and no `.model` --
      // every one of the three provenance sources the renderer tries is absent.
    };
    const renderer = createHistoryRenderer(buildRegistry());
    const { messages, report } = renderer.renderWithReport([unresolved], chainOf({}), CLAUDE_A);

    // The intermediate shape: opaque carriers gone, decoration never invented (no honest provider/
    // model to attribute it to), visible text untouched.
    expect(messages[0]!.decoration).toBeUndefined();
    const content = messages[0]!.content as ContentBlockLike[];
    expect(content.map((b) => b.type)).toEqual(["text"]);
    expect(content[0]).toEqual({ type: "text", text: "the visible final answer" });
    expect(report.strippedInDialectBlocks).toBe(2);
    expect(report.decorations).toHaveLength(0);
    expect(report.withoutMaterial).toBe(1); // the visible thinking text existed and was deliberately dropped, not carried
    // Micro-round Minor 1: real reasoning content was destroyed here (a thinking block's own text
    // AND a redacted_thinking block) -- the caller must learn this transfer became lossy.
    expect(report.truncated).toBe(true);

    // The REAL wire body an Anthropic-dialect adapter would actually send.
    const wire = toWireMessages(messages);
    const wireJson = JSON.stringify(wire);
    expect(wireJson).not.toContain("signature");
    expect(wireJson).not.toContain("redacted_thinking");
    expect(wireJson).not.toContain("SIG-SHOULD-NEVER-REACH-THE-WIRE");
    expect(wireJson).not.toContain("REDACTED-SHOULD-NEVER-REACH-THE-WIRE");
    expect(wireJson).not.toContain("secret unattributed reasoning"); // dropped, never carried unlabeled either
    expect(wireJson).toContain("the visible final answer");
  });

  test("identity is preserved when there is truly nothing opaque to strip -- zero behavior change for every pre-existing no-origin case, and truncated stays false", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const plain: ProviderMessageLike = { role: "assistant", content: "ordinary text, no opaque state at all" };
    const { messages, report } = renderer.renderWithReport([plain], chainOf({}), CLAUDE_A);
    expect(messages[0]).toBe(plain);
    expect(report.truncated).toBe(false);
  });

  test("Minor 1: nativeState alone (no thinking/redacted_thinking blocks at all) is enough to set truncated -- it is one of the THREE named carriers, not just the content blocks", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const unresolved: ProviderMessageLike = {
      role: "assistant",
      content: [{ type: "text", text: "visible answer" }],
      nativeState: { family: "openai", continuationDomain: "openai/o-reason", items: [{ encrypted_content: "OPAQUE-REASONING-STATE" }] },
      // No origin, no uuid, no .model.
    };
    const { messages, report } = renderer.renderWithReport([unresolved], chainOf({}), CLAUDE_A);
    expect(messages[0]!.nativeState).toBeUndefined();
    expect(report.droppedNativeState).toBe(1);
    expect(report.strippedInDialectBlocks).toBe(0);
    expect(report.truncated).toBe(true);
  });

  test("a stale decoration removed on an assistant message with no origin does NOT by itself set truncated -- only real reasoning CONTENT does", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const orphan: ProviderMessageLike = { role: "assistant", content: "rebuilt by compaction", decoration: { text: "STALE foreign material", door: "tag" } };
    const { messages, report } = renderer.renderWithReport([orphan], chainOf({}), CLAUDE_A);
    expect(messages[0]!.decoration).toBeUndefined();
    expect(report.truncated).toBe(false);
  });

  test("a decoration on a NON-ASSISTANT message is still a protected handoff note, even under fail-closed stripping", () => {
    const renderer = createHistoryRenderer(buildRegistry());
    const carrier: ProviderMessageLike = { role: "user", content: "carry on", decoration: { text: "<prior_model_handoff …>", door: "tag" } };
    const { messages } = renderer.renderWithReport([carrier], chainOf({}), CLAUDE_A);
    expect(messages[0]).toBe(carrier);
    expect(messages[0]!.decoration?.text).toContain("prior_model_handoff");
  });
});
