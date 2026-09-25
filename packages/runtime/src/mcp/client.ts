// Phase 4 Task 4 (Lane A), WS-09 §1/§2: the per-server MCP protocol connector. Given ONE resolved
// server config (+ dependencies), this file owns the "connect once, discover tools/resources, call
// things, close" lifecycle for a SINGLE connection -- multi-server orchestration, the three-deadline
// startup model, the seven-state model, and reconnect/toggle/setServers all live one layer up, in
// mcp/lifecycle.ts, which calls `connectMcpServer` once per server and holds the returned handle in
// its own mutable per-server slot (see that file's own header for why the INDIRECTION matters: a
// registry-installed tool executor must read through a slot, never close over a specific
// `ConnectedMcpClient` a reconnect would invalidate -- registry.ts's own "same-server replace
// preserves executor" consequence, seam-contracts-p4.test.ts's own header).
//
// Three-timeout discipline (do not conflate these -- a real bug class this file's own review
// caught before landing): (1) THIS file's `connectTimeoutMs` bounds the CONNECTION ATTEMPT only
// (WS-09 §2's `MCP_TIMEOUT`, 30000ms default, or a caller's own tighter bound for a live
// reconnect); (2) a TOOL CALL's own timeout (`callTool`/`readResource`'s `opts.timeoutMs`) is a
// SEPARATE input this file never invents a default for -- WS-09 §1.1's per-server `timeout`
// overriding `MCP_TOOL_TIMEOUT` is resolved by the CALLER (mcp/lifecycle.ts), never here, because
// this file has no access to the env config at all; (3) the batch-snapshot startup deadline
// (`MCP_CONNECT_TIMEOUT_MS`, 5000ms) is a multi-server concept this single-connection file has no
// concept of whatsoever.
//
// Outer-race requirement (empirically load-bearing, not defensive theater): verified before writing
// this file that `client.connect(transport, {timeout})` does NOT bound every failure mode for every
// transport -- an SSE client's inner timeout never fires against a server that accepts the TCP
// connection but never answers the initial GET at all (a different code path than the JSON-RPC
// request/response cycle `RequestOptions.timeout` covers; transports/sse.test.ts's own test documents
// this with a raw SDK reproduction). `raceConnect` below wraps EVERY transport in this file's own
// outer timer, unconditionally, rather than trusting any one transport's internal timeout handling.
//
// WS-23 (MCP TS SDK v2): everything below comes from the ONE public client package,
// `@modelcontextprotocol/client` 2.1.0 -- `Client`, the error classes, `Transport` and the in-memory
// pair are all re-exported from its root, so no subpath (and no direct `@modelcontextprotocol/core`
// import) is needed. The v1 -> v2 renames this file absorbs: `McpError`/`ErrorCode` became
// `ProtocolError`/`ProtocolErrorCode` for errors that CROSS THE WIRE, and every error the SDK raises
// LOCALLY (a request timeout, a closed connection, a failed era negotiation, a non-OK HTTP answer) is
// now an `SdkError` whose `code` is a STRING `SdkErrorCode` -- the HTTP status moved off `.code` onto
// `SdkHttpError.status`. `classifyConnectError` below is where that move is absorbed.
import { Client, ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode, SdkHttpError, SseError, UnauthorizedError, type Transport, type VersionNegotiationMode } from "@modelcontextprotocol/client";
import type { McpServerConfigForProcessTransport, McpVersionNegotiation } from "@yanlinglabs/winter-agent-sdk";
import { buildStdioTransport, WinterStdioTransport } from "./transports/stdio.ts";
import { buildHttpTransport } from "./transports/http.ts";
import { buildSseTransport } from "./transports/sse.ts";
import { buildSdkTransport, type InProcessMcpServer } from "./transports/sdk.ts";
import { installElicitationHandler, type ElicitationAsker } from "./elicitation.ts";

// --- Public shapes ---------------------------------------------------------------------------

export type McpConnectErrorCode = "timeout" | "spawn_failed" | "handshake_failed" | "needs_auth" | "unknown";

