import { afterAll, describe, expect, test } from "bun:test";
import { createEndpointPolicy, type EndpointPolicy } from "./endpoint-policy.ts";
import { ProviderBodyLimitError, boundedFetch } from "./http.ts";

const TEST_KEY = "test-key-http-abc";

interface RequestLogEntry {
  method: string;
  path: string;
  /** REDACTED: header NAMES only for anything credential-shaped, so the log is evidence without being a leak. */
  headerNames: string[];
  hasAuthorization: boolean;
  hasApiKey: boolean;
}

interface Fake {
  server: { stop(closeActiveConnections?: boolean): void };
  origin: string;
  log: RequestLogEntry[];
  close(): void;
}

/**
 * A loopback fake on 127.0.0.1:0. Every request it receives is logged (redacted) — that log is the
 * GROUND TRUTH for what a request actually carried, never the caller's intent (Global Constraints).
 */
function startFake(handler: (req: Request, url: URL, fake: () => Fake) => Response | Promise<Response>): Fake {
  const log: RequestLogEntry[] = [];
  let self: Fake;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      log.push({
        method: req.method,
        path: url.pathname,
        headerNames: [...req.headers.keys()].sort(),
        hasAuthorization: req.headers.has("authorization"),
        hasApiKey: req.headers.has("x-api-key"),
      });
      return await handler(req, url, () => self);
    },
  });
  self = {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    log,
    close() {
      server.stop(true);
    },
  };
  return self;
}

const fakes: Fake[] = [];
function fake(handler: Parameters<typeof startFake>[0]): Fake {
  const f = startFake(handler);
  fakes.push(f);
  return f;
}
afterAll(() => {
  for (const f of fakes) {
    try {
      f.close();
    } catch {
      /* a server already stopped by its own test */
    }
  }
});

function policyFor(origin: string): EndpointPolicy {
  const created = createEndpointPolicy(`${origin}/v1`, { generated: false, local: true });
  if (!created.ok) throw new Error(created.reason);
  return created.policy;
}

