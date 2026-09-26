// WebSearch executor tests. `withExaFixture` stands in for Exa's hosted backend; the inner pass's
// own model is a `scriptedProvider` double reached through a hand-registered `WebSessionRuntime`
// (never a real `runEngine`, matching `_inner-model.test.ts`'s own unit-level convention -- the
// engine-level "usage lands in the turn" claim is THAT file's, not this one's).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { resolveWebToolsConfig, type ResolvedWebToolsConfig } from "@yanlinglabs/winter-agent-sdk";
import "./web-search.ts";
import { createWebSearchExecutor, MAX_DOMAIN_LIST_ENTRIES, WEB_SEARCH_RESULT_CAP } from "./web-search.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { registerWebSessionRuntime, resetWebSessionRuntimesForTest, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { scriptedProvider } from "../../provider/mock.ts";
import type { Provider, ProviderRequest, ProviderTurn } from "../../engine.ts";
import { maxWebSearchesPerSessionEnvName, resetWebSearchBudgetForTest, webSearchBudgetRefusalText, webSearchCallsUsed } from "./_search-budget.ts";
import { createExaBackendState, type ExaBackendState } from "./_exa-client.ts";
import { advancedPayload, basicPayload, tooManyRequests, withExaFixture, type ExaFixture } from "./_exa-fixture.test-support.ts";
import { resetExaSessionClientsForTest } from "./_exa-session-client.ts";
import { INNER_MODEL_BUDGET_EXCEEDED_DETAIL } from "./_inner-model.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider } from "../../provider/session-provider.ts";
import { fakeAnthropicCatalog, startAnthropicFake } from "../../provider/anthropic-fake.test-support.ts";

const SESSION_MODEL_KEY = "prova/session-model";

// WS-23: HERMETIC BY CONSTRUCTION. The seed search runs before any model call, so a case that forgot
// its fixture would reach Exa's real endpoint; every request in this file must stay on loopback.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") throw new Error(`hermetic test file: refused a request to ${target.origin}`);
    return await realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  resetWebSessionRuntimesForTest();
  resetWebSearchBudgetForTest();
  resetExaSessionClientsForTest();
});

function makeCtx(sessionId: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId,
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...overrides,
  };
}

function runtimeWith(sessionId: string, provider: Provider, over: Partial<WebSessionRuntime> = {}, webConfig?: Parameters<typeof resolveWebToolsConfig>[0]): WebSessionRuntime {
  const web: ResolvedWebToolsConfig = resolveWebToolsConfig(webConfig);
  const runtime: WebSessionRuntime = { web, sessionModel: () => ({ provider, model: SESSION_MODEL_KEY }), accountUsage() {}, ...over };
  registerWebSessionRuntime(sessionId, runtime);
  return runtime;
}

interface RunDeps {
  fixture?: ExaFixture;
  state?: ExaBackendState;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Run the module's own REGISTERED singleton (proves real wiring). Only for a call that returns before any search -- the singleton points at Exa's real endpoint. */
  singleton?: true;
}

/**
 * Runs the executor: the registered singleton when asked (`singleton`), else a fresh instance pointed at
 * the fixture -- a DEFAULT one when the caller names none.
 *
 * WS-23: HERMETIC BY DEFAULT. The seed search now runs from the tool's own input BEFORE any model call,
 * so a call that used to be answered by a scripted model without searching now searches -- and the
 * singleton would take that to Exa's real endpoint.
 */
async function run(input: unknown, ctx: ToolExecutionContext, deps: RunDeps = {}): Promise<ToolResultPayload> {
  if (deps.singleton === true) {
    const executor = getRegisteredTool("WebSearch")!.executor!;
    return executor.execute(input, ctx);
  }
  if (deps.fixture === undefined) return await withExaFixture({}, async (fixture) => run(input, ctx, { ...deps, fixture }));
  const executor = createWebSearchExecutor({
    ...(deps.state !== undefined ? { backendState: deps.state } : {}),
    exaClientOptions: { endpoint: deps.fixture.endpoint, ...(deps.state !== undefined ? { state: deps.state } : {}), ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}) },
  });
  return executor.execute(input, ctx);
}

const call = (id: string, query: string): { id: string; name: string; input: unknown } => ({ id, name: "web_search", input: { query } });

// =====================================================================================================
// Validation -- claude's own two errors, verbatim; the session budget is untouched by either.
// =====================================================================================================

