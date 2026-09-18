// WebSearch OUTPUT ASSEMBLY, differentially: the pinned `claude` binary and Winter's own pure
// assembler are handed the SAME scripted inner-search response, and the tool_result STRING each
// builds from it must be byte-identical.
//
// How the official side is driven. claude's WebSearch makes an INNER Messages call carrying the
// server tool `web_search_20250305`, then assembles that response's `text` / `server_tool_use` /
// `web_search_tool_result` blocks into one string. The loopback therefore plays three roles, told
// apart by CONTENT, never by arrival order:
//   - the MAIN model's first turn: ONE assistant message carrying every scenario's `WebSearch`
//     tool_use at once (the tool is concurrency-safe, so one spawn covers the whole table);
//   - each INNER request (recognised by the server tool in its tool list), routed by the query in
//     its user text to that scenario's scripted block stream;
//   - the FOLLOWING main-loop request (it carries tool_results), answered with a closing text turn.
// The tool's PURE output is read from the binary's own stdout `user` frame; the following request's
// tool_result is ALSO checked, allowing exactly the one suffix the main loop itself appends to a
// tool_result on the wire (see `MAIN_LOOP_WIRE_SUFFIX`).
//
// Winter's side is the pure assembler fed the same sequence in its own event shape -- no engine, no
// search backend: the assembler was written to be diffed exactly like this. Winter's EXECUTOR is
// reached only where the comparison needs it (the two input-validation errors, and the inner pass's
// system/user prompt text).
//
// Every assertion states ONE contract for both sides. A difference is a finding to report, never a
// reason to loosen the assertion or to touch the tool.
//
// KNOWN RED as of 2026-09-18 (findings, reported -- the assertions are deliberately left strict; a red
// here is NOT a broken harness). Every assembly scenario and every inner-request assertion is green.
//   - [one-character-query] / [empty-query]: the binary's SCHEMA (`minLength: 2`) refuses these before
//     the tool's own validation runs, with `InputValidationError: [...] "Too small: expected string to
//     have >=2 characters"`; Winter answers `Error: Missing query`. (That text was never observed from
//     the binary for any string input: the schema refuses the short ones and the tool ACCEPTS the rest.)
//     Red until Winter has a schema-validation step in front of its executors at all -- it has none,
//     for any tool, so `Error: Missing query` is Winter's reachable backstop for these inputs.
//
// GATED (`RUN_OFFICIAL_CAPTURE=1`) like every file in this family; permission mode
// `bypassPermissions`, as everywhere else here. See `web-tools-script.ts` for the hermeticity guard.
import { describe, test, expect } from "bun:test";
import { resolvePinnedClaudeBinary, sseResponse, sseTextTurn, sseToolUseTurn, OFFICIAL_MODEL, CLAUDE_VERSION, type RawFrame } from "./differential-harness.ts";
import {
  runOfficialOnce,
  sseInnerSearchTurn,
  toWinterEvents,
  isInnerSearchRequest,
  firstUserText,
  hasToolResult,
  toolResultsFromFrames,
  toolResultsFromRequest,
  wireMatchesPure,
  INNER_SEARCH_USER_PREFIX,
  type OfficialRun,
  type OfficialToolResult,
  type ScriptedSearchBlock,
} from "./web-tools-script.ts";
// Relative imports straight into the sibling package's source -- the same door (and the same reason:
// no package.json edge, which would be a cycle) as every other differential file here.
import { assembleWebSearchOutput, flushWebSearchStream } from "../../../runtime/src/tools/impl/_web-search-assembler.ts";
import { createWebSearchExecutor } from "../../../runtime/src/tools/impl/web-search.ts";
import { registerWebSessionRuntime, resetWebSessionRuntimesForTest } from "../../../runtime/src/web/session-runtime.ts";
import type { ToolExecutionContext } from "../../../runtime/src/tools/registry.ts";
import type { Provider, ProviderRequest } from "../../../runtime/src/engine.ts";
import { resolveWebToolsConfig } from "../../../sdk/src/index.ts";

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

