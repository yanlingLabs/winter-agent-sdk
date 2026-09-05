// Lane A's OpenAI **Responses** fake: a scripted `/responses` endpoint over the T3 fake base.
//
// The base file (`server.ts`) is frozen; this adds the family's own routes, its model-keyed scenario
// reader, and a frame BUILDER — because the interesting corpus cases differ from each other by one
// property of a turn (three tool calls instead of one, arguments split across eight chunks instead
// of arriving whole, a completion event that never comes), and hand-writing an SSE script per case
// makes those differences invisible.
//
// Everything here produces FINITE streams. Task 2's finding stands: an infinitely-pulling loopback
// fake hangs the runner rather than failing the test.

import { jsonResponse, scenarioTable, sseResponse, startFake, type FakeRoute, type FakeServer, type RecordedRequest, type ScenarioResponder, type SseFrame } from "./server.ts";

/** A Responses turn, described by what it CONTAINS rather than by its frames. */
export interface ResponsesScript {
  id?: string;
  model?: string;
  /** `response.output_text.delta` payloads, in order. */
  text?: string[];
  /** `response.reasoning_summary_text.delta` payloads — the readable summary channel. */
  summary?: string[];
  /** Completed reasoning items, by output index. `encrypted` becomes `encrypted_content`; an empty string means "summary only, nothing replayable". */
  reasoningItems?: Array<{ index: number; encrypted: string; summaryText?: string }>;
  calls?: Array<{
    index: number;
    itemId: string;
    callId: string;
    name: string;
    /** When present, arguments arrive as `function_call_arguments.delta` frames. */
    argumentChunks?: string[];
    /** The complete `arguments` string on the final item. Defaults to the joined chunks. */
    argumentsJson?: string;
  }>;
  usage?: { input: number; output: number; cachedInput?: number };
  /** Sets `incomplete_details.reason` on the completion event (`max_output_tokens` is the interesting one). */
  incompleteReason?: string;
  /** Adds a `refusal` content part to the completion's output message. */
  refusal?: boolean;
  /** An output item type this adapter cannot represent (`computer_call`, `mcp_call`, …) — the no-silent-tool-dropping probe. */
  unrepresentableCall?: string;
  /** Milliseconds before EVERY frame. The slow-stream / stall primitive. */
  frameDelayMs?: number;
  /** Emit `response.failed` instead of `response.completed`. */
  failed?: string;
  /** Omit the completion event entirely — a stream that just stops. */
  omitCompleted?: boolean;
}

function frame(payload: Record<string, unknown>, delayMs?: number): SseFrame {
  const event = typeof payload.type === "string" ? payload.type : "message";
  return { event, data: JSON.stringify(payload), ...(delayMs !== undefined ? { delayMs } : {}) };
}

/**
 * A script -> the SSE frames the real API produces, in the real order: created, summary, item
 * openings, argument deltas, text, item completions, completion.
 *
 * The ORDER matters to more than one corpus case — `streaming-order` asserts it survives
 * normalization unreordered, and `opaque-continuation` asserts the reasoning item is taken from the
 * completion side of it rather than from `output_item.added`.
 */
