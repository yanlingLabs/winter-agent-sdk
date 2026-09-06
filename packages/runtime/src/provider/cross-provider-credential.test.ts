// P6 fix wave, Ruling E-1 (whole-branch review C-1, M-7): THE CREDENTIAL AND CONNECTION RULE for every
// provider `buildProvider` constructs.
//
// The whole-branch review's probe P1 drove two providers on the shared chat adapter, each with its own
// loopback fake, and watched vendor A's inline secret arrive at vendor B's endpoint -- for an R6-17
// child with a qualified key (P1a) and for a classifier whose route carried its OWN `authRef` that
// the wiring then dropped (P1b). Every fixture here is that probe with the assertion inverted, plus
// the three things the ruling adds: the target provider's OWN keychain record, the typed refusal when
// there is none, and the child's loud (never silent) fallback.
//
// GROUND TRUTH IS THE FAKES' REQUEST LOG: which fake received a request, with which `authorization`
// header, carrying which headers. A test that read the wiring's intent could not tell a fixed
// `buildProvider` from the old one.
import { describe, expect, test } from "bun:test";
import { serve } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { WinterProviderResolutionError, createMemoryCredentialStore, type CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider, DEFAULT_PROVIDER_ACCOUNT_ID } from "./session-provider.ts";
import { providerCredentialRef } from "./credential-api.ts";
import { buildProductionWiring } from "../production-wiring.ts";
import { runEngine, type Provider, type ProviderRequest } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { scriptedProvider } from "./mock.ts";
import { registerTool, unregisterToolForTest, type ToolExecutionContext } from "../tools/registry.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type SpawnChildRequest } from "../subagents/child-handle.ts";
import { createChildEngineFactory } from "../subagents/child-engine.ts";
import { resetSpawnLimitsForTest } from "../subagents/limits.ts";

// --- the two-provider world ----------------------------------------------------------------------

const SECRET_A = "SESSION-SECRET-FOR-PROVIDER-A-ONLY";
const SECRET_B_RECORD = "PROVIDER-B-OWN-KEYCHAIN-RECORD";

function evidence<T>(value: T) {
  return { value, source: "official-doc" as const, observedAt: "2026-09-06", confidence: "verified" as const };
}

interface RawRequest {
  path: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: string;
}

