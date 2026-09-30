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

  test("Gemini 3: a GIF is never nested (a nested part holds inline data only) -- it follows as a note", async () => {
    const body = await wireBody((fake) => testGoogleAdapter().streamTurn(req(imageReadHistory("image/gif", GIF_B64), "gemini-3-pro-preview"), googleContext(fake.url)));
    const parts = (body["contents"] as Array<{ parts: Array<Record<string, unknown>> }>).at(-1)!.parts;
    expect(parts[0]).toEqual({ functionResponse: { name: "Read", response: { output: "", imageCount: 1 } } });
    expect(parts[1]).toEqual({ text: "The image returned by the Read call:" });
    expect(parts[2]!["text"]).toContain("an image/gif image was here");
    expect(JSON.stringify(parts)).not.toContain(GIF_B64);
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


// --- Several calls in one round, only some with images; the same results split across messages -------------
//
// A round of three calls -- Read (image), Bash (text), Read (image). Engine history puts the round's
// results on ONE tool message; a history resumed from a claude transcript has ONE MESSAGE PER RESULT.
// Both shapes must reach every surface identically, with nothing placed between two results of the batch.

const PNG2_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeAgMB0bEk+gAAAABJRU5ErkJggg==";
const DATA_URL2 = `data:image/png;base64,${PNG2_B64}`;
const img = (data: string) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data } });

function batchCall(): ProviderMessageLike {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", id: "call_a", name: "Read", input: { file_path: "/tmp/a.png" } },
      { type: "tool_use", id: "call_b", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "call_c", name: "Read", input: { file_path: "/tmp/c.png" } },
    ],
  };
}
const RESULT_A = { type: "tool_result" as const, tool_use_id: "call_a", content: [img(PNG_B64)] };
const RESULT_B = { type: "tool_result" as const, tool_use_id: "call_b", content: "a.png c.png" };
const RESULT_C = { type: "tool_result" as const, tool_use_id: "call_c", content: [img(PNG2_B64)] };

const SHAPES: Record<"one message" | "split across messages", ProviderMessageLike[]> = {
  "one message": [{ role: "user", content: "look at both" }, batchCall(), { role: "tool", content: [RESULT_A, RESULT_B, RESULT_C] }],
  "split across messages": [
    { role: "user", content: "look at both" },
    batchCall(),
    { role: "tool", content: [RESULT_A] },
    { role: "tool", content: [RESULT_B] },
    { role: "tool", content: [RESULT_C] },
  ],
};

const FOLLOWS = "[image: attached in the user message after the tool results]";

