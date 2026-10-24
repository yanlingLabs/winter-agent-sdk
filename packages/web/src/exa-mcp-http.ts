// THE BUILT-IN EXA TRANSPORT -- the three requests a search needs of an MCP server over Streamable
// HTTP (`initialize`, `notifications/initialized`, `tools/call`), on the platform `fetch`, so the
// package needs no MCP SDK. A response may be plain JSON or an SSE stream; the stream is read only
// until the matching JSON-RPC response arrives, and both forms are size-capped.
//
// Headers: the caller's (the key tier's `x-api-key`), `Mcp-Session-Id` once the server assigns one,
// and `MCP-Protocol-Version` after `initialize`. Nothing is ever added to the URL. With
// `refuseRedirects` (the key tier) a redirect fails the request (`redirect: "error"`), so the key is
// never replayed to another origin. Every error is an `ExaTransportError` whose message holds at most
// the server's own (capped) body text -- never a URL, a header or a stack.
import type { ExaConnectRequest, ExaConnection, ExaErrorClass, ExaToolCallResult, ExaTransport } from "./exa.ts";
import { classifyExaErrorText, EXA_UNREACHABLE_PATTERN } from "./exa-classify.ts";

export const EXA_MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;
const CLOSE_TIMEOUT_MS = 2_000;

export type ExaTransportErrorKind = "http" | "timeout" | "network" | "rpc" | "protocol";

export class ExaTransportError extends Error {
  override name = "ExaTransportError";
  readonly kind: ExaTransportErrorKind;
  /** `connect` while the session is being set up, `call` afterwards. */
  readonly phase: "connect" | "call";
  readonly status: number | undefined;
  readonly rpcCode: number | undefined;
  constructor(kind: ExaTransportErrorKind, phase: "connect" | "call", message: string, extra: { status?: number; rpcCode?: number } = {}) {
    super(message);
    this.kind = kind;
    this.phase = phase;
    this.status = extra.status;
    this.rpcCode = extra.rpcCode;
  }
}

/** The slice of `fetch` the transport uses. */
export type ExaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ExaMcpHttpTransportOptions {
  /** Default: the global `fetch`. */
  fetch?: ExaFetch;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const TIMEOUT = Symbol("timeout");

function label(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  const name = err instanceof Error ? err.name : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : "Error";
}

async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ text: string; over: boolean }> {
  if (body === null) return { text: "", over: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > max) {
        chunks.push(value.subarray(0, max - total));
        total = max;
        over = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (over) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(all), over };
}

function matching(parsed: unknown, id: number): JsonRpcMessage | undefined {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of list) if (typeof m === "object" && m !== null && (m as JsonRpcMessage).id === id) return m as JsonRpcMessage;
  return undefined;
}

/** Reads SSE events until the response with `id` arrives; then stops reading. */
async function readSse(body: ReadableStream<Uint8Array> | null, id: number, phase: "connect" | "call"): Promise<JsonRpcMessage> {
  if (body === null) throw new ExaTransportError("protocol", phase, "the server sent an empty event stream");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ExaTransportError("protocol", phase, "the server's response exceeded the size limit");
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data.length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const found = matching(parsed, id);
        if (found !== undefined) return found;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new ExaTransportError("protocol", phase, "the server's event stream ended without a response");
}

class McpHttpConnection implements ExaConnection {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 1;
  private closed = false;
  private readonly inflight = new Set<AbortController>();

  private readonly request: ExaConnectRequest;
  private readonly fetchImpl: ExaFetch;
  private readonly clientInfo: { name: string; version: string };

  constructor(request: ExaConnectRequest, fetchImpl: ExaFetch, clientInfo: { name: string; version: string }) {
    this.request = request;
    this.fetchImpl = fetchImpl;
    this.clientInfo = clientInfo;
  }

