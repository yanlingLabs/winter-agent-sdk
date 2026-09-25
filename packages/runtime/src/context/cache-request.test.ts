// WS-23 items 6, 8 and 9 at the engine: what the engine puts on each provider request for the prompt
// cache (the system-prompt lifetime, the cache-routing key, the previous response id for
// diagnostics) and what it reports back on the turn's result. Ground truth is the LIVE provider
// request and the result frame.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { promptCacheTtlFor, runEngine, type EngineOptions, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";

async function drive(opts: { config?: Partial<RuntimeConfig>; prompts: string[]; generate?: (req: ProviderRequest, index: number) => ProviderTurn; engine?: Partial<EngineOptions> }) {
  const requests: ProviderRequest[] = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "ws23-cache-session", cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5", ...(opts.config ?? {}) },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push(req);
        return opts.generate?.(req, requests.length - 1) ?? { kind: "text", text: `reply ${requests.length}` };
      },
    },
    tools: stubExecutor,
    ...(opts.engine ?? {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): Array<Record<string, unknown>> =>
    frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
  for (let i = 0; i < opts.prompts.length; i++) {
    host.output.write({ type: "user", text: opts.prompts[i]! });
    for (let n = 0; n < 2000 && results().length < i + 1; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { requests, results: results() };
}

describe("the system prompt's cache lifetime (WS-23 item 6)", () => {
  test("one reader, defaulting to 5 minutes", () => {
    expect(promptCacheTtlFor({})).toBe("5m");
    expect(promptCacheTtlFor({ promptCacheTtl: "5m" })).toBe("5m");
    expect(promptCacheTtlFor({ promptCacheTtl: "1h" })).toBe("1h");
  });

  test("`promptCacheTtl: \"1h\"` reaches every request; the default sends no field at all", async () => {
    const hour = await drive({ config: { promptCacheTtl: "1h" }, prompts: ["one", "two"] });
    expect(hour.requests.map((r) => r.cacheTtl)).toEqual(["1h", "1h"]);
    const plain = await drive({ prompts: ["one"] });
    expect("cacheTtl" in plain.requests[0]!).toBe(false);
  });

  test("the result's `cache_creation` splits the writes by lifetime as the provider reported them", async () => {
    const { results } = await drive({
      prompts: ["one"],
      generate: () => ({ kind: "text", text: "ok", usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 10, cacheWriteTokens: 248, cacheWrite1hTokens: 100 } }),
    });
    const usage = results[0]!["usage"] as { cache_creation_input_tokens: number; cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number } };
    expect(usage.cache_creation_input_tokens).toBe(248);
    expect(usage.cache_creation).toEqual({ ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 148 });
  });
});

describe("cache diagnostics through the engine (WS-23 item 8)", () => {
  test("the first request opts in with `null`; each later main-loop request names the previous response", async () => {
    const { requests } = await drive({ prompts: ["one", "two"], generate: (_req, i) => ({ kind: "text", text: "ok", responseId: `msg_${i}` }) });
    expect(requests.map((r) => r.cacheDiagnostics)).toEqual([{ previousMessageId: null }, { previousMessageId: "msg_0" }]);
  });

  test("a turn's cache verdicts reach its result usage as `cache_misses`; a clean turn carries no such key", async () => {
    const { results } = await drive({
      prompts: ["one", "two"],
      generate: (_req, i) =>
        i === 1
          ? { kind: "text", text: "ok", usage: { inputTokens: 42, outputTokens: 1, cacheMiss: { type: "system_changed", missedInputTokens: 41850 }, thinkingBlocksDropped: 2 } }
          : { kind: "text", text: "ok", usage: { inputTokens: 42, outputTokens: 1 } },
    });
    expect(results[0]!["usage"]).not.toHaveProperty("cache_misses");
    expect((results[1]!["usage"] as Record<string, unknown>)["cache_misses"]).toEqual([{ type: "system_changed", missed_input_tokens: 41850, thinking_blocks_dropped: 2 }]);
  });
});
