// Phase 6 Task 6 (Lane B): the Google GenerateContent loopback fake.
//
// ADDED beside `fakes/server.ts`, which is FROZEN (R6-12).
//
// The family's stream is JSON-per-event over `?alt=sse` -- each `data:` is a whole
// `GenerateContentResponse` with a `candidates[0].content.parts` array -- so a "frame" here is a
// CHUNK of parts rather than a named event. That difference is exactly why the ordering rules land
// somewhere else than they do for the Anthropic fake: there is no `content_block_stop`, so the only
// thing that marks a turn complete is a chunk carrying `finishReason`, and the completion-event rule
// (`thoughtSignature` is captured only from the completing chunk) has to be proved against THAT.
//
// `thoughtSignature` values in a fixture are OPAQUE MARKERS the assertions search for: the negative
// (`noRequestContains` / "it never reached a log or an error") is only meaningful if the value is
// distinctive.
import { errorResponse, sseResponse, type FakeRoute, type RecordedRequest, type SseFrame, type SseResponseOptions } from "./server.ts";
import { redactOpaqueFields } from "./redact-opaque.ts";

/** One `parts` entry, in the family's own spelling. */
export type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } }
  | { inlineData: { mimeType: string; data: string } };

/** One streamed chunk. A chunk carrying `finishReason` is the COMPLETING one. */
export interface GeminiChunk {
  parts?: GeminiPart[];
  finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "PROHIBITED_CONTENT" | "MALFORMED_FUNCTION_CALL";
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  modelVersion?: string;
  /** A top-level prompt block -- the family's own refusal shape, which carries no candidate at all. */
  promptFeedback?: { blockReason: string };
  delayMs?: number;
}

export function geminiSseFrames(chunks: GeminiChunk[]): SseFrame[] {
  return chunks.map((chunk) => {
    const payload: Record<string, unknown> = {};
    if (chunk.promptFeedback !== undefined) payload["promptFeedback"] = chunk.promptFeedback;
    else {
      payload["candidates"] = [
        {
          content: { role: "model", parts: chunk.parts ?? [] },
          ...(chunk.finishReason !== undefined ? { finishReason: chunk.finishReason } : {}),
          index: 0,
        },
      ];
    }
    if (chunk.usageMetadata !== undefined) payload["usageMetadata"] = chunk.usageMetadata;
    if (chunk.modelVersion !== undefined) payload["modelVersion"] = chunk.modelVersion;
    return { data: JSON.stringify(payload), ...(chunk.delayMs !== undefined ? { delayMs: chunk.delayMs } : {}) };
  });
}

export function geminiStreamResponse(chunks: GeminiChunk[], opts: SseResponseOptions = {}): Response {
  return sseResponse(geminiSseFrames(chunks), opts);
}

/** The family's error envelope: a NUMERIC `error.code` with the machine-readable value in `error.status`. */
export function geminiError(status: number, googleStatus: string, message = "fake error", headers: Record<string, string> = {}): Response {
  return errorResponse(status, { error: { code: status, message, status: googleStatus } }, headers);
}

/**
 * Reads the model id out of a Gemini request.
 *
 * IT IS IN THE PATH, not the body -- `/v1beta/models/<model>:streamGenerateContent` -- which is why
 * the base's `scenarioTable` takes a family-specific `modelOf` instead of guessing.
 */
export function geminiModelOf(recorded: RecordedRequest): string | undefined {
  const match = /\/models\/([^:/]+):/.exec(recorded.path);
  return match?.[1];
}

export function geminiBody(recorded: RecordedRequest): Record<string, unknown> {
  return JSON.parse(recorded.body) as Record<string, unknown>;
}

/** The `contents` array of a recorded request. */
export function geminiContents(recorded: RecordedRequest): Array<{ role?: string; parts?: GeminiPart[] }> {
  const contents = geminiBody(recorded)["contents"];
  return Array.isArray(contents) ? (contents as Array<{ role?: string; parts?: GeminiPart[] }>) : [];
}

export interface GeminiRequestExpectation {
  model?: string;
  /** The whole search string, so `?alt=sse` is asserted as the literal it is. */
  search?: string;
  roles?: string[];
  /** Every part's discriminating KEY (`text` / `functionCall` / `functionResponse` / `inlineData`), flattened in wire order. */
  partKinds?: string[];
  thinkingConfig?: unknown;
  toolConfig?: unknown;
  functionNames?: string[];
  systemInstruction?: string;
  maxOutputTokens?: number;
}

