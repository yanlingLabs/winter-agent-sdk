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
  test("no web session runtime registered -> a typed error result", async () => {
    const result = await run({ query: "hello world" }, makeCtx("w-not-wired"));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no search runtime is wired up");
  });

  test("the search backend turned off for this session -> a plain (non-error) refusal", async () => {
    const ctx = makeCtx("w-disabled");
    runtimeWith("w-disabled", scriptedProvider([]), {}, { search: { enabled: false } });
    const result = await run({ query: "hello world" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Web search is turned off for this session.");
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
// The result cap.
// =====================================================================================================

describe("the result cap", () => {
  test("a result over the cap is sliced, never silently dropped", async () => {
    const hugeTitle = "x".repeat(WEB_SEARCH_RESULT_CAP + 5_000);
    await withExaFixture({ respond: () => advancedPayload([{ title: hugeTitle, url: "https://big.example/" }]) }, async (fixture) => {
      const state = createExaBackendState();
      const ctx = makeCtx("cap-result");
      runtimeWith("cap-result", scriptedProvider([call1Turn(), { kind: "text", text: "done" }]));
      const result = await run({ query: "qq" }, ctx, { fixture, state });
      expect(result.output.length).toBe(WEB_SEARCH_RESULT_CAP);
    });
  });
});

// =====================================================================================================
// Spine bug awareness (coordinator note, 2026-09-18): the shared `runInnerModel` tool loop currently
// bounds TOOL CALLS, not GENERATIONS -- a model that never names the offered tool correctly can run
// far more generations than `maxToolCalls` before a scripted double's turns run out. A parallel fix
// lane is adding a hard generation cap. These two tests pin "the executor still returns a sane result
// and terminates" rather than an exact call/generation count, and are expected to keep passing once
// that spine fix lands (they do not assert the buggy behaviour, only its absence of a hang/crash).
// =====================================================================================================

describe("spine bug awareness: unknown-tool-name and empty-calls-array loops", () => {
  test("an inner model that names an unknown tool every round still returns a sane, non-throwing result", async () => {
    const ctx = makeCtx("bug-unknown-tool");
    const turns: ProviderTurn[] = Array.from({ length: 60 }, (_, i) => ({ kind: "tool_use", calls: [{ id: `u${i}`, name: "NotWebSearch", input: {} }] }));
    runtimeWith("bug-unknown-tool", scriptedProvider(turns));
    const result = await run({ query: "hello world" }, ctx);
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeGreaterThan(0);
  }, 20_000);

  test("an inner model that emits an EMPTY calls array every round still terminates with a sane result", async () => {
    const ctx = makeCtx("bug-empty-calls");
    const turns: ProviderTurn[] = Array.from({ length: 60 }, () => ({ kind: "tool_use", calls: [] }));
    runtimeWith("bug-empty-calls", scriptedProvider(turns));
    const result = await run({ query: "hello world" }, ctx);
    expect(typeof result.output).toBe("string");
    expect(result.output.length).toBeGreaterThan(0);
  }, 20_000);
});
