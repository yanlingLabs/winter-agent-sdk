// Phase 4 Task 4 (Lane A), WS-09 §1.1: the "sse" (legacy Server-Sent Events) transport connector --
// the real SDK marks its own client-side counterpart `@deprecated` in favor of
// StreamableHTTPClientTransport (transports/http.ts), but WS-09 §1.1's own config union still names
// it as a first-class member Winter must accept (servers mid-migration may only speak SSE).
//
// WS-23: v2 (`@modelcontextprotocol/client` 2.1.0) still ships this client, marked `@deprecated` in
// favour of Streamable HTTP, and it is KEPT for exactly the reason above. v2 dropped the SSE SERVER
// transport, which is why this lane's SSE fixture (mcp/test-fixtures.ts's `withSseFixture`) is now a
// hand-written wire-level server rather than the SDK's own. Its default era negotiation is
// `'legacy'` (mcp/client.ts's `resolveVersionNegotiation` says why).
import { SSEClientTransport, type Transport } from "@modelcontextprotocol/client";
import type { McpSSEServerConfig } from "@yanlinglabs/winter-agent-sdk";

// Returns the `Transport` INTERFACE type, uncast -- see transports/http.ts for why v1's cast is gone.
export function buildSseTransport(cfg: McpSSEServerConfig): Transport {
  const transport = new SSEClientTransport(new URL(cfg.url), {
    ...(cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : {}),
  });
  return transport;
}