// --- the scenario table -----------------------------------------------------------------------------

interface Scenario {
  id: string;
  what: string;
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  blocks: ScriptedSearchBlock[];
}

const EXTRA = { page_age: "3 days ago", encrypted_content: "RW5jcnlwdGVkQ29udGVudEJsb2I=", snippet: "a snippet that must never survive" };

const SCENARIOS: Scenario[] = [
  { id: "text-only", what: "text only, no search at all", query: "differential text only", blocks: [{ kind: "text", text: "I could not find anything worth searching for." }] },
  {
    id: "one-search-extra-fields",
    what: "one search with hits, each carrying EXTRA fields -- only title and url may survive",
    query: "differential one search",
    blocks: [
      {
        kind: "search",
        query: "one search",
        hits: [
          { title: "First hit", url: "https://a.example/first", extra: EXTRA },
          { title: "Second hit", url: "https://b.example/second?x=1&y=2#frag", extra: { ...EXTRA, page_age: null } },
        ],
      },
    ],
  },
  {
    id: "text-before-between-after",
    what: "text BEFORE a search, BETWEEN searches and AFTER the last",
    query: "differential interleaved text",
    blocks: [
      { kind: "text", text: "I'll search for this now." },
      { kind: "search", query: "first", hits: [{ title: "One", url: "https://a.example/1" }] },
      { kind: "text", text: "That was thin; let me try another angle." },
      { kind: "search", query: "second", hits: [{ title: "Two", url: "https://a.example/2" }] },
      { kind: "text", text: "Based on both searches, here is the summary.\n\nIt spans two paragraphs." },
    ],
  },
  { id: "zero-hits", what: "a search with ZERO hits", query: "differential zero hits", blocks: [{ kind: "search", query: "nothing", hits: [] }] },
  {
    id: "two-searches-back-to-back",
    what: "two searches back to back with no text between",
    query: "differential back to back",
    blocks: [
      { kind: "search", query: "a", hits: [{ title: "A", url: "https://a.example/a" }] },
      { kind: "search", query: "b", hits: [{ title: "B", url: "https://a.example/b" }] },
    ],
  },
  { id: "error-block", what: "a result block carrying an error", query: "differential error block", blocks: [{ kind: "search_error", query: "boom", errorCode: "too_many_requests" }] },
  {
    id: "error-then-hits-then-empty",
    what: "an error, a search with hits and an empty search in one response",
    query: "differential mixed outcomes",
    blocks: [
      { kind: "search_error", query: "boom", errorCode: "max_uses_exceeded" },
      { kind: "search", query: "ok", hits: [{ title: "Recovered", url: "https://a.example/ok" }] },
      { kind: "search", query: "none", hits: [] },
    ],
  },
  {
    id: "whitespace-only-text",
    what: "whitespace-only text before, between and after blocks -- flushed only when the TRIMMED buffer is non-empty",
    query: "differential whitespace only",
    blocks: [
      { kind: "text", text: " \n\t " },
      { kind: "search", query: "a", hits: [{ title: "A", url: "https://a.example/a" }] },
      { kind: "text", text: "\n\n   \n" },
      { kind: "search", query: "b", hits: [{ title: "B", url: "https://a.example/b" }] },
      { kind: "text", text: "  \t" },
    ],
  },
  {
    id: "padded-text",
    what: "text with leading/trailing whitespace around real content (trimmed at the flush), and interior whitespace kept",
    query: "differential padded text",
    blocks: [
      { kind: "text", text: "\n\n  Leading and trailing padding.  \n" },
      { kind: "search", query: "a", hits: [{ title: "A", url: "https://a.example/a" }] },
      { kind: "text", text: "  interior   spacing\n\n\nand blank lines survive \n " },
    ],
  },
  {
    id: "adjacent-text-blocks",
    what: "two ADJACENT text blocks with no search between -- accumulated with no separator",
    query: "differential adjacent text",
    blocks: [
      { kind: "text", text: "first half, " },
      { kind: "text", text: "second half" },
      { kind: "search", query: "a", hits: [{ title: "A", url: "https://a.example/a" }] },
      { kind: "text", text: "tail one." },
      { kind: "text", text: " tail two." },
    ],
  },
  {
    id: "unicode-and-quotes",
    what: "unicode, quotes, backslashes and control characters in titles and urls -- compact JSON.stringify escaping",
    query: "differential unicode titles",
    blocks: [
      {
        kind: "search",
        query: "unicode",
        hits: [
          { title: 'She said "hello" \\ and left', url: "https://a.example/quotes?q=%22x%22" },
          { title: "Café — naïve 日本語 🚀", url: "https://a.example/café/日本" },
          { title: "line one\nline two\ttabbed sep </script> & <b>", url: "https://a.example/ctl" },
          { title: "", url: "" },
        ],
      },
      { kind: "text", text: 'A "quoted" remark — with ünicode.' },
    ],
  },
  {
    id: "quotes-in-query",
    what: "quotes in the QUERY itself -- the header interpolates it raw, unescaped",
    query: 'differential "quoted" query \\ with ünicode',
    blocks: [{ kind: "search", query: "q", hits: [{ title: "Q", url: "https://a.example/q" }] }],
  },
  {
    id: "allowed-domains",
    what: "allowed_domains only (the inner request's domain list)",
    query: "differential allowed domains",
    allowed_domains: ["a.example", "docs.b.example"],
    blocks: [{ kind: "search", query: "a", hits: [{ title: "A", url: "https://a.example/a" }] }],
  },
  {
    id: "blocked-domains",
    what: "blocked_domains only (the inner request's domain list)",
    query: "differential blocked domains",
    blocked_domains: ["spam.example"],
    blocks: [{ kind: "search", query: "a", hits: [{ title: "A", url: "https://a.example/a" }] }],
  },
];

