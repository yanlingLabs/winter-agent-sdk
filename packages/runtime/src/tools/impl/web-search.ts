// WebSearch -- a faithful copy of claude's own tool (see `descriptors/web-search.ts`'s own header for
// the description mechanism and its one disclosed deviation), backed by Exa's hosted search MCP
// (`_exa-client.ts`) instead of Anthropic's server-side search. The inner pass -- one function tool,
// up to N calls, on the SESSION's own model -- is `_inner-model.ts`'s `runInnerModel`; the OUTER
// model only ever sees what `_web-search-assembler.ts` assembles from it (titles + urls, never a
// highlight, never raw page text).
//
// DEVIATIONS FROM CLAUDE, ALL DISCLOSED (see this lane's own report for the fuller writeup):
//   - the lean/full description CHOICE is not session-dynamic (descriptors/web-search.ts's header);
//   - the inner tool's NAME/DESCRIPTION/SCHEMA are Winter-authored (a PROMPT, never an interface
//     string -- claude's own inner tool is its private server_tool_use wiring, never observed);
//   - the anonymous-vs-keyed per-call cap (3 vs 8) has no claude analogue at all;
//   - a search failure's MESSAGE (not just its bare `Web search error: <code>` item) is surfaced once,
//     at the end, when EVERY attempted search failed -- claude's backend retries transparently and
//     never needs to tell the model how to add a key; Winter's does.
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import "../descriptors/web-search.ts"; // self-sufficiency: guarantees the "WebSearch" stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { searchBackendUsable, webSessionRuntimeFor, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { INNER_TOOL_LIMIT_NOTICE, runInnerModel, type InnerModelFailure, type InnerModelStep, type InnerToolHandler } from "./_inner-model.ts";
import { anonymousBreakerOpen, createExaSearchClient, EXA_DEFAULT_NUM_RESULTS, exaKeyResolverFor, sharedExaBackendState, type ExaBackendState, type ExaSearchClientOptions, type ExaSearchResult } from "./_exa-client.ts";
import { exaSearchClientForSession } from "./_exa-session-client.ts";
import { reserveWebSearchCall, resolveMaxWebSearchesPerSession, webSearchBudgetRefusalText } from "./_search-budget.ts";
import { assembleWebSearchOutput, type WebSearchStreamEvent } from "./_web-search-assembler.ts";

type EnvBrand = Pick<BrandProfile, "envPrefix">;

/** claude's own cap (research file, "maxResultSizeChars: 100000"). No per-tool cap seam exists on this registry (verified: no `maxResultChars`/`maxResultSizeChars` anywhere in it), so the executor enforces it itself. */
export const WEB_SEARCH_RESULT_CAP = 100_000;

// --- input -------------------------------------------------------------------------------------

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

type ParsedInput = { ok: true; input: WebSearchInput } | { ok: false; error: string };

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

/**
 * claude's own `validateInput`, verbatim texts (research file, errorCodes 1/2). The zod `min(2)`
 * message is NOT in the pinned binary (the research file's own "Not found" list) -- a query of
 * length 1 is folded into the SAME `Error: Missing query` claude gives an empty one, rather than
 * inventing a distinct Winter-authored line for a case the binary never had its own text for.
 * Disclosed in this lane's report.
 */
function parseInput(raw: unknown): ParsedInput {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const query = typeof record["query"] === "string" ? record["query"].trim() : "";
  if (query.length < 2) return { ok: false, error: "Error: Missing query" };
  const allowed = stringArray(record["allowed_domains"]);
  const blocked = stringArray(record["blocked_domains"]);
  if (allowed !== undefined && blocked !== undefined) {
    return { ok: false, error: "Error: Cannot specify both allowed_domains and blocked_domains in the same request" };
  }
  return { ok: true, input: { query, ...(allowed !== undefined ? { allowed_domains: allowed } : {}), ...(blocked !== undefined ? { blocked_domains: blocked } : {}) } };
}

// --- the inner tool (Winter-authored: a PROMPT, never claude's own private server-tool wiring) -----

const INNER_SEARCH_TOOL_NAME = "web_search";
const INNER_SEARCH_TOOL_DESCRIPTION = "Search the web for information relevant to the outer query. Call this as many times as you need, with different queries, before answering.";
const INNER_SEARCH_TOOL_SCHEMA = { type: "object", properties: { query: { type: "string", description: "One web search query." } }, required: ["query"] } as const;

function compactHitsForInnerModel(hits: readonly { title: string; url: string; highlight: string }[]): string {
  if (hits.length === 0) return "No results found.";
  return hits.map((h) => `- ${h.title}\n  ${h.url}${h.highlight.length > 0 ? `\n  ${h.highlight}` : ""}`).join("\n");
}

// --- failure text ----------------------------------------------------------------------------------

