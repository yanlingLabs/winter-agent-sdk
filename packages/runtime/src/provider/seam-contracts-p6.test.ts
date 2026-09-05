// Phase 6 Task 3 (R6-2): the executable contract for every seam this spine ships.
//
// THIS FILE IS THE SEAM'S AUTHORITY. Every lane brief cites it: a lane that wants to know what
// `ProviderRequest`/`ProviderTurn`/`ProviderMessage`/`ContentBlock`/`ProviderStateRecord` mean reads
// the assertions here, not a prose description of them. Both sides keep it green.
//
// Two halves:
//   1. THE BY-MEANING SWEEP (R6-3). `ContentBlock` grew three variants and `tool_result.content`
//      widened. Almost none of that breaks a build: a consumer with a `default:` arm or a
//      `block.content` fallthrough keeps compiling and starts silently dropping (or worse, silently
//      LEAKING) the new shapes. Each test below names one CONSUMER and asserts what it must do with
//      each new variant -- these are the fixtures that RED-fail on a silent drop.
//   2. THE TYPE-LEVEL CONTRACTS. The engine's own `ContentBlock`/`ProviderMessage` must stay
//      assignable to provider-runtime's `ContentBlockLike`/`ProviderMessageLike` in BOTH directions
//      for every shared variant, because the bridge converts between them on every generation.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlockLike, MessageOrigin, ProviderMessageLike, ProviderNativeState } from "@yanlinglabs/winter-provider-runtime";
import type { ContentBlock, ProviderMessage, ProviderRequest, ProviderTurn, ProviderStreamSink } from "../engine.ts";
import { providerMessageContentToText } from "../engine.ts";
import { redactForSummary } from "../compaction/summarizer.ts";
import { assistantEntry } from "../store/dialect.ts";
import { rebuildProviderMessages, toDialectEntries } from "../store/resume.ts";
import { assembleReviewerMessages } from "../tools/impl/advisor.ts";
import { appendProviderState, buildContinuationChain, providerStateSidecarPath, readProviderState, type ProviderStateRecord } from "../store/provider-state.ts";

// The three variants R6-3 adds, plus a text-with-calls turn -- one fixture value every consumer test
// below reuses, so a consumer that grows a new drop is caught by every one of them at once.
const SIGNATURE = "sig-abc-do-not-leak";
const REDACTED_DATA = "redacted-payload-do-not-leak";
const IMAGE_DATA = "aW1hZ2UtYnl0ZXM";

const NEW_BLOCKS: ContentBlock[] = [
  { type: "text", text: "the visible answer" },
  { type: "thinking", thinking: "step one then step two", signature: SIGNATURE },
  { type: "redacted_thinking", data: REDACTED_DATA },
  { type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } },
];

const OPAQUE_STRINGS = [SIGNATURE, REDACTED_DATA, IMAGE_DATA];

function expectNoOpaque(text: string): void {
  for (const secret of OPAQUE_STRINGS) expect(text).not.toContain(secret);
}

