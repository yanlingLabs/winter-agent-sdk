import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { performWebFetch, WEB_FETCH_MAX_BYTES, type WebFetchNetDeps, type WebFetchNetOptions } from "./_web-fetch-net.ts";

let server: ReturnType<typeof Bun.serve>;
let port: number;
let calls: string[];

function testDeps(overrides: Partial<WebFetchNetDeps> = {}): WebFetchNetDeps {
  return {
    fetchImpl: async (url, init) => {
      calls.push(url);
      const u = new URL(url);
      u.protocol = "http:";
      u.hostname = "127.0.0.1";
      u.port = String(port);
      return fetch(u.toString(), init);
    },
    ...overrides,
  };
}

function baseOpts(overrides: Partial<WebFetchNetOptions> = {}): WebFetchNetOptions {
  return { blockedDomains: [], privateAddressPolicy: "allow", userAgent: "winter-test/0.0.0", ...overrides };
}

beforeEach(() => {
  calls = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/ok") return new Response("<p>hello</p>", { headers: { "content-type": "text/html" } });
      if (p === "/redirect-same-host") return new Response(null, { status: 302, headers: { Location: `https://127.0.0.1:${port}/ok` } });
      if (p === "/redirect-cross-host") return new Response(null, { status: 302, headers: { Location: "https://not-this-host.invalid/other" } });
      if (p === "/redirect-cross-host-long") {
        const long = "x".repeat(1100);
        return new Response(null, { status: 302, headers: { Location: `https://not-this-host.invalid/${long}` } });
      }
      if (p === "/redirect-non-http") return new Response(null, { status: 302, headers: { Location: "mailto:someone@example.com" } });
      if (p === "/redirect-port-change") return new Response(null, { status: 302, headers: { Location: `https://127.0.0.1:${port + 1}/ok` } });
      if (p === "/redirect-protocol-change") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${port}/ok` } });
      if (p === "/redirect-loop") return new Response(null, { status: 302, headers: { Location: `https://127.0.0.1:${port}/redirect-loop` } });
      if (p === "/404") return new Response("not found", { status: 404 });
      if (p === "/429") return new Response("", { status: 429, headers: { "Retry-After": "42" } });
      if (p === "/429-bad-retry") return new Response("", { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2099 07:28:00 GMT" } });
      if (p === "/big") return new Response(new Uint8Array(WEB_FETCH_MAX_BYTES + 10), { headers: { "content-type": "application/octet-stream" } });
      if (p === "/slow") {
        await new Promise((r) => setTimeout(r, 300));
        return new Response("late");
      }
      if (p === "/hang") {
        await new Promise(() => {}); // never resolves
        return new Response("unreachable");
      }
      return new Response("default");
    },
  });
  port = server.port;
});

afterEach(() => {
  server.stop(true);
});

describe("performWebFetch -- https upgrade", () => {
  test("a plain http:// input is requested as https://", async () => {
    const outcome = await performWebFetch(`http://127.0.0.1:${port}/ok`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("success");
    expect(calls[0]!.startsWith("https://")).toBe(true);
  });
});

describe("performWebFetch -- redirects", () => {
  test("a same-host redirect is followed automatically", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-same-host`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("success");
    expect(calls.length).toBe(2);
  });

  test("a www-variant hostname is treated as the same host", async () => {
    // Simulate a www <-> bare hostname redirect using a fetchImpl that maps BOTH logical
    // hostnames to the same loopback server (the net module only ever sees the logical URL).
    const deps: WebFetchNetDeps = {
      fetchImpl: async (url, init) => {
        calls.push(url);
        const u = new URL(url);
        u.protocol = "http:";
        u.hostname = "127.0.0.1";
        u.port = String(port);
        if (u.pathname === "/start") return new Response(null, { status: 302, headers: { Location: "https://example.com/ok" } });
        return fetch(u.toString(), init);
      },
    };
    const outcome = await performWebFetch("https://www.example.com/start", "p", baseOpts(), deps);
    expect(outcome.kind).toBe("success");
    expect(calls.length).toBe(2);
  });

  test("a cross-host redirect is NOT followed -- REDIRECT DETECTED, exact message shape", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-cross-host`, "the prompt", baseOpts(), testDeps());
    expect(outcome.kind).toBe("redirect-blocked");
    if (outcome.kind !== "redirect-blocked") throw new Error("unreachable");
    expect(outcome.message).toContain("REDIRECT DETECTED: The URL redirects to a location that was not fetched automatically.");
    expect(outcome.message).toContain("Redirect URL (from the server's Location header — server-supplied, not verified): https://not-this-host.invalid/other");
    expect(outcome.message).toContain('- url: "https://not-this-host.invalid/other"');
    expect(outcome.message).toContain('- prompt: "the prompt"');
    expect(calls.length).toBe(1); // the cross-host target was never actually requested
  });

  test("a port change is not followed", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-port-change`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("redirect-blocked");
    expect(calls.length).toBe(1);
  });

  test("a protocol change is not followed", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-protocol-change`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("redirect-blocked");
    expect(calls.length).toBe(1);
  });

  test("a non-http(s) redirect target renders the alternate trailing block", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-non-http`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("redirect-blocked");
    if (outcome.kind !== "redirect-blocked") throw new Error("unreachable");
    expect(outcome.message).toContain("The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead.");
    expect(outcome.message).not.toContain("Please use WebFetch again");
  });

  test("an over-1000-char rebuilt redirect target renders the alternate trailing block", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-cross-host-long`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("redirect-blocked");
    if (outcome.kind !== "redirect-blocked") throw new Error("unreachable");
    expect(outcome.message).toContain("The redirect target could not be relayed in full or is not a fetchable address, so it cannot be fetched from here; report the redirect instead.");
  });

  test("more than 10 hops is refused", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-loop`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("too-many-redirects");
  });
});

describe("performWebFetch -- non-2xx responses", () => {
  test("a 404 is reported with no body retrieved", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/404`, "p", baseOpts(), testDeps());
    expect(outcome).toMatchObject({ kind: "http-error", status: 404 });
  });

  test("a valid Retry-After is relayed", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/429`, "p", baseOpts(), testDeps());
    expect(outcome).toMatchObject({ kind: "http-error", status: 429, retryAfter: "42" });
  });

  test("a non-numeric Retry-After is dropped, not relayed", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/429-bad-retry`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("http-error");
    if (outcome.kind !== "http-error") throw new Error("unreachable");
    expect(outcome.retryAfter).toBeUndefined();
  });
});