export function responsesFrames(script: ResponsesScript): SseFrame[] {
  const delay = script.frameDelayMs;
  const frames: SseFrame[] = [];
  const responseId = script.id ?? "resp_fake_1";
  frames.push(frame({ type: "response.created", response: { id: responseId, ...(script.model !== undefined ? { model: script.model } : {}), status: "in_progress" } }, delay));

  for (const item of script.reasoningItems ?? []) {
    // The EARLIER copy, deliberately carrying a DIFFERENT encrypted payload: an adapter that took
    // its continuation state from `output_item.added` would replay this one, and the fixture would
    // catch it by name.
    frames.push(frame({ type: "response.output_item.added", output_index: item.index, item: { id: `rs_${item.index}`, type: "reasoning", encrypted_content: `PARTIAL-${item.encrypted}`, status: "in_progress" } }, delay));
  }
  for (const text of script.summary ?? []) frames.push(frame({ type: "response.reasoning_summary_text.delta", delta: text }, delay));

  for (const call of script.calls ?? []) {
    frames.push(frame({ type: "response.output_item.added", output_index: call.index, item: { id: call.itemId, type: "function_call", call_id: call.callId, name: call.name, arguments: "" } }, delay));
    for (const chunk of call.argumentChunks ?? []) frames.push(frame({ type: "response.function_call_arguments.delta", item_id: call.itemId, output_index: call.index, delta: chunk }, delay));
  }

  for (const text of script.text ?? []) frames.push(frame({ type: "response.output_text.delta", delta: text }, delay));

  if (script.unrepresentableCall !== undefined) {
    frames.push(frame({ type: "response.output_item.done", output_index: 99, item: { id: "unrep_1", type: script.unrepresentableCall, status: "completed" } }, delay));
  }

  for (const item of script.reasoningItems ?? []) {
    frames.push(
      frame(
        {
          type: "response.output_item.done",
          output_index: item.index,
          item: {
            id: `rs_${item.index}`,
            type: "reasoning",
            ...(item.summaryText !== undefined ? { summary: [{ type: "summary_text", text: item.summaryText }] } : {}),
            encrypted_content: item.encrypted,
            status: "completed",
          },
        },
        delay,
      ),
    );
  }
  for (const call of script.calls ?? []) {
    frames.push(
      frame(
        {
          type: "response.output_item.done",
          output_index: call.index,
          item: { id: call.itemId, type: "function_call", call_id: call.callId, name: call.name, arguments: call.argumentsJson ?? (call.argumentChunks ?? []).join(""), status: "completed" },
        },
        delay,
      ),
    );
  }

  if (script.failed !== undefined) {
    frames.push(frame({ type: "response.failed", response: { id: responseId, status: "failed", error: { code: "server_error", message: script.failed } } }, delay));
    return frames;
  }
  if (script.omitCompleted === true) return frames;

  const output: unknown[] = [];
  if (script.refusal === true) output.push({ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I cannot help with that." }] });
  frames.push(
    frame(
      {
        type: "response.completed",
        response: {
          id: responseId,
          status: script.incompleteReason !== undefined ? "incomplete" : "completed",
          output,
          ...(script.incompleteReason !== undefined ? { incomplete_details: { reason: script.incompleteReason } } : {}),
          ...(script.usage !== undefined
            ? {
                usage: {
                  input_tokens: script.usage.input,
                  output_tokens: script.usage.output,
                  ...(script.usage.cachedInput !== undefined ? { input_tokens_details: { cached_tokens: script.usage.cachedInput } } : {}),
                },
              }
            : {}),
        },
      },
      delay,
    ),
  );
  return frames;
}

/** A complete SSE response for one script. */
export function responsesStream(script: ResponsesScript, opts: { dropAfter?: number } = {}): Response {
  return sseResponse(responsesFrames(script), opts.dropAfter !== undefined ? { dropAfter: opts.dropAfter } : {});
}

/** Reads the model id out of a Responses request body — the key `scenarioTable` dispatches on. */
export function responsesModelOf(recorded: RecordedRequest): string | undefined {
  try {
    const body = JSON.parse(recorded.body) as { model?: unknown };
    return typeof body.model === "string" ? body.model : undefined;
  } catch {
    return undefined;
  }
}

/** The parsed request body, for a serialization assertion. Always read off the FAKE'S RECORD, never off adapter intent. */
export function recordedBody(recorded: RecordedRequest): Record<string, unknown> {
  return JSON.parse(recorded.body) as Record<string, unknown>;
}

export interface OpenAiResponsesFakeOptions {
  /** modelId -> scripted answer. A `Response[]` is consumed by attempt, with the last entry repeating. */
  scenarios: Record<string, ScenarioResponder | Response[]>;
  /** Extra routes (a `/models` page set, a redirect target). */
  routes?: FakeRoute[];
  unknownModel?: ScenarioResponder;
}

/**
 * Starts a fake serving `/responses` and `/v1/responses` (the adapter's base may or may not carry
 * the `/v1` segment, and a fixture should not have to care which).
 */
export async function startOpenAiResponsesFake(opts: OpenAiResponsesFakeOptions): Promise<FakeServer> {
  const handler = scenarioTable({ modelOf: responsesModelOf, scenarios: opts.scenarios, ...(opts.unknownModel !== undefined ? { unknownModel: opts.unknownModel } : {}) });
  return startFake({
    routes: [
      { path: "/responses", method: "POST", handler },
      { path: "/v1/responses", method: "POST", handler },
      { path: "/openai/v1/responses", method: "POST", handler },
      ...(opts.routes ?? []),
    ],
  });
}

/** An OpenAI-shaped error body: `{ error: { message, type, code } }`, with `code` AFTER an unbounded human message (which is the whole reason `parseProviderErrorCode` reads the full body). */
export function openAiErrorBody(message: string, code: string, type = "invalid_request_error"): Record<string, unknown> {
  return { error: { message, type, param: null, code } };
}

/** A non-JSON body, for the malformed-response case. */
export function htmlErrorResponse(status: number): Response {
  return new Response("<html><body>gateway error</body></html>", { status, headers: { "content-type": "text/html" } });
}

/** A 200 whose body is not SSE at all — the other half of `error-malformed`. */
export function notSseResponse(): Response {
  return jsonResponse({ definitely: "not a stream" }, 200);
}
