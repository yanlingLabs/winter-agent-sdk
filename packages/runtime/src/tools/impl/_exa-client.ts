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
import { isDomainBlocked, mergeDomainLists } from "./_domains.ts";

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
  /** The earliest time the next anonymous call may START (pacing). */
  nextAnonymousCallAt: number;
}

export function createExaBackendState(): ExaBackendState {
  return { nextAnonymousCallAt: 0 };
}

export const sharedExaBackendState: ExaBackendState = createExaBackendState();

/** True while the anonymous tier is being skipped. After the cooldown it reads `false`, and the next call is the re-probe. */
export function anonymousBreakerOpen(state: ExaBackendState, now: number): boolean {
  return state.anonymousRateLimitedAt !== undefined && now - state.anonymousRateLimitedAt < EXA_ANONYMOUS_COOLDOWN_MS;
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

const RATE_LIMIT_PATTERN = /\b429\b|\b402\b|rate.?limit|too many requests|quota|credits? (?:exhausted|exceeded)|limit (?:reached|exceeded)/i;
const AUTH_PATTERN = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api.?key|api.?key (?:is )?(?:invalid|required|missing)/i;
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

function hitFromRecord(record: Record<string, unknown>): ExaSearchHit | undefined {
  const url = typeof record["url"] === "string" ? record["url"] : typeof record["id"] === "string" && /^https?:\/\//i.test(record["id"]) ? record["id"] : undefined;
  if (url === undefined || url.trim().length === 0) return undefined;
  const title = typeof record["title"] === "string" && record["title"].trim().length > 0 ? record["title"].trim() : url;
  // Highlights are what was asked for; `summary` and the (capped) page `text` are what is left when the backend sent none.
  const highlight = highlightFrom(record["highlights"]) || highlightFrom(record["summary"]) || highlightFrom(record["text"]);
  const published = typeof record["publishedDate"] === "string" && record["publishedDate"].length > 0 ? record["publishedDate"] : undefined;
  return { title, url: url.trim(), highlight: capText(highlight.trim(), EXA_HIGHLIGHTS_MAX_CHARACTERS), ...(published !== undefined ? { publishedDate: published } : {}) };
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
    if (url === undefined || !/^https?:\/\//i.test(url)) continue;
    hits.push({
      title: title !== undefined && title.length > 0 ? title : url,
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
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "failed"; detail: string; unreachable: boolean };

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
  let key: Promise<ToolSecretResult> | undefined;
  let closed = false;

  const drop = async (tier: ExaTier): Promise<void> => {
    const connection = connections[tier];
    delete connections[tier];
    if (connection !== undefined) await connection.close().catch(() => {});
  };

  const connectionFor = async (tier: ExaTier, apiKey: string | undefined): Promise<ConnectedMcpClient> => {
    const existing = connections[tier];
    if (existing !== undefined) return existing;
    const config: McpServerConfigForProcessTransport = { type: "http", url, ...(tier === "key" && apiKey !== undefined ? { headers: { [EXA_API_KEY_HEADER]: apiKey } } : {}) };
    // The always-declining asker: a search backend has no business eliciting input from the user.
    const connection = await connect({ name: MCP_SERVER_NAME, config, connectTimeoutMs, elicitationAsk: createElicitationAsker(undefined) });
    if (closed) {
      await connection.close().catch(() => {});
      throw new Error("the search client was closed while connecting");
    }
    connections[tier] = connection;
    return connection;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), callTimeoutMs + connectTimeoutMs);
      if (signal !== undefined) {
        onAbort = () => resolve("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      const work = (async (): Promise<CallOutcome> => {
        const connection = await connectionFor(tier, apiKey);
        const result = await connection.callTool(tool, args, { timeoutMs: callTimeoutMs });
        if (result.isError === true) {
          const text = resultText(result);
          if (RATE_LIMIT_PATTERN.test(text)) return { kind: "rate-limited", detail: detailOf(text) };
          if (AUTH_PATTERN.test(text)) return { kind: "auth", detail: detailOf(text) };
          return { kind: "failed", detail: detailOf(text), unreachable: false };
        }
        return { kind: "ok", result };
      })();
      // The losing side of the race is abandoned; its later rejection must not surface as unhandled.
      work.catch(() => {});
      const settled = await Promise.race([work, interrupted]);
      if (settled === "timeout" || settled === "aborted") {
        // `callTool` takes no signal, so the only way to stop the in-flight request is to close its connection.
        await drop(tier);
        return { kind: settled };
      }
      return settled;
    } catch (err) {
      if (isAborted()) return { kind: "aborted" };
      const classified = classifyError(err);
      // A connection that produced an error is not reused: the next attempt reconnects.
      await drop(tier);
      if (classified === "rate-limited") return { kind: "rate-limited", detail: detailOf(errorText(err)) };
      if (classified === "auth") return { kind: "auth", detail: detailOf(errorText(err)) };
      if (classified === "timeout") return { kind: "timeout" };
      return { kind: "failed", detail: detailOf(errorText(err)), unreachable: err instanceof McpConnectError || UNREACHABLE_PATTERN.test(errorText(err)) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  };

  /** One tier, with ONE reconnect-and-retry when an ESTABLISHED session was dropped under it. */
  const callTier = async (tier: ExaTier, apiKey: string | undefined, tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallOutcome> => {
    const hadConnection = connections[tier] !== undefined;
    const first = await attempt(tier, apiKey, tool, args, signal);
    if (first.kind !== "failed" || !hadConnection) return first;
    // `attempt` already dropped the dead connection; this one reconnects from scratch.
    return attempt(tier, apiKey, tool, args, signal);
  };

  const pace = async (signal: AbortSignal | undefined): Promise<void> => {
    const start = Math.max(now(), state.nextAnonymousCallAt);
    state.nextAnonymousCallAt = start + EXA_ANONYMOUS_MIN_INTERVAL_MS;
    const wait = start - now();
    if (wait > 0) await sleep(wait, signal);
  };

  const failureFrom = (outcome: Exclude<CallOutcome, { kind: "ok" } | { kind: "rate-limited" } | { kind: "auth" }>): ExaSearchResult => {
    if (outcome.kind === "timeout") return { ok: false, code: "timeout", message: `the search backend did not answer within ${Math.round(callTimeoutMs / 1000)} seconds` };
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
      const exclude = include.length > 0 ? [] : mergeDomainLists(floor, params.excludeDomains);
      const numResults = Math.max(1, Math.floor(params.numResults ?? EXA_DEFAULT_NUM_RESULTS));
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
        const hits = parseExaHits(full).filter((hit) => !isDomainBlocked(hit.url, floor));
        return { ok: true, hits, tier, tool, rawText: capText(full, maxResultChars), truncated: full.length > maxResultChars };
      };

      // --- anonymous first ----------------------------------------------------------------------
      let anonymousDetail: string | undefined;
      if (!anonymousBreakerOpen(state, now())) {
        await pace(signal);
        const outcome = await callTier("anonymous", undefined, tool, args, signal);
        if (outcome.kind === "ok") {
          delete state.anonymousRateLimitedAt;
          return succeed("anonymous", outcome.result);
        }
        if (outcome.kind !== "rate-limited" && outcome.kind !== "auth") return failureFrom(outcome);
        // Rate-limited (or the anonymous tier now demands a credential): OPEN the breaker and fall to the key.
        state.anonymousRateLimitedAt = now();
        anonymousDetail = outcome.detail;
      }

      // --- the key, as fallback -----------------------------------------------------------------
      key ??= options.resolveKey?.() ?? Promise.resolve<ToolSecretResult>({ status: "missing" });
      const secret = await key;
      if (secret.status !== "found") {
        const retryMinutes = Math.max(1, Math.ceil((EXA_ANONYMOUS_COOLDOWN_MS - (now() - (state.anonymousRateLimitedAt ?? now()))) / 60_000));
        const exhausted = `The free web search quota is exhausted${anonymousDetail !== undefined ? ` (${anonymousDetail})` : ""}; the free tier will be tried again in about ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`;
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
