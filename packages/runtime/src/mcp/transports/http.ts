// Phase 4 Task 4 (Lane A), WS-09 §1.1: the "http" (modern Streamable HTTP) transport connector --
// the non-deprecated remote transport `McpHttpServerConfig` names (contrast transports/sse.ts's
// own deprecated-but-still-supported sibling).
//
// WS-23: on the MCP TS SDK v2 (`@modelcontextprotocol/client` 2.1.0). The transport is unchanged in
// shape for this caller; what v2 changes AROUND it -- the `'auto'` era probe it may carry, the
// `SdkHttpError` it throws on a non-OK answer -- is absorbed in mcp/client.ts.
import { StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import type { McpHttpServerConfig } from "@yanlinglabs/winter-agent-sdk";

// Returns the `Transport` INTERFACE type, not the concrete class. v1 needed an `as unknown as`
// cast here (its `get sessionId(): string | undefined` was not assignable to `Transport`'s
// `sessionId?: string` under this package's `exactOptionalPropertyTypes`); v2 declares the field
// `sessionId?: string | undefined`, so the class is assignable as-is and the cast is gone.
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
  return transport;
}
