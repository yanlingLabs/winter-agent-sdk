// THE EXA SEARCH CLIENT -- Exa's hosted MCP server (`https://mcp.exa.ai/mcp`), reached over a
// pluggable transport (`ExaTransport`; the default is this package's own Streamable HTTP client,
// `exa-mcp-http.ts`).
//
// ANONYMOUS FIRST, THE KEY AS FALLBACK. The anonymous tier is free and needs no credential, so it is
// tried first; the key is asked for (`resolveKey`) only once the anonymous tier answers rate-limited
// or refuses anonymous access. The key travels in the `x-api-key` HEADER and NEVER in the URL; it is
// scrubbed from every backend text this client quotes, and never appears in a result or an error.
// The keyed connection never follows a redirect (a redirect would replay the header elsewhere).
//
// THE CIRCUIT BREAKER. Once the anonymous tier answers rate-limited, every call sharing the same
// `ExaBackendState` goes straight to the key for `EXA_ANONYMOUS_COOLDOWN_MS`, then the next call
// RE-PROBES the anonymous tier. With no key and the breaker open the answer is a typed
// `quota_exhausted` result -- without touching the network.
//
// THE PACER. Anonymous call STARTS are spaced `EXA_ANONYMOUS_MIN_INTERVAL_MS` apart across every
// client sharing the state: each caller reserves the next slot synchronously and sleeps until it.
//
// STATE. `ExaBackendState` holds the breaker and the pacer and no credential. By default every client
// in the process shares `sharedExaBackendState` (the anonymous allowance is per network address); a
// host passes its own to scope it. A client caches a FOUND key for its lifetime (every resolution may
// be a keychain prompt); a missing or unreadable key is asked again next time.
//
// LIVE SCHEMA (server `exa-search-server` 3.2.1, probed 2026-09-18):
//   `web_search_exa`           requires `query` AND `objective`; optional `numResults`. No domain filter.
//   `web_search_advanced_exa`  requires `query`; accepts `numResults`, `type`, `includeDomains`,
//                              `excludeDomains`, `startPublishedDate`, `endPublishedDate` (ISO 8601;
//                              re-probed 2026-10-28), `enableHighlights`, `highlightsMaxCharacters`,
//                              `textMaxCharacters`, ...
// A domain filter or a published-date filter therefore selects the advanced tool.
// PAYLOADS -- one `text` content block each, in two shapes:
//   advanced: a JSON string `{ requestId, resolvedSearchType, results: [{ id, url, title,
//             publishedDate, image, text, highlights: string[] }], searchTime }`; `text` is the WHOLE
//             PAGE unless capped (one result measured 347,123 characters), so `textMaxCharacters` is
//             always sent and the text is capped again here.
//   basic:    plain-text records `Title:` / `URL:` / `Published:` / `Author:` / `Highlights:`,
//             separated by a line holding only `---`.
// `parseExaResults` reads both and is deliberately tolerant: the payload is a third party's, unversioned.
import { backendExcludableDomains, isDomainBlocked, mergeDomainLists, normalizeDomain } from "./domains.ts";
import { EXA_AUTH_PATTERN, EXA_RATE_LIMIT_PATTERN, type ExaErrorKind } from "./exa-classify.ts";
import { createExaMcpHttpTransport } from "./exa-mcp-http.ts";

export { classifyExaErrorText, EXA_AUTH_PATTERN, EXA_RATE_LIMIT_PATTERN, EXA_UNREACHABLE_PATTERN } from "./exa-classify.ts";

// --- named constants ------------------------------------------------------------------------------

