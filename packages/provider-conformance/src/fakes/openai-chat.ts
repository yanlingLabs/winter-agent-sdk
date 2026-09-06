// Lane A's OpenAI **Chat Completions** fake.
//
// The same shape as the Responses fake and for the same reason: a corpus case should differ from
// its neighbour by one property of a scripted turn, not by a hand-written SSE transcript. What
// differs here is the wire — chunks with `choices[].delta`, tool-call fragments keyed by INDEX, a
// usage chunk that arrives only because `stream_options.include_usage` asked for it, and a
// terminating `[DONE]` that many OpenAI-compatible servers never actually send.

import { jsonResponse, scenarioTable, sseResponse, startFake, type FakeRoute, type FakeServer, type RecordedRequest, type ScenarioResponder, type SseFrame } from "./server.ts";

export interface ChatToolCallScript {
  index: number;
  id: string;
  name: string;
  /** Argument fragments, in order. The first fragment carries the id and name; later ones carry the index alone. */
  argumentChunks: string[];
}

export interface ChatScript {
  id?: string;
  model?: string;
  /** `delta.content` payloads, in order. */
  text?: string[];
  /** `delta.reasoning_content` payloads — DeepSeek's exposed reasoning channel. */
  reasoning?: string[];
  /** Emit the exposed channel under OpenRouter's `reasoning` spelling instead of DeepSeek's `reasoning_content`. */
  reasoningFieldIsPlain?: boolean;
  toolCalls?: ChatToolCallScript[];
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: { prompt: number; completion: number; cachedPrompt?: number };
  /** An error object inside a 200 stream. */
  inlineError?: { message: string; code: string };
  /** A tool-call fragment opening a NEW slot with no id/name — the no-silent-tool-dropping probe. */
  anonymousToolCall?: boolean;
  frameDelayMs?: number;
  /** Omit the terminating `[DONE]` — the shape most local servers actually produce. */
  omitDone?: boolean;
  /** Omit the finish_reason too: a stream that simply stops. */
  omitFinish?: boolean;
}

function chunk(payload: Record<string, unknown>, delayMs?: number): SseFrame {
  return { data: JSON.stringify(payload), ...(delayMs !== undefined ? { delayMs } : {}) };
}

export function chatFrames(script: ChatScript): SseFrame[] {
  const delay = script.frameDelayMs;
  const frames: SseFrame[] = [];
  const id = script.id ?? "chatcmpl-fake-1";
  const model = script.model ?? "fake-model";
  const base = { id, object: "chat.completion.chunk", model };

  frames.push(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }, delay));

  if (script.inlineError !== undefined) {
    frames.push(chunk({ error: { message: script.inlineError.message, code: script.inlineError.code } }, delay));
    return frames;
  }

  for (const text of script.reasoning ?? []) {
    const field = script.reasoningFieldIsPlain === true ? "reasoning" : "reasoning_content";
    frames.push(chunk({ ...base, choices: [{ index: 0, delta: { [field]: text } }] }, delay));
  }

  // Openings first, then fragments interleaved by position — which is what a real stream does and
  // what makes "assembled by index" a claim worth testing.
  for (const call of script.toolCalls ?? []) {
    frames.push(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: call.index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] } }] }, delay));
  }
  const maxFragments = Math.max(0, ...(script.toolCalls ?? []).map((c) => c.argumentChunks.length));
  for (let position = 0; position < maxFragments; position++) {
    for (const call of script.toolCalls ?? []) {
      const fragment = call.argumentChunks[position];
      if (fragment === undefined) continue;
      frames.push(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: call.index, function: { arguments: fragment } }] } }] }, delay));
    }
  }

  if (script.anonymousToolCall === true) {
    frames.push(chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 7, function: { arguments: "{}" } }] } }] }, delay));
  }

  for (const text of script.text ?? []) frames.push(chunk({ ...base, choices: [{ index: 0, delta: { content: text } }] }, delay));

  if (script.omitFinish !== true) {
    frames.push(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: script.finishReason ?? (script.toolCalls !== undefined && script.toolCalls.length > 0 ? "tool_calls" : "stop") }] }, delay));
  }
  if (script.usage !== undefined) {
    frames.push(
      chunk(
        {
          ...base,
          choices: [],
          usage: {
            prompt_tokens: script.usage.prompt,
            completion_tokens: script.usage.completion,
            total_tokens: script.usage.prompt + script.usage.completion,
            ...(script.usage.cachedPrompt !== undefined ? { prompt_tokens_details: { cached_tokens: script.usage.cachedPrompt } } : {}),
          },
        },
        delay,
      ),
    );
  }
  if (script.omitDone !== true) frames.push({ data: "[DONE]", ...(delay !== undefined ? { delayMs: delay } : {}) });
  return frames;
}

