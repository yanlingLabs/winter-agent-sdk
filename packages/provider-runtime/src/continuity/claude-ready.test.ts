import { describe, expect, test } from "bun:test";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toClaudeReady, type ProviderStateRecord } from "./claude-ready.ts";
import { RECOVERED_REASONING_TAG } from "./decoration.ts";
import type { ContinuityEndpoint } from "./domains.ts";
import type { MessageOrigin } from "../types.ts";

const CLAUDE_TARGET: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/claude-target", family: "anthropic", continuationDomain: "anthropic/claude-target", readableState: "summary" };

/** Maps a bare `modelKey` to a ContinuityEndpoint whose continuationDomain equals the modelKey itself -- so "same domain as target" is simply "modelKey === CLAUDE_TARGET.modelKey", and any other modelKey is a real cross-domain boundary. */
function resolveEndpoint(origin: MessageOrigin): ContinuityEndpoint {
  return {
    providerId: origin.providerId,
    modelKey: origin.modelKey,
    family: origin.family,
    continuationDomain: origin.continuationDomain ?? origin.modelKey,
    readableState: origin.family === "anthropic" ? "summary" : origin.family === "deepseek-style" ? "full-exposed" : "summary",
  };
}

function baseOpts(overrides: Partial<{ budgetChars: number }> = {}) {
  return { target: CLAUDE_TARGET, resolveEndpoint, ...overrides };
}

