// Code-mode images: a tool result that carries an image (the Read tool on an image file) reaches the
// model AS AN IMAGE on every provider adapter -- inside the tool result where the vendor's API allows
// it, and otherwise in a message right after the tool results that names the call it came from.
//
// Every test drives the adapter's real `streamTurn` against a loopback fake and reads what the fake
// RECEIVED: the assertions are about the wire, never about what an adapter believed it sent. The fake
// answers every request with a 400, so each turn ends at once; the recorded body is all that matters.
// No real endpoint, key, home directory or Keychain is touched.

import { describe, expect, test } from "bun:test";
import {
  createAzureOpenAIAdapter,
  createChatCompletionsAdapter,
  createCodexOauthAdapter,
  createLocalOpenAIAdapter,
  createMemoryCredentialStore,
  createResponsesAdapter,
  createXaiOauthAdapter,
} from "@yanlinglabs/winter-provider-runtime";
import type { CredentialRef, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { FAST_RETRY, descriptor, testContext } from "@yanlinglabs/winter-provider-runtime/testing";
import { errorResponse, startFake, type FakeServer } from "../fakes/server.ts";
import { ANTHROPIC_MODELS, testAnthropicAdapter, testContext as anthropicContext } from "./anthropic.ts";
import { GOOGLE_MODELS, googleContext, testGoogleAdapter } from "./google.ts";
import { createBedrockHarness } from "./bedrock.ts";

// A real (tiny) PNG's bytes do not matter to any adapter; a distinctive base64 string does -- it is what
// every assertion searches the wire for.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const CALL_ID = "call_read_1";

/** The history an image Read leaves: the call, then its result carrying the image block (claude's Read shape). */
function imageReadHistory(mediaType = "image/png", data = PNG_B64): ProviderMessageLike[] {
  return [
    { role: "user", content: "What is in shot.png?" },
    { role: "assistant", content: [{ type: "tool_use", id: CALL_ID, name: "Read", input: { file_path: "/tmp/shot.png" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }] }] },
  ];
}

/** An ordinary text tool result -- the negative control: it must stay exactly a string on every surface. */
function textReadHistory(): ProviderMessageLike[] {
  return [
    { role: "user", content: "read it" },
    { role: "assistant", content: [{ type: "tool_use", id: CALL_ID, name: "Read", input: { file_path: "/tmp/a.txt" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: CALL_ID, content: "plain file text" }] },
  ];
}

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** Runs one turn against a fake that 400s everything, and returns the ONE request body it received. */
async function wireBody(run: (fake: FakeServer) => AsyncIterable<ProviderEvent>): Promise<Record<string, unknown>> {
  const fake = await startFake({ routes: [], fallback: () => errorResponse(400, { error: { type: "invalid_request_error", message: "fake: recorded" } }) });
  try {
    await drain(run(fake));
    expect(fake.requests.length).toBeGreaterThan(0);
    return JSON.parse(fake.requests[0]!.body) as Record<string, unknown>;
  } finally {
    await fake.close();
  }
}

/** Runs one turn that must be REFUSED before anything is sent; returns the error message. */
async function refusedBeforeWire(run: (fake: FakeServer) => AsyncIterable<ProviderEvent>): Promise<string> {
  const fake = await startFake({ routes: [], fallback: () => errorResponse(400, { error: { message: "fake" } }) });
  try {
    // An adapter reports a refusal as an `error` event (the OpenAI and Google families) or by throwing
    // from the stream (Bedrock); either way nothing may have reached the wire.
    let message: string | undefined;
    try {
      const events = await drain(run(fake));
      message = events.find((e): e is Extract<ProviderEvent, { type: "error" }> => e.type === "error")?.error.message;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(fake.requests).toHaveLength(0);
    expect(message).toBeDefined();
    return message!;
  } finally {
    await fake.close();
  }
}

const DATA_URL = `data:image/png;base64,${PNG_B64}`;
const openAiDescriptors = (providerId: string, inputModalities?: string[]) => (model: string) =>
  descriptor({ key: `${providerId}/${model}`, upstreamId: model, noReasoning: true, ...(inputModalities !== undefined ? { inputModalities } : {}) });
const req = (messages: ProviderMessageLike[], model = "vision-model"): TurnRequest => ({ model, messages });

// --- OpenAI Responses family ----------------------------------------------------------------------------

describe("OpenAI Responses (`openai`): the image rides INSIDE `function_call_output.output` as `input_image`", () => {
  test("image Read -> output is an array with the input_image data URL; no follow-up message", async () => {
    const body = await wireBody((fake) =>
      createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: openAiDescriptors("openai") }).streamTurn(req(imageReadHistory()), testContext({ providerId: "openai", baseUrl: fake.url, local: true })),
    );
    const input = body["input"] as Array<Record<string, unknown>>;
    const output = input.find((i) => i["type"] === "function_call_output")!;
    expect(output["call_id"]).toBe(CALL_ID);
    expect(output["output"]).toEqual([{ type: "input_image", image_url: DATA_URL }]);
    // Nothing after it: the image is not ALSO sent a second time.
    expect(input.at(-1)).toBe(output);
  });

  test("a text-only result is still the plain string (other tools unaffected)", async () => {
    const body = await wireBody((fake) =>
      createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: openAiDescriptors("openai") }).streamTurn(req(textReadHistory()), testContext({ providerId: "openai", baseUrl: fake.url, local: true })),
    );
    const output = (body["input"] as Array<Record<string, unknown>>).find((i) => i["type"] === "function_call_output")!;
    expect(output["output"]).toBe("plain file text");
  });
});