export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
export const EXA_SEARCH_TOOL = "web_search_exa";
export const EXA_ADVANCED_SEARCH_TOOL = "web_search_advanced_exa";
/** The only two tools this client asks the server to expose (the endpoint's `tools=` selector). */
export const EXA_ENABLED_TOOLS: readonly string[] = [EXA_SEARCH_TOOL, EXA_ADVANCED_SEARCH_TOOL];
export const EXA_API_KEY_HEADER = "x-api-key";
/** How long the anonymous tier is skipped after it answers rate-limited, before it is re-probed. */
export const EXA_ANONYMOUS_COOLDOWN_MS = 10 * 60_000;
/** The anonymous tier allows 2 calls per second; call STARTS are spaced at least this far apart. */
export const EXA_ANONYMOUS_MIN_INTERVAL_MS = 500;
export const EXA_CONNECT_TIMEOUT_MS = 10_000;
export const EXA_CALL_TIMEOUT_MS = 25_000;
export const EXA_DEFAULT_NUM_RESULTS = 8;
/** The ceiling on `numResults`, and on the results handed on. */
export const EXA_MAX_NUM_RESULTS = 20;
export const EXA_TITLE_MAX_CHARACTERS = 300;
/** A result with a longer URL is DROPPED, never truncated -- a cut URL is a different, wrong URL. */
export const EXA_URL_MAX_CHARACTERS = 2_000;
/** Per-result highlight budget asked of the server, and enforced again on what comes back. */
export const EXA_HIGHLIGHTS_MAX_CHARACTERS = 1_200;
/** The advanced tool returns the whole page as `text` unless told otherwise; highlights are what is used. */
export const EXA_TEXT_MAX_CHARACTERS = 300;
/** The cap on one search's raw payload text as handed on. */
export const EXA_MAX_RESULT_CHARS = 40_000;
const FAVICON_MAX_CHARACTERS = 2048;
const DAY_MS = 86_400_000;

// --- shapes ---------------------------------------------------------------------------------------

export interface ExaSearchResultItem {
  url: string;
  title: string;
  publishedDate?: string;
  /** The best excerpt: the highlights joined, else the summary, else the (capped) page text. At most `EXA_HIGHLIGHTS_MAX_CHARACTERS`. Empty when the backend sent none. */
  text: string;
  /** The individual highlights, when the backend sent them, each capped. */
  highlights?: string[];
  /** The result's favicon when the backend sent an https one. */
  favicon?: string;
}

export interface ExaSearchParams {
  query: string;
  numResults?: number;
  /** Only these domains. Mutually exclusive with `excludeDomains` at Exa's surface; when both are given, `includeDomains` wins and `excludeDomains` is still applied to the results. */
  includeDomains?: readonly string[];
  excludeDomains?: readonly string[];
  /** `web_search_exa` REQUIRES one; defaults to the query itself. */
  objective?: string;
  /** Only results published on or after this date: `YYYY-MM-DD`, or any ISO 8601 date-time (sent as its UTC `toISOString()`). */
  startPublishedDate?: string;
  /** Only results published on or before this date; same forms as `startPublishedDate`. */
  endPublishedDate?: string;
  /** Only results published in the last N days (a positive number; fractions allowed). With `startPublishedDate` too, the LATER of the two starts applies. */
  recentDays?: number;
}

export type ExaTier = "anonymous" | "key";

/**
 *   `quota_exhausted`   the anonymous tier is exhausted/rate-limited (or refuses anonymous access) and NO key is configured.
 *   `key_unreadable`    ...and a key IS configured but `resolveKey` could not read it.
 *   `rate_limited`      the KEY tier answered rate-limited or out of credit.
 *   `key_rejected`      the key tier answered 401/403.
 *   `blocked_domains`   every `includeDomains` entry is on the client's `blockedDomains`: nothing may be searched.
 *   `timeout` / `aborted` / `unavailable` (the backend could not be reached) / `backend_error` (it answered with an error).
 */
export type ExaSearchFailureCode = "quota_exhausted" | "key_unreadable" | "rate_limited" | "key_rejected" | "blocked_domains" | "timeout" | "aborted" | "unavailable" | "backend_error";