// Input-validation cases: no inner request is ever made for these.
interface ValidationCase {
  id: string;
  input: Record<string, unknown>;
}
const VALIDATION: ValidationCase[] = [
  { id: "both-domain-lists", input: { query: "differential both lists", allowed_domains: ["a.example"], blocked_domains: ["b.example"] } },
  { id: "one-character-query", input: { query: "x" } },
  { id: "empty-query", input: { query: "" } },
];

/** A model the pinned binary's own catalog marks as rejecting `thinking: disabled`. */
const LEAN_TIER_MODEL = "claude-fable-5";

// A query of two spaces: long enough for the binary's schema (`minLength: 2`), and blank once trimmed.
const WHITESPACE_QUERY = "  ";
const WHITESPACE_ID = "whitespace-query";
const WHITESPACE_BLOCKS: ScriptedSearchBlock[] = [{ kind: "search", query: "blank", hits: [{ title: "Blank", url: "https://a.example/blank" }] }];

const toolUseIdFor = (id: string): string => `toolu_ws_${id.replace(/[^a-z0-9]/gi, "_")}`;

// --- the OFFICIAL side: one spawn for the whole table -------------------------------------------------

let captured: Promise<OfficialRun> | undefined;
function official(): Promise<OfficialRun> {
  captured ??= runOfficialOnce({
    binaryPath: "binaryPath" in resolved ? resolved.binaryPath : "",
    prompt: "run the scripted searches",
    logPrefix: "websearch official",
    route(messages, body) {
      if (isInnerSearchRequest(body)) {
        const query = firstUserText(body).slice(INNER_SEARCH_USER_PREFIX.length);
        if (query === WHITESPACE_QUERY) return sseResponse(sseInnerSearchTurn(WHITESPACE_BLOCKS));
        const scenario = SCENARIOS.find((s) => s.query === query);
        return sseResponse(scenario ? sseInnerSearchTurn(scenario.blocks) : sseTextTurn(`UNSCRIPTED inner query: ${query}`));
      }
      if (hasToolResult(messages)) return sseResponse(sseTextTurn("done"));
      return sseResponse(
        sseToolUseTurn([
          ...SCENARIOS.map((s) => ({
            id: toolUseIdFor(s.id),
            name: "WebSearch",
            input: { query: s.query, ...(s.allowed_domains ? { allowed_domains: s.allowed_domains } : {}), ...(s.blocked_domains ? { blocked_domains: s.blocked_domains } : {}) },
          })),
          ...VALIDATION.map((v) => ({ id: toolUseIdFor(v.id), name: "WebSearch", input: v.input })),
          { id: toolUseIdFor(WHITESPACE_ID), name: "WebSearch", input: { query: WHITESPACE_QUERY } },
        ]),
      );
    },
  });
  return captured;
}