function fail(message: string, recorded: RecordedRequest): never {
  // The HEADERS are already redacted by the base, so a key cannot leak here. The BODY is not, and
  // deliberately so (a body is what a serialization assertion is about) -- but this lane's replay
  // fixtures put a real signature / `redacted_thinking.data` / `thoughtSignature` into it on purpose,
  // and a failure message is the likeliest thing in a test run to be pasted somewhere. Opaque field
  // VALUES are replaced before the message is built; everything a reader needs to diagnose survives.
  throw new Error(`${message}\n  live request: ${recorded.method} ${recorded.path}${recorded.search}\n  headers: ${JSON.stringify(recorded.headers)}\n  body: ${redactOpaqueFields(recorded.body)}`);
}

/** The discriminating key of one part, for an ordering assertion that does not depend on the payload. */
export function partKind(part: GeminiPart): string {
  if ("functionCall" in part) return "functionCall";
  if ("functionResponse" in part) return "functionResponse";
  if ("inlineData" in part) return "inlineData";
  if ("thought" in part && part.thought === true) return "thought";
  return "text";
}

/**
 * Asserts the EXACT request shape on the live request the fake received.
 *
 * `x-goog-api-key` is checked in its REDACTED form -- the base replaces a credential header's
 * material as it records, so asserting on `***` proves both that the adapter authenticated and that
 * the redaction ran.
 */
export function assertGeminiRequest(recorded: RecordedRequest, expected: GeminiRequestExpectation = {}): void {
  if (recorded.method !== "POST") fail(`expected a POST, saw ${recorded.method}`, recorded);
  if (recorded.headers["x-goog-api-key"] !== "***") fail(`expected a redacted x-goog-api-key header, saw ${JSON.stringify(recorded.headers["x-goog-api-key"])}`, recorded);
  if (!(recorded.headers["content-type"] ?? "").startsWith("application/json")) fail(`expected a JSON content-type, saw ${JSON.stringify(recorded.headers["content-type"])}`, recorded);
  if (expected.model !== undefined && geminiModelOf(recorded) !== expected.model) fail(`expected model ${expected.model} in the PATH, saw ${JSON.stringify(geminiModelOf(recorded))}`, recorded);
  if (expected.search !== undefined && recorded.search !== expected.search) fail(`expected search ${expected.search}, saw ${recorded.search}`, recorded);

  const body = geminiBody(recorded);
  const generationConfig = (body["generationConfig"] ?? {}) as Record<string, unknown>;
  if (expected.maxOutputTokens !== undefined && generationConfig["maxOutputTokens"] !== expected.maxOutputTokens) {
    fail(`expected maxOutputTokens ${expected.maxOutputTokens}, saw ${JSON.stringify(generationConfig["maxOutputTokens"])}`, recorded);
  }
  if (expected.thinkingConfig !== undefined && JSON.stringify(generationConfig["thinkingConfig"]) !== JSON.stringify(expected.thinkingConfig)) {
    fail(`expected thinkingConfig ${JSON.stringify(expected.thinkingConfig)}, saw ${JSON.stringify(generationConfig["thinkingConfig"])}`, recorded);
  }
  if (expected.toolConfig !== undefined && JSON.stringify(body["toolConfig"]) !== JSON.stringify(expected.toolConfig)) {
    fail(`expected toolConfig ${JSON.stringify(expected.toolConfig)}, saw ${JSON.stringify(body["toolConfig"])}`, recorded);
  }
  if (expected.functionNames !== undefined) {
    const tools = Array.isArray(body["tools"]) ? (body["tools"] as Array<{ functionDeclarations?: Array<{ name?: unknown }> }>) : [];
    const names = tools.flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name));
    if (JSON.stringify(names) !== JSON.stringify(expected.functionNames)) fail(`expected functionDeclarations ${JSON.stringify(expected.functionNames)}, saw ${JSON.stringify(names)}`, recorded);
  }
  if (expected.systemInstruction !== undefined) {
    const system = body["systemInstruction"] as { parts?: Array<{ text?: unknown }> } | undefined;
    const text = system?.parts?.map((p) => p.text).join("") ?? undefined;
    if (text !== expected.systemInstruction) fail(`expected systemInstruction ${JSON.stringify(expected.systemInstruction)}, saw ${JSON.stringify(text)}`, recorded);
  }

  const contents = geminiContents(recorded);
  if (expected.roles !== undefined) {
    const roles = contents.map((c) => c.role);
    if (JSON.stringify(roles) !== JSON.stringify(expected.roles)) fail(`expected roles ${JSON.stringify(expected.roles)}, saw ${JSON.stringify(roles)}`, recorded);
  }
  if (expected.partKinds !== undefined) {
    const kinds = contents.flatMap((c) => (c.parts ?? []).map(partKind));
    if (JSON.stringify(kinds) !== JSON.stringify(expected.partKinds)) fail(`expected part ordering ${JSON.stringify(expected.partKinds)}, saw ${JSON.stringify(kinds)}`, recorded);
  }
}

