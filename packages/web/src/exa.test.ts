// The Exa client over the built-in MCP Streamable HTTP transport, against a loopback fake of Exa's MCP
// server. Typed failures (429, quota, 5xx, breaker open, timeout, abort), anonymous-first with the
// key as fallback, and the key never anywhere but the `x-api-key` header.
import { harness, isBun, type BunTestModule } from "./harness.test-support.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createExaBackendState, createExaSearchClient, EXA_ANONYMOUS_COOLDOWN_MS, parseExaResults, type ExaSearchClientOptions, type ExaSearchResult } from "./exa.ts";

// @ts-ignore -- `bun:test` has no types under the Node-only configs (the fence, this package's own tsconfig); it is imported only under Bun.
const { describe, test } = await harness(isBun ? ((await import("bun:test")) as unknown as BunTestModule) : undefined);

const KEY = "exa-test-key-0123456789abcdef";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  rpc?: string;
}

type Reply = { status: number; body?: string; location?: string } | "hang" | undefined;

interface FakeOptions {
  /** Short-circuits a request before the MCP layer. */
  gate?: (seen: Seen, keyed: boolean) => Reply;
  /** The tools/call answer. */
  respond?: (args: Record<string, unknown>, keyed: boolean) => { content: unknown[]; isError?: boolean };
  sse?: boolean;
}

const advanced = (results: unknown[]) => ({ content: [{ type: "text", text: JSON.stringify({ requestId: "r", results }) }] });

