// E4 (dist-session fixes, 2026-09-22; lane D's finding D1): a bare wire model id must be validated
// against THE REQUEST'S OWN PROVIDER's catalog row -- never another provider's that happens to share
// the adapter and the upstream id.
//
// What the installed app did: every turn of a chat on deepseek-v4-flash was refused before sending,
// `model "alibaba-cn/deepseek-v4-flash" declares no reasoning effort vocabulary, so effort "max" cannot
// be mapped onto it`. `createShippedAdapters` handed the OpenAI-family adapters
// `descriptorLookupForAdapter(catalog, adapterId)`, ONE index per ADAPTER keyed by the bare upstream id,
// first provider in catalog order winning. `winter.openai-chat-completions` serves 138 providers, and
// `alibaba-cn` sorts before `deepseek`; the adapter asked that index for `req.model` (the provider-local
// id the bridge puts on the wire) and got alibaba-cn's row -- which declares no effort vocabulary.
//
// The user's ruling: a model is always provider-qualified; the same model on another provider is a
// different tag, and nothing resolves a bare id across providers. The Anthropic and Google adapters
// already looked rows up by `ctx.connection.providerId` + model (`findDescriptor`); every adapter now does.
import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { ProviderEvent, TurnRequest } from "../types.ts";
import { SHIPPED_ADAPTER_IDS, createShippedAdapters, descriptorLookupForAdapter } from "./index.ts";
import { testContext } from "./openai/testing.ts";

/** Adapters whose descriptor lookup the wiring supplies (the Anthropic/Google families derive theirs from the catalog, provider-aware). */
const LOOKUP_ADAPTERS = SHIPPED_ADAPTER_IDS.filter((id) => !["winter.anthropic-messages", "winter.google-generate-content", "winter.vertex-gemini"].includes(id));

describe("descriptorLookupForAdapter: keyed by the request's own provider", () => {
  test("the reported case: deepseek's bare `deepseek-v4-flash` is deepseek's row (effort vocabulary includes `max`), alibaba-cn's is alibaba-cn's", () => {
    const lookup = descriptorLookupForAdapter(loadCatalog(), "winter.openai-chat-completions");
    const deepseek = lookup("deepseek-v4-flash", "deepseek");
    expect(deepseek?.key).toBe("deepseek/deepseek-v4-flash");
    expect(deepseek?.reasoning?.efforts).toContain("max");
    expect(lookup("deepseek-v4-flash", "alibaba-cn")?.key).toBe("alibaba-cn/deepseek-v4-flash");
  });

  test.each(LOOKUP_ADAPTERS.map((id) => [id] as const))("%s: EVERY row of EVERY provider it serves resolves to itself by (upstream id, provider)", (adapterId) => {
    const catalog = loadCatalog();
    const lookup = descriptorLookupForAdapter(catalog, adapterId);
    const providers = new Set(catalog.providers.filter((p) => p.adapterId === adapterId).map((p) => p.id));
    const rows = catalog.models.filter((m) => providers.has(m.providerId));
    const wrong = rows.filter((row) => lookup(row.upstreamId, row.providerId)?.key !== row.key || lookup(row.key, row.providerId)?.key !== row.key).map((row) => row.key);
    expect(wrong).toEqual([]);
  });

  test("a provider this adapter does not serve gets NOTHING, never a row of a provider it does", () => {
    const lookup = descriptorLookupForAdapter(loadCatalog(), "winter.openai-chat-completions");
    expect(lookup("deepseek-v4-flash", "no-such-provider")).toBeUndefined();
    // A qualified key naming ANOTHER provider than the request's is not the request's model either.
    expect(lookup("alibaba-cn/deepseek-v4-flash", "deepseek")).toBeUndefined();
  });

  test("with no provider named, a bare id served by several providers resolves to NONE of them; a globally unique key still resolves", () => {
    const lookup = descriptorLookupForAdapter(loadCatalog(), "winter.openai-chat-completions");
    expect(lookup("deepseek-v4-flash")).toBeUndefined();
    expect(lookup("deepseek/deepseek-v4-flash")?.key).toBe("deepseek/deepseek-v4-flash");
  });
});

// --- the turn itself, through the shipped adapter -------------------------------------------------

async function startChatFake(): Promise<{ url: string; bodies: string[]; close(): Promise<void> }> {
  const bodies: string[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      const chunk = (delta: Record<string, unknown>, finish?: string): string =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "deepseek-v4-flash", choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "" }) + chunk({ content: "ok" }) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, bodies, close: async () => void (await server.stop(true)) };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("the shipped chat adapter validates a deepseek turn against deepseek's own row", () => {
  test("effort `max` on deepseek/deepseek-v4-flash is SENT (mapped onto deepseek's vocabulary), not refused against alibaba-cn's row", async () => {
    const fake = await startChatFake();
    try {
      const adapter = createShippedAdapters(loadCatalog()).find((a) => a.id === "winter.openai-chat-completions")!;
      const req: TurnRequest = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], effort: "max" };
      const events = await collect(adapter.streamTurn(req, testContext({ providerId: "deepseek", baseUrl: fake.url, local: true })));
      const errors = events.filter((e) => e.type === "error");
      expect(errors).toEqual([]);
      expect(fake.bodies).toHaveLength(1);
      const body = JSON.parse(fake.bodies[0]!) as { model: string; reasoning_effort?: unknown };
      expect(body.model).toBe("deepseek-v4-flash");
      expect(body.reasoning_effort).toBeDefined();
    } finally {
      await fake.close();
    }
  });
});