function innerFailureText(failure: InnerModelFailure): string {
  switch (failure.code) {
    case "not-wired":
      return "Error: web search is not available for this session (no search runtime is wired up for it).";
    case "invalid-request":
      return `Error: web search could not build its internal request (${failure.message}).`;
    case "model-unresolvable":
    case "no-credential":
      // WebSearch's inner pass always runs on {kind:"session"} -- these codes are only reachable for
      // a STATED model, so they are dead in practice; kept for exhaustiveness, never thrown away.
      return `Error: the web search model could not be used (${failure.message}).`;
    case "provider-error":
      return `Error: the web search failed: ${failure.message}`;
    case "aborted":
      return "Web search was interrupted.";
  }
}

// --- deps (advisor.ts precedent: a factory so tests can point the client at a fixture) -------------

export interface WebSearchExecutorDeps {
  /** Forwarded into `createExaSearchClient` for the session's first call. Tests set `endpoint`/`state`/`sleep`/`connect`. */
  exaClientOptions?: Pick<ExaSearchClientOptions, "endpoint" | "state" | "sleep" | "connect" | "callTimeoutMs" | "connectTimeoutMs" | "maxResultChars">;
  /** The SAME breaker state object passed above (defaults to the process-wide one, matching `_exa-client.ts`'s own default) -- read here too, to decide the per-call cap BEFORE the loop starts. */
  backendState?: ExaBackendState;
  now?: () => number;
  brand?: EnvBrand;
  resultCap?: number;
}