describe("validation", () => {
  test("Error: Missing query -- absent, non-string, empty and length-1 all fold to the same text", async () => {
    const ctx = makeCtx("v-missing");
    for (const query of [undefined, 7, "", "a", " "]) {
      expect(await run({ query }, ctx)).toEqual({ output: "Error: Missing query", isError: true });
    }
  });

  test("the query is never trimmed: a two-space query is ACCEPTED, searched and rendered raw (claude's own measured behaviour)", async () => {
    await withExaFixture({}, async (fixture) => {
      const ctx = makeCtx("v-raw-query");
      const seen: string[] = [];
      const inner = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "spaces")] }, { kind: "text", text: "done" }]);
      const provider: Provider = {
        generate(input) {
          const first = input.messages[0]?.content;
          seen.push(typeof first === "string" ? first : JSON.stringify(first));
          return inner.generate(input);
        },
      };
      runtimeWith("v-raw-query", provider);
      const result = await run({ query: "  " }, ctx, { fixture });
      expect(result.isError).toBeUndefined();
      expect(result.output.startsWith('Web search results for query: "  "\n')).toBe(true);
      expect(seen[0]).toContain("Perform a web search for the query:   ");
      // A padded query keeps its padding too -- nothing between the model and the header rewrites it.
      runtimeWith("v-raw-query", scriptedProvider([{ kind: "tool_use", calls: [call("c2", "padded")] }, { kind: "text", text: "done" }]));
      expect((await run({ query: " a " }, ctx, { fixture })).output.startsWith('Web search results for query: " a "\n')).toBe(true);
    });
  });

  test("Error: Cannot specify both allowed_domains and blocked_domains in the same request", async () => {
    const ctx = makeCtx("v-both-lists");
    const result = await run({ query: "bun release", allowed_domains: ["a.example"], blocked_domains: ["b.example"] }, ctx);
    expect(result).toEqual({ output: "Error: Cannot specify both allowed_domains and blocked_domains in the same request", isError: true });
  });

  // Whole-branch review, NIT + MINOR 10: a domain list is model-supplied and reaches a third-party
  // backend. A wrong TYPE used to read as "absent", i.e. the search ran UNFILTERED -- the one direction
  // that is never safe to guess -- and a 100,000-element list was forwarded whole.
  test("a wrong-typed domain list is REFUSED, never quietly ignored (which would search unfiltered)", async () => {
    const ctx = makeCtx("v-wrong-typed-list");
    for (const value of ["a.example", 7, true, { "0": "a.example" }]) {
      expect(await run({ query: "bun release", allowed_domains: value }, ctx)).toEqual({ output: "Error: allowed_domains must be an array of domain strings", isError: true });
      expect(await run({ query: "bun release", blocked_domains: value }, ctx)).toEqual({ output: "Error: blocked_domains must be an array of domain strings", isError: true });
    }
    // An array with a non-string entry is refused too -- filtering it out is the same silent guess.
    expect(await run({ query: "bun release", allowed_domains: ["a.example", 7] }, ctx)).toEqual({ output: "Error: every entry of allowed_domains must be a string", isError: true });
    // An explicit EMPTY array, and one of only blank strings, still read as "absent": they filter nothing.
    expect((await run({ query: "bun release", allowed_domains: [] }, ctx)).output).not.toContain("must be an array");
    expect((await run({ query: "bun release", allowed_domains: ["  "] }, ctx)).output).not.toContain("must be an array");
  });

  test("an absurdly long domain list is refused rather than forwarded to the backend", async () => {
    const ctx = makeCtx("v-huge-list");
    const huge = Array.from({ length: MAX_DOMAIN_LIST_ENTRIES + 1 }, (_, i) => `d${i}.example`);
    const result = await run({ query: "bun release", blocked_domains: huge }, ctx);
    expect(result).toEqual({ output: `Error: blocked_domains has 1,001 entries; at most 1,000 are accepted`, isError: true });
    // The bound itself is not off by one: exactly the cap is accepted.
    expect((await run({ query: "bun release", blocked_domains: huge.slice(0, MAX_DOMAIN_LIST_ENTRIES) }, ctx)).output).not.toContain("entries; at most");
  });

  test("validation failures never touch the session's search budget (no runtime needs to be wired for them to fail correctly)", async () => {
    const ctx = makeCtx("v-no-budget-spend");
    await run({ query: "" }, ctx);
    await run({ query: "a" }, ctx);
    await run({ query: "x", allowed_domains: ["a"], blocked_domains: ["b"] }, ctx);
    await run({ query: "x", allowed_domains: "a" }, ctx);
    expect(webSearchCallsUsed("v-no-budget-spend")).toBe(0);
  });
});

// =====================================================================================================
// Wiring gaps -- typed results, never a throw.
// =====================================================================================================

