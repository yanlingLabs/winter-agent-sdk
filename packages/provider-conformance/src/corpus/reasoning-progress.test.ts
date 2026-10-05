// 0.0.47: the live reasoning stream (`system/reasoning_progress`), proved per family on the wire.
//
// Every case drives a REAL adapter against a loopback fake and folds its stream with the REAL consumer
// (`foldProviderStream`) into a recording sink -- the same path a session's generation takes -- and
// asserts what the host would see: one `start` and one `end` per block, the readable text and nothing
// else, and the kind the block turned out to be. Each family's opaque material (a signature, encrypted
// content, redacted data) is a named marker in its script, and no progress step may contain it.
import { describe, expect, test } from "bun:test";
import { createChatCompletionsAdapter, createResponsesAdapter } from "@yanlinglabs/winter-provider-runtime";
import type { ProviderAdapter, ProviderContext, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { FAST_RETRY, descriptor, testContext } from "@yanlinglabs/winter-provider-runtime/testing";
import { foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import type { ProviderStreamSink, ReasoningProgress } from "../../../runtime/src/engine.ts";
import { sseResponse, withFake, type SseFrame } from "../fakes/server.ts";
import { chatStream } from "../fakes/openai-chat.ts";
import { converseStreamEvent, eventStreamResponse, startBedrockFake } from "../fakes/bedrock.ts";
import { ANTHROPIC_MODELS, anthropicCorpusRoutes, testAnthropicAdapter, testContext as anthropicContext } from "./anthropic.ts";
import { GOOGLE_MODELS, GOOGLE_SIGNATURE, googleContext, googleCorpusRoutes, testGoogleAdapter } from "./google.ts";
import { BEDROCK_CORPUS_MODEL, OPAQUE_SIGNATURE_MARKER, bedrockScenarios, createBedrockHarness } from "./bedrock.ts";

/** What the host would receive, in order: each progress step, and each live `stream_event` type between them. */
interface Recording {
  sink: ProviderStreamSink;
  progress: ReasoningProgress[];
  /** Progress steps AND the stream's own block events, interleaved, so ordering against the answer is checkable. */
  log: string[];
  summaries: string[];
}

function record(): Recording {
  const progress: ReasoningProgress[] = [];
  const log: string[] = [];
  const summaries: string[] = [];
  return {
    progress,
    log,
    summaries,
    sink: {
      onStreamEvent: (event) => {
        if (event.type === "content_block_start") log.push(`block:${(event.content_block as { type: string }).type}`);
      },
      onRetry: () => {},
      onRateLimit: () => {},
      onAuthStatus: () => {},
      onReasoningSummary: (text) => summaries.push(text),
      onReasoningProgress: (p) => {
        progress.push(p);
        log.push(`progress:${p.phase}:${p.kind}`);
      },
    },
  };
}

/** The contract's shape, per block: one `start` first, one `end` last, only `delta`s between, the `end` naming the last kind. */
function expectWellFormed(progress: ReasoningProgress[]): void {
  const byBlock = new Map<string, ReasoningProgress[]>();
  for (const p of progress) byBlock.set(p.blockId, [...(byBlock.get(p.blockId) ?? []), p]);
  for (const [id, steps] of byBlock) {
    expect([id, steps[0]!.phase]).toEqual([id, "start"]);
    expect([id, steps.at(-1)!.phase]).toEqual([id, "end"]);
    expect([id, steps.slice(1, -1).every((s) => s.phase === "delta")]).toEqual([id, true]);
    const lastDelta = steps.slice(1, -1).at(-1);
    if (lastDelta !== undefined) expect([id, steps.at(-1)!.kind]).toEqual([id, lastDelta.kind]);
  }
}

/** The blocks, each as [its kinds over time, its joined text]. */
function blocks(progress: ReasoningProgress[]): Array<{ kinds: string[]; text: string; parts: Array<number | undefined> }> {
  const out = new Map<string, { kinds: string[]; text: string; parts: Array<number | undefined> }>();
  for (const p of progress) {
    const block = out.get(p.blockId) ?? { kinds: [], text: "", parts: [] };
    if (block.kinds.at(-1) !== p.kind) block.kinds.push(p.kind);
    if (p.phase === "delta") {
      block.text += p.text ?? "";
      block.parts.push(p.part);
    }
    out.set(p.blockId, block);
  }
  return [...out.values()];
}

const frame = (payload: Record<string, unknown>): SseFrame => ({ event: String(payload.type), data: JSON.stringify(payload) });
const ENCRYPTED_MARKER = "ENCRYPTED-REASONING-DO-NOT-LEAK";

describe("OpenAI Responses (also codex-oauth and xAI's API rows)", () => {
  test("a reasoning item opens a block at `output_item.added`, streams its summary PARTS live, and closes at `.done`; an encrypted-only item is hidden", async () => {
    // The real wire order: the item opens, its summary parts stream (each `summary_index` a paragraph
    // starting with the provider's own bold heading), it completes carrying its encrypted content.
    const frames = [
      frame({ type: "response.created", response: { id: "resp_1", model: "o-test", status: "in_progress" } }),
      frame({ type: "response.output_item.added", output_index: 0, item: { id: "rs_A", type: "reasoning", summary: [] } }),
      frame({ type: "response.reasoning_summary_text.delta", item_id: "rs_A", output_index: 0, summary_index: 0, delta: "**Planning the fix**\n\n" }),
      frame({ type: "response.reasoning_summary_text.delta", item_id: "rs_A", output_index: 0, summary_index: 0, delta: "Reading the file first." }),
      frame({ type: "response.reasoning_summary_text.delta", item_id: "rs_A", output_index: 0, summary_index: 1, delta: "**Checking tests**\n\nThen the suite." }),
      frame({ type: "response.output_item.done", output_index: 0, item: { id: "rs_A", type: "reasoning", summary: [], encrypted_content: ENCRYPTED_MARKER, status: "completed" } }),
      // A second item with no readable text at all: encrypted only.
      frame({ type: "response.output_item.added", output_index: 1, item: { id: "rs_B", type: "reasoning", summary: [] } }),
      frame({ type: "response.output_item.done", output_index: 1, item: { id: "rs_B", type: "reasoning", summary: [], encrypted_content: `${ENCRYPTED_MARKER}-2`, status: "completed" } }),
      frame({ type: "response.output_text.delta", output_index: 2, delta: "done" }),
      frame({ type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 5, output_tokens: 9 } } }),
    ];
    await withFake({ routes: [{ path: "/responses", method: "POST", handler: () => sseResponse(frames) }] }, async (fake) => {
      const adapter: ProviderAdapter = createResponsesAdapter({
        generatedBaseUrl: fake.url,
        retry: FAST_RETRY,
        descriptors: (model) => descriptor({ key: `corpus/${model}`, upstreamId: model, efforts: ["low"], readableState: "summary", summaryValues: ["detailed"], continuation: "opaque-provider-state", continuationDomain: ["corpus-domain"] }),
      });
      const rec = record();
      const turn = await foldProviderStream(adapter.streamTurn({ model: "o-test", messages: [{ role: "user", content: "go" }] }, testContext({})), rec.sink);

      expectWellFormed(rec.progress);
      expect(blocks(rec.progress)).toEqual([
        { kinds: ["hidden", "summary"], text: "**Planning the fix**\n\nReading the file first.**Checking tests**\n\nThen the suite.", parts: [0, 0, 1] },
        { kinds: ["hidden"], text: "", parts: [] },
      ]);
      // The live deltas carry the part NUMBER, never the blank line the complete summary puts between
      // parts -- and that complete summary still arrives once, unchanged (compat).
      expect(rec.summaries).toEqual(["**Planning the fix**\n\nReading the file first.\n\n**Checking tests**\n\nThen the suite."]);
      expect(turn.thinking?.summary).toBe(rec.summaries[0]!);
      // Both blocks closed BEFORE the answer's text block opened.
      expect(rec.log.indexOf("block:text")).toBeGreaterThan(rec.log.lastIndexOf("progress:end:hidden"));
      expect(JSON.stringify(rec.progress)).not.toContain(ENCRYPTED_MARKER);
      // Session-unique ids: two blocks, two different ones.
      expect(new Set(rec.progress.map((p) => p.blockId)).size).toBe(2);
    });
  });
});

