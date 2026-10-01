// Search (Exa answer mode) -- the executor, fixture-driven: every call goes to an injected `fetch`, never
// the network. Pins the request (endpoint, header, body, no redirects), the rendering, the caps, the
// dangerous-domain floor on cited urls, the status vocabulary, and the host-only site icons.
import { afterEach, describe, expect, test } from "bun:test";
import { resolveWebToolsConfig, type CredentialRef, type WebToolsConfig } from "@yanlinglabs/winter-agent-sdk";
import "./search.ts";
import { createSearchExecutor, EXA_ANSWER_URL, SEARCH_ANSWER_CHARS, SEARCH_NO_KEY_MESSAGE, SEARCH_TOTAL_OUTPUT_CHARS, searchStatusMessage } from "./search.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { registerWebSessionRuntime, resetWebSessionRuntimesForTest, type WebSessionRuntime } from "../../web/session-runtime.ts";
import type { ToolSecretResult } from "../../provider/tool-secret.ts";

const KEY = "exa-test-key-123";
const REF: CredentialRef = { kind: "keychain", account: "exa-api-key", service: "test.service" };

afterEach(() => resetWebSessionRuntimesForTest());

function ctx(sessionId: string, over: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: "/work",
    home: "/home/test",
    sessionId,
    readState: createSessionReadState({ cwd: process.cwd() }),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/work/.tmp",
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...over,
  };
}

function wire(sessionId: string, opts: { web?: WebToolsConfig; secret?: ToolSecretResult | (() => Promise<ToolSecretResult>); noResolver?: true } = {}): { refs: CredentialRef[] } {
  const refs: CredentialRef[] = [];
  const secret = opts.secret ?? { status: "found", key: KEY };
  const runtime: WebSessionRuntime = {
    web: resolveWebToolsConfig(opts.web ?? { search: { authRef: REF } }),
    sessionModel: () => ({ provider: { async generate() { return { kind: "text", text: "" }; } }, model: "m" }),
    accountUsage() {},
    ...(opts.noResolver === true
      ? {}
      : {
          resolveToolSecret: async (ref: CredentialRef) => {
            refs.push(ref);
            return typeof secret === "function" ? secret() : secret;
          },
        }),
  };
  registerWebSessionRuntime(sessionId, runtime);
  return { refs };
}

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: () => Response | Promise<Response>, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function run(sessionId: string, input: unknown, fetchFn: typeof fetch): Promise<ToolResultPayload> {
  return createSearchExecutor({ fetchFn }).execute(input, ctx(sessionId));
}

describe("Search: the request", () => {
  test("POSTs `{query}` to Exa's /answer with the key in `x-api-key`, follows no redirect, and resolves the key through the session's resolver", async () => {
    const { refs } = wire("s-req");
    const seen: Seen[] = [];
    await run("s-req", { query: "what changed in bun 2?" }, fakeFetch(() => json({ answer: "A", citations: [] }), seen));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(EXA_ANSWER_URL);
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.redirect).toBe("manual");
    expect((seen[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ query: "what changed in bun 2?" });
    expect(refs).toEqual([REF]);
  });

  test("the registered executor is wired (a call with no key reaches the no-key answer, not 'not yet executable')", async () => {
    wire("s-reg", { secret: { status: "missing" } });
    const executor = getRegisteredTool("Search")?.executor;
    expect(executor).toBeDefined();
    const out = await executor!.execute({ query: "q" }, ctx("s-reg"));
    expect(out).toEqual({ output: SEARCH_NO_KEY_MESSAGE, isError: true });
  });
});

