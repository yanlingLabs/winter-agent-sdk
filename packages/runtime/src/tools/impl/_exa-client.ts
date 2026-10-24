// THE SEARCH BACKEND CLIENT -- Exa's hosted MCP server over Streamable HTTP -- in a module that
// REGISTERS NOTHING. `impl/web-search.ts` drives it; nothing here is a tool.
//
// THE CLIENT ITSELF (anonymous-first, the key fallback, the breaker, the pacer, the per-call timeout,
// the echo-proof error reading, the parsing) LIVES IN `@yanlinglabs/winter-web`'s
// `createExaSearchClient`; what stays here is Winter's TRANSPORT for it -- this runtime's own MCP
// client (`connectMcpServer`, below) and the reading of that client's error types -- plus the
// session's key resolver and the hit/failure shapes `web-search.ts` and its tests speak.
//
// It wraps `connectMcpServer` (the ONE MCP client in this codebase; no second client is built here)
// and owns everything that, for a lifecycle-managed server, `mcp/lifecycle.ts` would own: the
// per-call timeout, the output cap, abort, rate-limit handling and reconnect. None of those exist on
// the direct-call path -- `callTool` takes no abort signal, `capMcpOutput` is lifecycle-only, and
// there is no retry or backoff anywhere under `mcp/`.
//
// ANONYMOUS FIRST, THE KEY AS FALLBACK. The anonymous tier is free and needs no credential, so it is
// tried first; the user's key is spent only once the anonymous tier answers rate-limited or
// quota-exhausted. The key travels in the `x-api-key` HEADER and NEVER in the URL -- a query string
// is logged by proxies, kept in shell history and echoed in error messages, and the endpoint URL is
// exactly the kind of string that ends up in all three.
//
// THE CIRCUIT BREAKER. Once the anonymous tier answers rate-limited, every call in this PROCESS goes
// straight to the key for `EXA_ANONYMOUS_COOLDOWN_MS`, then the next call RE-PROBES the anonymous
// tier. The server's allowance window is unstated, so nothing here assumes a calendar boundary (no
// "until UTC midnight"): the cooldown is a named constant, short enough that a no-key user is not
// locked out long after the allowance returns, long enough that a keyed user is not paying a failed
// round trip per search. With no key and the breaker open the answer is a typed `quota-exhausted`
// result -- without touching the network -- that says how to add a key.
//
// A CLIENT IS PER SESSION, AND SHORT-LIVED (one per `WebSearch` call is the intended use). It caches
// the resolved key and holds the KEYED connection, so sharing one across sessions would send one
// session's key on another's searches. What IS shared across the process is only `ExaBackendState`
// (the breaker and the pacer), which holds no credential. Key caching: a FOUND key is resolved once
// per client (every resolution can be a keychain prompt); a `missing` or `unreadable` answer is NOT
// cached, so a key the user adds mid-session is seen by the very next search.
//
// LIVE SCHEMA this was built against (server `exa-search-server` 3.2.1, probed 2026-09-18):
//   `web_search_exa`           requires `query` AND `objective`; optional `numResults`. No domain filter.
//   `web_search_advanced_exa`  requires `query`; accepts `numResults`, `type`, `includeDomains`,
//                              `excludeDomains`, `enableHighlights`, `highlightsMaxCharacters`,
//                              `textMaxCharacters`, ...
// RESPONSE PAYLOADS, also measured -- one `text` content block each, in two different shapes:
//   advanced: a JSON string `{ requestId, resolvedSearchType, results: [{ id, url, title,
//             publishedDate, image, text, highlights: string[] }], searchTime }`. `text` is the WHOLE
//             PAGE unless capped -- one result measured 347,123 characters -- which is why
//             `textMaxCharacters` is always sent and the raw text is capped again here.
//   basic:    plain text records `Title:` / `URL:` / `Published:` / `Author:` / `Highlights:` (the
//             highlight lines follow), separated by a line holding only `---`.
// `parseExaHits` reads both and is deliberately tolerant: the payload is a third party's, unversioned.
import { SdkError, SdkErrorCode, SdkHttpError, SseError } from "@modelcontextprotocol/client";
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import {
  createExaSearchClient as createWebExaSearchClient,
  EXA_AUTH_PATTERN,
  EXA_RATE_LIMIT_PATTERN,
  EXA_UNREACHABLE_PATTERN,
  parseExaResults,
  type ExaConnection,
  type ExaSearchResultItem,
  type ExaTransport,
  type ExaSearchFailureCode as WebExaSearchFailureCode,
} from "@yanlinglabs/winter-web";
import { connectMcpServer, McpConnectError } from "../../mcp/client.ts";
import { createElicitationAsker } from "../../mcp/elicitation.ts";
import type { ToolSecretResult } from "../../provider/tool-secret.ts";
import type { WebSessionRuntime } from "../../web/session-runtime.ts";
import { siteIconHttpsUrl } from "./_site-icons.ts";

