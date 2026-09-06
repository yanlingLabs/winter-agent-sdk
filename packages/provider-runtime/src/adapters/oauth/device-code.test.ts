// RFC 8628, proved against a loopback device/token endpoint.
//
// The identity assertion is the one that matters for D21: a flow that carried Winter's name on the
// device request and dropped it on the polls would be honest exactly once, so the fake records the
// field on EVERY request and the test asserts on all of them.
import { describe, expect, test } from "bun:test";
import { runDeviceCodeFlow } from "./device-code.ts";
import { winterUserAgent } from "../../identity.ts";

describe("runDeviceCodeFlow (RFC 8628)", () => {
  test("requests a device code, reports the user code, polls until the token arrives, and sends the identity field on EVERY request", async () => {
    let polls = 0;
    const seenIdentity: string[] = [];
    const seenUserAgent: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const form = new URLSearchParams(await req.text());
        seenIdentity.push(form.get("referrer") ?? "MISSING");
        seenUserAgent.push(req.headers.get("user-agent") ?? "MISSING");
        if (url.pathname === "/device") return Response.json({ device_code: "dev-1", user_code: "ABCD-EFGH", verification_uri: "https://example.invalid/activate", interval: 0 });
        polls += 1;
        if (polls < 2) return Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({ access_token: "tok", refresh_token: "ref", expires_in: 10 });
      },
    });
    try {
      const statuses: string[] = [];
      const tokens = await runDeviceCodeFlow({
        clientId: "public-client",
        deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        scope: "openid offline_access",
        identity: { field: "referrer", value: "winter-agent-sdk" },
        pollIntervalMs: 5,
        onAuthStatus: (s) => {
          for (const line of s.output ?? []) statuses.push(line);
        },
      });
      expect(tokens.accessToken).toBe("tok");
      expect(tokens.refreshToken).toBe("ref");
      expect(statuses.join("\n")).toContain("ABCD-EFGH");
      expect(statuses.join("\n")).toContain("https://example.invalid/activate");
      expect(seenIdentity.every((v) => v === "winter-agent-sdk")).toBe(true);
      expect(seenIdentity).toHaveLength(3);
      // BOTH identity channels, on the device request and on every poll: the form field the vendor's
      // flow reads, and the user-agent its logs and edge see.
      expect(seenUserAgent.every((v) => v === winterUserAgent())).toBe(true);
      expect(seenUserAgent).toHaveLength(3);
      expect(polls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("`verification_uri_complete` is reported when the vendor sends one — it is the link a user can actually click", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        await req.text();
        if (url.pathname === "/device") {
          return Response.json({ device_code: "d", user_code: "WXYZ", verification_uri: "https://example.invalid/a", verification_uri_complete: "https://example.invalid/a?code=WXYZ", interval: 0 });
        }
        return Response.json({ access_token: "tok", expires_in: 1 });
      },
    });
    try {
      const statuses: string[] = [];
      await runDeviceCodeFlow({
        clientId: "c",
        deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        scope: "s",
        identity: { field: "referrer", value: "winter-agent-sdk" },
        pollIntervalMs: 1,
        onAuthStatus: (s) => {
          for (const line of s.output ?? []) statuses.push(line);
        },
      });
      expect(statuses.join("\n")).toContain("https://example.invalid/a?code=WXYZ");
    } finally {
      server.stop(true);
    }
  });

  test("`slow_down` BACKS OFF rather than being treated as a failure — RFC 8628 §3.5's own interval rule", async () => {
    let polls = 0;
    const pollAt: number[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        await req.text();
        if (url.pathname === "/device") return Response.json({ device_code: "d", user_code: "U", verification_uri: "https://example.invalid/a", interval: 0 });
        polls += 1;
        pollAt.push(Date.now());
        if (polls === 1) return Response.json({ error: "slow_down" }, { status: 400 });
        return Response.json({ access_token: "tok", expires_in: 1 });
      },
    });
    try {
      const tokens = await runDeviceCodeFlow({
        clientId: "c",
        deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        scope: "s",
        identity: { field: "referrer", value: "winter-agent-sdk" },
        pollIntervalMs: 1,
        slowDownStepMs: 40,
        timeoutMs: 5_000,
      });
      expect(tokens.accessToken).toBe("tok");
      expect(polls).toBe(2);
      // The second poll waited the WIDENED interval, not the original one.
      expect(pollAt[1]! - pollAt[0]!).toBeGreaterThanOrEqual(35);
    } finally {
      server.stop(true);
    }
  });

  test("a terminal error from the token endpoint stops the flow instead of polling forever, and never echoes the body", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        await req.text();
        if (url.pathname === "/device") return Response.json({ device_code: "d", user_code: "U", verification_uri: "https://example.invalid/a", interval: 0 });
        return Response.json({ error: "access_denied", error_description: "leaky-detail-should-not-appear" }, { status: 400 });
      },
    });
    try {
      const err = await runDeviceCodeFlow({
        clientId: "c",
        deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        scope: "s",
        identity: { field: "referrer", value: "winter-agent-sdk" },
        pollIntervalMs: 1,
        timeoutMs: 5_000,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toContain("access_denied");
      expect(String(err)).not.toContain("leaky-detail-should-not-appear");
    } finally {
      server.stop(true);
    }
  });

  test("an `access_denied` at the DEVICE step surfaces the code — as `providerCode` and in the message", async () => {
    // Fix-wave carry (Lane O review Important 3). RFC 8628 lets the device step fail the ways the
    // poll can, and this throw used to report only the HTTP status — so `xai-oauth`'s reversion
    // classifier, which reads the code back, could not see a refusal at the door: an unregistered
    // client the vendor rejects looked like a plain 4xx and never reached the reversion arm.
    const MARKER = "MARKER-vendor-prose-must-not-survive";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // The vendor's real shape: the machine-readable code beside a human sentence that routinely
      // quotes the request.
      fetch: async () => Response.json({ error: "access_denied", error_description: `${MARKER}: this client is not permitted` }, { status: 400 }),
    });
    try {
      let thrown: unknown;
      try {
        await runDeviceCodeFlow({
          clientId: "public-client",
          deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
          tokenUrl: `http://127.0.0.1:${server.port}/token`,
          scope: "openid",
          identity: { field: "referrer", value: "winter-agent-sdk" },
          pollIntervalMs: 5,
        });
      } catch (err) {
        thrown = err;
      }
      // THE FIELD, which is the point: a consumer that had to regex a sentence to classify a failure
      // is one reworded sentence away from misclassifying it.
      expect((thrown as { providerCode?: string }).providerCode).toBe("access_denied");
      expect((thrown as Error).message).toContain("access_denied");
      // ...and the vendor's prose does NOT survive, on either channel. `error_description` quotes the
      // request, and a login failure is the moment a message is most likely to be pasted somewhere.
      expect((thrown as Error).message).not.toContain(MARKER);
    } finally {
      server.stop(true);
    }
  });

  test("a NON-CODE `error` value at the device step is refused as prose and does not become a providerCode", async () => {
    // The shape guard, not a nicety: the field is admitted only when it matches `[a-z_]+`, so a
    // vendor that puts a sentence (or an object rendered as one) in `error` cannot smuggle it into
    // the message or the field. Without this the carry above would be a new echo channel.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => Response.json({ error: "Your request 12345 was denied for user a@b.c" }, { status: 400 }),
    });
    try {
      let thrown: unknown;
      try {
        await runDeviceCodeFlow({
          clientId: "public-client",
          deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
          tokenUrl: `http://127.0.0.1:${server.port}/token`,
          scope: "openid",
          identity: { field: "referrer", value: "winter-agent-sdk" },
          pollIntervalMs: 5,
        });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { providerCode?: string }).providerCode).toBeUndefined();
      expect((thrown as Error).message).toBe("the device authorization request failed: HTTP 400");
      expect((thrown as Error).message).not.toContain("a@b.c");
    } finally {
      server.stop(true);
    }
  });

  test("the flow gives up at `timeoutMs` rather than polling a vendor forever", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        await req.text();
        if (url.pathname === "/device") return Response.json({ device_code: "d", user_code: "U", verification_uri: "https://example.invalid/a", interval: 0 });
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      },
    });
    try {
      const err = await runDeviceCodeFlow({
        clientId: "c",
        deviceCodeUrl: `http://127.0.0.1:${server.port}/device`,
        tokenUrl: `http://127.0.0.1:${server.port}/token`,
        scope: "s",
        identity: { field: "referrer", value: "winter-agent-sdk" },
        pollIntervalMs: 1,
        timeoutMs: 60,
      }).catch((e: unknown) => e);
      expect(String(err)).toMatch(/timed out/i);
    } finally {
      server.stop(true);
    }
  });
});