describe("Search: rendering", () => {
  test("the answer, then a numbered Sources list (title, then url)", async () => {
    wire("s-render");
    const out = await run("s-render", { query: "q" }, fakeFetch(() => json({ answer: "  The answer.  ", citations: [{ title: " Page One ", url: "https://one.example.com/a" }, { url: "https://two.example.com/" }] })));
    expect(out.isError).toBeUndefined();
    expect(out.output).toBe("The answer.\n\nSources:\n1. Page One\n   https://one.example.com/a\n2. -\n   https://two.example.com/");
  });

  test("no answer reads `no answer for <query>`; an answer with no sources is marked unsourced", async () => {
    wire("s-empty");
    expect((await run("s-empty", { query: "zz" }, fakeFetch(() => json({ answer: "", citations: [] })))).output).toBe("no answer for zz");
    expect((await run("s-empty", { query: "zz" }, fakeFetch(() => json({ answer: "Yes." })))).output).toBe(
      "Yes.\n\n[unsourced — the search service returned no sources; say so if you repeat this]",
    );
  });

  test("an over-long answer is cut and SAYS so; the whole output is capped and says so", async () => {
    wire("s-cap");
    const long = "x".repeat(SEARCH_ANSWER_CHARS + 10);
    const cut = await run("s-cap", { query: "q" }, fakeFetch(() => json({ answer: long, citations: [{ title: "t", url: "https://a.example.com/" }] })));
    expect(cut.output.startsWith("x".repeat(SEARCH_ANSWER_CHARS) + "\n\n[answer truncated]")).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => ({ title: "t".repeat(2000), url: `https://a${i}.example.com/` }));
    const capped = await run("s-cap", { query: "q" }, fakeFetch(() => json({ answer: "y".repeat(SEARCH_ANSWER_CHARS), citations: many })));
    expect(capped.output.length).toBe(SEARCH_TOTAL_OUTPUT_CHARS + "\n\n[truncated]".length);
    expect(capped.output.endsWith("\n\n[truncated]")).toBe(true);
  });
});

describe("Search: the dangerous-domain floor on cited urls", () => {
  test("a floor-listed citation is withheld and COUNTED, never silently dropped", async () => {
    wire("s-floor", { web: { search: { authRef: REF }, blockedDomains: ["evil.example"] } });
    const out = await run("s-floor", { query: "q" }, fakeFetch(() => json({ answer: "A", citations: [{ title: "ok", url: "https://good.example.com/" }, { title: "bad", url: "https://www.evil.example/x" }] })));
    expect(out.output).toBe("A\n\nSources:\n1. ok\n   https://good.example.com/\n\n[1 source withheld — matched the dangerous-domain list]");
  });

  test("every source withheld: the answer is marked unsourced for THAT reason", async () => {
    wire("s-floor2", { web: { search: { authRef: REF }, blockedDomains: ["evil.example"] } });
    const out = await run("s-floor2", { query: "q" }, fakeFetch(() => json({ answer: "A", citations: [{ url: "https://evil.example/" }, { url: "https://a.evil.example/" }] })));
    expect(out.output).toBe("A\n\n[unsourced — every source was withheld by the dangerous-domain list; say so if you repeat this]\n\n[2 sources withheld — matched the dangerous-domain list]");
  });

  test("a host's LIVE floor rides the input's `blocked_domains` (a PreToolUse hook's addition): it adds to the spawn-time list, and is never sent to Exa", async () => {
    wire("s-floor-live", { web: { search: { authRef: REF }, blockedDomains: ["evil.example"] } });
    const seen: Seen[] = [];
    const out = await run(
      "s-floor-live",
      { query: "q", blocked_domains: ["later.example", 7, ""] },
      fakeFetch(() => json({ answer: "A", citations: [{ title: "ok", url: "https://good.example.com/" }, { url: "https://www.later.example/x" }, { url: "https://evil.example/" }] }), seen),
    );
    expect(out.output).toBe("A\n\nSources:\n1. ok\n   https://good.example.com/\n\n[2 sources withheld — matched the dangerous-domain list]");
    expect(seen.map((s) => s.init.body)).toEqual([JSON.stringify({ query: "q" })]);
  });
});

describe("Search: site icons (host-only)", () => {
  test("each surviving citation's Exa favicon rides `siteIcons`, never the output; a withheld citation's icon does not", async () => {
    wire("s-icons", { web: { search: { authRef: REF }, blockedDomains: ["evil.example"] } });
    const out = await run(
      "s-icons",
      { query: "q" },
      fakeFetch(() =>
        json({
          answer: "A",
          citations: [
            { title: "one", url: "https://one.example.com/a", favicon: "https://one.example.com/favicon.ico" },
            { title: "two", url: "https://two.example.org/", favicon: "http://insecure.example.org/i.png" },
            { title: "bad", url: "https://evil.example/", favicon: "https://evil.example/f.png" },
          ],
        }),
      ),
    );
    expect(out.siteIcons).toEqual([{ url: "https://one.example.com/a", iconUrl: "https://one.example.com/favicon.ico" }]);
    expect(out.output).not.toContain("favicon");
  });
});

