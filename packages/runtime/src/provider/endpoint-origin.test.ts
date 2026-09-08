// P7a (Lane D): WHERE a connection profile's `baseUrl` came from, and what that changes.
//
// TWO THINGS THIS FILE PROVES, both through the REAL wiring (`buildSessionProvider` →
// `buildProvider` → the shipped chat adapter → a loopback fake), because both were previously
// green-in-fixtures and wrong-in-production for the same reason:
//
//   1. WS-13b §10's M-1 PARTIAL, CLOSED. A multi-provider adapter has no vendor default to fall
//      back on, so the runtime copies the catalog's REVIEWED endpoint into the profile. Until
//      `endpointOrigin` existed, every adapter read a present `baseUrl` as a user endpoint — so 156
//      of the catalog's rows silently left the privileged-header path and the profile-`User-Agent`
//      rule inverted on them, while every adapter unit test kept passing because those tests pass a
//      generated base URL DIRECTLY and never through a profile. That is why these fixtures drive
//      the wiring rather than the adapter.
//   2. WS-13b §2/§10's PER-TENANT ROWS. `azure-ai`/`oci` ship no endpoint at all. The refusal has
//      to happen in the wiring: this row sits on `winter.openai-chat-completions`, whose
//      `resolveEndpoint` falls back to the ADAPTER's compiled-in vendor default when the profile
//      carries no base — which would put this provider's credential on the wire to somebody else's
//      host. A test that asserted "an error is thrown" without watching the fakes could not tell
//      the refusal from that fallback.
//
// GROUND TRUTH IS THE FAKE'S REQUEST LOG. `hostHeaders` (privileged-headers.ts) is the observable:
// on a GENERATED policy it drops the host's `user-agent` (Winter's identity is what reaches a
// reviewed vendor endpoint) and KEEPS `x-goog-quota-project`; on a USER policy it does the exact
// inverse (the operator may describe their own proxy, and their account topology must not leak to a
// host the catalog never named). One flag, two opposite consequences — so a fixture that got the
// flag backwards fails twice, in opposite directions, rather than being half-right.
import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog, stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import { WinterProviderResolutionError, createMemoryCredentialStore, winterUserAgent } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider, connectionForProvider, generatedConnectionForProvider } from "./session-provider.ts";

const SESSION_KEY = "ENDPOINT-ORIGIN-SESSION-KEY";
const HOST_UA = "some-other-product/9.9";
const QUOTA_PROJECT = "operator-quota-project";

function evidence<T>(value: T) {
  return { value, source: "official-doc" as const, observedAt: "2026-09-08", confidence: "verified" as const };
}

interface RawRequest {
  path: string;
  headers: Record<string, string>;
}

/** A chat-completions fake bound to 127.0.0.1:0, closed by every caller in `finally`. Records the headers only. */
async function startFake(): Promise<{ url: string; requests: RawRequest[]; close(): Promise<void> }> {
  const requests: RawRequest[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      requests.push({ path: new URL(req.url).pathname, headers });
      const chunk = (delta: Record<string, unknown>, finish?: string): string =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "x", choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }] })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "" }) + chunk({ content: "hi" }) + chunk({}, "stop"), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    async close() {
      await server.stop(true);
    },
  };
}

const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

