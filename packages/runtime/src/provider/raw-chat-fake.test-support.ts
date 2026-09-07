// P6 fix wave test support: ONE raw chat-completions loopback fake and ONE small catalog builder,
// shared by the fix-wave fixtures (`switch-seam.test.ts`, `engine-seam-p6.test.ts`'s catalog-resolved
// variant) so the two cannot drift. NOT a test file (no `.test.ts` suffix) and never exported from the
// package barrel: it exists so a fixture can drive a REAL catalog-resolved adapter against a server it
// owns and read the ground truth off that server's request log.
//
// Hermetic by construction: 127.0.0.1:0, closed by the caller in `finally`, holds no credential and
// records the `authorization` header only so a fixture can assert WHICH key arrived.
import { serve } from "bun";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";

export interface RawChatRequest {
  path: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: string;
  /** The `model` field of the JSON body, when the body carried one. */
  model: string | undefined;
}

export interface RawChatFake {
  url: string;
  requests: RawChatRequest[];
  close(): Promise<void>;
}

export interface RawChatFakeOptions {
  /**
   * Answer every request whose wire `model` equals `wireModel` with this status (and the given
   * `Retry-After`), so a fixture can fail ONE model and serve another on the same server.
   */
  failModel?: { wireModel: string; status: number; retryAfter?: string };
  /** The text the scripted turn answers with. */
  text?: string;
  /** Hold every response this long, so a fixture can act while a turn is genuinely IN FLIGHT (a mid-turn `set_model`, an interrupt). */
  delayMs?: number;
  /**
   * A per-request script: answer with text, or with ONE tool call (fragmented over two chunks, as
   * every real chat-completions stream fragments arguments). Absent -> `text` for every request.
   */
  script?: (request: RawChatRequest) => { text: string } | { toolCall: { id: string; name: string; arguments: string } };
}

export function evidence<T>(value: T): { value: T; source: "official-doc"; observedAt: string; confidence: "verified" } {
  return { value, source: "official-doc", observedAt: "2026-09-06", confidence: "verified" };
}

export async function startRawChatFake(options: RawChatFakeOptions = {}): Promise<RawChatFake> {
  const requests: RawChatRequest[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const body = req.method === "GET" ? "" : await req.text();
      const model = /"model":"([^"]+)"/.exec(body)?.[1];
      requests.push({ path: url.pathname, authorization: req.headers.get("authorization"), headers, body, model });
      if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failModel !== undefined && model === options.failModel.wireModel) {
        return new Response(JSON.stringify({ error: { message: "raw chat fake: scripted failure", type: "server_error" } }), {
          status: options.failModel.status,
          headers: { "content-type": "application/json", ...(options.failModel.retryAfter !== undefined ? { "retry-after": options.failModel.retryAfter } : {}) },
        });
      }
      const chunk = (delta: Record<string, unknown>, finish?: string): string =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: model ?? "x", choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }] })}\n\n`;
      const usage = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: model ?? "x", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`;
      const answer = options.script?.(requests[requests.length - 1]!) ?? { text: options.text ?? "hi" };
      if ("toolCall" in answer) {
        const { id, name, arguments: args } = answer.toolCall;
        return new Response(
          chunk({ role: "assistant", content: "" }) +
            chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }) +
            chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }) +
            chunk({}, "tool_calls") +
            usage,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(chunk({ role: "assistant", content: "" }) + chunk({ content: answer.text }) + chunk({}, "stop") + usage, {
        headers: { "content-type": "text/event-stream" },
      });
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

/** A provider on the shared chat-completions adapter whose GENERATED endpoint is the given fake. `local` discovery declares the loopback target. */
export function chatProvider(id: string, api: string): WinterProviderDescriptor {
  return {
    id,
    displayName: id,
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    defaultEndpoints: { api },
    modelDiscovery: "local",
    liveCatalogAuthority: "partial",
    adapterId: "winter.openai-chat-completions",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    // WS-13b §1: both fields are REQUIRED on every provider row, so a fixture states its
    // own basis rather than inheriting one — a row-shape change fails HERE, at the fixture.
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture:raw-chat-fake", tier: "local" },
  };
}

export interface ChatModelInit {
  key: string;
  providerId: string;
  upstreamId: string;
  /** `undefined` = a model with no reasoning transport (no continuation domain); a list = an opaque-state model DECLARING these domain members. */
  domain?: string[];
  aliases?: string[];
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number };
  contextWindow?: number;
}

// WS-13c: `modelFamily`/`canonicalModelId` are DERIVED, never hand-typed into a fixture. The
// pipeline's own `stampFamilyFields` fills them here with NO families, so a fixture row lands in
// `other` carrying the real normaliser's canonical id rather than a second, drifting spelling.
const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

export function chatModel(init: ChatModelInit): WinterModelDescriptor {
  return stampRow({
    key: init.key,
    providerId: init.providerId,
    upstreamId: init.upstreamId,
    displayName: init.key,
    description: init.key,
    aliases: init.aliases ?? [],
    endpoints: ["chat"],
    ...(init.contextWindow !== undefined ? { contextWindow: evidence(init.contextWindow) } : {}),
    inputModalities: evidence(["text"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native"),
    nativeTools: evidence(true),
    ...(init.domain !== undefined
      ? { reasoning: { supported: evidence(true), efforts: [], continuation: "opaque-provider-state", continuationDomain: { value: init.domain, source: "official-doc", observedAt: "2026-09-06", confidence: "declared" } } }
      : {}),
    ...(init.pricing !== undefined ? { pricing: evidence(init.pricing) } : {}),
    unsupportedParameters: [],
    status: "supported",
  } as Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">);
}

export function chatCatalog(providers: WinterProviderDescriptor[], models: WinterModelDescriptor[]): WinterCatalog {
  return {
    schemaVersion: 2,
    families: [],
    catalogVersion: "0.0.0-fixe-fixture",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers,
    models,
  };
}