export class McpConnectError extends Error {
  readonly code: McpConnectErrorCode;
  /**
   * The HTTP status an http/sse transport failed the handshake with, when there was one.
   *
   * Carried because the classification below is LOSSY on purpose (the state model needs only
   * failed-vs-needsAuth) and the transport's message holds the response BODY, not the status -- so a
   * direct caller that must tell a 429 from a 500 (the web search backend's anonymous tier answers a
   * rate limit at `initialize`) had nothing to read. `declare` + conditional assignment so an error
   * with no status has no own `httpStatus` key at all.
   */
  declare readonly httpStatus?: number;
  constructor(code: McpConnectErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = "McpConnectError";
    this.code = code;
    if (httpStatus !== undefined) Object.assign(this, { httpStatus });
  }
}

// A real MCP `ToolAnnotations` mirror (registry.ts's own identical 5-field shape, WS-09 §4 "preserved
// end-to-end") -- redeclared rather than imported to avoid a runtime package importing a TYPE from a
// different runtime module purely for a structural shape both already independently pin the same way.
export interface McpToolAnnotationsInfo {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
  idempotentHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotationsInfo;
  _meta?: Record<string, unknown>;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

// Deliberately NOT the "path marker" shape WS-09 §1.4 pins for ReadMcpResourceTool's own result
// (`blobSavedTo`) -- persisting a blob to `ctx.tempDir` is a WINTER TOOL concern (ToolExecutionContext
// carries `tempDir`; this protocol-layer file does not and should not know about it), so this file
// hands back the raw base64 `blob` the wire actually carries and lets the bridge tool
// (tools/impl/read-mcp-resource-tool.ts) decide what to do with it. `error` is populated only by a
// caller-side wrapper (mcp/lifecycle.ts) that catches a per-resource failure; this file's own
// `readResource` throws on failure like every other method here, it never fabricates this field.
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blobBase64?: string;
}

export interface McpToolCallResult {
  content: unknown[];
  isError?: boolean;
}

