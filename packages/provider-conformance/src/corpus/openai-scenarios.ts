// The scripted answers the OpenAI-family corpus asks for, one table per SURFACE.
//
// Split out from `openai.ts` so the questions (the cases) and the answers (these scripts) are read
// separately: a case names a scenario, and this file is the single place that says what that
// scenario's wire actually looks like. Both surfaces answer the SAME scenario ids, which is what
// lets one set of cases run against five adapters.

import { errorResponse, type ScenarioResponder } from "../fakes/server.ts";
import { htmlErrorResponse, openAiErrorBody, responsesStream, silentStream } from "../fakes/openai-responses.ts";
import { chatStream, deepSeekMissingReasoningError } from "../fakes/openai-chat.ts";
import { OPAQUE_MARKER, SCENARIO } from "./openai.ts";

/** A `Retry-After` HTTP-DATE roughly two seconds out. Computed per request so it is always in the future. */
function retryAfterDate(): string {
  return new Date(Date.now() + 2000).toUTCString();
}

/** The 429 both surfaces answer with. `Retry-After` in its DATE form — the harder of RFC 7231's two spellings. */
function rateLimited(): Response {
  return errorResponse(429, openAiErrorBody("Rate limit reached for this model.", "rate_limit_exceeded"), { "retry-after": retryAfterDate() });
}

/** A 400 whose structured `code` sits after an unbounded human message — the shape that defeats a truncate-then-parse reader. */
function providerCodeError(): Response {
  const message = `This model's maximum context length is exceeded. ${"Your conversation is too long; please shorten it or start a new one. ".repeat(12)}`;
  return errorResponse(400, openAiErrorBody(message, "context_length_exceeded"));
}

const AUTH_ERROR = (): Response => errorResponse(401, openAiErrorBody("Incorrect API key provided.", "invalid_api_key", "invalid_request_error"));

// --- the Responses surface -----------------------------------------------------------------------------

export function responsesCorpusScenarios(): Record<string, ScenarioResponder> {
  return {
    [SCENARIO.happy]: () => responsesStream({ text: ["hello ", "world"], usage: { input: 12, output: 5, cachedInput: 4 } }),
    [SCENARIO.tools]: () =>
      responsesStream({ calls: [{ index: 0, itemId: "fc_0", callId: "call_1", name: "Read", argumentChunks: ['{"file_path"', ':"/tmp/x"}'] }], usage: { input: 3, output: 3 } }),
    [SCENARIO.multiTools]: () =>
      responsesStream({
        calls: [1, 2, 3].map((n, index) => ({ index, itemId: `fc_${index}`, callId: `call_${n}`, name: "Read", argumentChunks: [`{"n":${n}}`] })),
      }),
    [SCENARIO.fragmented]: () =>
      responsesStream({ calls: [{ index: 0, itemId: "fc_0", callId: "call_1", name: "Read", argumentChunks: '{"a":1,"b":{"c":[1,2,3]}}'.split("") }] }),
    [SCENARIO.reasoning]: () =>
      responsesStream({
        summary: ["weighed ", "two options"],
        // The `added` copy the fake also emits carries `PARTIAL-…`; capturing it instead of this one
        // is the exact regression `opaque-continuation` is written to catch.
        reasoningItems: [{ index: 0, encrypted: OPAQUE_MARKER, summaryText: "weighed two options" }],
        calls: [{ index: 1, itemId: "fc_1", callId: "call_1", name: "Read", argumentChunks: ["{}"] }],
        usage: { input: 20, output: 8 },
      }),
    [SCENARIO.replay]: () => responsesStream({ text: ["done"], usage: { input: 30, output: 1 } }),
    [SCENARIO.continuationReplay]: () => responsesStream({ text: ["continued"], usage: { input: 40, output: 1 } }),
    [SCENARIO.vision]: () => responsesStream({ text: ["a picture"], usage: { input: 50, output: 2 } }),
    [SCENARIO.slow]: () => responsesStream({ text: ["one", "two", "three", "four"], frameDelayMs: 25, usage: { input: 1, output: 4 } }),
    [SCENARIO.stall]: () => silentStream(1500),
    [SCENARIO.drop]: () => responsesStream({ text: ["half an ", "answer"], usage: { input: 1, output: 1 } }, { dropAfter: 2 }),
    [SCENARIO.auth]: AUTH_ERROR,
    // ODD attempts fail: the corpus runs this scenario twice (error-rate-limit, then
    // retry-after-no-replay), and each run must see one 429 followed by a success.
    [SCENARIO.rateLimit]: (_recorded, attempt) => (attempt % 2 === 1 ? rateLimited() : responsesStream({ text: ["after the limit"], usage: { input: 2, output: 3 } })),
    [SCENARIO.malformed]: () => htmlErrorResponse(400),
    [SCENARIO.providerCode]: providerCodeError,
    [SCENARIO.unrepresentable]: () => responsesStream({ unrepresentableCall: "computer_call", text: ["ignored"] }),
  };
}

