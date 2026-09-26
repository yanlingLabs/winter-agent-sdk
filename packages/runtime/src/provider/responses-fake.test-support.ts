// WS-23 (midconv) test support: ONE OpenAI Responses loopback fake for driving the REAL Responses
// adapter (and the codex-oauth one) through a REAL `runEngine` -- `configuration_update` placement,
// the client `tool_search` round trip, `allowed_tools`, and the multi-request prefix-identity tests.
// NOT a test file (no `.test.ts` suffix) and never exported from the package barrel -- the same
// convention as `anthropic-fake.test-support.ts`, whose shape this mirrors.
//
// Hermetic by construction: 127.0.0.1:0, closed by the caller in `finally`, never a real key (the
// fixture credential is an inline `fixture` string), and a credential header is recorded by its SCHEME
// only.
import { serve } from "bun";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

export interface ResponsesFakeRequest {
  path: string;
  headers: Record<string, string>;
  /** The parsed JSON body. */
  body: Record<string, unknown>;
  /** The raw body, byte for byte -- what the prefix-identity assertions compare. */
  raw: string;
}

/** One scripted output item, streamed the way the real endpoint streams it. */
export type ResponsesFakeItem =
  | { type: "text"; text: string }
  | { type: "function_call"; callId: string; name: string; arguments: Record<string, unknown>; namespace?: string }
  | { type: "tool_search_call"; callId: string; arguments: Record<string, unknown> };

export type ResponsesFakeAnswer =
  | { items: ResponsesFakeItem[]; usage?: { input_tokens: number; output_tokens: number; cached_tokens?: number } }
  | { status: number; error: { message: string; type?: string; code?: string | null; param?: string | null } };

export interface ResponsesFake {
  url: string;
  requests: ResponsesFakeRequest[];
  close(): Promise<void>;
}

const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "chatgpt-account-id"]);

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function itemFrames(item: ResponsesFakeItem, index: number): string {
  if (item.type === "text") {
    const id = `msg_${index}`;
    return (
      frame({ type: "response.output_item.added", output_index: index, item: { id, type: "message", role: "assistant", content: [] } }) +
      frame({ type: "response.output_text.delta", item_id: id, output_index: index, content_index: 0, delta: item.text }) +
      frame({ type: "response.output_item.done", output_index: index, item: { id, type: "message", role: "assistant", content: [{ type: "output_text", text: item.text }] } })
    );
  }
  if (item.type === "function_call") {
    const id = `fc_${index}`;
    const wire = { id, type: "function_call", call_id: item.callId, name: item.name, ...(item.namespace !== undefined ? { namespace: item.namespace } : {}) };
    return (
      frame({ type: "response.output_item.added", output_index: index, item: { ...wire, arguments: "" } }) +
      frame({ type: "response.output_item.done", output_index: index, item: { ...wire, arguments: JSON.stringify(item.arguments) } })
    );
  }
  // codex-rs's own round-trip fixture: `arguments` is an OBJECT on this item, not a JSON string.
  const id = `tsc_${index}`;
  return (
    frame({ type: "response.output_item.added", output_index: index, item: { id, type: "tool_search_call", call_id: item.callId, execution: "client", status: "in_progress", arguments: {} } }) +
    frame({ type: "response.output_item.done", output_index: index, item: { id, type: "tool_search_call", call_id: item.callId, execution: "client", status: "completed", arguments: item.arguments } })
  );
}

export async function startResponsesFake(script: (request: ResponsesFakeRequest, index: number) => ResponsesFakeAnswer): Promise<ResponsesFake> {
  const requests: ResponsesFakeRequest[] = [];
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
      const request = { path: url.pathname, headers, body, raw };
      requests.push(request);
      const answer = script(request, requests.length - 1);
      if ("status" in answer) {
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: null, param: null, ...answer.error } }), { status: answer.status, headers: { "content-type": "application/json" } });
      }
      const model = typeof body["model"] === "string" ? body["model"] : "gpt";
      let out = frame({ type: "response.created", response: { id: `resp_${requests.length}`, model, output: [] } });
      answer.items.forEach((item, i) => (out += itemFrames(item, i)));
      const usage = answer.usage ?? { input_tokens: 10, output_tokens: 2 };
      out += frame({
        type: "response.completed",
        response: { id: `resp_${requests.length}`, model, status: "completed", usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, input_tokens_details: { cached_tokens: usage.cached_tokens ?? 0 } }, output: [] },
      });
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

/** The fixture provider row for `providerId` (`openai` or `codex-oauth`): production's id and adapter, this fake's endpoint. */
export function fakeResponsesProvider(providerId: "openai" | "codex-oauth", api: string): WinterProviderDescriptor {
  const compiled = loadCatalog().providers.find((p) => p.id === providerId);
  if (compiled === undefined) throw new Error(`fixture: no compiled provider ${providerId}`);
  return { ...compiled, defaultEndpoints: { ...compiled.defaultEndpoints, api }, modelDiscovery: "local" };
}

/** A catalog of the fixture provider plus the named REAL rows, verbatim from the compiled catalog (optionally patched). */
export function fakeResponsesCatalog(providerId: "openai" | "codex-oauth", api: string, keys: string[], patch: (row: WinterModelDescriptor) => WinterModelDescriptor = (r) => r): WinterCatalog {
  const compiled = loadCatalog();
  const models: WinterModelDescriptor[] = keys.map((key) => {
    const row = compiled.models.find((m) => m.key === key);
    if (row === undefined) throw new Error(`fixture: no compiled catalog row ${key}`);
    return patch(row);
  });
  return { ...compiled, providers: [fakeResponsesProvider(providerId, api)], models, families: [] };
}
