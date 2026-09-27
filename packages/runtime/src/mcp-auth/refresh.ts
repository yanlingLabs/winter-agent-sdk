// WS-25 (MCP OAuth) §2: the refresh the HOST runs (Winter's daemon, answering `mcp_oauth_refresh`) -- and a
// standalone SDK session runs in-process when its host registers no handler.
import { McpOAuthError } from "./errors.ts";
import type { McpOAuthStore } from "./store.ts";

export interface RefreshMcpOAuthTokenOptions {
  /** The token item's FULL account name, `mcp-oauth:<id>`. The client item is its prefix swap. */
  account: string;
  store: McpOAuthStore;
  /** The network under the auth-HTTP policy (tests). The policy is applied on top, always. */
  fetch?: typeof fetch;
  /** The clock (tests). Epoch ms. */
  now?: () => number;
  /**
   * WS-25, additive: the generation the ASKING session last read (`McpOAuthRefreshRequest.generation`).
   * When the stored record has already moved past it, another caller refreshed first: the answer is
   * `{ ok: true }` with the stored generation, and nothing is posted.
   */
  generation?: number;
  /**
   * WS-25, additive: a scope a `403 insufficient_scope` asked for (`McpOAuthRefreshRequest.stepUpScope`).
   * A refresh cannot widen a grant (RFC 6749 §6), so it is recorded on the client registration for the
   * next sign-in and the answer is `needs_auth`.
   */
  stepUpScope?: string;
}

export type RefreshMcpOAuthTokenResult = { ok: true; generation: number } | { ok: false; reason: "needs_auth" | "transient" };

export async function refreshMcpOAuthToken(_opts: RefreshMcpOAuthTokenOptions): Promise<RefreshMcpOAuthTokenResult> {
  throw new McpOAuthError("not_implemented", "refreshMcpOAuthToken is not implemented yet");
}
