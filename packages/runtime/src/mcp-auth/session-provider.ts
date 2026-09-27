// WS-25 (MCP OAuth) §1.1-§1.3: the SESSION's side of a sign-in -- a READ-ONLY bearer provider for one
// remote MCP server connection.
//
// READ-ONLY is the design, not a limitation. A session (a spawned code child, an embedded Worker) reads
// the token item from the Keychain and never posts a refresh grant while its host answers
// `mcp_oauth_refresh`: the host is the ONE refresher (refresh.ts's header says why a rotating refresh
// token needs exactly one). So this is the MCP client's minimal `AuthProvider` (`token()` +
// `onUnauthorized()`), never an `OAuthClientProvider` -- handing the transport the latter would let it run
// `auth()` -- a refresh grant, or a browser redirect -- inside the session.
//
// STARTUP (spec §1.2, exactly -- and never the Claude Code bug that refreshes a still-valid token, or
// treats one without a refresh token as needing a refresh):
//   - a stored token that is usable -> used; NO refresh at connect;
//   - `expiresAt` absent -> usable until the server answers 401;
//   - expired (or within 60 s of it) WITH a refresh token -> ask the host to refresh, then re-read;
//   - expired WITHOUT a refresh token -> `needs-auth` at once: no refresh attempt, no request to the
//     server, no error loop (`preflight`, run before the transport even exists);
//   - a refresh that answers `needs_auth` (invalid_grant, a revoked client) -> `needs-auth`.
// No stored sign-in at all is NOT an error here: the server may not need one. It connects with no
// `Authorization` header, and a 401 then is `needs-auth` like any other.
//
// MID-SESSION: `token()` re-reads the Keychain at most every ~30 s, and at once when the cached token is
// near expiry (asking the host first); a 401 re-reads once (another process may already have refreshed),
// asks the host if the token did not change, and otherwise ends in `needs-auth`. Nothing here opens a
// browser, and nothing here ever blocks a tool call on a person.
//
// NO HOST HANDLER (a standalone SDK user, one process): the host's answer is "no handler registered", and
// the session refreshes IN-PROCESS through the same `refreshMcpOAuthToken` a host runs -- single-flight
// and generation-checked within this process.
import type { McpOAuthRefreshAnswer, McpOAuthRefreshRequest } from "@yanlinglabs/winter-agent-sdk";
import { mcpOAuthTokenAccount } from "./account.ts";
import { MCP_OAUTH_EXPIRY_SKEW_MS, MCP_OAUTH_SESSION_CACHE_MS } from "./constants.ts";
import type { McpOAuthTokenRecord } from "./records.ts";
import { refreshMcpOAuthToken } from "./refresh.ts";
import { readTokenRecordLenient, type McpOAuthStore } from "./store.ts";

/** The host's answer, or `"unhandled"` when the host registered no `mcp_oauth_refresh` handler. */
export type McpOAuthHostAsk = (request: McpOAuthRefreshRequest) => Promise<McpOAuthRefreshAnswer | "unhandled">;

/** What a session hands every remote server's connection. */
export interface McpSessionOAuth {
  /** The Keychain (the session's own service), read-only unless the in-process fallback refreshes. */
  store: McpOAuthStore;
  /** Asks the host to refresh. Absent: always in-process. */
  askHost?: McpOAuthHostAsk;
  /**
   * WS-25 §7: the host OWNS renewal (a host-brokered session: `store` is read-only, and no refresh token
   * is in this process). A host answer of "unhandled" is then `transient`, never the in-process refresh.
   */
  hostOwnsRefresh?: boolean;
  /** The sign-in door, for a server name -- the text a `needs-auth` error names (e.g. `winter mcp login linear`). */
  signInHint: (serverName: string) => string;
  /** The clock (tests). Epoch ms. */
  now?: () => number;
  /** The network the in-process fallback refreshes over (tests). */
  fetch?: typeof fetch;
}

/** The server needs a (new) sign-in. Classified `needs_auth` wherever it surfaces. */
export class McpNeedsAuthError extends Error {
  readonly serverName: string;
  constructor(serverName: string, why: string, hint: string) {
    super(`MCP server "${serverName}" needs sign-in (${why}). ${hint}`);
    this.name = "McpNeedsAuthError";
    this.serverName = serverName;
  }
}

/** A refresh that could not complete right now (the network, the authorization server's 5xx). */
export class McpAuthRefreshUnavailableError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}": its sign-in could not be refreshed right now (the authorization server did not answer); reconnect it later`);
    this.name = "McpAuthRefreshUnavailableError";
  }
}

export interface McpSessionAuthProvider {
  /** The MCP client's `AuthProvider.token()`: the bearer for the next request, or none. */
  token(): Promise<string | undefined>;
  /** The MCP client's `AuthProvider.onUnauthorized()`: make the next `token()` valid, or throw. */
  onUnauthorized(): Promise<void>;
  /** Before the transport exists: throws `McpNeedsAuthError` when the stored sign-in is already dead (spec §1.2). */
  preflight(): Promise<void>;
  /** A `403 insufficient_scope`: the host records the scope for the next sign-in (the answer is not awaited for anything). */
  reportInsufficientScope(scope: string | undefined): Promise<void>;
}

