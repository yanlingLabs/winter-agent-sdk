// WS-24 (cross-lane, for the Winter daemon): the runtime's ONE MCP client, as a public subpath --
// `@yanlinglabs/winter-agent-runtime/mcp-client`.
//
// WHY. A host that talks to MCP servers itself (Winter's daemon keeps a hand-written 2024-11-05 stdio
// client behind its `McpManager`) should use the client its sessions already use -- the v2 TS SDK behind
// Winter's own stdio transport (explicit env allowlist, process-group kill), the per-transport version
// negotiation with its one legacy retry, the cause-classified `McpConnectError` -- rather than a second
// implementation that drifts from it.
//
// LIGHT ON PURPOSE, like `./embedded-host`: this entry reaches only `mcp/client.ts`, its transports, the
// elicitation adapter and the process-group ledger -- never the engine, the tool registry or anything
// else with module-level session state -- so a host can import it on its main thread.
//
// `elicitationAsk` is required by `connectMcpServer`: pass `createElicitationAsker(undefined)` for "no
// host UI" (every elicitation is declined deterministically, never left hanging).
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import { connectMcpServer as connectInternal, type ConnectedMcpClient } from "./mcp/client.ts";
import type { ElicitationAsker } from "./mcp/elicitation.ts";

export {
  McpConnectError,
  resolveVersionNegotiation,
  type ConnectedMcpClient,
  type McpConnectErrorCode,
  type McpToolInfo,
  type McpToolAnnotationsInfo,
  type McpResourceInfo,
  type McpResourceContent,
  type McpToolCallResult,
} from "./mcp/client.ts";
export {
  createElicitationAsker,
  type ElicitationAction,
  type ElicitationAsker,
  type ElicitationRequestPayload,
  type ElicitationResultPayload,
  type ElicitationSender,
} from "./mcp/elicitation.ts";

/**
 * What a HOST connects with -- deliberately narrower than the runtime's own options: no in-process
 * (`type: "sdk"`) server (a host that has the server object in hand does not need a protocol client to
 * reach it), no redirect refusal (the runtime's web search backend's concern) and no list-changed hook
 * (the runtime's lifecycle owns re-registration). Everything it references is exported from here or from
 * `@yanlinglabs/winter-agent-sdk`, so this subpath's declarations reach into nothing private.
 */
export interface ConnectMcpServerOptions {
  /** The server's name: prefixes its diagnostics and is `ConnectedMcpClient.serverName`. */
  name: string;
  /** A stdio, Streamable HTTP or SSE server config (with its optional `versionNegotiation`). */
  config: Exclude<McpServerConfigForProcessTransport, { type: "sdk" }>;
  /** The connection attempt's whole budget, in ms (never a tool call's timeout). */
  connectTimeoutMs: number;
  /** Answers a server's elicitation; `createElicitationAsker(undefined)` declines every one deterministically. */
  elicitationAsk: ElicitationAsker;
  /** REQUIRED for a stdio server: the directory it starts in (never the host process's cwd by default). */
  cwd?: string;
}

/** Connect ONE MCP server and return its live client. Rejects with a typed `McpConnectError` (see its `code`). */
export function connectMcpServer(opts: ConnectMcpServerOptions): Promise<ConnectedMcpClient> {
  return connectInternal({
    name: opts.name,
    config: opts.config,
    connectTimeoutMs: opts.connectTimeoutMs,
    elicitationAsk: opts.elicitationAsk,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
}
