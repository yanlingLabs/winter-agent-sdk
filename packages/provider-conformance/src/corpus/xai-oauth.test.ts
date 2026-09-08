// `winter.xai-oauth` on the wire: a real generation, through the registered adapter, against the
// chat fake — and the catalog row read back to prove the row and the request agree.
//
// The unit tests next to the adapter prove the LOGIN is honest. This file proves the two things the
// login cannot: that the subscription bearer actually reaches the request as an `Authorization`
// header and Winter's user-agent rides beside it, and that the row this adapter serves is
// `pricingBasis: "subscription"` — which is what keeps its usage out of R6-H cost.
//
// Everything is loopback and in-memory: the fake binds `127.0.0.1:0` and closes in a `finally`, the
// credential store is in-memory, and the access token is a `test-token-…` literal.

import { describe, expect, test } from "bun:test";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialRef, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import {
  createXaiOauthAdapter,
  XAI_OAUTH,
  XAI_OAUTH_ADAPTER_ID,
  DERIVED_XAI,
  DERIVED_XAI_COMMIT,
  createShippedAdapters,
  createMemoryCredentialStore,
  winterUserAgent,
  WinterProviderResolutionError,
} from "@yanlinglabs/winter-provider-runtime";
import { FAST_RETRY, descriptor, testContext } from "@yanlinglabs/winter-provider-runtime/testing";
import { startOpenAiChatFake } from "../fakes/openai-chat.ts";
import { crossVendorViolationsIn } from "./cross-vendor-headers.ts";
import { chatCorpusScenarios } from "./openai-scenarios.ts";
import { SCENARIO, bodyOf, turnRequests } from "./openai.ts";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
// `createSelectionRegistry`/`resolveSessionProvider` stay relative (review r1 Critical-2):
// `winter-agent-runtime` is `"private": true`, never published -- irrelevant here since `.test.ts`
// files never ship as reachable code.
import { createSelectionRegistry, resolveSessionProvider } from "../../../runtime/src/provider/selection.ts";

const catalog = loadCatalog();
// Narrowed once, loudly: every assertion below is about THIS row, and `ROW?.x` on a missing row
// would make three of them pass vacuously against `undefined`.
const ROW = catalog.providers.find((p) => p.id === "xai-oauth");
if (ROW === undefined) throw new Error("the committed catalog has no `xai-oauth` provider row");
const ROW_API = ROW.defaultEndpoints["api"] ?? "";