/** A chat-completions fake that records the raw `authorization` header. Bound to 127.0.0.1:0, closed by every caller in `finally`. */
async function startRawFake(): Promise<{ url: string; requests: RawRequest[]; close(): Promise<void> }> {
  const requests: RawRequest[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      const body = req.method === "GET" ? "" : await req.text();
      requests.push({ path: url.pathname, authorization: req.headers.get("authorization"), headers, body });
      const chunk = (delta: Record<string, unknown>, finish?: string): string =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "x", choices: [{ index: 0, delta, ...(finish !== undefined ? { finish_reason: finish } : {}) }] })}\n\n`;
      const usage = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "x", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;
      return new Response(chunk({ role: "assistant", content: "" }) + chunk({ content: "hi" }) + chunk({}, "stop") + usage, { headers: { "content-type": "text/event-stream" } });
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

function provider(id: string, api: string): WinterProviderDescriptor {
  return {
    id,
    displayName: id,
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    // Each provider's GENERATED endpoint is its own fake: the shared chat adapter copies it into the
    // profile (`connectionForProvider`), and `modelDiscovery: "local"` declares the loopback target.
    defaultEndpoints: { api },
    modelDiscovery: "local",
    liveCatalogAuthority: "partial",
    adapterId: "winter.openai-chat-completions",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    // WS-13b §1: both fields are REQUIRED on every provider row, so a fixture states its
    // own basis rather than inheriting one — a row-shape change fails HERE, at the fixture.
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture:cross-provider" },
  };
}

function model(key: string, providerId: string, upstreamId: string): WinterModelDescriptor {
  return {
    key,
    providerId,
    upstreamId,
    displayName: key,
    description: key,
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native"),
    nativeTools: evidence(true),
    unsupportedParameters: [],
    status: "supported",
  } as WinterModelDescriptor;
}

function catalogFor(apiA: string, apiB: string): WinterCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: "0.0.0-fixe-e1",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [provider("prova", apiA), provider("provb", apiB)],
    models: [model("prova/amodel", "prova", "amodel"), model("provb/bmodel", "provb", "bmodel")],
  };
}

/** The keychain record Ruling E-1 step (2) looks up for `provb`: one record per provider/account (R6-10). */
const PROVB_RECORD = providerCredentialRef({ providerId: "provb", accountId: DEFAULT_PROVIDER_ACCOUNT_ID });

function credentialsWith(seedB: boolean): CredentialStore {
  return createMemoryCredentialStore(seedB ? [[PROVB_RECORD, { kind: "api-key", key: SECRET_B_RECORD }] as const] : []);
}

function sessionConfig(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    sessionId: "fixe-e1",
    cwd: process.cwd(),
    model: "prova/amodel",
    persistSession: false,
    provider: { providerId: "prova", authRef: { kind: "inline", value: SECRET_A } },
    ...over,
  } as RuntimeConfig;
}

async function withTwoFakes(run: (a: Awaited<ReturnType<typeof startRawFake>>, b: Awaited<ReturnType<typeof startRawFake>>) => Promise<void>): Promise<void> {
  const fakeA = await startRawFake();
  const fakeB = await startRawFake();
  try {
    await run(fakeA, fakeB);
  } finally {
    await fakeA.close();
    await fakeB.close();
  }
}

/** Every string that would betray the SESSION's material on another provider's wire. */
function assertNoSessionMaterial(request: RawRequest): void {
  const flat = JSON.stringify(request);
  expect(flat).not.toContain(SECRET_A);
  expect(request.authorization).not.toBe(`Bearer ${SECRET_A}`);
}

// --- the rule, step by step ---------------------------------------------------------------------

describe("Ruling E-1: a target on ANOTHER provider never inherits the session's credential or connection", () => {
  test("(P1a, inverted) an R6-17 child on another provider is built with THAT provider's own keychain record -- the other fake saw B's key and none of A's material", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({ config: sessionConfig(), env: {}, catalog: catalogFor(fakeA.url, fakeB.url), credentials: credentialsWith(true) });
      const resolvedChild = wiring.registry.resolve({ model: "provb/bmodel" });
      if (resolvedChild instanceof WinterProviderResolutionError) throw resolvedChild;

      const material = wiring.describeTargetMaterial(resolvedChild);
      expect(material.crossProvider).toBe(true);
      expect(material.source).toBe("provider-record");
      expect(material.authRef).toEqual(PROVB_RECORD);

      await wiring.buildProvider(resolvedChild).generate({ messages: [{ role: "user", content: "hello from the child" }] });
      expect(fakeA.requests.length).toBe(0);
      expect(fakeB.requests.length).toBe(1);
      expect(fakeB.requests[0]!.path).toBe("/chat/completions");
      expect(fakeB.requests[0]!.authorization).toBe(`Bearer ${SECRET_B_RECORD}`);
      assertNoSessionMaterial(fakeB.requests[0]!);
    });
  });

  test("(P1b, inverted) the classifier route's OWN `authRef` reaches the wire -- never the session's", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({
        config: sessionConfig({ autoClassifier: { model: "provb/bmodel", authRef: { kind: "inline", value: "CLASSIFIER-OWN-SECRET" } } }),
        env: {},
        catalog: catalogFor(fakeA.url, fakeB.url),
        credentials: credentialsWith(false),
      });
      expect(wiring.classifierRoute.kind).toBe("configured");
      expect(wiring.classifier).toBeDefined();
      const envelope = { toolName: "Bash", canonicalToolName: "Bash", input: { command: "ls" }, cwd: process.cwd(), roots: [process.cwd()], resolvedPaths: [], boundaries: {} } as never;
      const context = { autoConfig: {}, classifierContext: [] } as never;
      await wiring.classifier!.classify(envelope, context);
      expect(fakeA.requests.length).toBe(0);
      expect(fakeB.requests.length).toBe(1);
      expect(fakeB.requests[0]!.authorization).toBe("Bearer CLASSIFIER-OWN-SECRET");
      assertNoSessionMaterial(fakeB.requests[0]!);
    });
  });

  test("the advisor's OWN `authRef` (new, mirroring the classifier's) reaches the wire -- never the session's", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({
        config: sessionConfig({ advisor: { model: "provb/bmodel", authRef: { kind: "inline", value: "ADVISOR-OWN-SECRET" } } }),
        env: {},
        catalog: catalogFor(fakeA.url, fakeB.url),
        credentials: credentialsWith(false),
      });
      expect(wiring.advisorProvider).toBeDefined();
      await wiring.advisorProvider!.generate({ messages: [{ role: "user", content: "review this" }] });
      expect(fakeA.requests.length).toBe(0);
      expect(fakeB.requests.length).toBe(1);
      expect(fakeB.requests[0]!.authorization).toBe("Bearer ADVISOR-OWN-SECRET");
      assertNoSessionMaterial(fakeB.requests[0]!);
    });
  });

  test("a cross-provider target with NO route authRef and NO keychain record is a typed `no-credential-for-provider` refusal at its first generation -- nothing is sent anywhere", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({ config: sessionConfig(), env: {}, catalog: catalogFor(fakeA.url, fakeB.url), credentials: credentialsWith(false) });
      const resolvedChild = wiring.registry.resolve({ model: "provb/bmodel" });
      if (resolvedChild instanceof WinterProviderResolutionError) throw resolvedChild;
      let thrown: unknown;
      try {
        await wiring.buildProvider(resolvedChild).generate({ messages: [{ role: "user", content: "x" }] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WinterProviderResolutionError);
      expect((thrown as WinterProviderResolutionError).code).toBe("no-credential-for-provider");
      // The refusal names the provider and the record's LOCATOR, never any material.
      expect(String((thrown as Error).message)).toContain('"provb"');
      expect(String((thrown as Error).message)).not.toContain(SECRET_A);
      expect(fakeA.requests.length).toBe(0);
      expect(fakeB.requests.length).toBe(0);
    });
  });

  test("a cross-provider classifier with no credential of its own fails CLOSED (`no_verdict`/`provider_error`) and sends nothing", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({
        config: sessionConfig({ autoClassifier: { model: "provb/bmodel" } }),
        env: {},
        catalog: catalogFor(fakeA.url, fakeB.url),
        credentials: credentialsWith(false),
      });
      expect(wiring.classifier).toBeDefined();
      const envelope = { toolName: "Bash", canonicalToolName: "Bash", input: { command: "ls" }, cwd: process.cwd(), roots: [process.cwd()], resolvedPaths: [], boundaries: {} } as never;
      const verdict = await wiring.classifier!.classify(envelope, { autoConfig: {}, classifierContext: [] } as never);
      expect(verdict.verdict).toBe("no_verdict");
      expect(verdict.reasonCode).toBe("provider_error");
      expect(fakeA.requests.length).toBe(0);
      expect(fakeB.requests.length).toBe(0);
    });
  });

  test("a cross-provider target reaches its OWN generated endpoint -- never the session's user `baseUrl`, never the session's headers", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({
        config: sessionConfig({
          provider: { providerId: "prova", authRef: { kind: "inline", value: SECRET_A }, connection: { baseUrl: fakeA.url, local: true, headers: { "x-session-only": "must-not-cross" } } },
          advisor: { model: "provb/bmodel", authRef: { kind: "inline", value: "ADVISOR-OWN-SECRET" } },
        }),
        env: {},
        catalog: catalogFor(fakeA.url, fakeB.url),
        credentials: credentialsWith(false),
      });
      const resolvedChild = wiring.registry.resolve({ model: "provb/bmodel" });
      if (resolvedChild instanceof WinterProviderResolutionError) throw resolvedChild;
      const material = wiring.describeTargetMaterial(resolvedChild, { authRef: { kind: "inline", value: "ADVISOR-OWN-SECRET" } });
      expect(material.source).toBe("route");
      expect(material.connection?.baseUrl).toBe(fakeB.url);
      expect(material.connection?.headers).toBeUndefined();

      await wiring.advisorProvider!.generate({ messages: [{ role: "user", content: "review" }] });
      expect(fakeA.requests.length).toBe(0);
      expect(fakeB.requests.length).toBe(1);
      expect(fakeB.requests[0]!.headers["x-session-only"]).toBeUndefined();
      assertNoSessionMaterial(fakeB.requests[0]!);
    });
  });

  // --- Re-review round 1, R-E1: the C-1 class on the REFUSED arm (probe P4) ---------------------

  /** Drives the real engine on a wiring: turn, `set_model`, turn -- and returns what the host saw. */
  async function driveRefusedSession(config: RuntimeConfig, catalog: WinterCatalog, credentials: CredentialStore, setModel: string): Promise<{ ack: { ok: boolean; error?: { code: string; message: string } }; results: Array<Record<string, unknown>> }> {
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials });
    expect(wiring.resolutionError, "the session model must have FAILED to resolve for this fixture").toBeDefined();
    const { host, runtime } = createInMemoryChannel();
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    const done = runEngine({ config, input: runtime.input, output: runtime.output, provider: wiring.provider, tools: stubExecutor, resolveModelSwitch: wiring.resolveModelSwitch } as never);
    const results = () => frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message).filter((m) => m.type === "result") as Array<Record<string, unknown>>;
    const until = async (predicate: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    host.output.write({ type: "user", text: "first" });
    await until(() => results().length === 1, "the first result");
    host.output.write({ type: "control_request", requestId: "sm", subtype: "set_model", payload: { model: setModel } });
    await until(() => frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === "sm"), "the set_model ack");
    host.output.write({ type: "user", text: "second" });
    await until(() => results().length === 2, "the second result");
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await reader;
    await done;
    const ack = frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === "sm") as { ok: boolean; error?: { code: string; message: string } };
    return { ack, results: results() };
  }

  /** A session that names its provider ONLY through its qualified model key and carries a secret -- the wire-reachable shape probe P4 drove (`--config-json` accepts it). */
  const keyOnlySession = (model: string): RuntimeConfig => ({ sessionId: "fixe-p4", cwd: process.cwd(), model, persistSession: false, provider: { authRef: { kind: "inline", value: SECRET_A } } }) as never;

  test("(P4, inverted) a session WITHOUT providerId whose model failed to resolve still has a provider -- its qualified prefix -- so `set_model` to another provider's key is a provider-mismatch refusal and vendor B's fake receives NOTHING", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const catalog = catalogFor(fakeA.url, fakeB.url);
      const wiring = buildSessionProvider({ config: keyOnlySession("prova/never-existed"), env: {}, catalog, credentials: credentialsWith(false) });
      expect(wiring.sessionProviderId()).toBe("prova");
      const resolvedB = wiring.registry.resolve({ model: "provb/bmodel" });
      if (resolvedB instanceof WinterProviderResolutionError) throw resolvedB;
      expect(wiring.describeTargetMaterial(resolvedB).crossProvider).toBe(true);
      const { ack, results } = await driveRefusedSession(keyOnlySession("prova/never-existed"), catalog, credentialsWith(false), "provb/bmodel");
      expect(ack.ok).toBe(false);
      expect(ack.error?.code).toBe("invalid_model");
      expect(ack.error?.message).toContain("provider-mismatch");
      expect(results.map((r) => r.terminal_reason)).toEqual(["api_error", "api_error"]);
      expect(fakeB.requests.length).toBe(0);
      expect(fakeA.requests.length).toBe(0);
    });
  });

  test("(P4, the fail-closed half) a refused session that names NO catalog provider at all treats EVERY target as another provider: `set_model provb/bmodel` resolves, and vendor B gets its OWN record or a typed refusal -- never the session's secret", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const catalog = catalogFor(fakeA.url, fakeB.url);
      // (i) no record for provb: the switch is accepted (the key resolves on its own), the next turn
      //     lands on the typed no-credential refusal, and nothing reaches either fake.
      const wiring = buildSessionProvider({ config: keyOnlySession("nowhere/x"), env: {}, catalog, credentials: credentialsWith(false) });
      expect(wiring.sessionProviderId()).toBeUndefined();
      const resolvedA = wiring.registry.resolve({ model: "prova/amodel" });
      if (resolvedA instanceof WinterProviderResolutionError) throw resolvedA;
      expect(wiring.describeTargetMaterial(resolvedA).crossProvider, "an UNKNOWN session provider fails closed even for the key's own vendor").toBe(true);
      const refused = await driveRefusedSession(keyOnlySession("nowhere/x"), catalog, credentialsWith(false), "provb/bmodel");
      expect(refused.ack.ok).toBe(true);
      expect(String(refused.results[1]!.result)).toContain("no credential is configured for provider \"provb\"");
      expect(String(refused.results[1]!.result)).not.toContain(SECRET_A);
      expect(fakeB.requests.length).toBe(0);
      // (ii) provb's OWN record present: the switched turn goes out under B's key, never the session's.
      const served = await driveRefusedSession(keyOnlySession("nowhere/x"), catalog, credentialsWith(true), "provb/bmodel");
      expect(served.ack.ok).toBe(true);
      expect(served.results[1]!.is_error).toBeFalsy();
      expect(fakeB.requests.length).toBe(1);
      expect(fakeB.requests[0]!.authorization).toBe(`Bearer ${SECRET_B_RECORD}`);
      assertNoSessionMaterial(fakeB.requests[0]!);
      expect(fakeA.requests.length).toBe(0);
    });
  });

  test("CONTROL (P4): with `providerId` configured the refused session's provider is that one -- a foreign key is still a mismatch, and its own key recovers on the session's material", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const catalog = catalogFor(fakeA.url, fakeB.url);
      const mismatch = await driveRefusedSession(sessionConfig({ model: "prova/never-existed" }), catalog, credentialsWith(false), "provb/bmodel");
      expect(mismatch.ack.ok).toBe(false);
      expect(mismatch.ack.error?.message).toContain("provider-mismatch");
      expect(fakeB.requests.length).toBe(0);
      const recovered = await driveRefusedSession(sessionConfig({ model: "prova/never-existed" }), catalog, credentialsWith(false), "prova/amodel");
      expect(recovered.ack.ok).toBe(true);
      expect(recovered.results[1]!.is_error).toBeFalsy();
      expect(fakeA.requests[0]!.authorization).toBe(`Bearer ${SECRET_A}`);
      expect(fakeB.requests.length).toBe(0);
    });
  });

  test("CONTROL: a target on the session's OWN provider keeps the session's material -- the pre-fix same-provider world is unchanged", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const wiring = buildSessionProvider({
        config: sessionConfig({ autoClassifier: { model: "prova/amodel" } }),
        env: {},
        catalog: catalogFor(fakeA.url, fakeB.url),
        credentials: credentialsWith(false),
      });
      const resolved = wiring.registry.resolve({ model: "prova/amodel" });
      if (resolved instanceof WinterProviderResolutionError) throw resolved;
      const material = wiring.describeTargetMaterial(resolved);
      expect(material.crossProvider).toBe(false);
      expect(material.source).toBe("session");
      const envelope = { toolName: "Bash", canonicalToolName: "Bash", input: { command: "ls" }, cwd: process.cwd(), roots: [process.cwd()], resolvedPaths: [], boundaries: {} } as never;
      await wiring.classifier!.classify(envelope, { autoConfig: {}, classifierContext: [] } as never);
      expect(fakeB.requests.length).toBe(0);
      expect(fakeA.requests.length).toBe(1);
      expect(fakeA.requests[0]!.authorization).toBe(`Bearer ${SECRET_A}`);
    });
  });
});

// --- the production child path ------------------------------------------------------------------

describe("Ruling E-1 on the PRODUCTION child seam (`resolveChildProvider`)", () => {
  async function productionWiring(catalog: WinterCatalog, credentials: CredentialStore, over: Partial<RuntimeConfig> = {}) {
    const winterHome = mkdtempSync(join(tmpdir(), "winter-fixe-e1-home-"));
    const wiring = await buildProductionWiring({ config: sessionConfig(over), env: {}, winterHome, provider: { catalog, credentials } });
    return { wiring, dispose: () => { wiring.dispose(); rmSync(winterHome, { recursive: true, force: true }); } };
  }

  test("a cross-provider child WITH the target provider's keychain record runs on it, and its identity reports the CHILD's own credential kind (M-7)", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const { wiring, dispose } = await productionWiring(catalogFor(fakeA.url, fakeB.url), credentialsWith(true));
      try {
        const resolution = await wiring.childFactoryOptions.resolveChildProvider!("provb/bmodel");
        expect(resolution).toBeDefined();
        if (resolution === undefined || "refused" in resolution) throw new Error(`expected a built child provider, got ${JSON.stringify(resolution)}`);
        // The parent authenticated INLINE; the child's material is the KEYCHAIN record. Stamping the
        // parent's kind here was M-7.
        expect(resolution.identity.authRefKind).toBe("keychain");
        expect(resolution.identity.providerId).toBe("provb");
        await resolution.provider.generate({ messages: [{ role: "user", content: "child turn" }] });
        expect(fakeA.requests.length).toBe(0);
        expect(fakeB.requests[0]!.authorization).toBe(`Bearer ${SECRET_B_RECORD}`);
        assertNoSessionMaterial(fakeB.requests[0]!);
      } finally {
        dispose();
      }
    });
  });

  test("a cross-provider child with NO resolvable credential is REFUSED by the seam -- named, and nothing reaches either fake", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const { wiring, dispose } = await productionWiring(catalogFor(fakeA.url, fakeB.url), credentialsWith(false));
      try {
        const resolution = await wiring.childFactoryOptions.resolveChildProvider!("provb/bmodel");
        expect(resolution).toBeDefined();
        if (resolution === undefined || !("refused" in resolution)) throw new Error("expected the refusal");
        expect(resolution.refused.providerId).toBe("provb");
        expect(resolution.refused.modelKey).toBe("provb/bmodel");
        expect(resolution.refused.reason).toContain("never inherits the parent's credential");
        expect(JSON.stringify(resolution)).not.toContain(SECRET_A);
        expect(fakeA.requests.length).toBe(0);
        expect(fakeB.requests.length).toBe(0);
      } finally {
        dispose();
      }
    });
  });

  test("CONTROL: a same-provider child still builds and runs on the session's material, exactly as T10 shipped it", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      const catalog = catalogFor(fakeA.url, fakeB.url);
      catalog.models.push(model("prova/asmall", "prova", "asmall"));
      const { wiring, dispose } = await productionWiring(catalog, credentialsWith(false));
      try {
        const resolution = await wiring.childFactoryOptions.resolveChildProvider!("asmall");
        if (resolution === undefined || "refused" in resolution) throw new Error("expected a built child provider");
        expect(resolution.identity.authRefKind).toBe("inline");
        await resolution.provider.generate({ messages: [{ role: "user", content: "child turn" }] });
        expect(fakeB.requests.length).toBe(0);
        expect(fakeA.requests[0]!.authorization).toBe(`Bearer ${SECRET_A}`);
        expect(fakeA.requests[0]!.body).toContain('"model":"asmall"');
      } finally {
        dispose();
      }
    });
  });
});

// --- the refusal, end to end: stderr line + continuity_warning frame -----------------------------

describe("Ruling E-1: a refused cross-provider child is LOUD -- a stderr line and a `continuity_warning` frame, never the parent's provider silently", () => {
  const SPAWN_PROBE = "fixe_e1_spawn_probe";

  function registerSpawnProbe(): void {
    registerTool({
      descriptor: {
        canonicalName: SPAWN_PROBE, advertisedName: SPAWN_PROBE, source: "builtin", inputSchema: { type: "object" },
        description: "spawns a child and awaits it", exposure: "eager", permissionClass: "read",
        availability: {}, capabilityRequirements: [], disposition: "implement-now",
      },
      executor: {
        async execute(input: unknown, ctx: ToolExecutionContext) {
          if (!ctx.session.spawnChild) return { output: "no spawnChild capability configured", isError: true };
          const handle = await ctx.session.spawnChild(input as SpawnChildRequest);
          const result = await handle.result();
          return { output: JSON.stringify({ status: result.status, content: result.content }) };
        },
      },
    });
  }

  test("the spawn reports the child, the model and the provider on stderr AND on the parent's stream, and the child's first generation is R6-F's refusal -- NO request on the parent's provider, none on any wire (R-E3)", async () => {
    await withTwoFakes(async (fakeA, fakeB) => {
      registerSpawnProbe();
      const winterHome = mkdtempSync(join(tmpdir(), "winter-fixe-e1-spawn-"));
      try {
        const wiring = await buildProductionWiring({ config: sessionConfig(), env: {}, winterHome, provider: { catalog: catalogFor(fakeA.url, fakeB.url), credentials: credentialsWith(false) } });
        const warnings: string[] = [];
        // The parent's provider is a COUNTING double: R-E3's claim is that the refused child never
        // generates on it -- not once.
        const parentGenerations: ProviderRequest[] = [];
        const parentDouble = scriptedProvider([{ kind: "text", text: "the parent's double must never serve the child" }]);
        const parentProvider: Provider = {
          async generate(input) {
            parentGenerations.push(input);
            return parentDouble.generate(input);
          },
        };
        registerChildEngineFactory(
          createChildEngineFactory({
            provider: parentProvider,
            resolveChildProvider: wiring.childFactoryOptions.resolveChildProvider!,
            warn: (line) => warnings.push(line),
          }),
        );
        const req: SpawnChildRequest = {
          parentToolUseId: "call-1",
          prompt: "do the thing",
          runInBackground: false,
          name: "prober",
          definition: { description: "the cross-provider probe", prompt: "you are the probe", model: "provb/bmodel" },
        };
        const { host, runtime } = createInMemoryChannel();
        const done = runEngine({
          config: sessionConfig({ sessionId: "parent-e1", model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, provider: undefined } as never),
          input: runtime.input,
          output: runtime.output,
          provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "call-1", name: SPAWN_PROBE, input: req }] }, { kind: "text", text: "done" }]),
        });
        host.output.write({ type: "user", text: "go" });
        host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
        const frames: WinterFrame[] = [];
        for await (const f of host.input) frames.push(f);
        await done;
        wiring.dispose();

        // (1) the operator's line, naming the child, the model and the provider -- and no material.
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('child agent "prober"');
        expect(warnings[0]).toContain('"provb/bmodel"');
        expect(warnings[0]).toContain('provider "provb"');
        expect(warnings[0]).not.toContain(SECRET_A);
        // (2) the host's frame, on the PARENT's stream.
        const messages = frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
        const warning = messages.find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "continuity_warning") as Record<string, unknown> | undefined;
        expect(warning).toBeDefined();
        expect(warning!.warning).toBe("child_provider_refused");
        expect(String(warning!.detail)).toContain('provider "provb"');
        expect(JSON.stringify(warning)).not.toContain(SECRET_A);
        // (3) the child's first generation was the DEFERRED REFUSAL (R6-F), carrying the typed reason
        //     and naming the provider -- and the parent's own turn still completed around it.
        const toolResult = messages.find((m) => m.type === "user") as { message: { content: Array<{ content?: string }> } } | undefined;
        const rendered = JSON.stringify(toolResult);
        expect(rendered).toContain("no credential is configured for provider");
        expect(rendered).toContain("provb");
        expect(rendered).not.toContain("the parent's double must never serve the child");
        expect(rendered).not.toContain(SECRET_A);
        // (4) the parent's provider served the PARENT's two turns and nothing else: the child never
        //     generated on it, and no fake was ever contacted with anything.
        expect(parentGenerations.length).toBe(0);
        expect(fakeA.requests.length).toBe(0);
        expect(fakeB.requests.length).toBe(0);
      } finally {
        unregisterToolForTest(SPAWN_PROBE);
        resetChildEngineFactoryForTest();
        resetSpawnLimitsForTest();
        rmSync(winterHome, { recursive: true, force: true });
      }
    });
  });
});