export type ExaSearchResult =
  | { ok: true; results: ExaSearchResultItem[]; tier: ExaTier; tool: string; /** The payload's text, capped at `maxResultChars`. */ rawText: string; truncated: boolean }
  | { ok: false; code: ExaSearchFailureCode; message: string; /** For `quota_exhausted`/`key_unreadable`: when the anonymous tier will next be tried. */ retryAfterMs?: number };

/** The breaker and the pacer. Holds no credential. */
export interface ExaBackendState {
  /** When the anonymous tier last answered rate-limited; `undefined` while it is believed usable. */
  anonymousRateLimitedAt?: number;
  /** WHY it was last refused -- an auth refusal is not an exhausted quota. Absent reads as `rate-limited`. */
  anonymousRefusal?: "rate-limited" | "auth";
  /** The earliest time the next anonymous call may START. */
  nextAnonymousCallAt: number;
  /** How many callers are asleep in the pacer right now. Absent reads as 0. */
  anonymousWaiting?: number;
}

export function createExaBackendState(): ExaBackendState {
  return { nextAnonymousCallAt: 0 };
}

/** The process-wide default state. */
export const sharedExaBackendState: ExaBackendState = createExaBackendState();

/** True while the anonymous tier is being skipped. After the cooldown it reads `false`, and the next call is the re-probe. */
export function anonymousBreakerOpen(state: ExaBackendState, now: number): boolean {
  if (state.anonymousRateLimitedAt === undefined) return false;
  // A wall clock can step BACKWARDS; re-stamping to `now` bounds the damage at one cooldown.
  if (now < state.anonymousRateLimitedAt) state.anonymousRateLimitedAt = now;
  return now - state.anonymousRateLimitedAt < EXA_ANONYMOUS_COOLDOWN_MS;
}

/** What `resolveKey` may answer. A bare string is a found key; `undefined`/`null`/`""` is "no key configured". */
export type ExaKeyResolution = string | undefined | null | { status: "found"; key: string } | { status: "missing" } | { status: "unreadable"; message: string };

// --- the transport --------------------------------------------------------------------------------

/** One MCP tool result, as the transport hands it back. */
export interface ExaToolCallResult {
  content: unknown[];
  isError?: boolean;
}

export interface ExaConnection {
  callTool(name: string, args: Record<string, unknown>, options: { timeoutMs: number }): Promise<ExaToolCallResult>;
  /** Closes the session and aborts anything in flight on it. Never throws. */
  close(): Promise<void>;
}

export interface ExaConnectRequest {
  /** The endpoint with its `tools=` selector -- never carrying a credential. */
  url: string;
  tier: ExaTier;
  /** Request headers for every request on this connection (`x-api-key` for the key tier). */
  headers: Record<string, string>;
  connectTimeoutMs: number;
  /** True for the key tier: a redirect must fail the request, never be followed. */
  refuseRedirects: boolean;
}

/** How a transport error reads to the client. */
export interface ExaErrorClass {
  kind: ExaErrorKind;
  /** The backend was never reached (a connect failure). */
  unreachable: boolean;
  /** The CALL itself failed without an answer (a dropped session, a closed socket): one reconnect-and-retry is free. */
  transport: boolean;
}

export interface ExaTransport {
  connect(request: ExaConnectRequest): Promise<ExaConnection>;
  /** Classifies an error `connect` or `callTool` threw. */
  classify(error: unknown): ExaErrorClass;
}

// --- classification -------------------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An argument shorter than this is never treated as an echo (removing it would shred the backend's own words). */
const ECHO_MIN_LENGTH = 6;

/** Is `value`, taken WHOLE, nothing but one of the two patterns' own phrases? Such a value is never stripped as an echo. */
function isBareTriggerPhrase(value: string): boolean {
  const trimmed = value.trim();
  return new RegExp(`^(?:${EXA_RATE_LIMIT_PATTERN.source})$`, "i").test(trimmed) || new RegExp(`^(?:${EXA_AUTH_PATTERN.source})$`, "i").test(trimmed);
}

