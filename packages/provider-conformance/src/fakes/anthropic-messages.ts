// Phase 6 Task 6 (Lane B): the Anthropic Messages loopback fake.
//
// ADDED beside `fakes/server.ts`, which is FROZEN (R6-12). Everything here builds on that base's
// primitives (`sseResponse`, `errorResponse`, `scenarioTable`, `RecordedRequest`) and adds exactly
// two things a family fake owes:
//
//   1. THE WIRE SCRIPT. A turn is described as blocks (`text`/`thinking`/`redacted_thinking`/
//      `tool_use`) and rendered into the family's real SSE frame sequence -- `message_start`,
//      `content_block_start`/`_delta`/`_stop` per block, `message_delta`, `message_stop` -- because
//      an adapter's normalizer can only be proved against the frame ORDER a real endpoint produces
//      (derived-shapes-p6.md capture (F): one completion per block, four delta variants, a `ping`
//      that must never reach the consumer).
//   2. THE REQUEST ASSERTION. `assertAnthropicRequest` reads the LIVE request the fake received --
//      never what the adapter believed it sent -- and checks the headers, the API version, the
//      block ordering of the replayed history and the `thinking`/`tool_choice` envelope.
//
// NO REAL KEYS, EVER. Every fixture in this lane authenticates with a `test-key-...` string, and the
// base's own recorder redacts `x-api-key` before it is stored -- so the assertion below checks for
// the REDACTED form, which is also the proof that the redaction happened.
import { errorResponse, sseResponse, type FakeRoute, type RecordedRequest, type SseFrame, type SseResponseOptions } from "./server.ts";

/** One scripted content block. `chunks` are the deltas the wire emits, so a fixture controls fragmentation directly. */
export type AnthropicScriptBlock =
  | { type: "text"; chunks: string[] }
  /** `signature` absent scripts the R6-8 discriminator: capture (F) run (ii), a thinking block with NO signature at all. */
  | { type: "thinking"; chunks: string[]; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; jsonChunks: string[] };

export interface AnthropicTurnScript {
  id?: string;
  model?: string;
  blocks: AnthropicScriptBlock[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal";
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  /** Injects `event: ping` after the FIRST `content_block_start`, exactly where capture (F) put it. */
  ping?: boolean;
  /** Emits an `event: error` frame instead of `message_delta`/`message_stop` -- the mid-stream provider failure. */
  errorAfterBlocks?: { type: string; message: string };
}

const frame = (event: string, data: unknown): SseFrame => ({ event, data: JSON.stringify(data) });

/**
 * Renders a scripted turn into the family's real frame sequence.
 *
 * The ORDER is the point and is taken from capture (F): `message_start`, then per block a
 * `content_block_start` -> its deltas -> `content_block_stop`, then `message_delta` carrying the
 * stop reason and the output-token count, then `message_stop`. A `thinking` block's
 * `signature_delta` arrives LAST inside its own block, which is what makes "capture the block only
 * at `content_block_stop`" a testable rule rather than a stylistic one.
 */
export function anthropicSseFrames(script: AnthropicTurnScript): SseFrame[] {
  const usage = script.usage ?? {};
  const frames: SseFrame[] = [
    frame("message_start", {
      type: "message_start",
      message: {
        id: script.id ?? "msg_fake_1",
        type: "message",
        role: "assistant",
        model: script.model ?? "fake-model",
        content: [],
        usage: {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          ...(usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
          ...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        },
      },
    }),
  ];

  script.blocks.forEach((block, index) => {
    switch (block.type) {
      case "text":
        frames.push(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
        if (index === 0 && script.ping === true) frames.push(frame("ping", { type: "ping" }));
        for (const chunk of block.chunks) {
          frames.push(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } }));
        }
        break;
      case "thinking":
        frames.push(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
        if (index === 0 && script.ping === true) frames.push(frame("ping", { type: "ping" }));
        for (const chunk of block.chunks) {
          frames.push(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: chunk } }));
        }
        if (block.signature !== undefined) {
          frames.push(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }));
        }
        break;
      case "redacted_thinking":
        // A redacted block arrives COMPLETE on its start event -- there is nothing to stream, since
        // its payload is opaque by construction. The `content_block_stop` still follows, which is
        // what keeps "one completion per block" uniform across every block type.
        frames.push(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data: block.data } }));
        if (index === 0 && script.ping === true) frames.push(frame("ping", { type: "ping" }));
        break;
      case "tool_use":
        frames.push(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
        if (index === 0 && script.ping === true) frames.push(frame("ping", { type: "ping" }));
        for (const chunk of block.jsonChunks) {
          frames.push(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: chunk } }));
        }
        break;
    }
    frames.push(frame("content_block_stop", { type: "content_block_stop", index }));
  });

  if (script.errorAfterBlocks !== undefined) {
    frames.push(frame("error", { type: "error", error: script.errorAfterBlocks }));
    return frames;
  }

  frames.push(
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: script.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens ?? 0 },
    }),
  );
  frames.push(frame("message_stop", { type: "message_stop" }));
  return frames;
}

