// WebSearch -- a faithful copy of claude's own tool (see `descriptors/web-search.ts`'s own header for
// the description mechanism and its one disclosed deviation), backed by Exa's hosted search MCP
// (`_exa-client.ts`) instead of Anthropic's server-side search. The inner pass -- one function tool,
// up to N calls, on the SESSION's own model -- is `_inner-model.ts`'s `runInnerModel`; the OUTER
// model only ever sees what `_web-search-assembler.ts` assembles from it (titles + urls, never a
// highlight, never raw page text).
//
// WS-23: THE FIRST SEARCH IS THE RUNTIME'S, NOT THE MODEL'S. The inner pass used to FORCE its first
// round's `tool_choice` so the model could not answer from memory. Opus 5.5 and Fable 5.1 reject a
// forced `tool_choice` (a documented 400), the Anthropic adapter downgrades it to `auto` on those
// rows, the model then answered without calling the tool, and WebSearch returned "Web search was not
// performed" on the two newest Claude models. Parity no longer binds, so the fix is at the root: the
// executor runs the search for the tool's own input deterministically, BEFORE any model call, and the
// inner model starts from those results -- no forcing anywhere, on any model. The model may still call
// the inner tool for follow-up queries (auto), within the same per-call cap, which the seed search
// counts against. The output shape the outer model reads is unchanged.
//
// DEVIATIONS FROM CLAUDE, ALL DISCLOSED (see this lane's own report for the fuller writeup):
//   - the lean/full description CHOICE is not session-dynamic (descriptors/web-search.ts's header);
//   - the inner tool's NAME/DESCRIPTION/SCHEMA are Winter-authored (a PROMPT, never an interface
//     string -- claude's own inner tool is its private server_tool_use wiring, never observed);
//   - the anonymous-vs-keyed per-call cap (3 vs 8) has no claude analogue at all;
//   - a search failure's MESSAGE (not just its bare `Web search error: <code>` item) is surfaced once,
//     at the end, when EVERY attempted search failed -- claude's backend retries transparently and
//     never needs to tell the model how to add a key; Winter's does;
//   - the SESSION SPEND CEILING stop (`isBudgetStop`, below) has no claude analogue at all -- Winter's
//     own inner pass is billed against the session's own `maxBudgetUsd`, a Winter product concept.
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { WEB_SEARCH_CANONICAL_NAME } from "../descriptors/web-search.ts"; // self-sufficiency: guarantees the stub is registered before replaceExecutor runs below.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { searchBackendUsable, webSessionRuntimeFor, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { INNER_MODEL_BUDGET_EXCEEDED_DETAIL, INNER_TOOL_LIMIT_NOTICE, runInnerModel, type InnerModelFailure, type InnerModelStep, type InnerToolHandler } from "./_inner-model.ts";
import { anonymousBreakerOpen, createExaSearchClient, EXA_DEFAULT_NUM_RESULTS, exaKeyResolverFor, sharedExaBackendState, type ExaBackendState, type ExaSearchClientOptions, type ExaSearchResult } from "./_exa-client.ts";
import { exaSearchClientForSession } from "./_exa-session-client.ts";
import { reserveWebSearchCall, resolveMaxWebSearchesPerSession, webSearchBudgetRefusalText } from "./_search-budget.ts";
import { assembleWebSearchOutputCapped, type WebSearchStreamEvent } from "./_web-search-assembler.ts";

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

/**
 * The most entries either domain list may carry. claude has no analogue -- its schema-validated
 * `string[]` is forwarded whole, and the extraction notes record no bound -- but a list is a MODEL-
 * supplied array that this runtime hands to a third-party backend, and a 100,000-element one was
 * forwarded verbatim (whole-branch review MINOR 10). A thousand is far past any real filter and small
 * enough that no request built from it is absurd.
 */
export const MAX_DOMAIN_LIST_ENTRIES = 1000;

