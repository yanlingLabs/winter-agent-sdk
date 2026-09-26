// WS-23 (anthropic-cache, with the bridge pass-through): the prompt-cache fields REACH THE WIRE. The
// real engine drives the real catalog-resolved provider (bridge, history renderer, adapter) against a
// loopback endpoint, and each assertion reads the request body the endpoint actually received:
//   - `promptCacheTtl: "1h"` -> `ttl: "1h"` on the system breakpoints (Anthropic);
//   - cache diagnostics -> `diagnostics.previous_message_id`, `null` first, then the previous response's
//     id (Anthropic's Claude API rows only);
//   - the session id -> `prompt_cache_key` (OpenAI Responses, a row with `promptCacheKey` evidence).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { createSystemPromptAssembler } from "../context/assembler.ts";
import { fakeAnthropicCatalog, startAnthropicFake } from "./anthropic-fake.test-support.ts";
import { SCENARIO_MODELS, startScenarioFake } from "./scenario-fake.ts";

async function drive(config: RuntimeConfig, provider: Provider, identity: { providerId: string; modelKey: string; family: string }, prompts: string[], home: string): Promise<void> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider,
    tools: stubExecutor,
    providerIdentity: identity,
    // The real assembler, so the Anthropic request carries cache-marked system blocks.
    systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
  } as never);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  for (let i = 0; i < prompts.length; i++) {
    host.output.write({ type: "user", text: prompts[i]! });
    for (let n = 0; n < 3000 && results() < i + 1; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
}

describe("the prompt-cache fields on the wire (WS-23 items 6, 8, 9)", () => {
  test("Anthropic: `ttl: \"1h\"` on the system breakpoints, and `diagnostics.previous_message_id` null then the previous response's id", async () => {
    const model = "anthropic/claude-opus-5-5";
    const fake = await startAnthropicFake(() => ({ blocks: [{ type: "text", text: "ok" }], stopReason: "end_turn" }));
    const cwd = mkdtempSync(join(tmpdir(), "winter-ws23-wire-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "winter-ws23-wire-home-"));
    try {
      const config = {
        sessionId: "ws23-wire-anthropic",
        cwd,
        model,
        promptCacheTtl: "1h",
        persistSession: false,
        provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      } as RuntimeConfig;
      const wiring = buildSessionProvider({ config, env: {}, catalog: fakeAnthropicCatalog(fake.url, [model]), credentials: createMemoryCredentialStore() });
      await drive(config, wiring.provider, { providerId: wiring.identity!.providerId, modelKey: wiring.identity!.modelKey, family: "anthropic" }, ["one", "two"], home);
      expect(fake.requests).toHaveLength(2);
      const system = fake.requests[0]!.body["system"] as Array<{ cache_control?: Record<string, unknown> }>;
      expect(system.length).toBeGreaterThan(0);
      expect(system.filter((b) => b.cache_control !== undefined).every((b) => b.cache_control!["ttl"] === "1h")).toBe(true);
      expect(fake.requests[0]!.body["diagnostics"]).toEqual({ previous_message_id: null });
      expect(fake.requests[1]!.body["diagnostics"]).toEqual({ previous_message_id: "msg_fake" });
    } finally {
      await fake.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("OpenAI Responses: `prompt_cache_key` is the session id", async () => {
    const model = SCENARIO_MODELS.openaiResponses;
    expect(loadCatalog().models.find((m) => m.key === model)?.promptCacheKey?.value).toBe(true);
    const fake = await startScenarioFake();
    const home = mkdtempSync(join(tmpdir(), "winter-ws23-wire-home-"));
    try {
      const config = {
        sessionId: "ws23-wire-openai",
        cwd: "/tmp/ws23-wire",
        model,
        persistSession: false,
        provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fake.url, local: true } },
      } as RuntimeConfig;
      const wiring = buildSessionProvider({ config, env: {}, credentials: createMemoryCredentialStore() });
      await drive(config, wiring.provider, { providerId: wiring.identity!.providerId, modelKey: wiring.identity!.modelKey, family: "openai" }, ["one"], home);
      const responses = fake.requests.filter((r) => r.path.endsWith("/responses"));
      expect(responses.length).toBeGreaterThan(0);
      expect((JSON.parse(responses[0]!.body) as Record<string, unknown>)["prompt_cache_key"]).toBe("ws23-wire-openai");
    } finally {
      await fake.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