// --- the Chat Completions surface -------------------------------------------------------------------------

export function chatCorpusScenarios(): Record<string, ScenarioResponder> {
  return {
    [SCENARIO.happy]: () => chatStream({ text: ["hello ", "world"], finishReason: "stop", usage: { prompt: 12, completion: 5, cachedPrompt: 4 } }),
    [SCENARIO.tools]: () => chatStream({ toolCalls: [{ index: 0, id: "call_1", name: "Read", argumentChunks: ['{"file_path"', ':"/tmp/x"}'] }], usage: { prompt: 3, completion: 3 } }),
    [SCENARIO.multiTools]: () =>
      chatStream({ toolCalls: [1, 2, 3].map((n, index) => ({ index, id: `call_${n}`, name: "Read", argumentChunks: [`{"n":${n}}`] })) }),
    [SCENARIO.fragmented]: () => chatStream({ toolCalls: [{ index: 0, id: "call_1", name: "Read", argumentChunks: '{"a":1,"b":{"c":[1,2,3]}}'.split("") }] }),
    [SCENARIO.reasoning]: () =>
      chatStream({
        reasoning: [OPAQUE_MARKER],
        toolCalls: [{ index: 0, id: "call_1", name: "Read", argumentChunks: ["{}"] }],
        usage: { prompt: 20, completion: 8 },
      }),
    [SCENARIO.replay]: () => chatStream({ text: ["done"], finishReason: "stop", usage: { prompt: 30, completion: 1 } }),
    // §6.3's HARD ERROR, reproduced: with tools in play, a request that dropped the preceding
    // `reasoning_content` is answered 400. That is what makes the replay fixture a proof rather than
    // an assertion about a string in a body nobody would have rejected.
    [SCENARIO.continuationReplay]: (recorded) =>
      recorded.body.includes("reasoning_content") ? chatStream({ text: ["continued"], finishReason: "stop", usage: { prompt: 40, completion: 1 } }) : deepSeekMissingReasoningError(),
    [SCENARIO.vision]: () => chatStream({ text: ["a picture"], finishReason: "stop", usage: { prompt: 50, completion: 2 } }),
    [SCENARIO.slow]: () => chatStream({ text: ["one", "two", "three", "four"], finishReason: "stop", frameDelayMs: 25, usage: { prompt: 1, completion: 4 } }),
    [SCENARIO.stall]: () => silentStream(1500),
    [SCENARIO.drop]: () => chatStream({ text: ["half an ", "answer"], finishReason: "stop", usage: { prompt: 1, completion: 1 } }, { dropAfter: 2 }),
    [SCENARIO.auth]: AUTH_ERROR,
    [SCENARIO.rateLimit]: (_recorded, attempt) => (attempt % 2 === 1 ? rateLimited() : chatStream({ text: ["after the limit"], finishReason: "stop", usage: { prompt: 2, completion: 3 } })),
    [SCENARIO.malformed]: () => htmlErrorResponse(400),
    [SCENARIO.providerCode]: providerCodeError,
    // The chat surface's unrepresentable call is a fragment that opens a NEW slot with no identity.
    [SCENARIO.unrepresentable]: () => chatStream({ anonymousToolCall: true, text: ["ignored"], finishReason: "stop" }),
  };
}