async function withFake<T>(options: FakeOptions, fn: (endpoint: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  let sessions = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let rpc: { id?: number; method?: string; params?: { arguments?: Record<string, unknown> } } = {};
      try {
        rpc = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        /* not JSON */
      }
      const record: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, ...(rpc.method !== undefined ? { rpc: rpc.method } : {}) };
      seen.push(record);
      const keyed = typeof req.headers["x-api-key"] === "string";
      const gated = options.gate?.(record, keyed);
      if (gated === "hang") return;
      if (gated !== undefined) {
        res.statusCode = gated.status;
        if (gated.location !== undefined) res.setHeader("location", gated.location);
        res.setHeader("content-type", "application/json");
        res.end(gated.body ?? "");
        return;
      }
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const send = (message: unknown): void => {
        if (options.sse === true) {
          res.setHeader("content-type", "text/event-stream");
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`);
          res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
          // Left open on purpose: the client must stop at the response, not wait for the stream to end.
          setTimeout(() => res.end(), 2_000).unref?.();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(message));
      };
      if (rpc.method === "initialize") {
        res.setHeader("mcp-session-id", `session-${++sessions}`);
        send({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-exa", version: "0" } } });
        return;
      }
      if (rpc.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (rpc.method === "tools/call") {
        const result = options.respond?.(rpc.params?.arguments ?? {}, keyed) ?? advanced([{ url: "https://a.example/1", title: "One", highlights: ["first", "second"], publishedDate: "2026-01-01", favicon: "https://a.example/f.ico" }]);
        send({ jsonrpc: "2.0", id: rpc.id, result });
        return;
      }
      res.statusCode = 400;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function client(endpoint: string, over: Partial<ExaSearchClientOptions> = {}) {
  return createExaSearchClient({ endpoint, state: createExaBackendState(), sleep: async () => {}, callTimeoutMs: 2_000, connectTimeoutMs: 2_000, ...over });
}

/** The key appears in NOTHING but the `x-api-key` header: not in a URL, a body, a result or a message. */
function assertKeyOnlyInHeader(seen: Seen[], result: ExaSearchResult): void {
  for (const s of seen) {
    assert.ok(!s.url.includes(KEY), "key in a URL");
    assert.ok(!s.body.includes(KEY), "key in a request body");
    for (const [name, value] of Object.entries(s.headers)) if (name !== "x-api-key") assert.ok(!String(value).includes(KEY), `key in header ${name}`);
  }
  assert.ok(!JSON.stringify(result).includes(KEY), "key in the result");
}

const rateLimited = (_s: Seen, keyed: boolean): Reply => (keyed ? undefined : { status: 429, body: JSON.stringify({ error: "Rate limit exceeded for the free tier." }) });

describe("Exa client, built-in transport", () => {
  test("anonymous first: no key is resolved while the anonymous tier answers", async () => {
    await withFake({}, async (endpoint, seen) => {
      let asked = 0;
      const c = client(endpoint, { resolveKey: () => (asked++, KEY) });
      const result = await c.search({ query: "bun release notes" });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.tier, "anonymous");
        assert.deepEqual(result.results, [{ url: "https://a.example/1", title: "One", publishedDate: "2026-01-01", text: "first\n...\nsecond", highlights: ["first", "second"], favicon: "https://a.example/f.ico" }]);
      }
      assert.equal(asked, 0);
      assert.ok(seen.every((s) => s.headers["x-api-key"] === undefined));
      assert.ok(seen.every((s) => s.url === "/mcp?tools=web_search_exa,web_search_advanced_exa"));
      await c.close();
    });
  });

  test("a 429 on the anonymous tier falls back to the key, which travels ONLY in x-api-key", async () => {
    await withFake({ gate: rateLimited }, async (endpoint, seen) => {
      const c = client(endpoint, { resolveKey: async () => ({ status: "found", key: KEY }) });
      const result = await c.search({ query: "q", includeDomains: ["a.example"] });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.tier, "key");
      assert.ok(seen.some((s) => s.headers["x-api-key"] === KEY));
      assertKeyOnlyInHeader(seen, result);
      await c.close();
    });
  });

  test("the anonymous tier rate-limited with NO key: quota_exhausted, and the breaker then skips the network", async () => {
    await withFake({ gate: rateLimited }, async (endpoint, seen) => {
      const state = createExaBackendState();
      const c = client(endpoint, { state });
      const first = await c.search({ query: "q" });
      assert.equal(first.ok, false);
      if (!first.ok) {
        assert.equal(first.code, "quota_exhausted");
        assert.ok((first.retryAfterMs ?? 0) > 0);
      }
      const before = seen.length;
      const second = await client(endpoint, { state }).search({ query: "q" });
      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.code, "quota_exhausted");
      assert.equal(seen.length, before, "an open breaker with no key touches no network");
      await c.close();
    });
  });

  test("the breaker re-probes the anonymous tier after the cooldown", async () => {
    let now = 1_000_000;
    let limited = true;
    await withFake({ gate: (s, keyed) => (limited ? rateLimited(s, keyed) : undefined) }, async (endpoint) => {
      const state = createExaBackendState();
      const first = await client(endpoint, { state, now: () => now }).search({ query: "q" });
      assert.equal(first.ok, false);
      limited = false;
      now += EXA_ANONYMOUS_COOLDOWN_MS + 1;
      const again = await client(endpoint, { state, now: () => now }).search({ query: "q" });
      assert.equal(again.ok, true);
      assert.equal(state.anonymousRateLimitedAt, undefined);
    });
  });

  test("the key tier rate-limited: rate_limited; rejected: key_rejected; unreadable key: key_unreadable", async () => {
    await withFake({ gate: (_s, keyed) => (keyed ? { status: 429, body: "Too Many Requests" } : { status: 429 }) }, async (endpoint, seen) => {
      const result = await client(endpoint, { resolveKey: () => KEY }).search({ query: "q" });
      assert.equal(!result.ok && result.code, "rate_limited");
      assertKeyOnlyInHeader(seen, result);
    });
    await withFake({ gate: (_s, keyed) => (keyed ? { status: 401, body: `{"error":"invalid api key ${KEY}"}` } : { status: 429 }) }, async (endpoint, seen) => {
      const result = await client(endpoint, { resolveKey: () => KEY }).search({ query: "q" });
      assert.equal(!result.ok && result.code, "key_rejected");
      assertKeyOnlyInHeader(seen, result);
    });
    await withFake({ gate: rateLimited }, async (endpoint) => {
      const result = await client(endpoint, { resolveKey: () => ({ status: "unreadable", message: "the keychain is locked" }) }).search({ query: "q" });
      assert.equal(!result.ok && result.code, "key_unreadable");
      const thrown = await client(endpoint, { resolveKey: () => Promise.reject(new TypeError(`boom ${KEY}`)) }).search({ query: "q" });
      assert.equal(!thrown.ok && thrown.code, "key_unreadable");
      assert.ok(!JSON.stringify(thrown).includes(KEY));
    });
  });

  test("a 5xx is backend_error -- the backend answered -- and an unreachable backend is unavailable", async () => {
    await withFake({ gate: (s) => (s.rpc === "tools/call" ? { status: 503, body: "upstream down" } : undefined) }, async (endpoint) => {
      const result = await client(endpoint).search({ query: "q" });
      assert.equal(!result.ok && result.code, "backend_error");
    });
    await withFake({ gate: () => ({ status: 500 }) }, async (endpoint) => {
      const result = await client(endpoint).search({ query: "q" });
      assert.equal(!result.ok && result.code, "unavailable");
    });
    const closedPort = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const result = await client(`http://127.0.0.1:${closedPort}/mcp`).search({ query: "q" });
    assert.equal(!result.ok && result.code, "unavailable");
  });

  test("a tool error result naming a rate limit opens the breaker; one merely echoing the query does not", async () => {
    await withFake({ respond: (args, keyed) => (keyed ? advanced([]) : { content: [{ type: "text", text: "Rate limit exceeded" }], isError: true }) }, async (endpoint) => {
      const state = createExaBackendState();
      const result = await client(endpoint, { state }).search({ query: "q" });
      assert.equal(!result.ok && result.code, "quota_exhausted");
      assert.notEqual(state.anonymousRateLimitedAt, undefined);
    });
    await withFake({ respond: (args) => ({ content: [{ type: "text", text: `no results for ${String(args["query"])}` }], isError: true }) }, async (endpoint) => {
      const state = createExaBackendState();
      const result = await client(endpoint, { state }).search({ query: "why does my api say rate limit exceeded" });
      assert.equal(!result.ok && result.code, "backend_error");
      assert.equal(state.anonymousRateLimitedAt, undefined);
    });
  });

  test("timeout and abort are typed, never thrown", async () => {
    await withFake({ gate: (s) => (s.rpc === "tools/call" ? "hang" : undefined) }, async (endpoint) => {
      const timedOut = await client(endpoint, { callTimeoutMs: 200 }).search({ query: "q" });
      assert.equal(!timedOut.ok && timedOut.code, "timeout");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const aborted = await client(endpoint).search({ query: "q" }, { signal: controller.signal });
      assert.equal(!aborted.ok && aborted.code, "aborted");
      assert.equal(!(await client(endpoint).search({ query: "q" }, { signal: AbortSignal.abort() })).ok, true);
    });
  });

  test("an SSE response is read up to the matching JSON-RPC response, without waiting for the stream to end", async () => {
    await withFake({ sse: true }, async (endpoint) => {
      const started = Date.now();
      const result = await client(endpoint).search({ query: "q" });
      assert.equal(result.ok, true);
      assert.ok(Date.now() - started < 1_500);
    });
  });

  test("blockedDomains: an allow-list wholly blocked is blocked_domains without a request; blocked results are dropped", async () => {
    await withFake({ respond: () => advanced([{ url: "https://bad.example/x", title: "Bad" }, { url: "https://good.example/y", title: "Good" }]) }, async (endpoint, seen) => {
      const blocked = await client(endpoint, { blockedDomains: ["bad.example"] }).search({ query: "q", includeDomains: ["bad.example"] });
      assert.equal(!blocked.ok && blocked.code, "blocked_domains");
      assert.equal(seen.length, 0);
      const result = await client(endpoint, { blockedDomains: ["bad.example"] }).search({ query: "q" });
      assert.equal(result.ok, true);
      if (result.ok) assert.deepEqual(result.results.map((r) => r.url), ["https://good.example/y"]);
      const call = seen.find((s) => s.rpc === "tools/call")!;
      assert.deepEqual(JSON.parse(call.body).params.arguments.excludeDomains, ["bad.example"]);
    });
  });

  test("the keyed connection never follows a redirect, so the header is never replayed to another origin", async () => {
    await withFake({}, async (elsewhere, elsewhereSeen) => {
      await withFake({ gate: (_s, keyed) => (keyed ? { status: 307, location: elsewhere } : { status: 429 }) }, async (endpoint, seen) => {
        const result = await client(endpoint, { resolveKey: () => KEY }).search({ query: "q" });
        assert.equal(result.ok, false);
        assertKeyOnlyInHeader(seen, result);
      });
      assert.equal(elsewhereSeen.length, 0, "the redirect target was contacted");
    });
  });
});