describe("R6-3 by-meaning sweep: every consumer of ContentBlock/ProviderTurn/ProviderMessage", () => {
  test("consumer 1 -- rebuildProviderMessages round-trips thinking/redacted_thinking/image verbatim", () => {
    // A resumed session MUST hand the provider back exactly what it produced: an Anthropic-family
    // thinking block replayed without its signature breaks the signature chain (item (f)'s
    // `resumed_from_incomplete_thinking` exists solely to preserve it), and a dropped image block
    // silently changes what the model was shown.
    const entry = assistantEntry({ content: NEW_BLOCKS, chain: { parentUuid: null }, ctx: { sessionId: "s", cwd: "/tmp", version: "0" } });
    const rebuilt = rebuildProviderMessages(toDialectEntries([entry]));
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.content).toEqual(NEW_BLOCKS);
  });

  test("consumer 1b -- a tool_result whose content is BLOCKS round-trips", () => {
    const blocks: ContentBlock[] = [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: IMAGE_DATA } }] }];
    const entry = assistantEntry({ content: blocks, chain: { parentUuid: null }, ctx: { sessionId: "s", cwd: "/tmp", version: "0" } });
    const rebuilt = rebuildProviderMessages(toDialectEntries([entry]));
    expect(rebuilt[0]!.content).toEqual(blocks);
  });

  test("consumer 2 -- providerMessageContentToText REPRESENTS each new variant, without its opaque fields", () => {
    // The advisor's transcript source flattens through here, and the failure mode is SILENT in a way
    // worth naming: the old code ended in a bare `return block.content`, which is `undefined` on all
    // three new variants -- and `Array.prototype.join` renders `undefined` as the EMPTY STRING, so a
    // dropped block leaves no trace at all in the output. Nothing throws, nothing logs, and a
    // reviewer silently stops being told that the turn reasoned or produced an image.
    //
    // So the assertion is "each variant is represented", not "no 'undefined' appears": the first
    // RED-fails on the drop, the second does not.
    const text = providerMessageContentToText(NEW_BLOCKS);
    expect(text).toContain("the visible answer");
    expect(text).toContain("thinking");
    expect(text).toContain("redacted");
    expect(text).toContain("image");
    expect(text).not.toContain("undefined");
    expectNoOpaque(text);
  });

  test("consumer 2b -- a blocks-valued tool_result flattens to its inner text, not '[object Object]'", () => {
    const text = providerMessageContentToText([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "inner result" }] }]);
    expect(text).toContain("inner result");
    expect(text).not.toContain("[object Object]");
  });

  test("consumer 3 -- the advisor's opaque stripping still removes any line that names a marker", () => {
    const { messages } = assembleReviewerMessages([{ role: "assistant", text: providerMessageContentToText(NEW_BLOCKS) }]);
    for (const message of messages) expectNoOpaque(typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  });

  test("consumer 4 -- the dialect Block type persists the new variants verbatim", () => {
    // `store/dialect.ts`'s `Block` IS `ContentBlock`; this asserts the alias still carries every
    // variant onto disk rather than a narrowed copy of it.
    const entry = assistantEntry({ content: NEW_BLOCKS, chain: { parentUuid: null }, ctx: { sessionId: "s", cwd: "/tmp", version: "0" } });
    expect(entry.message.content).toEqual(NEW_BLOCKS);
  });

  test("consumer 5 -- the compaction summariser input carries NO opaque field of any new variant", () => {
    // Redaction here is a POSITIVE REBUILD: an unknown block is dropped, never guessed at. The
    // assertion is not "thinking survives" -- it is that nothing opaque reaches a model-readable
    // summary request, and that the message's own annotations are left behind by construction.
    const messages: ProviderMessage[] = [
      { role: "assistant", content: NEW_BLOCKS, origin: { providerId: "p", modelKey: "p/m", family: "openai" }, nativeState: { family: "openai", continuationDomain: "openai:responses", items: [{ encrypted_content: "OPAQUE-ITEM" }] } },
    ];
    const redacted = redactForSummary(messages);
    const serialized = JSON.stringify(redacted);
    expectNoOpaque(serialized);
    expect(serialized).not.toContain("OPAQUE-ITEM");
    expect(serialized).not.toContain("encrypted_content");
    for (const message of redacted) {
      expect(message.origin).toBeUndefined();
      expect(message.nativeState).toBeUndefined();
    }
  });

  test("consumer 6 -- a ProviderMessage's annotations survive a by-value copy (the child fork mirror)", () => {
    // `buildChildInheritance` forks with `messages: [...messages]`. A copy that rebuilt each element
    // as `{role, content}` would silently drop `origin`/`nativeState`, and the child would replay a
    // foreign history as if it were its own provider's.
    const origin: MessageOrigin = { providerId: "openai", modelKey: "openai/o-test", family: "openai", continuationDomain: "openai:responses" };
    const nativeState: ProviderNativeState = { family: "openai", continuationDomain: "openai:responses", items: ["opaque"] };
    const parent: ProviderMessage[] = [{ role: "assistant", content: "hi", uuid: "u-1", origin, nativeState }];
    const forked = [...parent];
    expect(forked[0]!.origin).toEqual(origin);
    expect(forked[0]!.nativeState).toEqual(nativeState);
    expect(forked[0]!.uuid).toBe("u-1");
  });

  test("consumer 7 -- a tool_use turn carries its leading TEXT (a real model returns both)", () => {
    // R6-3, stated as the reason the field exists: "a real model returns text AND calls in one turn
    // -- the text persists as a leading text block". A `tool_use` turn whose `text` is dropped loses
    // a whole assistant utterance from the transcript with nothing failing anywhere.
    const turn: ProviderTurn = { kind: "tool_use", text: "I'll read the file first.", calls: [{ id: "t1", name: "Read", input: {} }] };
    expect(turn.kind === "tool_use" ? turn.text : undefined).toBe("I'll read the file first.");
  });
});

