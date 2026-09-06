// Phase 6 Task 10: ONE loopback fake, four provider families, three transport legs.
//
// WHY IT LIVES HERE AND NOT IN `winter-provider-conformance`. The two consumers are
// `packages/sdk/src/transport-equivalence.test.ts` and `scripts/differential.ts`, and neither
// package depends on the conformance package (adding the dependency would move the lockfile, which
// is a gate, and would put a Bun-only package on the sdk's own dependency graph). Both ALREADY
// import `winter-agent-runtime`, which is where every other cross-leg fixture lives and for exactly
// the same stated reason: "one definition per scenario, consumed by both, so the two can never
// drift" (`provider/mock.ts`'s own header).
//
// WHY ONE SERVER FOR FOUR FAMILIES. The brief's requirement is that all three legs talk to the SAME
// fake — a spawned child and a compiled binary reach it over a real socket, and an in-memory session
// reaches the identical port. One server means one `baseUrl` to hand every leg and one request log
// to read the ground truth off; four servers would multiply the teardown surface for nothing.
//
// WHAT IT IS NOT. It is not a provider emulator: it answers exactly the scripted turns the P6
// equivalence scenarios need (text -> a tool round -> a final answer) on each family's real wire
// shape, and 404s everything else so an unrouted path fails loudly rather than hanging. The
// per-family wire shapes are the ones the conformance fakes already pin; the SCENARIO here is
// deliberately the smallest thing that proves a whole session ran end to end on a real adapter.
//
// HERMETIC BY CONSTRUCTION: binds `127.0.0.1` on port 0, records every request, and is closed by its
// caller in a `finally`. It holds no credential and never echoes one — a request's `authorization`
// is not read, not logged and not compared.
import { serve } from "bun";

/** One recorded request. `headers` are lower-cased; a credential header keeps its SCHEME and loses its material. */
export interface ScenarioRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
}

export interface ScenarioFake {
  /** `http://127.0.0.1:<port>` — what a `ConnectionProfile.baseUrl` points at. */
  url: string;
  /** Every request received, in order. THE GROUND TRUTH for what a provider was actually asked. */
  requests: ScenarioRequest[];
  close(): Promise<void>;
}

/** The four families this fake serves, and the model key each scenario pins. Real catalog rows, so selection resolves them for real. */
export const SCENARIO_MODELS = {
  anthropic: "anthropic/claude-sonnet-5",
  openaiResponses: "openai/gpt-4.1",
  openaiChat: "deepseek/deepseek-v4-pro",
  gemini: "google/gemini-2.5-flash",
} as const;

/**
 * A REAL row whose `toolCalling` evidence is `native`, in each family.
 *
 * Not an incidental choice: WS-13 §8.1 makes Winter FAIL capability negotiation rather than silently
 * drop tools, so a session pinned to a row the catalog says has no native tool calling cannot run a
 * tool round at all — which is correct behaviour and the wrong subject for an equivalence scenario.
 * `SCENARIO_TOOL_CALLING_NONE` is the row that proves the refusal instead.
 */
export const SCENARIO_TOOL_CALLING_NONE = "anthropic/claude-sonnet-4.5";

/** The CHILD's model for the R6-17 scenario: the same provider, a different row, also `native`. */
export const SCENARIO_CHILD_MODEL = "anthropic/claude-haiku-4-5-20251001";

/**
 * The marker a prompt carries to ask the scripted turn for an `Agent` call instead of a `Glob` one.
 *
 * KEYED ON THE PROMPT rather than on a request counter, for the same reason `carriesToolResult` is:
 * three legs share this fake, and a counter would hand "the delegation turn" to whichever leg asked
 * first.
 */
export const SCENARIO_DELEGATE_MARKER = "winter-t10-delegate";
/** The subagent type the delegation turn asks for. The scenario defines an `agents` entry under this name. */
export const SCENARIO_CHILD_AGENT = "prober";