// AN EXPLICIT EMPTY ARRAY (`allowed_domains: []`) collapses to "absent", same as an array whose every
// entry is blank. Whether claude's own code treats a truthy-but-empty array the same way is unprovable
// from the binary (no observed call exercises it); this reading is the more defensible one (an empty
// list filters nothing, so it is indistinguishable in EFFECT from not having named the field at all),
// but it is a judgement call, not a transcription.
//
// A WRONG TYPE IS REFUSED, NOT IGNORED (whole-branch review, NIT). `allowed_domains: "a.example"` used
// to read as `undefined` here -- i.e. the search ran UNFILTERED, which is the opposite of what the
// caller asked for and the one direction that is never safe to guess. claude never has to decide: its
// schema refuses the call first. With no schema step in front of this executor, refusing here is that
// step's stand-in, and it is an ordinary error result.
type DomainListResult = { ok: true; value: string[] | undefined } | { ok: false; error: string };

function stringArray(field: string, value: unknown): DomainListResult {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value)) return { ok: false, error: `Error: ${field} must be an array of domain strings` };
  if (value.length > MAX_DOMAIN_LIST_ENTRIES) return { ok: false, error: `Error: ${field} has ${value.length.toLocaleString("en-US")} entries; at most ${MAX_DOMAIN_LIST_ENTRIES.toLocaleString("en-US")} are accepted` };
  if (value.some((v) => typeof v !== "string")) return { ok: false, error: `Error: every entry of ${field} must be a string` };
  const strings = (value as string[]).filter((v) => v.trim().length > 0);
  return { ok: true, value: strings.length > 0 ? strings : undefined };
}

/**
 * The query is validated, searched and rendered RAW -- never trimmed. Measured against the pinned
 * binary: a two-space query is ACCEPTED there, searched as-is, and its header reads
 * `Web search results for query: "  "`; the only length rule is the schema's `minLength: 2` on the
 * string the model actually sent. (A blank `objective` is the search client's own concern: it falls
 * back to the per-call query, and is backend plumbing rather than interface.)
 *
 * `Error: Missing query` is a real string in claude's binary that NO input can reach there: claude
 * validates a call against the tool's input schema BEFORE the tool's own validation, so a short or
 * absent query is refused by the schema (`InputValidationError: [...]`) and every string that passes
 * the schema also passes this check. This runtime has no schema-validation step in front of its
 * executors, so here the same text IS reachable, as the backstop for exactly the inputs claude's
 * schema refuses. It stops being reachable the day such a step exists.
 */