describe("wiring", () => {
  test("no web session runtime registered -> a typed error result, and the budget is NEVER touched (ordering fix: wiring is checked before the reservation)", async () => {
    const result = await run({ query: "hello world" }, makeCtx("w-not-wired"), { singleton: true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no search runtime is wired up");
    expect(webSearchCallsUsed("w-not-wired")).toBe(0);
  });

  test("the search backend turned off for this session -> a plain (non-error) refusal, and the budget is NEVER touched", async () => {
    const ctx = makeCtx("w-disabled");
    runtimeWith("w-disabled", scriptedProvider([]), {}, { search: { enabled: false } });
    const result = await run({ query: "hello world" }, ctx, { singleton: true });
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Web search is turned off for this session.");
    expect(webSearchCallsUsed("w-disabled")).toBe(0);
  });

  test("the executor never throws -- even when the inner pass itself throws unexpectedly (sessionModel() exploding)", async () => {
    const ctx = makeCtx("w-throws");
    const runtime: WebSessionRuntime = {
      web: resolveWebToolsConfig(undefined),
      sessionModel: () => {
        throw new Error("boom - sessionModel exploded, this text must never reach the model");
      },
      accountUsage() {},
    };
    registerWebSessionRuntime("w-throws", runtime);
    const result = await run({ query: "hello world" }, ctx);
    // WS-23: the seed search ran before the model was ever asked for, so its links are kept and the
    // failure is appended as a sentence -- the thrown message itself never is.
    expect(result.output).toContain("Links: ");
    expect(result.output).toContain("could not be resolved");
    expect(result.output).not.toContain("boom");
    expect(result.output).not.toContain("exploded");
  });
});

// =====================================================================================================
// A multi-search pass: order, fidelity (title+url only), domain lists, "No links found.".
// =====================================================================================================

describe("a real pass against the Exa fixture", () => {
  test("WS-23: the SEED search runs from the tool's own input before any model call -- nothing is forced, the model answers from the results it was handed, and highlights never reach the outer model", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-multi");
      const requests: ProviderRequest[] = [];
      const scripted = scriptedProvider([
        { kind: "tool_use", calls: [call("c1", "bun 1.4 changelog")], text: "Let me check the changelog too." },
        { kind: "text", text: "Bun 1.4 fixed two known regressions." },
      ]);
      const provider: Provider = { generate: (input) => (requests.push(input), scripted.generate(input)) };
      runtimeWith("p-multi", provider);
      const result = await run({ query: "bun 1.4 release notes" }, ctx, { fixture, state });
      expect(result.isError).toBeUndefined();
      // The seed is the fixture's FIRST call, on the outer query itself; the model's follow-up is second.
      expect(fixture.calls.map((c) => c.args["query"])).toEqual(["bun 1.4 release notes", "bun 1.4 changelog"]);
      // No round is forced: every inner request's choice is `auto`.
      expect(requests.map((r) => r.toolChoice)).toEqual([{ type: "auto" }, { type: "auto" }]);
      // The seed's results are in the model's FIRST prompt -- highlight included (the INNER model may read it).
      expect(JSON.stringify(requests[0]!.messages)).toContain("This release fixes two regressions.");
      expect(result.output).toContain('Web search results for query: "bun 1.4 release notes"');
      expect(result.output).toContain("Let me check the changelog too.");
      expect(result.output).toContain("Bun 1.4 fixed two known regressions.");
      expect(result.output).toContain("Links: ");
      expect(result.output).toContain("REMINDER: You MUST include the sources above");
      // The default fixture payload's own highlight text must never leak into the outer model's output.
      expect(result.output).not.toContain("This release fixes two regressions.");
      const linksMatch = result.output.match(/Links: (\[.*\])\n/);
      expect(linksMatch).not.toBeNull();
      const links = JSON.parse(linksMatch![1]!) as Array<Record<string, unknown>>;
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(Object.keys(link).sort()).toEqual(["title", "url"]);
      expect(fixture.calls[0]!.tool).toBe("web_search_exa"); // no domain filters -> the plain tool
    });
  });

  test("a zero-hit search renders `No links found.`", async () => {
    await withExaFixture({ respond: () => advancedPayload([]) }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-empty");
      const provider = scriptedProvider([{ kind: "text", text: "nothing found" }]);
      runtimeWith("p-empty", provider);
      const result = await run({ query: "an obscure query" }, ctx, { fixture, state });
      expect(result.output).toContain("No links found.");
    });
  });

  test("allowed_domains routes to the advanced tool; the host's blocked-domain floor is filtered OUT of what reaches Exa", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-domains");
      const provider = scriptedProvider([{ kind: "text", text: "done" }]);
      runtimeWith("p-domains", provider, {}, { blockedDomains: ["blocked.example"] });
      await run({ query: "qq", allowed_domains: ["good.example", "blocked.example"] }, ctx, { fixture, state });
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.calls[0]!.tool).toBe("web_search_advanced_exa");
      expect(fixture.calls[0]!.args["includeDomains"]).toEqual(["good.example"]);
      expect(fixture.calls[0]!.args["excludeDomains"]).toBeUndefined();
    });
  });

  test("blocked_domains reaches EVERY inner search alongside the host's own floor", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-domains-2");
      // The seed search plus ONE model follow-up: both must carry the caller's list and the floor.
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "q1")] }, { kind: "text", text: "done" }]);
      runtimeWith("p-domains-2", provider, {}, { blockedDomains: ["floor.example"] });
      await run({ query: "qq", blocked_domains: ["caller.example"] }, ctx, { fixture, state });
      expect(fixture.calls).toHaveLength(2);
      for (const c of fixture.calls) {
        expect(c.tool).toBe("web_search_advanced_exa");
        expect((c.args["excludeDomains"] as string[]).sort()).toEqual(["caller.example", "floor.example"]);
      }
    });
  });

  test("every allowed domain is blocked by the floor -> no network call at all, and the failure is surfaced as a search-error item", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-domains-all-blocked");
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "qq")] }, { kind: "text", text: "done" }]);
      runtimeWith("p-domains-all-blocked", provider, {}, { blockedDomains: ["blocked.example"] });
      const result = await run({ query: "qq", allowed_domains: ["blocked.example"] }, ctx, { fixture, state });
      expect(fixture.calls).toHaveLength(0);
      expect(result.output).toContain("Web search error: blocked-domains");
    });
  });

  test("a backend error mid-pass becomes `Web search error: <code>` for that one search; the pass continues and still reports the successful one", async () => {
    let n = 0;
    await withExaFixture(
      {
        respond: () => {
          n += 1;
          return n === 1 ? basicPayload([{ title: "A", url: "https://a.example/", highlights: "hi" }]) : { content: [{ type: "text", text: "an internal backend hiccup" }], isError: true };
        },
      },
      async (fixture) => {
        const state = createExaBackendState();
        const ctx = makeCtx("p-mid-fail");
        // Search 1 is the seed (succeeds); search 2 is the model's follow-up (fails).
        const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c2", "q2")] }, { kind: "text", text: "done" }]);
        runtimeWith("p-mid-fail", provider);
        const result = await run({ query: "q1" }, ctx, { fixture, state });
        expect(result.output).toContain("Links: ");
        expect(result.output).toContain("Web search error: backend-error");
      },
    );
  });

  test("a query containing the literal words 'quota' and '429' does not trip the anonymous breaker when the backend answers NORMALLY", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-query-quota-429");
      const query = "what is the 429 quota policy for this API";
      const provider = scriptedProvider([{ kind: "text", text: "done" }]);
      runtimeWith("p-query-quota-429", provider);
      const result = await run({ query }, ctx, { fixture, state });
      expect(state.anonymousRateLimitedAt).toBeUndefined();
      expect(result.output).toContain("Links: ");
    });
  });
});

