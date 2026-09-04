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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import { buildStdioTransport, WinterStdioTransport } from "./transports/stdio.ts";
import { buildHttpTransport } from "./transports/http.ts";
import { buildSseTransport } from "./transports/sse.ts";
import { buildSdkTransport, type InProcessMcpServer } from "./transports/sdk.ts";
import { installElicitationHandler, type ElicitationAsker } from "./elicitation.ts";

// --- Public shapes ---------------------------------------------------------------------------

export type McpConnectErrorCode = "timeout" | "spawn_failed" | "handshake_failed" | "needs_auth" | "unknown";

export class McpConnectError extends Error {
  readonly code: McpConnectErrorCode;
  constructor(code: McpConnectErrorCode, message: string) {
    super(message);
    this.name = "McpConnectError";
    this.code = code;
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
}

// --- Error classification (WS-09 §2.1's failed/needsAuth split, plus a small diagnostic taxonomy
// beyond what the state model itself distinguishes) --------------------------------------------

function classifyConnectError(err: unknown): McpConnectError {
  if (err instanceof McpConnectError) return err;
  if (err instanceof UnauthorizedError) return new McpConnectError("needs_auth", err.message);
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return new McpConnectError("timeout", err.message);
  // A bare 401 with NO authProvider configured (this connector never configures one) does NOT
  // throw `UnauthorizedError` from these two transports -- verified empirically against the real
  // SDK: that class is reserved for the case an authProvider EXISTS but authorization still fails.
  // An unauthenticated 401 instead surfaces as an ordinary `StreamableHTTPError`/`SseError` whose
  // own `code` carries the HTTP status -- checked here so a server that requires auth Winter has no
  // credentials for still lands in WS-09 §2.1's `needsAuth` state, not a generic "failed".
  if ((err instanceof StreamableHTTPError || err instanceof SseError) && err.code === 401) {
    return new McpConnectError("needs_auth", err.message);
  }
  if (err instanceof StreamableHTTPError || err instanceof SseError) return new McpConnectError("handshake_failed", err.message);
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

// --- The connector -----------------------------------------------------------------------------

export async function connectMcpServer(opts: ConnectMcpServerOptions): Promise<ConnectedMcpClient> {
  const { name, config, connectTimeoutMs, elicitationAsk } = opts;

  let transport: Transport;

  try {
    if (config.type === "sdk") {
      if (!opts.inProcessServer) {
        throw new McpConnectError("spawn_failed", `mcp client: server "${name}" is configured as type "sdk" but no in-process server instance was supplied to connectMcpServer`);
      }
      transport = await buildSdkTransport(opts.inProcessServer);
    } else if (config.type === "http") {
      transport = buildHttpTransport(config);
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

    const client = new Client(
      { name: "winter", version: "0.0.1" },
      // Unconditional, regardless of whether `elicitationAsk` will itself round-trip to a real host
      // callback or decline immediately -- see elicitation.ts's own header: a connected server must
      // NEVER be left without a registered handler at the protocol level (that is what guarantees
      // "never a hang" all the way down to the wire).
      { capabilities: { elicitation: {} } },
    );
    installElicitationHandler(client, name, elicitationAsk);

    await raceConnect(client, transport, connectTimeoutMs);

    let closed = false;
    return {
      serverName: name,
      // A REAL, LIVE re-query every call -- NOT a snapshot frozen at connect time. This is
      // load-bearing, not merely "more correct": mcp/lifecycle.ts's own `refreshServerTools`
      // (RefreshMcpTools, WS-09 §1.4) exists specifically to observe a server's tool list changing
      // AFTER the initial connection, and a caching `listTools()` here would make that mechanism a
      // silent no-op regardless of what the connected server actually reports (found by this lane's
      // own test suite: a fixture server whose tools/list answer genuinely changed between two
      // calls kept reporting the ORIGINAL list until this was fixed). The real SDK's own
      // `Client.listTools()` performs a real `tools/list` request every call (it only caches output-
      // schema VALIDATORS, never the list itself, verified against the pinned 1.30.0 source) --
      // this method mirrors that live-request behavior, not a stale wrapper around it.
      async listTools(): Promise<McpToolInfo[]> {
        const rawTools = await client.listTools();
        return dedupeTools(
          rawTools.tools.map((t) => ({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
            ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema as Record<string, unknown> } : {}),
            ...(t.annotations !== undefined ? { annotations: t.annotations as McpToolAnnotationsInfo } : {}),
            ...(t._meta !== undefined ? { _meta: t._meta as Record<string, unknown> } : {}),
          })),
        );
      },
      async listResources(): Promise<McpResourceInfo[]> {
        const result = await client.listResources();
        return result.resources.map((r) => ({
          uri: r.uri,
          ...(r.name !== undefined ? { name: r.name } : {}),
          ...(r.description !== undefined ? { description: r.description } : {}),
          ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
        }));
      },
      async readResource(uri: string, readOpts?: { timeoutMs?: number }): Promise<McpResourceContent[]> {
        const result = await client.readResource({ uri }, readOpts?.timeoutMs !== undefined ? { timeout: readOpts.timeoutMs } : undefined);
        return result.contents.map((c) => {
          const mimeType = "mimeType" in c && c.mimeType !== undefined ? c.mimeType : undefined;
          if ("blob" in c) {
            return { uri: c.uri, ...(mimeType !== undefined ? { mimeType } : {}), blobBase64: c.blob };
          }
          return { uri: c.uri, ...(mimeType !== undefined ? { mimeType } : {}), text: "text" in c ? c.text : "" };
        });
      },
      async callTool(toolName: string, args: Record<string, unknown>, callOpts?: { timeoutMs?: number }): Promise<McpToolCallResult> {
        const result = await client.callTool(
          { name: toolName, arguments: args },
          undefined,
          callOpts?.timeoutMs !== undefined ? { timeout: callOpts.timeoutMs } : undefined,
        );
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