describe("Responses surfaces that do not document an image output (`xai`, Azure, local): the follow-up user message", () => {
  function assertFollowUp(body: Record<string, unknown>): void {
    const input = body["input"] as Array<Record<string, unknown>>;
    const outputIndex = input.findIndex((i) => i["type"] === "function_call_output");
    const output = input[outputIndex]!;
    expect(typeof output["output"]).toBe("string");
    expect(output["output"]).toContain("[image: attached in the user message after the tool results]");
    expect(output["output"] as string).not.toContain(PNG_B64);
    const followUp = input[outputIndex + 1]!;
    expect(followUp).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `The image returned by tool call ${CALL_ID}:` },
        { type: "input_image", image_url: DATA_URL },
      ],
    });
  }

  test("xai (api key) on the Responses adapter", async () => {
    assertFollowUp(
      await wireBody((fake) =>
        createResponsesAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("xai") }).streamTurn(req(imageReadHistory()), testContext({ providerId: "xai", baseUrl: fake.url, local: true })),
      ),
    );
  });

  test("Azure OpenAI (/openai/v1 Responses)", async () => {
    assertFollowUp(
      await wireBody((fake) =>
        createAzureOpenAIAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("azure-openai") }).streamTurn(
          req(imageReadHistory()),
          testContext({ providerId: "azure-openai", baseUrl: fake.url, local: true, apiVersion: "preview" }),
        ),
      ),
    );
  });

  test("a local runner on its Responses surface", async () => {
    assertFollowUp(
      await wireBody((fake) =>
        createLocalOpenAIAdapter({ surface: "responses", retry: FAST_RETRY, descriptors: openAiDescriptors("lm-studio") }).streamTurn(req(imageReadHistory()), testContext({ providerId: "lm-studio", baseUrl: fake.url, local: true })),
      ),
    );
  });
});

describe("Codex (ChatGPT sign-in): the image rides inside `function_call_output`, like OpenAI's own API", () => {
  test("image Read -> input_image inside the output", async () => {
    const ref: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "codex-oauth:acct" };
    const body = await wireBody((fake) => {
      const ctx: ProviderContext = {
        ...testContext({ providerId: "codex-oauth" }),
        credentials: createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: "test-token-codex", accountId: "acct", expiresAt: Date.now() + 3_600_000 }]]),
        authRef: ref,
      };
      return createCodexOauthAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined }).streamTurn(req(imageReadHistory(), "gpt-5.6-sol"), ctx);
    });
    const output = (body["input"] as Array<Record<string, unknown>>).find((i) => i["type"] === "function_call_output")!;
    expect(output["output"]).toEqual([{ type: "input_image", image_url: DATA_URL }]);
  });
});