function innerRequestFor(run: OfficialRun, scenario: Scenario): RawFrame | undefined {
  return run.requests.find((r) => isInnerSearchRequest(r) && firstUserText(r) === INNER_SEARCH_USER_PREFIX + scenario.query);
}

function officialResult(run: OfficialRun, id: string): OfficialToolResult {
  const result = toolResultsFromFrames(run.frames).get(toolUseIdFor(id));
  if (result === undefined) throw new Error(`the binary emitted no tool_result frame for ${toolUseIdFor(id)} -- the harness script is broken, or the tool never ran`);
  return result;
}

// --- the WINTER side ---------------------------------------------------------------------------------

function minimalCtx(sessionId: string): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId,
    readState: { readFiles: new Map() } as unknown as ToolExecutionContext["readState"],
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
  } as ToolExecutionContext;
}

/** Runs Winter's real executor far enough to see the inner pass's FIRST provider request (the provider answers with plain text, so no search backend is ever reached). */
async function winterInnerRequest(query: string): Promise<ProviderRequest> {
  const sessionId = `websearch-differential-${crypto.randomUUID()}`;
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async generate(input) {
      requests.push(input);
      return { kind: "text", text: "no search", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  registerWebSessionRuntime(sessionId, { web: resolveWebToolsConfig(undefined), sessionModel: () => ({ provider, model: "prova/session-model" }), accountUsage() {} });
  try {
    await createWebSearchExecutor().execute({ query }, minimalCtx(sessionId));
  } finally {
    resetWebSessionRuntimesForTest();
  }
  if (requests.length === 0) throw new Error("Winter's WebSearch executor made no inner provider request");
  return requests[0]!;
}

function flatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as Array<{ text?: unknown }>).map((b) => (typeof b.text === "string" ? b.text : "")).join("");
  return "";
}