/** `text` with the request's own string arguments removed, so a backend ECHOING the query cannot trip a pattern meant for its own words. */
function withoutEchoes(text: string, args: Record<string, unknown>): string {
  let out = text;
  for (const value of Object.values(args)) {
    if (typeof value !== "string" || value.length < ECHO_MIN_LENGTH) continue;
    if (isBareTriggerPhrase(value)) continue;
    out = out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  return out;
}

function resultText(result: ExaToolCallResult): string {
  return (Array.isArray(result.content) ? result.content : [])
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

/** What may be handed on as a link: http(s) only (never `javascript:`/`data:`), and not absurdly long. */
function isLinkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= EXA_URL_MAX_CHARACTERS;
}

/** The backend's favicon value, unchanged, when it is an https URL without credentials. */
function faviconOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > FAVICON_MAX_CHARACTERS) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
  } catch {
    return undefined;
  }
  return value;
}

function itemFromRecord(record: Record<string, unknown>): ExaSearchResultItem | undefined {
  const url = [record["url"], record["id"]].map((v) => (typeof v === "string" ? v.trim() : "")).find(isLinkableUrl);
  if (url === undefined) return undefined;
  const title = capText(typeof record["title"] === "string" && record["title"].trim().length > 0 ? record["title"].trim() : url, EXA_TITLE_MAX_CHARACTERS);
  const text = highlightFrom(record["highlights"]) || highlightFrom(record["summary"]) || highlightFrom(record["text"]);
  const published = typeof record["publishedDate"] === "string" && record["publishedDate"].length > 0 ? record["publishedDate"] : undefined;
  const rawHighlights = record["highlights"];
  const highlights = Array.isArray(rawHighlights) ? rawHighlights.filter((v): v is string => typeof v === "string").map((h) => capText(h, EXA_HIGHLIGHTS_MAX_CHARACTERS)) : typeof rawHighlights === "string" ? [capText(rawHighlights, EXA_HIGHLIGHTS_MAX_CHARACTERS)] : undefined;
  const favicon = faviconOf(record["favicon"]);
  return {
    url,
    title,
    ...(published !== undefined ? { publishedDate: published } : {}),
    text: capText(text.trim(), EXA_HIGHLIGHTS_MAX_CHARACTERS),
    ...(highlights !== undefined && highlights.length > 0 ? { highlights } : {}),
    ...(favicon !== undefined ? { favicon } : {}),
  };
}

const FIELD_LINE = /^(Title|URL|Published(?: Date)?|Author|Highlights|Text|Summary|Content):[ \t]*(.*)$/i;

function itemsFromPlainText(text: string): ExaSearchResultItem[] {
  const items: ExaSearchResultItem[] = [];
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
    items.push({
      url,
      title: capText(title !== undefined && title.length > 0 ? title : url, EXA_TITLE_MAX_CHARACTERS),
      ...(published !== undefined && published.length > 0 && published.toUpperCase() !== "N/A" ? { publishedDate: published } : {}),
      text: capText((body ?? []).join("\n").trim(), EXA_HIGHLIGHTS_MAX_CHARACTERS),
    });
  }
  return items;
}

/**
 * Results out of one payload's text. Tolerant by design: JSON with a `results` array (the advanced
 * tool), else `Title:`/`URL:` records (the basic tool), else none -- never a throw. A result with
 * no linkable URL is dropped; one with no title uses its URL.
 */
export function parseExaResults(text: string): ExaSearchResultItem[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const results = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null ? (parsed as { results?: unknown }).results : undefined;
      if (Array.isArray(results)) {
        return results.flatMap((r) => {
          const item = typeof r === "object" && r !== null ? itemFromRecord(r as Record<string, unknown>) : undefined;
          return item !== undefined ? [item] : [];
        });
      }
    } catch {
      /* a truncated or non-JSON payload: fall through to the text form */
    }
  }
  return itemsFromPlainText(trimmed);
}

