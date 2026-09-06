// WS-13b §2 (P6.5 lane X2): WHAT SHAPE MUST `defaultEndpoints.api` BE?
//
// This file exists because the answer was not written down anywhere, and the catalog's two layers
// disagreed about it for the whole of P6 without anything failing. The upstream layer recorded
// upstream's `baseUrl` verbatim -- the full chat path -- while all five non-empty hand-authored
// overlay rows recorded the API ROOT. Every upstream row was shadowed by an overlay row, so the
// contradiction never reached a wire, and widening the catalog (which removes the shadows) is
// exactly what would have shipped it.
//
// The mechanism, in two links that live in different packages and are individually reasonable:
//
//   1. `session-provider.ts`'s `connectionFrom` copies `provider.defaultEndpoints.api` into
//      `connection.baseUrl` as soon as MORE THAN ONE provider shares an adapter id. Widening puts
//      a hundred-odd providers on `winter.openai-chat-completions`, so this fires for all of them.
//   2. Every adapter family then appends its OWN protocol path to that base
//      (`adapters/openai/chat-completions.ts`: `${endpoint.baseUrl}/chat/completions`).
//
// So the catalog must carry the root, and this test is the executable statement of it: it drives the
// REAL catalog-resolved adapter against a loopback fake and reads the path off the fake's own
// request log. Ground truth is the request the server received, not what the adapter believed.
//
// A catalog-lane file in the runtime directory, deliberately: the fact under test is a property of
// the CATALOG, but it is only observable where the catalog meets the adapter, and no package that
// can see both is closer than this one. `provider-catalog` cannot import the runtime.
import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import { createMemoryCredentialStore, winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider } from "./session-provider.ts";
import { chatCatalog, chatModel, chatProvider, startRawChatFake } from "./raw-chat-fake.test-support.ts";