// =====================================================================================================
// The per-call cap: 3 (anonymous) vs 8 (keyed, once the breaker is open).
// =====================================================================================================

describe("the per-call search cap", () => {
  function manySearchTurns(n: number): ProviderTurn[] {
    const turns: ProviderTurn[] = Array.from({ length: n }, (_, i) => ({ kind: "tool_use", calls: [call(`c${i}`, `q${i}`)] }));
    turns.push({ kind: "text", text: "done" });
    return turns;
  }

  test("anonymous tier, breaker closed -> capped at anonymousMaxSearchesPerCall (3)", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("cap-anon");
      runtimeWith("cap-anon", scriptedProvider(manySearchTurns(10)));
      await run({ query: "qq" }, ctx, { fixture, state, sleep: async () => {} });
      expect(fixture.calls).toHaveLength(3);
    });
  });

  test("breaker OPEN and a key configured -> capped at maxSearchesPerCall (8), every call on the key", async () => {
    await withExaFixture({}, async (fixture) => {
      const state: ExaBackendState = { anonymousRateLimitedAt: Date.now(), nextAnonymousCallAt: 0 };
      const ctx = makeCtx("cap-key");
      runtimeWith("cap-key", scriptedProvider(manySearchTurns(10)), { resolveToolSecret: async () => ({ status: "found", key: "exa-test-key" }) }, { search: { authRef: { kind: "env", name: "WINTER_TEST_EXA_KEY" } } });
      await run({ query: "qq" }, ctx, { fixture, state, sleep: async () => {} });
      expect(fixture.calls).toHaveLength(8);
      expect(fixture.calls.every((c) => c.apiKey === "exa-test-key")).toBe(true);
    });
  });

  test("breaker OPEN with NO key configured -> still the anonymous cap (3); the disclosed edge, every call fails fast as quota-exhausted", async () => {
    await withExaFixture({}, async (fixture) => {
      const state: ExaBackendState = { anonymousRateLimitedAt: Date.now(), nextAnonymousCallAt: 0 };
      const ctx = makeCtx("cap-open-no-key");
      runtimeWith("cap-open-no-key", scriptedProvider(manySearchTurns(10)));
      const result = await run({ query: "qq" }, ctx, { fixture, state, sleep: async () => {} });
      expect(fixture.calls).toHaveLength(0); // never touches the network: quota-exhausted short-circuits
      expect(result.output).toContain("Web search error: quota-exhausted");
    });
  });
});

// =====================================================================================================
// Quota exhausted, with and without a key.
// =====================================================================================================