/** The scripted turn as an SSE response. `opts.dropAfter` is the base's mid-stream-drop primitive, counted in FRAMES. */
export function anthropicTurnResponse(script: AnthropicTurnScript, opts: SseResponseOptions = {}): Response {
  return sseResponse(anthropicSseFrames(script), opts);
}

/** Reads the model id out of an Anthropic request body -- the family's `modelOf` for `scenarioTable`. */
export function anthropicModelOf(recorded: RecordedRequest): string | undefined {
  try {
    const body = JSON.parse(recorded.body) as { model?: unknown };
    return typeof body.model === "string" ? body.model : undefined;
  } catch {
    return undefined;
  }
}

/** The parsed body of a recorded Anthropic request, for an assertion that wants to read one field. */
export function anthropicBody(recorded: RecordedRequest): Record<string, unknown> {
  return JSON.parse(recorded.body) as Record<string, unknown>;
}

export interface AnthropicRequestExpectation {
  model?: string;
  apiVersion?: string;
  beta?: string;
  stream?: boolean;
  /** The `type` of every content block of every message, flattened in wire order -- the block-ordering assertion R6-8 needs. */
  blockTypes?: string[];
  /** The wire roles, in order. `tool` is NOT a wire role: a tool result rides a `user` message. */
  roles?: string[];
  thinking?: unknown;
  toolChoice?: unknown;
  toolNames?: string[];
  maxTokens?: number;
  system?: string;
}

function fail(message: string, recorded: RecordedRequest): never {
  // The recorded request is already REDACTED by the base, so embedding it in a failure message
  // cannot leak a key -- which is exactly why the assertion prints it.
  throw new Error(`${message}\n  live request: ${recorded.method} ${recorded.path}${recorded.search}\n  headers: ${JSON.stringify(recorded.headers)}\n  body: ${recorded.body}`);
}

/**
 * Asserts the EXACT request shape on the live request the fake received.
 *
 * `x-api-key` is checked in its REDACTED form (`***`): the base replaces a credential header's
 * material as it records, so asserting on `***` proves both that the adapter authenticated and that
 * the fake's own redaction ran.
 */
export function assertAnthropicRequest(recorded: RecordedRequest, expected: AnthropicRequestExpectation = {}): void {
  if (recorded.method !== "POST") fail(`expected a POST, saw ${recorded.method}`, recorded);
  if (recorded.headers["x-api-key"] !== "***") fail(`expected a redacted x-api-key header, saw ${JSON.stringify(recorded.headers["x-api-key"])}`, recorded);
  if (recorded.headers["authorization"] !== undefined) fail("an Anthropic request must authenticate with x-api-key, never Authorization", recorded);
  const version = expected.apiVersion ?? "2023-06-01";
  if (recorded.headers["anthropic-version"] !== version) fail(`expected anthropic-version ${version}, saw ${JSON.stringify(recorded.headers["anthropic-version"])}`, recorded);
  if (!(recorded.headers["content-type"] ?? "").startsWith("application/json")) fail(`expected a JSON content-type, saw ${JSON.stringify(recorded.headers["content-type"])}`, recorded);
  if (expected.beta !== undefined && recorded.headers["anthropic-beta"] !== expected.beta) {
    fail(`expected anthropic-beta ${expected.beta}, saw ${JSON.stringify(recorded.headers["anthropic-beta"])}`, recorded);
  }

  const body = anthropicBody(recorded);
  if (expected.model !== undefined && body["model"] !== expected.model) fail(`expected model ${expected.model}, saw ${JSON.stringify(body["model"])}`, recorded);
  if (expected.stream !== undefined && body["stream"] !== expected.stream) fail(`expected stream ${expected.stream}, saw ${JSON.stringify(body["stream"])}`, recorded);
  if (expected.maxTokens !== undefined && body["max_tokens"] !== expected.maxTokens) fail(`expected max_tokens ${expected.maxTokens}, saw ${JSON.stringify(body["max_tokens"])}`, recorded);
  if (expected.system !== undefined && body["system"] !== expected.system) fail(`expected system ${JSON.stringify(expected.system)}, saw ${JSON.stringify(body["system"])}`, recorded);
  if (expected.thinking !== undefined && JSON.stringify(body["thinking"]) !== JSON.stringify(expected.thinking)) {
    fail(`expected thinking ${JSON.stringify(expected.thinking)}, saw ${JSON.stringify(body["thinking"])}`, recorded);
  }
  if (expected.toolChoice !== undefined && JSON.stringify(body["tool_choice"]) !== JSON.stringify(expected.toolChoice)) {
    fail(`expected tool_choice ${JSON.stringify(expected.toolChoice)}, saw ${JSON.stringify(body["tool_choice"])}`, recorded);
  }
  if (expected.toolNames !== undefined) {
    const tools = Array.isArray(body["tools"]) ? (body["tools"] as Array<{ name?: unknown }>).map((t) => t.name) : [];
    if (JSON.stringify(tools) !== JSON.stringify(expected.toolNames)) fail(`expected tools ${JSON.stringify(expected.toolNames)}, saw ${JSON.stringify(tools)}`, recorded);
  }

  const messages = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ role?: unknown; content?: unknown }>) : [];
  if (expected.roles !== undefined) {
    const roles = messages.map((m) => m.role);
    if (JSON.stringify(roles) !== JSON.stringify(expected.roles)) fail(`expected roles ${JSON.stringify(expected.roles)}, saw ${JSON.stringify(roles)}`, recorded);
  }
  if (expected.blockTypes !== undefined) {
    const types = flattenBlockTypes(messages);
    if (JSON.stringify(types) !== JSON.stringify(expected.blockTypes)) fail(`expected block ordering ${JSON.stringify(expected.blockTypes)}, saw ${JSON.stringify(types)}`, recorded);
  }
}