function originRecord(anchorUuid: string, origin: MessageOrigin): ProviderStateRecord {
  return { type: "winter_provider_state", uuid: `${anchorUuid}-origin`, timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s", anchorUuid, provider: origin.providerId, model: origin.modelKey, family: origin.family, ...(origin.continuationDomain !== undefined ? { continuationDomain: origin.continuationDomain } : {}), itemIndex: 0, kind: "origin", payload: {} };
}

function summaryRecord(anchorUuid: string, text: string, material?: "exposed", complete?: boolean): ProviderStateRecord {
  return { type: "winter_provider_state", uuid: `${anchorUuid}-summary`, timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s", anchorUuid, provider: "x", model: "x", family: "x", itemIndex: 1, kind: "summary", payload: { text, ...(material !== undefined ? { material, complete: complete === true } : {}) } };
}

function nativeStateRecord(anchorUuid: string): ProviderStateRecord {
  return { type: "winter_provider_state", uuid: `${anchorUuid}-native`, timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s", anchorUuid, provider: "x", model: "x", family: "x", itemIndex: 1, kind: "native-state", payload: { items: ["MUST-NEVER-BE-READ-AS-MATERIAL"] } };
}

describe("toClaudeReady (W18-14)", () => {
  test("(a) legacy compaction becomes the native shape with the uuids kept", () => {
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "turn one" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "reply one" }] } },
      { type: "compact_summary", uuid: "s1", parentUuid: "a1", message: { role: "user", content: "THE SUMMARY" } },
      { type: "compact_boundary", uuid: "b1", parentUuid: "s1", compact_metadata: { trigger: "manual", pre_tokens: 100, preserved_messages: { anchor_uuid: "s1", uuids: ["a1"] } } },
      { type: "user", uuid: "u2", parentUuid: "b1", message: { role: "user", content: "after" } },
    ];
    const { entries: out } = toClaudeReady(entries, [], baseOpts());
    const boundary = out.find((e) => e.uuid === "b1")!;
    const summary = out.find((e) => e.uuid === "s1")!;
    expect(boundary.type).toBe("system");
    expect(boundary.subtype).toBe("compact_boundary");
    expect(boundary.content).toBe("Conversation compacted");
    expect(boundary.level).toBe("info");
    expect(boundary.parentUuid).toBeNull();
    expect(boundary.logicalParentUuid).toBe("a1");
    expect((boundary.compactMetadata as Record<string, unknown>).trigger).toBe("manual");
    expect((boundary.compactMetadata as Record<string, unknown>).preTokens).toBe(100);
    expect((boundary.compactMetadata as { preservedMessages: unknown }).preservedMessages).toEqual({ anchorUuid: "s1", uuids: ["a1"] });
    expect(summary.type).toBe("user");
    expect(summary.parentUuid).toBe("b1");
    expect((summary.message as { content: string }).content).toContain("THE SUMMARY");
    expect(summary.isCompactSummary).toBe(true);
    expect(summary.isVisibleInTranscriptOnly).toBe(true);
    // uuids never change.
    expect(out.map((e) => e.uuid)).toEqual(["u1", "a1", "s1", "b1", "u2"]);
  });

  test("(b) message.id is stamped, and STABLE across two independent runs", () => {
    const entries: SessionStoreEntry[] = [{ type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }];
    const first = toClaudeReady(entries, [], baseOpts());
    const second = toClaudeReady(entries, [], baseOpts());
    const id1 = (first.entries[0]!.message as { id: string }).id;
    const id2 = (second.entries[0]!.message as { id: string }).id;
    expect(id1).toBe(id2);
    expect(id1).toBe("msg_winter_a1");
    expect((first.entries[0]!.message as { type: string }).type).toBe("message");
  });

  test("(b) an entry that ALREADY has a message.id is never re-stamped", () => {
    const entries: SessionStoreEntry[] = [{ type: "assistant", uuid: "a1", parentUuid: null, message: { id: "msg_real_claude_id", type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] } }];
    const { entries: out } = toClaudeReady(entries, [], baseOpts());
    expect((out[0]!.message as { id: string }).id).toBe("msg_real_claude_id");
  });

  test("(c) a tool id failing the pattern, or exceeding 128 chars, is remapped consistently in the tool_use and its tool_result", () => {
    const longId = "x".repeat(200);
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "tool_use", id: "bad id with spaces!", name: "Read", input: {} }, { type: "tool_use", id: longId, name: "Write", input: {} }] } },
      { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bad id with spaces!", content: "ok" }, { type: "tool_result", tool_use_id: longId, content: "ok2" }] } },
    ];
    const { entries: out } = toClaudeReady(entries, [], baseOpts());
    const assistantBlocks = (out.find((e) => e.uuid === "a1")!.message as { content: Array<Record<string, unknown>> }).content;
    const userBlocks = (out.find((e) => e.uuid === "u2")!.message as { content: Array<Record<string, unknown>> }).content;
    const id1 = assistantBlocks[0]!.id as string;
    const id2 = assistantBlocks[1]!.id as string;
    expect(id1).toMatch(/^toolu_winter_[0-9a-f]{32}$/);
    expect(id2).toMatch(/^toolu_winter_[0-9a-f]{32}$/);
    expect(id1).not.toBe(id2);
    expect(userBlocks[0]!.tool_use_id).toBe(id1);
    expect(userBlocks[1]!.tool_use_id).toBe(id2);
    // Deterministic: the SAME source id always remaps to the SAME replacement.
    const { entries: out2 } = toClaudeReady(entries, [], baseOpts());
    expect((out2.find((e) => e.uuid === "a1")!.message as { content: Array<Record<string, unknown>> }).content[0]!.id).toBe(id1);
  });

  test("(c) a VALID short tool id is never touched", () => {
    const entries: SessionStoreEntry[] = [{ type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] } }];
    const { entries: out } = toClaudeReady(entries, [], baseOpts());
    expect(((out[0]!.message as { content: Array<Record<string, unknown>> }).content[0] as { id: string }).id).toBe("call_1");
  });

  test("(d) a non-first-party thinking/redacted_thinking block is dropped -- foreign origin, different domain", () => {
    const foreignOrigin: MessageOrigin = { providerId: "anthropic", modelKey: "anthropic/claude-OLD-domain", family: "anthropic", continuationDomain: "anthropic/claude-OLD-domain" };
    const entries: SessionStoreEntry[] = [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: null,
        message: { role: "assistant", content: [{ type: "thinking", thinking: "must be dropped", signature: "SIG-MUST-NOT-SURVIVE" }, { type: "redacted_thinking", data: "DATA-MUST-NOT-SURVIVE" }, { type: "text", text: "visible answer" }] },
      },
    ];
    const records = [originRecord("a1", foreignOrigin), summaryRecord("a1", "the model's own summary")];
    const { entries: out } = toClaudeReady(entries, records, baseOpts());
    const content = (out[0]!.message as { content: Array<Record<string, unknown>> }).content;
    expect(content.some((b) => b.type === "thinking")).toBe(false);
    expect(content.some((b) => b.type === "redacted_thinking")).toBe(false);
    expect(JSON.stringify(content)).not.toContain("SIG-MUST-NOT-SURVIVE");
    expect(JSON.stringify(content)).not.toContain("DATA-MUST-NOT-SURVIVE");
    expect(content.some((b) => b.type === "text" && (b.text as string) === "visible answer")).toBe(true);
  });

  test("(d) a FIRST-PARTY entry in the TARGET's own domain keeps its thinking blocks (with real signatures) unchanged", () => {
    const sameDomainOrigin: MessageOrigin = { providerId: "anthropic", modelKey: CLAUDE_TARGET.modelKey, family: "anthropic", continuationDomain: CLAUDE_TARGET.continuationDomain! };
    const entries: SessionStoreEntry[] = [
      { type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "thinking", thinking: "kept", signature: "SIG-REAL" }, { type: "text", text: "answer" }] } },
    ];
    const { entries: out } = toClaudeReady(entries, [originRecord("a1", sameDomainOrigin)], baseOpts());
    const content = (out[0]!.message as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(JSON.stringify(content)).toContain("SIG-REAL");
  });

  test("(d) an entry with NO sidecar record at all counts as first-party -- kept unchanged", () => {
    const entries: SessionStoreEntry[] = [{ type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "thinking", thinking: "official-written, no sidecar", signature: "SIG-OFFICIAL" }, { type: "text", text: "answer" }] } }];
    const { entries: out } = toClaudeReady(entries, [], baseOpts());
    const content = (out[0]!.message as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  test("(e) a foreign assistant message gets EXACTLY ONE decoration, from the sidecar summary record -- native-state is never read as material", () => {
    const foreignOrigin: MessageOrigin = { providerId: "anthropic", modelKey: "anthropic/claude-OLD-domain", family: "anthropic", continuationDomain: "anthropic/claude-OLD-domain" };
    const entries: SessionStoreEntry[] = [
      { type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "thinking", thinking: "private", signature: "SIG" }, { type: "text", text: "answer" }] } },
    ];
    const records = [originRecord("a1", foreignOrigin), summaryRecord("a1", "the readable summary text"), nativeStateRecord("a1")];
    const { entries: out } = toClaudeReady(entries, records, baseOpts());
    const content = (out[0]!.message as { content: Array<Record<string, unknown>> }).content;
    const textBlocks = content.filter((b) => b.type === "text");
    expect(textBlocks).toHaveLength(2); // the original visible answer + exactly one decoration
    const decorationBlock = textBlocks[1]!.text as string;
    expect(decorationBlock).toContain(`<${RECOVERED_REASONING_TAG} kind="summary"`);
    expect(decorationBlock).toContain("the readable summary text");
    expect(JSON.stringify(content)).not.toContain("MUST-NEVER-BE-READ-AS-MATERIAL");
  });

  test("(e) exposed material (sidecar material: \"exposed\") renders kind=\"exposed\"", () => {
    const foreignOrigin: MessageOrigin = { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "deepseek-style", continuationDomain: "deepseek/r-reason" };
    const entries: SessionStoreEntry[] = [{ type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }];
    const records = [originRecord("a1", foreignOrigin), summaryRecord("a1", "the whole raw trace", "exposed", true)];
    const { entries: out } = toClaudeReady(entries, records, baseOpts());
    const content = (out[0]!.message as { content: Array<Record<string, unknown>> }).content;
    const decoration = content.find((b) => b.type === "text" && (b.text as string).includes(RECOVERED_REASONING_TAG))!.text as string;
    expect(decoration).toContain('kind="exposed"');
  });

  test("the budget reports `dropped` when a decoration cannot fit", () => {
    const foreignOrigin: MessageOrigin = { providerId: "anthropic", modelKey: "anthropic/claude-OLD-domain", family: "anthropic", continuationDomain: "anthropic/claude-OLD-domain" };
    const entries: SessionStoreEntry[] = [
      { type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "answer one" }] } },
      { type: "user", uuid: "u1", parentUuid: "a1", message: { role: "user", content: "next" } },
      { type: "assistant", uuid: "a2", parentUuid: "u1", message: { role: "assistant", content: [{ type: "thinking", thinking: "y", signature: "s2" }, { type: "text", text: "answer two" }] } },
    ];
    const records = [
      originRecord("a1", foreignOrigin),
      summaryRecord("a1", "a".repeat(500)),
      originRecord("a2", foreignOrigin),
      summaryRecord("a2", "b".repeat(500)),
    ];
    const unbounded = toClaudeReady(entries, records, baseOpts());
    expect(unbounded.dropped).toBe(0);
    const bounded = toClaudeReady(entries, records, baseOpts({ budgetChars: 10 }));
    expect(bounded.dropped).toBeGreaterThan(0);
  });

  test("the input array is deep-equal before and after (no mutation)", () => {
    const entries: SessionStoreEntry[] = [
      { type: "assistant", uuid: "a1", parentUuid: null, message: { role: "assistant", content: [{ type: "tool_use", id: "bad id!", name: "Read", input: {} }] } },
    ];
    const snapshot = JSON.parse(JSON.stringify(entries));
    toClaudeReady(entries, [], baseOpts());
    expect(entries).toEqual(snapshot);
  });

  test("toClaudeReady(toClaudeReady(x)) == toClaudeReady(x) -- idempotent end to end", () => {
    const foreignOrigin: MessageOrigin = { providerId: "anthropic", modelKey: "anthropic/claude-OLD-domain", family: "anthropic", continuationDomain: "anthropic/claude-OLD-domain" };
    const entries: SessionStoreEntry[] = [
      { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: { role: "assistant", content: [{ type: "tool_use", id: "bad id!", name: "Read", input: {} }, { type: "thinking", thinking: "reasoning", signature: "SIG" }, { type: "text", text: "answer" }] },
      },
      { type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bad id!", content: "ok" }] } },
      { type: "compact_summary", uuid: "s1", parentUuid: "u2", message: { role: "user", content: "SUMMARY" } },
      { type: "compact_boundary", uuid: "b1", parentUuid: "s1", compact_metadata: { trigger: "auto", pre_tokens: 1 } },
    ];
    const records = [originRecord("a1", foreignOrigin), summaryRecord("a1", "readable material")];
    const first = toClaudeReady(entries, records, baseOpts());
    const second = toClaudeReady(first.entries, records, baseOpts());
    expect(second.entries).toEqual(first.entries);
    expect(second.dropped).toBe(first.dropped);
  });
});