describe("quota exhausted", () => {
  test("no key configured -> a typed, actionable result naming how to fix it -- never an error, never a throw", async () => {
    await withExaFixture({ gate: () => tooManyRequests() }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("q-no-key");
      runtimeWith("q-no-key", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]));
      const result = await run({ query: "qq" }, ctx, { fixture, state });
      expect(result.isError).toBeUndefined();
      expect(result.output.toLowerCase()).toContain("key");
      expect(result.output.toLowerCase()).toContain("add");
      expect(result.output).toContain("Web search error: quota-exhausted");
    });
  });

  test("a key IS configured -> falls through to the key tier automatically, no manual retry needed", async () => {
    await withExaFixture({ gate: (req) => (req.apiKey === null ? tooManyRequests() : undefined) }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("q-with-key");
      runtimeWith("q-with-key", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]), { resolveToolSecret: async () => ({ status: "found", key: "exa-key-1" }) }, { search: { authRef: { kind: "env", name: "WINTER_TEST_EXA_KEY" } } });
      const result = await run({ query: "qq" }, ctx, { fixture, state });
      expect(result.output).toContain("Links: ");
      expect(result.output).not.toContain("Web search error");
    });
  });
});

function call1Turn(): ProviderTurn {
  return { kind: "tool_use", calls: [call("c1", "qq")] };
}

// =====================================================================================================
// Zero successful searches -- reported honestly, never dressed up as results.
// =====================================================================================================

describe("zero successful searches", () => {
  test("every attempted search failed -> the result says so plainly, with actionable guidance, never a fabricated summary", async () => {
    await withExaFixture({ respond: () => ({ content: [{ type: "text", text: "an internal backend hiccup" }], isError: true }) }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("zero-fail");
      runtimeWith("zero-fail", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]));
      const result = await run({ query: "qq" }, ctx, { fixture, state });
      expect(result.output).toContain("Web search error: backend-error");
      expect(result.output).not.toContain("Links: ");
    });
  });

  // Whole-branch review, NIT: the stream walk accumulates adjacent text with NO separator (claude's own
  // rule for claude's own deltas), so Winter's appended sentence ran straight into the model's last
  // word -- "doneWeb search error guidance...".
  test("an appended failure sentence is separated from the model's own trailing text, never glued to it", async () => {
    // The seed succeeds; the model writes "done" beside a follow-up call, and round 2's generate()
    // fails (the script is spent) -- the pass's failure sentence must not run into "done".
    const ctx = makeCtx("zero-fail-separator");
    runtimeWith("zero-fail-separator", scriptedProvider([{ kind: "tool_use", calls: [call("c1", "qq")], text: "done" }]));
    const result = await run({ query: "qq" }, ctx);
    expect(result.output).toContain("done\n\n");
    expect(result.output).not.toMatch(/done\S/);
  });

  test("WS-23: a model that never calls the inner tool STILL yields a real search -- the seed's links, and its own answer read from them (the old 'Web search was not performed' outcome is gone)", async () => {
    await withExaFixture({}, async (fixture) => {
      const ctx = makeCtx("zero-no-call");
      const requests: ProviderRequest[] = [];
      const scripted = scriptedProvider([{ kind: "text", text: "From the results: two regressions were fixed." }]);
      runtimeWith("zero-no-call", { generate: (input) => (requests.push(input), scripted.generate(input)) });
      const result = await run({ query: "hello world" }, ctx, { fixture });
      expect(fixture.calls).toHaveLength(1);
      expect(result.output).toContain("Links: ");
      expect(result.output).toContain("From the results: two regressions were fixed.");
      expect(result.output).not.toContain("not performed");
      expect(JSON.stringify(requests[0]!.messages)).toContain("This release fixes two regressions.");
    });
  });

  test("REGRESSION: a pass that FAILS outright after only text/unknown-tool steps surfaces the real failure -- after the seed search it already ran, which is kept", async () => {
    const ctx = makeCtx("zero-fail-with-text");
    // Round 1: leading text + an unknown-tool-name call. Only ONE turn is scripted, so round 2's
    // generate() throws "no more scripted turns" -- the inner pass fails outright (`pass.ok === false`,
    // code "provider-error"). The seed search is real, so its links stay and the failure is APPENDED
    // (a completed search is never discarded -- the same rule as a budget stop), not a bare error.
    runtimeWith("zero-fail-with-text", scriptedProvider([{ kind: "tool_use", calls: [{ id: "u1", name: "NotWebSearch", input: {} }], text: "Let me check." }]));
    const result = await run({ query: "hello world" }, ctx);
    expect(result.output).toContain("Links: ");
    expect(result.output).toContain("the web search failed");
    expect(result.output).not.toContain("not performed");
  });
});

// =====================================================================================================
// The session cap: counted before running, shared with a child, exact refusal text, env override.
// =====================================================================================================

