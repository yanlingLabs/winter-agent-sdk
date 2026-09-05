// Phase 5 Task 7 (Lane K, R5-4 / WS-11 §7): "the condensed summary and compact boundary are
// persisted in the transcript dialect so RESUME WORKS ACROSS COMPACTION."
//
// This fixture EXERCISES T3's boundary persistence and rebuild -- it does not re-implement them.
// `recordCompactBoundary` (store/dialect.ts) and `rebuildProviderMessages` (store/resume.ts) are
// spine and already correct; what has never been proven is that they agree with a REAL controller's
// retention. The seam contract test drives that path with a hand-written `CompactBoundaryRecord`;
// here the record comes from a live `runEngine` turn with the real controller, so the one thing this
// catches that nothing else can is a MISALIGNMENT between `retained.length` (messages) and the
// "last N conversational entries" the writer names by uuid.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { WinterCompatibilitySessionStore, compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { createCompactionController } from "./controller.ts";
import type { CompactionController, CompactionInput, CompactionResult } from "./seam.ts";

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** Wraps the REAL controller so the fixture can see exactly what it decided to retain. */
function spyOn(controller: CompactionController, results: CompactionResult[]): CompactionController {
  return {
    shouldCompact: (a) => controller.shouldCompact(a),
    async compact(input: CompactionInput): Promise<CompactionResult> {
      const result = await controller.compact(input);
      results.push(result);
      return result;
    },
  };
}

/**
 * Reports enough usage to sit over 0.92 x 1000 from the first generation onward. The SUMMARIZER
 * runs on this same object (R5-4: the session's own provider, never a second one), so it is
 * answered separately -- a fixture that let the summarizer consume a scripted conversational reply
 * would silently shift every later assertion by one.
 */
function overThresholdProvider(replies: string[], summary = "THE COMPACTED SUMMARY"): Provider {
  let i = 0;
  return {
    async generate(input): Promise<ProviderTurn> {
      if (input.system?.includes("compacting a conversation") === true) return { kind: "text", text: summary };
      const text = replies[Math.min(i++, replies.length - 1)] ?? "reply";
      return { kind: "text", text, usage: { inputTokens: 950, outputTokens: 0 } };
    },
  };
}