describe("boundedFetch — the happy path", () => {
  test("performs the request and returns the response", async () => {
    const f = fake(() => new Response("hello", { status: 200 }));
    const res = await boundedFetch(`${f.origin}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" },
      body: "{}",
      timeoutMs: 5000,
      maxBodyBytes: 1024,
      policy: policyFor(f.origin),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
    expect(f.log).toHaveLength(1);
    expect(f.log[0]!.hasAuthorization).toBe(true);
  });

  test("refuses a URL the policy does not admit, WITHOUT issuing a request", async () => {
    const f = fake(() => new Response("should not happen"));
    await expect(
      boundedFetch("https://evil.example.test/v1", {
        timeoutMs: 5000,
        maxBodyBytes: 1024,
        policy: policyFor(f.origin),
      }),
    ).rejects.toMatchObject({ code: "capability" });
    expect(f.log).toHaveLength(0);
  });
});

describe("boundedFetch — redirects (R6-11: manual, revalidated, no credential forwarding)", () => {
  test("follows a SAME-origin redirect and KEEPS credentials", async () => {
    const f = fake((_req, url) =>
      url.pathname === "/v1/start"
        ? new Response(null, { status: 307, headers: { location: "/v1/end" } })
        : new Response("arrived", { status: 200 }),
    );
    const res = await boundedFetch(`${f.origin}/v1/start`, {
      headers: { authorization: `Bearer ${TEST_KEY}`, "x-api-key": TEST_KEY },
      timeoutMs: 5000,
      maxBodyBytes: 1024,
      policy: policyFor(f.origin),
    });
    expect(await res.text()).toBe("arrived");
    expect(f.log.map((e) => e.path)).toEqual(["/v1/start", "/v1/end"]);
    expect(f.log[1]!.hasAuthorization).toBe(true);
    expect(f.log[1]!.hasApiKey).toBe(true);
  });

  test("follows a CROSS-origin redirect but STRIPS every credential header", async () => {
    // The ground truth is the second server's own request log, not the caller's intent: this is the
    // exact manoeuvre by which a compliant client is talked into replaying its bearer token to a
    // host the user never named.
    const second = fake(() => new Response("second", { status: 200 }));
    const first = fake(() => new Response(null, { status: 302, headers: { location: `${second.origin}/v1/next` } }));
    const res = await boundedFetch(`${first.origin}/v1/start`, {
      headers: { authorization: `Bearer ${TEST_KEY}`, "x-api-key": TEST_KEY, cookie: `s=${TEST_KEY}`, "content-type": "application/json" },
      timeoutMs: 5000,
      maxBodyBytes: 1024,
      policy: policyFor(first.origin),
    });
    expect(await res.text()).toBe("second");
    expect(second.log).toHaveLength(1);
    expect(second.log[0]!.hasAuthorization).toBe(false);
    expect(second.log[0]!.hasApiKey).toBe(false);
    expect(second.log[0]!.headerNames).not.toContain("cookie");
    // A non-credential header survives; stripping it would break the request for no benefit.
    expect(second.log[0]!.headerNames).toContain("content-type");
  });

  test("refuses a redirect the policy rejects, and never issues the second request", async () => {
    const f = fake(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    const policy = policyFor(f.origin);
    await expect(
      boundedFetch(`${f.origin}/v1/start`, { timeoutMs: 5000, maxBodyBytes: 1024, policy }),
    ).rejects.toMatchObject({ code: "capability" });
    expect(f.log).toHaveLength(1);
  });

  test("refuses a redirect LOOP rather than following it forever", async () => {
    const f = fake((_req, url) => new Response(null, { status: 302, headers: { location: `/v1/${url.pathname.length}` } }));
    await expect(
      boundedFetch(`${f.origin}/v1/start`, { timeoutMs: 5000, maxBodyBytes: 1024, policy: policyFor(f.origin), maxRedirects: 3 }),
    ).rejects.toMatchObject({ code: "capability" });
    expect(f.log.length).toBe(4); // the original plus exactly maxRedirects hops
  });

  test("a 3xx with NO location header is returned as-is rather than treated as a redirect", async () => {
    const f = fake(() => new Response("weird", { status: 304 }));
    const res = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 5000, maxBodyBytes: 1024, policy: policyFor(f.origin) });
    expect(res.status).toBe(304);
  });
});

describe("boundedFetch — body cap, enforced ON READ", () => {
  test("passes a body under the cap through unchanged", async () => {
    const f = fake(() => new Response("x".repeat(100)));
    const res = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 5000, maxBodyBytes: 200, policy: policyFor(f.origin) });
    expect((await res.text()).length).toBe(100);
  });

  test("errors while READING a body that exceeds the cap, even with no content-length", async () => {
    // Enforcing on Content-Length alone is the trap: a chunked/streamed response has none, which is
    // exactly the shape a provider stream takes. The cap has to live in the read path.
    // FINITE but oversized, and deliberately so: an endless `pull` keeps the FAKE's own event loop
    // pumping into a connection the client already tore down, which does not fail the test — it
    // hangs the whole runner (measured). 32 KiB with no content-length is the same shape a chunked
    // provider stream has, which is all this needs to prove.
    const f = fake(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              for (let i = 0; i < 32; i++) c.enqueue(new TextEncoder().encode("y".repeat(1024)));
              c.close();
            },
          }),
        ),
    );
    const res = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 5000, maxBodyBytes: 4096, policy: policyFor(f.origin) });
    expect(res.headers.get("content-length")).toBeNull();
    await expect(res.text()).rejects.toBeInstanceOf(ProviderBodyLimitError);
  });

  test("the cap counts BYTES, not characters", async () => {
    const f = fake(() => new Response("é".repeat(10))); // 20 bytes, 10 characters
    const under = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 5000, maxBodyBytes: 20, policy: policyFor(f.origin) });
    expect((await under.text()).length).toBe(10);
    const over = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 5000, maxBodyBytes: 15, policy: policyFor(f.origin) });
    await expect(over.text()).rejects.toBeInstanceOf(ProviderBodyLimitError);
  });
});

describe("boundedFetch — timeout and abort", () => {
  test("times out waiting for RESPONSE HEADERS", async () => {
    const f = fake(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return new Response("late");
    });
    const err = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 80, maxBodyBytes: 1024, policy: policyFor(f.origin) }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("timeout");
  });

  test("the header timeout does NOT kill a slow BODY — that is the stall watchdog's job", async () => {
    // A generation legitimately takes far longer than any sane header deadline. Cancelling the
    // timer once headers arrive is what makes `timeoutMs` a connect budget rather than a turn budget.
    const f = fake(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(c) {
              c.enqueue(new TextEncoder().encode("part1"));
              await new Promise((r) => setTimeout(r, 200));
              c.enqueue(new TextEncoder().encode("part2"));
              c.close();
            },
          }),
        ),
    );
    const res = await boundedFetch(`${f.origin}/v1`, { timeoutMs: 100, maxBodyBytes: 1024, policy: policyFor(f.origin) });
    expect(await res.text()).toBe("part1part2");
  });

  test("a caller's abort signal cancels the request", async () => {
    const f = fake(async () => {
      await new Promise((r) => setTimeout(r, 1000));
      return new Response("late");
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const err = await boundedFetch(`${f.origin}/v1`, {
      timeoutMs: 10_000,
      maxBodyBytes: 1024,
      policy: policyFor(f.origin),
      signal: controller.signal,
    }).then(() => undefined, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe("aborted");
  });

  test("a connection refused is a retryable network error with NO status", async () => {
    const f = fake(() => new Response("ok"));
    const origin = f.origin;
    const policy = policyFor(origin);
    f.close();
    const err = await boundedFetch(`${origin}/v1`, { timeoutMs: 2000, maxBodyBytes: 1024, policy }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { code?: string }).code).toBe("network");
    expect((err as { retryable?: boolean }).retryable).toBe(true);
    expect("status" in (err as object)).toBe(false);
  });
});
