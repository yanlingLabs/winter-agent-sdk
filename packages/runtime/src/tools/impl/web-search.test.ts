// WebSearch executor tests. `withExaFixture` stands in for Exa's hosted backend; the inner pass's
// own model is a `scriptedProvider` double reached through a hand-registered `WebSessionRuntime`
// (never a real `runEngine`, matching `_inner-model.test.ts`'s own unit-level convention -- the
// engine-level "usage lands in the turn" claim is THAT file's, not this one's).
import { afterEach, describe, expect, test } from "bun:test";
import { resolveWebToolsConfig, type ResolvedWebToolsConfig } from "@yanlinglabs/winter-agent-sdk";
import "./web-search.ts";
import { createWebSearchExecutor, WEB_SEARCH_RESULT_CAP } from "./web-search.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { registerWebSessionRuntime, resetWebSessionRuntimesForTest, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { scriptedProvider } from "../../provider/mock.ts";
import type { Provider, ProviderTurn } from "../../engine.ts";
import { maxWebSearchesPerSessionEnvName, resetWebSearchBudgetForTest, webSearchBudgetRefusalText, webSearchCallsUsed } from "./_search-budget.ts";
import { createExaBackendState, type ExaBackendState } from "./_exa-client.ts";
import { advancedPayload, basicPayload, tooManyRequests, withExaFixture, type ExaFixture } from "./_exa-fixture.test-support.ts";
import { resetExaSessionClientsForTest } from "./_exa-session-client.ts";
import { INNER_MODEL_BUDGET_EXCEEDED_DETAIL } from "./_inner-model.ts";

const SESSION_MODEL_KEY = "prova/session-model";

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
}

/** Runs the executor: the module's own registered singleton when `deps` names no fixture (proves real wiring), else a fresh instance pointed at the fixture. */
async function run(input: unknown, ctx: ToolExecutionContext, deps: RunDeps = {}): Promise<ToolResultPayload> {
  if (deps.fixture === undefined) {
    const executor = getRegisteredTool("WebSearch")!.executor!;
    return executor.execute(input, ctx);
  }
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
  test("Error: Missing query -- absent, empty, whitespace-only and length-1 all fold to the same text", async () => {
    const ctx = makeCtx("v-missing");
    for (const query of [undefined, "", "   ", "a"]) {
      expect(await run({ query }, ctx)).toEqual({ output: "Error: Missing query", isError: true });
    }
  });

  test("Error: Cannot specify both allowed_domains and blocked_domains in the same request", async () => {
    const ctx = makeCtx("v-both-lists");
    const result = await run({ query: "bun release", allowed_domains: ["a.example"], blocked_domains: ["b.example"] }, ctx);
    expect(result).toEqual({ output: "Error: Cannot specify both allowed_domains and blocked_domains in the same request", isError: true });
  });

  test("validation failures never touch the session's search budget (no runtime needs to be wired for them to fail correctly)", async () => {
    const ctx = makeCtx("v-no-budget-spend");
    await run({ query: "" }, ctx);
    await run({ query: "a" }, ctx);
    await run({ query: "x", allowed_domains: ["a"], blocked_domains: ["b"] }, ctx);
    expect(webSearchCallsUsed("v-no-budget-spend")).toBe(0);
  });
});

// =====================================================================================================
// Wiring gaps -- typed results, never a throw.
// =====================================================================================================

describe("wiring", () => {
  test("no web session runtime registered -> a typed error result, and the budget is NEVER touched (ordering fix: wiring is checked before the reservation)", async () => {
    const result = await run({ query: "hello world" }, makeCtx("w-not-wired"));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no search runtime is wired up");
    expect(webSearchCallsUsed("w-not-wired")).toBe(0);
  });

  test("the search backend turned off for this session -> a plain (non-error) refusal, and the budget is NEVER touched", async () => {
    const ctx = makeCtx("w-disabled");
    runtimeWith("w-disabled", scriptedProvider([]), {}, { search: { enabled: false } });
    const result = await run({ query: "hello world" }, ctx);
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
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("boom");
    expect(result.output).not.toContain("exploded");
  });
});