describe("Search: failures", () => {
  test("no key named, no resolver, a missing key: one actionable sentence, an error result, NO request", async () => {
    const seen: Seen[] = [];
    wire("s-nokey1", { web: {} });
    expect(await run("s-nokey1", { query: "q" }, fakeFetch(() => json({}), seen))).toEqual({ output: SEARCH_NO_KEY_MESSAGE, isError: true });
    wire("s-nokey2", { noResolver: true });
    expect(await run("s-nokey2", { query: "q" }, fakeFetch(() => json({}), seen))).toEqual({ output: SEARCH_NO_KEY_MESSAGE, isError: true });
    wire("s-nokey3", { secret: { status: "missing" } });
    expect(await run("s-nokey3", { query: "q" }, fakeFetch(() => json({}), seen))).toEqual({ output: SEARCH_NO_KEY_MESSAGE, isError: true });
    expect(seen).toHaveLength(0);
  });

  test("an unreadable key says why, without the key", async () => {
    wire("s-unread", { secret: { status: "unreadable", code: "malformed", message: "keychain:test.service/exa-api-key holds no usable key" } });
    const out = await run("s-unread", { query: "q" }, fakeFetch(() => json({})));
    expect(out.isError).toBe(true);
    expect(out.output).toBe("search failed: an Exa API key is configured but could not be used: keychain:test.service/exa-api-key holds no usable key");
  });

  test("each documented status maps to its own sentence, and the response BODY never reaches the model", async () => {
    wire("s-status");
    for (const status of [400, 401, 402, 403, 429, 500, 302]) {
      const out = await run("s-status", { query: "q" }, fakeFetch(() => new Response(`echo ${KEY} secret body`, { status })));
      expect(out).toEqual({ output: searchStatusMessage(status), isError: true });
      expect(out.output).not.toContain(KEY);
    }
    expect(searchStatusMessage(401)).toContain("key was rejected");
    expect(searchStatusMessage(402)).toContain("out of credits");
    expect(searchStatusMessage(429)).toContain("rate-limiting");
    expect(searchStatusMessage(503)).toBe("search failed: the search service is unavailable (HTTP 503)");
  });

  test("a network failure never echoes the exception (which can embed the key)", async () => {
    wire("s-net");
    const original = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    try {
      const out = await run("s-net", { query: "q" }, (async () => {
        throw new TypeError(`Header 'x-api-key' has invalid value: '${KEY}'`);
      }) as unknown as typeof fetch);
      expect(out).toEqual({ output: "search failed: could not reach the search service", isError: true });
      expect(logged.join("\n")).not.toContain(KEY);
      expect(logged.join("\n")).toContain("<redacted>");
    } finally {
      console.error = original;
    }
  });

  test("a timeout names the query; a malformed body is a parse error", async () => {
    wire("s-timeout");
    const timeout = await createSearchExecutor({
      timeoutMs: 5,
      fetchFn: ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch,
    }).execute({ query: "slow one" }, ctx("s-timeout"));
    expect(timeout).toEqual({ output: "search timed out for slow one", isError: true });
    for (const body of [{ citations: "str" }, { citations: {} }, { citations: [null] }, { answer: { structured: true } }]) {
      expect(await run("s-timeout", { query: "q" }, fakeFetch(() => json(body)))).toEqual({ output: "search failed: malformed response from search service", isError: true });
    }
    const notJson = await run("s-timeout", { query: "q" }, fakeFetch(() => new Response("<html>", { status: 200 })));
    expect(notJson.isError).toBe(true);
    expect(notJson.output.startsWith("search failed: could not parse response")).toBe(true);
  });

  test("an empty query is refused before anything else; a switched-off backend says so", async () => {
    wire("s-q");
    expect(await run("s-q", { query: "   " }, fakeFetch(() => json({})))).toEqual({ output: "Error: Missing query", isError: true });
    wire("s-off", { web: { search: { enabled: false, authRef: REF } } });
    expect(await run("s-off", { query: "q" }, fakeFetch(() => json({})))).toEqual({ output: "Web search is turned off for this session." });
  });
});
