// The search backend client, against a REAL loopback Streamable-HTTP MCP server. Ground truth is the
// fixture's own log: which tier (by `x-api-key` header) made which call with which arguments.
import { describe, expect, test } from "bun:test";
import {
  EXA_ADVANCED_SEARCH_TOOL,
  EXA_ANONYMOUS_COOLDOWN_MS,
  EXA_ANONYMOUS_MIN_INTERVAL_MS,
  EXA_HIGHLIGHTS_MAX_CHARACTERS,
  EXA_MAX_NUM_RESULTS,
  EXA_MCP_ENDPOINT,
  EXA_SEARCH_TOOL,
  EXA_TEXT_MAX_CHARACTERS,
  EXA_TITLE_MAX_CHARACTERS,
  EXA_URL_MAX_CHARACTERS,
  anonymousBreakerOpen,
  createExaBackendState,
  createExaSearchClient,
  exaEndpointUrl,
  exaKeyResolverFor,
  parseExaHits,
  type ExaSearchClientOptions,
} from "./_exa-client.ts";
import { advancedPayload, basicPayload, tooManyRequests, withExaFixture, type ExaFixtureHttpRequest } from "./_exa-fixture.test-support.ts";
import { withHttpFixture } from "../../mcp/test-fixtures.ts";
import { resolveWebToolsConfig } from "@yanlinglabs/winter-agent-sdk";

const KEY = "exa-key-3f9c1b7e-THE-SECRET";
const found = async () => ({ status: "found" as const, key: KEY });

/** A controllable clock plus a `sleep` that ADVANCES it and records what it was asked for. */
function clock(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
  };
}

function clientFor(endpoint: string, over: ExaSearchClientOptions = {}) {
  const c = clock();
  const state = over.state ?? createExaBackendState();
  return { client: createExaSearchClient({ endpoint, state, now: c.now, sleep: c.sleep, ...over }), clock: c, state };
}

const anonymousIs429 = (request: ExaFixtureHttpRequest): Response | undefined => (request.apiKey === null ? tooManyRequests() : undefined);

describe("the endpoint", () => {
  test("is the documented URL with the two-tool selector, and a key can never ride the query string", () => {
    expect(exaEndpointUrl()).toBe(`${EXA_MCP_ENDPOINT}?tools=${EXA_SEARCH_TOOL},${EXA_ADVANCED_SEARCH_TOOL}`);
    expect(exaEndpointUrl("http://127.0.0.1:1/mcp?x=1")).toBe(`http://127.0.0.1:1/mcp?x=1&tools=${EXA_SEARCH_TOOL},${EXA_ADVANCED_SEARCH_TOOL}`);
  });
});

