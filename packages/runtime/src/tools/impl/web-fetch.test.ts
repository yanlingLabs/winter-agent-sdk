// WebFetch -- the executor's own end-to-end tests. `_web-fetch-net.test.ts` already proves the fetch
// mechanics (redirects, size cap, timeout, abort, floor/private-address per hop) against a real
// loopback server; `_web-fetch-html.test.ts` proves the HTML->markdown conversion;
// `_web-fetch-cache.test.ts` proves the cache's own TTL/LRU. This file proves what only the EXECUTOR
// adds on top: input validation, the runtime-not-wired guard, the cache/preapproved/digest wiring,
// binary handling, and "an executor never throws."
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebToolsConfig, type ResolvedWebToolsConfig } from "@yanlinglabs/winter-agent-sdk";
import type { Provider, ProviderRequest, ProviderTurn, ProviderUsage } from "../../engine.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { registerWebSessionRuntime, resetWebSessionRuntimesForTest, type WebSessionRuntime } from "../../web/session-runtime.ts";
import {
  BINARY_SAVE_BUDGET_BYTES,
  createWebFetchExecutor,
  PERMISSIVE_GUIDELINES,
  saveBinaryToTemp,
  STRICT_GUIDELINES,
  WEB_FETCH_BUDGET_STOP_MESSAGE,
  type WebFetchExecutorDeps,
} from "./web-fetch.ts";
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
      if (p === "/binary-9mb") return new Response(new Uint8Array(9_000_000), { headers: { "content-type": "application/octet-stream" } });
      if (p === "/xhtml") return new Response("<h1>Title</h1><p>Hello <b>world</b>.</p>", { headers: { "content-type": "application/xhtml+xml; charset=utf-8" } });
      if (p === "/404") return new Response("nf", { status: 404 });
      if (p === "/redir-other-private") return new Response(null, { status: 302, headers: { location: "http://10.9.9.9/secret" } });
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

  test("an unparseable URL -- claude's exact error string, WITH the Error: prefix (security review corrections §4.2)", async () => {
    const executor = createWebFetchExecutor();
    const result = await runFetch(executor, { url: "not a url", prompt: "p" }, makeCtx());
    expect(result).toEqual({ output: 'Error: Invalid URL "not a url". The URL provided could not be parsed.', isError: true });
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

  test("the message has NO trailing period (security review corrections §4.6, measured against the binary)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const runtime = fakeRuntime(provider, { blockedDomains: ["127.0.0.1"] });
    const ctx = makeCtx({ sessionId: "s-floor-period" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.output).toBe("Winter is unable to fetch from 127.0.0.1");
    expect(result.output.endsWith(".")).toBe(false);
  });

  test("a cache HIT is re-gated against the private-address policy (a policy change since caching still applies)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "digested" }]);
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "allow" } });
    const ctx = makeCtx({ sessionId: "s-cache-then-deny" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    // First call: allowed, populates the cache.
    const first = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(first).toEqual({ output: "digested" });
    // The session's policy is now "deny" (e.g. a live settings change) -- the SAME executor instance,
    // same cache, same URL: the cached content must not be served past the new policy.
    const denyingRuntime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "deny" } });
    registerWebSessionRuntime(ctx.sessionId, denyingRuntime);
    const second = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("127.0.0.1");
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

