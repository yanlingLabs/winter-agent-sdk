// 0.0.48: the readable-reasoning AUDIT, pinned on the COMPILED catalog and proved on the wire.
//
// The rule (user ruling 2026-10-05): wherever a provider's API can return a readable reasoning summary,
// Winter asks for one, so every reasoning model streams text to the host (`system/reasoning_progress`).
// An adapter asks only where the row's own `reasoning.summaryRequest` evidence says how, so the evidence
// IS the coverage. The pins below name every reasoning row of an audited family that carries none, each
// with the reason it is left out -- a new reasoning row with no evidence fails here and has to be
// decided, not silently left unable to show its thinking.
import { describe, expect, test } from "bun:test";
import { loadCatalog, type WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { createGoogleGenerateContentAdapter, createResponsesAdapter } from "@yanlinglabs/winter-provider-runtime";
import { FAST_RETRY, testContext } from "@yanlinglabs/winter-provider-runtime/testing";
import { foldProviderStream } from "../../../runtime/src/provider/bridge.ts";
import { sseResponse, withFake } from "../fakes/server.ts";
import { geminiBody, geminiFakeRoutes, geminiStreamResponse } from "../fakes/gemini.ts";
import { googleContext } from "./google.ts";

const catalog = loadCatalog();
const reasoningRows = (providerId: string): WinterModelDescriptor[] => catalog.models.filter((m) => m.providerId === providerId && m.reasoning?.supported.value === true);
const withoutRequest = (providerId: string): string[] => reasoningRows(providerId).filter((m) => m.reasoning?.summaryRequest === undefined).map((m) => m.key).sort();

describe("every reasoning row that can return a readable summary asks for one", () => {
  test("OpenAI (Responses): all but o3-mini", () => {
    // o3-mini: Azure's support table marks it without reasoning summaries, and OpenAI's own guide names
    // no summarizer for it -- asking would risk a 400 on a request that otherwise works.
    expect(withoutRequest("openai")).toEqual(["openai/o3-mini"]);
    for (const row of reasoningRows("openai")) if (row.reasoning?.summaryRequest !== undefined) expect([row.key, row.reasoning.summaryRequest.value.field]).toEqual([row.key, "reasoning.summary"]);
  });

  test("codex-oauth: all, as before", () => {
    expect(withoutRequest("codex-oauth")).toEqual([]);
  });

  test("Azure OpenAI (Responses leg): every model the support table marks with Reasoning summary", () => {
    // Left out, per https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning (read
    // 2026-10-05): o1, o3-mini and o3-pro are marked WITHOUT reasoning summaries; the GPT-6 table has no
    // Reasoning summary row at all; gpt-chat-latest, gpt-oss-* and o1-mini are not in either table.
    expect(withoutRequest("azure-openai")).toEqual(
      ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-chat-latest", "gpt-oss-120b", "gpt-oss-20b", "o1", "o1-mini", "o3-mini", "o3-pro"].map((id) => `azure-openai/${id}`),
    );
    // The gpt-5 series takes no `concise`; `auto` is what is sent everywhere.
    const gpt5 = catalog.models.find((m) => m.key === "azure-openai/gpt-5.4")!;
    expect(gpt5.reasoning?.summaryRequest?.value).toEqual({ field: "reasoning.summary", values: ["auto", "detailed"] });
  });

  test("xAI: grok-4.7 alone -- the only model whose docs expose reasoning summaries", () => {
    // https://docs.x.ai/developers/model-capabilities/text/reasoning: "For grok-4.7, we expose
    // summarizations of the model's internal reasoning"; no other Grok model is documented as returning
    // reasoning text.
    expect(withoutRequest("xai")).toEqual(["xai/grok-4.20-0309-reasoning", "xai/grok-4.20-multi-agent-0309", "xai/grok-4.3", "xai/grok-4.5", "xai/grok-4.6", "xai/grok-build-0.1"]);
  });

  test("Gemini API and Vertex: every Gemini 2.5+ row; Gemma is not a Gemini thinking model", () => {
    // "Thought summaries are supported in Gemini 2.5 and later models" (Vertex's thinking page, read
    // 2026-10-05); Gemma 4 is in neither thinking list.
    expect(withoutRequest("google")).toEqual(["google/gemma-4-26b-a4b-it", "google/gemma-4-31b-it"]);
    expect(withoutRequest("vertex")).toEqual([]);
    for (const providerId of ["google", "vertex"]) {
      for (const row of reasoningRows(providerId)) {
        if (row.reasoning?.summaryRequest === undefined) continue;
        expect([row.key, row.reasoning.summaryRequest.value]).toEqual([row.key, { field: "thinkingConfig.includeThoughts", values: ["true"] }]);
      }
    }
  });

  test("Claude (anthropic, console): every row whose default would hide its thinking", () => {
    // Opus 4.5/4.6 and Sonnet 4.5/4.6 return summarized thinking BY DEFAULT ("summarized ... is the
    // default on Claude Opus 4.6, Claude Sonnet 4.6, and earlier models"), so nothing needs asking for.
    for (const providerId of ["anthropic", "console"]) {
      expect(withoutRequest(providerId)).toEqual(["claude-opus-4.5", "claude-opus-4.6", "claude-sonnet-4.5", "claude-sonnet-4.6"].map((id) => `${providerId}/${id}`));
    }
  });
});

describe("on the wire", () => {
  const compiledDescriptor = (model: string, providerId: string) => catalog.models.find((m) => m.providerId === providerId && (m.upstreamId === model || m.key === model));

  test("openai/gpt-5.6-terra (API key) asks for `reasoning.summary: auto` -- the same as its codex-oauth twin", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const frames = [
      { event: "response.created", data: JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } }) },
      { event: "response.completed", data: JSON.stringify({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1 } } }) },
    ];
    await withFake(
      { routes: [{ path: "/responses", method: "POST", handler: (_req, recorded) => (bodies.push(JSON.parse(recorded.body) as Record<string, unknown>), sseResponse(frames)) }] },
      async (fake) => {
        const adapter = createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: compiledDescriptor });
        await foldProviderStream(adapter.streamTurn({ model: "gpt-5.6-terra", messages: [{ role: "user", content: "go" }], effort: "medium", requestSummary: true }, testContext({ providerId: "openai" })));
      },
    );
    expect(bodies[0]!["reasoning"]).toEqual({ effort: "medium", summary: "auto" });
  });

  test("google/gemini-3.5-flash asks for `includeThoughts` beside its thinking level", async () => {
    await withFake(
      { routes: geminiFakeRoutes({ stream: { "gemini-3.5-flash": () => geminiStreamResponse([{ parts: [{ text: "ok" }] }, { finishReason: "STOP", usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]) } }) },
      async (fake) => {
        const adapter = createGoogleGenerateContentAdapter({ catalog, retry: { maxRetries: 0, random: () => 0, sleep: async () => {} }, requestTimeoutMs: 5_000 });
        await foldProviderStream(adapter.streamTurn({ model: "gemini-3.5-flash", messages: [{ role: "user", content: "go" }], effort: "high", requestSummary: true }, googleContext(fake.url)));
        const thinkingConfig = (geminiBody(fake.requests[0]!)["generationConfig"] as Record<string, unknown>)["thinkingConfig"] as Record<string, unknown>;
        expect(thinkingConfig["includeThoughts"]).toBe(true);
      },
    );
  });
});