describe("WS-13b §2: `defaultEndpoints.api` is the API ROOT, because the adapter appends the protocol path", () => {
  test("a ROOT reaches /v1/chat/completions -- and the full path upstream states would DOUBLE it", async () => {
    const fake = await startRawChatFake();
    try {
      // TWO providers on one adapter id, which is what makes `connectionFrom` copy `api` into
      // `connection.baseUrl` at all. One carries the shape the catalog must ship; the other carries
      // the shape upstream states, so the assertion below is a contrast rather than a single value
      // that could be right by accident.
      const catalog = chatCatalog(
        [chatProvider("rootshape", `${fake.url}/v1`), chatProvider("fullpath", `${fake.url}/v1/chat/completions`)],
        [chatModel({ key: "rootshape/m1", providerId: "rootshape", upstreamId: "m1" }), chatModel({ key: "fullpath/m1", providerId: "fullpath", upstreamId: "m1" })],
      );
      for (const model of ["rootshape/m1", "fullpath/m1"]) {
        const wiring = buildSessionProvider({ config: { model } as never, env: {}, catalog, credentials: createMemoryCredentialStore() });
        await wiring.provider.generate({ messages: [{ role: "user", content: "hi" }] } as never);
      }
      expect(fake.requests.map((r) => r.path)).toEqual([
        // The contract: a root row lands on the vendor's real chat path.
        "/v1/chat/completions",
        // The defect this rule prevents, shown rather than described. Nothing rejects this request
        // in the catalog, in selection or in the adapter -- it is a 404 from the vendor at runtime,
        // per provider, discoverable only by using each one.
        "/v1/chat/completions/chat/completions",
      ]);
    } finally {
      await fake.close();
    }
  });

  test("R6b-5: `winter.anthropic-messages` is multi-provider IN FACT -- each sibling reaches its OWN endpoint", async () => {
    // WS-13b §2 says "the Anthropic adapter becomes multi-provider" and names no owner, so this is
    // the measurement rather than the assumption. There is no `providerId === "anthropic"` guard in
    // `adapters/anthropic/messages.ts`; what makes the siblings work is the same `connectionFrom`
    // copy as above, and the adapter appending `/v1/messages` to whatever base it is handed.
    //
    // `zai-anthropic`'s numbers are the real ones: upstream states
    // `https://api.z.ai/api/anthropic/v1/messages`, the mapper records the root
    // `https://api.z.ai/api/anthropic`, and the adapter must put the full URL back together.
    const paths: string[] = [];
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname);
        // The SUBJECT is the URL, so the body may be anything: a 400 is recorded just as well as a
        // stream, and refusing keeps the fake to four lines.
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "probe" } }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const anthropicRow = (id: string, api: string) => ({ ...chatProvider(id, api), protocols: ["anthropic-messages"], adapterId: "winter.anthropic-messages", family: "anthropic" }) as never;
      const catalog = chatCatalog(
        [anthropicRow("anthropic", `${url}/one`), anthropicRow("zai-anthropic", `${url}/api/anthropic`)],
        [chatModel({ key: "anthropic/m1", providerId: "anthropic", upstreamId: "m1" }), chatModel({ key: "zai-anthropic/m2", providerId: "zai-anthropic", upstreamId: "m2" })],
      );
      for (const model of ["anthropic/m1", "zai-anthropic/m2"]) {
        const wiring = buildSessionProvider({ config: { model } as never, env: {}, catalog, credentials: createMemoryCredentialStore() });
        await wiring.provider.generate({ messages: [{ role: "user", content: "hi" }] } as never).catch(() => {});
      }
      expect(paths).toEqual(["/one/v1/messages", "/api/anthropic/v1/messages"]);
    } finally {
      await server.stop(true);
    }
  });

  test("...and the COPY costs `anthropic` no header: every protocol header and Winter's own user-agent still arrive", async () => {
    // The residual `anthropic` inherited by becoming multi-provider in P6.5: `connectionFrom` copies
    // its catalog endpoint into `connection.baseUrl`, which `resolveEndpoint` evaluates as a USER
    // endpoint (`generated: false`) -- and R6-L drops privileged headers on those. Measured on the
    // wire rather than reasoned about, because "no privileged header is dropped" read off the source
    // would be a claim about the source, and T1's `user-agent` is a header nobody swept for this.
    const seen: Array<Record<string, string>> = [];
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const h: Record<string, string> = {};
        req.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
        seen.push(h);
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "probe" } }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    try {
      const anthropicRow = (id: string, api: string) => ({ ...chatProvider(id, api), protocols: ["anthropic-messages"], adapterId: "winter.anthropic-messages", family: "anthropic" }) as never;
      const catalog = chatCatalog(
        // TWO rows, so the copy actually fires -- one row would leave the adapter on its compiled default.
        [anthropicRow("anthropic", `http://127.0.0.1:${server.port}`), anthropicRow("zai-anthropic", `http://127.0.0.1:${server.port}/api/anthropic`)],
        [chatModel({ key: "anthropic/m1", providerId: "anthropic", upstreamId: "m1" })],
      );
      const wiring = buildSessionProvider({ config: { model: "anthropic/m1" } as never, env: {}, catalog, credentials: createMemoryCredentialStore() });
      await wiring.provider.generate({ messages: [{ role: "user", content: "hi" }] } as never).catch(() => {});
      const headers = seen[0] ?? {};
      // The PROTOCOL headers (R6-L's other half) are unaffected by the endpoint's provenance...
      expect(Object.keys(headers)).toEqual(expect.arrayContaining(["anthropic-version", "content-type", "accept"]));
      // ...and so is Winter's own identity, which T1 added and nothing swept for this case.
      expect(headers["user-agent"]).toBe(winterUserAgent());
      expect(headers["user-agent"]).not.toMatch(/bun/i);
    } finally {
      await server.stop(true);
    }
  });

  test("EVERY shipped catalog row on a path-appending adapter carries a root, not a protocol path", async () => {
    // The structural half. The test above proves what the adapter does; this one proves the
    // committed catalog obeys it -- including the overlay, which the extractor's own rule cannot
    // reach. A hand-authored overlay row is exactly where this class comes back.
    const { loadCatalog } = await import("@yanlinglabs/winter-provider-catalog");
    const catalog = loadCatalog();
    const appending = new Set(["winter.openai-chat-completions", "winter.openai-responses", "winter.local-openai", "winter.codex-oauth", "winter.anthropic-messages", "winter.azure-openai"]);
    const offenders = catalog.providers
      .filter((p) => appending.has(p.adapterId))
      .map((p) => [p.id, p.defaultEndpoints["api"] ?? ""] as const)
      .filter(([, api]) => /\/chat\/completions$|\/responses$|\/v1\/messages$/.test(api))
      .map(([id, api]) => `${id} -> ${api}`);
    expect(offenders).toEqual([]);
  });
});
