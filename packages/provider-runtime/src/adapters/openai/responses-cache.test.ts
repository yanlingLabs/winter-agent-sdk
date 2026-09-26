// WS-23 item 9: OpenAI's `prompt_cache_key` from the Responses body builder (OpenAI Responses and the
// Codex backend share it), only where the row's `promptCacheKey` evidence says the endpoint takes one.
// Kept in its own file so the xAI lane's edits to `responses.test.ts` never collide with it.
import { describe, expect, test } from "bun:test";
import { buildResponsesBody } from "./responses.ts";
import { resolveReasoning } from "./shared.ts";
import { descriptor } from "./testing.ts";
import type { TurnRequest } from "../../types.ts";

const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }], ...over });
const keyed = () => ({ ...descriptor(), promptCacheKey: { value: true, source: "official-doc" as const, confidence: "declared" as const } });

describe("prompt_cache_key (WS-23 item 9)", () => {
  test("a row with the evidence sends the conversation's key", () => {
    const r = req({ cacheKey: "session-1" });
    expect(buildResponsesBody(r, resolveReasoning(r, keyed()), keyed())["prompt_cache_key"]).toBe("session-1");
  });

  test("no evidence, or no key, sends no field (byte-identical to before)", () => {
    const r = req({ cacheKey: "session-1" });
    expect(buildResponsesBody(r, resolveReasoning(r, descriptor()), descriptor())).not.toHaveProperty("prompt_cache_key");
    expect(buildResponsesBody(req(), resolveReasoning(req(), keyed()), keyed())).not.toHaveProperty("prompt_cache_key");
  });

  test("`store: false` is untouched: a routing key keeps nothing server-side", () => {
    const r = req({ cacheKey: "session-1" });
    expect(buildResponsesBody(r, resolveReasoning(r, keyed()), keyed())["store"]).toBe(false);
  });
});