// --- OpenAI chat completions family ---------------------------------------------------------------------

describe("Chat completions (DeepSeek-class, local runners, xAI OAuth): a `tool` message is text only, so the image follows", () => {
  function assertChatFollowUp(body: Record<string, unknown>): void {
    const messages = body["messages"] as Array<Record<string, unknown>>;
    const toolIndex = messages.findIndex((m) => m["role"] === "tool");
    expect(messages[toolIndex]).toEqual({ role: "tool", tool_call_id: CALL_ID, content: "[image: attached in the user message after the tool results]" });
    expect(messages[toolIndex + 1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: `The image returned by tool call ${CALL_ID}:` },
        { type: "image_url", image_url: { url: DATA_URL } },
      ],
    });
  }

  test("an OpenAI-compatible chat provider", async () => {
    assertChatFollowUp(
      await wireBody((fake) =>
        createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("openrouter") }).streamTurn(req(imageReadHistory()), testContext({ providerId: "openrouter", baseUrl: fake.url, local: true })),
      ),
    );
  });

  test("a local runner (chat surface)", async () => {
    assertChatFollowUp(
      await wireBody((fake) =>
        createLocalOpenAIAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("ollama-local") }).streamTurn(req(imageReadHistory()), testContext({ providerId: "ollama-local", baseUrl: fake.url, local: true })),
      ),
    );
  });

  test("xAI OAuth (a chat-completions surface)", async () => {
    const ref: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "xai-oauth:acct-x" };
    assertChatFollowUp(
      await wireBody((fake) =>
        createXaiOauthAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: openAiDescriptors("xai-oauth") }).streamTurn(req(imageReadHistory()), {
          ...testContext({ providerId: "xai-oauth" }),
          credentials: createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: "test-token-xai-access", refreshToken: "test-token-xai-refresh", accountId: "acct-x", expiresAt: Date.now() + 3_600_000 }]]),
          authRef: ref,
        }),
      ),
    );
  });

  test("a text-only result is still a plain-string tool message with nothing after it", async () => {
    const body = await wireBody((fake) =>
      createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("openrouter") }).streamTurn(req(textReadHistory()), testContext({ providerId: "openrouter", baseUrl: fake.url, local: true })),
    );
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toEqual({ role: "tool", tool_call_id: CALL_ID, content: "plain file text" });
  });
});

// --- Anthropic Messages -----------------------------------------------------------------------------------

describe("Anthropic Messages: the image rides INSIDE `tool_result.content` (the documented shape)", () => {
  test("image Read -> tool_result content [image base64]", async () => {
    const body = await wireBody((fake) => testAnthropicAdapter().streamTurn(req(imageReadHistory(), ANTHROPIC_MODELS.main), anthropicContext(fake.url)));
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const result = messages.flatMap((m) => m.content).find((b) => b["type"] === "tool_result")!;
    expect(result["tool_use_id"]).toBe(CALL_ID);
    expect(result["content"]).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }]);
  });
});

// --- Google GenerateContent -----------------------------------------------------------------------------

