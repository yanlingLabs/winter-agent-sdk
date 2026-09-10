// The advisor (WS-06 §4, ruling P-6): the handler factory, the assembler, and the opaque-state floor.
//
// The reviewer types here are DELIBERATELY narrow (`AdvisorReviewer`, not a host's `Provider`): the
// only thing this tool needs of a provider is "turn these messages into one text turn", and taking
// the host's whole provider interface would drag the engine's wire types into a published package.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WinterCompatibilitySessionStore } from "../index.ts";
import {
  ADVISOR_DEFAULT_MAX_CHARS,
  assembleReviewerMessages,
  createAdvisorToolHandler,
  OPAQUE_MARKERS,
  stripOpaqueMarkers,
  transcriptSourceForSessionKey,
  type AdvisorReviewer,
  type AdvisorReviewerRequest,
  type AdvisorReviewerTurn,
  type TranscriptEntry,
} from "./index.ts";

function scriptedReviewer(turn: AdvisorReviewerTurn = { kind: "text", text: "looks fine" }): { reviewer: AdvisorReviewer; calls: AdvisorReviewerRequest[] } {
  const calls: AdvisorReviewerRequest[] = [];
  return {
    calls,
    reviewer: {
      async generate(input) {
        calls.push(input);
        return turn;
      },
    },
  };
}

const ENTRIES: TranscriptEntry[] = [
  { role: "user", text: "please review" },
  { role: "assistant", text: "on it" },
];

describe("createAdvisorToolHandler", () => {
  test("a resolved reviewer returns the pinned `{ advice, model }` result", async () => {
    const { reviewer, calls } = scriptedReviewer();
    const handler = createAdvisorToolHandler({ transcriptSource: { getEntries: () => ENTRIES }, resolveReviewer: () => ({ provider: reviewer, model: "reviewer-model-1" }) });
    const result = await handler({});
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.text)).toEqual({ advice: "looks fine", model: "reviewer-model-1" });
    expect(calls[0]?.messages).toEqual([
      { role: "user", content: "please review" },
      { role: "assistant", content: "on it" },
    ]);
  });

  test("NO reviewer -> the ordinary tool error WS-06 §4 pins, never a throw and never a blocked turn", async () => {
    const handler = createAdvisorToolHandler({ transcriptSource: { getEntries: () => [] }, resolveReviewer: () => undefined });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("unavailable");
  });

  test("a throwing resolver, a throwing transcript and a throwing reviewer are all ordinary tool errors", async () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    const resolverThrew = await createAdvisorToolHandler({ transcriptSource: { getEntries: () => [] }, resolveReviewer: boom })({});
    expect(resolverThrew.isError).toBe(true);

    const { reviewer } = scriptedReviewer();
    const transcriptThrew = await createAdvisorToolHandler({ transcriptSource: { getEntries: boom }, resolveReviewer: () => ({ provider: reviewer, model: "m" }) })({});
    expect(transcriptThrew.isError).toBe(true);

    const reviewerThrew = await createAdvisorToolHandler({
      transcriptSource: { getEntries: () => ENTRIES },
      resolveReviewer: () => ({ provider: { async generate() { throw new Error("upstream down"); } }, model: "m" }),
    })({});
    expect(reviewerThrew.isError).toBe(true);
    expect(reviewerThrew.text).toContain("upstream down");
  });

  test("a NON-TEXT turn is an ordinary tool error -- the advisor has no tool-execution loop", async () => {
    const { reviewer } = scriptedReviewer({ kind: "tool_use" });
    const result = await createAdvisorToolHandler({ transcriptSource: { getEntries: () => ENTRIES }, resolveReviewer: () => ({ provider: reviewer, model: "m" }) })({});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("tool_use");
  });

  test("`truncated: true` rides the result only when something was actually clipped", async () => {
    const { reviewer } = scriptedReviewer();
    const long: TranscriptEntry[] = [
      { role: "user", text: "a".repeat(50) },
      { role: "assistant", text: "b".repeat(50) },
    ];
    const handler = createAdvisorToolHandler({ transcriptSource: { getEntries: () => long }, resolveReviewer: () => ({ provider: reviewer, model: "m" }), maxChars: 60 });
    expect(JSON.parse((await handler({})).text)).toEqual({ advice: "looks fine", model: "m", truncated: true });
  });

  test("NO CACHE (WS-06 §4): two invocations are two `generate` calls", async () => {
    const { reviewer, calls } = scriptedReviewer();
    const handler = createAdvisorToolHandler({ transcriptSource: { getEntries: () => ENTRIES }, resolveReviewer: () => ({ provider: reviewer, model: "m" }) });
    await handler({});
    await handler({});
    expect(calls).toHaveLength(2);
  });

  test("an ASYNC transcript source is awaited -- the host may read one off disk", async () => {
    const { reviewer, calls } = scriptedReviewer();
    const handler = createAdvisorToolHandler({ transcriptSource: { getEntries: async () => ENTRIES }, resolveReviewer: () => ({ provider: reviewer, model: "m" }) });
    await handler({});
    expect(calls[0]?.messages).toHaveLength(2);
  });
});