describe("compaction -- resume across a compaction (R5-4 / WS-11 §7)", () => {
  test("a LIVE compaction's retention and the RESUMED session's rebuilt history are the same conversation", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-lane-k-resume-"));
    try {
      const cwd = join(home, "work");
      const sessionId = "sess-lane-k-resume";
      const config: RuntimeConfig = { sessionId, cwd, model: "sonnet", winterHome: home, contextWindowTokens: 1000 };
      const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });

      const results: CompactionResult[] = [];
      // retainedPairs: 1 -- the whole point is that the boundary preserves EXACTLY what the
      // controller retained, whatever that number is.
      const controller = spyOn(createCompactionController({ retainedPairs: 1 }), results);

      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: resolved.config,
        input: runtime.input,
        output: runtime.output,
        provider: overThresholdProvider(["reply one", "reply two", "reply three"]),
        tools: stubExecutor,
        ...(resolved.store !== undefined ? { store: resolved.store } : {}),
        compactionController: controller,
      });
      host.output.write({ type: "user", text: "turn one" });
      host.output.write({ type: "user", text: "turn two" });
      host.output.write({ type: "user", text: "turn three" });
      host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      await done;

      // --- the live half -------------------------------------------------------------------------
      // Turn 1's check sees a zero reading; turn 2's sees 950 (>= 0.92 x 1000) and compacts; turn 3's
      // sees the SAME 950 and is suppressed by the engine's own no-movement guard.
      expect(results).toHaveLength(1);
      const live = results[0]!;
      expect(live.preTokens).toBe(950);
      expect(live.retained.map((m) => m.content)).toEqual(["turn two"]);
      expect(dataMessages(frames).filter((m) => (m as { subtype?: string }).subtype === "compact_boundary")).toHaveLength(1);

      // --- the durable half ----------------------------------------------------------------------
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const raw = (await store.load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId })) ?? [];
      const boundary = raw.find((e) => e.type === "compact_boundary") as unknown as { compact_metadata: { pre_tokens: number; trigger: string; preserved_messages?: { anchor_uuid: string; uuids: string[] } } } | undefined;
      expect(boundary).toBeDefined();
      expect(boundary!.compact_metadata.trigger).toBe("auto");
      expect(boundary!.compact_metadata.pre_tokens).toBe(950);
      // THE ALIGNMENT THIS FIXTURE EXISTS FOR: one retained message, one preserved uuid. A
      // controller whose `retained` counted something the writer does not treat as a conversational
      // entry would silently preserve the wrong number of them, and only a resume would show it.
      expect(boundary!.compact_metadata.preserved_messages!.uuids).toHaveLength(live.retained.length);

      // --- the resume ----------------------------------------------------------------------------
      const resumed = await resolveEngineSession({
        config: { sessionId: "fresh", cwd, model: "sonnet", winterHome: home, resume: sessionId },
        resolveWinterHome: () => home,
        env: {},
      });
      const texts = resumed.initialMessages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

      // The summary, then the preserved message, then everything appended after the boundary.
      expect(texts[0]).toBe(live.summary);
      expect(texts[1]).toBe("turn two");
      expect(texts).toEqual([live.summary, "turn two", "reply two", "turn three", "reply three"]);
      // The turns the summary REPLACED never come back -- the failure mode T3 found and fixed
      // (a resume that rebuilt the whole pre-compaction conversation, straight back over the
      // threshold that caused the compaction).
      expect(texts).not.toContain("turn one");
      expect(texts).not.toContain("reply one");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // ================================================================================================
  // Landed with the T3 fix round (2ca7ef7): the frame carries preserved_messages + post_tokens.
  //
  // The T3 review found that resume correctness holds for the TRANSCRIPT (the boundary + summary
  // rebuild, proven above) but NOT for the emitted `compact_boundary` FRAME: `recordCompactBoundary`
  // returns `void`, so the engine never learns the uuids the writer minted and can put neither
  // `preserved_messages` nor `post_tokens` on the frame. The fix (on main, not in this lane's
  // ownership) makes the method return `{ boundaryUuid, preservedUuids }` and the engine put
  // `preserved_messages` on the frame when non-empty plus `post_tokens` read after the swap.
  //
  // Written now, against the INTENDED shape, and skipped rather than softened: an assertion loose
  // enough to pass both ways would still pass if the fix landed half-done. This scenario retains ONE
  // message (never `keep: 0`), which is what makes `preserved_messages` non-empty and therefore
  // present at all.
  // ================================================================================================
  test("the emitted compact_boundary frame carries preserved_messages and post_tokens", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-lane-k-resume-"));
    try {
      const cwd = join(home, "work");
      const sessionId = "sess-lane-k-frame";
      const config: RuntimeConfig = { sessionId, cwd, model: "sonnet", winterHome: home, contextWindowTokens: 1000 };
      const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });
      const results: CompactionResult[] = [];
      const controller = spyOn(createCompactionController({ retainedPairs: 1 }), results);

      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: resolved.config,
        input: runtime.input,
        output: runtime.output,
        provider: overThresholdProvider(["reply one", "reply two", "reply three"]),
        tools: stubExecutor,
        ...(resolved.store !== undefined ? { store: resolved.store } : {}),
        compactionController: controller,
      });
      host.output.write({ type: "user", text: "turn one" });
      host.output.write({ type: "user", text: "turn two" });
      host.output.write({ type: "user", text: "turn three" });
      host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
      const frames = await drain(host.input);
      await done;

      const live = results[0]!;
      expect(live.retained).toHaveLength(1);
      const boundary = dataMessages(frames).find((m) => (m as { subtype?: string }).subtype === "compact_boundary") as {
        compact_metadata: { pre_tokens: number; post_tokens?: number; preserved_messages?: { anchor_uuid: string; uuids: string[] } };
      };
      // The uuids on the FRAME must be the same ones the transcript's own boundary names -- a host
      // relinking from the frame and a resume relinking from the file have to agree.
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const raw = (await store.load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId })) ?? [];
      const persisted = raw.find((e) => e.type === "compact_boundary") as unknown as { compact_metadata: { preserved_messages?: { anchor_uuid: string; uuids: string[] } } };
      expect(boundary.compact_metadata.preserved_messages).toEqual(persisted.compact_metadata.preserved_messages!);
      expect(boundary.compact_metadata.preserved_messages!.uuids).toHaveLength(live.retained.length);
      // `post_tokens` is the accountant's reading AFTER the swap, so it is a real number rather than
      // the dead field it is today.
      expect(typeof boundary.compact_metadata.post_tokens).toBe("number");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the summary the model wrote is what resume replays -- not a paraphrase and not the raw messages", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-lane-k-resume-"));
    try {
      const cwd = join(home, "work");
      const sessionId = "sess-lane-k-resume-2";
      const config: RuntimeConfig = { sessionId, cwd, model: "sonnet", winterHome: home, contextWindowTokens: 1000 };
      const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });

      // A provider that answers the SUMMARIZER differently from the conversation, so the assertion
      // cannot pass by accident on an echoed message.
      let generations = 0;
      const provider: Provider = {
        async generate(input): Promise<ProviderTurn> {
          generations++;
          if (input.system?.includes("compacting a conversation") === true) return { kind: "text", text: "The user's lucky number is 4242." };
          return { kind: "text", text: `reply ${generations}`, usage: { inputTokens: 950, outputTokens: 0 } };
        },
      };

      const { host, runtime } = createInMemoryChannel();
      const done = runEngine({
        config: resolved.config,
        input: runtime.input,
        output: runtime.output,
        provider,
        tools: stubExecutor,
        ...(resolved.store !== undefined ? { store: resolved.store } : {}),
        compactionController: createCompactionController({ retainedPairs: 1 }),
      });
      host.output.write({ type: "user", text: "my lucky number is 4242" });
      host.output.write({ type: "user", text: "what did I say?" });
      host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
      await drain(host.input);
      await done;

      const resumed = await resolveEngineSession({
        config: { sessionId: "fresh", cwd, model: "sonnet", winterHome: home, resume: sessionId },
        resolveWinterHome: () => home,
        env: {},
      });
      expect(resumed.initialMessages[0]!.content).toBe("The user's lucky number is 4242.");
      // The summarizer's own generation never entered the conversation history it summarized.
      expect(resumed.initialMessages.map((m) => m.content)).not.toContain("my lucky number is 4242");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