// =====================================================================================================
// A multi-search pass: order, fidelity (title+url only), domain lists, "No links found.".
// =====================================================================================================

describe("a real pass against the Exa fixture", () => {
  test("round 1 is forced (the fixture receives a call even though the scripted model never chose to), results assemble in stream order, and highlights never reach the outer model", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-multi");
      const provider = scriptedProvider([
        { kind: "tool_use", calls: [call("c1", "bun 1.4 release notes")], text: "Let me check the release notes." },
        { kind: "text", text: "Bun 1.4 fixed two known regressions." },
      ]);
      runtimeWith("p-multi", provider);
      const result = await run({ query: "bun 1.4 release notes" }, ctx, { fixture, state });
      expect(result.isError).toBeUndefined();
      expect(result.output).toContain('Web search results for query: "bun 1.4 release notes"');
      expect(result.output).toContain("Let me check the release notes.");
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
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "an obscure query")] }, { kind: "text", text: "nothing found" }]);
      runtimeWith("p-empty", provider);
      const result = await run({ query: "an obscure query" }, ctx, { fixture, state });
      expect(result.output).toContain("No links found.");
    });
  });

  test("allowed_domains routes to the advanced tool; the host's blocked-domain floor is filtered OUT of what reaches Exa", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("p-domains");
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "qq")] }, { kind: "text", text: "done" }]);
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
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "q1")] }, { kind: "tool_use", calls: [call("c2", "q2")] }, { kind: "text", text: "done" }]);
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
        const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "q1")] }, { kind: "tool_use", calls: [call("c2", "q2")] }, { kind: "text", text: "done" }]);
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
      const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", query)] }, { kind: "text", text: "done" }]);
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

  test("the model never even called the tool (an adapter that ignores the forced round 1) -> a plain 'not performed' result, never the model's own commentary dressed up as search results", async () => {
    const ctx = makeCtx("zero-no-call");
    runtimeWith("zero-no-call", scriptedProvider([{ kind: "text", text: "I already know the answer without searching." }]));
    const result = await run({ query: "hello world" }, ctx);
    expect(result.output).toBe("Web search was not performed: the search pass produced no search calls.");
    expect(result.output).not.toContain("I already know");
  });

  test("REGRESSION: a pass with only text/unknown-tool steps that then FAILS outright must surface the real failure, never the generic 'not performed' message that would otherwise swallow it", async () => {
    const ctx = makeCtx("zero-fail-with-text");
    // Round 1: leading text + an unknown-tool-name call (attemptedSearches stays 0 -- neither is a
    // real search). Only ONE turn is scripted, so round 2's generate() throws "no more scripted
    // turns" -- the inner pass fails outright (`pass.ok === false`, code "provider-error") with
    // ONLY text-shaped events recorded. Before the fix, `attemptedSearches === 0 && events.every(text)`
    // fired regardless of `pass.ok` and replaced the real failure with the generic "not performed"
    // text, discarding the actual reason the pass never completed.
    runtimeWith("zero-fail-with-text", scriptedProvider([{ kind: "tool_use", calls: [{ id: "u1", name: "NotWebSearch", input: {} }], text: "Let me check." }]));
    const result = await run({ query: "hello world" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).not.toBe("Web search was not performed: the search pass produced no search calls.");
    expect(result.output).toContain("the web search failed");
  });
});

// =====================================================================================================
// The session cap: counted before running, shared with a child, exact refusal text, env override.
// =====================================================================================================