describe("the opaque-state floor (RULING R3-3)", () => {
  test("the five markers are the pinned set", () => {
    expect([...OPAQUE_MARKERS]).toEqual(["encrypted_content", "reasoning_item", "signature", "thinking", "redacted_thinking"]);
  });

  test("a whole line mentioning a marker is DROPPED, never partially redacted, case-insensitively", () => {
    expect(stripOpaqueMarkers("keep me\nencrypted_content: AAAA-BBBB\nkeep me too")).toBe("keep me\nkeep me too");
    expect(stripOpaqueMarkers("Reasoning_Item: xyz")).toBe("");
    for (const marker of OPAQUE_MARKERS) expect([marker, stripOpaqueMarkers(`line with ${marker} in it`)]).toEqual([marker, ""]);
  });

  test("stripping runs PER ENTRY, BEFORE truncation is measured -- a kept entry is a whole, cleaned entry", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "old and short" },
      { role: "assistant", text: `visible\nsignature: ${"Z".repeat(500)}` },
    ];
    // The signature line is 500+ chars; if it were counted before stripping, the budget would be
    // blown and the older entry dropped. Cleaned first, both entries fit.
    const { messages, truncated } = assembleReviewerMessages(entries, 100);
    expect(truncated).toBe(false);
    expect(messages).toEqual([
      { role: "user", content: "old and short" },
      { role: "assistant", content: "visible" },
    ]);
  });
});

describe("assembleReviewerMessages", () => {
  test("the default budget is the pinned 20_000", () => {
    expect(ADVISOR_DEFAULT_MAX_CHARS).toBe(20_000);
  });

  test("it keeps the TAIL -- recent turns are what advice needs", () => {
    const entries: TranscriptEntry[] = [
      { role: "user", text: "oldest" },
      { role: "assistant", text: "middle" },
      { role: "user", text: "newest" },
    ];
    const { messages, truncated } = assembleReviewerMessages(entries, 12);
    expect(truncated).toBe(true);
    expect(messages).toEqual([
      { role: "assistant", content: "middle" },
      { role: "user", content: "newest" },
    ]);
  });

  test("a single entry that ALONE exceeds the budget is clipped to its own tail rather than dropped whole", () => {
    const { messages, truncated } = assembleReviewerMessages([{ role: "user", text: "abcdefghij" }], 4);
    expect(truncated).toBe(true);
    expect(messages).toEqual([{ role: "user", content: "ghij" }]);
  });

  test("nothing to assemble is not an error", () => {
    expect(assembleReviewerMessages([], 100)).toEqual({ messages: [], truncated: false });
  });
});

describe("transcriptSourceForSessionKey (ruling P-6: the durable transcript, read as entries)", () => {
  test("two appended entries come back as TranscriptEntries, in order", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-advisor-transcript-"));
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj", sessionId: "s_1" };
      await store.append(key, [
        { type: "user", uuid: "u1", message: { role: "user", content: "please review" } },
        { type: "assistant", uuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "on it" }] } },
      ]);
      const source = transcriptSourceForSessionKey(key, { store });
      await expect(source.getEntries()).resolves.toEqual([
        { role: "user", text: "please review" },
        { role: "assistant", text: "on it" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a session with no transcript at all yields no entries rather than throwing", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-advisor-transcript-"));
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      await expect(transcriptSourceForSessionKey({ projectKey: "proj", sessionId: "nope" }, { store }).getEntries()).resolves.toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("non-conversational entries are skipped -- only what a reviewer can read is forwarded", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-advisor-transcript-"));
    try {
      const store = new WinterCompatibilitySessionStore({ winterHome: home });
      const key = { projectKey: "proj", sessionId: "s_2" };
      await store.append(key, [
        { type: "agent_metadata", uuid: "m1", name: "child" },
        { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
        { type: "summary", uuid: "s1" },
      ]);
      await expect(transcriptSourceForSessionKey(key, { store }).getEntries()).resolves.toEqual([{ role: "user", text: "hello" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