describe("anonymous first", () => {
  test("an unfiltered search uses the BASIC tool with BOTH required arguments, on the anonymous tier, and never resolves the key", async () => {
    await withExaFixture({}, async (fixture) => {
      let keyResolutions = 0;
      const { client } = clientFor(fixture.endpoint, { resolveKey: async () => (keyResolutions++, await found()) });
      try {
        const result = await client.search({ query: "bun release notes" });
        if (!result.ok) throw new Error(result.message);
        expect(result.tier).toBe("anonymous");
        expect(result.tool).toBe(EXA_SEARCH_TOOL);
        // The live schema REQUIRES `objective` beside `query`; it defaults to the query.
        expect(fixture.calls).toEqual([{ tool: EXA_SEARCH_TOOL, args: { query: "bun release notes", objective: "bun release notes", numResults: 8 }, apiKey: null }]);
        expect(result.hits).toEqual([
          { title: "Bun v1.4.2 | Bun Blog", url: "https://bun.com/blog/bun-v1.4.2", highlight: "This release fixes two regressions." },
          { title: "Releases · oven-sh/bun", url: "https://github.com/oven-sh/bun/releases", highlight: "Release list" },
        ]);
        expect(keyResolutions).toBe(0);
        // No request carried a key, and the selector is on the URL.
        expect(fixture.requests.every((r) => r.apiKey === null)).toBe(true);
        expect(fixture.requests[0]!.search).toBe(`?tools=${EXA_SEARCH_TOOL},${EXA_ADVANCED_SEARCH_TOOL}`);
        expect(JSON.stringify(fixture.requests)).not.toContain("exaApiKey");
      } finally {
        await client.close();
      }
    });
  });

  test("the wrapper can be pointed at the shared `withHttpFixture` server", async () => {
    await withHttpFixture({ tools: [{ name: EXA_SEARCH_TOOL, handler: () => basicPayload([{ title: "T", url: "https://t.example/a", highlights: "h" }]) }] }, async (url) => {
      const { client } = clientFor(url.toString());
      try {
        expect(await client.search({ query: "q" })).toMatchObject({ ok: true, tier: "anonymous", hits: [{ title: "T", url: "https://t.example/a", highlight: "h" }] });
      } finally {
        await client.close();
      }
    });
  });

  test("`blockedDomains` reaches the ADVANCED tool as `excludeDomains` on EVERY search, merged with the call's own list; hits on the floor are dropped anyway", async () => {
    const respond = () => advancedPayload([{ title: "ok", url: "https://fine.example/a", highlights: ["h"] }, { title: "leaked", url: "https://sub.blocked.example/x", highlights: ["must be dropped"] }]);
    await withExaFixture({ respond }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { blockedDomains: ["Blocked.Example", "*.ads.example.net"] });
      try {
        const first = await client.search({ query: "one" });
        const second = await client.search({ query: "two", excludeDomains: ["reddit.com", "blocked.example"] });
        if (!first.ok || !second.ok) throw new Error("expected both searches to succeed");
        expect(fixture.calls.map((c) => c.tool)).toEqual([EXA_ADVANCED_SEARCH_TOOL, EXA_ADVANCED_SEARCH_TOOL]);
        expect(fixture.calls[0]!.args).toEqual({
          query: "one",
          numResults: 8,
          enableHighlights: true,
          highlightsMaxCharacters: EXA_HIGHLIGHTS_MAX_CHARACTERS,
          // The advanced tool returns the WHOLE PAGE as `text` unless capped (347,123 chars measured).
          textMaxCharacters: EXA_TEXT_MAX_CHARACTERS,
          excludeDomains: ["blocked.example", "ads.example.net"],
        });
        expect(fixture.calls[1]!.args["excludeDomains"]).toEqual(["blocked.example", "ads.example.net", "reddit.com"]);
        expect(first.hits.map((h) => h.url)).toEqual(["https://fine.example/a"]);
      } finally {
        await client.close();
      }
    });
  });

  test("an allow-list rides as `includeDomains` MINUS anything on the floor; an allow-list wholly on the floor searches nothing", async () => {
    await withExaFixture({}, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { blockedDomains: ["blocked.example"] });
      try {
        await client.search({ query: "q", includeDomains: ["docs.example.org", "sub.blocked.example"] });
        expect(fixture.calls[0]!.args["includeDomains"]).toEqual(["docs.example.org"]);
        expect("excludeDomains" in fixture.calls[0]!.args).toBe(false);
        expect(await client.search({ query: "q", includeDomains: ["blocked.example"] })).toMatchObject({ ok: false, code: "blocked-domains" });
        expect(fixture.calls).toHaveLength(1);
      } finally {
        await client.close();
      }
    });
  });

  test("anonymous calls are PACED to two per second, process-wide (the shared state, not the client)", async () => {
    await withExaFixture({}, async (fixture) => {
      const state = createExaBackendState();
      const c = clock();
      const a = createExaSearchClient({ endpoint: fixture.endpoint, state, now: c.now, sleep: c.sleep });
      const b = createExaSearchClient({ endpoint: fixture.endpoint, state, now: c.now, sleep: c.sleep });
      try {
        await a.search({ query: "1" });
        await b.search({ query: "2" });
        await a.search({ query: "3" });
        expect(c.slept).toEqual([EXA_ANONYMOUS_MIN_INTERVAL_MS, EXA_ANONYMOUS_MIN_INTERVAL_MS]);
      } finally {
        await a.close();
        await b.close();
      }
    });
  });
});