describe("the session cap (200 by default)", () => {
  test("counted BEFORE the search runs: a validation failure spends nothing, a real call spends one", async () => {
    const ctx = makeCtx("cap-order");
    runtimeWith("cap-order", scriptedProvider([{ kind: "text", text: "answered without searching" }]));
    await run({ query: "" }, ctx);
    expect(webSearchCallsUsed("cap-order")).toBe(0);
    await run({ query: "hello world" }, ctx);
    expect(webSearchCallsUsed("cap-order")).toBe(1);
  });

  test("SHARED with a child: the child's own call counts against the identical session id", async () => {
    runtimeWith("cap-shared", scriptedProvider([{ kind: "text", text: "a" }, { kind: "text", text: "b" }]));
    const parentCtx = makeCtx("cap-shared");
    const childCtx = makeCtx("cap-shared", { agentId: "child-1" }); // same sessionId, distinct agentId
    await run({ query: "from the parent" }, parentCtx);
    await run({ query: "from the child" }, childCtx);
    expect(webSearchCallsUsed("cap-shared")).toBe(2);
  });

  test("the refusal is the exact verbatim text, as a plain RESULT (never isError)", async () => {
    const ctx = makeCtx("cap-refusal", { env: { [maxWebSearchesPerSessionEnvName()]: "1" } });
    runtimeWith("cap-refusal", scriptedProvider([{ kind: "text", text: "a" }]));
    const first = await run({ query: "first" }, ctx);
    expect(first.isError).toBeUndefined();
    const second = await run({ query: "second" }, ctx);
    expect(second).toEqual({ output: webSearchBudgetRefusalText(1, 1) });
    // A THIRD call reads the SAME "1 of 1" -- the refusal never increments its own counter.
    const third = await run({ query: "third" }, ctx);
    expect(third).toEqual({ output: webSearchBudgetRefusalText(1, 1) });
  });

  test("the env override is branded and effective", async () => {
    const ctx = makeCtx("cap-env", { env: { [maxWebSearchesPerSessionEnvName()]: "2" } });
    runtimeWith("cap-env", scriptedProvider([{ kind: "text", text: "a" }, { kind: "text", text: "b" }]));
    await run({ query: "one" }, ctx);
    await run({ query: "two" }, ctx);
    const third = await run({ query: "three" }, ctx);
    expect(third.output).toContain("2 of 2");
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

  test("over budget from the very first generation -> a plain, non-error result naming the spending limit, never the generic interrupt wording", async () => {
    const ctx = makeCtx("budget-from-start");
    runtimeWith("budget-from-start", scriptedProvider([{ kind: "text", text: "unreachable -- the budget check runs before round 1's own generate()" }]), { budgetExceeded: () => true });
    const result = await run({ query: "hello world" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Web search stopped: this session has reached its spending limit, so no further searches will run. Continue with the information already gathered.");
    expect(result.output.toLowerCase()).not.toContain("interrupt");
  });

  test("over budget AFTER one search already succeeded -> the completed search is kept and returned, with the budget note appended, never discarded", async () => {
    let exceeded = false;
    await withExaFixture(
      {
        respond: (call) => {
          // Flips AS A SIDE EFFECT of the first search actually completing -- so round 1's own
          // budget check (before this call) still passes, and it is round 2's check that stops the
          // pass, reproducing "one search already ran, then the ceiling was crossed."
          exceeded = true;
          return basicPayload([{ title: "A", url: "https://a.example/", highlights: "hi" }]);
        },
      },
      async (fixture) => {
        const state = createExaBackendState();
        const ctx = makeCtx("budget-after-one");
        const provider = scriptedProvider([{ kind: "tool_use", calls: [call("c1", "qq")] }, { kind: "text", text: "unreachable -- round 2's own budget check stops the pass before this generation runs" }]);
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
  test("an inner model that names an unknown tool EVERY round terminates at exactly maxToolCalls + 2 generations, and the 'no successful search' honesty fires", async () => {
    const ctx = makeCtx("bound-unknown-tool");
    let generations = 0;
    const provider: Provider = {
      async generate() {
        generations += 1;
        return { kind: "tool_use", calls: [{ id: `u${generations}`, name: "NotWebSearch", input: {} }] };
      },
    };
    // The default anonymous per-call cap is 3 (no key, no breaker override) -> maxGenerations = 3 + 2 = 5.
    runtimeWith("bound-unknown-tool", provider);
    const result = await run({ query: "hello world" }, ctx);
    expect(generations).toBe(5);
    expect(result).toEqual({ output: "Web search was not performed: the search pass produced no search calls." });
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
    expect(result).toEqual({ output: "Web search was not performed: the search pass produced no search calls." });
  });
});
