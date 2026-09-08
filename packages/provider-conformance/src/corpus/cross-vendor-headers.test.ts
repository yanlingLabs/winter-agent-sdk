// P6.5 fix wave (ruling R-FW-1, whole-branch review I-1 and I-2): THE COMPOSED-ROW HEADER SWEEP.
//
// The review's finding was not "one adapter has a bug". It was that every header assertion on the
// branch was written from the SAME vendor's fixture as the row it guarded, so a header named for
// ANOTHER vendor was structurally invisible: `xai-oauth.test.ts` and `DERIVED_XAI.vendorOnlyHeaders`
// enumerate xAI's own six names, and the header that actually shipped was `chatgpt-account-id`.
//
// So this file drives the rows where a header can arrive from somewhere other than their own family
// — the composed adapter (`xai-oauth`), the multi-provider ones (`winter.anthropic-messages` serves
// eight rows, `winter.openai-chat-completions` serves a hundred and thirty-six) and a chat row
// carrying OAUTH material (the shape the dormant branch keyed on) — and sweeps EVERY header of
// EVERY recorded request against `crossVendorHeaderViolations`, whose rule is keyed on the row's own
// identity rather than on a list of one vendor's names.
//
// GROUND TRUTH IS THE LOOPBACK FAKE'S REQUEST LOG, and the path is the PRODUCTION one: the real
// catalog with each driven row's `defaultEndpoints.api` rewritten to the fake (so the row keeps its
// own adapter, its own auth style and its own multi-provider status), the real
// `createShippedAdapters`, and `buildSessionProvider` — the same wiring a session gets. That matters
// beyond tidiness: a multi-provider row's endpoint is COPIED into `connection.baseUrl` by
// `connectionFrom`, which makes its policy NON-generated in production, and an adapter-level fixture
// with `generatedBaseUrl` would be testing a policy real sessions never see.
//
// `codex-oauth` is driven as the POSITIVE CONTROL. It sends `chatgpt-account-id` and `originator`
// legitimately, and the sweep must pass it while proving it can see those names — otherwise a rule
// that passed everything would look identical to a rule that worked.
//
// Everything is loopback and in-memory: one fake on `127.0.0.1:0` closed in a `finally`, in-memory
// credential stores, and `test-token-…` literals.