describe("Google GenerateContent", () => {
  test("Gemini 3 and later: the image is NESTED in the functionResponse as `parts[].inlineData`", async () => {
    const body = await wireBody((fake) => testGoogleAdapter().streamTurn(req(imageReadHistory(), "gemini-3-pro-preview"), googleContext(fake.url)));
    const contents = body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const last = contents.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "", imageCount: 1 }, parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } },
    ]);
  });

  test("before Gemini 3: the image follows the functionResponse as an `inlineData` part, captioned", async () => {
    const body = await wireBody((fake) => testGoogleAdapter().streamTurn(req(imageReadHistory(), GOOGLE_MODELS.main), googleContext(fake.url)));
    const contents = body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect(contents.at(-1)!.parts).toEqual([
      { functionResponse: { name: "Read", response: { output: "", imageCount: 1 } } },
      { text: "The image returned by the Read call:" },
      { inlineData: { mimeType: "image/png", data: PNG_B64 } },
    ]);
  });

  test("a GIF, which Gemini does not read, becomes a note that says so -- never a request Gemini rejects, never a silent drop", async () => {
    const body = await wireBody((fake) => testGoogleAdapter().streamTurn(req(imageReadHistory("image/gif", GIF_B64), GOOGLE_MODELS.main), googleContext(fake.url)));
    const parts = (body["contents"] as Array<{ parts: Array<Record<string, unknown>> }>).at(-1)!.parts;
    expect(JSON.stringify(parts)).not.toContain(GIF_B64);
    expect(parts[2]!["text"]).toContain("an image/gif image was here");
  });
});

// --- Bedrock Converse -------------------------------------------------------------------------------------

describe("Bedrock Converse", () => {
  test("an Anthropic model: the image rides INSIDE `toolResult.content` as `{image:{format,source:{bytes}}}`", async () => {
    const body = await wireBody((fake) => {
      const harness = createBedrockHarness(fake, { retry: { maxRetries: 0 } });
      return harness.adapter.streamTurn(req(imageReadHistory(), "us.anthropic.claude-sonnet-4-5-20250929-v1:0"), harness.ctx);
    });
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content).toEqual([
      { toolResult: { toolUseId: CALL_ID, content: [{ image: { format: "png", source: { bytes: PNG_B64 } } }], status: "success" } },
    ]);
  });

  test("a model outside Anthropic/Nova (tool-result images are theirs only): the image follows the toolResult", async () => {
    const body = await wireBody((fake) => {
      const harness = createBedrockHarness(fake, { retry: { maxRetries: 0 } });
      return harness.adapter.streamTurn(req(imageReadHistory(), "meta.llama3-2-90b-instruct-v1:0"), harness.ctx);
    });
    const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content).toEqual([
      { toolResult: { toolUseId: CALL_ID, content: [{ text: "[image: attached after the tool results]" }], status: "success" } },
      { text: `The image returned by tool call ${CALL_ID}:` },
      { image: { format: "png", source: { bytes: PNG_B64 } } },
    ]);
  });
});

// --- The text-only gate: no adapter sends an image to a model that reads none ----------------------------

describe("no adapter sends an image to a text-only model (refused before the wire)", () => {
  test("Responses", async () => {
    const message = await refusedBeforeWire((fake) =>
      createResponsesAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("openai", ["text"]) }).streamTurn(req(imageReadHistory()), testContext({ providerId: "openai", baseUrl: fake.url, local: true })),
    );
    expect(message).toContain("does not advertise image input");
  });

  test("chat completions", async () => {
    const message = await refusedBeforeWire((fake) =>
      createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("deepseek", ["text"]) }).streamTurn(req(imageReadHistory()), testContext({ providerId: "deepseek", baseUrl: fake.url, local: true })),
    );
    expect(message).toContain("does not advertise image input");
  });

  test("Bedrock", async () => {
    const message = await refusedBeforeWire((fake) => {
      const harness = createBedrockHarness(fake, { descriptor: descriptor({ key: "bedrock/text-only", upstreamId: "text-only", inputModalities: ["text"], noReasoning: true }) });
      return harness.adapter.streamTurn(req(imageReadHistory(), "text-only"), harness.ctx);
    });
    expect(message).toContain("does not advertise image input");
  });

  test("Anthropic and Google (their pre-existing gates, reached through a tool result)", async () => {
    expect(await refusedBeforeWire((fake) => testAnthropicAdapter().streamTurn(req(imageReadHistory(), ANTHROPIC_MODELS.noVision), anthropicContext(fake.url)))).toContain("does not advertise image input");
    expect(await refusedBeforeWire((fake) => testGoogleAdapter().streamTurn(req(imageReadHistory(), GOOGLE_MODELS.noVision), googleContext(fake.url)))).toContain("does not advertise image input");
  });
});