export function createWebSearchExecutor(deps: WebSearchExecutorDeps = {}): ToolExecutor {
  const now = deps.now ?? Date.now;
  const backendState = deps.backendState ?? sharedExaBackendState;
  const resultCap = deps.resultCap ?? WEB_SEARCH_RESULT_CAP;

  async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const parsed = parseInput(rawInput);
    if (!parsed.ok) return { output: parsed.error, isError: true };
    const { query, allowed_domains, blocked_domains } = parsed.input;

    // --- the session's own budget (counted BEFORE the search runs; see `_search-budget.ts`) --------
    const brand = deps.brand ?? ctx.brand ?? WINTER_BRAND;
    const env = ctx.env ?? process.env;
    const cap = resolveMaxWebSearchesPerSession(env, brand);
    const reservation = reserveWebSearchCall(ctx.sessionId, cap);
    if (!reservation.ok) return { output: webSearchBudgetRefusalText(reservation.used, reservation.cap, brand) };

    // --- the session's search wiring ----------------------------------------------------------------
    const runtime: WebSessionRuntime | undefined = webSessionRuntimeFor(ctx);
    if (runtime === undefined) {
      return { output: "Error: web search is not available for this session (no search runtime is wired up for it -- a host wiring gap, not an input error).", isError: true };
    }
    if (!searchBackendUsable(runtime)) {
      return { output: "Web search is turned off for this session." };
    }

    const resolveKey = exaKeyResolverFor(runtime);
    const client = exaSearchClientForSession(ctx.sessionId, () =>
      createExaSearchClient({
        ...(resolveKey !== undefined ? { resolveKey } : {}),
        blockedDomains: runtime.web.blockedDomains,
        state: backendState,
        ...deps.exaClientOptions,
      }),
    );

    // --- the per-call cap: decided ONCE, before the loop (`maxToolCalls` is fixed for `runInnerModel`) --
    //
    // Anonymous-first, exactly like the client's own per-search posture: the ONLY time this call uses
    // the larger keyed cap is when the breaker is ALREADY open (the anonymous tier is known exhausted
    // for the next `EXA_ANONYMOUS_COOLDOWN_MS`) AND a key is configured to fall back to. Disclosed
    // edge: a call that starts with the breaker CLOSED but whose first search trips it mid-call still
    // finishes capped at the smaller anonymous bound for THIS call -- the larger cap applies from the
    // NEXT call onward, once the breaker's open state is visible here too.
    const hasKeyConfigured = runtime.web.search.authRef !== undefined;
    const breakerOpen = anonymousBreakerOpen(backendState, now());
    const maxToolCalls = breakerOpen && hasKeyConfigured ? runtime.web.search.maxSearchesPerCall : runtime.web.search.anonymousMaxSearchesPerCall;

    const outcomes = new Map<string, ExaSearchResult>();
    const handler: InnerToolHandler = async (rawToolInput, info) => {
      const toolQuery = typeof rawToolInput === "object" && rawToolInput !== null && typeof (rawToolInput as Record<string, unknown>)["query"] === "string" ? ((rawToolInput as Record<string, unknown>)["query"] as string) : query;
      const result = await client.search(
        {
          query: toolQuery,
          // The EXECUTOR supplies `objective`, always the OUTER query -- never the inner model's own
          // per-call query -- so every inner search stays on-task (briefed explicitly; the inner
          // model is never given a way to set this itself).
          objective: query,
          numResults: EXA_DEFAULT_NUM_RESULTS,
          ...(allowed_domains !== undefined ? { includeDomains: allowed_domains } : {}),
          ...(blocked_domains !== undefined ? { excludeDomains: blocked_domains } : {}),
        },
        info.signal !== undefined ? { signal: info.signal } : {},
      );
      outcomes.set(info.toolUseId, result);
      if (!result.ok) return { output: `Error: the search failed (${result.code}): ${result.message}`, isError: true };
      return { output: compactHitsForInnerModel(result.hits) };
    };

    let pass;
    try {
      pass = await runInnerModel(ctx, {
        system: "You are an assistant for performing a web search tool use",
        prompt: `Perform a web search for the query: ${query}`,
        tool: { name: INNER_SEARCH_TOOL_NAME, description: INNER_SEARCH_TOOL_DESCRIPTION, inputSchema: INNER_SEARCH_TOOL_SCHEMA },
        maxToolCalls,
        handler,
      });
    } catch (err) {
      // `runInnerModel` is documented never to throw for an expected failure; a genuine bug here
      // still must not end the whole turn -- the NAME only, never the message (it is unvetted).
      return { output: `Error: web search failed unexpectedly (${err instanceof Error ? err.name : "unknown error"}).`, isError: true };
    }

    // --- claude-shaped events, built from the inner pass's own ordered steps ------------------------
    const events: WebSearchStreamEvent[] = [];
    let successfulSearches = 0;
    let attemptedSearches = 0;
    let lastFailureMessage: string | undefined;
    for (const step of pass.steps as readonly InnerModelStep[]) {
      if (step.kind === "text") {
        events.push({ type: "text", text: step.text });
        continue;
      }
      if (!step.executed) {
        // Two shapes reach here, and only one is a claude-recognisable search event (advisor
        // guidance, disclosed in the report): a LIMIT-NOTICE step (the model was still calling the
        // tool past `maxToolCalls`) is what claude's OWN backend answers `error_code:
        // max_uses_exceeded` for on an over-budget call -- so it becomes that error item. An
        // UNKNOWN-TOOL-NAME step (the model hallucinated a tool that was never offered) has no
        // claude analogue at all -- it is not a search, and is simply not a claude-shaped event.
        if (step.output === INNER_TOOL_LIMIT_NOTICE) events.push({ type: "search_error", code: "max_uses_exceeded" });
        continue;
      }
      const outcome = outcomes.get(step.toolUseId);
      attemptedSearches += 1;
      if (outcome === undefined || !outcome.ok) {
        const code = outcome?.code ?? "backend-error";
        if (outcome !== undefined) lastFailureMessage = outcome.message;
        events.push({ type: "search_error", code });
        continue;
      }
      successfulSearches += 1;
      events.push({ type: "search_result", hits: outcome.hits.map((h) => ({ title: h.title, url: h.url })) });
    }

    // A pass that failed OUTRIGHT (not-wired, provider-error, aborted, ...): show whatever REAL
    // searches it completed first (a partial loop's searches are still real -- `_inner-model.ts`'s
    // own contract), then append the failure as a trailing note; a pass with NO ATTEMPTED SEARCH
    // returns the failure text alone, as an error -- checked BEFORE the "no search calls" branch
    // below, which would otherwise SWALLOW the real failure reason behind a generic "not performed"
    // whenever the pass also produced leading/trailing commentary text (e.g. round 1 answers with
    // "Let me check." + an unknown-tool-name call, then round 2's generation itself throws:
    // `events` would be all-text with zero attempted searches, and without this ordering the
    // provider-error detail would be discarded in favour of a message that implies nothing went
    // wrong at all).
    if (!pass.ok) {
      if (attemptedSearches === 0) return { output: innerFailureText(pass), isError: true };
      events.push({ type: "text", text: innerFailureText(pass) });
    } else if (attemptedSearches === 0 && events.every((e) => e.type === "text")) {
      // The forced round-1 tool call never actually called the tool at all (an adapter that ignores
      // a forced `toolChoice`) -- there is no search to report, and the model's own commentary must
      // not be dressed up as a search summary that never happened.
      return { output: "Web search was not performed: the search pass produced no search calls." };
    }

    // Every ATTEMPTED search failed: the terse per-item `Web search error: <code>` strings are
    // already in `events` (claude-shaped fidelity), but Winter's own backend errors carry actionable
    // guidance (e.g. "add an Exa API key") claude's never needs to -- surfaced ONCE, plainly, rather
    // than leaving the model to infer it from a bare code.
    if (attemptedSearches > 0 && successfulSearches === 0 && lastFailureMessage !== undefined) {
      events.push({ type: "text", text: lastFailureMessage });
    }

    const text = assembleWebSearchOutput(query, events);
    return { output: text.length > resultCap ? text.slice(0, resultCap) : text };
  }

  return { execute };
}

replaceExecutor("WebSearch", createWebSearchExecutor());