describe("private-address policy 'ask': the executor honours the permission layer's explicit-approval marker", () => {
  // The ASK happens before execution, in the permission layer; what reaches the executor is
  // `ctx.permission.explicitApproval`. These rows pin the executor's half: proceed WITH the marker,
  // keep refusing without it, and keep refusing the one case no pre-execution ask could have covered.
  function askSession(sessionId: string, permission?: ToolExecutionContext["permission"]) {
    const provider = recordingProvider([{ kind: "text", text: "digested" }]);
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "ask" } });
    const ctx = makeCtx({ sessionId, ...(permission !== undefined ? { permission } : {}) });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    return { provider, ctx };
  }

  /** A `fetchImpl` that records every url the net layer actually asked for, then serves it from the local server. */
  function recordingFetch() {
    const fetched: string[] = [];
    const inner = loopbackFetchImpl();
    const fetchImpl: typeof inner = async (url, init) => {
      fetched.push(url);
      return inner(url, init);
    };
    return { fetched, fetchImpl };
  }

  test("a lexically-private target WITHOUT the marker keeps today's refusal, verbatim, and nothing is fetched", async () => {
    const { ctx, provider } = askSession("s-ask-unmarked");
    const { fetched, fetchImpl } = recordingFetch();
    const result = await runFetch(createWebFetchExecutor({ net: { fetchImpl } }), { url: "http://192.168.1.10/html", prompt: "p" }, ctx);
    expect(result).toEqual({
      output: "WebFetch cannot prompt for approval mid-call. 192.168.1.10 is a private/loopback address; the user must explicitly approve WebFetch(domain:192.168.1.10) before this URL can be fetched.",
      isError: true,
    });
    expect(fetched).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });

  test("a lexically-private target WITH the marker is fetched and digested -- by prompt, and by a rule naming the host", async () => {
    for (const explicitApproval of ["prompt", "rule"] as const) {
      for (const url of ["http://192.168.1.10/html", "http://api.localhost/html", "http://printer.local/html"]) {
        const { ctx } = askSession(`s-ask-${explicitApproval}-${url}`, { explicitApproval });
        const { fetched, fetchImpl } = recordingFetch();
        const result = await runFetch(createWebFetchExecutor({ net: { fetchImpl }, resolveHost: async () => ["127.0.0.1"] }), { url, prompt: "p" }, ctx);
        expect([url, result]).toEqual([url, { output: "digested" }]);
        expect(fetched).toHaveLength(1);
      }
    }
  });

  test("THE LATE CASE: a public-looking name that RESOLVES private is still refused after a PROMPT approval -- nobody was told -- and the refusal names the rule that permits it", async () => {
    for (const permission of [undefined, { explicitApproval: "prompt" as const }]) {
      const { ctx, provider } = askSession(`s-ask-late-${permission?.explicitApproval ?? "none"}`, permission);
      const { fetched, fetchImpl } = recordingFetch();
      const executor = createWebFetchExecutor({ net: { fetchImpl }, resolveHost: async () => ["127.0.0.1"] });
      const result = await runFetch(executor, { url: "https://public-looking.example/html", prompt: "p" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toBe(
        "WebFetch will not reach public-looking.example: it resolves to a private/loopback address. That is only discoverable at fetch time, so no approval could be asked for it beforehand, and WebFetch cannot prompt for approval mid-call. An allow rule naming the host permits it: WebFetch(domain:public-looking.example).",
      );
      expect(fetched).toHaveLength(0);
      expect(provider.requests).toHaveLength(0);
    }
  });

  test("THE LATE CASE, with exactly the rule that refusal names: `WebFetch(domain:<host>)` arrives as 'rule' and the fetch proceeds", async () => {
    const { ctx } = askSession("s-ask-late-rule", { explicitApproval: "rule" });
    const { fetched, fetchImpl } = recordingFetch();
    const executor = createWebFetchExecutor({ net: { fetchImpl }, resolveHost: async () => ["10.1.2.3"] });
    const result = await runFetch(executor, { url: "https://intranet.example/html", prompt: "p" }, ctx);
    expect(result).toEqual({ output: "digested" });
    expect(fetched).toHaveLength(1);
  });

  test("approval of ONE private host never reaches ANOTHER: a redirect to a different private host is returned to the model, not followed", async () => {
    for (const explicitApproval of ["prompt", "rule"] as const) {
      const { ctx, provider } = askSession(`s-ask-redirect-${explicitApproval}`, { explicitApproval });
      const { fetched, fetchImpl } = recordingFetch();
      const result = await runFetch(createWebFetchExecutor({ net: { fetchImpl } }), { url: "http://192.168.1.10/redir-other-private", prompt: "p" }, ctx);
      expect(fetched).toHaveLength(1); // the approved host only -- 10.9.9.9 was never requested
      expect(fetched[0]).toContain("192.168.1.10");
      expect(result.output).toContain("10.9.9.9"); // relayed as a redirect for the model to re-request...
      expect(provider.requests).toHaveLength(0); // ...which is a NEW call, back through the permission layer
    }
  });

  test("the marker means nothing under 'deny' -- deny is absolute", async () => {
    const provider = recordingProvider([{ kind: "text", text: "digested" }]);
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "deny" } });
    for (const explicitApproval of ["prompt", "rule"] as const) {
      const ctx = makeCtx({ sessionId: `s-deny-marked-${explicitApproval}`, permission: { explicitApproval } });
      registerWebSessionRuntime(ctx.sessionId, runtime);
      const { fetched, fetchImpl } = recordingFetch();
      const result = await runFetch(createWebFetchExecutor({ net: { fetchImpl } }), { url: "http://192.168.1.10/html", prompt: "p" }, ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("policy denies WebFetch access to private addresses");
      expect(fetched).toHaveLength(0);
    }
  });

  test("a cache HIT obeys the same rule: served with the marker, refused without it", async () => {
    const provider = recordingProvider([{ kind: "text", text: "digested" }]);
    const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "ask" } });
    registerWebSessionRuntime("s-ask-cache", runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const url = "http://192.168.1.10/html";
    expect(await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId: "s-ask-cache", permission: { explicitApproval: "prompt" } }))).toEqual({ output: "digested" });
    // Same session, same url, now cached -- but THIS call was not explicitly approved.
    const unmarked = await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId: "s-ask-cache" }));
    expect(unmarked.isError).toBe(true);
    expect(unmarked.output).toContain("must explicitly approve WebFetch(domain:192.168.1.10)");
    expect(await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId: "s-ask-cache", permission: { explicitApproval: "rule" } }))).toEqual({ output: "digested" });
  });
});