describe("parseExaResults", () => {
  test("the advanced JSON form and the basic text form; unlinkable URLs dropped; text capped", () => {
    const json = parseExaResults(JSON.stringify({ results: [{ url: "javascript:alert(1)" }, { id: "https://b.example", title: "", text: "x".repeat(5000) }] }));
    assert.equal(json.length, 1);
    assert.equal(json[0]!.title, "https://b.example");
    assert.equal(json[0]!.text.length, 1200);
    const basic = parseExaResults("Title: T\nURL: https://c.example\nPublished: N/A\nAuthor: N/A\nHighlights:\nline one\nline two\n\n---\n\nTitle: U\nURL: ftp://nope");
    assert.deepEqual(basic, [{ url: "https://c.example", title: "T", text: "line one\nline two" }]);
  });
});

describe("published-date filters", () => {
  const calls = (seen: Seen[]): { name: string; args: Record<string, unknown> }[] =>
    seen.flatMap((s) => {
      if (s.rpc !== "tools/call") return [];
      const params = (JSON.parse(s.body) as { params: { name: string; arguments: Record<string, unknown> } }).params;
      return [{ name: params.name, args: params.arguments }];
    });

  test("a date filter selects the advanced tool and is passed through; publishedDate is kept on the results", async () => {
    await withFake({}, async (endpoint, seen) => {
      const c = client(endpoint);
      const result = await c.search({ query: "bun release notes", startPublishedDate: "2026-01-01", endPublishedDate: "2026-06-30T12:00:00+02:00" });
      assert.ok(result.ok);
      if (result.ok) {
        assert.equal(result.tool, "web_search_advanced_exa");
        assert.equal(result.results[0]?.publishedDate, "2026-01-01");
      }
      const [call] = calls(seen);
      assert.equal(call?.name, "web_search_advanced_exa");
      assert.equal(call?.args["startPublishedDate"], "2026-01-01");
      assert.equal(call?.args["endPublishedDate"], "2026-06-30T10:00:00.000Z");
      assert.equal("includeDomains" in (call?.args ?? {}), false);
      assert.equal("excludeDomains" in (call?.args ?? {}), false);
      assert.equal("objective" in (call?.args ?? {}), false);
      await c.close();
    });
  });

  test("recentDays is a start date N days before now; with startPublishedDate the later start applies", async () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    await withFake({}, async (endpoint, seen) => {
      const c = client(endpoint, { now: () => now });
      assert.ok((await c.search({ query: "q", recentDays: 7 })).ok);
      assert.ok((await c.search({ query: "q", recentDays: 7, startPublishedDate: "2026-10-25" })).ok);
      assert.ok((await c.search({ query: "q", recentDays: 7, startPublishedDate: "2026-01-01", excludeDomains: ["b.example"] })).ok);
      const [first, second, third] = calls(seen);
      assert.equal(first?.args["startPublishedDate"], "2026-10-21T12:00:00.000Z");
      assert.equal(second?.args["startPublishedDate"], "2026-10-25");
      assert.equal(third?.args["startPublishedDate"], "2026-10-21T12:00:00.000Z");
      assert.deepEqual(third?.args["excludeDomains"], ["b.example"]);
      await c.close();
    });
  });

  test("an invalid filter rejects with a TypeError before any request", async () => {
    await withFake({}, async (endpoint, seen) => {
      const c = client(endpoint);
      for (const params of [
        { query: "q", startPublishedDate: "last week" },
        { query: "q", startPublishedDate: "2026-02-30" },
        { query: "q", endPublishedDate: "2026-13-01" },
        { query: "q", recentDays: 0 },
        { query: "q", recentDays: Number.NaN },
        { query: "q", startPublishedDate: "2026-06-01", endPublishedDate: "2026-05-01" },
        // No offset: it would be read in the host's own time zone.
        { query: "q", startPublishedDate: "2026-10-28T10:00" },
        { query: "q", startPublishedDate: "2026-02-30T00:00:00Z" },
        { query: "q", startPublishedDate: "2026-10-28T24:00:00Z" },
        { query: "q", startPublishedDate: "0050-01-01" },
      ]) {
        await assert.rejects(c.search(params), TypeError, JSON.stringify(params));
      }
      assert.equal(seen.length, 0);
      // A recentDays reaching past year 1000 is clamped, never a RangeError.
      assert.ok((await c.search({ query: "q", recentDays: 1e12 })).ok);
      assert.equal(calls(seen)[0]?.args["startPublishedDate"], "1000-01-01T00:00:00.000Z");
      seen.length = 0;
      // No filter at all: the basic tool, exactly as before.
      assert.ok((await c.search({ query: "q" })).ok);
      assert.equal(calls(seen)[0]?.name, "web_search_exa");
      await c.close();
    });
  });
});