function model(providerId: string, upstreamId: string): WinterModelDescriptor {
  return stampRow({
    key: `${providerId}/${upstreamId}`,
    providerId,
    upstreamId,
    displayName: upstreamId,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native"),
    nativeTools: evidence(true),
    unsupportedParameters: [],
    status: "supported",
  } as Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">);
}

function baseRow(id: string, over: Partial<WinterProviderDescriptor>): WinterProviderDescriptor {
  return {
    id,
    displayName: id,
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    defaultEndpoints: {},
    // `local` declares the loopback fake, exactly as the twelve local rows do; without it
    // `evaluateEndpoint` refuses plain http to 127.0.0.1 on a USER endpoint — which is a DIFFERENT
    // refusal from the ones under test and would mask them.
    modelDiscovery: "local",
    liveCatalogAuthority: "partial",
    // THE SHARED adapter, deliberately: an adapter serving one provider gets its endpoint compiled
    // in and never goes through the copy path this file is about.
    adapterId: "winter.openai-chat-completions",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture:endpoint-origin", tier: "local" },
    ...over,
  };
}

/** Two rows on ONE adapter — which is what makes `connectionFrom` copy a reviewed endpoint at all. */
function catalogFor(reviewedApi: string): WinterCatalog {
  return {
    schemaVersion: 2,
    families: [],
    catalogVersion: "0.0.0-endpoint-origin",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [
      baseRow("reviewedrow", { defaultEndpoints: { api: reviewedApi } }),
      // The per-tenant row: NO endpoint, a template, and a sibling on the same adapter (the shipped
      // `azure-ai`/`oci` shape, which catalog-integrity pins).
      baseRow("tenantrow", { requiresUserEndpoint: true, endpointTemplate: "https://<resource>.services.example.test/openai/v1" }),
    ],
    models: [model("reviewedrow", "m1"), model("tenantrow", "m1")],
  };
}

function configFor(providerId: string, connection?: RuntimeConfig["provider"] extends infer P ? (P extends { connection?: infer C } ? C : never) : never): RuntimeConfig {
  return {
    sessionId: "endpoint-origin",
    cwd: process.cwd(),
    model: `${providerId}/m1`,
    persistSession: false,
    provider: { providerId, authRef: { kind: "inline", value: SESSION_KEY }, ...(connection !== undefined ? { connection } : {}) },
  } as RuntimeConfig;
}

async function withFake(run: (fake: Awaited<ReturnType<typeof startFake>>) => Promise<void>): Promise<void> {
  const fake = await startFake();
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

// --- the marker itself ---------------------------------------------------------------------------

describe("P7a: `connectionFrom` records WHERE the baseUrl came from", () => {
  test("the catalog's copied endpoint is `reviewed`; an operator's own is `user`", () => {
    const catalog = catalogFor("https://reviewed.example/v1");
    const row = catalog.providers.find((p) => p.id === "reviewedrow")!;

    const copied = connectionForProvider(configFor("reviewedrow"), catalog, row);
    expect(copied).toEqual({ baseUrl: "https://reviewed.example/v1", endpointOrigin: "reviewed", local: true });

    const supplied = connectionForProvider(configFor("reviewedrow", { baseUrl: "https://operator.example/v1", local: false }), catalog, row);
    expect(supplied).toEqual({ baseUrl: "https://operator.example/v1", local: false, endpointOrigin: "user" });
  });

  test("a HOST that writes `endpointOrigin: \"reviewed\"` into its own profile is overwritten to `user` — provenance is not self-certifiable", () => {
    // The attack this closes: `endpointOrigin` decides whether the operator's organisation/project
    // headers ride a URL. If a host could assert the marker, it could vouch for its own endpoint and
    // collect exactly the account topology R6-L exists to withhold. Only the copy below mints
    // `"reviewed"`.
    const catalog = catalogFor("https://reviewed.example/v1");
    const row = catalog.providers.find((p) => p.id === "reviewedrow")!;
    const supplied = connectionForProvider(configFor("reviewedrow", { baseUrl: "https://operator.example/v1", endpointOrigin: "reviewed" }), catalog, row);
    expect(supplied?.endpointOrigin).toBe("user");
  });

  // --- THE SHIPPED ROWS, not a fixture ------------------------------------------------------------
  //
  // Closing WS-13b §10's M-1 partial changes live behaviour on ~156 catalog rows, and the twelve
  // LOCAL runners are the largest part of that blast radius: a host is likeliest to have set a proxy
  // `user-agent` on one of their profiles, and their `http://127.0.0.1:…` endpoint is a COPIED
  // reviewed one, so that header is now dropped and the privileged set now applies. The cases above
  // prove the rule on synthetic rows whose only nod to the cohort is `modelDiscovery: "local"` — a
  // fixture cannot fail when a future catalog edit moves a real local row off the shared adapter or
  // changes its discovery mode. These name shipped ids and read the shipped catalog.
  test("the SHIPPED `ollama-local` row is stamped `reviewed` and `local` — the local cohort is the M-1 closure's largest blast radius", () => {
    const real = loadCatalog();
    const row = real.providers.find((p) => p.id === "ollama-local")!;
    expect(row).toBeDefined();
    const connection = connectionForProvider(configFor("ollama-local"), real, row);
    expect(connection).toEqual({ baseUrl: row.defaultEndpoints["api"] as string, endpointOrigin: "reviewed", local: true });
  });

  test("the SHIPPED `deepseek-anthropic` row is stamped `reviewed` too — an Anthropic-dialect sibling, not a local runner", () => {
    // The other half of the ~156: a non-local, multi-provider row on the Anthropic family, whose
    // reviewed endpoint the runtime copies for exactly the same reason. `local` is absent here
    // (`modelDiscovery` is not `"local"`), so this case also pins that the two stamps are
    // independent -- `endpointOrigin` is about PROVENANCE, `local` about the address.
    const real = loadCatalog();
    const row = real.providers.find((p) => p.id === "deepseek-anthropic")!;
    expect(row).toBeDefined();
    const connection = connectionForProvider(configFor("deepseek-anthropic"), real, row);
    expect(connection).toEqual({ baseUrl: row.defaultEndpoints["api"] as string, endpointOrigin: "reviewed" });
  });

  test("a row on a SINGLE-provider adapter still gets no baseUrl at all — the copy rule is unchanged", () => {
    // Guarding the P6 rule the marker sits on top of: the copy happens only where the adapter has no
    // vendor default. A change that started copying everywhere would demote every reviewed endpoint
    // into the profile — and now it would ALSO stamp them `reviewed`, which would look correct.
    const catalog = catalogFor("https://reviewed.example/v1");
    const solo = { ...catalog, providers: [catalog.providers[0]!] };
    expect(connectionForProvider(configFor("reviewedrow"), solo, solo.providers[0]!)).toBeUndefined();
  });
});

// --- the M-1 partial, through the real wiring ----------------------------------------------------

describe("WS-13b §10 (M-1): a COPIED reviewed endpoint is evaluated as reviewed, not as a user endpoint", () => {
  test("the host's `user-agent` does NOT reach a reviewed vendor endpoint, and its `x-goog-quota-project` DOES", async () => {
    await withFake(async (fake) => {
      const wiring = buildSessionProvider({
        config: configFor("reviewedrow", { headers: { "user-agent": HOST_UA, "x-goog-quota-project": QUOTA_PROJECT } }),
        env: {},
        catalog: catalogFor(fake.url),
        credentials: createMemoryCredentialStore(),
      });
      await wiring.provider.generate({ messages: [{ role: "user", content: "hello" }] });

      expect(fake.requests.length).toBe(1);
      const headers = fake.requests[0]!.headers;
      // BEFORE this change both assertions were the other way round on every one of the catalog's
      // 156 multi-provider rows, in production only.
      expect(headers["user-agent"]).toBe(winterUserAgent());
      expect(headers["user-agent"]).not.toBe(HOST_UA);
      expect(headers["x-goog-quota-project"]).toBe(QUOTA_PROJECT);
    });
  });

  test("...and the operator's OWN endpoint keeps the exact inverse — their UA rides, their quota project does not", async () => {
    await withFake(async (fake) => {
      const wiring = buildSessionProvider({
        // Same row, same catalog, same headers: the ONLY difference is that the operator named the
        // endpoint. `defaultEndpoints.api` is pointed at an address nothing is listening on, so a
        // regression that ignored the profile's base would fail loudly rather than pass by luck.
        config: configFor("reviewedrow", { baseUrl: fake.url, local: true, headers: { "user-agent": HOST_UA, "x-goog-quota-project": QUOTA_PROJECT } }),
        env: {},
        catalog: catalogFor("https://unreachable.invalid/v1"),
        credentials: createMemoryCredentialStore(),
      });
      await wiring.provider.generate({ messages: [{ role: "user", content: "hello" }] });

      expect(fake.requests.length).toBe(1);
      const headers = fake.requests[0]!.headers;
      expect(headers["user-agent"]).toBe(HOST_UA);
      expect(headers["x-goog-quota-project"]).toBeUndefined();
    });
  });
});

// --- the per-tenant refusal ----------------------------------------------------------------------

describe("WS-13b §2/§10: a `requiresUserEndpoint` provider REQUIRES the profile's baseUrl", () => {
  test("absent → the typed `endpoint-required` refusal, naming the template, and NOTHING is ever requested", async () => {
    await withFake(async (fake) => {
      const wiring = buildSessionProvider({
        config: configFor("tenantrow"),
        env: {},
        catalog: catalogFor(fake.url),
        credentials: createMemoryCredentialStore(),
      });

      // R6-9's deferred refusal: the session STARTS (no throw here), and the first generation
      // reports it. A refusal that threw from the constructor would take the session down before
      // `system/init`.
      expect(wiring.resolutionError?.code).toBe("endpoint-required");
      expect(wiring.resolutionError?.message).toContain("https://<resource>.services.example.test/openai/v1");

      await expect(wiring.provider.generate({ messages: [{ role: "user", content: "hello" }] })).rejects.toThrow(/endpoint/i);
      // THE POINT. `winter.openai-chat-completions` falls back to its own compiled-in vendor default
      // when a profile carries no base, so "no request at all" is what separates a refusal from this
      // provider's credential arriving at another vendor's host. The sibling row's fake is the
      // nearest reachable stand-in for that default and it saw nothing.
      expect(fake.requests.length).toBe(0);
    });
  });

  test("present → the request goes to the OPERATOR's endpoint and is evaluated as a USER one (no privileged header)", async () => {
    await withFake(async (fake) => {
      const wiring = buildSessionProvider({
        config: configFor("tenantrow", { baseUrl: fake.url, local: true, headers: { "user-agent": HOST_UA, "x-goog-quota-project": QUOTA_PROJECT } }),
        env: {},
        catalog: catalogFor("https://unreachable.invalid/v1"),
        credentials: createMemoryCredentialStore(),
      });
      expect(wiring.resolutionError).toBeUndefined();
      await wiring.provider.generate({ messages: [{ role: "user", content: "hello" }] });

      expect(fake.requests.length).toBe(1);
      expect(fake.requests[0]!.path).toBe("/chat/completions");
      // A per-tenant endpoint is the OPERATOR'S, never reviewed by Winter — so the user-endpoint
      // rules apply to it in full.
      expect(fake.requests[0]!.headers["user-agent"]).toBe(HOST_UA);
      expect(fake.requests[0]!.headers["x-goog-quota-project"]).toBeUndefined();
    });
  });

  test("a CROSS-PROVIDER target on a per-tenant provider refuses too — it has no endpoint and may not borrow the session's", () => {
    // Ruling E-1 forbids a cross-provider target from taking the session's user `baseUrl`, and this
    // provider ships none of its own, so there is genuinely nothing to reach. A classifier, advisor
    // or R6-17 child pointed at `azure-ai` lands here.
    const catalog = catalogFor("https://reviewed.example/v1");
    const tenant = catalog.providers.find((p) => p.id === "tenantrow")!;
    let thrown: unknown;
    try {
      generatedConnectionForProvider(catalog, tenant);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
    expect((thrown as WinterProviderResolutionError).code).toBe("endpoint-required");
  });

  test("the refusal message never echoes an endpoint — only the documented template", () => {
    // A refusal string is one of the most reliably-logged values in any system. Echoing the
    // operator's real base URL back would put their tenant or region name into every log that
    // captures this error; the template is documentation and names nobody.
    const catalog = catalogFor("https://reviewed.example/v1");
    const tenant = catalog.providers.find((p) => p.id === "tenantrow")!;
    let message = "";
    try {
      connectionForProvider(configFor("tenantrow"), catalog, tenant);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("https://<resource>.services.example.test/openai/v1");
    expect(message).not.toContain("reviewed.example");
    expect(message).not.toContain(SESSION_KEY);
  });
});

// --- P7a fix wave item 4: the refusal must not ESCAPE the switch seam as a throw -----------------
//
// Ruling E-2's whole point is that the engine calls `resolveModelSwitch` FIRST, so an unusable
// target becomes a control-response refusal and nothing is ever parked. Every resolution branch in
// that function already returned a typed `{refused, code, message}` -- and then the two calls that
// MATERIALISE the target (`describeTargetMaterial`, and `buildProvider`, which calls it again) could
// still throw straight past all of them, because `connectionFrom` raises `endpoint-required` for a
// per-tenant row with no user `baseUrl`. A `set_model` onto `azure-ai`/`oci` is exactly that shape,
// and it landed on the caller's generic error path instead of the refusal a host is shaped to render.
describe("P7a fix wave (item 4): `endpoint-required` reaches the caller as the TYPED refusal, never as a throw", () => {
  test("a CROSS-PROVIDER slot switch onto a per-tenant row refuses -- `{refused, code: \"endpoint-required\"}`, no throw", () => {
    const catalog = catalogFor("https://reviewed.example/v1");
    // A slot is the one production path that legitimately crosses providers on a BARE name (WS-13c
    // §5): the slot resolver has already made the provider decision, so `resolveModelSwitch` looks
    // the target up under the SLOT's provider and reaches `describeTargetMaterial` cross-provider --
    // where `generatedConnectionForProvider` refuses, because a cross-provider target may not borrow
    // the session's endpoint and this row ships none of its own.
    const wiring = buildSessionProvider({
      config: configFor("reviewedrow"),
      env: {},
      catalog,
      credentials: createMemoryCredentialStore(),
      resolveSlot: (requested) =>
        requested === "tenant"
          ? { ok: true, modelKey: "tenantrow/m1", providerId: "tenantrow", canonicalModelId: "m1", slot: { family: "openai", name: "tenant", source: "default" }, viaSlotName: true }
          : { ok: false, code: "unknown-slot", message: `no slot named "${requested}"`, wouldServe: [] },
    });
    expect(wiring.resolutionError).toBeUndefined();

    let thrown: unknown;
    let outcome: ReturnType<typeof wiring.resolveModelSwitch> | undefined;
    try {
      outcome = wiring.resolveModelSwitch("tenant");
    } catch (err) {
      thrown = err;
    }
    // BEFORE the fix this line is what fails: the call threw and `outcome` stayed undefined.
    expect(thrown).toBeUndefined();
    expect(outcome).toBeDefined();
    expect(outcome).toHaveProperty("refused", true);
    const refusal = outcome as { refused: true; code: string; message: string };
    expect(refusal.code).toBe("endpoint-required");
    // The message the seam hands on is the connection layer's own, so the operator is told what to
    // set -- and it still names only the TEMPLATE, never a real endpoint.
    expect(refusal.message).toContain("https://<resource>.services.example.test/openai/v1");
    expect(refusal.message).not.toContain("reviewed.example");
  });

  test("a SAME-PROVIDER switch on a refused per-tenant session refuses the same way -- the other door into `connectionFrom`", () => {
    // The second reachable shape: the session itself is on the per-tenant row with no `baseUrl`, so
    // it started REFUSED (deferred, per R6-9) and `sessionProviderId()` is `tenantrow`. A `set_model`
    // to that provider's own qualified key resolves fine and then dies in `connectionForProvider` --
    // a different branch of the same function, and it must answer the same way.
    const wiring = buildSessionProvider({
      config: configFor("tenantrow"),
      env: {},
      catalog: catalogFor("https://reviewed.example/v1"),
      credentials: createMemoryCredentialStore(),
    });
    expect(wiring.resolutionError?.code).toBe("endpoint-required");

    let thrown: unknown;
    let outcome: ReturnType<typeof wiring.resolveModelSwitch> | undefined;
    try {
      outcome = wiring.resolveModelSwitch("tenantrow/m1");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(outcome).toHaveProperty("refused", true);
    expect((outcome as { code: string }).code).toBe("endpoint-required");
  });

  test("a target that DOES resolve is unaffected -- the wrapper converts refusals, it does not swallow success", () => {
    // The guard on the guard: a try/catch around a construction is exactly the shape that can turn a
    // working path into a silent refusal, so the happy case is pinned in the same block.
    const wiring = buildSessionProvider({
      config: configFor("reviewedrow"),
      env: {},
      catalog: catalogFor("https://reviewed.example/v1"),
      credentials: createMemoryCredentialStore(),
    });
    const outcome = wiring.resolveModelSwitch("reviewedrow/m1");
    expect(outcome).not.toHaveProperty("refused");
    expect((outcome as { identity: { modelKey: string } }).identity.modelKey).toBe("reviewedrow/m1");
  });
});