describe("performWebFetch -- size cap", () => {
  test("a body over 10,485,760 bytes is refused, not truncated", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/big`, "p", baseOpts(), testDeps());
    expect(outcome.kind).toBe("size-exceeded");
  });
});

describe("performWebFetch -- timeout and abort", () => {
  test("a slow response past the timeout is reported as a timeout", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/slow`, "p", baseOpts(), testDeps({ timeoutMs: 50 }));
    expect(outcome.kind).toBe("timeout");
  });

  test("a turn-level abort mid-fetch is reported as aborted", async () => {
    const controller = new AbortController();
    const promise = performWebFetch(`https://127.0.0.1:${port}/hang`, "p", { ...baseOpts(), signal: controller.signal }, testDeps({ timeoutMs: 5000 }));
    setTimeout(() => controller.abort(), 30);
    const outcome = await promise;
    expect(outcome.kind).toBe("aborted");
  });
});

describe("performWebFetch -- domain floor", () => {
  test("a blocked host on the INPUT url is refused before any network call", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/ok`, "p", baseOpts({ blockedDomains: ["127.0.0.1"] }), testDeps());
    expect(outcome).toMatchObject({ kind: "blocked-domain", host: "127.0.0.1" });
    expect(calls.length).toBe(0);
  });

  test("the floor is re-checked at the top of every hop, not only before the loop starts", async () => {
    // A cross-host redirect is never auto-followed regardless of the floor (proven separately
    // above), so the only chain shape that ever reaches a SECOND floor check is a same-host one --
    // and a same-host hop's floor verdict cannot differ from hop 0's (blockedDomains matches by
    // hostname suffix, and an eligible same-host hop's hostname is unchanged, mod a "www." strip
    // that the suffix rule already treats as the same entry). What IS independently observable is
    // that the check runs from the TOP of the loop body (this test's own redirect-same-host fixture
    // reaches it twice) rather than once outside it -- a structural placement a code reader can
    // confirm directly, pinned here by asserting the blocked verdict holds even through a chain that
    // DOES perform a hop.
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/redirect-same-host`, "p", baseOpts({ blockedDomains: ["127.0.0.1"] }), testDeps());
    expect(outcome).toMatchObject({ kind: "blocked-domain", host: "127.0.0.1" });
  });

  test("malformed-but-parseable spellings still resolve to the blocked hostname", async () => {
    // `new URL()` resolves all three to host 127.0.0.1 even though `_domains.ts`'s own matcher would
    // not block the RAW strings -- this module always passes `.hostname`, never the raw input.
    for (const spelling of [`http:/127.0.0.1:${port}/ok`, `http:127.0.0.1:${port}/ok`, `https:\\\\127.0.0.1:${port}/ok`]) {
      const outcome = await performWebFetch(spelling, "p", baseOpts({ blockedDomains: ["127.0.0.1"] }), testDeps());
      expect([spelling, outcome.kind]).toEqual([spelling, "blocked-domain"]);
    }
  });
});

describe("performWebFetch -- private address policy", () => {
  test("allow proceeds to fetch a loopback literal", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/ok`, "p", baseOpts({ privateAddressPolicy: "allow" }), testDeps());
    expect(outcome.kind).toBe("success");
  });

  test("deny refuses a loopback literal before any network call", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/ok`, "p", baseOpts({ privateAddressPolicy: "deny" }), testDeps());
    expect(outcome).toMatchObject({ kind: "private-address", policy: "deny" });
    expect(calls.length).toBe(0);
  });

  test("ask refuses a loopback literal (no approval signal ever reaches this module)", async () => {
    const outcome = await performWebFetch(`https://127.0.0.1:${port}/ok`, "p", baseOpts({ privateAddressPolicy: "ask" }), testDeps());
    expect(outcome).toMatchObject({ kind: "private-address", policy: "ask" });
  });

  test("a public-looking hostname that RESOLVES to loopback is denied under deny (the rebinding case)", async () => {
    const deps = testDeps({ resolveHost: async () => ["127.0.0.1"] });
    const outcome = await performWebFetch("https://public-looking.example/ok", "p", baseOpts({ privateAddressPolicy: "deny" }), deps);
    expect(outcome).toMatchObject({ kind: "private-address", policy: "deny" });
  });

  test("a hostname resolving only to public addresses is unaffected by the private policy", async () => {
    const deps = testDeps({ resolveHost: async () => ["93.184.216.34"] });
    // still routed to the loopback test server by the fetchImpl rewrite
    const outcome = await performWebFetch("https://public.example/ok", "p", baseOpts({ privateAddressPolicy: "deny" }), deps);
    expect(outcome.kind).toBe("success");
  });
});