export interface ConnectedMcpClient {
  readonly serverName: string;
  /**
   * The protocol revision this connection settled on: `2025-11-25` (or an older 2025-era revision a
   * server counter-offered) on the legacy `initialize` handshake, `2026-07-28` when an `auto`/pinned
   * `server/discover` probe selected the modern era. Read ONCE at connect -- a connection's era never
   * changes after it is established (the v2 client resets it only on a fresh connect). Optional on
   * the type so a hand-built fake (test-fixtures.ts's `createFakeConnectedMcpClient`) need not invent
   * one.
   */
  readonly protocolVersion?: string;
  listTools(): Promise<McpToolInfo[]>;
  listResources(): Promise<McpResourceInfo[]>;
  readResource(uri: string, opts?: { timeoutMs?: number }): Promise<McpResourceContent[]>;
  callTool(toolName: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface ConnectMcpServerOptions {
  name: string;
  config: McpServerConfigForProcessTransport;
  // MCP_TIMEOUT (or a caller's own tighter bound for a live reconnect) -- see this file's own header
  // on why this is NEVER the tool-call timeout and NEVER the batch-snapshot deadline.
  connectTimeoutMs: number;
  elicitationAsk: ElicitationAsker;
  // Required (and ONLY consulted) when `config.type === "sdk"` and the caller wants an ACTUAL
  // connection through this file (this lane's own fixtures; a future direct-instance producer) --
  // see transports/sdk.ts's own header for why a host-supplied `Options.mcpServers` entry of this
  // type never reaches this parameter at all (T3's sdk_mcp_call bridge owns that path completely).
  inProcessServer?: InProcessMcpServer;
  /** `type: "http"` only: fail rather than follow a redirect -- see `buildHttpTransport`. For a direct caller whose headers carry a credential. */
  refuseHttpRedirects?: boolean;
  /**
   * Called when the connected server says its TOOL list changed (`notifications/tools/list_changed`
   * on a legacy connection; the same notification over the auto-opened `subscriptions/listen` stream
   * on a 2026-07-28 one). A SIGNAL, never a list: the v2 client is configured with
   * `autoRefresh: false`, so this file never fetches or hands over a tool list of its own -- the
   * caller (mcp/lifecycle.ts) re-queries through `listTools()` on its own staleness-guarded refresh
   * path, which stays the ONE place a server's tools are (re-)registered. Only wired when the server
   * advertises `tools.listChanged` (the v2 client skips the handler otherwise).
   *
   * No prompts/resources counterpart, deliberately: the runtime keeps no view of either to refresh.
   * `listResources()`/`readResource()` below are live requests on every call (the bridge tools read
   * through them), and Winter does not surface MCP prompts at all -- a handler for those two
   * notifications would have nothing to update.
   */
  onToolListChanged?: () => void;
}

// --- Protocol-version negotiation (WS-23; protocol revision 2026-07-28) ----------------------------
//
// The v2 client can probe `server/discover` before `initialize` and select the modern 2026-07-28
// era when the server offers it. Its own default is `'legacy'` (byte-identical to a v1 client); the
// per-server `versionNegotiation` config field overrides the per-TRANSPORT default below.
//
// WHY THE DEFAULT DIFFERS BY TRANSPORT (a deliberate divergence from the SDK's one global default):
//   - `http` (Streamable HTTP) defaults to `'auto'`. Every probe is its own POST, a legacy server
//     answers it with a JSON-RPC or HTTP error the client reads as a definitive legacy signal, and
//     the plain `initialize` handshake follows -- measured against this lane's own legacy fixtures
//     (they settle on 2025-11-25) and a v2 `createMcpHandler` endpoint (it settles on 2026-07-28).
//     The one cost, by the v2 client's design: a server that answers the probe with an HTTP 5xx (or
//     never answers it) fails the connect as `handshake_failed`/`timeout` -- the client refuses to
//     read an outage as an era verdict. Such a server needs `versionNegotiation: "legacy"`.
//   - `stdio` defaults to `'legacy'`. `WinterStdioTransport` is a CUSTOM stdio-shaped transport, and
//     the v2 client probes a custom transport IN PLACE, on the one live pipe -- the sibling-process
//     probe it runs for its own `StdioClientTransport` is not available to it. A legacy server built
//     on an SDK that exits on any unknown pre-`initialize` request would therefore die on the probe
//     and never connect. A user who knows their server can opt in per server.
//   - `sse` defaults to `'legacy'`. It is the 2024-11-05 transport; no 2026-07-28 server is reached
//     over it, and on a non-stdio transport a probe TIMEOUT rejects the connect outright (the v2
//     client reads silence on a network transport as an outage, not a legacy signal), so `'auto'`
//     could only ever cost a legacy SSE server its connection.
//   - `sdk` (in-process) is always `'legacy'`: an in-process `Server.connect()` serves the legacy
//     era only (the modern era needs the v2 SDK's own per-connection serving entries).
export function resolveVersionNegotiation(config: McpServerConfigForProcessTransport): McpVersionNegotiation {
  if (config.type === "sdk") return "legacy";
  if (config.versionNegotiation !== undefined) return config.versionNegotiation;
  return config.type === "http" ? "auto" : "legacy";
}

function toSdkNegotiationMode(mode: McpVersionNegotiation): VersionNegotiationMode {
  return typeof mode === "string" ? mode : { pin: mode.pin };
}

// --- Error classification (WS-09 §2.1's failed/needsAuth split, plus a small diagnostic taxonomy
// beyond what the state model itself distinguishes) --------------------------------------------

function classifyConnectError(err: unknown): McpConnectError {
  if (err instanceof McpConnectError) return err;
  if (err instanceof UnauthorizedError) return new McpConnectError("needs_auth", err.message);
  // v2 moved every locally-raised failure onto `SdkError` with a STRING code; the v1 check this
  // replaces (`McpError` + `ErrorCode.RequestTimeout`) can no longer match anything.
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return new McpConnectError("timeout", err.message);
  // A bare 401 with NO authProvider configured (this connector never configures one) does NOT
  // throw `UnauthorizedError` -- that class is reserved for the case an authProvider EXISTS but
  // authorization still fails. An unauthenticated 401 surfaces as an ordinary HTTP error carrying
  // the status: on Streamable HTTP an `SdkHttpError` (v2; `.status`, with `.code` the string
  // `CLIENT_HTTP_AUTHENTICATION` -- whether the 401 answered the `'auto'` probe or `initialize`
  // itself), on legacy SSE an `SseError` whose numeric `.code` is still the status. Checked here so a
  // server that requires auth Winter has no credentials for lands in WS-09 §2.1's `needsAuth` state,
  // not a generic "failed". Read off the STATUS, never the v2 string code: the status is the
  // contract both transports share, and it is what `httpStatus` reports to a direct caller.
  const httpStatus = err instanceof SdkHttpError ? err.status : err instanceof SseError && typeof err.code === "number" ? err.code : undefined;
  if (err instanceof SdkHttpError || err instanceof SseError) {
    return new McpConnectError(httpStatus === 401 ? "needs_auth" : "handshake_failed", err.message, httpStatus);
  }
  // WS-23: a failed era negotiation (a `{pin}` the server does not offer, a probe answered 5xx, a
  // network failure mid-probe) never becomes an era verdict -- the v2 client refuses the connect
  // with this code. When it wraps an underlying failure (`cause`: a refused connection, a DNS
  // failure) that failure is what is classified, so the code matches what the same failure gets on
  // the legacy handshake (and got on v1); only a failure OF the negotiation itself (no cause: the
  // pin was not offered) is a handshake failure.
  if (err instanceof SdkError && err.code === SdkErrorCode.EraNegotiationFailed) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== err) return classifyConnectError(cause);
    return new McpConnectError("handshake_failed", err.message);
  }
  // A JSON-RPC error ANSWERING the handshake (e.g. an `initialize` the server refused) -- v1 left
  // this to the generic "unknown" below; it is a handshake failure by definition.
  if (err instanceof ProtocolError) return new McpConnectError("handshake_failed", err.message);
  const message = err instanceof Error ? err.message : String(err);
  // Node's own child_process spawn failure shape (verified empirically: `ENOENT: no such file or
  // directory, posix_spawn '<command>'`, `err.code === "ENOENT"`) -- checked by CODE, not a message
  // substring match, since the message text is not a contract.
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "EACCES") return new McpConnectError("spawn_failed", message);
  return new McpConnectError("unknown", message);
}

