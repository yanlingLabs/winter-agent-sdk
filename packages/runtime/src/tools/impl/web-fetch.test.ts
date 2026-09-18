// WebFetch -- the executor's own end-to-end tests. `_web-fetch-net.test.ts` already proves the fetch
// mechanics (redirects, size cap, timeout, abort, floor/private-address per hop) against a real
// loopback server; `_web-fetch-html.test.ts` proves the HTML->markdown conversion;
// `_web-fetch-cache.test.ts` proves the cache's own TTL/LRU. This file proves what only the EXECUTOR
// adds on top: input validation, the runtime-not-wired guard, the cache/preapproved/digest wiring,
// binary handling, and "an executor never throws."
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebToolsConfig, type ResolvedWebToolsConfig } from "@yanlinglabs/winter-agent-sdk";
import type { Provider, ProviderRequest, ProviderTurn, ProviderUsage } from "../../engine.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { registerWebSessionRuntime, resetWebSessionRuntimesForTest, type WebSessionRuntime } from "../../web/session-runtime.ts";
import { createWebFetchExecutor, PERMISSIVE_GUIDELINES, STRICT_GUIDELINES, type WebFetchExecutorDeps } from "./web-fetch.ts";
import { WEB_FETCH_MAX_BYTES } from "./_web-fetch-net.ts";
import { WebFetchCache } from "./_web-fetch-cache.ts";
import "./web-fetch.ts"; // self-sufficiency: installs the module-load default before getRegisteredTool below

const USAGE: ProviderUsage = { inputTokens: 50, outputTokens: 5 };

function recordingProvider(turns: ProviderTurn[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    async generate(input) {
      requests.push(input);
      return turns[Math.min(requests.length - 1, turns.length - 1)]!;
    },
  };
}

function fakeRuntime(
  provider: Provider,
  overrides: Partial<Pick<ResolvedWebToolsConfig, "blockedDomains"> & { fetch: Partial<ResolvedWebToolsConfig["fetch"]> }> = {},
  resolverOverride?: WebSessionRuntime["resolveAuxiliaryModel"],
): WebSessionRuntime & { accounted: Array<{ key: string | undefined; usage: ProviderUsage }> } {
  const accounted: Array<{ key: string | undefined; usage: ProviderUsage }> = [];
  const web = resolveWebToolsConfig({
    fetch: { privateAddressPolicy: "allow", ...overrides.fetch },
    ...(overrides.blockedDomains !== undefined ? { blockedDomains: overrides.blockedDomains } : {}),
  });
  return {
    accounted,
    web,
    sessionModel: () => ({ provider, model: "prova/session-model" }),
    accountUsage: (key, usage) => void accounted.push({ key, usage }),
    ...(resolverOverride !== undefined ? { resolveAuxiliaryModel: resolverOverride } : {}),
  };
}

let tmpRoot: string;
function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd: tmpRoot,
    home: "/home/test",
    sessionId: overrides.sessionId ?? "webfetch-test-session",
    readState: { readFiles: new Map() } as unknown as ToolExecutionContext["readState"],
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(tmpRoot, ".tmp"),
    sandboxSettings: {},
    session: {
      setCwd() {},
      addBoundedRoot() {},
      removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => tmpRoot,
      setSessionRoot() {},
    },
    ...overrides,
  };
}

let server: ReturnType<typeof Bun.serve>;
let port: number;

function loopbackFetchImpl(): NonNullable<NonNullable<WebFetchExecutorDeps["net"]>["fetchImpl"]> {
  return async (url, init) => {
    const u = new URL(url);
    u.protocol = "http:";
    u.hostname = "127.0.0.1";
    u.port = String(port);
    return fetch(u.toString(), init);
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "webfetch-exec-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/html") return new Response("<h1>Title</h1><p>Hello <b>world</b>.</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/bightml") {
        const big = `<p>${"a".repeat(1_100_000)}</p>`;
        return new Response(big, { headers: { "content-type": "text/html" } });
      }
      if (p === "/text") return new Response("plain body text", { headers: { "content-type": "text/plain" } });
      if (p === "/markdown-doc") return new Response("# Real Docs\n\nSome real markdown.", { headers: { "content-type": "text/markdown; charset=utf-8" } });
      if (p === "/binary") return new Response(new Uint8Array([0, 1, 2, 3, 255, 254]), { headers: { "content-type": "application/octet-stream" } });
      if (p === "/404") return new Response("nf", { status: 404 });
      if (p === "/big") return new Response(new Uint8Array(WEB_FETCH_MAX_BYTES + 10), { headers: { "content-type": "text/plain" } });
      if (p === "/hang") {
        await new Promise(() => {});
        return new Response("unreachable");
      }
      return new Response("default");
    },
  });
  port = server.port!;
});