/** The tool the scripted turn calls, and the text the scripted final turn answers with. Shared so an assertion never re-spells them. */
export const SCENARIO_TOOL_NAME = "Glob";
// A pattern that deterministically matches NOTHING, in any checkout, on any machine: the tool
// round is the subject, and a result that varied with the repository's contents would make a golden
// churn for reasons that have nothing to do with the provider layer.
export const SCENARIO_TOOL_INPUT = { pattern: "*.winter-t10-no-such-file" };
export const SCENARIO_FIRST_TEXT = "checking the tree";
export const SCENARIO_FINAL_TEXT = "the provider scenario is done";

const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "proxy-authorization", "x-amz-security-token"]);

function redactHeaderValue(name: string, value: string): string {
  if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) return value;
  const space = value.indexOf(" ");
  return space > 0 ? `${value.slice(0, space)} ***` : "***";
}

function sse(frames: unknown[], eventNames?: string[]): Response {
  const body = frames
    .map((payload, i) => {
      const event = eventNames?.[i];
      return `${event !== undefined ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`;
    })
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

// --- the four families' scripted turns ------------------------------------------------------------
//
// TURN 1 is text PLUS a tool call in one response — R6-3's own note that "a real model returns text
// AND calls in one turn" — and turn 2 is the final text. `withTool` selects between them, driven by
// whether the request body already contains a tool result.

/** The child model's PROVIDER-LOCAL id — what actually goes on the wire when a child runs its own provider. */
export const SCENARIO_CHILD_WIRE_ID = "claude-haiku-4-5-20251001";

function anthropicFrames(withTool: boolean, delegating = false): { frames: unknown[]; events: string[] } {
  const frames: unknown[] = [{ type: "message_start", message: { id: "msg_p6", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 7, output_tokens: 3 } } }];
  const events = ["message_start"];
  const push = (event: string, payload: unknown): void => {
    events.push(event);
    frames.push(payload);
  };
  if (withTool) {
    const toolName = delegating ? "Agent" : SCENARIO_TOOL_NAME;
    const toolInput = delegating ? { subagent_type: SCENARIO_CHILD_AGENT, description: "r6-17 probe", prompt: "answer briefly" } : SCENARIO_TOOL_INPUT;
    push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SCENARIO_FIRST_TEXT } });
    push("content_block_stop", { type: "content_block_stop", index: 0 });
    push("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_p6", name: toolName, input: {} } });
    push("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } });
    push("content_block_stop", { type: "content_block_stop", index: 1 });
    push("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } });
  } else {
    push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SCENARIO_FINAL_TEXT } });
    push("content_block_stop", { type: "content_block_stop", index: 0 });
    push("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
  }
  push("message_stop", { type: "message_stop" });
  return { frames, events };
}

function responsesFrames(withTool: boolean): unknown[] {
  const out: unknown[] = [{ type: "response.created", response: { id: "resp_p6", model: "gpt-4.1", output: [] } }];
  if (withTool) {
    out.push(
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_p6", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_p6", output_index: 0, content_index: 0, delta: SCENARIO_FIRST_TEXT },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_p6", type: "message", role: "assistant", content: [{ type: "output_text", text: SCENARIO_FIRST_TEXT }] } },
      { type: "response.output_item.added", output_index: 1, item: { id: "fc_p6", type: "function_call", call_id: "call_p6", name: SCENARIO_TOOL_NAME, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_p6", output_index: 1, delta: JSON.stringify(SCENARIO_TOOL_INPUT) },
      { type: "response.output_item.done", output_index: 1, item: { id: "fc_p6", type: "function_call", call_id: "call_p6", name: SCENARIO_TOOL_NAME, arguments: JSON.stringify(SCENARIO_TOOL_INPUT) } },
    );
  } else {
    out.push(
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_p6b", type: "message", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_p6b", output_index: 0, content_index: 0, delta: SCENARIO_FINAL_TEXT },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_p6b", type: "message", role: "assistant", content: [{ type: "output_text", text: SCENARIO_FINAL_TEXT }] } },
    );
  }
  out.push({ type: "response.completed", response: { id: "resp_p6", model: "gpt-4.1", status: "completed", usage: { input_tokens: 7, output_tokens: 4 }, output: [] } });
  return out;
}

