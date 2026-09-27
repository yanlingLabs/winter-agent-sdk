// WS-25 (MCP OAuth): what the ENGINE needs from `mcp-auth`, kept here so `engine.ts` gains call sites, not
// logic: the session's `McpSessionOAuth` (the store plus the host's `mcp_oauth_refresh` door over the
// session's own control bridge), the needs-auth hint for a call to a withdrawn tool, and the persisted
// notice that tells the model which servers need the user to sign in.
import { MCP_OAUTH_REFRESH_SUBTYPE, WinterRpcError, type McpOAuthRefreshAnswer, type McpOAuthRefreshRequest } from "@yanlinglabs/winter-agent-sdk";
import { attachmentsIn, registerAttachmentRenderer, type AttachmentPayload } from "../context/attachments.ts";
import type { ProviderMessage } from "../engine.ts";
import type { McpServerState } from "../mcp/state.ts";
import { mcpSignInHint, type McpSessionOAuth } from "./session-provider.ts";
import type { McpOAuthStore } from "./store.ts";

/** How long a session waits for its host to refresh a sign-in before treating the ask as transient. */
export const MCP_OAUTH_HOST_REFRESH_TIMEOUT_MS = 60_000;

/** The narrow view of the session's control bridge this needs (the runtime's `RpcBridge` satisfies it). */
export interface McpOAuthHostSender {
  request<T = unknown>(subtype: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

function isAnswer(value: unknown): value is McpOAuthRefreshAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; reason?: unknown };
  return v.ok === true || (v.ok === false && (v.reason === "needs_auth" || v.reason === "transient"));
}

/**
 * The session's sign-in wiring. `askHost` answers `"unhandled"` ONLY for the host's own "no handler
 * registered" reply -- the standalone case, which refreshes in-process. Every other failure of the round
 * trip (a timeout, a dead transport, a malformed answer) is `transient`: a host that HAS a handler must
 * never be bypassed by a session that then posts the refresh itself.
 */
export function createSessionMcpOAuth(opts: { store: McpOAuthStore; sender: McpOAuthHostSender; brand: { homeDirName: string; productName: string } }): McpSessionOAuth {
  return {
    store: opts.store,
    signInHint: (serverName) => mcpSignInHint(opts.brand, serverName),
    askHost: async (request: McpOAuthRefreshRequest) => {
      try {
        const answer = await opts.sender.request(MCP_OAUTH_REFRESH_SUBTYPE, request, { timeoutMs: MCP_OAUTH_HOST_REFRESH_TIMEOUT_MS });
        return isAnswer(answer) ? answer : { ok: false, reason: "transient" };
      } catch (err) {
        if (err instanceof WinterRpcError && err.code === "unhandled_subtype") return "unhandled";
        return { ok: false, reason: "transient" };
      }
    },
  };
}

/** The servers in `needsAuth`, sorted: the notice's subject and the hint's lookup. */
export function needsAuthServers(states: readonly McpServerState[] | undefined): string[] {
  return (states ?? [])
    .filter((s) => s.state === "needsAuth")
    .map((s) => s.name)
    .sort();
}

/**
 * The hint a call to a tool of a server that needs sign-in gets, appended to "No such tool available"
 * (spec §1.3: the call answers with the door, never a browser and never a model-callable auth tool).
 * Matched on the `mcp__<server>__` prefix of each needs-auth server by NAME, not by splitting the tool
 * name (a server name may itself contain `__`).
 */
export function needsAuthToolHint(states: readonly McpServerState[] | undefined, toolName: string, brand: { homeDirName: string; productName: string }): string {
  const server = needsAuthServers(states).find((name) => toolName.startsWith(`mcp__${name}__`));
  if (server === undefined) return "";
  return `. The MCP server '${server}' needs sign-in, so its tools are unavailable. ${mcpSignInHint(brand, server)}`;
}

// --- The needs-auth notice: a persisted attachment -----------------------------------------------------
//
// WHY AN ATTACHMENT, NOT A SYSTEM-CONTEXT LINE (a disclosed divergence from spec §3's wording). The
// session's system context is built ONCE for prompt-cache stability; a line in it listing needs-auth
// servers would either go stale after a sign-in or, re-rendered, shift the cached prefix of every later
// request. A persisted attachment (WS-24's `plan_mode` precedent) is announced ONCE per change, stays in
// the history as a stable prefix, survives resume, and costs one cache miss on the turn it lands.

export interface McpNeedsAuthAttachment extends AttachmentPayload {
  type: "mcp_needs_auth";
  /** The servers that need sign-in now (sorted); empty means "none any more". */
  servers: string[];
  /** The door, captured at production time for the `<server>` placeholder (a renderer has no brand). */
  door: string;
}

const SERVER_PLACEHOLDER = "<server>";

/** A server name as the model may read it: the characters a config name legitimately has. */
function displayName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
}

registerAttachmentRenderer("mcp_needs_auth", (attachment) => {
  const servers = Array.isArray(attachment.servers) ? attachment.servers.filter((s): s is string => typeof s === "string").map(displayName) : [];
  const door = typeof attachment.door === "string" ? attachment.door : "";
  if (servers.length === 0) return "The MCP servers that needed sign-in are signed in now; their tools are available again.";
  return `These MCP servers need the user to sign in, so their tools are not available: ${servers.join(", ")}. Do not try to authenticate on the user's behalf. If the user needs one of them, tell them how to sign in: ${door}`;
});

/** What the history last announced (`[]` before any announcement). */
function lastAnnounced(messages: readonly ProviderMessage[]): string[] {
  let last: string[] = [];
  for (const a of attachmentsIn(messages)) {
    if (a.type === "mcp_needs_auth" && Array.isArray(a.servers)) last = (a.servers as unknown[]).filter((s): s is string => typeof s === "string");
  }
  return last;
}

/** The notice to append now, or `undefined` when the needs-auth set is what the history already says. */
export function mcpNeedsAuthAttachment(states: readonly McpServerState[] | undefined, messages: readonly ProviderMessage[], brand: { homeDirName: string; productName: string }): McpNeedsAuthAttachment | undefined {
  const now = needsAuthServers(states);
  const before = lastAnnounced(messages);
  if (now.length === before.length && now.every((name, i) => name === before[i])) return undefined;
  return { type: "mcp_needs_auth", servers: now, door: mcpSignInHint(brand, SERVER_PLACEHOLDER) };
}