describe("the digest pass stopped by the session's BUDGET is not reported as an interruption", () => {
  test("a budget stop says the spending limit was reached and that retrying will not help", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should never run" }]);
    const runtime = { ...fakeRuntime(provider), budgetExceeded: () => true };
    const ctx = makeCtx({ sessionId: "s-budget-stop" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const result = await runFetch(createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } }), { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result).toEqual({ output: WEB_FETCH_BUDGET_STOP_MESSAGE, isError: true });
    expect(result.output).toContain("spending limit");
    expect(result.output).toContain("Retrying will not help");
    expect(result.output).not.toContain("interrupted");
    expect(provider.requests).toHaveLength(0);
  });

  test("a genuine interruption of the digest pass keeps the 'was interrupted' wording", async () => {
    const controller = new AbortController();
    const provider: Provider = {
      async generate() {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-digest-interrupted", signal: controller.signal });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const result = await runFetch(createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } }), { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result).toEqual({ output: "WebFetch was interrupted before it could answer.", isError: true });
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

  test("security review minor: the saved file is 0o600 (owner-only)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-binary-mode" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/binary`, prompt: "p" }, ctx);
    const pathMatch = /saved to (\S+webfetch-\S+)\./.exec(result.output);
    if (pathMatch === null) throw new Error(`no saved path found in: ${result.output}`);
    const info = await stat(pathMatch[1]!);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("security review minor: a per-session save budget bounds disk use -- a looping model cannot fill the disk", async () => {
    const provider = recordingProvider([{ kind: "text", text: "should not run" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-binary-budget" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    // Six 9 MB saves (54 MB) exceed the 50 MiB per-session budget on the sixth call; each is under
    // WebFetch's own 10,485,760-byte BODY cap, which is a different limit than the save budget.
    let lastOutput = "";
    for (let i = 0; i < 6; i++) {
      const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/binary-9mb`, prompt: "p" }, ctx);
      lastOutput = result.output;
      if (i < 5) expect(result.output).toContain("saved to");
    }
    expect(lastOutput).toContain("budget");
    expect(lastOutput).not.toContain("saved to");
  });

  test("item 1: the budget is RESERVED synchronously, so 12 genuinely concurrent 10 MiB saves never overspend it", async () => {
    // Calling the async function 12 times in a plain loop -- with NO `await` between calls -- is
    // what makes this deterministic rather than network-jitter-dependent: each call runs
    // synchronously up to its own first `await` (inside `saveBinaryToTemp`, that is `await
    // mkdir(...)`), so if the budget check-and-reserve happens before that point, all 12 checks run
    // back-to-back in one microtask BEFORE any of the 12 writes has a chance to complete -- exactly
    // the race the bug report measured (120 MiB saved against a 50 MiB budget). Fails before the fix
    // (all 12 pass the check, all 12 save) and passes after it (only 5 fit; 7 are budget-exceeded).
    const sessionId = "s-binary-budget-concurrent";
    const tenMiB = new Uint8Array(10 * 1024 * 1024);
    const url = new URL("https://example.com/file.bin");
    const fakeCtx = { tempDir: join(tmpRoot, ".tmp-concurrent"), sessionId } as unknown as ToolExecutionContext;

    const promises: ReturnType<typeof saveBinaryToTemp>[] = [];
    for (let i = 0; i < 12; i++) promises.push(saveBinaryToTemp(fakeCtx, url, tenMiB));
    const results = await Promise.all(promises);

    const saved = results.filter((r): r is string => typeof r === "string" && r !== "budget-exceeded");
    const budgetExceeded = results.filter((r) => r === "budget-exceeded");
    // 5 * 10 MiB == 50 MiB exactly fits the budget (the boundary case, spent + bytes === BUDGET, must
    // still be accepted); a 6th would push it to 60 MiB and must be refused.
    expect(saved.length).toBe(5);
    expect(budgetExceeded.length).toBe(7);

    let totalBytesOnDisk = 0;
    for (const path of saved) totalBytesOnDisk += (await stat(path)).size;
    expect(totalBytesOnDisk).toBe(5 * 10 * 1024 * 1024);
    expect(totalBytesOnDisk).toBeLessThanOrEqual(BINARY_SAVE_BUDGET_BYTES);
  });
});