  private headers(): Record<string, string> {
    return {
      ...this.request.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId !== undefined ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion !== undefined ? { "mcp-protocol-version": this.protocolVersion } : {}),
    };
  }

  private async post(message: Record<string, unknown>, phase: "connect" | "call", timeoutMs: number): Promise<JsonRpcMessage | undefined> {
    if (this.closed) throw new ExaTransportError("network", phase, "the connection was closed");
    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
    const id = typeof message["id"] === "number" ? (message["id"] as number) : undefined;
    try {
      const res = await this.fetchImpl(this.request.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
        redirect: this.request.refuseRedirects ? "error" : "follow",
        signal: controller.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid !== null && sid.length > 0 && sid.length <= 256 && /^[\x21-\x7e]+$/.test(sid)) this.sessionId = sid;
      if (!res.ok) {
        const { text } = await readCapped(res.body, MAX_ERROR_BODY_BYTES).catch(() => ({ text: "" }));
        throw new ExaTransportError("http", phase, `HTTP ${res.status}${text.trim().length > 0 ? `: ${text.trim()}` : ""}`, { status: res.status });
      }
      if (id === undefined) {
        await res.body?.cancel().catch(() => {});
        return undefined;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.includes("text/event-stream")) return await readSse(res.body, id, phase);
      const { text, over } = await readCapped(res.body, MAX_RESPONSE_BYTES);
      if (over) throw new ExaTransportError("protocol", phase, "the server's response exceeded the size limit");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ExaTransportError("protocol", phase, "the server's response was not JSON");
      }
      const found = matching(parsed, id);
      if (found === undefined) throw new ExaTransportError("protocol", phase, "the server's response did not answer the request");
      return found;
    } catch (err) {
      if (controller.signal.reason === TIMEOUT) throw new ExaTransportError("timeout", phase, "the request timed out");
      if (err instanceof ExaTransportError) throw err;
      if (this.closed) throw new ExaTransportError("network", phase, "the connection was closed");
      throw new ExaTransportError("network", phase, `network error (${label(err)})`);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  private rpcError(message: JsonRpcMessage, phase: "connect" | "call"): ExaTransportError {
    const text = typeof message.error?.message === "string" ? message.error.message.slice(0, 1000) : "error";
    const code = typeof message.error?.code === "number" ? message.error.code : undefined;
    return new ExaTransportError("rpc", phase, text, code !== undefined ? { rpcCode: code } : {});
  }

  async initialize(): Promise<void> {
    const id = this.nextId++;
    const answer = await this.post(
      { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: EXA_MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo } },
      "connect",
      this.request.connectTimeoutMs,
    );
    if (answer === undefined) throw new ExaTransportError("protocol", "connect", "the server did not answer initialize");
    if (answer.error !== undefined) throw this.rpcError(answer, "connect");
    const version = (answer.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    this.protocolVersion = typeof version === "string" && /^[\x21-\x7e]{1,64}$/.test(version) ? version : EXA_MCP_PROTOCOL_VERSION;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, "connect", this.request.connectTimeoutMs);
  }

  async callTool(name: string, args: Record<string, unknown>, options: { timeoutMs: number }): Promise<ExaToolCallResult> {
    const id = this.nextId++;
    const answer = await this.post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, "call", options.timeoutMs);
    if (answer === undefined) throw new ExaTransportError("protocol", "call", "the server did not answer the call");
    if (answer.error !== undefined) throw this.rpcError(answer, "call");
    const result = (answer.result ?? {}) as { content?: unknown; isError?: unknown };
    return { content: Array.isArray(result.content) ? result.content : [], isError: result.isError === true };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.inflight) c.abort();
    this.inflight.clear();
    if (this.sessionId === undefined) return;
    try {
      const res = await this.fetchImpl(this.request.url, {
        method: "DELETE",
        headers: { ...this.request.headers, "mcp-session-id": this.sessionId, ...(this.protocolVersion !== undefined ? { "mcp-protocol-version": this.protocolVersion } : {}) },
        redirect: this.request.refuseRedirects ? "error" : "follow",
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
    } catch {
      /* best effort: the server expires an idle session on its own */
    }
  }
}

/** How a built-in transport error reads: status first, then the words of the server's own reply. */
export function classifyExaTransportError(err: unknown): ExaErrorClass {
  if (!(err instanceof ExaTransportError)) {
    const text = err instanceof Error ? err.message : String(err);
    return { kind: classifyExaErrorText(text), unreachable: EXA_UNREACHABLE_PATTERN.test(text), transport: true };
  }
  const unreachable = err.phase === "connect" || err.kind === "network";
  if (err.status === 429 || err.status === 402) return { kind: "rate-limited", unreachable, transport: false };
  if (err.status === 401 || err.status === 403) return { kind: "auth", unreachable, transport: false };
  if (err.kind === "timeout") return { kind: "timeout", unreachable, transport: false };
  const transport = err.phase === "call" && (err.kind === "network" || (err.kind === "http" && err.status === 404));
  return { kind: classifyExaErrorText(err.message), unreachable, transport };
}

/** The built-in transport: Exa's MCP server over Streamable HTTP on `fetch`. */
export function createExaMcpHttpTransport(options: ExaMcpHttpTransportOptions = {}): ExaTransport {
  const fetchImpl: ExaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const clientInfo = { name: options.clientName ?? "winter-web", version: options.clientVersion ?? "1" };
  return {
    async connect(request: ExaConnectRequest): Promise<ExaConnection> {
      const connection = new McpHttpConnection(request, fetchImpl, clientInfo);
      try {
        await connection.initialize();
      } catch (err) {
        await connection.close();
        throw err;
      }
      return connection;
    },
    classify: classifyExaTransportError,
  };
}
