// Search -- Exa's ANSWER mode (`POST https://api.exa.ai/answer`): a written answer plus the pages it was
// grounded in, in one call. A faithful port of the Winter daemon's own `Search` (its retired `research`
// capability server's tool): the same request body (`{query}` and nothing else), the same caps,
// the same rendering (the answer, then a numbered `Sources:` list), the same unsourced / withheld /
// truncated notes, the same status-to-sentence vocabulary, and the same dangerous-domain floor on the
// CITED urls -- read from the session's `web.blockedDomains`, the list `WebFetch` and `WebSearch` honour.
//
// DIFFERENCES FROM THE DAEMON'S COPY, ALL DELIBERATE:
//   * THE KEY is resolved through the session's tool-secret resolver from `web.search.authRef` -- the
//     same locator and the same resolver `WebSearch`'s keyed tier uses (so a host that brokers
//     credentials answers it over its control channel; this runtime never reads a store the host did
//     not hand it). The daemon read its Keychain directly.
//   * ERROR TEXT NAMES NO HOST COMMAND. The daemon's said `winter credentials set exa`; a runtime cannot
//     know its host's CLI, so the remediation is stated generically ("replace the configured key").
//   * NO AUDIT LINE OF ITS OWN. The daemon wrote `{kind,tool,query,outcome}` to its own audit log; that
//     log is the host's, so a host that keeps one writes it from its PostToolUse/PostToolUseFailure hooks
//     (the query is the input, the outcome the result text -- this file's sentences are stable for that).
//   * THE LIVE FLOOR. The daemon read its dangerous-domain list per call; the runtime's copy is the
//     session's spawn-time `web.blockedDomains`, so a host whose list changes mid-session adds it to the
//     call's input as `blocked_domains` from a PreToolUse hook (as it does for `WebSearch`). Not in the
//     advertised schema -- the model is never offered it -- and it can only ever add to the floor.
//   * SITE ICONS travel as `ToolResultPayload.siteIcons` (host-only, never in the output): each surviving
//     citation's Exa `favicon`, the same channel `WebSearch` uses. The daemon recorded them for a hook to
//     pair with the call id.
import "../descriptors/search.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { webSessionRuntimeFor } from "../../web/session-runtime.ts";
import { exaKeyResolverFor } from "./_exa-client.ts";
import { isDomainBlocked } from "./_domains.ts";
import { collectSiteIcons } from "./_site-icons.ts";
import { SEARCH_CANONICAL_NAME } from "../descriptors/search.ts";

/** `/answer` SYNTHESIZES -- it runs a search and then writes a grounded answer over the results -- so it
 *  is materially slower than a `/search` round trip; the daemon's 45 s, kept. */
export const SEARCH_REQUEST_TIMEOUT_MS = 45_000;
/** The synthesized answer itself. */
export const SEARCH_ANSWER_CHARS = 24_000;
/** Rendered as a sources list; the backend decides how many it used. */
export const SEARCH_MAX_CITATIONS = 20;
/** The whole response: the model's ENTIRE view of the search (a chat has no page-reading tool). */
export const SEARCH_TOTAL_OUTPUT_CHARS = 30_000;
export const EXA_ANSWER_URL = "https://api.exa.ai/answer";

/** What `/answer` returns: `answer` (a string unless `outputSchema` was sent, which this tool never
 *  sends) and the `citations` it was grounded in, each carrying at least `title` and `url` and, per Exa's
 *  reference, an optional `favicon`. `requestId`/`costDollars` ride along and are ignored. */
type ExaCitation = { title?: unknown; url?: unknown; favicon?: unknown };
interface ExaAnswerResponse {
  answer?: unknown;
  citations?: unknown;
}

/** `citations` absent, or an array of non-null objects -- anything else is a malformed response (the
 *  daemon's three pinned cases: `citations:"str"`, `citations:{}`, `citations:[null]`). */
function isValidCitations(value: unknown): value is ExaCitation[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => item !== null && typeof item === "object");
}