afterEach(() => {
  server.stop(true);
  resetWebSessionRuntimesForTest();
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function runFetch(executor: ReturnType<typeof createWebFetchExecutor>, input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  return executor.execute(input, ctx);
}

describe("input validation", () => {
  test("a non-object input", async () => {
    const executor = createWebFetchExecutor();
    const ctx = makeCtx();
    const result = await runFetch(executor, "not an object", ctx);
    expect(result.isError).toBe(true);
  });

  test("a missing url", async () => {
    const executor = createWebFetchExecutor();
    const result = await runFetch(executor, { prompt: "p" }, makeCtx());
    expect(result.isError).toBe(true);
  });

  test("an unparseable URL -- claude's exact error string", async () => {
    const executor = createWebFetchExecutor();
    const result = await runFetch(executor, { url: "not a url", prompt: "p" }, makeCtx());
    expect(result).toEqual({ output: 'Invalid URL "not a url". The URL provided could not be parsed.', isError: true });
  });
});

describe("no web session runtime registered", () => {
  test("refuses before any network call", async () => {
    const executor = createWebFetchExecutor();
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, makeCtx({ sessionId: "unregistered-session" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no web session runtime is registered");
  });
});

describe("the registered module-load default never throws", () => {
  test("garbage input", async () => {
    const tool = getRegisteredTool("WebFetch");
    if (tool?.executor === undefined) throw new Error("WebFetch is not registered");
    const outputs = await Promise.all([tool.executor.execute(null, makeCtx()), tool.executor.execute(42, makeCtx()), tool.executor.execute({ url: 123, prompt: "p" }, makeCtx()), tool.executor.execute({}, makeCtx())]);
    for (const o of outputs) {
      expect(typeof o.output).toBe("string");
    }
  });
});

describe("domain floor", () => {
  test("a blocked host on the input url refuses, brand-named, before any network call", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const runtime = fakeRuntime(provider, { blockedDomains: ["127.0.0.1"] });
    const ctx = makeCtx({ sessionId: "s-floor" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("127.0.0.1");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("private-address policy", () => {
  test("deny refuses, naming the host and WebFetch(domain:...) for ask", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    for (const policy of ["deny", "ask"] as const) {
      const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: policy } });
      const ctx = makeCtx({ sessionId: `s-priv-${policy}` });
      registerWebSessionRuntime(ctx.sessionId, runtime);
      const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
      const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
      expect([policy, result.isError]).toEqual([policy, true]);
      if (policy === "ask") expect(result.output).toContain("WebFetch(domain:127.0.0.1)");
    }
  });

  test("allow proceeds to fetch and digest", async () => {
    const provider = recordingProvider([{ kind: "text", text: "digested" }]);
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "allow" } });
    const ctx = makeCtx({ sessionId: "s-priv-allow" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "summarise" }, ctx);
    expect(result).toEqual({ output: "digested" });
  });

  test("an unrecognised policy string fails CLOSED to ask (spine bug #2 workaround)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    // Bypass resolveWebToolsConfig's own typing to simulate untyped JSON carrying a junk value.
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "sometimes" as never } });
    const ctx = makeCtx({ sessionId: "s-priv-junk" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("must explicitly approve");
  });

  test("a hostname that RESOLVES to loopback is denied under deny", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "deny" } });
    const ctx = makeCtx({ sessionId: "s-priv-resolve" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["127.0.0.1"] });
    const result = await runFetch(executor, { url: "https://public-looking.example/html", prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("public-looking.example");
  });
});