// --- published-date filters -----------------------------------------------------------------------

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A date argument as sent to Exa: a valid `YYYY-MM-DD` unchanged, any other parseable ISO date as its UTC ISO string. Throws a `TypeError` naming `field` otherwise. */
function publishedDateArg(field: string, value: unknown): { sent: string; ms: number } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const plain = PLAIN_DATE.exec(trimmed);
    if (plain !== null) {
      const ms = Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
      const back = new Date(ms);
      if (back.getUTCFullYear() === Number(plain[1]) && back.getUTCMonth() === Number(plain[2]) - 1 && back.getUTCDate() === Number(plain[3])) return { sent: trimmed, ms };
    } else if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const ms = Date.parse(trimmed);
      if (Number.isFinite(ms)) return { sent: new Date(ms).toISOString(), ms };
    }
  }
  throw new TypeError(`${field} must be an ISO 8601 date (YYYY-MM-DD or a date-time), got ${JSON.stringify(typeof value === "string" ? value.slice(0, 64) : value)}`);
}

/**
 * The published-date window of one search, as Exa arguments. Throws a `TypeError` for a caller error
 * (an unparseable date, a `recentDays` that is not a positive finite number, a start after the end):
 * these are not search failures, and nothing is sent.
 */
function publishedDateArgs(params: ExaSearchParams, now: number): { startPublishedDate?: string; endPublishedDate?: string } {
  let start = params.startPublishedDate !== undefined ? publishedDateArg("startPublishedDate", params.startPublishedDate) : undefined;
  const end = params.endPublishedDate !== undefined ? publishedDateArg("endPublishedDate", params.endPublishedDate) : undefined;
  if (params.recentDays !== undefined) {
    if (typeof params.recentDays !== "number" || !Number.isFinite(params.recentDays) || params.recentDays <= 0) {
      throw new TypeError(`recentDays must be a positive number of days, got ${JSON.stringify(params.recentDays)}`);
    }
    const ms = now - params.recentDays * DAY_MS;
    if (start === undefined || ms > start.ms) start = { sent: new Date(ms).toISOString(), ms };
  }
  if (start !== undefined && end !== undefined && start.ms > end.ms) {
    throw new TypeError(`the published-date window is empty: its start (${start.sent}) is after its end (${end.sent})`);
  }
  return { ...(start !== undefined ? { startPublishedDate: start.sent } : {}), ...(end !== undefined ? { endPublishedDate: end.sent } : {}) };
}

// --- the client -----------------------------------------------------------------------------------

export interface ExaSearchClientOptions {
  /**
   * Resolves the fallback key, LAZILY: not called at all while the anonymous tier answers. A found
   * key is kept for the client's lifetime. A throwing resolver reads as `key_unreadable`.
   */
  resolveKey?: () => ExaKeyResolution | Promise<ExaKeyResolution>;
  /** The breaker and pacer to use. Default: `sharedExaBackendState`. */
  state?: ExaBackendState;
  /** Excluded from EVERY search, and any result on it is dropped. */
  blockedDomains?: readonly string[];
  /** Overrides `EXA_MCP_ENDPOINT`. */
  endpoint?: string;
  /** Default: `createExaMcpHttpTransport()`. */
  transport?: ExaTransport;
  now?: () => number;
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  callTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxResultChars?: number;
}

export interface ExaSearchClient {
  /** Never rejects for a search failure (those are typed results); rejects with a `TypeError`, before any request, for an invalid published-date filter. */
  search(params: ExaSearchParams, options?: { signal?: AbortSignal }): Promise<ExaSearchResult>;
  /** Closes both tiers' connections. Idempotent; never throws. */
  close(): Promise<void>;
}

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