describe("security review fidelity #10: only text/html converts, not xhtml", () => {
  test("application/xhtml+xml is passed through raw (as text), never markdown-converted", async () => {
    const provider = recordingProvider([{ kind: "text", text: "ok" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-xhtml" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    await runFetch(executor, { url: `http://127.0.0.1:${port}/xhtml`, prompt: "p" }, ctx);
    const sent = provider.requests[0]!.messages[0]!.content as string;
    // Raw markup survives (never converted to "Title\n=====" the way real text/html would be).
    expect(sent).toContain("<h1>Title</h1>");
    expect(sent).not.toContain("=====");
  });
});

describe("security review finding M5: the digest model's failure message is never forwarded", () => {
  test("a provider-error digest failure is a fixed sentence, never the underlying provider message", async () => {
    const failingProvider: Provider = {
      async generate() {
        throw Object.assign(new Error("connect ECONNREFUSED proxy http://user:SECRETPASS@proxy.corp:8080"), { winterProviderFailure: true, name: "ProviderFailure" });
      },
    };
    const runtime = fakeRuntime(failingProvider);
    const ctx = makeCtx({ sessionId: "s-provider-error" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("SECRETPASS");
    expect(result.output).not.toContain("proxy.corp");
    expect(result.output).toBe("The digest model failed.");
  });
});

describe("security review finding B1: the executor never throws, even when a dependency misbehaves", () => {
  test("a fetchImpl that throws synchronously is still a result, not an unhandled rejection", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-b1-throw" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({
      net: {
        fetchImpl: () => {
          throw new Error("synchronous failure, not even a rejected promise");
        },
      },
    });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(typeof result.output).toBe("string");
  });

  test("a cache whose get() throws is still a result, not a throw (the last-resort catch)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-b1-cache-throw" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const brokenCache = { get: () => { throw new Error("cache is on fire"); }, set: () => {} } as unknown as WebFetchCache;
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, cache: brokenCache });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/html`, prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("failed unexpectedly");
  });
});

describe("non-2xx, size cap, timeout, abort -- wiring proof (mechanics fully covered in _web-fetch-net.test.ts)", () => {
  test("a 404 is surfaced with the verbatim message shape -- as an ORDINARY result, never `isError` (claude's own measured posture)", async () => {
    const provider = recordingProvider([{ kind: "text", text: "x" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-404" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() } });
    const result = await runFetch(executor, { url: `http://127.0.0.1:${port}/404`, prompt: "p" }, ctx);
    expect(result.isError).toBe(false);
    expect(provider.requests.length, "no digest pass for a non-2xx answer").toBe(0);
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
    // resolveHost is stubbed so this test is hermetic (bun.sh is a REAL preapproved hostname, never
    // actually reached -- the fetchImpl rewrite below routes the actual bytes to the loopback server).
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["93.184.216.34"] });
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
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["93.184.216.34"] });
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
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["93.184.216.34"] });
    const result = await runFetch(executor, { url: "https://bun.sh/markdown-doc", prompt: "irrelevant" }, ctx);
    expect(result).toEqual({ output: "# Real Docs\n\nSome real markdown." });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("cache", () => {
  test("security review minor: a cache-hit's private-address lookup is raced against the turn's abort signal", async () => {
    const provider = recordingProvider([{ kind: "text", text: "digested" }]);
    const runtime = fakeRuntime(provider);
    const ctx = makeCtx({ sessionId: "s-cache-hit-abort" });
    registerWebSessionRuntime(ctx.sessionId, runtime);
    // A NAME-based host (not a literal IP): `classifyHostname` short-circuits an IP literal
    // LEXICALLY, never calling `resolveHost` at all, which would make this test exercise nothing.
    const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["127.0.0.1"] });
    await runFetch(executor, { url: "https://cache-hit-abort.test/html", prompt: "p" }, ctx); // populate the cache
    const controller = new AbortController();
    const hangingResolveHost = createWebFetchExecutor({
      net: { fetchImpl: loopbackFetchImpl() },
      resolveHost: () => new Promise(() => {}), // never resolves
    });
    const promise = runFetch(hangingResolveHost, { url: "https://cache-hit-abort.test/html", prompt: "p" }, { ...ctx, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.output).toBe("WebFetch was interrupted.");
  });

  describe("item 2: a cache-hit whose DNS lookup FAILS reports 'could not resolve', never 'it is private'", () => {
    // A resolver that always fails: no address is known at all, so the host is not actually
    // demonstrated to be private -- it is simply unresolvable. Before the fix, `privateAddressRefusal`
    // could not tell this apart from a genuinely private address and said so anyway (false).
    function failingResolveHost(): Promise<readonly string[]> {
      return Promise.reject(new Error("ENOTFOUND"));
    }

    async function populateCache(sessionId: string, url: string): Promise<void> {
      const provider = recordingProvider([{ kind: "text", text: "digested" }]);
      const runtime = fakeRuntime(provider, { fetch: { privateAddressPolicy: "allow" } });
      const ctx = makeCtx({ sessionId });
      registerWebSessionRuntime(ctx.sessionId, runtime);
      const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["93.184.216.34"] });
      const result = await runFetch(executor, { url, prompt: "p" }, ctx);
      expect(result).toEqual({ output: "digested" });
    }

    test("under 'deny', a resolution failure says 'could not resolve', not 'it is a private/loopback address'", async () => {
      const sessionId = "s-cache-hit-dns-fail-deny";
      const url = "https://dns-fail-deny.test/html";
      await populateCache(sessionId, url);
      const runtime = fakeRuntime(recordingProvider([{ kind: "text", text: "should not run" }]), { fetch: { privateAddressPolicy: "deny" } });
      registerWebSessionRuntime(sessionId, runtime);
      const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: failingResolveHost });
      const result = await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId }));
      expect(result.isError).toBe(true);
      // Matches the MISS path's own exact wording (_web-fetch-net.ts's network-error message) --
      // the two paths must never disagree about how "resolution failed" reads to the model.
      expect(result.output).toBe("WebFetch could not resolve any address for dns-fail-deny.test.");
      expect(result.output).not.toContain("it is a private/loopback address");
    });

    test("under 'ask', a resolution failure ALSO says 'could not resolve', not the late-case or the direct-private wording", async () => {
      const sessionId = "s-cache-hit-dns-fail-ask";
      const url = "https://dns-fail-ask.test/html";
      await populateCache(sessionId, url);
      const runtime = fakeRuntime(recordingProvider([{ kind: "text", text: "should not run" }]), { fetch: { privateAddressPolicy: "ask" } });
      registerWebSessionRuntime(sessionId, runtime);
      const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: failingResolveHost });
      const result = await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId }));
      expect(result.isError).toBe(true);
      expect(result.output).toBe("WebFetch could not resolve any address for dns-fail-ask.test.");
      expect(result.output).not.toContain("must explicitly approve");
      expect(result.output).not.toContain("only discoverable at fetch time");
    });

    test("under 'allow', a resolution failure still serves the cached content (unchanged: an explicit allow needs no resolution)", async () => {
      const sessionId = "s-cache-hit-dns-fail-allow";
      const url = "https://dns-fail-allow.test/html";
      await populateCache(sessionId, url);
      const runtime = fakeRuntime(recordingProvider([{ kind: "text", text: "digested again" }]), { fetch: { privateAddressPolicy: "allow" } });
      registerWebSessionRuntime(sessionId, runtime);
      const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: failingResolveHost });
      const result = await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId }));
      expect(result).toEqual({ output: "digested again" });
    });

    test("a GENUINELY private resolved address (not a lookup failure) keeps today's wording, unchanged", async () => {
      const sessionId = "s-cache-hit-genuinely-private";
      const url = "https://genuinely-private.test/html";
      await populateCache(sessionId, url);
      const runtime = fakeRuntime(recordingProvider([{ kind: "text", text: "should not run" }]), { fetch: { privateAddressPolicy: "deny" } });
      registerWebSessionRuntime(sessionId, runtime);
      const executor = createWebFetchExecutor({ net: { fetchImpl: loopbackFetchImpl() }, resolveHost: async () => ["127.0.0.1"] });
      const result = await runFetch(executor, { url, prompt: "p" }, makeCtx({ sessionId }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("it is a private/loopback address");
      expect(result.output).not.toContain("could not resolve");
    });
  });

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
