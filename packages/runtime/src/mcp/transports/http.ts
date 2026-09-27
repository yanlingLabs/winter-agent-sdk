// Phase 4 Task 4 (Lane A), WS-09 §1.1: the "http" (modern Streamable HTTP) transport connector --
// the non-deprecated remote transport `McpHttpServerConfig` names (contrast transports/sse.ts's
// own deprecated-but-still-supported sibling).
//
// WS-23: on the MCP TS SDK v2 (`@modelcontextprotocol/client` 2.1.0). The transport is unchanged in
// shape for this caller; what v2 changes AROUND it -- the `'auto'` era probe it may carry, the
// `SdkHttpError` it throws on a non-OK answer -- is absorbed in mcp/client.ts.
import { StreamableHTTPClientTransport, type AuthProvider, type Transport } from "@modelcontextprotocol/client";
import type { McpHttpServerConfig } from "@yanlinglabs/winter-agent-sdk";

/**
 * WS-25: the network an AUTHENTICATED transport (one with an `authProvider`) uses -- the platform `fetch`
 * with every redirect REFUSED. A bearer token rides the `Authorization` header, which fetch strips on a
 * cross-origin hop, but the MCP request BODY (tool arguments drawn from the conversation) does not get
 * stripped, and a server that redirects an authenticated MCP connection is not one to follow. Read at call
 * time, so a test's network guard (which wraps the global) still sees every request.
 */
export const refusingRedirectsFetch = ((url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, redirect: "error" })) as typeof fetch;

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
//
// `opts.authProvider` (WS-25): the session's READ-ONLY bearer provider (mcp-auth/session-provider.ts) --
// the MCP client's minimal `AuthProvider`, never an `OAuthClientProvider`, so the transport can never run a
// refresh grant or a browser redirect of its own. Its presence also switches every request to
// `refusingRedirectsFetch`.
export function buildHttpTransport(cfg: McpHttpServerConfig, opts: { refuseRedirects?: boolean; authProvider?: AuthProvider } = {}): Transport {
  const requestInit: RequestInit = { ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}), ...(opts.refuseRedirects === true ? { redirect: "error" as const } : {}) };
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    ...(Object.keys(requestInit).length > 0 ? { requestInit } : {}),
    ...(opts.authProvider !== undefined ? { authProvider: opts.authProvider, fetch: refusingRedirectsFetch } : {}),
  });
  return transport;
}
