// WS-23 (midconv, live gate): a request that ends on an assistant turn is an assistant PREFILL, which
// Opus 4.6+, Opus 5/5.5, Sonnet 5 and Fable 5/5.1 reject with a 400 -- the compaction fallback hit it live
// on claude-opus-5-5. The adapter refuses it typed for a row recording `assistantPrefill: false`, except the
// one legitimate trailing assistant turn: a `pause_turn` resend.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { buildRequestBody } from "./messages.ts";
import type { ProviderMessageLike } from "../../types.ts";

const row = (key: string) => loadCatalog().models.find((m) => m.key === key)!;
const endsOnAssistant: ProviderMessageLike[] = [{ role: "user", content: "one" }, { role: "assistant", content: "the answer is" }];

describe("assistant prefill (WS-23 midconv live gate)", () => {
  test("the catalog records it for every row the migration guides name, and not for a row they do not", () => {
    for (const key of ["anthropic/claude-opus-5-5", "anthropic/claude-opus-4.6", "anthropic/claude-sonnet-5", "anthropic/claude-fable-5-1", "console/claude-opus-5-5"]) expect(row(key).assistantPrefill?.value).toBe(false);
    expect(row("anthropic/claude-sonnet-4.5").assistantPrefill).toBeUndefined();
  });

  test("a request ending on an assistant turn is refused typed on such a row; a trailing system message does not hide it", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: endsOnAssistant }, row("anthropic/claude-opus-5-5"), {})).toThrow(/assistant prefill/);
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [...endsOnAssistant, { role: "system", content: [], outputConfig: { effort: "low" } }] }, row("anthropic/claude-opus-5-5"), {})).toThrow(/assistant prefill/);
  });

  test("exempt: a `pause_turn` resend, a token count, a row that documents nothing, and any request ending on a user turn", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: endsOnAssistant, resumesPausedTurn: true }, row("anthropic/claude-opus-5-5"), {})).not.toThrow();
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: endsOnAssistant }, row("anthropic/claude-opus-5-5"), {}, "count")).not.toThrow();
    expect(() => buildRequestBody({ model: "claude-sonnet-4-5", messages: endsOnAssistant }, row("anthropic/claude-sonnet-4.5"), {})).not.toThrow();
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [...endsOnAssistant, { role: "user", content: "go on" }] }, row("anthropic/claude-opus-5-5"), {})).not.toThrow();
  });
});