describe("the session cap (200 by default)", () => {
  // ONE fixture per test: a session's search client is cached per session id, so every call of one
  // session must reach the same backend.
  test("counted BEFORE the search runs: a validation failure spends nothing, a real call spends one", async () => {
    await withExaFixture({}, async (fixture) => {
      const ctx = makeCtx("cap-order");
      runtimeWith("cap-order", scriptedProvider([{ kind: "text", text: "answered from the seed" }]));
      await run({ query: "" }, ctx, { fixture });
      expect(webSearchCallsUsed("cap-order")).toBe(0);
      await run({ query: "hello world" }, ctx, { fixture });
      expect(webSearchCallsUsed("cap-order")).toBe(1);
    });
  });

  test("SHARED with a child: the child's own call counts against the identical session id", async () => {
    await withExaFixture({}, async (fixture) => {
      runtimeWith("cap-shared", scriptedProvider([{ kind: "text", text: "a" }, { kind: "text", text: "b" }]));
      const parentCtx = makeCtx("cap-shared");
      const childCtx = makeCtx("cap-shared", { agentId: "child-1" }); // same sessionId, distinct agentId
      await run({ query: "from the parent" }, parentCtx, { fixture });
      await run({ query: "from the child" }, childCtx, { fixture });
      expect(webSearchCallsUsed("cap-shared")).toBe(2);
    });
  });

  test("the refusal is the exact verbatim text, as a plain RESULT (never isError)", async () => {
    await withExaFixture({}, async (fixture) => {
      const ctx = makeCtx("cap-refusal", { env: { [maxWebSearchesPerSessionEnvName()]: "1" } });
      runtimeWith("cap-refusal", scriptedProvider([{ kind: "text", text: "a" }]));
      const first = await run({ query: "first" }, ctx, { fixture });
      expect(first.isError).toBeUndefined();
      const second = await run({ query: "second" }, ctx, { fixture });
      expect(second).toEqual({ output: webSearchBudgetRefusalText(1, 1) });
      // A THIRD call reads the SAME "1 of 1" -- the refusal never increments its own counter.
      const third = await run({ query: "third" }, ctx, { fixture });
      expect(third).toEqual({ output: webSearchBudgetRefusalText(1, 1) });
    });
  });

  test("the env override is branded and effective", async () => {
    await withExaFixture({}, async (fixture) => {
      const ctx = makeCtx("cap-env", { env: { [maxWebSearchesPerSessionEnvName()]: "2" } });
      runtimeWith("cap-env", scriptedProvider([{ kind: "text", text: "a" }, { kind: "text", text: "b" }]));
      await run({ query: "one" }, ctx, { fixture });
      await run({ query: "two" }, ctx, { fixture });
      const third = await run({ query: "three" }, ctx, { fixture });
      expect(third.output).toContain("2 of 2");
    });
  });
});

// =====================================================================================================
// Abort mid-pass, and usage accounting.
// =====================================================================================================

describe("abort and usage", () => {
  test("abort mid-pass: interrupted cleanly, no fabricated results, the executor never throws", async () => {
    let release: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await withExaFixture({ respond: async () => (await hang, basicPayload([{ title: "A", url: "https://a.example/", highlights: "" }])) }, async (fixture) => {
        const state = createExaBackendState();
        const controller = new AbortController();
        const ctx = makeCtx("abort-mid", { signal: controller.signal });
        runtimeWith("abort-mid", scriptedProvider([call1Turn(), { kind: "text", text: "unreachable, aborted before this" }]));
        const pending = run({ query: "qq" }, ctx, { fixture, state });
        await new Promise((r) => setTimeout(r, 30));
        controller.abort();
        const result = await pending;
        expect(result.isError).toBe(true);
        expect(result.output.toLowerCase()).toContain("interrupt");
      });
    } finally {
      release?.();
    }
  });

  test("inner generations' usage reaches the runtime's accountUsage, keyed under the session model", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const accounted: Array<{ key: string | undefined; usage: unknown }> = [];
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [call("c1", "qq")], usage: { inputTokens: 50, outputTokens: 5 } },
        { kind: "text", text: "done", usage: { inputTokens: 20, outputTokens: 2 } },
      ]);
      const ctx = makeCtx("usage");
      runtimeWith("usage", provider, { accountUsage: (key, usage) => void accounted.push({ key, usage }) });
      await run({ query: "qq" }, ctx, { fixture, state });
      expect(accounted).toEqual([
        { key: SESSION_MODEL_KEY, usage: { inputTokens: 50, outputTokens: 5 } },
        { key: SESSION_MODEL_KEY, usage: { inputTokens: 20, outputTokens: 2 } },
      ]);
    });
  });
});

// =====================================================================================================
// The SESSION's own spend ceiling (`maxBudgetUsd`), reported by the fixed spine as `runInnerModel`'s
// existing "aborted" code with `detail: "budget-exceeded"` -- distinct wording from a genuine
// interrupt, never `isError`, and whatever searches completed before the ceiling is kept and returned.
// =====================================================================================================

