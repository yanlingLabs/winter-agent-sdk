// Phase 4 Task 4 (Lane A), WS-09 §1.1: the "http" (modern Streamable HTTP) transport connector --
// the non-deprecated remote transport `McpHttpServerConfig` names (contrast transports/sse.ts's
// own deprecated-but-still-supported sibling).
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpHttpServerConfig } from "@yanlinglabs/winter-agent-sdk";

// Returns the `Transport` INTERFACE type, not the concrete `StreamableHTTPClientTransport` class:
// under this package's `exactOptionalPropertyTypes: true`, the concrete class's own
// `get sessionId(): string | undefined` getter is NOT structurally assignable to `Transport`'s
// `sessionId?: string` field (an optional field means "absent, or present as exactly `string`" under
// that flag -- never "present with a possibly-undefined value", which is what a getter declares).
// This is a real friction between the pinned SDK's own (pre-exactOptionalPropertyTypes) type
// declarations and this package's stricter tsconfig, not a behavioral concern -- the class DOES
// implement `Transport` (its own `implements Transport` clause, checked under the SDK's own laxer
// tsconfig). Casting ONCE here, at the producer, means every caller (this lane's own tests,
// mcp/client.ts) receives an already-`Transport`-typed value and never re-hits this friction at
// their own call sites.
//
// `opts.refuseRedirects`: every request fails rather than follow a redirect. For a connection that
// carries a credential in a CUSTOM header this is not optional hygiene: fetch strips only
// `Authorization` on a cross-origin redirect, so an `x-api-key` header would otherwise be replayed to
// whatever origin the endpoint (or anything in front of it) pointed at. Not on the public server
// config -- it is a decision of the direct caller that put the credential there.
export function buildHttpTransport(cfg: McpHttpServerConfig, opts: { refuseRedirects?: boolean } = {}): Transport {
  const requestInit: RequestInit = { ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}), ...(opts.refuseRedirects === true ? { redirect: "error" as const } : {}) };
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    ...(Object.keys(requestInit).length > 0 ? { requestInit } : {}),
  });
  return transport as unknown as Transport;
}
