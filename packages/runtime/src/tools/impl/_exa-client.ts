// THE SEARCH BACKEND CLIENT -- Exa's hosted MCP server over Streamable HTTP -- in a module that
// REGISTERS NOTHING. `impl/web-search.ts` drives it; nothing here is a tool.
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
import type { McpServerConfigForProcessTransport } from "@yanlinglabs/winter-agent-sdk";
import { connectMcpServer, McpConnectError, type ConnectedMcpClient, type McpToolCallResult } from "../../mcp/client.ts";
import { createElicitationAsker } from "../../mcp/elicitation.ts";
import type { ToolSecretResult } from "../../provider/tool-secret.ts";
import type { WebSessionRuntime } from "../../web/session-runtime.ts";
import { backendExcludableDomains, isDomainBlocked, mergeDomainLists } from "./_domains.ts";

// --- named constants ------------------------------------------------------------------------------

export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
export const EXA_SEARCH_TOOL = "web_search_exa";
export const EXA_ADVANCED_SEARCH_TOOL = "web_search_advanced_exa";
/** The only two tools this client asks the server to expose (the endpoint's `tools=` selector). */
export const EXA_ENABLED_TOOLS: readonly string[] = [EXA_SEARCH_TOOL, EXA_ADVANCED_SEARCH_TOOL];
export const EXA_API_KEY_HEADER = "x-api-key";
/** How long the anonymous tier is skipped after it answers rate-limited, before it is re-probed. See the header. */
export const EXA_ANONYMOUS_COOLDOWN_MS = 10 * 60_000;
/** The anonymous tier allows 2 calls per second; call STARTS are spaced at least this far apart, process-wide. */
export const EXA_ANONYMOUS_MIN_INTERVAL_MS = 500;
export const EXA_CONNECT_TIMEOUT_MS = 10_000;
export const EXA_CALL_TIMEOUT_MS = 25_000;
export const EXA_DEFAULT_NUM_RESULTS = 8;
/** The ceiling on `numResults`, and on the hits handed on. Each hit is capped; without this the COUNT was not. */
export const EXA_MAX_NUM_RESULTS = 20;
export const EXA_TITLE_MAX_CHARACTERS = 300;
/** A hit with a longer URL is DROPPED, never truncated -- a cut URL is a different, wrong URL. */
export const EXA_URL_MAX_CHARACTERS = 2_000;
/** Per-result highlight budget asked of the server, and enforced again on what comes back. */
export const EXA_HIGHLIGHTS_MAX_CHARACTERS = 1_200;
/** The advanced tool returns the whole page as `text` unless told otherwise; highlights are what is used. */
export const EXA_TEXT_MAX_CHARACTERS = 300;
/** The cap on one search's raw text, applied before parsing results are handed on. */
export const EXA_MAX_RESULT_CHARS = 40_000;
const MCP_SERVER_NAME = "exa";

// --- shapes ---------------------------------------------------------------------------------------

