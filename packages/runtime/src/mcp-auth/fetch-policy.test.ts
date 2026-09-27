// WS-25 §6: the auth-HTTP policy -- what an auth request may reach, and what it never follows.
import { afterEach, describe, expect, test } from "bun:test";
import { createMcpAuthFetch, evaluateMcpAuthUrl } from "./fetch-policy.ts";
import { McpOAuthError } from "./errors.ts";

const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function serve(fetch: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("the URL rules", () => {
  test("https to a public name is allowed; http only to a LITERAL loopback address", () => {
    expect(evaluateMcpAuthUrl("https://as.example.com/token")).toMatchObject({ ok: true, loopback: false });
    expect(evaluateMcpAuthUrl("http://127.0.0.1:9/token", { allowLoopback: true })).toMatchObject({ ok: true, loopback: true });
    expect(evaluateMcpAuthUrl("http://[::1]:9/token", { allowLoopback: true })).toMatchObject({ ok: true, loopback: true });
    expect(evaluateMcpAuthUrl("http://localhost:9/token", { allowLoopback: true })).toMatchObject({ ok: true, loopback: true });
    // ...and loopback at ALL (http or https) only for a server that is itself on loopback (M4).
    expect(evaluateMcpAuthUrl("http://127.0.0.1:9/token").ok).toBe(false);
    expect(evaluateMcpAuthUrl("https://127.0.0.1:9/token").ok).toBe(false);
    expect(evaluateMcpAuthUrl("http://as.example.com/token").ok).toBe(false);
  });

  test("a literal private, link-local, unique-local or CGNAT address is refused whatever the scheme (SSRF)", () => {
    for (const url of ["https://10.0.0.5/x", "https://192.168.1.1/x", "https://172.16.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[fe80::1]/x", "https://[fd00::1]/x", "https://100.64.0.1/x", "https://0.0.0.0/x"]) {
      expect([url, evaluateMcpAuthUrl(url).ok]).toEqual([url, false]);
    }
  });

  test("userinfo and non-http schemes are refused", () => {
    expect(evaluateMcpAuthUrl("https://u:p@as.example.com/").ok).toBe(false);
    expect(evaluateMcpAuthUrl("file:///etc/passwd").ok).toBe(false);
  });
});

describe("the fetch", () => {
  test("refuses a policy-violating URL before a byte leaves (typed policy_refused)", async () => {
    const authFetch = createMcpAuthFetch();
    const err = await authFetch("https://169.254.169.254/latest").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpOAuthError);
    expect((err as McpOAuthError).code).toBe("policy_refused");
  });

  test("follows a SAME-origin redirect, refuses a CROSS-origin one outright", async () => {
    const other = serve(() => new Response("elsewhere"));
    const origin = serve((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/same") return new Response(null, { status: 302, headers: { location: "/final" } });
      if (path === "/cross") return new Response(null, { status: 302, headers: { location: `${other}/final` } });
      return new Response("final");
    });
    const authFetch = createMcpAuthFetch({ allowLoopback: true });
    expect(await (await authFetch(`${origin}/same`)).text()).toBe("final");
    const err = await authFetch(`${origin}/cross`).catch((e: unknown) => e);
    expect((err as McpOAuthError).code).toBe("policy_refused");
    expect((err as Error).message).toContain("cross-origin");
  });

  test("caps the body while reading", async () => {
    const origin = serve(() => new Response("x".repeat(4096)));
    const authFetch = createMcpAuthFetch({ maxBodyBytes: 1024, allowLoopback: true });
    const response = await authFetch(`${origin}/big`);
    await expect(response.text()).rejects.toThrow("1024-byte limit");
  });

  test("the WHOLE exchange is bounded: a body that drips past the deadline is aborted, not waited on (M9)", async () => {
    const origin = serve(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              await Bun.sleep(1000);
              controller.close();
            },
          }),
        ),
    );
    const response = await createMcpAuthFetch({ timeoutMs: 150, allowLoopback: true })(`${origin}/slow`);
    const started = Date.now();
    await expect(response.text()).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(800);
  });

  test("a dead endpoint is `network` (retry later), not a policy refusal", async () => {
    const origin = serve(() => new Response("gone"));
    servers.splice(0).forEach((s) => s.stop(true));
    const err = await createMcpAuthFetch({ allowLoopback: true })(`${origin}/token`).catch((e: unknown) => e);
    expect((err as McpOAuthError).code).toBe("network");
  });

  test("an INJECTED network gets the same URL rules and every redirect refused", async () => {
    const seen: string[] = [];
    const injected = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(url)} redirect=${init?.redirect}`);
      return new Response("ok");
    }) as typeof fetch;
    const authFetch = createMcpAuthFetch({ fetch: injected });
    expect(await (await authFetch("https://as.example.com/token")).text()).toBe("ok");
    expect(seen).toEqual(["https://as.example.com/token redirect=error"]);
    await expect(authFetch("http://as.example.com/token")).rejects.toMatchObject({ code: "policy_refused" });
  });
});