/** One sentence per documented failure, each naming what clears it -- never the response body, which can
 *  echo request headers (and so the key) and is third-party text besides. */
export function searchStatusMessage(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "search failed: the configured Exa API key was rejected — it needs to be replaced before Search can work";
    case 402:
      return "search failed: this Exa account is out of credits or over its budget — top it up at exa.ai, or answer from what you already know and say the search was unavailable";
    case 429:
      return "search failed: the search service is rate-limiting this key — wait a little before searching again, and do not retry in a loop";
    case 400:
      return "search failed: the search service rejected the request as malformed — try a plainer question";
    default:
      return `search failed: the search service is unavailable (HTTP ${status})`;
  }
}

export const SEARCH_NO_KEY_MESSAGE = "Search needs an Exa API key (from exa.ai), and none is configured for this session";

export interface SearchExecutorDeps {
  /** Test seam: defaults to the global `fetch`. Tests point it at a loopback fixture. */
  fetchFn?: typeof fetch;
  /** Test seam: defaults to `EXA_ANSWER_URL`. */
  endpoint?: string;
  /** Test seam: defaults to `SEARCH_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

function errorResult(output: string): ToolResultPayload {
  return { output, isError: true };
}

export function createSearchExecutor(deps: SearchExecutorDeps = {}): ToolExecutor {
  const endpoint = deps.endpoint ?? EXA_ANSWER_URL;
  const timeoutMs = deps.timeoutMs ?? SEARCH_REQUEST_TIMEOUT_MS;

  async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const record = typeof rawInput === "object" && rawInput !== null ? (rawInput as Record<string, unknown>) : {};
    const query = typeof record["query"] === "string" ? record["query"] : "";
    if (query.trim().length === 0) return errorResult("Error: Missing query");

    const runtime = webSessionRuntimeFor(ctx);
    if (runtime === undefined) return errorResult("Error: Search is not available for this session (no search runtime is wired up for it -- a host wiring gap, not an input error).");
    if (!runtime.web.search.enabled) return { output: "Web search is turned off for this session." };

    // --- the key: the session's own resolver, never a store of this runtime's own ---------------------
    const resolveKey = exaKeyResolverFor(runtime);
    if (resolveKey === undefined) return errorResult(SEARCH_NO_KEY_MESSAGE);
    let key: string;
    try {
      const secret = await resolveKey();
      if (secret.status === "missing") return errorResult(SEARCH_NO_KEY_MESSAGE);
      if (secret.status === "unreadable") return errorResult(`search failed: an Exa API key is configured but could not be used: ${secret.message}`);
      key = secret.key;
    } catch (err) {
      return errorResult(`search failed: the key resolver failed with ${err instanceof Error ? err.name : "an unknown error"}`);
    }
    if (key.length === 0) return errorResult(SEARCH_NO_KEY_MESSAGE);

    // --- the request ---------------------------------------------------------------------------------
    const fetchFn = deps.fetchFn ?? fetch;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal !== undefined ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ query }),
        // Exa never redirects; with the default `follow` a 3xx would carry `x-api-key` to wherever its
        // `Location` points. `manual` turns any 3xx into a plain non-200, handled below.
        redirect: "manual",
        signal,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || name === "TimeoutError") {
        return errorResult(ctx.signal?.aborted === true ? "Search was interrupted." : `search timed out for ${query}`);
      }
      // NEVER the exception's own message in the result: Bun's fetch embeds an invalid header's VALUE
      // (the key) in its error text. Logged with the key redacted, for whoever reads the runtime's stderr.
      const rawMessage = err instanceof Error ? err.message : String(err);
      console.error(`Search: network error (${name || "Error"}) — ${rawMessage.replaceAll(key, "<redacted>")}`);
      return errorResult("search failed: could not reach the search service");
    }

    if (res.status !== 200) {
      // Drain nothing: the body is never read on a failure (see `searchStatusMessage`).
      try {
        await res.body?.cancel();
      } catch {
        // a body that will not cancel is not this call's problem
      }
      return errorResult(searchStatusMessage(res.status));
    }

    let data: ExaAnswerResponse;
    try {
      data = (await res.json()) as ExaAnswerResponse;
    } catch (err) {
      return errorResult(`search failed: could not parse response (${err instanceof Error ? err.message : String(err)})`);
    }
    if (data === null || typeof data !== "object" || !isValidCitations(data.citations)) return errorResult("search failed: malformed response from search service");
    // A non-string answer is a shape this renderer cannot speak for -- a parse error, never
    // `String(object)` handing the model `[object Object]` labelled as an answer.
    if (data.answer !== undefined && typeof data.answer !== "string") return errorResult("search failed: malformed response from search service");

    const fullAnswer = (data.answer ?? "").trim();
    // NEVER a silent slice: an answer cut mid-sentence reads as a complete one.
    const answer = fullAnswer.length > SEARCH_ANSWER_CHARS ? fullAnswer.slice(0, SEARCH_ANSWER_CHARS) + "\n\n[answer truncated]" : fullAnswer;

    // The dangerous-domain floor on the CITED urls: a link the model is shown is a link it will try. Never
    // a SILENT drop -- the withheld count is always stated.
    // `blocked_domains` on the INPUT (not in the advertised schema): a host's PreToolUse hook adds its
    // LIVE floor there, as it does for `WebSearch` -- the session's `web.blockedDomains` is the list as it
    // stood at spawn, and a host whose floor changes mid-session (Winter's per-project additions) must not
    // wait for the next incarnation. It can only ever ADD to the floor, never lift a spawn-time entry.
    const hostFloor = Array.isArray(record["blocked_domains"]) ? (record["blocked_domains"] as unknown[]).filter((d): d is string => typeof d === "string" && d.trim().length > 0).slice(0, 1000) : [];
    const floor = hostFloor.length > 0 ? [...runtime.web.blockedDomains, ...hostFloor] : runtime.web.blockedDomains;
    const rawCitations = (data.citations ?? []).slice(0, SEARCH_MAX_CITATIONS);
    let withheld = 0;
    const citations = rawCitations.filter((c) => {
      if (typeof c.url !== "string" || c.url.length === 0 || !isDomainBlocked(c.url, floor)) return true;
      withheld++;
      return false;
    });
    const withheldNote = withheld > 0 ? `\n\n[${withheld} source${withheld === 1 ? "" : "s"} withheld — matched the dangerous-domain list]` : "";

    // The cited pages' icons, for the HOST and never the model: only citations that survived the floor
    // (`collectSiteIcons` checks both urls -- https, public names, bounded).
    const siteIcons = collectSiteIcons(citations.map((c) => ({ url: c.url, iconUrl: c.favicon })));
    const withIcons = (output: string): ToolResultPayload => ({ output, ...(siteIcons !== undefined ? { siteIcons } : {}) });

    if (answer === "") return withIcons(`no answer for ${query}${withheldNote}`);
    // An answer with NOTHING left to attribute is still the answer, MARKED -- an unsourced answer is the
    // one a model must not present as cited fact.
    const sources =
      citations.length === 0
        ? `\n\n[unsourced — ${withheld > 0 ? "every source was withheld by the dangerous-domain list" : "the search service returned no sources"}; say so if you repeat this]`
        : "\n\nSources:\n" +
          citations
            .map((c, i) => `${i + 1}. ${(typeof c.title === "string" ? c.title.trim() : "") || "-"}\n   ${typeof c.url === "string" && c.url.length > 0 ? c.url : "-"}`)
            .join("\n");
    const rendered = answer + sources;
    const capped = rendered.length > SEARCH_TOTAL_OUTPUT_CHARS ? rendered.slice(0, SEARCH_TOTAL_OUTPUT_CHARS) + "\n\n[truncated]" : rendered;
    return withIcons(capped + withheldNote);
  }

  return { execute };
}

replaceExecutor(SEARCH_CANONICAL_NAME, createSearchExecutor());