export function chatStream(script: ChatScript, opts: { dropAfter?: number } = {}): Response {
  return sseResponse(chatFrames(script), opts.dropAfter !== undefined ? { dropAfter: opts.dropAfter } : {});
}

export function chatModelOf(recorded: RecordedRequest): string | undefined {
  try {
    const body = JSON.parse(recorded.body) as { model?: unknown };
    return typeof body.model === "string" ? body.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wire invariant OpenAI and Azure both enforce: a `tool` message must respond to the assistant
 * `tool_calls` message immediately before it, with only other `tool` messages in between.
 *
 * MODELLED HERE ON PURPOSE. A fake that accepts anything cannot fail a pin, and round 3 is exactly
 * that story: a decoration was rendered as a `user` message between an assistant's `tool_calls` and
 * its `tool` reply, every fixture stayed green, and the shape would have failed every real turn.
 * The DeepSeek and Azure fakes already model their providers' refusals; this closes the gap.
 */
export function toolAdjacencyRefusal(body: string): Response | undefined {
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body) as { messages?: unknown };
  } catch {
    return undefined;
  }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === null || typeof message !== "object" || (message as { role?: unknown }).role !== "tool") continue;
    const previous = i > 0 ? messages[i - 1] : undefined;
    const previousRole = previous !== null && typeof previous === "object" ? (previous as { role?: unknown }).role : undefined;
    const previousCalls = previous !== null && typeof previous === "object" ? (previous as { tool_calls?: unknown }).tool_calls : undefined;
    const respondsToACall = previousRole === "assistant" && Array.isArray(previousCalls) && previousCalls.length > 0;
    const followsAnotherResult = previousRole === "tool";
    if (respondsToACall || followsAnotherResult) continue;
    return jsonResponse(
      {
        error: {
          // The provider's own phrasing, misspelling included.
          message: `Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'.`,
          type: "invalid_request_error",
          param: `messages[${i}].role`,
          code: null,
        },
      },
      400,
    );
  }
  return undefined;
}

export interface OpenAiChatFakeOptions {
  scenarios: Record<string, ScenarioResponder | Response[]>;
  routes?: FakeRoute[];
  unknownModel?: ScenarioResponder;
}

/** Serves `/chat/completions` in every path spelling the family's surfaces use (bare, `/v1`, and Azure's deployment path). */
export async function startOpenAiChatFake(opts: OpenAiChatFakeOptions): Promise<FakeServer> {
  const dispatch = scenarioTable({ modelOf: chatModelOf, scenarios: opts.scenarios, ...(opts.unknownModel !== undefined ? { unknownModel: opts.unknownModel } : {}) });
  const handler = (req: Request, recorded: RecordedRequest): Response | Promise<Response> => toolAdjacencyRefusal(recorded.body) ?? dispatch(req, recorded);
  return startFake({
    routes: [
      { path: "/chat/completions", method: "POST", handler },
      { path: "/v1/chat/completions", method: "POST", handler },
      // Azure's classic surface: `/openai/deployments/<deployment>/chat/completions`.
      { path: "/openai/deployments/*", method: "POST", handler },
      ...(opts.routes ?? []),
    ],
  });
}

/** A DeepSeek-shaped 400 for a tool loop missing its prior `reasoning_content` — §6.3's hard error, reproduced. */
export function deepSeekMissingReasoningError(): Response {
  return jsonResponse(
    {
      error: {
        message: "The last assistant message must contain reasoning_content when tools are used. Please pass back all preceding reasoning_content.",
        type: "invalid_request_error",
        param: "messages",
        code: "invalid_request_error",
      },
    },
    400,
  );
}
