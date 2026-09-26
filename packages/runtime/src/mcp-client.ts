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
export {
  connectMcpServer,
  McpConnectError,
  resolveVersionNegotiation,
  type ConnectedMcpClient,
  type ConnectMcpServerOptions,
  type McpConnectErrorCode,
  type McpToolInfo,
  type McpToolAnnotationsInfo,
  type McpResourceInfo,
  type McpResourceContent,
  type McpToolCallResult,
} from "./mcp/client.ts";
export { createElicitationAsker, type ElicitationAsker, type ElicitationSender } from "./mcp/elicitation.ts";