/** The endpoint with its `tools=` selector. Built by hand so NOTHING else -- least of all a key -- can ride the query string. */
export function exaEndpointUrl(endpoint: string = EXA_MCP_ENDPOINT): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}tools=${EXA_ENABLED_TOOLS.join(",")}`;
}

type CallOutcome =
  | { kind: "ok"; result: ExaToolCallResult }
  | { kind: "rate-limited"; detail: string }
  | { kind: "auth"; detail: string }
  | { kind: "timeout"; afterMs: number }
  | { kind: "aborted" }
  /** `transport: true` -- the CALL ITSELF failed, nothing was searched; `false` -- the backend ANSWERED with an error (final). */
  | { kind: "failed"; detail: string; unreachable: boolean; transport: boolean };

type KeyAnswer = { status: "found"; key: string } | { status: "missing" } | { status: "unreadable"; message: string };

function normalizeKey(answer: ExaKeyResolution): KeyAnswer {
  if (answer === undefined || answer === null) return { status: "missing" };
  if (typeof answer === "string") return answer.length > 0 ? { status: "found", key: answer } : { status: "missing" };
  if (answer.status === "found") return typeof answer.key === "string" && answer.key.length > 0 ? { status: "found", key: answer.key } : { status: "missing" };
  if (answer.status === "unreadable") return { status: "unreadable", message: typeof answer.message === "string" ? answer.message : "the key could not be read" };
  return { status: "missing" };
}

export function createExaSearchClient(options: ExaSearchClientOptions = {}): ExaSearchClient {
  const state = options.state ?? sharedExaBackendState;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const transport = options.transport ?? createExaMcpHttpTransport();
  const callTimeoutMs = options.callTimeoutMs ?? EXA_CALL_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? EXA_CONNECT_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? EXA_MAX_RESULT_CHARS;
  const floor = mergeDomainLists(options.blockedDomains);
  const url = exaEndpointUrl(options.endpoint);

  const connections: Partial<Record<ExaTier, ExaConnection>> = {};
  // SINGLE-FLIGHT: two concurrent first searches share ONE connect.
  const connecting: Partial<Record<ExaTier, Promise<ExaConnection>>> = {};
  let foundKey: string | undefined;
  let closed = false;

  const drop = async (tier: ExaTier): Promise<void> => {
    const connection = connections[tier];
    delete connections[tier];
    if (connection !== undefined) await connection.close().catch(() => {});
  };

  const connectionFor = (tier: ExaTier, apiKey: string | undefined): Promise<ExaConnection> => {
    const existing = connections[tier];
    if (existing !== undefined) return Promise.resolve(existing);
    const pending = connecting[tier];
    if (pending !== undefined) return pending;
    const headers: Record<string, string> = tier === "key" && apiKey !== undefined ? { [EXA_API_KEY_HEADER]: apiKey } : {};
    const started = (async (): Promise<ExaConnection> => {
      const connection = await transport.connect({ url, tier, headers, connectTimeoutMs, refuseRedirects: tier === "key" });
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

  const classify = (err: unknown): ExaErrorClass => {
    try {
      return transport.classify(err);
    } catch {
      return { kind: "other", unreachable: false, transport: false };
    }
  };

  /** ONE attempt on one tier: connect if needed, call, race the call against our own timer and the abort signal. */
  const attempt = async (tier: ExaTier, apiKey: string | undefined, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallOutcome> => {
    const isAborted = (): boolean => signal?.aborted === true;
    // What a failure may quote of the backend's own words: short, and with the key scrubbed.
    const detailOf = (text: string): string => capText(apiKey !== undefined && apiKey.length > 0 ? text.split(apiKey).join("***") : text, 300);
    if (isAborted()) return { kind: "aborted" };
    const boundMs = callTimeoutMs + (connections[tier] === undefined ? connectTimeoutMs : 0);
    // Set when the caller stopped waiting: a connect that lands afterwards must not go on to search.
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
          const about = withoutEchoes(text, args);
          if (EXA_RATE_LIMIT_PATTERN.test(about)) return { kind: "rate-limited", detail: detailOf(text) };
          if (EXA_AUTH_PATTERN.test(about)) return { kind: "auth", detail: detailOf(text) };
          return { kind: "failed", detail: detailOf(text), unreachable: false, transport: false };
        }
        return { kind: "ok", result };
      })();
      work.catch(() => {});
      const settled = await Promise.race([work, interrupted]);
      if (settled === "timeout" || settled === "aborted") {
        abandoned = true;
        // The only way to stop the in-flight request is to close its connection.
        await drop(tier);
        return settled === "timeout" ? { kind: "timeout", afterMs: boundMs } : { kind: "aborted" };
      }
      return settled;
    } catch (err) {
      if (isAborted()) return { kind: "aborted" };
      const classified = classify(err);
      await drop(tier);
      if (classified.kind === "rate-limited") return { kind: "rate-limited", detail: detailOf(errorText(err)) };
      if (classified.kind === "auth") return { kind: "auth", detail: detailOf(errorText(err)) };
      if (classified.kind === "timeout") return { kind: "timeout", afterMs: boundMs };
      return { kind: "failed", detail: detailOf(errorText(err)), unreachable: classified.unreachable, transport: classified.transport };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  };

  /** One tier, with ONE reconnect-and-retry when an ESTABLISHED session was dropped under it. */
  const callTier = async (tier: ExaTier, apiKey: string | undefined, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallOutcome> => {
    const hadConnection = connections[tier] !== undefined;
    const first = await attempt(tier, apiKey, tool, args, signal);
    if (first.kind !== "failed" || !first.transport || !hadConnection) return first;
    return attempt(tier, apiKey, tool, args, signal);
  };

  // THE PACER. A reservation can legitimately sit at most `(waiting + 1)` intervals ahead of now; one
  // further out is a wall clock that stepped backwards, and only that is re-based.
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

  const failureFrom = (outcome: Extract<CallOutcome, { kind: "timeout" | "aborted" | "failed" }>): ExaSearchResult => {
    if (outcome.kind === "timeout") return { ok: false, code: "timeout", message: `the search backend did not answer within ${Math.max(1, Math.round(outcome.afterMs / 1000))} seconds` };
    if (outcome.kind === "aborted") return { ok: false, code: "aborted", message: "the search was interrupted" };
    return outcome.unreachable
      ? { ok: false, code: "unavailable", message: `the search backend could not be reached: ${outcome.detail}` }
      : { ok: false, code: "backend_error", message: `the search backend reported an error: ${outcome.detail}` };
  };

  return {
    async search(params, opts = {}): Promise<ExaSearchResult> {
      const signal = opts.signal;
      if (closed) return { ok: false, code: "backend_error", message: "the search client has been closed" };
      if (signal?.aborted === true) return { ok: false, code: "aborted", message: "the search was interrupted" };

      // The floor rides EVERY search: applied to the allow-list itself, excluded otherwise, and in
      // every case applied again to the results.
      const include = mergeDomainLists(params.includeDomains).filter((domain) => !isDomainBlocked(domain, floor));
      if ((params.includeDomains?.length ?? 0) > 0 && include.length === 0) {
        return { ok: false, code: "blocked_domains", message: "every domain in the allow-list is blocked by this client's configuration, so there is nothing that may be searched" };
      }
      // `localExclude` is everything that must not come back; `exclude` is the part the BACKEND's
      // filter is trusted with: multi-label names only.
      const localExclude = mergeDomainLists(floor, params.excludeDomains);
      const exclude = include.length > 0 ? [] : backendExcludableDomains(localExclude);
      const requested = typeof params.numResults === "number" && Number.isFinite(params.numResults) ? Math.floor(params.numResults) : EXA_DEFAULT_NUM_RESULTS;
      const numResults = Math.min(EXA_MAX_NUM_RESULTS, Math.max(1, requested));
      const dates = publishedDateArgs(params, now());
      const filtered = include.length > 0 || exclude.length > 0 || Object.keys(dates).length > 0;
      const tool = filtered ? EXA_ADVANCED_SEARCH_TOOL : EXA_SEARCH_TOOL;
      const query = typeof params.query === "string" ? params.query : String(params.query);
      const args: Record<string, unknown> = filtered
        ? {
            query,
            numResults,
            enableHighlights: true,
            highlightsMaxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS,
            textMaxCharacters: EXA_TEXT_MAX_CHARACTERS,
            ...(include.length > 0 ? { includeDomains: include } : exclude.length > 0 ? { excludeDomains: exclude } : {}),
            ...dates,
          }
        : { query, objective: params.objective !== undefined && params.objective.trim().length > 0 ? params.objective : query, numResults };

      const succeed = (tier: ExaTier, result: ExaToolCallResult, apiKey: string | undefined): ExaSearchResult => {
        let full = resultText(result);
        if (apiKey !== undefined && apiKey.length > 0) full = full.split(apiKey).join("***");
        // A result whose URL names no host is dropped: a fail-open edge of the floor otherwise.
        const results = parseExaResults(full)
          .filter((item) => normalizeDomain(item.url) !== undefined && !isDomainBlocked(item.url, localExclude))
          .slice(0, numResults);
        return { ok: true, results, tier, tool, rawText: capText(full, maxResultChars), truncated: full.length > maxResultChars };
      };

      // --- anonymous first ----------------------------------------------------------------------
      let anonymousDetail: string | undefined;
      if (!anonymousBreakerOpen(state, now())) {
        await pace(signal);
        const outcome = await callTier("anonymous", undefined, tool, args, signal);
        if (outcome.kind === "ok") {
          delete state.anonymousRateLimitedAt;
          delete state.anonymousRefusal;
          return succeed("anonymous", outcome.result, undefined);
        }
        if (outcome.kind !== "rate-limited" && outcome.kind !== "auth") return failureFrom(outcome);
        state.anonymousRateLimitedAt = now();
        state.anonymousRefusal = outcome.kind;
        anonymousDetail = outcome.detail;
      }

      // --- the key, as fallback -----------------------------------------------------------------
      let secret: KeyAnswer;
      if (foundKey !== undefined) {
        secret = { status: "found", key: foundKey };
      } else {
        try {
          secret = normalizeKey(options.resolveKey === undefined ? undefined : await options.resolveKey());
        } catch (err) {
          // A resolver that throws must not throw out of `search()`. Its error's NAME only.
          secret = { status: "unreadable", message: `the key resolver failed with ${err instanceof Error ? err.name : "an unknown error"}` };
        }
        if (secret.status === "found") foundKey = secret.key;
      }
      if (secret.status !== "found") {
        const retryAfterMs = Math.max(0, EXA_ANONYMOUS_COOLDOWN_MS - (now() - (state.anonymousRateLimitedAt ?? now())));
        const retryMinutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
        const why = state.anonymousRefusal === "auth" ? "The web search backend refused anonymous access" : "The free web search quota is exhausted";
        const exhausted = `${why}${anonymousDetail !== undefined && anonymousDetail.length > 0 ? ` (${anonymousDetail})` : ""}; the free tier will be tried again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`;
        return secret.status === "missing"
          ? { ok: false, code: "quota_exhausted", message: `${exhausted} No search API key is configured -- add an Exa API key to keep searching without waiting.`, retryAfterMs }
          : { ok: false, code: "key_unreadable", message: `${exhausted} A search API key is configured but could not be used: ${secret.message}`, retryAfterMs };
      }
      const outcome = await callTier("key", secret.key, tool, args, signal);
      if (outcome.kind === "ok") return succeed("key", outcome.result, secret.key);
      if (outcome.kind === "rate-limited") return { ok: false, code: "rate_limited", message: `the search backend rate-limited or refused the configured API key for lack of quota: ${outcome.detail}` };
      if (outcome.kind === "auth") return { ok: false, code: "key_rejected", message: `the search backend rejected the configured API key: ${outcome.detail}` };
      return failureFrom(outcome);
    },

    async close(): Promise<void> {
      closed = true;
      await Promise.all([drop("anonymous"), drop("key")]);
    },
  };
}