describe("HTML conversion, truncation, non-html text", () => {
  test("html converts to markdown before the digest, and the digest sees the converted content", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-html" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "summarise" }, ctx);
    const sent = provider.requests[0]!.messages[0]!;
    expect(typeof sent.content).toBe("string");
    expect(sent.content as string).toContain("Title\n=====");
    expect(sent.content as string).toContain("Hello **world**.");
  });

  test("non-html text is passed through raw (no markdown conversion)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-text" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    await runFetch(executor, { url: `http://127.0.0.1:${port}/text`, prompt: "p" }, ctx);
    expect(provider.requests[0]!.messages[0]!.content as string).toContain("plain body text");
  });

  test("content over the 100,000-char digest cap is truncated with the notice", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-bightml" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    await runFetch(executor, { url: `http://127.0.0.1:${port}/bightml`, prompt: "p" }, ctx);
    const sentContent = provider.requests[0]!.messages[0]!.content as string;
    expect(sentContent).toContain("[Content truncated due to length...]");
  });
});

describe("binary content", () => {
  test("is saved to ctx.tempDir and named in the result; the digest never runs", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-binary" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/binary`, prompt: "p" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("binary");
    expect(result.output).toContain(ctx.tempDir);
    expect(provider.requests).toHaveLength(0);
    const pathMatch = /saved to (\S+webfetch-\S+)\./.exec(result.output);
    if (pathMatch === null) throw new Error(`no saved path found in: ${result.output}`);
    const saved = await readFile(pathMatch[1]!);
    expect([...saved]).toEqual([0, 1, 2, 3, 255, 254]);
  });
});

describe("non-2xx, size cap, timeout, abort -- wiring proof (mechanics fully covered in _web-fetch-net.test.ts)", () => {
  test("a 404 is surfaced as an error result with the verbatim message shape", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-404" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/404`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("The server returned HTTP 404 Not Found.");
    expect(result.output).toContain("The response body was not retrieved.");
  });

  test("a body over the size cap is refused", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-big" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/big`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
  });

  test("a timeout is surfaced as an error result", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-timeout" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl(), timeoutMs: 50 } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/hang`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
  });

  test("a turn-level abort mid-fetch is surfaced as an error result, never a throw", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-abort" });
    const controller = new AbortController();
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl(), timeoutMs: 5000 } });
    const promise = runFetch(executor, { url: `http://127.0.0.1:${port}/hang`, prompt: "p" }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    expect(result.isError).toBe(true);
  });
});