describe("Chat Completions (DeepSeek / OpenRouter / Qwen-style exposed reasoning)", () => {
  for (const plain of [false, true]) {
    test(`\`${plain ? "reasoning" : "reasoning_content"}\` streams live as ONE exposed block, closed when the answer begins -- before 0.0.47 it reached no host at all`, async () => {
      await withFake(
        { routes: [{ path: "/chat/completions", method: "POST", handler: () => chatStream({ reasoning: ["First, ", "the cache."], ...(plain ? { reasoningFieldIsPlain: true } : {}), text: ["answer"], finishReason: "stop", usage: { prompt: 3, completion: 4 } }) }] },
        async (fake) => {
          const adapter = createChatCompletionsAdapter({
            generatedBaseUrl: fake.url,
            retry: FAST_RETRY,
            descriptors: (model) => descriptor({ key: `corpus/${model}`, upstreamId: model, efforts: ["low"], readableState: "full-exposed", continuation: "plaintext", continuationDomain: ["corpus-domain"] }),
          });
          const rec = record();
          await foldProviderStream(adapter.streamTurn({ model: "deepseek-test", messages: [{ role: "user", content: "go" }] }, testContext({ providerId: "deepseek" })), rec.sink);
          expectWellFormed(rec.progress);
          expect(blocks(rec.progress)).toEqual([{ kinds: ["exposed"], text: "First, the cache.", parts: [undefined, undefined] }]);
          expect(rec.log).toEqual(["progress:start:exposed", "progress:delta:exposed", "progress:delta:exposed", "progress:end:exposed", "block:text"]);
        },
      );
    });
  }

  test("a stream that ends mid-reasoning still closes the block (the fold's guarantee)", async () => {
    await withFake({ routes: [{ path: "/chat/completions", method: "POST", handler: () => chatStream({ reasoning: ["half a ", "thought"], text: ["never"] }, { dropAfter: 2 }) }] }, async (fake) => {
      const adapter = createChatCompletionsAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined });
      const rec = record();
      await expect(foldProviderStream(adapter.streamTurn({ model: "m", messages: [{ role: "user", content: "go" }] }, testContext({})), rec.sink)).rejects.toThrow();
      expectWellFormed(rec.progress);
      expect(rec.progress.map((p) => p.phase)).toEqual(["start", "delta", "end"]);
    });
  });
});

