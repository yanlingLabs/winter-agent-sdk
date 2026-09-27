// WS-25 (MCP OAuth) §2 / §1.6: sign-out -- best-effort RFC 7009 revocation, then the token item is removed.
import { McpOAuthError } from "./errors.ts";
import type { McpOAuthStore } from "./store.ts";

export interface RevokeMcpOAuthOptions {
  /** The token item's FULL account name, `mcp-oauth:<id>`. */
  account: string;
  store: McpOAuthStore;
  /** The network under the auth-HTTP policy (tests). The policy is applied on top, always. */
  fetch?: typeof fetch;
  /**
   * WS-25, additive (`winter mcp logout --forget-client`): also remove the client registration. Absent, it
   * is KEPT (spec §1.6) -- re-registering on every sign-in would be DCR spam, and a pre-registered or CIMD
   * client has nothing to re-register.
   */
  forgetClient?: boolean;
}

export async function revokeMcpOAuth(_opts: RevokeMcpOAuthOptions): Promise<void> {
  throw new McpOAuthError("not_implemented", "revokeMcpOAuth is not implemented yet");
}
