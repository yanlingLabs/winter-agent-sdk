// 0.0.56 (W3): per-marker cache lifetimes on the Anthropic Messages wire -- the rolling and lookback
// message breakpoints may be written at 1 hour as well as the system ones, and a request that would put a
// 1-hour breakpoint after a 5-minute one is refused before it is sent.
import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { ProviderRequestError } from "../../http.ts";
import type { ProviderMessageLike, TurnRequest } from "../../types.ts";
import { resolveCacheTtls } from "../cache-ttl.ts";
import { buildRequestBody } from "./messages.ts";

const haiku = loadCatalog().models.find((m) => m.key === "anthropic/claude-haiku-5-5")!;
const A = "You are the character.";
const B = "Today's notes.";
const orgBlocks = [{ text: A, cacheScope: "org" as const }, { text: B, cacheScope: "org" as const }];

/** user q1, assistant a1, then a user turn of 20 text blocks: more than 15 positions after the previous write, so BOTH message breakpoints are placed. */
function longConversation(): ProviderMessageLike[] {
  return [
    { role: "user", content: [{ type: "text", text: "q1" }] },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    { role: "user", content: Array.from({ length: 20 }, (_, i) => ({ type: "text" as const, text: `line ${i}` })) },
  ];
}

function body(over: Partial<TurnRequest>): { system: Array<Record<string, unknown>>; messages: Array<{ content: Array<Record<string, unknown>> }> } {
  return buildRequestBody({ model: "claude-haiku-5-5", messages: longConversation(), system: `${A}\n\n${B}`, systemBlocks: orgBlocks, ...over }, haiku, {}) as never;
}

const rollingMarker = (b: ReturnType<typeof body>) => b.messages[2]!.content[19]!["cache_control"];
const lookbackMarker = (b: ReturnType<typeof body>) => b.messages[0]!.content[0]!["cache_control"];

function refusedWith(fn: () => unknown, needle: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProviderRequestError);
  expect((caught as ProviderRequestError).code).toBe("bad_request");
  expect((caught as ProviderRequestError).message).toContain(needle);
}

describe("per-marker cache TTL (Anthropic Messages)", () => {
  test("the consumer's shape: system = A + blank line + B, systemBlocks [A, B] at scope org, cacheTtl 1h, no system message", () => {
    const b = body({ cacheTtl: "1h" });
    expect(b.system).toEqual([
      { type: "text", text: A, cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: B, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(rollingMarker(b)).toEqual({ type: "ephemeral" });
    expect(lookbackMarker(b)).toEqual({ type: "ephemeral" });
  });

  test("rolling 1h: the lookback marker inherits it, and the whole request is 1-hour", () => {
    const b = body({ cacheTtl: "1h", messageCacheTtl: { rolling: "1h" } });
    expect(rollingMarker(b)).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(lookbackMarker(b)).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("lookback 1h with rolling 5m is valid (longer before shorter)", () => {
    const b = body({ cacheTtl: "1h", messageCacheTtl: { lookback: "1h", rolling: "5m" } });
    expect(lookbackMarker(b)).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(rollingMarker(b)).toEqual({ type: "ephemeral" });
  });

  test("REFUSED: a 1-hour message breakpoint after 5-minute system breakpoints", () => {
    refusedWith(() => body({ messageCacheTtl: { rolling: "1h" } }), "set cacheTtl to \"1h\" too");
    refusedWith(() => body({ cacheTtl: "5m", messageCacheTtl: { lookback: "1h" } }), "set cacheTtl to \"1h\" too");
  });

  test("REFUSED: a 5-minute lookback before a 1-hour rolling breakpoint", () => {
    refusedWith(() => body({ cacheTtl: "1h", messageCacheTtl: { lookback: "5m", rolling: "1h" } }), "messageCacheTtl.lookback");
  });

  test("the refusal is on the DECLARED lifetimes, so it does not depend on whether a lookback marker is placed", () => {
    expect(() => buildRequestBody({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }], system: `${A}\n\n${B}`, systemBlocks: orgBlocks, cacheTtl: "1h", messageCacheTtl: { lookback: "5m", rolling: "1h" } }, haiku, {})).toThrow(ProviderRequestError);
  });

  test("a system prompt with no breakpoint constrains nothing: rolling 1h is accepted with no cacheTtl", () => {
    const b = buildRequestBody({ model: "claude-haiku-5-5", messages: longConversation(), system: `${A}\n\n${B}`, systemBlocks: [{ text: A, cacheScope: null }, { text: B, cacheScope: null }], messageCacheTtl: { rolling: "1h" } }, haiku, {}) as ReturnType<typeof body>;
    expect(rollingMarker(b)).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("an unknown lifetime is refused, typed", () => {
    refusedWith(() => body({ cacheTtl: "1h", messageCacheTtl: { rolling: "24h" as never } }), "messageCacheTtl.rolling");
    refusedWith(() => body({ cacheTtl: "2h" as never }), "cacheTtl must be");
  });

  test("without the caching layout (no systemBlocks) nothing is marked and nothing is refused", () => {
    const b = buildRequestBody({ model: "claude-haiku-5-5", messages: longConversation(), messageCacheTtl: { rolling: "1h" } }, haiku, {});
    expect(JSON.stringify(b)).not.toContain("cache_control");
  });
});

describe("resolveCacheTtls (pure)", () => {
  test("defaults: everything 5 minutes; lookback takes rolling's value", () => {
    expect(resolveCacheTtls({}, true)).toEqual({ system: "5m", lookback: "5m", rolling: "5m" });
    expect(resolveCacheTtls({ cacheTtl: "1h", messageCacheTtl: { rolling: "1h" } }, true)).toEqual({ system: "1h", lookback: "1h", rolling: "1h" });
  });
  test("every non-increasing combination is accepted and every increasing one refused", () => {
    const values = ["5m", "1h"] as const;
    const rank = { "5m": 0, "1h": 1 };
    for (const system of values) for (const lookback of values) for (const rolling of values) {
      const ok = rank[system] >= rank[lookback] && rank[lookback] >= rank[rolling];
      const run = () => resolveCacheTtls({ cacheTtl: system, messageCacheTtl: { lookback, rolling } }, true);
      if (ok) expect(run()).toEqual({ system, lookback, rolling });
      else expect(run).toThrow(ProviderRequestError);
    }
  });
});