// --- The outer race (see this file's own header for why it is unconditional, not defensive
// theater) ---------------------------------------------------------------------------------------

function raceConnect(client: Client, transport: Transport, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpConnectError("timeout", `mcp client: connection attempt exceeded ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([client.connect(transport, { timeout: timeoutMs }), outer]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

// --- Tool list hygiene (this lane's own brief: "NEVER duplicate names within one batch --
// registerMcpServerTools silently last-write-wins today, a known fix-wave gap: dedupe/validate
// before calling") -- deduping HERE, at the protocol layer, means every consumer of `listTools()`
// (mcp/lifecycle.ts's own registration call, any future direct caller) inherits a clean list by
// construction, rather than each caller needing its own copy of this logic. First occurrence wins;
// a real server returning two tools under the identical name is a server-side anomaly worth a
// console warning, not a crash.
function dedupeTools(tools: McpToolInfo[]): McpToolInfo[] {
  const seen = new Set<string>();
  const out: McpToolInfo[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      console.error(`winter: mcp client: server reported duplicate tool name "${tool.name}" in one tools/list response -- keeping the first occurrence, dropping the rest`);
      continue;
    }
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

// --- `'auto'`: the probe's own budget, and the legacy retry (WS-23 fix round 1, ruling I1) --------
//
// The v2 client's `'auto'` falls back to `initialize` only on answers it reads as definitive legacy
// evidence (404/405/400, a -32601 in a 200). Measured against hand-written and proxied legacy servers
// that are correct on `initialize`, several other answers to the unknown `server/discover` probe made
// it REFUSE the connect instead: 500/502/503 (even a 500 whose body is a valid -32601), an empty 202,
// a 200 `text/html`, a probe that hangs, a silent SSE stream -- every one a server v1 connected to.
// So Winter adds the fallback the SDK leaves out: when an `'auto'` attempt fails for any reason other
// than an auth wall (401/403 -- a legacy handshake would hit the same wall, and must not be spent
// twice) or a spawn failure (no server to talk to), it is retried ONCE with `'legacy'`, on a FRESH
// transport (the first one may be mid-probe, or its stdio child dead), inside what is left of the
// same connect budget. A `{pin}` is never retried: a pin is a demand, and "no silent fallback" is the
// point of one.
//
// The probe gets its OWN bound, min(5 s, connect budget / 3): left to inherit the whole budget, a
// probe that hangs would consume it, and the legacy retry would never get to run.
export const AUTO_PROBE_TIMEOUT_CAP_MS = 5000;

function autoProbeTimeoutMs(connectTimeoutMs: number): number {
  return Math.max(1, Math.min(AUTO_PROBE_TIMEOUT_CAP_MS, Math.floor(connectTimeoutMs / 3)));
}

function retriesAsLegacy(err: McpConnectError): boolean {
  if (err.code === "needs_auth" || err.code === "spawn_failed") return false;
  return err.httpStatus !== 401 && err.httpStatus !== 403;
}

// --- Listing without the capability (WS-23 fix round 1, ruling I2) -------------------------------
//
// v2's `listTools()`/`listResources()` return an EMPTY list, without a request, when the server did
// not advertise the `tools`/`resources` capability. v1 always sent the request, and hand-written
// servers that serve `tools/list` without declaring the capability worked -- on v2 they would connect
// with zero tools and nothing anywhere saying why. For such a server this file sends the request
// itself, through the public `client.request`, and walks the pages with the SDK's own 64-page cap
// (`ClientOptions.listMaxPages`' default) and a repeated-cursor stop. One deliberate difference from
// v1: a server that declares nothing AND answers `-32601 Method not found` simply has none -- v1
// failed the whole connection on that, which served no one.
export const MANUAL_LIST_MAX_PAGES = 64;

async function listAllPagesManually<T>(fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string | undefined }>, what: string): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MANUAL_LIST_MAX_PAGES; page++) {
    let result: { items: T[]; nextCursor?: string | undefined };
    try {
      result = await fetchPage(cursor);
    } catch (err) {
      if (page === 0 && err instanceof ProtocolError && err.code === ProtocolErrorCode.MethodNotFound) return [];
      throw err;
    }
    out.push(...result.items);
    const next = result.nextCursor;
    if (next === undefined || seen.has(next)) return out;
    seen.add(next);
    cursor = next;
  }
  throw new Error(`mcp client: ${what} did not finish within ${MANUAL_LIST_MAX_PAGES} pages (the server's pagination never converged)`);
}

// --- The connector -----------------------------------------------------------------------------

export async function connectMcpServer(opts: ConnectMcpServerOptions): Promise<ConnectedMcpClient> {
  const mode = resolveVersionNegotiation(opts.config);
  if (mode !== "auto") return connectOnce(opts, mode, opts.connectTimeoutMs);
  const started = Date.now();
  try {
    return await connectOnce(opts, "auto", opts.connectTimeoutMs, autoProbeTimeoutMs(opts.connectTimeoutMs));
  } catch (err) {
    if (!(err instanceof McpConnectError) || !retriesAsLegacy(err)) throw err;
    // Whatever is left of the ONE connect budget -- the outer race (raceConnect) is what fired when
    // nothing is left, and a retry past it would stretch MCP_TIMEOUT.
    const remaining = opts.connectTimeoutMs - (Date.now() - started);
    if (remaining <= 0) throw err;
    return connectOnce(opts, "legacy", remaining);
  }
}

async function connectOnce(opts: ConnectMcpServerOptions, mode: McpVersionNegotiation, connectTimeoutMs: number, probeTimeoutMs?: number): Promise<ConnectedMcpClient> {
  const { name, config, elicitationAsk } = opts;

  let transport: Transport;

  try {
    if (config.type === "sdk") {
      if (!opts.inProcessServer) {
        throw new McpConnectError("spawn_failed", `mcp client: server "${name}" is configured as type "sdk" but no in-process server instance was supplied to connectMcpServer`);
      }
      transport = await buildSdkTransport(opts.inProcessServer);
    } else if (config.type === "http") {
      transport = buildHttpTransport(config, opts.refuseHttpRedirects === true ? { refuseRedirects: true } : {});
    } else if (config.type === "sse") {
      transport = buildSseTransport(config);
    } else {
      // WS-09 derived-shapes item (a): `type` is the ONLY optional discriminant of the four
      // variants -- an absent `type` field is structurally a stdio config. `WinterStdioTransport`
      // (fix round 1, RULING P4-H) owns its own process lifecycle end-to-end -- including a reliable
      // process-GROUP kill on close() -- so, unlike the SDK's own `StdioClientTransport` this file
      // used to wrap, no separate pid-capture/hard-kill fallback is needed here: the generic
      // `transport!.close()` in this function's own catch block below is sufficient for every
      // transport kind, stdio included.
      transport = buildStdioTransport(config);
    }

    const onToolListChanged = opts.onToolListChanged;
    const client = new Client(
      { name: "winter", version: "0.0.1" },
      {
        // Unconditional, regardless of whether `elicitationAsk` will itself round-trip to a real host
        // callback or decline immediately -- see elicitation.ts's own header: a connected server must
        // NEVER be left without a registered handler at the protocol level (that is what guarantees
        // "never a hang" all the way down to the wire). Both modes are declared: the host surface
        // (`Options.onElicitation`) already carries `mode`/`url`/`elicitationId`, so a URL-mode request
        // is forwarded exactly like a form one (elicitation.ts's `installElicitationHandler`). Declaring
        // `form` explicitly keeps form mode on -- per the spec an EMPTY object means form-only, and a
        // non-empty one lists every mode it supports.
        capabilities: { elicitation: { form: {}, url: {} } },
        versionNegotiation: { mode: toSdkNegotiationMode(mode), ...(probeTimeoutMs !== undefined ? { probe: { timeoutMs: probeTimeoutMs } } : {}) },
        // `input_required` (2026-07-28): left at the v2 default (`autoFulfill: true`), which fulfils
        // an embedded elicitation through the SAME `elicitation/create` handler installed below and
        // retries the call -- so a modern server's multi-round-trip tool reaches the host exactly the
        // way a legacy server's server->client `elicitation/create` does. Stated here rather than
        // silently defaulted because it is a behaviour this file depends on.
        inputRequired: { autoFulfill: true },
        ...(onToolListChanged !== undefined
          ? {
              listChanged: {
                tools: {
                  // Never let the SDK fetch a list on our behalf -- see `onToolListChanged`'s own doc.
                  autoRefresh: false,
                  onChanged: () => {
                    try {
                      onToolListChanged();
                    } catch (err) {
                      console.error(`winter: mcp client: server "${name}" tool-list-changed handler threw`, err);
                    }
                  },
                },
              },
            }
          : {}),
      },
    );
    installElicitationHandler(client, name, elicitationAsk);

    await raceConnect(client, transport, connectTimeoutMs);
    const protocolVersion = client.getNegotiatedProtocolVersion();

    let closed = false;
    return {
      serverName: name,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      // A REAL, LIVE re-query every call -- NOT a snapshot frozen at connect time. This is
      // load-bearing, not merely "more correct": mcp/lifecycle.ts's own `refreshServerTools`
      // (RefreshMcpTools, WS-09 §1.4) exists specifically to observe a server's tool list changing
      // AFTER the initial connection, and a caching `listTools()` here would make that mechanism a
      // silent no-op regardless of what the connected server actually reports (found by this lane's
      // own test suite: a fixture server whose tools/list answer genuinely changed between two
      // calls kept reporting the ORIGINAL list until this was fixed).
      //
      // WS-23: v2's `Client.listTools()` is NOT live by default any more -- it fronts a response
      // cache (SEP-2549) and, under the default `cacheMode: 'use'`, serves a still-fresh entry
      // without a round trip. A legacy server never sends a TTL, so the entry is "immediately stale"
      // and today's behaviour happens to survive, but a 2026-07-28 server that answers `tools/list`
      // with `ttlMs > 0` would turn RefreshMcpTools back into exactly the silent no-op above.
      // `cacheMode: 'refresh'` always fetches (and still re-stores, which is what callTool's
      // output-schema validation reads), so the live-requery contract holds on every era.
      async listTools(): Promise<McpToolInfo[]> {
        const rawTools =
          client.getServerCapabilities()?.tools !== undefined
            ? (await client.listTools(undefined, { cacheMode: "refresh" })).tools
            : await listAllPagesManually(async (cursor) => {
                const page = await client.request({ method: "tools/list", ...(cursor !== undefined ? { params: { cursor } } : {}) });
                return { items: page.tools, nextCursor: page.nextCursor };
              }, "tools/list");
        return dedupeTools(
          rawTools.map((t) => ({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
            ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
            ...(t.annotations !== undefined ? { annotations: t.annotations as McpToolAnnotationsInfo } : {}),
            ...(t._meta !== undefined ? { _meta: t._meta as Record<string, unknown> } : {}),
          })),
        );
      },
      // Same `cacheMode: 'refresh'` reasoning as `listTools()`: the resource bridge tools promise the
      // server's CURRENT answer, and a server-sent TTL must not quietly change that.
      async listResources(): Promise<McpResourceInfo[]> {
        const resources =
          client.getServerCapabilities()?.resources !== undefined
            ? (await client.listResources(undefined, { cacheMode: "refresh" })).resources
            : await listAllPagesManually(async (cursor) => {
                const page = await client.request({ method: "resources/list", ...(cursor !== undefined ? { params: { cursor } } : {}) });
                return { items: page.resources, nextCursor: page.nextCursor };
              }, "resources/list");
        return resources.map((r) => ({
          uri: r.uri,
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.description !== undefined ? { description: r.description } : {}),
          ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
        }));
      },
      async readResource(uri: string, readOpts?: { timeoutMs?: number }): Promise<McpResourceContent[]> {
        const result = await client.readResource({ uri }, { cacheMode: "refresh", ...(readOpts?.timeoutMs !== undefined ? { timeout: readOpts.timeoutMs } : {}) });
        return result.contents.map((c) => {
          const mimeType = "mimeType" in c && c.mimeType !== undefined ? c.mimeType : undefined;
          if ("blob" in c) {
            return { uri: c.uri, ...(mimeType !== undefined ? { mimeType } : {}), blobBase64: c.blob };
          }
          return { uri: c.uri, ...(mimeType !== undefined ? { mimeType } : {}), text: "text" in c ? c.text : "" };
        });
      },
      async callTool(toolName: string, args: Record<string, unknown>, callOpts?: { timeoutMs?: number }): Promise<McpToolCallResult> {
        // v2's `callTool(params, options)` -- the v1 middle `resultSchema` argument is gone.
        const result = await client.callTool({ name: toolName, arguments: args }, callOpts?.timeoutMs !== undefined ? { timeout: callOpts.timeoutMs } : undefined);
        return {
          content: (result as { content?: unknown[] }).content ?? [],
          ...((result as { isError?: boolean }).isError === true ? { isError: true as const } : {}),
        };
      },
      async close(): Promise<void> {
        if (closed) return; // idempotent -- a lifecycle reconnect/disconnect path may call this more than once
        closed = true;
        await client.close();
      },
    };
  } catch (err) {
    // Best-effort cleanup on a failed connect -- never let a classification failure mask the
    // original error, and never let a SECOND failure (from cleanup itself) propagate over the first.
    // For stdio specifically, `WinterStdioTransport.close()` performs its own unconditional
    // process-GROUP kill (RULING P4-H) -- verified empirically (transports/stdio.test.ts's
    // connect-timeout case) to reliably reap the child AND any grandchild it spawned, so no
    // additional pid-tracking or manual kill is needed at this layer for any transport kind.
    // Whole-branch review N3: read the stderr tail BEFORE close() clears anything, so a stdio server
    // that died or hung during startup leaves a diagnostic on the error a caller actually sees.
    // A hung server produces no child `error` event at all (the transport's own spawn-path
    // attachment cannot cover it) -- this is the handshake/timeout half of the same finding.
    const stderrTail = transport! instanceof WinterStdioTransport ? (transport as WinterStdioTransport).stderrTail.trim() : "";
    try {
      await transport!.close();
    } catch {
      /* transport may never have started, or may already be closed -- either is fine here */
    }
    const classified = classifyConnectError(err);
    if (stderrTail === "" || classified.message.includes(stderrTail)) throw classified;
    // A NEW error of the same code, never a mutated one: McpConnectError.message is read back by
    // lifecycle.ts into the slot's own `error` field, and rewriting a thrown object in place is the
    // kind of aliasing that surprises a second reader of the same reference.
    throw new McpConnectError(classified.code, `${classified.message}\n--- server stderr (last ${stderrTail.length} chars) ---\n${stderrTail}`);
  }
}
