// Phase 4 Task 4 (Lane A), WS-09 §1.1: the "sse" (legacy Server-Sent Events) transport connector --
// the real SDK marks its own client-side counterpart `@deprecated` in favor of
// StreamableHTTPClientTransport (transports/http.ts), but WS-09 §1.1's own config union still names
// it as a first-class member Winter must accept (servers mid-migration may only speak SSE).
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpSSEServerConfig } from "@yanlinglabs/winter-agent-sdk";

// Returns the `Transport` INTERFACE type -- see transports/http.ts's own header for exactly why the
// concrete `SSEClientTransport` class needs a cast under this package's `exactOptionalPropertyTypes`
// (the identical `sessionId?: string` vs. `get sessionId(): string | undefined` friction).
export function buildSseTransport(cfg: McpSSEServerConfig): Transport {
  const transport = new SSEClientTransport(new URL(cfg.url), {
    ...(cfg.headers !== undefined ? { requestInit: { headers: cfg.headers } } : {}),
  });
  return transport as unknown as Transport;
}