function chatFrames(withTool: boolean): unknown[] {
  const base = { id: "chatcmpl-p6", object: "chat.completion.chunk", model: "deepseek-v4-pro" };
  const out: unknown[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }];
  if (withTool) {
    out.push(
      { ...base, choices: [{ index: 0, delta: { content: SCENARIO_FIRST_TEXT } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_p6", type: "function", function: { name: SCENARIO_TOOL_NAME, arguments: "" } }] } }] },
      { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(SCENARIO_TOOL_INPUT) } }] } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    );
  } else {
    out.push({ ...base, choices: [{ index: 0, delta: { content: SCENARIO_FINAL_TEXT } }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  out.push({ ...base, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
  return out;
}

function geminiFrames(withTool: boolean): unknown[] {
  const parts = withTool ? [{ text: SCENARIO_FIRST_TEXT }, { functionCall: { name: SCENARIO_TOOL_NAME, args: SCENARIO_TOOL_INPUT } }] : [{ text: SCENARIO_FINAL_TEXT }];
  return [
    {
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 },
      modelVersion: "gemini-2.5-flash",
    },
  ];
}

/**
 * True when this request body already carries a TOOL RESULT — i.e. it is the second leg of the round.
 *
 * KEYED ON THE BODY, not on a request counter, and that is what makes the fake usable from three legs
 * at once and from a resumed session: a counter would answer "the final turn" to whichever leg
 * happened to ask second, which is precisely the cross-leg coupling these scenarios exist to rule out.
 * Every family spells a tool result differently, so the check is the union of their spellings.
 */
function carriesToolResult(body: string): boolean {
  return body.includes("tool_result") || body.includes("function_call_output") || body.includes("functionResponse") || body.includes('"role":"tool"');
}

/**
 * Starts the shared scenario fake.
 *
 * ALWAYS close it in a `finally`. A leaked fake keeps a port and an event loop alive for the rest of
 * the process, which is how one careless scenario makes an unrelated one flaky.
 */
export interface ScenarioFakeOptions {
  /**
   * Answer each leg's FIRST ATTEMPT at a turn with this status (and `retry-after: 0`), then behave
   * normally — so the retry succeeds.
   *
   * "EACH LEG'S", not "the first request", and the difference is the whole reason this option is a
   * state machine rather than a counter: three legs share one fake, so a plain `requests.length === 1`
   * check fails leg A's first attempt and leaves every other leg's untouched — which is a cross-leg
   * divergence the harness itself invented. The rule below is leg-count-independent: fail a request
   * that opens a turn, never the retry that immediately follows it.
   *
   * `retry-after: 0` deliberately: R6-6 honours the header verbatim up to 60 s, and a scenario that
   * waited a real backoff would spend seconds per leg proving something the delay is not part of.
   */
  firstAttemptStatus?: number;
  /** Answer EVERY request with this status. Drives R6-F's terminal provider failure. */
  alwaysFailStatus?: number;
  /**
   * P6 fix wave (Ruling E-3): answer every request for ONE wire model with this status -- in the body
   * (`"model":"<id>"`) or, for the Gemini family, in the PATH (`/models/<id>:`, the colon so that
   * `gemini-2.5-flash` does not also match `gemini-2.5-flash-lite`) -- and serve every other model
   * normally. `retryAfter` is sent verbatim: R6-6 honours a positive `Retry-After` in place of its
   * jittered backoff, which is what keeps a retries-exhausted scenario at a bounded wall-clock
   * (10 retries x the header, rather than 10 jittered steps capped at 30 s each).
   */
  failModel?: { wireModel: string; status: number; retryAfter?: string };
  /**
   * P6 fix wave round 2 (R-E2): on the Anthropic route, send `message_start` and then DROP the
   * connection -- a failure AFTER the first byte, which the adapter normalizes as a network error
   * (retryable) that the fold has already committed to. The class R6-6 forbids replaying.
   */
  dropAfterFirstEvent?: boolean;
}

export async function startScenarioFake(options: ScenarioFakeOptions = {}): Promise<ScenarioFake> {
  const requests: ScenarioRequest[] = [];
  /** See `firstAttemptStatus`: the retry immediately following a scripted refusal must succeed. */
  let lastWasScriptedRefusal = false;

  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = redactHeaderValue(name, value);
      });
      const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
      requests.push({ method: req.method, path: url.pathname, search: url.search, headers, body });
      if (options.failModel !== undefined && (body.includes(`"model":"${options.failModel.wireModel}"`) || url.pathname.includes(`/models/${options.failModel.wireModel}:`))) {
        return new Response(JSON.stringify({ error: { message: "winter scenario fake: scripted failure for one model", type: "server_error" } }), {
          status: options.failModel.status,
          headers: { "content-type": "application/json", ...(options.failModel.retryAfter !== undefined ? { "retry-after": options.failModel.retryAfter } : {}) },
        });
      }
      if (options.alwaysFailStatus !== undefined) {
        return new Response(JSON.stringify({ error: { message: "winter scenario fake: scripted provider failure", type: "server_error" } }), {
          status: options.alwaysFailStatus,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      if (options.firstAttemptStatus !== undefined && !lastWasScriptedRefusal && !carriesToolResult(body)) {
        lastWasScriptedRefusal = true;
        return new Response(JSON.stringify({ error: { message: "winter scenario fake: scripted first-attempt refusal", type: "rate_limit_error" } }), {
          status: options.firstAttemptStatus,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
            // The pinned rate-limit header families (R6-6). Present so the scenario can assert what
            // Winter does NOT do with them: R6-B keeps `rate_limit_event` for subscription-shaped
            // quota states only, so a header-derived limit must never become a frame.
            "anthropic-ratelimit-requests-limit": "100",
            "anthropic-ratelimit-requests-remaining": "0",
            "x-ratelimit-limit-requests": "100",
            "x-ratelimit-remaining-requests": "0",
          },
        });
      }
      lastWasScriptedRefusal = false;
      const withTool = !carriesToolResult(body);
      // The CHILD's own generation. Identified by the model on the wire, which is the point of the
      // R6-17 scenario: a child running its parent's provider would carry the PARENT's id here, and
      // this branch would never be taken.
      const isChild = body.includes(`"model":"${SCENARIO_CHILD_WIRE_ID}"`);
      const delegating = withTool && !isChild && body.includes(SCENARIO_DELEGATE_MARKER);

      if (url.pathname === "/v1/messages") {
        const { frames, events } = anthropicFrames(withTool && !isChild, delegating);
        if (options.dropAfterFirstEvent === true) {
          const first = `event: ${events[0]}\ndata: ${JSON.stringify(frames[0])}\n\n`;
          const torn = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(first));
              // Errored, not closed: a closed stream is a clean EOF the adapter reports as "incomplete",
              // an ERRORED one is the torn socket a real outage produces.
              setTimeout(() => controller.error(new Error("winter scenario fake: connection dropped after the first event")), 5);
            },
          });
          return new Response(torn, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
        }
        return sse(frames, events);
      }
      if (url.pathname === "/responses") return sse(responsesFrames(withTool));
      if (url.pathname === "/chat/completions") return sse(chatFrames(withTool));
      if (url.pathname.endsWith(":streamGenerateContent")) return sse(geminiFrames(withTool));

      // A 404 whose body names the path: an explicit failure an assertion can read, never a hang.
      return new Response(JSON.stringify({ error: { message: `winter scenario fake: no route for ${req.method} ${url.pathname}` } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    async close(): Promise<void> {
      await server.stop(true);
    },
  };
}