for (const [shape, history] of Object.entries(SHAPES)) {
  describe(`a round with images on only some results (${shape})`, () => {
    test("Anthropic: each image inside its own tool_result; the text result untouched", async () => {
      const body = await wireBody((fake) => testAnthropicAdapter().streamTurn(req(history, ANTHROPIC_MODELS.main), anthropicContext(fake.url)));
      const last = (body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>).at(-1)!;
      expect(last.role).toBe("user");
      expect(last.content).toEqual([
        { type: "tool_result", tool_use_id: "call_a", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }] },
        { type: "tool_result", tool_use_id: "call_b", content: "a.png c.png" },
        { type: "tool_result", tool_use_id: "call_c", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG2_B64 } }] },
      ]);
    });

    test("OpenAI Responses and Codex: array outputs for the image results, a string for the text one, nothing after", async () => {
      const openai = await wireBody((fake) =>
        createResponsesAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: openAiDescriptors("openai") }).streamTurn(req(history), testContext({ providerId: "openai", baseUrl: fake.url, local: true })),
      );
      const ref: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "codex-oauth:acct" };
      const codex = await wireBody((fake) =>
        createCodexOauthAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: () => undefined }).streamTurn(req(history, "gpt-5.6-sol"), {
          ...testContext({ providerId: "codex-oauth" }),
          credentials: createMemoryCredentialStore([[ref, { kind: "oauth", accessToken: "test-token-codex", accountId: "acct", expiresAt: Date.now() + 3_600_000 }]]),
          authRef: ref,
        }),
      );
      for (const body of [openai, codex]) {
        const input = body["input"] as Array<Record<string, unknown>>;
        const outputs = input.filter((i) => i["type"] === "function_call_output");
        expect(outputs).toEqual([
          { type: "function_call_output", call_id: "call_a", output: [{ type: "input_image", image_url: DATA_URL }] },
          { type: "function_call_output", call_id: "call_b", output: "a.png c.png" },
          { type: "function_call_output", call_id: "call_c", output: [{ type: "input_image", image_url: DATA_URL2 }] },
        ]);
        expect(input.at(-1)).toEqual(outputs.at(-1));
      }
    });

    test("Responses follow-up (xAI): all outputs first, then ONE user message with each image under its call's caption", async () => {
      const body = await wireBody((fake) =>
        createResponsesAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("xai") }).streamTurn(req(history), testContext({ providerId: "xai", baseUrl: fake.url, local: true })),
      );
      const input = body["input"] as Array<Record<string, unknown>>;
      const firstOutput = input.findIndex((i) => i["type"] === "function_call_output");
      expect(input.slice(firstOutput)).toEqual([
        { type: "function_call_output", call_id: "call_a", output: FOLLOWS },
        { type: "function_call_output", call_id: "call_b", output: "a.png c.png" },
        { type: "function_call_output", call_id: "call_c", output: FOLLOWS },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "The image returned by tool call call_a:" },
            { type: "input_image", image_url: DATA_URL },
            { type: "input_text", text: "The image returned by tool call call_c:" },
            { type: "input_image", image_url: DATA_URL2 },
          ],
        },
      ]);
    });

    test("chat completions follow-up: all tool messages first, then ONE user message -- never a user message between two tool replies", async () => {
      const body = await wireBody((fake) =>
        createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("openrouter") }).streamTurn(req(history), testContext({ providerId: "openrouter", baseUrl: fake.url, local: true })),
      );
      const messages = body["messages"] as Array<Record<string, unknown>>;
      const firstTool = messages.findIndex((m) => m["role"] === "tool");
      expect(messages.slice(firstTool)).toEqual([
        { role: "tool", tool_call_id: "call_a", content: FOLLOWS },
        { role: "tool", tool_call_id: "call_b", content: "a.png c.png" },
        { role: "tool", tool_call_id: "call_c", content: FOLLOWS },
        {
          role: "user",
          content: [
            { type: "text", text: "The image returned by tool call call_a:" },
            { type: "image_url", image_url: { url: DATA_URL } },
            { type: "text", text: "The image returned by tool call call_c:" },
            { type: "image_url", image_url: { url: DATA_URL2 } },
          ],
        },
      ]);
    });

    test("Mistral: each image rides INSIDE its tool message as an image_url chunk; nothing user-role follows a tool reply", async () => {
      const body = await wireBody((fake) =>
        createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("mistral") }).streamTurn(req(history, "mistral-medium-3-5"), testContext({ providerId: "mistral", baseUrl: fake.url, local: true })),
      );
      const messages = body["messages"] as Array<Record<string, unknown>>;
      const firstTool = messages.findIndex((m) => m["role"] === "tool");
      expect(messages.slice(firstTool)).toEqual([
        { role: "tool", tool_call_id: "call_a", content: [{ type: "image_url", image_url: { url: DATA_URL } }] },
        { role: "tool", tool_call_id: "call_b", content: "a.png c.png" },
        { role: "tool", tool_call_id: "call_c", content: [{ type: "image_url", image_url: { url: DATA_URL2 } }] },
      ]);
    });

    test("Gemini before 3: all responses, then each result's images under its caption; Gemini 3: nested in each response", async () => {
      const old = await wireBody((fake) => testGoogleAdapter().streamTurn(req(history, GOOGLE_MODELS.main), googleContext(fake.url)));
      expect((old["contents"] as Array<{ parts: unknown[] }>).at(-1)!.parts).toEqual([
        { functionResponse: { name: "Read", response: { output: "", imageCount: 1 } } },
        { functionResponse: { name: "Bash", response: { output: "a.png c.png" } } },
        { functionResponse: { name: "Read", response: { output: "", imageCount: 1 } } },
        { text: "The image returned by the Read call:" },
        { inlineData: { mimeType: "image/png", data: PNG_B64 } },
        { text: "The image returned by the Read call:" },
        { inlineData: { mimeType: "image/png", data: PNG2_B64 } },
      ]);
      const three = await wireBody((fake) => testGoogleAdapter().streamTurn(req(history, "gemini-3-pro-preview"), googleContext(fake.url)));
      expect((three["contents"] as Array<{ parts: unknown[] }>).at(-1)!.parts).toEqual([
        { functionResponse: { name: "Read", response: { output: "", imageCount: 1 }, parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } },
        { functionResponse: { name: "Bash", response: { output: "a.png c.png" } } },
        { functionResponse: { name: "Read", response: { output: "", imageCount: 1 }, parts: [{ inlineData: { mimeType: "image/png", data: PNG2_B64 } }] } },
      ]);
    });

    test("Bedrock: Claude takes each image in its toolResult; another model gets every toolResult first, then the captioned images", async () => {
      const claude = await wireBody((fake) => {
        const harness = createBedrockHarness(fake, { retry: { maxRetries: 0 } });
        return harness.adapter.streamTurn(req(history, "us.anthropic.claude-sonnet-4-5-20250929-v1:0"), harness.ctx);
      });
      expect((claude["messages"] as Array<{ content: unknown[] }>).at(-1)!.content).toEqual([
        { toolResult: { toolUseId: "call_a", content: [{ image: { format: "png", source: { bytes: PNG_B64 } } }], status: "success" } },
        { toolResult: { toolUseId: "call_b", content: [{ text: "a.png c.png" }], status: "success" } },
        { toolResult: { toolUseId: "call_c", content: [{ image: { format: "png", source: { bytes: PNG2_B64 } } }], status: "success" } },
      ]);
      const other = await wireBody((fake) => {
        const harness = createBedrockHarness(fake, { retry: { maxRetries: 0 } });
        return harness.adapter.streamTurn(req(history, "meta.llama3-2-90b-instruct-v1:0"), harness.ctx);
      });
      expect((other["messages"] as Array<{ content: unknown[] }>).at(-1)!.content).toEqual([
        { toolResult: { toolUseId: "call_a", content: [{ text: "[image: attached after the tool results]" }], status: "success" } },
        { toolResult: { toolUseId: "call_b", content: [{ text: "a.png c.png" }], status: "success" } },
        { toolResult: { toolUseId: "call_c", content: [{ text: "[image: attached after the tool results]" }], status: "success" } },
        { text: "The image returned by tool call call_a:" },
        { image: { format: "png", source: { bytes: PNG_B64 } } },
        { text: "The image returned by tool call call_c:" },
        { image: { format: "png", source: { bytes: PNG2_B64 } } },
      ]);
    });
  });
}

describe("Mistral: trailing content of a tool turn is folded into the last tool message, never a user message after it", () => {
  test("a hook's text after the results joins the last tool message as a text chunk", async () => {
    const history: ProviderMessageLike[] = [
      { role: "user", content: "look" },
      { role: "assistant", content: [{ type: "tool_use", id: CALL_ID, name: "Read", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: CALL_ID, content: [img(PNG_B64)] }, { type: "text", text: "<system-reminder>hook note</system-reminder>" }] },
    ];
    const body = await wireBody((fake) =>
      createChatCompletionsAdapter({ retry: FAST_RETRY, descriptors: openAiDescriptors("mistral") }).streamTurn(req(history, "mistral-large-latest"), testContext({ providerId: "mistral", baseUrl: fake.url, local: true })),
    );
    const messages = body["messages"] as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: CALL_ID,
      content: [
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "text", text: "<system-reminder>hook note</system-reminder>" },
      ],
    });
  });
});