/** Every message's content-block `type`, flattened in wire order. A string content counts as one `text`. */
export function flattenBlockTypes(messages: Array<{ content?: unknown }>): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push("text");
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<{ type?: unknown }>) out.push(String(block.type));
  }
  return out;
}

/** The blocks of one message of a recorded request, for an assertion about verbatim replay. */
export function messageBlocks(recorded: RecordedRequest, index: number): Array<Record<string, unknown>> {
  const body = anthropicBody(recorded);
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as Array<{ content?: unknown }>) : [];
  const message = messages[index];
  if (message === undefined) return [];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
}

/** A standard Anthropic error envelope: `error.type` is the family's machine-readable code (there is no `error.code`). */
export function anthropicError(status: number, type: string, message = "fake error", headers: Record<string, string> = {}): Response {
  return errorResponse(status, { type: "error", error: { type, message } }, headers);
}

export interface AnthropicFakeOptions {
  /** modelId -> the scripted answer for `POST /v1/messages`. A `Response[]` is indexed by attempt, its last element repeating (the base's own retry shape). */
  messages: ScenarioMap;
  /** The `POST /v1/messages/count_tokens` answer. Absent -> a fixed count, so a fixture that does not care need not script one. */
  countTokens?: (recorded: RecordedRequest) => Response;
  /** The `GET /v1/models` answer -- discovery AND `validateCredential` both land here. */
  models?: (recorded: RecordedRequest) => Response | Promise<Response>;
}

type ScenarioMap = Record<string, ((recorded: RecordedRequest, attempt: number) => Response | Promise<Response>) | Response[]>;

/**
 * The three routes an Anthropic adapter can reach, wired to a model-keyed scenario table.
 *
 * `count_tokens` is registered BEFORE `/v1/messages` deliberately: the base matches routes in order
 * and an exact-path match for `/v1/messages` would otherwise be fine, but keeping the more specific
 * path first makes the ordering independent of that detail.
 */
export function anthropicFakeRoutes(opts: AnthropicFakeOptions): FakeRoute[] {
  const attempts = new Map<string, number>();
  return [
    {
      path: "/v1/messages/count_tokens",
      method: "POST",
      handler: (_req, recorded) => opts.countTokens?.(recorded) ?? new Response(JSON.stringify({ input_tokens: 42 }), { status: 200, headers: { "content-type": "application/json" } }),
    },
    {
      path: "/v1/messages",
      method: "POST",
      handler: async (_req, recorded) => {
        const model = anthropicModelOf(recorded) ?? "";
        const attempt = (attempts.get(model) ?? 0) + 1;
        attempts.set(model, attempt);
        const entry = opts.messages[model];
        if (entry === undefined) return anthropicError(400, "invalid_request_error", `fake: no scenario for model ${JSON.stringify(model)}`);
        if (Array.isArray(entry)) return entry[Math.min(attempt - 1, entry.length - 1)]!;
        return await entry(recorded, attempt);
      },
    },
    {
      path: "/v1/models",
      method: "GET",
      handler: async (_req, recorded) =>
        (await opts.models?.(recorded)) ?? new Response(JSON.stringify({ data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  ];
}