/** A live, unexpired subscription token in an in-memory store, under the ref the login would have written. */
const REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "xai-oauth:acct-x" };
function xaiContext(): ReturnType<typeof testContext> {
  const credentials = createMemoryCredentialStore([[REF, { kind: "oauth", accessToken: "test-token-xai-access", refreshToken: "test-token-xai-refresh", accountId: "acct-x", expiresAt: Date.now() + 3_600_000 }]]);
  return { ...testContext({ providerId: "xai-oauth" }), credentials, authRef: REF };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const req = (model: string): TurnRequest => ({ model, messages: [{ role: "user", content: "corpus question" }] });

describe("winter.xai-oauth on the wire (WS-13b §4)", () => {
  test("a generation carries the oauth bearer, Winter's user-agent and the wire model id — and nothing of the vendor's identity", async () => {
    const fake = await startOpenAiChatFake({ scenarios: chatCorpusScenarios() });
    try {
      const adapter = createXaiOauthAdapter({ generatedBaseUrl: fake.url, retry: FAST_RETRY, descriptors: (model) => descriptor({ key: `xai-oauth/${model}`, upstreamId: model }) });
      expect(adapter.id).toBe(XAI_OAUTH_ADAPTER_ID);

      const events = await collect(adapter.streamTurn(req(SCENARIO.happy), xaiContext()));
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(events.map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toBe("hello world");

      const turns = turnRequests(fake);
      expect(turns).toHaveLength(1);
      const turn = turns[0]!;
      // The fake REDACTS an authorization value, so this asserts the scheme reached the wire without
      // ever putting a token in an assertion or a failure message.
      expect(turn.headers["authorization"]).toBe("Bearer ***");
      expect(turn.headers["user-agent"]).toBe(winterUserAgent());
      // The wire model id is the row's own upstream id, not Winter's namespaced key.
      expect(bodyOf(turn)["model"]).toBe(SCENARIO.happy);

      // WS-13 §5, on the generation path as well as the login path.
      for (const banned of DERIVED_XAI.vendorOnlyHeaders) expect(turn.headers[banned]).toBeUndefined();
      expect(turn.headers["user-agent"]).not.toMatch(/grok/i);

      // ...AND THE CROSS-VENDOR SWEEP (fix wave R-FW-1 / review I-1). The denylist above is xAI's
      // OWN six names, which is why it could not see `chatgpt-account-id: <the xAI OIDC sub>` — a
      // header named for a DIFFERENT vendor, stamped by the plain chat adapter this row composes for
      // any oauth material carrying an `accountId`, and passed rather than dropped because this
      // adapter is single-provider and its endpoint is therefore GENERATED. The sweep is keyed on
      // the row's own identity, so it sees every other vendor's namespace at once.
      expect(crossVendorViolationsIn({ providerId: "xai-oauth", adapterId: XAI_OAUTH_ADAPTER_ID }, turns)).toEqual([]);
      // Named explicitly beside the general rule: this is the exact header the review found, and a
      // reader of this file should not have to derive it from the prefix table.
      expect(turn.headers["chatgpt-account-id"]).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  test("the catalog row is SUBSCRIPTION-priced, so nothing it returns can feed R6-H cost", () => {
    expect(ROW.pricingBasis).toBe("subscription");
    // A subscription row with a per-token price would be a contradiction the pricing basis hides.
    for (const model of catalog.models.filter((m) => m.providerId === "xai-oauth")) {
      expect(model.pricing).toBeUndefined();
      expect(model.status).toBe("candidate");
    }
  });

  test("the row's admission is evidence: an oauth-documented basis citing the audit and the pinned client", () => {
    expect(ROW.admission.basis).toBe("oauth-documented");
    expect(ROW.admission.citation).toContain("audit:2.5");
    // The pinned commit travels WITH the row, so a reviewer reading the catalog alone can still
    // reach the artifact the constants came from.
    expect(ROW.admission.citation).toContain(DERIVED_XAI_COMMIT);
    expect(ROW.authKinds).toEqual(["oauth-approved"]);
  });

  test("the row's endpoint is the subscription proxy the capture derived, and the adapter agrees with it", () => {
    // The catalog row and the adapter constant are two independent statements of the same fact, and
    // `createShippedAdapters` wires the ROW's value in. If they ever diverge, the shipped request
    // goes somewhere the reviewed row does not name.
    expect(ROW_API).toBe(DERIVED_XAI.apiBaseUrl);
    expect(ROW_API).toBe(XAI_OAUTH.apiBaseUrl);
    expect(ROW_API).not.toContain("api.x.ai");
  });

  test("R6b-7: the reversion SWITCH works on this row — the per-provider enabled setting refuses it at resolution, by name", () => {
    // T1 pinned the mechanism generically (on `ollama-local`); this pins it on the row the ruling was
    // WRITTEN for. The audit's condition is "ship it behind a setting that can be turned off without
    // a release" — that is a claim about THIS provider id, and nothing else asserted it.
    const registry = createSelectionRegistry(catalog);
    for (const shipped of createShippedAdapters(catalog)) registry.register(shipped);
    const base = { registry, credentials: createMemoryCredentialStore(), env: {} };
    const config: RuntimeConfig = { sessionId: "s", cwd: "/tmp/x", model: "xai-oauth/grok-4.6" };

    // The POSITIVE leg first: without it the refusal below would pass just as happily on a model
    // that never resolves at all, which is exactly what a broken row looks like from outside.
    const resolved = resolveSessionProvider(config, base);
    expect("testProvider" in resolved).toBe(false);

    let err: unknown;
    try {
      resolveSessionProvider(config, { ...base, providerSettings: () => ({ "xai-oauth": { enabled: false } }) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WinterProviderResolutionError);
    expect((err as WinterProviderResolutionError).code).toBe("provider-disabled");
    expect((err as Error).message).toContain("providers.xai-oauth.enabled");
  });

  test("the repository NOTICE pins the SAME commit the derived constants were read at", async () => {
    // Fix-wave carry (release gates). `NOTICE` is the attribution a release ships and
    // `DERIVED_XAI_COMMIT` is what the capture actually read; nothing tied the two, so a re-capture
    // at a newer commit could update the constants and leave the NOTICE attesting to an artifact
    // Winter no longer derives from — which is the one claim in that file a reader relies on.
    const notice = await Bun.file(new URL("../../../../NOTICE", import.meta.url)).text();
    expect(notice).toContain(DERIVED_XAI_COMMIT);
    // ...and the repository it names, so the commit is not a bare hex string a reader cannot resolve.
    expect(notice).toContain("xai-org/grok-build");
    // The row carries it too, which is what lets a reviewer reading the CATALOG alone reach the
    // artifact. Three statements of one fact, all machine-checked against each other.
    expect(ROW.admission.citation).toContain(DERIVED_XAI_COMMIT);
  });

  test("the adapter this build ships is registered under the id the row names", () => {
    // The failure this catches is `no-adapter` at resolution time for a row the catalog swears is
    // shipped — the exact thing `createShippedAdapters` exists to make impossible.
    const ids = createShippedAdapters(catalog).map((a) => a.id);
    expect(ids).toContain(XAI_OAUTH_ADAPTER_ID);
    expect(ids).toContain(ROW.adapterId);
  });
});