// --- the differential tests ----------------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(`WebSearch output assembly: Winter's assembler vs pinned ${CLAUDE_VERSION} claude${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  test(
    "the scripted run is hermetic and complete: nothing left the box, and every scenario got its own inner request",
    async () => {
      const run = await official();
      expect(run.trapHits, "nothing may try to leave the box").toEqual([]);
      const innerQueries = run.requests.filter(isInnerSearchRequest).map((r) => firstUserText(r).slice(INNER_SEARCH_USER_PREFIX.length)).sort();
      // (The whitespace-only query is its own test below; whether it reaches the inner call is that test's subject.)
      expect(innerQueries.filter((q) => q !== WHITESPACE_QUERY), "one inner request per scenario, none for a validation failure").toEqual(SCENARIOS.map((s) => s.query).sort());
    },
    180_000,
  );

  for (const scenario of SCENARIOS) {
    test(
      `[${scenario.id}] ${scenario.what}: the tool_result string is byte-identical`,
      async () => {
        const run = await official();
        const result = officialResult(run, scenario.id);
        const winter = assembleWebSearchOutput(scenario.query, toWinterEvents(scenario.blocks));
        console.log(`\n--- [${scenario.id}] official ---\n${JSON.stringify(result.content)}\n--- [${scenario.id}] winter ---\n${JSON.stringify(winter)}`);

        expect(result.isError, "a completed search is never an error result").toBe(false);
        expect(winter).toBe(result.content);

        // The STRUCTURED intermediate: claude's `results` list (tool_use_id aside, which Winter's
        // item shape deliberately does not carry) against Winter's stream walk.
        const structured = result.structured as { query?: unknown; results?: unknown[] } | undefined;
        expect(structured?.query).toBe(scenario.query);
        const officialItems = (structured?.results ?? []).map((item) => (typeof item === "string" ? item : { content: (item as { content?: unknown }).content }));
        expect(JSON.stringify(flushWebSearchStream(toWinterEvents(scenario.blocks)))).toBe(JSON.stringify(officialItems));

        // What went back to the API in the FOLLOWING main-loop request: the same string, plus at
        // most the main loop's own wire suffix.
        const following = run.requests.find((r) => !isInnerSearchRequest(r) && toolResultsFromRequest(r).has(toolUseIdFor(scenario.id)));
        expect(following, "a following main-loop request must carry this call's tool_result").toBeDefined();
        const wire = toolResultsFromRequest(following!).get(toolUseIdFor(scenario.id))!;
        expect(wireMatchesPure(wire, winter), `the wire tool_result must be Winter's string (plus at most the main loop's own suffix) -- got ${JSON.stringify(wire)}`).toBe(true);
      },
      180_000,
    );
  }

  test(
    "only `title` and `url` survive a hit, on BOTH sides -- no extra field reaches the model in any form",
    async () => {
      const run = await official();
      const scenario = SCENARIOS.find((s) => s.id === "one-search-extra-fields")!;
      const winter = assembleWebSearchOutput(scenario.query, toWinterEvents(scenario.blocks));
      for (const [label, text] of [["official", officialResult(run, scenario.id).content], ["winter", winter]] as const) {
        for (const leaked of ["page_age", "encrypted_content", "snippet", EXTRA.encrypted_content, EXTRA.page_age, EXTRA.snippet]) {
          expect(text.includes(leaked), `${label}: ${JSON.stringify(leaked)} must not appear in the tool_result`).toBe(false);
        }
      }
      expect(JSON.stringify(officialResult(run, scenario.id).structured).includes("encrypted_content"), "official: the structured result drops it too").toBe(false);
    },
    180_000,
  );

  // --- the INNER REQUEST the binary sends --------------------------------------------------------------

  for (const scenario of SCENARIOS) {
    test(
      `[${scenario.id}] the inner request: model, system, user message, server tool (max_uses + domain lists), forced tool choice`,
      async () => {
        const run = await official();
        const inner = innerRequestFor(run, scenario);
        expect(inner, "the binary must have made an inner search request for this query").toBeDefined();
        const body = inner!;

        // The MAIN LOOP model, not a small-fast one.
        expect(body.model).toBe(OFFICIAL_MODEL);

        // system: the SDK's two standing preamble blocks, then the search prompt as the LAST block;
        // no cache marker on any of them (no prompt caching on this call).
        const system = body.system as Array<{ type?: unknown; text?: unknown; cache_control?: unknown }>;
        expect(Array.isArray(system)).toBe(true);
        expect(system.length).toBe(3);
        expect(String(system[0]!.text)).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.250\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/);
        expect(system[1]!.text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
        expect(system[2]!.text).toBe("You are an assistant for performing a web search tool use");
        expect(system.some((b) => b.cache_control !== undefined), "no cache_control on the inner system").toBe(false);

        // user message: ONE message, a one-block content array.
        expect(JSON.stringify(body.messages)).toBe(JSON.stringify([{ role: "user", content: [{ type: "text", text: `Perform a web search for the query: ${scenario.query}` }] }]));

        // the server tool: exactly these keys, in this order; a domain list that was not supplied is
        // ABSENT (not null, not []); `user_location` is never sent.
        const expectedTool = {
          type: "web_search_20250305",
          name: "web_search",
          ...(scenario.allowed_domains ? { allowed_domains: scenario.allowed_domains } : {}),
          ...(scenario.blocked_domains ? { blocked_domains: scenario.blocked_domains } : {}),
          max_uses: 8,
        };
        expect(JSON.stringify(body.tools)).toBe(JSON.stringify([expectedTool]));

        // forced tool choice, thinking disabled -- for a model that ACCEPTS disabled thinking (this
        // one does; see the separate test below for one that does not).
        expect(JSON.stringify(body.tool_choice)).toBe(JSON.stringify({ type: "tool", name: "web_search" }));
        expect(JSON.stringify(body.thinking)).toBe(JSON.stringify({ type: "disabled" }));
        expect(body.max_tokens).toBe(32000);
        expect(body.temperature).toBe(1);
        expect(body.stream).toBe(true);
        expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "metadata", "model", "stream", "system", "temperature", "thinking", "tool_choice", "tools"]);
      },
      180_000,
    );
  }

  test(
    "Winter's inner pass opens with the SAME system prompt and the SAME user message text as the binary's",
    async () => {
      const run = await official();
      const scenario = SCENARIOS.find((s) => s.id === "quotes-in-query")!;
      const officialInner = innerRequestFor(run, scenario)!;
      const winterInner = await winterInnerRequest(scenario.query);
      const officialSystem = (officialInner.system as Array<{ text?: unknown }>).at(-1)!.text;
      expect(flatText(winterInner.system)).toBe(String(officialSystem));
      expect(flatText(winterInner.messages[0]!.content)).toBe(firstUserText(officialInner));
    },
    180_000,
  );

  // --- a whitespace-only query: accepted or refused? ------------------------------------------------------
  test(
    "a whitespace-only query (two spaces): both sides make the SAME accept/refuse decision, and an accepted one renders the RAW query in the header",
    async () => {
      const run = await official();
      const result = officialResult(run, WHITESPACE_ID);
      const searched = run.requests.some((r) => isInnerSearchRequest(r) && firstUserText(r) === INNER_SEARCH_USER_PREFIX + WHITESPACE_QUERY);
      // Winter's executor runs against a WIRED session (as in `winterInnerRequest`): an unwired one is
      // refused for the missing wiring, which would say nothing about the INPUT decision under test.
      const sessionId = `websearch-whitespace-${crypto.randomUUID()}`;
      const winterPrompts: string[] = [];
      const provider: Provider = {
        async generate(input) {
          winterPrompts.push(flatText(input.messages[0]!.content));
          return { kind: "text", text: "no search", usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      registerWebSessionRuntime(sessionId, { web: resolveWebToolsConfig(undefined), sessionModel: () => ({ provider, model: "prova/session-model" }), accountUsage() {} });
      let winter;
      try {
        winter = await createWebSearchExecutor().execute({ query: WHITESPACE_QUERY }, minimalCtx(sessionId));
      } finally {
        resetWebSessionRuntimesForTest();
      }
      console.log(`\n--- [${WHITESPACE_ID}] official (isError=${result.isError}, searched=${searched}) ---\n${JSON.stringify(result.content)}\n--- winter executor (isError=${winter.isError === true}) ---\n${JSON.stringify(winter.output)}`);
      // The ASSEMBLER, given the raw query, reproduces whatever the binary rendered for it.
      if (searched) expect(assembleWebSearchOutput(WHITESPACE_QUERY, toWinterEvents(WHITESPACE_BLOCKS))).toBe(result.content);
      // The EXECUTOR's decision must match the binary's.
      expect(winter.isError === true, `the binary ${searched ? "ACCEPTED the query and searched" : "refused the query"}; Winter's executor must decide the same`).toBe(result.isError);
      // ...and an accepted query reaches Winter's inner pass exactly as it reached the binary's: RAW.
      expect(winterPrompts.length > 0, "Winter's executor must search exactly when the binary does").toBe(searched);
      if (searched) expect(winterPrompts[0]).toBe(INNER_SEARCH_USER_PREFIX + WHITESPACE_QUERY);
    },
    180_000,
  );

  // --- a model that REJECTS disabled thinking: the inner call is shaped differently -----------------------
  //
  // "Forced tool choice, thinking disabled" holds only for a model that accepts `thinking: disabled`.
  // For one that does not (the top tier), the binary cannot force the tool -- a forced tool choice is
  // incompatible with thinking -- so it sends `tool_choice: auto`, no `thinking` key, no `temperature`,
  // an `output_config.effort`, and the model's own larger `max_tokens`. The ASSEMBLY is unchanged.
  test(
    `a model that rejects disabled thinking (${LEAN_TIER_MODEL}): tool choice is AUTO, not forced -- and the assembled string is still byte-identical`,
    async () => {
      const scenario = SCENARIOS.find((s) => s.id === "text-before-between-after")!;
      const run = await runOfficialOnce({
        binaryPath: "binaryPath" in resolved ? resolved.binaryPath : "",
        model: LEAN_TIER_MODEL,
        prompt: "run the scripted search",
        logPrefix: "websearch official (top tier)",
        route(messages, body) {
          if (isInnerSearchRequest(body)) return sseResponse(sseInnerSearchTurn(scenario.blocks, LEAN_TIER_MODEL));
          if (hasToolResult(messages)) return sseResponse(sseTextTurn("done"));
          return sseResponse(sseToolUseTurn([{ id: toolUseIdFor(scenario.id), name: "WebSearch", input: { query: scenario.query } }]));
        },
      });
      expect(run.trapHits).toEqual([]);
      expect(assembleWebSearchOutput(scenario.query, toWinterEvents(scenario.blocks))).toBe(officialResult(run, scenario.id).content);

      const body = innerRequestFor(run, scenario)!;
      expect(body.model).toBe(LEAN_TIER_MODEL);
      expect((body.system as Array<{ text?: unknown }>).at(-1)!.text).toBe("You are an assistant for performing a web search tool use");
      expect(JSON.stringify(body.tools)).toBe(JSON.stringify([{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]));
      expect(JSON.stringify(body.tool_choice)).toBe(JSON.stringify({ type: "auto" }));
      expect("thinking" in body, "no `thinking` key at all for this model").toBe(false);
      expect("temperature" in body).toBe(false);
      expect(JSON.stringify(body.output_config)).toBe(JSON.stringify({ effort: "high" }));
      expect(body.max_tokens).toBe(64000);
    },
    180_000,
  );

  // --- input validation: no inner request, and the same error text -------------------------------------

  for (const v of VALIDATION) {
    test(
      `[${v.id}] input validation: the same refusal text on both sides, and no inner request`,
      async () => {
        const run = await official();
        const result = officialResult(run, v.id);
        const winter = await createWebSearchExecutor().execute(v.input, minimalCtx(`websearch-validation-${v.id}`));
        console.log(`\n--- [${v.id}] official (isError=${result.isError}) ---\n${JSON.stringify(result.content)}\n--- [${v.id}] winter (isError=${winter.isError === true}) ---\n${JSON.stringify(winter.output)}`);
        expect(run.requests.filter(isInnerSearchRequest).some((r) => firstUserText(r) === INNER_SEARCH_USER_PREFIX + String(v.input.query)), "a refused input never reaches the inner call").toBe(false);
        expect(result.isError).toBe(true);
        expect(winter.isError).toBe(true);
        // The binary's main loop wraps a refused call's text in its own error tag; the text INSIDE is
        // the tool's.
        expect(result.content).toBe(`<tool_use_error>${winter.output}</tool_use_error>`);
      },
      180_000,
    );
  }
});