export {
  anonymousBreakerOpen,
  createExaBackendState,
  exaEndpointUrl,
  sharedExaBackendState,
  EXA_ADVANCED_SEARCH_TOOL,
  EXA_ANONYMOUS_COOLDOWN_MS,
  EXA_ANONYMOUS_MIN_INTERVAL_MS,
  EXA_API_KEY_HEADER,
  EXA_CALL_TIMEOUT_MS,
  EXA_CONNECT_TIMEOUT_MS,
  EXA_DEFAULT_NUM_RESULTS,
  EXA_ENABLED_TOOLS,
  EXA_HIGHLIGHTS_MAX_CHARACTERS,
  EXA_MAX_NUM_RESULTS,
  EXA_MAX_RESULT_CHARS,
  EXA_MCP_ENDPOINT,
  EXA_SEARCH_TOOL,
  EXA_TEXT_MAX_CHARACTERS,
  EXA_TITLE_MAX_CHARACTERS,
  EXA_URL_MAX_CHARACTERS,
  type ExaBackendState,
  type ExaTier,
} from "@yanlinglabs/winter-web";
import type { ExaBackendState, ExaTier } from "@yanlinglabs/winter-web";

const MCP_SERVER_NAME = "exa";

// --- shapes ---------------------------------------------------------------------------------------

export interface ExaSearchHit {
  title: string;
  url: string;
  /** The result's highlight text, capped at `EXA_HIGHLIGHTS_MAX_CHARACTERS`. Empty when the backend sent none. */
  highlight: string;
  publishedDate?: string;
  /** The result's `favicon` when the backend sent one (Exa's /search reference: "The URL of the favicon for the search result's domain"), https only. Never model-visible: `WebSearch` hands it to the HOST as `ToolResultPayload.siteIcons`. Absent from the basic text form and, as measured 2026-09-18, from the advanced JSON form too -- read when present. */
  favicon?: string;
}

export interface ExaSearchParams {
  query: string;
  /** `web_search_exa` REQUIRES one; defaults to the query itself. */
  objective?: string;
  numResults?: number;
  /** The call's own allow-list. Mutually exclusive with `excludeDomains` at the tool's surface. */
  includeDomains?: readonly string[];
  /** The call's own block-list. The host's `blockedDomains` floor is ADDED to it on every search. */
  excludeDomains?: readonly string[];
}

/**
 *   `quota-exhausted`   the anonymous tier is exhausted/rate-limited and NO key is configured.
 *   `key-unreadable`    ...and a key IS configured but could not be read (the message says why).
 *   `key-rate-limited`  the KEY tier answered rate-limited or out of credit.
 *   `key-rejected`      the key tier answered 401/403.
 *   `blocked-domains`   every allowed domain is on the host's block-list: nothing may be searched.
 *   `timeout` / `aborted` / `unreachable` / `backend-error`   as named.
 */
export type ExaSearchFailureCode = "quota-exhausted" | "key-unreadable" | "key-rate-limited" | "key-rejected" | "blocked-domains" | "timeout" | "aborted" | "unreachable" | "backend-error";

export type ExaSearchResult =
  | { ok: true; hits: ExaSearchHit[]; tier: ExaTier; tool: string; /** The payload's text, capped. */ rawText: string; truncated: boolean }
  | { ok: false; code: ExaSearchFailureCode; message: string };