/**
 * This dialect's equivalent ordering constraint, enforced so a pin about it can fail.
 *
 * A `functionResponse` answers the turn it follows; a text part placed ahead of one inside the same
 * `user` entry is the shape this lane emitted for a decorated tool message. `inlineData` is exempt:
 * an image the response's Struct could not carry rides beside it by construction.
 *
 * Returns the offending entry index, or `undefined` when every entry is well-formed.
 */
export function findFunctionResponseOrderingViolation(recorded: RecordedRequest): number | undefined {
  let body: { contents?: unknown };
  try {
    body = JSON.parse(recorded.body) as { contents?: unknown };
  } catch {
    return undefined;
  }
  const contents = Array.isArray(body.contents) ? (body.contents as Array<{ parts?: unknown }>) : [];
  for (const [index, entry] of contents.entries()) {
    if (!Array.isArray(entry.parts)) continue;
    let sawOther = false;
    for (const part of entry.parts as GeminiPart[]) {
      const kind = partKind(part);
      if (kind === "functionResponse") {
        if (sawOther) return index;
      } else if (kind !== "inlineData") {
        sawOther = true;
      }
    }
  }
  return undefined;
}

export interface GeminiFakeOptions {
  /** modelId -> the scripted answer for `:streamGenerateContent`. */
  stream: Record<string, ((recorded: RecordedRequest, attempt: number) => Response | Promise<Response>) | Response[]>;
  countTokens?: (recorded: RecordedRequest) => Response;
  /** `GET /v1beta/models` -- discovery and credential validation both land here. */
  models?: (recorded: RecordedRequest) => Response | Promise<Response>;
  /** The path prefix the routes are mounted under. `/v1beta` for the Gemini API, `/v1/projects/...` for Vertex. */
  prefix?: string;
}

/**
 * The routes a Google-family adapter can reach.
 *
 * PREFIX-MATCHED (`path` ending in `*`) rather than exact, because the model id and the method are
 * both IN THE PATH -- `/v1beta/models/gemini-2.5-pro:streamGenerateContent` -- so an exact match
 * would need one route per scenario model.
 */
export function geminiFakeRoutes(opts: GeminiFakeOptions): FakeRoute[] {
  const prefix = opts.prefix ?? "/v1beta";
  const attempts = new Map<string, number>();
  return [
    {
      path: `${prefix}/models*`,
      method: "POST",
      handler: async (_req, recorded) => {
        const badEntry = findFunctionResponseOrderingViolation(recorded);
        if (badEntry !== undefined) {
          return geminiError(400, "INVALID_ARGUMENT", `contents[${badEntry}]: functionResponse parts must precede any other content in their turn`);
        }
        const model = geminiModelOf(recorded) ?? "";
        if (recorded.path.endsWith(":countTokens")) {
          return opts.countTokens?.(recorded) ?? new Response(JSON.stringify({ totalTokens: 42 }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const attempt = (attempts.get(model) ?? 0) + 1;
        attempts.set(model, attempt);
        const entry = opts.stream[model];
        if (entry === undefined) return geminiError(400, "INVALID_ARGUMENT", `fake: no scenario for model ${JSON.stringify(model)}`);
        if (Array.isArray(entry)) return entry[Math.min(attempt - 1, entry.length - 1)]!;
        return await entry(recorded, attempt);
      },
    },
    {
      path: `${prefix}/models`,
      method: "GET",
      handler: async (_req, recorded) => (await opts.models?.(recorded)) ?? new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    },
  ];
}