export interface ExaSearchHit {
  title: string;
  url: string;
  /** The result's highlight text, capped at `EXA_HIGHLIGHTS_MAX_CHARACTERS`. Empty when the backend sent none. */
  highlight: string;
  publishedDate?: string;
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

export type ExaTier = "anonymous" | "key";

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

/**
 * The anonymous tier's breaker and pacer. PROCESS-WIDE by default (`sharedExaBackendState`): the
 * allowance is per network address, so every session in this process shares one. A test passes its own.
 */
export interface ExaBackendState {
  /** When the anonymous tier last answered rate-limited; `undefined` while it is believed usable. */
  anonymousRateLimitedAt?: number;
  /** WHY it was last refused -- so a keyless caller is told the truth (an auth refusal is not an exhausted quota). Absent reads as `rate-limited`. */
  anonymousRefusal?: "rate-limited" | "auth";
  /** The earliest time the next anonymous call may START (pacing). */
  nextAnonymousCallAt: number;
  /** How many callers are asleep in the pacer RIGHT NOW -- what tells a deep queue from a clock step. Absent reads as 0. */
  anonymousWaiting?: number;
}

export function createExaBackendState(): ExaBackendState {
  return { nextAnonymousCallAt: 0 };
}

export const sharedExaBackendState: ExaBackendState = createExaBackendState();

/** True while the anonymous tier is being skipped. After the cooldown it reads `false`, and the next call is the re-probe. */
export function anonymousBreakerOpen(state: ExaBackendState, now: number): boolean {
  if (state.anonymousRateLimitedAt === undefined) return false;
  // A wall clock can step BACKWARDS (NTP, a manual change). Unclamped, the stamp would then sit in the
  // future and hold the breaker open for the cooldown PLUS the size of the step. Re-stamping to `now`
  // bounds the damage at one cooldown from the moment the step is noticed.
  if (now < state.anonymousRateLimitedAt) state.anonymousRateLimitedAt = now;
  return now - state.anonymousRateLimitedAt < EXA_ANONYMOUS_COOLDOWN_MS;
}

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

// --- classification -------------------------------------------------------------------------------

// WORDS ARE THE FALLBACK, and deliberately narrow: opening the breaker is PROCESS-WIDE and locks a
// keyless user out for the whole cooldown, so a loose match is expensive. No bare `429` / `quota`
// (either can sit inside an echoed query), only phrases a server uses ABOUT ITSELF. The HTTP status,
// when there is one, is read first and decides on its own.
const RATE_LIMIT_PATTERN = /rate.?limit(?:ed| exceeded| reached)?\b|too many requests|quota (?:exceeded|exhausted|reached)|credits? (?:exhausted|exceeded)|free tier/i;
const AUTH_PATTERN = /unauthori[sz]ed|forbidden|invalid api.?key|api.?key (?:is )?(?:invalid|required|missing)/i;
const UNREACHABLE_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|unable to connect|network/i;

type Classified = "rate-limited" | "auth" | "timeout" | "other";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classifyError(err: unknown): Classified {
  // The STATUS first, the words second. A mid-session failure is the transport's own error, whose
  // `code` IS the HTTP status; a handshake failure arrives wrapped as `McpConnectError`, whose `code`
  // is a category and whose status rides `httpStatus`. The message holds only the response BODY, so
  // a rate limit answered with an empty or unexpected body is recognisable by status alone.
  const code = err instanceof McpConnectError ? err.httpStatus : (err as { code?: unknown } | null)?.code;
  if (code === 429 || code === 402) return "rate-limited";
  if (code === 401 || code === 403) return "auth";
  if (err instanceof McpConnectError && err.code === "needs_auth") return "auth";
  if (err instanceof McpConnectError && err.code === "timeout") return "timeout";
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
 * Read off `code`, which both error families carry as a number: the transport's is the HTTP STATUS
 * (only 404 -- "session not found" -- means the session is gone), the protocol's is a JSON-RPC code
 * (only -32000, connection closed, is a transport failure). An error with no numeric code at all is a
 * socket-level failure.
 */
function isTransportFailure(err: unknown): boolean {
  if (err instanceof McpConnectError) return false;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "number") return true;
  return code === 404 || code === -32000;
}

/**
 * An argument shorter than this is never treated as an echo. Removing a SHORT argument shreds the
 * backend's own words instead of the caller's: with the query `e`, "Rate limit exceeded" reads
 * "Rat  limit  xc  d d", the detector answers `backend-error`, the breaker stays shut and the key
 * fallback never happens. Six clears every word the two patterns are built from that a query could
 * plausibly BE (`limit`, `quota`, `rate`, `free`, `tier`, `key`).
 */
const ECHO_MIN_LENGTH = 6;

/**
 * `text` with the request's own string arguments removed, so a backend ECHOING the query cannot trip a
 * pattern meant for the backend's own words. CASE-INSENSITIVE (a backend may re-case what it echoes),
 * and the argument is matched as TEXT -- escaped, never compiled as the caller's own pattern.
 */
function withoutEchoes(text: string, args: Record<string, unknown>): string {
  let out = text;
  for (const value of Object.values(args)) {
    if (typeof value !== "string" || value.length < ECHO_MIN_LENGTH) continue;
    out = out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  return out;
}

function resultText(result: McpToolCallResult): string {
  return result.content
    .map((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

// --- parsing --------------------------------------------------------------------------------------

function capText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function highlightFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").join("\n...\n");
  return "";
}

/** What may be handed on as a link: http(s) only (never `javascript:`/`data:`), and not absurdly long. Applied on BOTH parsing paths. */
function isLinkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= EXA_URL_MAX_CHARACTERS;
}

function hitFromRecord(record: Record<string, unknown>): ExaSearchHit | undefined {
  const url = [record["url"], record["id"]].map((v) => (typeof v === "string" ? v.trim() : "")).find(isLinkableUrl);
  if (url === undefined) return undefined;
  const title = capText(typeof record["title"] === "string" && record["title"].trim().length > 0 ? record["title"].trim() : url, EXA_TITLE_MAX_CHARACTERS);
  // Highlights are what was asked for; `summary` and the (capped) page `text` are what is left when the backend sent none.
  const highlight = highlightFrom(record["highlights"]) || highlightFrom(record["summary"]) || highlightFrom(record["text"]);
  const published = typeof record["publishedDate"] === "string" && record["publishedDate"].length > 0 ? record["publishedDate"] : undefined;
  return { title, url, highlight: capText(highlight.trim(), EXA_HIGHLIGHTS_MAX_CHARACTERS), ...(published !== undefined ? { publishedDate: published } : {}) };
}

const FIELD_LINE = /^(Title|URL|Published(?: Date)?|Author|Highlights|Text|Summary|Content):[ \t]*(.*)$/i;

function hitsFromPlainText(text: string): ExaSearchHit[] {
  const hits: ExaSearchHit[] = [];
  for (const block of text.split(/\n[ \t]*-{3,}[ \t]*\n/)) {
    let title: string | undefined;
    let url: string | undefined;
    let published: string | undefined;
    let body: string[] | undefined;
    for (const line of block.split("\n")) {
      const field = body === undefined ? FIELD_LINE.exec(line) : null;
      if (field === null) {
        body?.push(line);
        continue;
      }
      const name = field[1]!.toLowerCase();
      const value = field[2]!.trim();
      if (name === "title") title = value;
      else if (name === "url") url = value;
      else if (name.startsWith("published")) published = value;
      else if (name !== "author") body = value.length > 0 ? [value] : [];
    }
    if (url === undefined || !isLinkableUrl(url)) continue;
    hits.push({
      title: capText(title !== undefined && title.length > 0 ? title : url, EXA_TITLE_MAX_CHARACTERS),
      url,
      highlight: capText((body ?? []).join("\n").trim(), EXA_HIGHLIGHTS_MAX_CHARACTERS),
      ...(published !== undefined && published.length > 0 && published.toUpperCase() !== "N/A" ? { publishedDate: published } : {}),
    });
  }
  return hits;
}

/**
 * Search hits out of one payload's text. Tolerant by design: JSON with a `results` array (the
 * advanced tool), else `Title:`/`URL:` records (the basic tool), else NO hits -- never a throw. A
 * result with no URL is dropped (there is nothing to link to); one with no title uses its URL.
 */
export function parseExaHits(text: string): ExaSearchHit[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const results = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? (parsed as { results?: unknown }).results : undefined;
      if (Array.isArray(results)) {
        return results.flatMap((r) => {
          const hit = typeof r === "object" && r !== null ? hitFromRecord(r as Record<string, unknown>) : undefined;
          return hit !== undefined ? [hit] : [];
        });
      }
    } catch {
      /* a truncated or non-JSON payload: fall through to the text form */
    }
  }
  return hitsFromPlainText(trimmed);
}

// --- the client -----------------------------------------------------------------------------------

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/** The endpoint with its `tools=` selector. Built by hand so the comma list is sent exactly as documented, and so NOTHING else -- least of all a key -- can ride the query string. */
export function exaEndpointUrl(endpoint: string = EXA_MCP_ENDPOINT): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}tools=${EXA_ENABLED_TOOLS.join(",")}`;
}

type CallOutcome =
  | { kind: "ok"; result: McpToolCallResult }
  | { kind: "rate-limited"; detail: string }
  | { kind: "auth"; detail: string }
  | { kind: "timeout"; afterMs: number }
  | { kind: "aborted" }
  /**
   * `transport: true` -- the CALL ITSELF threw (a dropped session, a closed socket): nothing was
   * searched, so one reconnect-and-retry is free. `transport: false` -- the backend ANSWERED, with an
   * error result: that search already counted against the allowance, and asking again would spend a
   * second one to be told the same thing.
   */
  | { kind: "failed"; detail: string; unreachable: boolean; transport: boolean };

export function createExaSearchClient(options: ExaSearchClientOptions = {}): ExaSearchClient {
  const state = options.state ?? sharedExaBackendState;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const connect = options.connect ?? connectMcpServer;
  const callTimeoutMs = options.callTimeoutMs ?? EXA_CALL_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? EXA_CONNECT_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? EXA_MAX_RESULT_CHARS;
  const floor = mergeDomainLists(options.blockedDomains);
  const url = exaEndpointUrl(options.endpoint);

  const connections: Partial<Record<ExaTier, ConnectedMcpClient>> = {};
  // SINGLE-FLIGHT: two concurrent first searches share ONE connect. Without it each opened its own
  // session, the second overwrote the first in `connections`, and the first was never closed.
  const connecting: Partial<Record<ExaTier, Promise<ConnectedMcpClient>>> = {};
  // Only a FOUND key is kept (see the header): a `missing`/`unreadable` answer is asked again next time.
  let foundKey: string | undefined;
  let closed = false;

  const drop = async (tier: ExaTier): Promise<void> => {
    const connection = connections[tier];
    delete connections[tier];
    if (connection !== undefined) await connection.close().catch(() => {});
  };

  const connectionFor = (tier: ExaTier, apiKey: string | undefined): Promise<ConnectedMcpClient> => {
    const existing = connections[tier];
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = connecting[tier];
    if (pending !== undefined) return pending;
    const config: McpServerConfigForProcessTransport = { type: "http", url, ...(tier === "key" && apiKey !== undefined ? { headers: { [EXA_API_KEY_HEADER]: apiKey } } : {}) };
    const started = (async (): Promise<ConnectedMcpClient> => {
      const connection = await connect({
        name: MCP_SERVER_NAME,
        config,
        connectTimeoutMs,
        // The always-declining asker: a search backend has no business eliciting input from the user.
        elicitationAsk: createElicitationAsker(undefined),
        // The KEYED connection never follows a redirect: fetch strips only `Authorization` across
        // origins, so `x-api-key` would be replayed to wherever the endpoint pointed.
        ...(tier === "key" ? { refuseHttpRedirects: true } : {}),
      });
      if (closed) {
        await connection.close().catch(() => {});
        throw new Error("the search client was closed while connecting");
      }
      connections[tier] = connection;
      return connection;
    })();
    connecting[tier] = started;
    const clear = (): void => {
      if (connecting[tier] === started) delete connecting[tier];
    };
    started.then(clear, clear);
    return started;
  };

  /** ONE attempt on one tier: connect if needed, call, race the call against our own timer and the abort signal. */
  const attempt = async (tier: ExaTier, apiKey: string | undefined, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallOutcome> => {
    // A FUNCTION, not an inline read: `aborted` flips asynchronously, and TypeScript narrows an inline
    // property read across awaits as if it could not.
    const isAborted = (): boolean => signal?.aborted === true;
    // What a failure may quote of the backend's own words: short, and with the key scrubbed in case a
    // server ever echoes the credential it was sent.
    const detailOf = (text: string): string => capText(apiKey !== undefined && apiKey.length > 0 ? text.split(apiKey).join("***") : text, 300);
    if (isAborted()) return { kind: "aborted" };
    // THE BOUND ACTUALLY APPLIED: the call's own, plus the connect's when there is no connection yet.
    // It is what the timeout MESSAGE reports -- a message naming the call bound alone understated a
    // cold search's real wait by the whole connect timeout.
    const boundMs = callTimeoutMs + (connections[tier] === undefined ? connectTimeoutMs : 0);
    // Set when the caller stopped waiting. The work below may still be mid-CONNECT at that moment; when
    // the connect lands it must NOT go on to run the search -- that would spend a real query, against
    // a small allowance, for a caller that has already been told "timed out" or "interrupted".
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundMs);
      if (signal !== undefined) {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const work = (async (): Promise<CallOutcome> => {
        const connection = await connectionFor(tier, apiKey);
        if (abandoned) return { kind: "aborted" };
        const result = await connection.callTool(tool, args, { timeoutMs: callTimeoutMs });
        if (result.isError === true) {
          const text = resultText(result);
          // Read with the caller's OWN words removed: a backend that echoes the query back ("no
          // results for ...") must not open a process-wide breaker because the user asked about
          // rate limits.
          const about = withoutEchoes(text, args);
          if (RATE_LIMIT_PATTERN.test(about)) return { kind: "rate-limited", detail: detailOf(text) };
          if (AUTH_PATTERN.test(about)) return { kind: "auth", detail: detailOf(text) };
          return { kind: "failed", detail: detailOf(text), unreachable: false, transport: false };
        }
        return { kind: "ok", result };
      })();
      // The losing side of the race is abandoned; its later rejection must not surface as unhandled.
      work.catch(() => {});
      const settled = await Promise.race([work, interrupted]);
      if (settled === "timeout" || settled === "aborted") {
        abandoned = true;
        // `callTool` takes no signal, so the only way to stop the in-flight request is to close its connection.
        await drop(tier);
        return settled === "timeout" ? { kind: "timeout", afterMs: boundMs } : { kind: "aborted" };
      }
      return settled;
    } catch (err) {
      if (isAborted()) return { kind: "aborted" };
      const classified = classifyError(err);
      // A connection that produced an error is not reused: the next attempt reconnects.
      await drop(tier);
      if (classified === "rate-limited") return { kind: "rate-limited", detail: detailOf(errorText(err)) };
      if (classified === "auth") return { kind: "auth", detail: detailOf(errorText(err)) };
      if (classified === "timeout") return { kind: "timeout", afterMs: boundMs };
      return { kind: "failed", detail: detailOf(errorText(err)), unreachable: err instanceof McpConnectError || UNREACHABLE_PATTERN.test(errorText(err)), transport: isTransportFailure(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  };

  /** One tier, with ONE reconnect-and-retry when an ESTABLISHED session was dropped under it. */
  const callTier = async (tier: ExaTier, apiKey: string | undefined, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallOutcome> => {
    const hadConnection = connections[tier] !== undefined;
    const first = await attempt(tier, apiKey, tool, args, signal);
    // ONLY a transport failure on a connection that already existed. A fresh connection that failed
    // has nothing stale to replace, and an error the backend ANSWERED with is final (see `CallOutcome`).
    if (first.kind !== "failed" || !first.transport || !hadConnection) return first;
    // `attempt` already dropped the dead connection; this one reconnects from scratch.
    return attempt(tier, apiKey, tool, args, signal);
  };

  // THE PACER. Each caller RESERVES the next start slot synchronously and then sleeps until it, so N
  // callers queued at one instant start one interval apart however deep the queue is.
  //
  // A reservation can legitimately sit at most `(waiting + 1)` intervals ahead of now: one slot per
  // caller still asleep, plus the one handed out last. Anything FURTHER out is not a queue -- it is a
  // wall clock that stepped backwards under the reservation -- and only that is re-based (behind the
  // callers still asleep, so they keep their spacing). The bound is the queue's REAL depth, never a
  // fixed ceiling: a fixed one ("over 32 s is absurd") is also true of the 65th genuinely queued
  // caller, which it would wave through unpaced -- a burst against a two-per-second allowance.
  const pace = async (signal: AbortSignal | undefined): Promise<void> => {
    const at = now();
    const waiting = state.anonymousWaiting ?? 0;
    const steppedBack = state.nextAnonymousCallAt > at + (waiting + 1) * EXA_ANONYMOUS_MIN_INTERVAL_MS;
    const start = steppedBack ? at + waiting * EXA_ANONYMOUS_MIN_INTERVAL_MS : Math.max(at, state.nextAnonymousCallAt);
    state.nextAnonymousCallAt = start + EXA_ANONYMOUS_MIN_INTERVAL_MS;
    const wait = start - at;
    if (wait <= 0) return;
    state.anonymousWaiting = waiting + 1;
    try {
      await sleep(wait, signal);
    } finally {
      state.anonymousWaiting = Math.max(0, (state.anonymousWaiting ?? 1) - 1);
    }
  };

  const failureFrom = (outcome: Exclude<CallOutcome, { kind: "ok" } | { kind: "rate-limited" } | { kind: "auth" }>): ExaSearchResult => {
    if (outcome.kind === "timeout") return { ok: false, code: "timeout", message: `the search backend did not answer within ${Math.max(1, Math.round(outcome.afterMs / 1000))} seconds` };
    if (outcome.kind === "aborted") return { ok: false, code: "aborted", message: "the search was interrupted" };
    return outcome.unreachable
      ? { ok: false, code: "unreachable", message: `the search backend could not be reached: ${outcome.detail}` }
      : { ok: false, code: "backend-error", message: `the search backend reported an error: ${outcome.detail}` };
  };

  return {
    async search(params, opts = {}): Promise<ExaSearchResult> {
      const signal = opts.signal;
      if (closed) return { ok: false, code: "backend-error", message: "the search client has been closed" };
      if (signal?.aborted === true) return { ok: false, code: "aborted", message: "the search was interrupted" };

      // --- the request --------------------------------------------------------------------------
      //
      // The host's floor rides EVERY search. With an allow-list the backend takes `includeDomains`
      // alone (the two filters are mutually exclusive at the tool's surface), so the floor is
      // applied to the allow-list itself -- an allowed domain the host blocks is not searched --
      // and, in every case, again to the hits below.
      const include = mergeDomainLists(params.includeDomains).filter((domain) => !isDomainBlocked(domain, floor));
      if ((params.includeDomains?.length ?? 0) > 0 && include.length === 0) {
        return { ok: false, code: "blocked-domains", message: "every domain in the allow-list is blocked by this host's configuration, so there is nothing that may be searched" };
      }
      // TWO lists, on purpose. `localExclude` is everything that must not come back, applied to the
      // hits below under `_domains.ts`'s own rule. `exclude` is the part of it that may be handed to
      // the BACKEND's filter: multi-label names only -- how the backend matches an IP or a single
      // label (`com`) is unknown, and a suffix reading would over-block silently.
      const localExclude = mergeDomainLists(floor, params.excludeDomains);
      const exclude = include.length > 0 ? [] : backendExcludableDomains(localExclude);
      // CLAMPED, and total: each hit is capped, so without a ceiling on the COUNT a caller (the inner
      // model picks this) could still pull a thousand capped hits; `NaN` would serialise to `null`.
      const requested = typeof params.numResults === "number" && Number.isFinite(params.numResults) ? Math.floor(params.numResults) : EXA_DEFAULT_NUM_RESULTS;
      const numResults = Math.min(EXA_MAX_NUM_RESULTS, Math.max(1, requested));
      const filtered = include.length > 0 || exclude.length > 0;
      const tool = filtered ? EXA_ADVANCED_SEARCH_TOOL : EXA_SEARCH_TOOL;
      const args: Record<string, unknown> = filtered
        ? {
            query: params.query,
            numResults,
            enableHighlights: true,
            highlightsMaxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS,
            textMaxCharacters: EXA_TEXT_MAX_CHARACTERS,
            ...(include.length > 0 ? { includeDomains: include } : { excludeDomains: exclude }),
          }
        : { query: params.query, objective: params.objective !== undefined && params.objective.trim().length > 0 ? params.objective : params.query, numResults };

      const succeed = (tier: ExaTier, result: McpToolCallResult): ExaSearchResult => {
        const full = resultText(result);
        // Parsed from the FULL text (a JSON payload cut mid-way would not parse at all), capped for
        // what is handed on; each hit's own highlight is already capped.
        // Sliced to what was ASKED FOR: a backend that ignores `numResults` cannot widen the bound.
        const hits = parseExaHits(full).filter((hit) => !isDomainBlocked(hit.url, localExclude)).slice(0, numResults);
        return { ok: true, hits, tier, tool, rawText: capText(full, maxResultChars), truncated: full.length > maxResultChars };
      };

      // --- anonymous first ----------------------------------------------------------------------
      let anonymousDetail: string | undefined;
      if (!anonymousBreakerOpen(state, now())) {
        await pace(signal);
        const outcome = await callTier("anonymous", undefined, tool, args, signal);
        if (outcome.kind === "ok") {
          delete state.anonymousRateLimitedAt;
          delete state.anonymousRefusal;
          return succeed("anonymous", outcome.result);
        }
        if (outcome.kind !== "rate-limited" && outcome.kind !== "auth") return failureFrom(outcome);
        // Rate-limited (or the anonymous tier now demands a credential): OPEN the breaker and fall to the key.
        state.anonymousRateLimitedAt = now();
        state.anonymousRefusal = outcome.kind;
        anonymousDetail = outcome.detail;
      }

      // --- the key, as fallback -----------------------------------------------------------------
      let secret: ToolSecretResult;
      if (foundKey !== undefined) {
        secret = { status: "found", key: foundKey };
      } else {
        try {
          secret = (await options.resolveKey?.()) ?? { status: "missing" };
        } catch (err) {
          // A custom resolver that REJECTS must not throw out of `search()`. Its NAME only.
          secret = { status: "unreadable", code: "io", message: `the key resolver failed with ${err instanceof Error ? err.name : "an unknown error"}` };
        }
        if (secret.status === "found") foundKey = secret.key;
      }
      if (secret.status !== "found") {
        const retryMinutes = Math.max(1, Math.ceil((EXA_ANONYMOUS_COOLDOWN_MS - (now() - (state.anonymousRateLimitedAt ?? now()))) / 60_000));
        const why = state.anonymousRefusal === "auth" ? "The web search backend refused anonymous access" : "The free web search quota is exhausted";
        const exhausted = `${why}${anonymousDetail !== undefined && anonymousDetail.length > 0 ? ` (${anonymousDetail})` : ""}; the free tier will be tried again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`;
        return secret.status === "missing"
          ? { ok: false, code: "quota-exhausted", message: `${exhausted} No search API key is configured -- add an Exa API key to keep searching without waiting.` }
          : { ok: false, code: "key-unreadable", message: `${exhausted} A search API key is configured but could not be used: ${secret.message}` };
      }
      const outcome = await callTier("key", secret.key, tool, args, signal);
      if (outcome.kind === "ok") return succeed("key", outcome.result);
      if (outcome.kind === "rate-limited") return { ok: false, code: "key-rate-limited", message: `the search backend rate-limited or refused the configured API key for lack of quota: ${outcome.detail}` };
      if (outcome.kind === "auth") return { ok: false, code: "key-rejected", message: `the search backend rejected the configured API key: ${outcome.detail}` };
      return failureFrom(outcome);
    },

    async close(): Promise<void> {
      closed = true;
      await Promise.all([drop("anonymous"), drop("key")]);
    },
  };
}