function parseInput(raw: unknown): ParsedInput {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const query = typeof record["query"] === "string" ? record["query"] : "";
  if (query.length < 2) return { ok: false, error: "Error: Missing query" };
  const allowedList = stringArray("allowed_domains", record["allowed_domains"]);
  if (!allowedList.ok) return { ok: false, error: allowedList.error };
  const blockedList = stringArray("blocked_domains", record["blocked_domains"]);
  if (!blockedList.ok) return { ok: false, error: blockedList.error };
  const allowed = allowedList.value;
  const blocked = blockedList.value;
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

/**
 * The inner pass's user prompt: the outer query, and the results of the search the runtime already ran
 * for it. Winter-authored (a PROMPT, never an interface string). The hits sit in the USER turn rather
 * than a synthetic assistant `tool_use` + `tool_result` pair: a replayed assistant tool call carries no
 * thinking block, which a thinking-enabled model rejects as a malformed tool loop.
 */
function seededPrompt(query: string, hits: string): string {
  return [
    `Perform a web search for the query: ${query}`,
    "",
    `A search for exactly that query has already been run. Its results:`,
    "",
    hits,
    "",
    `Answer the query from these results. If they are not enough, call ${INNER_SEARCH_TOOL_NAME} with a different query before answering.`,
  ].join("\n");
}

/** The step id the runtime's own seed search is recorded under. Never a model-minted id, so it can never collide with one. */
const SEED_SEARCH_STEP_ID = "winter-seed-search";

// --- failure text ----------------------------------------------------------------------------------

// A SESSION-BUDGET stop (`maxBudgetUsd`, checked between every inner generation, independent of this
// tool's own 200-call budget) arrives as the inner helper's existing `aborted` code with the helper's
// own exported `detail` constant -- matched through that constant, never a re-spelled literal.
function isBudgetStop(failure: InnerModelFailure): boolean {
  return failure.code === "aborted" && failure.detail === INNER_MODEL_BUDGET_EXCEEDED_DETAIL;
}

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
      // A BUDGET STOP is a normal, session-initiated boundary (the same posture as the 200-call
      // refusal, `_search-budget.ts`'s own `webSearchBudgetRefusalText`) -- distinct wording, and
      // NEVER `isError` (see the call site below), so the model is told plainly why no more searches
      // ran rather than reading a generic interrupt it might reasonably retry. A genuine external
      // interruption (the turn's own abort signal) keeps its own, separate wording.
      return isBudgetStop(failure)
        ? "Web search stopped: this session has reached its spending limit, so no further searches will run. Continue with the information already gathered."
        : "Web search was interrupted.";
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

    // --- the session's search wiring -- checked BEFORE the budget is touched --------------------------
    //
    // ORDERING FIX (independent review): a call against an unwired or disabled session has ZERO
    // chance of ever running a search, so it must not spend budget either -- the session cap is a
    // count of calls that COULD have searched, not of calls that merely asked. Only input validation
    // (above) and this wiring/enablement check run before the reservation now.
    const runtime: WebSessionRuntime | undefined = webSessionRuntimeFor(ctx);
    if (runtime === undefined) {
      return { output: "Error: web search is not available for this session (no search runtime is wired up for it -- a host wiring gap, not an input error).", isError: true };
    }
    if (!searchBackendUsable(runtime)) {
      return { output: "Web search is turned off for this session." };
    }

    // --- the session's own budget (counted BEFORE the search runs; see `_search-budget.ts`) --------
    const brand = deps.brand ?? ctx.brand ?? WINTER_BRAND;
    const env = ctx.env ?? process.env;
    const cap = resolveMaxWebSearchesPerSession(env, brand);
    const reservation = reserveWebSearchCall(ctx.sessionId, cap);
    if (!reservation.ok) return { output: webSearchBudgetRefusalText(reservation.used, reservation.cap, brand) };

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

    // A session already past its spending limit runs NOTHING -- not the seed search, not the inner
    // pass. The same plain, non-error wording the inner pass's own budget stop produces.
    let overBudget = false;
    try {
      overBudget = runtime.budgetExceeded?.() === true;
    } catch {
      overBudget = false;
    }
    if (overBudget) return { output: innerFailureText({ ok: false, code: "aborted", message: "", detail: INNER_MODEL_BUDGET_EXCEEDED_DETAIL, steps: [], toolCalls: 0 }) };

    const outcomes = new Map<string, ExaSearchResult>();
    /** The seed search's step, recorded ahead of the inner pass's own (stream order). */
    const seedSteps: InnerModelStep[] = [];

    let pass;
    try {
      // The session's Exa client -- its own construction is synchronous and never connects (a
      // connection happens lazily, inside `.search()`), so it cannot throw today. It is built INSIDE
      // this try/catch anyway: "this executor never throws" must not depend on a file this lane does
      // not own (`_exa-session-client.ts` / `_exa-client.ts`) staying that way forever.
      const resolveKey = exaKeyResolverFor(runtime);
      const client = exaSearchClientForSession(ctx.sessionId, () =>
        createExaSearchClient({
          ...(resolveKey !== undefined ? { resolveKey } : {}),
          blockedDomains: runtime.web.blockedDomains,
          state: backendState,
          ...deps.exaClientOptions,
        }),
      );
      // The TOMBSTONE (whole-branch review MINOR 6): this session's search client was closed by the
      // root run's teardown, so nothing may open another one -- a still-running child on a torn-down
      // session would otherwise build a connection nobody ever closes. An ordinary error RESULT, never
      // a throw: a child whose parent has gone away is told plainly and finishes its own turn.
      if (client === undefined) {
        return { output: "Error: web search is no longer available: this session's search backend was closed when the session ended.", isError: true };
      }

      const search = (searchQuery: string, signal: AbortSignal | undefined): Promise<ExaSearchResult> =>
        client.search(
          {
            query: searchQuery,
            // The EXECUTOR supplies `objective`, always the OUTER query -- never the inner model's
            // own per-call query -- so every inner search stays on-task (briefed explicitly; the
            // inner model is never given a way to set this itself).
            objective: query,
            numResults: EXA_DEFAULT_NUM_RESULTS,
            ...(allowed_domains !== undefined ? { includeDomains: allowed_domains } : {}),
            ...(blocked_domains !== undefined ? { excludeDomains: blocked_domains } : {}),
          },
          signal !== undefined ? { signal } : {},
        );

      // --- the SEED search: the tool's own input, run by the runtime, before any model call ------------
      const seed = await search(query, ctx.signal);
      outcomes.set(SEED_SEARCH_STEP_ID, seed);
      seedSteps.push({ kind: "tool_call", toolUseId: SEED_SEARCH_STEP_ID, input: { query }, output: seed.ok ? compactHitsForInnerModel(seed.hits) : seed.message, isError: !seed.ok, executed: true });
      if (ctx.signal?.aborted === true) return { output: "Web search was interrupted.", isError: true };
      // A FAILED seed has nothing for a model to read: the pass is skipped and the failure is reported
      // exactly as a failed inner search always was (the `search_error` item plus its guidance, below).
      if (seed.ok) {
        const handler: InnerToolHandler = async (rawToolInput, info) => {
          const toolQuery = typeof rawToolInput === "object" && rawToolInput !== null && typeof (rawToolInput as Record<string, unknown>)["query"] === "string" ? ((rawToolInput as Record<string, unknown>)["query"] as string) : query;
          const result = await search(toolQuery, info.signal);
          outcomes.set(info.toolUseId, result);
          if (!result.ok) return { output: `Error: the search failed (${result.code}): ${result.message}`, isError: true };
          return { output: compactHitsForInnerModel(result.hits) };
        };
        // The seed is call 1 of this call's cap; the model's own follow-ups get the rest. A cap the
        // seed already spent leaves a single, tool-less generation: read the results and answer.
        const followUps = maxToolCalls - 1;
        const prompt = seededPrompt(query, compactHitsForInnerModel(seed.hits));
        const system = "You are an assistant for performing a web search tool use";
        pass =
          followUps >= 1
            ? await runInnerModel(ctx, { system, prompt, tool: { name: INNER_SEARCH_TOOL_NAME, description: INNER_SEARCH_TOOL_DESCRIPTION, inputSchema: INNER_SEARCH_TOOL_SCHEMA }, maxToolCalls: followUps, handler })
            : await runInnerModel(ctx, { system, prompt });
      }
    } catch (err) {
      // `runInnerModel` is documented never to throw for an expected failure; a genuine bug here
      // still must not end the whole turn -- the NAME only, never the message (it is unvetted).
      return { output: `Error: web search failed unexpectedly (${err instanceof Error ? err.name : "unknown error"}).`, isError: true };
    }

    // --- claude-shaped events, built from the seed search and the inner pass's own ordered steps -----
    const events: WebSearchStreamEvent[] = [];
    let successfulSearches = 0;
    let attemptedSearches = 0;
    let lastFailureMessage: string | undefined;
    for (const step of [...seedSteps, ...((pass?.steps ?? []) as readonly InnerModelStep[])]) {
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
    //
    // WS-23: the seed search always runs first, so `attemptedSearches` is never zero here and the old
    // "Web search was not performed" arm (a model that never called the tool) is unreachable by
    // construction -- it is gone rather than kept as dead text.
    if (pass !== undefined && !pass.ok) {
      // `\n\n` because the stream walk ACCUMULATES adjacent text with no separator of its own (claude's
      // own rule, for claude's own deltas): a pass whose last commentary was "done" rendered
      // "doneWeb search stopped: ..." (whole-branch review, NIT). The walk trims each flushed buffer,
      // so the prefix costs nothing when there is no preceding text.
      events.push({ type: "text", text: `\n\n${innerFailureText(pass)}` });
    }

    // Every ATTEMPTED search failed: the terse per-item `Web search error: <code>` strings are
    // already in `events` (claude-shaped fidelity), but Winter's own backend errors carry actionable
    // guidance (e.g. "add an Exa API key") claude's never needs to -- surfaced ONCE, plainly, rather
    // than leaving the model to infer it from a bare code.
    if (attemptedSearches > 0 && successfulSearches === 0 && lastFailureMessage !== undefined) {
      events.push({ type: "text", text: `\n\n${lastFailureMessage}` });
    }

    // Capped by DROPPING ITEMS, never by slicing the finished string -- a raw slice chops from the
    // END, which is exactly where the REMINDER footer lives (review fix; see
    // `renderWebSearchToolResultCapped`'s own header).
    return { output: assembleWebSearchOutputCapped(query, events, resultCap) };
  }

  return { execute };
}

replaceExecutor(WEB_SEARCH_CANONICAL_NAME, createWebSearchExecutor());
