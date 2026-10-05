// 0.0.48: an endpoint that refuses `reasoning.summary` (an OpenAI organization not verified for
// reasoning summaries) costs ONE failed request per connection and model, not one per turn: the turn is
// retried once without the summary, pre-stream, and the refusal is remembered for the process.
//
// On the WIRE: a loopback server this file owns answers each request from a script, and every case
// asserts what the server received and what the adapter yielded. Hermetic: 127.0.0.1:0 only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { createResponsesAdapter, resetReasoningSummaryRefusalsForTest } from "./responses.ts";
import { httpErrorFrom, isReasoningSummaryRejection } from "./shared.ts";
import { FAST_RETRY, descriptor, testContext } from "./testing.ts";
import type { ProviderEvent } from "../../types.ts";

type Answer = { status: number; body: string };

interface Server {
  url: string;
  bodies: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

const servers: Server[] = [];
beforeEach(() => resetReasoningSummaryRefusalsForTest());
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  resetReasoningSummaryRefusalsForTest();
});

function start(answer: (index: number) => Answer): Server {
  const bodies: Server["bodies"] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
      const a = answer(bodies.length - 1);
      return new Response(a.body, { status: a.status, headers: { "content-type": a.status === 200 ? "text/event-stream" : "application/json" } });
    },
  });
  const s = { url: `http://127.0.0.1:${server.port}`, bodies, stop: async () => void (await server.stop(true)) };
  servers.push(s);
  return s;
}

const frame = (payload: Record<string, unknown>): string => `event: ${String(payload["type"])}\ndata: ${JSON.stringify(payload)}\n\n`;
const ok: Answer = {
  status: 200,
  body:
    frame({ type: "response.created", response: { id: "r1", status: "in_progress" } }) +
    frame({ type: "response.output_text.delta", delta: "done" }) +
    frame({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1 } } }),
};

/** OpenAI's refusal of `reasoning.summary` for an organization not verified for it, in its standard error envelope. */
const VERIFICATION_REFUSAL = JSON.stringify({
  error: {
    message: "Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization. If you just verified, it can take up to 15 minutes for access to propagate.",
    type: "invalid_request_error",
    param: "reasoning.summary",
    code: "unsupported_value",
  },
});
const refused: Answer = { status: 400, body: VERIFICATION_REFUSAL };

function adapter(url: string) {
  return createResponsesAdapter({
    generatedBaseUrl: url,
    retry: FAST_RETRY,
    descriptors: (model) => descriptor({ key: `openai/${model}`, upstreamId: model, efforts: ["low", "medium", "high"], readableState: "summary", summaryValues: ["auto"] }),
  });
}

async function turn(url: string, model: string, logs: Array<{ kind: string; providerId: string; model?: string }> = []): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of adapter(url).streamTurn({ model, messages: [{ role: "user", content: "go" }], effort: "medium", requestSummary: true }, testContext({ logs }))) events.push(e);
  return events;
}

const reasoningOf = (body: Record<string, unknown>) => body["reasoning"];

describe("recognising the refusal: narrow, typed, read off the full body", () => {
  const classify = async (status: number, body: string) => isReasoningSummaryRejection(await httpErrorFrom(new Response(body, { status })));

  test("the organization-verification refusal is one, by its `param` or by its message", async () => {
    expect(await classify(400, VERIFICATION_REFUSAL)).toBe(true);
    // A proxy that drops `param` still carries the message.
    expect(await classify(400, JSON.stringify({ error: { message: "Your organization must be verified to generate reasoning summaries.", type: "invalid_request_error", param: null, code: null } }))).toBe(true);
    // Any refusal of the field itself (a value the model does not take).
    expect(await classify(400, JSON.stringify({ error: { message: "Unsupported value: 'concise' is not supported with this model.", type: "invalid_request_error", param: "reasoning.summary", code: "unsupported_value" } }))).toBe(true);
  });

  test("nothing else is: another field, a stray mention of summaries, a non-JSON body, another status", async () => {
    expect(await classify(400, JSON.stringify({ error: { message: "Unsupported value: 'minimal'", type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" } }))).toBe(false);
    expect(await classify(400, JSON.stringify({ error: { message: "The reasoning summary of your request was too long.", type: "invalid_request_error", param: "input", code: null } }))).toBe(false);
    expect(await classify(400, "Your organization must be verified to generate reasoning summaries.")).toBe(false);
    expect(await classify(403, VERIFICATION_REFUSAL)).toBe(false);
  });
});

describe("the retry and its memory", () => {
  test("a refused summary is retried ONCE without it, and the turn completes; one log line names the provider and model only", async () => {
    const s = start((i) => (i === 0 ? refused : ok));
    const logs: Array<{ kind: string; providerId: string; model?: string }> = [];
    const events = await turn(s.url, "gpt-5.5", logs);
    expect(s.bodies.map(reasoningOf)).toEqual([{ effort: "medium", summary: "auto" }, { effort: "medium" }]);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(events.some((e) => e.type === "error")).toBe(false);
    const dropped = logs.filter((l) => l.kind === "provider.reasoning_summary_dropped");
    expect(dropped).toEqual([{ kind: "provider.reasoning_summary_dropped", providerId: "openai", model: "gpt-5.5", detail: { reason: "reasoning_summary_refused" } } as never]);
    // Nothing of the body reached the log.
    expect(JSON.stringify(logs)).not.toContain("organization");
  });

  test("REMEMBERED: the next turn on the same connection and model sends no summary and logs nothing new; another model still asks", async () => {
    const s = start((i) => (i === 0 ? refused : ok));
    const logs: Array<{ kind: string; providerId: string; model?: string }> = [];
    await turn(s.url, "gpt-5.5", logs);
    await turn(s.url, "gpt-5.5", logs);
    await turn(s.url, "gpt-5.4", logs);
    expect(s.bodies.map(reasoningOf)).toEqual([{ effort: "medium", summary: "auto" }, { effort: "medium" }, { effort: "medium" }, { effort: "medium", summary: "auto" }]);
    expect(logs.filter((l) => l.kind === "provider.reasoning_summary_dropped")).toHaveLength(1);
  });

  test("a second refusal after the retry is the turn's error -- never a loop", async () => {
    const s = start(() => refused);
    const events = await turn(s.url, "gpt-5.5");
    expect(s.bodies).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { code: "bad_request" } });
  });

  test("an UNRELATED 400 is not retried", async () => {
    const s = start(() => ({ status: 400, body: JSON.stringify({ error: { message: "Unsupported value: 'medium'", type: "invalid_request_error", param: "reasoning.effort", code: "unsupported_value" } }) }));
    const events = await turn(s.url, "gpt-5.5");
    expect(s.bodies).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  test("a summary refusal AFTER the first byte is not replayed: the stream had begun", async () => {
    const s = start(() => ({
      status: 200,
      body:
        frame({ type: "response.created", response: { id: "r1", status: "in_progress" } }) +
        frame({ type: "response.output_text.delta", delta: "partial" }) +
        frame({ type: "response.failed", response: { id: "r1", status: "failed", error: { code: "unsupported_value", message: "Your organization must be verified to generate reasoning summaries." } } }),
    }));
    const events = await turn(s.url, "gpt-5.5");
    expect(s.bodies).toHaveLength(1);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});