describe("Google GenerateContent (Gemini thought summaries)", () => {
  test("a run of `thought: true` parts is one summary block, closed by the first answer part", async () => {
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const rec = record();
      await foldProviderStream(testGoogleAdapter().streamTurn({ model: GOOGLE_MODELS.full, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url)), rec.sink);
      expectWellFormed(rec.progress);
      // No `part` number: whether a thought part is a whole paragraph is unverified for this family.
      expect(blocks(rec.progress)).toEqual([{ kinds: ["summary"], text: "reasoning summary", parts: [undefined] }]);
      expect(rec.log.slice(0, 4)).toEqual(["progress:start:summary", "progress:delta:summary", "progress:end:summary", "block:text"]);
    });
  });

  test("a SIGNED thought part streams its text and never its `thoughtSignature`", async () => {
    await withFake({ routes: googleCorpusRoutes() }, async (fake) => {
      const rec = record();
      await foldProviderStream(testGoogleAdapter().streamTurn({ model: GOOGLE_MODELS.signedThought, messages: [{ role: "user", content: "go" }] }, googleContext(fake.url)), rec.sink);
      expectWellFormed(rec.progress);
      expect(blocks(rec.progress)).toEqual([{ kinds: ["summary"], text: "private reasoning", parts: [undefined] }]);
      expect(JSON.stringify(rec.progress)).not.toContain(GOOGLE_SIGNATURE);
    });
  });
});