export function createSessionAuthProvider(opts: { serverName: string; serverUrl: string; oauth: McpSessionOAuth }): McpSessionAuthProvider {
  const { serverName, oauth } = opts;
  const account = mcpOAuthTokenAccount(opts.serverUrl);
  const now = oauth.now ?? Date.now;
  let cached: { record: McpOAuthTokenRecord | null; readAt: number } | undefined;
  let refreshing: Promise<McpOAuthRefreshAnswer> | undefined;

  const needsAuth = (why: string): McpNeedsAuthError => new McpNeedsAuthError(serverName, why, oauth.signInHint(serverName));
  // Fix round 1 M3. The 60 s margin is a reason to REFRESH EARLY, so it applies only when there is a
  // refresh token: without one the token is used right up to its `expiresAt` (then needs-auth). And a
  // generation this provider just refreshed INTO is used to its `expiresAt` too -- an authorization
  // server that issues `expires_in <= 60` would otherwise be asked to refresh on every request.
  let refreshedGeneration: number | undefined;
  const usable = (record: McpOAuthTokenRecord): boolean => {
    if (record.expiresAt === undefined) return true;
    const margin = record.refreshToken !== undefined && record.generation !== refreshedGeneration ? MCP_OAUTH_EXPIRY_SKEW_MS : 0;
    return record.expiresAt - now() > margin;
  };

  async function read(force: boolean): Promise<McpOAuthTokenRecord | null> {
    if (!force && cached !== undefined && now() - cached.readAt < MCP_OAUTH_SESSION_CACHE_MS && (cached.record === null || usable(cached.record))) return cached.record;
    const record = await readTokenRecordLenient(oauth.store, account);
    cached = { record, readAt: now() };
    return record;
  }

  async function ask(generation: number, stepUpScope?: string): Promise<McpOAuthRefreshAnswer> {
    const request: McpOAuthRefreshRequest = { server: serverName, account, generation, ...(stepUpScope !== undefined ? { stepUpScope } : {}) };
    if (oauth.askHost !== undefined) {
      const answer = await oauth.askHost(request).catch((): McpOAuthRefreshAnswer => ({ ok: false, reason: "transient" }));
      if (answer !== "unhandled") return answer;
      if (oauth.hostOwnsRefresh === true) return { ok: false, reason: "transient" };
    }
    if (oauth.hostOwnsRefresh === true) return { ok: false, reason: "transient" };
    const result = await refreshMcpOAuthToken({ account, store: oauth.store, generation, ...(stepUpScope !== undefined ? { stepUpScope } : {}), ...(oauth.fetch !== undefined ? { fetch: oauth.fetch } : {}), ...(oauth.now !== undefined ? { now: oauth.now } : {}) });
    return result.ok ? { ok: true } : result;
  }

  /** One refresh at a time per connection; a joiner shares the answer. */
  function refresh(generation: number): Promise<McpOAuthRefreshAnswer> {
    refreshing ??= ask(generation).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function refreshed(record: McpOAuthTokenRecord): Promise<McpOAuthTokenRecord> {
    if (record.refreshToken === undefined) throw needsAuth("the stored token has expired and there is no refresh token");
    const answer = await refresh(record.generation);
    if (!answer.ok) {
      if (answer.reason === "needs_auth") throw needsAuth("the sign-in could not be refreshed");
      throw new McpAuthRefreshUnavailableError(serverName);
    }
    const next = await read(true);
    // `ok` means "re-read"; a record that did not move is a refresh that did not happen.
    if (next === null || next.generation === record.generation) throw needsAuth("the refreshed sign-in was not found");
    refreshedGeneration = next.generation;
    return next;
  }

  /** The token for the next request: the stored one when usable, else a refreshed one; none when never signed in. */
  async function current(): Promise<string | undefined> {
    const record = await read(false);
    if (record === null) return undefined;
    if (usable(record)) return record.accessToken;
    return (await refreshed(record)).accessToken;
  }

  return {
    token: current,
    async preflight() {
      await current();
    },
    async onUnauthorized() {
      const before = cached?.record ?? null;
      const record = await read(true);
      if (record === null) throw needsAuth("the server requires a sign-in");
      // Another process already refreshed (or a sign-in landed): retry with the new token.
      if (before === null || record.accessToken !== before.accessToken) return;
      await refreshed(record);
    },
    async reportInsufficientScope(scope) {
      const record = await read(true).catch(() => null);
      if (record === null || scope === undefined || scope.trim() === "") return;
      await ask(record.generation, scope).catch(() => undefined);
    },
  };
}

/**
 * The sign-in door a `needs-auth` error names, for a brand: `<cli> mcp login <server>` and the app's MCP
 * settings. The CLI name is the home directory's token (the dot-dir without its dot), the one brand field that
 * IS the command a user types.
 */
export function mcpSignInHint(brand: { homeDirName: string; productName: string }, serverName: string): string {
  const cli = brand.homeDirName.replace(/^\./, "");
  return `Sign in with \`${cli} mcp login ${serverName}\` (or ${brand.productName} Settings -> MCP), then reconnect the server.`;
}