export interface ExaSearchClientOptions {
  /**
   * Resolves the fallback key, LAZILY: it is not called at all while the anonymous tier answers, so
   * a session that never exhausts the free tier never touches the keychain. Called at most once per
   * client. Absent means "no key is configured".
   */
  resolveKey?: () => Promise<ToolSecretResult>;
  /** The host's `blockedDomains` floor: excluded from EVERY search, and any hit on it is dropped. */
  blockedDomains?: readonly string[];
  /** Overrides `EXA_MCP_ENDPOINT` -- a test points this at a loopback fixture. */
  endpoint?: string;
  state?: ExaBackendState;
  now?: () => number;
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  connect?: typeof connectMcpServer;
  callTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxResultChars?: number;
}

export interface ExaSearchClient {
  search(params: ExaSearchParams, opts?: { signal?: AbortSignal }): Promise<ExaSearchResult>;
  /** Closes both tiers' connections. Idempotent; never throws. */
  close(): Promise<void>;
}

/** The lazy key resolver for a session: `web.search.authRef` through the session's tool-secret resolver. */
export function exaKeyResolverFor(runtime: Pick<WebSessionRuntime, "web" | "resolveToolSecret">): (() => Promise<ToolSecretResult>) | undefined {
  const ref = runtime.web.search.authRef;
  const resolve = runtime.resolveToolSecret;
  if (ref === undefined || resolve === undefined) return undefined;
  return () => resolve(ref);
}

// --- classification of THIS runtime's MCP client errors --------------------------------------------

// WORDS ARE THE FALLBACK, and deliberately narrow: opening the breaker is PROCESS-WIDE and locks a
// keyless user out for the whole cooldown, so a loose match is expensive. No bare `429` / `quota`
// (either can sit inside an echoed query), only phrases a server uses ABOUT ITSELF. The HTTP status,
// when there is one, is read first and decides on its own.
const RATE_LIMIT_PATTERN = EXA_RATE_LIMIT_PATTERN;
const AUTH_PATTERN = EXA_AUTH_PATTERN;
const UNREACHABLE_PATTERN = EXA_UNREACHABLE_PATTERN;

type Classified = "rate-limited" | "auth" | "timeout" | "other";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The HTTP status an error carries, wherever this MCP SDK put it. A handshake failure arrives wrapped
 * as `McpConnectError`, whose `code` is a category and whose status rides `httpStatus`. A mid-session
 * failure is the transport's own error: on the MCP TS SDK v2 (WS-23) that is an `SdkHttpError`,
 * whose status is `.status` -- its `.code` is now a STRING (`SdkErrorCode`), where v1's
 * `StreamableHTTPError.code` WAS the status, which is exactly the field this file used to read. The
 * legacy SSE client's `SseError` still carries the status as a numeric `.code`.
 */
function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof McpConnectError) return err.httpStatus;
  if (err instanceof SdkHttpError) return err.status;
  if (err instanceof SseError && typeof err.code === "number") return err.code;
  return undefined;
}

function classifyError(err: unknown): Classified {
  // The STATUS first, the words second. The message holds only the response BODY, so a rate limit
  // answered with an empty or unexpected body is recognisable by status alone.
  const status = httpStatusOf(err);
  if (status === 429 || status === 402) return "rate-limited";
  if (status === 401 || status === 403) return "auth";
  if (err instanceof McpConnectError && err.code === "needs_auth") return "auth";
  if (err instanceof McpConnectError && err.code === "timeout") return "timeout";
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return "timeout";
  const text = errorText(err);
  if (RATE_LIMIT_PATTERN.test(text)) return "rate-limited";
  if (AUTH_PATTERN.test(text)) return "auth";
  if (/timed? ?out|timeout/i.test(text)) return "timeout";
  return "other";
}