describe("Anthropic Messages (in-dialect thinking)", () => {
  test("each thinking block streams live -- its text, never its signature -- and closes before the next block", async () => {
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const rec = record();
      const turn = await foldProviderStream(testAnthropicAdapter().streamTurn({ model: ANTHROPIC_MODELS.full, messages: [{ role: "user", content: "go" }] }, anthropicContext(fake.url)), rec.sink);
      expectWellFormed(rec.progress);
      // No `display` was asked for, so the block opens hidden and is a summary once text arrives.
      expect(blocks(rec.progress)).toEqual([{ kinds: ["hidden", "summary"], text: "let me think", parts: [undefined, undefined] }]);
      expect(rec.log.indexOf("progress:end:summary")).toBeLessThan(rec.log.indexOf("block:text"));
      expect(JSON.stringify(rec.progress)).not.toContain("sig-full-1");
      // The in-dialect block itself is unchanged: complete, signed, replayable.
      expect(turn.thinking?.blocks).toEqual([{ type: "thinking", thinking: "let me think", signature: "sig-full-1" }]);
      // Anthropic thinking is still never a foreign summary.
      expect(rec.summaries).toEqual([]);
    });
  });

  test("a `redacted_thinking` block is a hidden block whose data never rides the stream", async () => {
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const rec = record();
      await foldProviderStream(testAnthropicAdapter().streamTurn({ model: ANTHROPIC_MODELS.redacted, messages: [{ role: "user", content: "go" }] }, anthropicContext(fake.url)), rec.sink);
      expectWellFormed(rec.progress);
      expect(blocks(rec.progress)).toEqual([{ kinds: ["hidden"], text: "", parts: [] }]);
      expect(JSON.stringify(rec.progress)).not.toContain("REDACTED-OPAQUE-1");
    });
  });

  test("a stream that dies INSIDE a thinking block still ends it -- and the unsigned half-block is never replayable", async () => {
    await withFake({ routes: anthropicCorpusRoutes() }, async (fake) => {
      const rec = record();
      await expect(foldProviderStream(testAnthropicAdapter().streamTurn({ model: ANTHROPIC_MODELS.dropMidThinking, messages: [{ role: "user", content: "go" }] }, anthropicContext(fake.url)), rec.sink)).rejects.toThrow();
      expectWellFormed(rec.progress);
      expect(rec.progress.map((p) => p.phase)).toEqual(["start", "delta", "delta", "end"]);
      expect(JSON.stringify(rec.progress)).not.toContain("sig-never-seen");
    });
  });
});

describe("Bedrock Converse", () => {
  test("a reasoning block is a summary where the seam asked for one, its signature never on the stream", async () => {
    const fake = await startBedrockFake({ scenarios: bedrockScenarios() });
    try {
      const harness = createBedrockHarness(fake);
      const req: TurnRequest = { model: BEDROCK_CORPUS_MODEL, messages: [{ role: "user", content: "hi" }] };
      const asked = record();
      await foldProviderStream(harness.adapter.streamTurn({ ...req, model: "reasoning", requestSummary: true }, harness.ctx), asked.sink);
      expectWellFormed(asked.progress);
      expect(blocks(asked.progress)).toEqual([{ kinds: ["hidden", "summary"], text: "first half second half", parts: [undefined, undefined] }]);
      expect(JSON.stringify(asked.progress)).not.toContain(OPAQUE_SIGNATURE_MARKER.slice(0, 20));
      expect(JSON.stringify(asked.progress)).not.toContain(OPAQUE_SIGNATURE_MARKER.slice(20));

      // Not asked: the block is still visible as thinking, but its text is not surfaced (the existing rule).
      const unasked = record();
      await foldProviderStream(harness.adapter.streamTurn({ ...req, model: "reasoning" }, harness.ctx as ProviderContext), unasked.sink);
      expectWellFormed(unasked.progress);
      expect(blocks(unasked.progress)).toEqual([{ kinds: ["hidden"], text: "", parts: [] }]);
    } finally {
      await fake.close();
    }
  }, 30_000);

  test("a reasoning block whose text is EMPTY stays hidden even where a summary was asked for", async () => {
    const emptyReasoning = [
      converseStreamEvent("messageStart", { role: "assistant" }),
      converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "" } } }),
      converseStreamEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "SIG-EMPTY-BLOCK" } } }),
      converseStreamEvent("contentBlockStop", { contentBlockIndex: 0 }),
      converseStreamEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "answer" } }),
      converseStreamEvent("contentBlockStop", { contentBlockIndex: 1 }),
      converseStreamEvent("messageStop", { stopReason: "end_turn" }),
      converseStreamEvent("metadata", { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }),
    ];
    const fake = await startBedrockFake({ scenarios: { ...bedrockScenarios(), "empty-reasoning": () => eventStreamResponse(emptyReasoning) } });
    try {
      const harness = createBedrockHarness(fake);
      const rec = record();
      await foldProviderStream(harness.adapter.streamTurn({ model: "empty-reasoning", messages: [{ role: "user", content: "hi" }], requestSummary: true }, harness.ctx), rec.sink);
      expectWellFormed(rec.progress);
      expect(blocks(rec.progress)).toEqual([{ kinds: ["hidden"], text: "", parts: [] }]);
      expect(JSON.stringify(rec.progress)).not.toContain("SIG-EMPTY-BLOCK");
    } finally {
      await fake.close();
    }
  }, 30_000);
});