describe("the key as fallback, and the circuit breaker", () => {
  test("anonymous 429 -> key fallback (HEADER, never the URL) -> the breaker SKIPS anonymous next call -> RE-PROBE after the cooldown", async () => {
    let anonymousLimited = true;
    await withExaFixture({ gate: (r) => (anonymousLimited ? anonymousIs429(r) : undefined) }, async (fixture) => {
      let keyResolutions = 0;
      const { client, clock: c, state } = clientFor(fixture.endpoint, { resolveKey: async () => (keyResolutions++, await found()) });
      try {
        // (1) anonymous answers 429 -> the key serves the search.
        const first = await client.search({ query: "one" });
        expect(first).toMatchObject({ ok: true, tier: "key" });
        expect(fixture.calls).toEqual([{ tool: EXA_SEARCH_TOOL, args: { query: "one", objective: "one", numResults: 8 }, apiKey: KEY }]);
        expect(fixture.requests.some((r) => r.apiKey === null)).toBe(true);
        expect(fixture.requests.every((r) => !r.search.includes(KEY) && !r.search.toLowerCase().includes("apikey"))).toBe(true);
        expect(anonymousBreakerOpen(state, c.now())).toBe(true);

        // (2) breaker open: the next call goes STRAIGHT to the key -- not one anonymous request.
        const anonymousRequestsBefore = fixture.requests.filter((r) => r.apiKey === null).length;
        expect(await client.search({ query: "two" })).toMatchObject({ ok: true, tier: "key" });
        expect(fixture.requests.filter((r) => r.apiKey === null).length).toBe(anonymousRequestsBefore);
        // The key was resolved ONCE for the client's life (each resolution may be a keychain prompt).
        expect(keyResolutions).toBe(1);

        // (3) one millisecond short of the cooldown: still skipped.
        c.advance(EXA_ANONYMOUS_COOLDOWN_MS - 1 - (c.now() - state.anonymousRateLimitedAt!));
        expect(await client.search({ query: "three" })).toMatchObject({ ok: true, tier: "key" });
        expect(fixture.requests.filter((r) => r.apiKey === null).length).toBe(anonymousRequestsBefore);

        // (4) cooldown over and the allowance is back: the RE-PROBE succeeds and closes the breaker.
        c.advance(1);
        anonymousLimited = false;
        expect(await client.search({ query: "four" })).toMatchObject({ ok: true, tier: "anonymous" });
        expect(state.anonymousRateLimitedAt).toBeUndefined();
        expect(fixture.calls.at(-1)).toMatchObject({ apiKey: null, args: { query: "four" } });
      } finally {
        await client.close();
      }
    });
  });

  test("a 429 is recognised by STATUS alone -- at the handshake AND mid-session -- whatever the body says", async () => {
    // (a) at `initialize`, with an EMPTY body: nothing in the message says "rate limit".
    await withExaFixture({ gate: (r) => (r.apiKey === null ? new Response("", { status: 429 }) : undefined) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        expect(await client.search({ query: "q" })).toMatchObject({ ok: true, tier: "key" });
      } finally {
        await client.close();
      }
    });
    // (b) mid-session: the anonymous session connects and searches once, THEN the allowance runs out.
    let limited = false;
    await withExaFixture({ gate: (r) => (limited && r.apiKey === null ? new Response("", { status: 429 }) : undefined) }, async (fixture) => {
      const { client, clock: c, state } = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        expect(await client.search({ query: "one" })).toMatchObject({ ok: true, tier: "anonymous" });
        limited = true;
        expect(await client.search({ query: "two" })).toMatchObject({ ok: true, tier: "key" });
        expect(anonymousBreakerOpen(state, c.now())).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  test("a re-probe that is STILL rate-limited re-opens the breaker for a full cooldown and falls to the key", async () => {
    await withExaFixture({ gate: anonymousIs429 }, async (fixture) => {
      const { client, clock: c, state } = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        await client.search({ query: "one" });
        const openedAt = state.anonymousRateLimitedAt!;
        c.advance(EXA_ANONYMOUS_COOLDOWN_MS);
        expect(await client.search({ query: "two" })).toMatchObject({ ok: true, tier: "key" });
        expect(state.anonymousRateLimitedAt).toBeGreaterThan(openedAt);
        expect(anonymousBreakerOpen(state, c.now())).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  test("a rate-limit answered as an MCP `isError` RESULT (not an HTTP status) opens the breaker the same way", async () => {
    await withExaFixture({ respond: (call) => (call.apiKey === null ? { content: [{ type: "text", text: "Rate limit exceeded: free tier quota reached" }], isError: true } : advancedPayload([{ url: "https://k.example/" }])) }, async (fixture) => {
      const { client, clock: c, state } = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        expect(await client.search({ query: "q" })).toMatchObject({ ok: true, tier: "key", hits: [{ url: "https://k.example/", title: "https://k.example/" }] });
        expect(anonymousBreakerOpen(state, c.now())).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  test("NO KEY + exhausted -> a typed `quota-exhausted` result that says to add a key; while the breaker is open it costs NO network at all", async () => {
    await withExaFixture({ gate: anonymousIs429 }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint);
      try {
        const first = await client.search({ query: "one" });
        expect(first).toMatchObject({ ok: false, code: "quota-exhausted" });
        if (first.ok) throw new Error("unreachable");
        expect(first.message).toContain("add an Exa API key");
        const requestsBefore = fixture.requests.length;
        expect(await client.search({ query: "two" })).toMatchObject({ ok: false, code: "quota-exhausted" });
        expect(fixture.requests.length).toBe(requestsBefore);
      } finally {
        await client.close();
      }
    });
  });

  test("a configured key that cannot be READ is `key-unreadable` and carries the resolver's (redacted) reason; a rejected key is `key-rejected` and its value is never quoted", async () => {
    await withExaFixture({ gate: (r) => (r.apiKey === null ? tooManyRequests() : new Response(`{"error":"invalid api key ${KEY}"}`, { status: 401 })) }, async (fixture) => {
      const unreadable = clientFor(fixture.endpoint, { resolveKey: async () => ({ status: "unreadable", code: "malformed", message: 'the item at keychain(svc:exa) holds "oauth" credential material, not an API key' }) });
      try {
        const result = await unreadable.client.search({ query: "q" });
        expect(result).toMatchObject({ ok: false, code: "key-unreadable" });
        if (result.ok) throw new Error("unreachable");
        expect(result.message).toContain("keychain(svc:exa)");
      } finally {
        await unreadable.client.close();
      }
      const rejected = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        const result = await rejected.client.search({ query: "q" });
        expect(result).toMatchObject({ ok: false, code: "key-rejected" });
        expect(JSON.stringify(result)).not.toContain(KEY);
      } finally {
        await rejected.client.close();
      }
    });
  });
});

describe("timeouts, abort, reconnect, and the output cap -- all owned here, because the direct-call path has none of them", () => {
  test("a backend that never answers is a typed `timeout`, and the next search reconnects and works", async () => {
    let hang = true;
    await withExaFixture({ respond: async () => (hang ? await new Promise(() => {}) : advancedPayload([{ url: "https://ok.example/" }])) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { callTimeoutMs: 150, connectTimeoutMs: 2_000 });
      try {
        const started = Date.now();
        expect(await client.search({ query: "q" })).toMatchObject({ ok: false, code: "timeout" });
        expect(Date.now() - started).toBeLessThan(2_000);
        hang = false;
        expect(await client.search({ query: "q" })).toMatchObject({ ok: true, tier: "anonymous" });
      } finally {
        await client.close();
      }
    });
  }, 15_000);

  test("ABORT: `callTool` takes no signal, so the call is RACED -- an in-flight search ends `aborted` promptly, and an already-aborted signal makes no request", async () => {
    await withExaFixture({ respond: () => new Promise(() => {}) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint);
      try {
        const controller = new AbortController();
        const pending = client.search({ query: "q" }, { signal: controller.signal });
        setTimeout(() => controller.abort(), 100);
        const started = Date.now();
        expect(await pending).toMatchObject({ ok: false, code: "aborted" });
        expect(Date.now() - started).toBeLessThan(2_000);
        const requestsBefore = fixture.requests.length;
        expect(await client.search({ query: "q" }, { signal: controller.signal })).toMatchObject({ ok: false, code: "aborted" });
        expect(fixture.requests.length).toBe(requestsBefore);
      } finally {
        await client.close();
      }
    });
  }, 15_000);

  test("a DROPPED session gets exactly ONE reconnect-and-retry", async () => {
    await withExaFixture({}, async (fixture) => {
      const { client } = clientFor(fixture.endpoint);
      try {
        expect(await client.search({ query: "one" })).toMatchObject({ ok: true });
        fixture.dropSessions();
        expect(await client.search({ query: "two" })).toMatchObject({ ok: true, tier: "anonymous" });
        expect(fixture.calls.map((c) => c.args["query"])).toEqual(["one", "two"]);
        // Non-vacuity: the second search really did hit the dead session and open a SECOND one.
        expect(fixture.requests.filter((r) => r.method === "POST" && r.sessionId === null)).toHaveLength(2);
        expect(new Set(fixture.requests.map((r) => r.sessionId).filter((id) => id !== null)).size).toBe(2);
      } finally {
        await client.close();
      }
    });
  });

  test("an error the backend ANSWERED with is final -- NOT retried, because that search already counted against the allowance", async () => {
    let n = 0;
    await withExaFixture({ respond: () => (++n === 1 ? advancedPayload([{ url: "https://ok.example/" }]) : { content: [{ type: "text", text: "Invalid request: numResults must be at most 100" }], isError: true }) }, async (fixture) => {
      const { client, clock: c, state } = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        expect(await client.search({ query: "one" })).toMatchObject({ ok: true });
        const second = await client.search({ query: "two" });
        expect(second).toMatchObject({ ok: false, code: "backend-error" });
        if (second.ok) throw new Error("unreachable");
        expect(second.message).toContain("numResults must be at most 100");
        // Exactly TWO backend searches: the established connection did not earn the error a retry,
        // and an ordinary error neither opens the breaker nor spends the key.
        expect(fixture.calls).toHaveLength(2);
        expect(fixture.calls.every((call) => call.apiKey === null)).toBe(true);
        expect(anonymousBreakerOpen(state, c.now())).toBe(false);
      } finally {
        await client.close();
      }
    });
  });

  test("an unreachable endpoint is a typed `unreachable`, never a throw; a closed client answers without connecting", async () => {
    const { client } = clientFor("http://127.0.0.1:1/mcp", { connectTimeoutMs: 2_000 });
    const result = await client.search({ query: "q" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(["unreachable", "timeout"]).toContain(result.code);
    await client.close();
    await client.close();
    expect(await client.search({ query: "q" })).toMatchObject({ ok: false, code: "backend-error" });
  }, 15_000);

  test("THE OUTPUT CAP: a huge payload is parsed whole, handed on capped, and every highlight is capped too", async () => {
    const huge = "x".repeat(400_000);
    await withExaFixture({ respond: () => advancedPayload([{ title: "big", url: "https://big.example/", highlights: [huge] }, { title: "no highlights", url: "https://text.example/", text: "page text fallback" }]) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { maxResultChars: 5_000, blockedDomains: ["irrelevant.example"] });
      try {
        const result = await client.search({ query: "q" });
        if (!result.ok) throw new Error(result.message);
        expect(result.truncated).toBe(true);
        expect(result.rawText.length).toBe(5_000);
        expect(result.hits.map((h) => h.url)).toEqual(["https://big.example/", "https://text.example/"]);
        expect(result.hits[0]!.highlight.length).toBe(EXA_HIGHLIGHTS_MAX_CHARACTERS);
        expect(result.hits[1]!.highlight).toBe("page text fallback");
      } finally {
        await client.close();
      }
    });
  });
});

describe("review fixes: bounds, answered errors, single-flight connect, key re-resolution, a narrower rate-limit reading", () => {
  test("`numResults` is CLAMPED (a count, not just each hit, reaches the inner model) and a non-finite value falls back to the default", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, url: `https://r${i}.example/`, highlights: ["h"] }));
    await withExaFixture({ respond: () => advancedPayload(many) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { blockedDomains: ["x.example"] });
      try {
        const big = await client.search({ query: "q", numResults: 1000 });
        const nan = await client.search({ query: "q", numResults: Number.NaN });
        if (!big.ok || !nan.ok) throw new Error("expected both to succeed");
        expect(fixture.calls[0]!.args["numResults"]).toBe(EXA_MAX_NUM_RESULTS);
        expect(fixture.calls[1]!.args["numResults"]).toBe(8);
        // ...and a backend that ignores the bound still cannot hand on more hits than were asked for.
        expect(big.hits).toHaveLength(EXA_MAX_NUM_RESULTS);
        expect(nan.hits).toHaveLength(8);
      } finally {
        await client.close();
      }
    });
  });

  test("an error the backend ANSWERED as a JSON-RPC error, or with an HTTP 5xx, is final -- only a DROPPED SESSION earns the reconnect", async () => {
    let n = 0;
    await withExaFixture(
      {
        respond: () => {
          if (++n === 1) return advancedPayload([{ url: "https://ok.example/" }]);
          throw new Error("internal backend failure");
        },
      },
      async (fixture) => {
        const { client } = clientFor(fixture.endpoint);
        try {
          expect(await client.search({ query: "one" })).toMatchObject({ ok: true });
          expect(await client.search({ query: "two" })).toMatchObject({ ok: false, code: "backend-error" });
          expect(fixture.calls).toHaveLength(2);
        } finally {
          await client.close();
        }
      },
    );
    let fail5xx = false;
    await withExaFixture({ gate: (r) => (fail5xx && r.method === "POST" ? new Response("upstream exploded", { status: 503 }) : undefined) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint);
      try {
        expect(await client.search({ query: "one" })).toMatchObject({ ok: true });
        fail5xx = true;
        const postsBefore = fixture.requests.filter((r) => r.method === "POST").length;
        expect((await client.search({ query: "two" })).ok).toBe(false);
        // ONE failed POST -- not a second attempt, and not a fresh `initialize` either.
        expect(fixture.requests.filter((r) => r.method === "POST").length).toBe(postsBefore + 1);
      } finally {
        await client.close();
      }
    });
  });

  test("two CONCURRENT first searches share ONE connection (single-flight connect)", async () => {
    await withExaFixture({}, async (fixture) => {
      const { client } = clientFor(fixture.endpoint);
      try {
        const [a, b] = await Promise.all([client.search({ query: "a" }), client.search({ query: "b" })]);
        expect(a.ok && b.ok).toBe(true);
        expect(fixture.requests.filter((r) => r.method === "POST" && r.sessionId === null)).toHaveLength(1);
      } finally {
        await client.close();
      }
    });
  });

  test("a caller that stops waiting DURING CONNECT abandons the attempt: the search is NOT run later behind the caller's back", async () => {
    await withExaFixture({ gate: async (r) => (r.sessionId === null ? (await new Promise((resolve) => setTimeout(resolve, 400)), undefined) : undefined) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { callTimeoutMs: 50, connectTimeoutMs: 1_500 });
      try {
        // The race timer here is only ever as long as the caller's own bound: abort it early.
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        expect(await client.search({ query: "must not run" }, { signal: controller.signal })).toMatchObject({ ok: false, code: "aborted" });
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(fixture.calls).toEqual([]);
      } finally {
        await client.close();
      }
    });
  }, 15_000);

  test("a key that was MISSING is re-resolved on the next call (a key added mid-session is seen); a FOUND key is resolved once", async () => {
    await withExaFixture({ gate: anonymousIs429 }, async (fixture) => {
      let resolutions = 0;
      const { client } = clientFor(fixture.endpoint, { resolveKey: async () => (++resolutions === 1 ? { status: "missing" as const } : await found()) });
      try {
        expect(await client.search({ query: "one" })).toMatchObject({ ok: false, code: "quota-exhausted" });
        expect(await client.search({ query: "two" })).toMatchObject({ ok: true, tier: "key" });
        expect(await client.search({ query: "three" })).toMatchObject({ ok: true, tier: "key" });
        expect(resolutions).toBe(2);
      } finally {
        await client.close();
      }
    });
  });

  test("a `resolveKey` that REJECTS is `key-unreadable` -- a value, exposing the error's name only", async () => {
    await withExaFixture({ gate: anonymousIs429 }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, {
        resolveKey: async () => {
          throw new RangeError(`keychain exploded near ${KEY}`);
        },
      });
      try {
        const result = await client.search({ query: "q" });
        expect(result).toMatchObject({ ok: false, code: "key-unreadable" });
        expect(JSON.stringify(result)).toContain("RangeError");
        expect(JSON.stringify(result)).not.toContain(KEY);
      } finally {
        await client.close();
      }
    });
  });

  test("an `isError` text that merely ECHOES THE USER'S QUERY does not open the process-wide breaker", async () => {
    const query = "why does my API return 429 quota exceeded rate limit errors";
    await withExaFixture({ respond: (call) => ({ content: [{ type: "text", text: `No results found for: ${String(call.args["query"])} (${String(call.args["objective"])})` }], isError: true }) }, async (fixture) => {
      const { client, clock: c, state } = clientFor(fixture.endpoint, { resolveKey: found });
      try {
        expect(await client.search({ query })).toMatchObject({ ok: false, code: "backend-error" });
        expect(anonymousBreakerOpen(state, c.now())).toBe(false);
        expect(fixture.calls.every((call) => call.apiKey === null)).toBe(true);
      } finally {
        await client.close();
      }
    });
  });

  test("the timeout message states the bound that was ACTUALLY applied", async () => {
    await withExaFixture({ respond: () => new Promise(() => {}) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint, { callTimeoutMs: 1_000, connectTimeoutMs: 2_000 });
      try {
        const result = await client.search({ query: "q" });
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("timeout");
        // No connection existed, so the bound was connect + call = 3 s -- and the message says 3.
        expect(result.message).toContain("3 seconds");
      } finally {
        await client.close();
      }
    });
  }, 15_000);

  test("an AUTH refusal on the anonymous tier is not described as an exhausted quota", async () => {
    await withExaFixture({ gate: (r) => (r.apiKey === null ? new Response("", { status: 401 }) : undefined) }, async (fixture) => {
      const { client } = clientFor(fixture.endpoint);
      try {
        const result = await client.search({ query: "q" });
        if (result.ok) throw new Error("unreachable");
        expect(result.code).toBe("quota-exhausted");
        expect(result.message).not.toContain("quota is exhausted");
        expect(result.message).toContain("refused anonymous access");
        expect(result.message).toContain("add an Exa API key");
      } finally {
        await client.close();
      }
    });
  });

  test("a BACKWARDS clock step cannot hold the breaker open, or the pacer asleep, for longer than one period", () => {
    const state = createExaBackendState();
    state.anonymousRateLimitedAt = 10_000_000;
    // The clock stepped back by an hour: without a clamp the breaker would stay open for cooldown + 1h.
    expect(anonymousBreakerOpen(state, 10_000_000 - 3_600_000)).toBe(true);
    expect(anonymousBreakerOpen(state, 10_000_000 - 3_600_000 + EXA_ANONYMOUS_COOLDOWN_MS)).toBe(false);
  });

  test("the KEYED connection refuses redirects: `x-api-key` never follows one to another origin", async () => {
    const elsewhere: Array<string | null> = [];
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (elsewhere.push(req.headers.get("x-api-key")), new Response("{}", { status: 200 })) });
    try {
      await withExaFixture({ gate: (r) => (r.apiKey === null ? tooManyRequests() : new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/mcp` } })) }, async (fixture) => {
        const { client } = clientFor(fixture.endpoint, { resolveKey: found });
        try {
          expect((await client.search({ query: "q" })).ok).toBe(false);
          expect(elsewhere).toEqual([]);
        } finally {
          await client.close();
        }
      });
    } finally {
      other.stop(true);
    }
  });
});

describe("parseExaHits -- both measured payload shapes, tolerantly", () => {
  test("the advanced tool's JSON: `highlights` is a string ARRAY; a result with no url is dropped; an `id` that is a URL stands in for a missing `url`", () => {
    const text = JSON.stringify({ requestId: "r", results: [{ id: "https://a.example/1", url: "https://a.example/1", title: " A ", publishedDate: "2026-09-05T05:39:32.000Z", highlights: ["one", "two"], text: "ignored when highlights exist" }, { title: "no url" }, { id: "https://b.example/2" }, "not-an-object"] });
    expect(parseExaHits(text)).toEqual([
      { title: "A", url: "https://a.example/1", highlight: "one\n...\ntwo", publishedDate: "2026-09-05T05:39:32.000Z" },
      { title: "https://b.example/2", url: "https://b.example/2", highlight: "" },
    ]);
  });

  test("the basic tool's text records, split on the `---` line; `N/A` dates are omitted; multi-line highlights are kept", () => {
    const text = "Title: Bun v1.4.2 | Bun Blog\nURL: https://bun.com/blog/bun-v1.4.2\nPublished: 2026-09-05T05:39:32.000Z\nAuthor: N/A\nHighlights:\nBun v1.4.2 | Bun Blog\n...\nThis release fixes two regressions.\n\n---\n\nTitle: Releases · oven-sh/bun\nURL: https://github.com/oven-sh/bun/releases\nPublished: N/A\nAuthor: oven-sh\nHighlights:\nURL: not a field, this is highlight text\n- Bun v1.4";
    expect(parseExaHits(text)).toEqual([
      { title: "Bun v1.4.2 | Bun Blog", url: "https://bun.com/blog/bun-v1.4.2", highlight: "Bun v1.4.2 | Bun Blog\n...\nThis release fixes two regressions.", publishedDate: "2026-09-05T05:39:32.000Z" },
      { title: "Releases · oven-sh/bun", url: "https://github.com/oven-sh/bun/releases", highlight: "URL: not a field, this is highlight text\n- Bun v1.4" },
    ]);
  });

  test("BOTH paths require an http(s) URL, drop an over-long one, and cap the title", () => {
    const longUrl = `https://long.example/${"a".repeat(EXA_URL_MAX_CHARACTERS)}`;
    const json = JSON.stringify({ results: [{ url: "javascript:alert(1)", title: "js" }, { url: "ftp://files.example/x", title: "ftp" }, { id: "data:text/html,x" }, { url: longUrl, title: "long" }, { url: "https://ok.example/", title: "T".repeat(5_000) }] });
    const hits = parseExaHits(json);
    expect(hits.map((h) => h.url)).toEqual(["https://ok.example/"]);
    expect(hits[0]!.title.length).toBe(EXA_TITLE_MAX_CHARACTERS);
    const text = `Title: js\nURL: javascript:alert(1)\nHighlights:\nx\n\n---\n\nTitle: ${"T".repeat(5_000)}\nURL: https://ok.example/\nHighlights:\nh\n\n---\n\nTitle: long\nURL: ${longUrl}\nHighlights:\nh`;
    const fromText = parseExaHits(text);
    expect(fromText.map((h) => h.url)).toEqual(["https://ok.example/"]);
    expect(fromText[0]!.title.length).toBe(EXA_TITLE_MAX_CHARACTERS);
  });

  test("anything else -- prose, truncated JSON, an empty payload -- is NO hits, never a throw", () => {
    expect(parseExaHits("No results found.")).toEqual([]);
    expect(parseExaHits('{"results":[{"url":"https://cut.example/","tit')).toEqual([]);
    expect(parseExaHits("")).toEqual([]);
    expect(parseExaHits('{"results":"nope"}')).toEqual([]);
  });
});

describe("exaKeyResolverFor", () => {
  test("is absent without an authRef or without a resolver, and otherwise resolves the session's `web.search.authRef` lazily", async () => {
    const authRef = { kind: "keychain" as const, account: "exa" };
    expect(exaKeyResolverFor({ web: resolveWebToolsConfig(undefined), resolveToolSecret: found })).toBeUndefined();
    expect(exaKeyResolverFor({ web: resolveWebToolsConfig({ search: { authRef } }) })).toBeUndefined();
    const asked: unknown[] = [];
    const resolver = exaKeyResolverFor({ web: resolveWebToolsConfig({ search: { authRef } }), resolveToolSecret: async (ref) => (asked.push(ref), await found()) })!;
    expect(asked).toEqual([]);
    expect(await resolver()).toEqual({ status: "found", key: KEY });
    expect(asked).toEqual([authRef]);
  });
});