describe("a session budget stop (distinct from a genuine abort)", () => {
  test("the budget-stop detail is matched through `_inner-model.ts`'s exported constant, never a re-spelled literal", async () => {
    const source = await Bun.file(new URL("./web-search.ts", import.meta.url)).text();
    expect(source).toContain("INNER_MODEL_BUDGET_EXCEEDED_DETAIL");
    expect(source).not.toContain(`"${INNER_MODEL_BUDGET_EXCEEDED_DETAIL}"`);
  });

  test("already over budget -> a plain, non-error result naming the spending limit, never the generic interrupt wording -- and NO search runs at all", async () => {
    await withExaFixture({}, async (fixture) => {
    const ctx = makeCtx("budget-from-start");
    runtimeWith("budget-from-start", scriptedProvider([{ kind: "text", text: "unreachable -- the budget check runs before the seed search" }]), { budgetExceeded: () => true });
    const result = await run({ query: "hello world" }, ctx, { fixture });
    expect(fixture.calls).toHaveLength(0);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Web search stopped: this session has reached its spending limit, so no further searches will run. Continue with the information already gathered.");
    expect(result.output.toLowerCase()).not.toContain("interrupt");
    });
  });

  test("over budget AFTER one search already succeeded -> the completed search is kept and returned, with the budget note appended, never discarded", async () => {
    let exceeded = false;
    await withExaFixture(
      {
        respond: (call) => {
          // Flips AS A SIDE EFFECT of the first search (the SEED) actually completing -- so the
          // executor's own pre-search check still passes, and it is the inner pass's check before its
          // first generation that stops it: "one search already ran, then the ceiling was crossed."
          exceeded = true;
          return basicPayload([{ title: "A", url: "https://a.example/", highlights: "hi" }]);
        },
      },
      async (fixture) => {
        const state = createExaBackendState();
        const ctx = makeCtx("budget-after-one");
        const provider = scriptedProvider([{ kind: "text", text: "unreachable -- the inner pass's budget check stops it before this generation runs" }]);
        runtimeWith("budget-after-one", provider, { budgetExceeded: () => exceeded });
        const result = await run({ query: "qq" }, ctx, { fixture, state });
        expect(result.isError).toBeUndefined();
        expect(result.output).toContain("Links: ");
        expect(result.output).toContain("A");
        expect(result.output).toContain("spending limit");
        expect(result.output).not.toContain("unreachable");
      },
    );
  });
});

// =====================================================================================================
// The result cap.
// =====================================================================================================

describe("the result cap", () => {
  // Twenty hits per search (Exa's own `EXA_MAX_NUM_RESULTS`), each near the client's own per-hit
  // ceilings (title capped at 300, a URL rejected outright past 2,000) -- three such searches
  // comfortably clears `WEB_SEARCH_RESULT_CAP` (100,000) so the cap actually engages.
  const bigHits = Array.from({ length: 20 }, (_, i) => ({ title: "t".repeat(400), url: `https://big.example/${"y".repeat(1960)}/${i}` }));

  test("a result over the cap is capped by DROPPING ITEMS -- never by slicing the finished string -- so the header and the REMINDER footer always survive", async () => {
    await withExaFixture({ respond: () => advancedPayload(bigHits) }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("cap-result");
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "qq")] }, { kind: "tool_use", calls: [call("c2", "qq")] }, { kind: "tool_use", calls: [call("c3", "qq")] }, { kind: "text", text: "done" }]);
      runtimeWith("cap-result", provider);
      const result = await run({ query: "qq" }, ctx, { fixture, state });
      // Proves the cap actually engaged (the uncapped render would be far larger than this).
      expect(result.output.length).toBeLessThanOrEqual(WEB_SEARCH_RESULT_CAP);
      expect(result.output.length).toBeGreaterThan(1_000);
      expect(result.output.startsWith('Web search results for query: "qq"')).toBe(true);
      expect(result.output.endsWith("REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.")).toBe(true);
    });
  });

  // Whole-branch review, NIT: the header is the one part of the render the cap cannot drop, so an
  // enormous QUERY defeated the cap outright -- every item could go and the result was still megabytes.
  test("a megabyte-long query cannot defeat the cap: the header's copy of it is bounded", async () => {
    await withExaFixture({}, async (fixture) => {
      const ctx = makeCtx("cap-huge-query");
      const query = "q".repeat(1_000_000);
      runtimeWith("cap-huge-query", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]));
      const result = await run({ query }, ctx, { fixture });
      expect(result.output.length).toBeLessThanOrEqual(WEB_SEARCH_RESULT_CAP);
      expect(result.output).toContain("[query truncated at 1,000 characters]");
      // An ordinary query is still rendered RAW and whole -- the bound is far past any real one.
      runtimeWith("cap-huge-query", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]));
      expect((await run({ query: "bun release notes" }, ctx, { fixture })).output.startsWith('Web search results for query: "bun release notes"')).toBe(true);
    });
  });

  test("a cap small enough to force EVERY item out still keeps the header and the REMINDER -- the one floor this cannot drop below", async () => {
    await withExaFixture({ respond: () => advancedPayload(bigHits) }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("cap-result-tiny");
      runtimeWith("cap-result-tiny", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]));
      const executor = createWebSearchExecutor({ resultCap: 10, exaClientOptions: { endpoint: fixture.endpoint, state } });
      const result = await executor.execute({ query: "qq" }, ctx);
      expect(result.output).toBe('Web search results for query: "qq"\n\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.');
    });
  });
});