/**
 * Did the CALL ITSELF fail to reach an answer -- a dropped session, a closed socket -- so that a
 * reconnect-and-retry costs nothing? Anything the backend ANSWERED is final: a JSON-RPC error and an
 * HTTP 5xx may both follow a search that already ran and already counted against the allowance.
 *
 * Read per error family (WS-23, MCP TS SDK v2 -- v1 let one numeric `code` answer all of this):
 *   - an HTTP answer (`SdkHttpError`/`SseError`): only 404 -- "session not found" -- means the
 *     session is gone;
 *   - an error the SDK raised LOCALLY (`SdkError`, string code): only a closed or unsendable
 *     connection is a transport failure (v1 spelled this as the JSON-RPC-shaped `-32000`);
 *   - a JSON-RPC error the server sent (`ProtocolError`, numeric code): the backend answered -- final;
 *   - anything else WITHOUT a numeric code is a socket-level failure: `fetch failed` has none, and
 *     Bun's own fetch errors carry a STRING code (`ConnectionRefused`, `ECONNRESET`) -- exactly v1's
 *     `typeof code !== "number"` reading, kept.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof McpConnectError) return false;
  const status = httpStatusOf(err);
  if (status !== undefined) return status === 404;
  if (err instanceof SdkError) return err.code === SdkErrorCode.ConnectionClosed || err.code === SdkErrorCode.SendFailed || err.code === SdkErrorCode.NotConnected;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code !== "number";
}

// --- the transport ----------------------------------------------------------------------------------

/**
 * Winter's transport for the shared client: this runtime's own MCP client. `versionNegotiation:
 * "legacy"` -- deliberately NOT the http default (`"auto"`, mcp/client.ts): an `auto` probe is one
 * extra POST per connect, and on the anonymous tier every POST is spent against a rate limit the
 * client is built to conserve. The always-declining elicitation asker: a search backend has no
 * business eliciting input from the user. The KEYED connection never follows a redirect: fetch strips
 * only `Authorization` across origins, so `x-api-key` would be replayed to wherever the endpoint pointed.
 */
function mcpClientTransport(connect: typeof connectMcpServer): ExaTransport {
  return {
    async connect(request): Promise<ExaConnection> {
      const config: McpServerConfigForProcessTransport = { type: "http", url: request.url, versionNegotiation: "legacy", ...(Object.keys(request.headers).length > 0 ? { headers: { ...request.headers } } : {}) };
      const connection = await connect({
        name: MCP_SERVER_NAME,
        config,
        connectTimeoutMs: request.connectTimeoutMs,
        elicitationAsk: createElicitationAsker(undefined),
        ...(request.refuseRedirects ? { refuseHttpRedirects: true } : {}),
      });
      return {
        callTool: (name, args, options) => connection.callTool(name, args, options),
        close: () => connection.close(),
      };
    },
    classify(err) {
      const kind = classifyError(err);
      return { kind, unreachable: err instanceof McpConnectError || UNREACHABLE_PATTERN.test(errorText(err)), transport: isTransportFailure(err) };
    },
  };
}

const FAILURE_CODES: Record<WebExaSearchFailureCode, ExaSearchFailureCode> = {
  quota_exhausted: "quota-exhausted",
  key_unreadable: "key-unreadable",
  rate_limited: "key-rate-limited",
  key_rejected: "key-rejected",
  blocked_domains: "blocked-domains",
  timeout: "timeout",
  aborted: "aborted",
  unavailable: "unreachable",
  backend_error: "backend-error",
};

function hitFrom(item: ExaSearchResultItem): ExaSearchHit {
  const favicon = siteIconHttpsUrl(item.favicon);
  return { title: item.title, url: item.url, highlight: item.text, ...(item.publishedDate !== undefined ? { publishedDate: item.publishedDate } : {}), ...(favicon !== undefined ? { favicon } : {}) };
}

/**
 * Search hits out of one payload's text. Tolerant by design: JSON with a `results` array (the
 * advanced tool), else `Title:`/`URL:` records (the basic tool), else NO hits -- never a throw. A
 * result with no URL is dropped (there is nothing to link to); one with no title uses its URL.
 */
export function parseExaHits(text: string): ExaSearchHit[] {
  return parseExaResults(text).map(hitFrom);
}

export function createExaSearchClient(options: ExaSearchClientOptions = {}): ExaSearchClient {
  const { connect, resolveKey, ...rest } = options;
  const client = createWebExaSearchClient({
    ...rest,
    transport: mcpClientTransport(connect ?? connectMcpServer),
    ...(resolveKey !== undefined ? { resolveKey: async () => (await resolveKey()) ?? { status: "missing" as const } } : {}),
  });
  return {
    async search(params, opts = {}): Promise<ExaSearchResult> {
      const result = await client.search(params, opts);
      if (!result.ok) return { ok: false, code: FAILURE_CODES[result.code], message: result.message };
      return { ok: true, hits: result.results.map(hitFrom), tier: result.tier, tool: result.tool, rawText: result.rawText, truncated: result.truncated };
    },
    close: () => client.close(),
  };
}