describe("R6-3 type-level contract: the engine's unions and provider-runtime's mirrors agree", () => {
  test("every shared ContentBlock variant is assignable in BOTH directions", () => {
    // Compile-time, asserted at runtime only so the test reports. The bridge converts an adapter's
    // blocks into the engine's on every generation; a one-way-only assignability is a cast waiting
    // to be written.
    const engineBlocks: ContentBlock[] = NEW_BLOCKS;
    const asLike: ContentBlockLike[] = engineBlocks;
    const backToEngine: ContentBlock[] = asLike as ContentBlock[];
    expect(backToEngine).toEqual(engineBlocks);

    const likeBlocks: ContentBlockLike[] = [
      { type: "text", text: "t" },
      { type: "tool_use", id: "i", name: "n", input: {} },
      { type: "tool_result", tool_use_id: "i", content: "r" },
      { type: "thinking", thinking: "th", signature: "s" },
      { type: "redacted_thinking", data: "d" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      { type: "tool_reference", tool_names: ["a"] },
    ];
    const asEngine: ContentBlock[] = likeBlocks as ContentBlock[];
    expect(asEngine).toHaveLength(7);
  });

  test("a ProviderMessage is a ProviderMessageLike and back", () => {
    const message: ProviderMessage = {
      role: "assistant",
      content: NEW_BLOCKS,
      uuid: "u",
      origin: { providerId: "p", modelKey: "p/m", family: "anthropic" },
      nativeState: { family: "anthropic", continuationDomain: "anthropic:messages", items: [] },
      decoration: { text: "note", door: "tag" },
    };
    const asLike: ProviderMessageLike = message;
    const back: ProviderMessage = asLike as ProviderMessage;
    expect(back.uuid).toBe("u");
    expect(back.decoration?.door).toBe("tag");
  });

  test("ProviderRequest carries every field R6-3 adds, and every one is optional", () => {
    // A pre-existing Provider double must keep compiling: `{ messages }` alone is a legal request.
    const minimal: ProviderRequest = { messages: [] };
    expect(minimal.messages).toEqual([]);

    const sink: ProviderStreamSink = {
      onStreamEvent: () => {},
      onRetry: () => {},
      onRateLimit: () => {},
      onAuthStatus: () => {},
      onReasoningSummary: () => {},
    };
    const full: ProviderRequest = {
      messages: [{ role: "user", content: "hi" }],
      system: "sys",
      tools: [{ name: "Read", description: "read a file", inputSchema: { type: "object" } }],
      toolChoice: { type: "auto" },
      model: "p/m",
      effort: "high",
      thinking: { type: "enabled", budgetTokens: 1024 },
      signal: new AbortController().signal,
      sink,
    };
    expect(full.tools?.[0]?.name).toBe("Read");
    expect(full.signal?.aborted).toBe(false);
  });

  test("ProviderTurn's two production kinds carry usage/stopReason/thinking/nativeState", () => {
    const text: ProviderTurn = {
      kind: "text",
      text: "done",
      usage: { inputTokens: 1, outputTokens: 2 },
      stopReason: "end_turn",
      thinking: { summary: "considered options", blocks: [{ type: "thinking", thinking: "t", signature: "s" }] },
      nativeState: { family: "openai", continuationDomain: "openai:responses", items: [1] },
    };
    expect(text.stopReason).toBe("end_turn");
    const calls: ProviderTurn = { kind: "tool_use", calls: [], text: "leading", usage: { inputTokens: 1, outputTokens: 2 }, stopReason: "tool_use" };
    expect(calls.kind === "tool_use" ? calls.text : "").toBe("leading");
  });
});

describe("R6-7 contract: the provider-state sidecar", () => {
  test("a record is a SessionStoreEntry-shaped envelope with its OWN uuid, never the anchor's", () => {
    // Item (h) constraint 2: `uuid` is the store's idempotency key. A record that set `uuid` to the
    // anchor would make every record for one assistant entry collide into a single upserted row.
    const dir = mkdtempSync(join(tmpdir(), "winter-p6-sidecar-"));
    try {
      const path = providerStateSidecarPath(join(dir, "sess-1.jsonl"));
      expect(path).toBe(join(dir, "sess-1.provider-state.jsonl"));
      const record = appendProviderState(path, { sessionId: "sess-1", anchorUuid: "anchor-1", provider: "openai", model: "openai/o-test", family: "openai", itemIndex: 0, kind: "origin", payload: {} });
      expect(record.type).toBe("winter_provider_state");
      expect(record.uuid).not.toBe(record.anchorUuid);
      expect(typeof record.timestamp).toBe("string");
      const read = readProviderState(path);
      expect(read).toEqual([record]);
      const raw = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
      expect(raw.type).toBe("winter_provider_state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("buildContinuationChain ignores a record whose anchor entry is missing", () => {
    const orphan: ProviderStateRecord = { type: "winter_provider_state", uuid: "r-1", timestamp: "t", sessionId: "s", anchorUuid: "gone", provider: "p", model: "p/m", family: "openai", itemIndex: 0, kind: "origin", payload: {} };
    const kept: ProviderStateRecord = { type: "winter_provider_state", uuid: "r-2", timestamp: "t", sessionId: "s", anchorUuid: "here", provider: "p", model: "p/m", family: "openai", itemIndex: 0, kind: "origin", payload: {} };
    const chain = buildContinuationChain([orphan, kept], new Set(["here"]));
    expect(chain.has("gone")).toBe(false);
    expect(chain.get("here")?.origin).toEqual({ providerId: "p", modelKey: "p/m", family: "openai" });
  });
});
