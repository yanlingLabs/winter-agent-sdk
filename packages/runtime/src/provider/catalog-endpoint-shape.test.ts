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
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
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