import { describe, expect, test } from "bun:test";
import { loadCatalog, type WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialRef, CredentialMaterial } from "@yanlinglabs/winter-provider-runtime";
import { createMemoryCredentialStore, winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
// `buildSessionProvider` stays relative (review r1 Critical-2): `winter-agent-runtime` is
// `"private": true`, never published -- irrelevant here since `.test.ts` files never ship as
// reachable code.
import { buildSessionProvider } from "../../../runtime/src/provider/session-provider.ts";
import { anthropicFakeRoutes, anthropicTurnResponse } from "../fakes/anthropic-messages.ts";
import { chatStream } from "../fakes/openai-chat.ts";
import { responsesStream } from "../fakes/openai-responses.ts";
import { jsonResponse, startFake, type FakeRoute, type FakeServer, type RecordedRequest } from "../fakes/server.ts";
import { crossVendorHeaderViolations, crossVendorViolationsIn } from "./cross-vendor-headers.ts";

const CATALOG = loadCatalog();

/**
 * The rows this sweep drives, and WHY each one is exposed to a header from another vendor.
 *
 * `material` is the credential KIND the row's `authKinds` documents — except where the point is the
 * opposite (see `openrouter`), which is called out on the row itself.
 */
interface SweepRow {
  id: string;
  /** Why this row can receive a header its own family never authored. */
  why: string;
  material: "api-key" | "oauth";
}

const ROWS: readonly SweepRow[] = [
  { id: "xai-oauth", why: "COMPOSED: `createXaiOauthAdapter` wraps the plain chat adapter, and its single-provider endpoint is GENERATED — so a privileged header the row never asked for is passed rather than dropped", material: "oauth" },
  { id: "openrouter", why: "a CHAT row driven with OAUTH material — the exact shape the removed `auth.accountId` branch keyed on, on a row whose vendor is not OpenAI", material: "oauth" },
  { id: "aihorde", why: "a keyless-documented row on the 136-row chat adapter; also the `Client-Agent` row (I-2)", material: "api-key" },
  { id: "deepseek-anthropic", why: "R6b-5 dialect sibling on the multi-provider Anthropic adapter", material: "api-key" },
  { id: "zai-anthropic", why: "R6b-5 dialect sibling", material: "api-key" },
  { id: "minimax-anthropic", why: "R6b-5 dialect sibling", material: "api-key" },
  { id: "kimi-coding", why: "R6b-5 dialect sibling, and the subscription one", material: "api-key" },
  { id: "anthropic", why: "the multi-provider adapter's OWN vendor row, with D20 oauth material: the one row whose `anthropic-beta` is legitimate", material: "oauth" },
  { id: "openai", why: "the Responses TWIN of the removed `auth.accountId` branch (`responses.ts`): the plain OpenAI row driven with OAUTH material at its GENERATED Responses endpoint — a re-introduction in responses.ts alone passed every shipped suite before this row existed (fix-wave re-review, Minor 1)", material: "oauth" },
  { id: "codex-oauth", why: "POSITIVE CONTROL: `chatgpt-account-id` and `originator` are ITS headers and must survive the sweep", material: "oauth" },
];

function rowOf(id: string): { providerId: string; adapterId: string; modelKey: string; wireModel: string; multiProvider: boolean } {
  const provider = CATALOG.providers.find((p) => p.id === id);
  if (provider === undefined) throw new Error(`the committed catalog has no ${JSON.stringify(id)} provider row`);
  const model = CATALOG.models.find((m) => m.providerId === id);
  if (model === undefined) throw new Error(`the committed catalog has no model row for ${JSON.stringify(id)}`);
  return {
    providerId: id,
    adapterId: provider.adapterId,
    modelKey: model.key,
    wireModel: model.upstreamId,
    multiProvider: CATALOG.providers.filter((p) => p.adapterId === provider.adapterId).length > 1,
  };
}

/** The real catalog with ONE row's api endpoint pointed at the fake. Everything else about the row — adapter, auth kinds, siblings — is untouched. */
function catalogPointedAt(providerId: string, url: string): WinterCatalog {
  return {
    ...CATALOG,
    providers: CATALOG.providers.map((p) => (p.id === providerId ? { ...p, defaultEndpoints: { ...p.defaultEndpoints, api: url } } : p)),
  };
}

/** One fake serving all three dialects, so every row in the table is driven against the same recorder. */
async function startSweepFake(wireModels: readonly string[]): Promise<FakeServer> {
  const anthropicRoutes = anthropicFakeRoutes({
    messages: Object.fromEntries(wireModels.map((model) => [model, [anthropicTurnResponse({ model, blocks: [{ type: "text", chunks: ["hello"] }] })]])),
  });
  const routes: FakeRoute[] = [
    { path: "/chat/completions", method: "POST", handler: () => chatStream({ text: ["hello"] }) },
    { path: "/responses", method: "POST", handler: () => responsesStream({ text: ["hello"] }) },
    ...anthropicRoutes,
    { path: "/models", method: "GET", handler: () => jsonResponse({ data: [] }) },
  ];
  return await startFake({ routes });
}

const OAUTH_MATERIAL: CredentialMaterial = {
  kind: "oauth",
  accessToken: "test-token-sweep-access",
  refreshToken: "test-token-sweep-refresh",
  // THE ACCOUNT ID IS THE POINT. `chatgpt-account-id` was authored from exactly this field, so
  // omitting it here would make every row in the table pass for the wrong reason.
  accountId: "acct-sweep",
  expiresAt: Date.now() + 3_600_000,
};

/** Drives one row to a real turn and returns everything the fake recorded. */
async function driveRow(row: SweepRow): Promise<{ requests: RecordedRequest[]; adapterId: string }> {
  const resolved = rowOf(row.id);
  const fake = await startSweepFake([resolved.wireModel]);
  try {
    // The keychain ref is built (and typed) SEPARATELY from the union, because
    // `createMemoryCredentialStore`'s seed pairs are keychain-keyed by type — a store seeded through
    // the union would not compile, and widening the seed's type to make it would be the wrong repair.
    const keychainRef = { kind: "keychain", account: `${row.id}:acct-sweep` } as const;
    const ref: CredentialRef = row.material === "oauth" ? keychainRef : { kind: "inline", value: "test-key-sweep" };
    const credentials = row.material === "oauth" ? createMemoryCredentialStore([[keychainRef, OAUTH_MATERIAL] as const]) : createMemoryCredentialStore();
    const config = {
      sessionId: "cross-vendor-sweep",
      cwd: process.cwd(),
      model: resolved.modelKey,
      provider: {
        providerId: row.id,
        authRef: ref,
        // `local: true` and NO `baseUrl`. A multi-provider row's endpoint is copied into
        // `connection.baseUrl` by `connectionFrom`, which makes it a USER endpoint — and R6-11
        // refuses plain http to a loopback address unless the profile declares a local
        // installation. Declaring it is what lets the production copy-path run against a fake at
        // all; it does not widen anything, because a `baseUrl` is still never supplied here.
        ...(resolved.multiProvider ? { connection: { local: true } } : {}),
      },
    } as unknown as RuntimeConfig;

    const wiring = buildSessionProvider({ config, env: {}, catalog: catalogPointedAt(row.id, fake.url), credentials });
    await wiring.provider.generate({ messages: [{ role: "user", content: "ping" }], model: resolved.wireModel });
    return { requests: [...fake.requests], adapterId: resolved.adapterId };
  } finally {
    await fake.close();
  }
}

describe("WS-13 §5 / fix-wave R-FW-1: no row reaches its vendor carrying ANOTHER vendor's product header", () => {
  test.each(ROWS.map((row) => [row.id, row] as const))("%s: every request header is its own family's or Winter's", async (_id, row) => {
    const { requests, adapterId } = await driveRow(row);
    // Non-vacuous first: a sweep over zero requests passes trivially, and a row that failed to
    // resolve produces exactly that.
    expect([row.id, requests.length]).toEqual([row.id, 1]);
    expect([row.why, crossVendorViolationsIn({ providerId: row.id, adapterId }, requests)]).toEqual([row.why, []]);
    // ...and Winter named itself on the same request, on every family. An absent identity and a
    // clean sweep are not the same result.
    expect([row.id, requests[0]?.headers["user-agent"]?.startsWith("winter-agent-sdk/")]).toEqual([row.id, true]);
  }, 15_000);

  test("the POSITIVE CONTROL really did carry the codex headers — the sweep passed them, it did not miss them", async () => {
    // Without this, "no violations on codex-oauth" would be indistinguishable from "codex-oauth sent
    // no privileged header at all", which is what a broken wiring looks like from outside.
    const { requests } = await driveRow(ROWS.find((r) => r.id === "codex-oauth")!);
    expect(requests[0]?.headers["chatgpt-account-id"]).toBe("acct-sweep");
    expect(requests[0]?.headers["originator"]).toBe("winter");
    // ...and the same two names on any OTHER row are violations. Asserted on the rule directly, so
    // the claim does not depend on a second live drive.
    expect(crossVendorHeaderViolations({ providerId: "xai-oauth", adapterId: "winter.xai-oauth" }, { "chatgpt-account-id": "acct-sweep", originator: "winter" })).toEqual([
      'xai-oauth (winter.xai-oauth) sent "chatgpt-account-id", a "chatgpt-" header owned by codex-oauth',
    ]);
  }, 15_000);

  test("the dialect exemption is BY NAME: `anthropic-version` passes on a sibling, `anthropic-organization` does not", () => {
    // The rule's one interpretive call, pinned so a later reader sees it as a decision rather than
    // an accident. `anthropic-version` is PROTOCOL (`endpoint-policy.ts` says so in its own words) —
    // the sibling rows literally cannot be spoken to without it. Exempting the whole `anthropic-`
    // PREFIX would have re-opened the hole this rule exists to close, so only the two protocol names
    // are exempt and everything else in that namespace still fails.
    const sibling = { providerId: "deepseek-anthropic", adapterId: "winter.anthropic-messages" };
    expect(crossVendorHeaderViolations(sibling, { "anthropic-version": "2023-06-01", "anthropic-beta": "some-beta" })).toEqual([]);
    expect(crossVendorHeaderViolations(sibling, { "anthropic-organization": "org-x" })).toEqual([
      'deepseek-anthropic (winter.anthropic-messages) sent "anthropic-organization", a "anthropic-" header owned by anthropic',
    ]);
    // And the exemption is scoped to the DIALECT's adapter: the same name on a chat row fails.
    expect(crossVendorHeaderViolations({ providerId: "aihorde", adapterId: "winter.openai-chat-completions" }, { "anthropic-version": "2023-06-01" })).toHaveLength(1);
  });
});

/**
 * WS-13b §2/§7/§8.4 + audit §5.1 (fix-wave R-FW-2, whole-branch review I-2): THE SECOND IDENTITY
 * FIELD ACTUALLY ARRIVES.
 *
 * The spec asks for "a truthful `Client-Agent`" on the keyless rows, and what shipped was a row
 * whose citation NAMES the header and no code that sends it — the row author handed it to "the
 * adapter owner", whose brief was the live gate. So the assertion here is the LIVE REQUEST, on the
 * PRODUCTION path, and the table is read off the catalog rather than written out: a future row that
 * declares `identityHeaders` and is never wired into its family gets a red here without anybody
 * remembering to add a case.
 */
describe("WS-13b §7/§8.4: every row that DECLARES an identity header actually sends it", () => {
  const declaring = CATALOG.providers.filter((p) => p.identityHeaders !== undefined && Object.keys(p.identityHeaders).length > 0);

  test("the catalog declares at least one — the sweep below is not vacuous", () => {
    // `aihorde` today. If this ever goes to zero the obligation was deleted, not satisfied.
    expect(declaring.map((p) => p.id)).toEqual(["aihorde"]);
  });

  test.each(declaring.map((p) => [p.id] as const))("%s sends its declared identity header, with `<product>` and `<version>` substituted", async (id) => {
    const provider = CATALOG.providers.find((p) => p.id === id)!;
    // `authKinds` decides the material, so a keyless-documented row is driven exactly as the live
    // gate drives it rather than however this file finds convenient.
    const { requests } = await driveRow({ id, why: "declares identityHeaders", material: provider.authKinds.includes("oauth-approved") ? "oauth" : "api-key" });
    expect(requests).toHaveLength(1);
    // BOTH halves are read off the User-Agent this build actually sends, so the expectation cannot
    // drift from the product: `<product>/<version>` is that header's whole shape.
    const [product, version] = [winterUserAgent().split("/")[0]!, winterUserAgent().split("/")[1]!];
    for (const [name, declared] of Object.entries(provider.identityHeaders ?? {})) {
      const expected = declared.split("<product>").join(product).split("<version>").join(version);
      // Header names arrive lowercased on the recorder, as they do on the wire.
      expect([id, name, requests[0]?.headers[name.toLowerCase()]]).toEqual([id, name, expected]);
      // The substitution actually happened: a value still carrying either placeholder would be a
      // literal `<product>`/`<version>` on the wire, which reads as a bug report to whoever
      // receives it.
      expect(requests[0]?.headers[name.toLowerCase()]).not.toContain("<version>");
      expect(requests[0]?.headers[name.toLowerCase()]).not.toContain("<product>");
    }
  }, 15_000);

  test("a row that declares NONE sends none — the header is per-row, not per-adapter", async () => {
    // `openrouter` is on the SAME `winter.openai-chat-completions` instance as `aihorde`. If the
    // seam were adapter-scoped rather than row-scoped, this is where it would show.
    const { requests } = await driveRow(ROWS.find((r) => r.id === "openrouter")!);
    expect(requests[0]?.headers["client-agent"]).toBeUndefined();
    expect(requests[0]?.headers["user-agent"]).toBe(winterUserAgent());
  }, 15_000);
});
