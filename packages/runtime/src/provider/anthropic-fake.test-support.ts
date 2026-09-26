// WS-23 test support: ONE Anthropic Messages loopback fake and ONE catalog builder for driving the
// REAL Anthropic adapter through a REAL `runEngine` (block order, overflow recovery, pause_turn,
// refusal, mid-stream overload). NOT a test file (no `.test.ts` suffix) and never exported from the
// package barrel -- the same convention as `raw-chat-fake.test-support.ts`, whose shape this mirrors.
//
// WHY THE COMPILED CATALOG'S OWN ROWS. The subject is how the adapter treats a real Claude row --
// `claude-opus-5-5`'s always-on thinking and block binding, `claude-sonnet-5`'s adaptive thinking --
// so the model rows are taken verbatim from `loadCatalog()`. Only the PROVIDER row is the fixture's:
// same id (`anthropic`, so every provider-id gate behaves as in production) with its generated
// endpoint pointed at this server and `local` discovery declaring the loopback target.
//
// Hermetic by construction: 127.0.0.1:0, closed by the caller in `finally`, never a real key (the
// fixture credential is an inline `fixture` string), and a credential header is recorded by its
// SCHEME only.
import { serve } from "bun";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

export interface AnthropicFakeRequest {
  path: string;
  headers: Record<string, string>;
  /** The parsed JSON body. */
  body: Record<string, unknown>;
}

/** One scripted content block, streamed the way the real endpoint streams it. */
export type FakeBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** One scripted response: a stream, an HTTP error, or a stream cut by a mid-stream `error` frame. */
export type FakeResponse =
  | { blocks: FakeBlock[]; stopReason: string; stopDetails?: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } }
  | { status: number; error: { type: string; message: string } }
  /** `afterBlocks` blocks stream COMPLETELY (start + delta + stop), then the error frame ends the stream. `0` = before any content. */
  | { streamError: { type: string; message: string }; afterBlocks?: FakeBlock[] };

export interface AnthropicFake {
  url: string;
  requests: AnthropicFakeRequest[];
  close(): Promise<void>;
}

const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"]);

function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function blockFrames(block: FakeBlock, index: number): string {
  let out = "";
  if (block.type === "thinking") {
    out += sseFrame("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
    out += sseFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
    out += sseFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
  } else if (block.type === "text") {
    out += sseFrame("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    out += sseFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
  } else {
    out += sseFrame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    out += sseFrame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
  }
  out += sseFrame("content_block_stop", { type: "content_block_stop", index });
  return out;
}

const MESSAGE_START = (model: string): string =>
  sseFrame("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 10, output_tokens: 1 } } });

export async function startAnthropicFake(script: (request: AnthropicFakeRequest, index: number) => FakeResponse): Promise<AnthropicFake> {
  const requests: AnthropicFakeRequest[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        headers[lower] = CREDENTIAL_HEADERS.has(lower) ? (value.includes(" ") ? `${value.slice(0, value.indexOf(" "))} ***` : "***") : value;
      });
      const raw = req.method === "GET" ? "" : await req.text();
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const request = { path: url.pathname, headers, body };
      requests.push(request);
      const answer = script(request, requests.length - 1);
      const model = typeof body["model"] === "string" ? body["model"] : "claude";
      if ("status" in answer) {
        return new Response(JSON.stringify({ type: "error", error: answer.error }), { status: answer.status, headers: { "content-type": "application/json" } });
      }
      if ("streamError" in answer) {
        let out = MESSAGE_START(model);
        (answer.afterBlocks ?? []).forEach((block, i) => (out += blockFrames(block, i)));
        out += sseFrame("error", { type: "error", error: answer.streamError });
        return new Response(out, { headers: { "content-type": "text/event-stream" } });
      }
      let out = MESSAGE_START(model);
      answer.blocks.forEach((block, i) => (out += blockFrames(block, i)));
      out += sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: answer.stopReason, stop_sequence: null, ...(answer.stopDetails !== undefined ? { stop_details: answer.stopDetails } : {}) },
        usage: answer.usage ?? { output_tokens: 5 },
      });
      out += sseFrame("message_stop", { type: "message_stop" });
      return new Response(out, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    async close() {
      await server.stop(true);
    },
  };
}

/** The fixture `anthropic` provider row: production's id and adapter, this fake's endpoint. */
export function fakeAnthropicProvider(api: string): WinterProviderDescriptor {
  return {
    id: "anthropic",
    displayName: "Anthropic (fixture)",
    protocols: ["anthropic-messages"],
    authKinds: ["api-key"],
    defaultEndpoints: { api },
    modelDiscovery: "local",
    liveCatalogAuthority: "partial",
    adapterId: "winter.anthropic-messages",
    family: "anthropic",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture:anthropic-fake", tier: "local" },
  };
}

/** A catalog of the fixture provider plus the named REAL `anthropic/*` rows, verbatim from the compiled catalog. */
export function fakeAnthropicCatalog(api: string, keys: string[]): WinterCatalog {
  const compiled = loadCatalog();
  const models: WinterModelDescriptor[] = keys.map((key) => {
    const row = compiled.models.find((m) => m.key === key);
    if (row === undefined) throw new Error(`fixture: no compiled catalog row ${key}`);
    return row;
  });
  return { ...compiled, providers: [fakeAnthropicProvider(api)], models, families: [] };
}