// =====================================================================================================
// The generation bound is now a CONTRACT (fixed spine, `sdk/web-tools-integration`): an unknown-tool-
// name call never advances `toolCalls`, so the loop is bounded in GENERATIONS too
// (`maxToolCalls + 2`), and a tool_use turn with an EMPTY calls array is terminal on the spot. Both
// are asserted at their EXACT shape -- a provider that repeats forever, a generation counter, and the
// precise result the executor returns -- rather than "it eventually stops".
// =====================================================================================================

describe("the generation bound is exact", () => {
  test("an inner model that names an unknown tool EVERY round terminates at exactly (cap - seed) + 2 generations, and the seed's real search is still reported", async () => {
    const ctx = makeCtx("bound-unknown-tool");
    let generations = 0;
    const provider: Provider = {
      async generate() {
        generations += 1;
        return { kind: "tool_use", calls: [{ id: `u${generations}`, name: "NotWebSearch", input: {} }] };
      },
    };
    // The default anonymous per-call cap is 3 (no key, no breaker override); the seed spends one, so the
    // inner pass's own bound is 2 -> maxGenerations = 2 + 2 = 4.
    runtimeWith("bound-unknown-tool", provider);
    const result = await run({ query: "hello world" }, ctx);
    expect(generations).toBe(4);
    expect(result.output).toContain("Links: ");
  });

  test("an inner model that emits an EMPTY calls array is terminal on round 1 -- exactly one generation", async () => {
    const ctx = makeCtx("bound-empty-calls");
    let generations = 0;
    const provider: Provider = {
      async generate() {
        generations += 1;
        return { kind: "tool_use", calls: [] };
      },
    };
    runtimeWith("bound-empty-calls", provider);
    const result = await run({ query: "hello world" }, ctx);
    expect(generations).toBe(1);
    expect(result.output).toContain("Links: ");
  });
});

// =====================================================================================================
// WS-23: WebSearch on the model that broke it -- the REAL Anthropic adapter, the compiled catalog's
// own `claude-opus-5-5` row (forced tool_choice is a documented 400 there; thinking cannot be off).
// =====================================================================================================

describe("WS-23: WebSearch on Opus 5.5, through the real Anthropic adapter", () => {
  test("the search RUNS (seeded), its results reach the model's request, nothing is forced, and the answer comes back in today's output shape", async () => {
    const anthropic = await startAnthropicFake(() => ({ blocks: [{ type: "text", text: "Opus read the results: two regressions fixed." }], stopReason: "end_turn" }));
    const realFetch = globalThis.fetch;
    // Hermetic: the only endpoints this test may reach are its two loopback fakes.
    let exaUrl = "";
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!target.startsWith(anthropic.url) && (exaUrl === "" || !target.startsWith(new URL(exaUrl).origin))) throw new Error(`hermetic fixture: refused ${new URL(target).origin}`);
      return await realFetch(input, init);
    }) as typeof fetch;
    try {
      await withExaFixture({}, async (fixture) => {
        exaUrl = fixture.endpoint;
        const config = {
          sessionId: "ws23-opus55-search",
          cwd: "/tmp/ws23",
          model: "anthropic/claude-opus-5-5",
          persistSession: false,
          provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: anthropic.url, local: true } },
        } as RuntimeConfig;
        const wiring = buildSessionProvider({ config, env: {}, catalog: fakeAnthropicCatalog(anthropic.url, ["anthropic/claude-opus-5-5"]), credentials: createMemoryCredentialStore() });
        const ctx = makeCtx("ws23-opus55-search");
        // The live model is the session's own catalog KEY, exactly as production's engine carries it;
        // the bridge translates it to the wire id.
        runtimeWith("ws23-opus55-search", wiring.provider, { sessionModel: () => ({ provider: wiring.provider, model: "anthropic/claude-opus-5-5" }) });
        const result = await run({ query: "bun 1.4 release notes" }, ctx, { fixture });

        // The search ran, on the tool's own input.
        expect(fixture.calls.map((c) => c.args["query"])).toEqual(["bun 1.4 release notes"]);
        // The model was asked ONCE, with the results in its user turn, and nothing forced.
        expect(anthropic.requests).toHaveLength(1);
        const body = anthropic.requests[0]!.body;
        expect(body["model"]).toBe("claude-opus-5-5");
        expect(body["tool_choice"]).toEqual({ type: "auto" });
        expect(JSON.stringify(body["messages"])).toContain("This release fixes two regressions.");
        // Thinking cannot be off on this row: the inner pass's `disabled` rides as adaptive + block binding.
        expect(body["thinking"]).toMatchObject({ type: "adaptive" });
        // Today's output shape: header, the links (title+url only), the model's text, the REMINDER.
        expect(result.isError).toBeUndefined();
        expect(result.output.startsWith('Web search results for query: "bun 1.4 release notes"')).toBe(true);
        expect(result.output).toContain("Links: ");
        expect(result.output).toContain("Opus read the results: two regressions fixed.");
        expect(result.output).not.toContain("This release fixes two regressions.");
        expect(result.output).not.toContain("not performed");
        expect(result.output.endsWith("REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.")).toBe(true);
      });
    } finally {
      globalThis.fetch = realFetch;
      await anthropic.close();
    }
  });
});