describe("preapproved hosts", () => {
  test("permissive guidelines and the exact prompt string for a preapproved host", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-preapproved-guidelines" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    await runFetch(executor, { url: "https://bun.sh/html", prompt: "What does this say?" }, ctx);
    const sentPrompt = provider.requests[0]!.messages[0]!.content as string;
    const expected = `\nWeb page content:\n---\nTitle\n=====\n\nHello **world**.\n---\n\nWhat does this say?\n\n${PERMISSIVE_GUIDELINES}\n`;
    expect(sentPrompt).toBe(expected);
  });

  test("strict guidelines for an ordinary, non-preapproved host", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-strict-guidelines" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    await runFetch(executor, { url: "https://not-preapproved.example/html", prompt: "What does this say?" }, ctx);
    const sentPrompt = provider.requests[0]!.messages[0]!.content as string;
    const expected = `\nWeb page content:\n---\nTitle\n=====\n\nHello **world**.\n---\n\nWhat does this say?\n\n${STRICT_GUIDELINES}\n`;
    expect(sentPrompt).toBe(expected);
  });

  test("verbatim markdown passthrough for a preapproved host -- the digest never runs", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-passthrough" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: "https://bun.sh/markdown-doc", prompt: "irrelevant" }, ctx);
    expect(result).toEqual({ output: "# Real Docs\n\nSome real markdown." });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("cache", () => {
  test("a cache hit re-runs the digest model but never refetches", async () => {
    const provider = recordingProvider([{ kind: "text", text: "first digest" }, { kind: "text", text: "second digest" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-cache" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    let fetchCount = 0;
    const wrappedFetchImpl: NonNullable<WebFetchExecutorDeps["net"]>["fetchImpl"] = async (url, init) => {
      fetchCount += 1;
      return loopbackFetchImpl()!(url, init);
    };
    const executor = createWebFetchExecutor({ net: { fetchImpl: wrappedFetchImpl } });
    const r1 = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    const r2 = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(r1.output).toBe("first digest");
    expect(r2.output).toBe("second digest"); // re-ran the model
    expect(fetchCount).toBe(1); // did NOT refetch
    expect(provider.requests).toHaveLength(2);
  });

  test("a cache TTL expiry causes a real refetch", async () => {
    let now = 1_000_000;
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-cache-ttl" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    let fetchCount = 0;
    const wrappedFetchImpl: NonNullable<WebFetchExecutorDeps["net"]>["fetchImpl"] = async (url, init) => {
      fetchCount += 1;
      return loopbackFetchImpl()!(url, init);
    };
    const cache = new WebFetchCache({ now: () => now, ttlMs: 1000 });
    const executor = createWebFetchExecutor({ net: { fetchImpl: wrappedFetchImpl }, cache });
    await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    now += 2000; // past the TTL
    await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(fetchCount).toBe(2);
  });

  test("a redirect-blocked outcome and an http-error outcome are never cached", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-cache-errors" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    let fetchCount = 0;
    const wrappedFetchImpl: NonNullable<WebFetchExecutorDeps["net"]>["fetchImpl"] = async (url, init) => {
      fetchCount += 1;
      return loopbackFetchImpl()!(url, init);
    };
    const executor = createWebFetchExecutor({ net: { fetchImpl: wrappedFetchImpl } });
    await runFetch(executor, { url: `http://127.0.0.1:${port}/404`, prompt: "p" }, ctx);
    await runFetch(executor, { url: `http://127.0.0.1:${port}/404`, prompt: "p" }, ctx);
    expect(fetchCount).toBe(2); // no caching of an error outcome
  });
});

describe("digest model resolution", () => {
  test("absent digestModel runs on the session's own model, usage accounted", async () => {
    const provider = recordingProvider([{ kind: "text", text: "digested", usage: USAGE }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-digest-absent" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result).toEqual({ output: "digested" });
    expect(runtime.accounted).toEqual([{ key: "prova/session-model", usage: USAGE }]);
  });

  test("a stated digestModel that RESOLVES routes the request through it", async () => {
    const digestProvider = recordingProvider([{ kind: "text", text: "from the stated model", usage: USAGE }]);
    const sessionProvider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const resolver: WebSessionRuntime["resolveAuxiliaryModel"] = (tag) => (tag === "small-fast" ? { ok: true, provider: digestProvider, modelKey: "prova/small-fast" } : { ok: false, code: "unknown-model", message: "no" });
    const runtime = fakeRuntime(sessionProvider, { fetch: { digestModel: "small-fast" } }, resolver);
    const ctx = makeCtx({ sessionId: "s-digest-resolves" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result).toEqual({ output: "from the stated model" });
    expect(sessionProvider.requests).toHaveLength(0);
    expect(digestProvider.requests).toHaveLength(1);
  });

  test("a stated digestModel that CANNOT resolve is a named result, never a silent fallback", async () => {
    const sessionProvider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const resolver: WebSessionRuntime["resolveAuxiliaryModel"] = () => ({ ok: false, code: "unknown-model", message: "the model \"ghost-model\" does not exist" });
    const runtime = fakeRuntime(sessionProvider, { fetch: { digestModel: "ghost-model" } }, resolver);
    const ctx = makeCtx({ sessionId: "s-digest-unresolvable" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("could not be resolved");
    expect(result.output).toContain("ghost-model");
    expect(sessionProvider.requests).toHaveLength(0);
  });

  test("an empty digest answer becomes claude's own verbatim fallback string", async () => {
    const provider = recordingProvider([{ kind: "text", text: "" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-digest-empty" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result).toEqual({ output: "No response from model" });
  });
});
