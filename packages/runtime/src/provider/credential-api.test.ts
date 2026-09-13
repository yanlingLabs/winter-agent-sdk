// Phase 6 Task 8 (Lane D, R6-10): the credential host doors.
//
// IN-MEMORY STORES ONLY. Global Constraints: tests never touch `~/.winter`, `~/.norma`, `~/.claude`
// or the Keychain, and `Bun.secrets` is never called under test (`keychain-store.test.ts` holds the
// repo-wide grep tripwire that pins it). Every fixture here drives
// `createMemoryCredentialStore` or a hand-written double.
//
// The redaction assertions are the reason this file is long. "Material is redacted in every thrown
// error" is not provable by reading the implementation, because the STORE these doors are handed can
// be a host's own — so the fixtures hand them stores that deliberately put the secret in their error
// message and assert it does not come back out.
import { test, expect, describe } from "bun:test";
import { createMemoryCredentialStore, createRegistry, CredentialResolutionError, type CredentialMaterial, type CredentialRef, type CredentialStatus, type CredentialStore, type ProviderAdapter, type ProviderContext } from "@yanlinglabs/winter-provider-runtime";
import type { WinterCatalog, WinterModelDescriptor, WinterProviderDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";
import { deleteProviderCredential, providerCredentialRef, startProviderLogin, storeProviderCredential, validateProviderCredential } from "./credential-api.ts";
// BY PACKAGE NAME, as every other runtime test reaches this package (`@yanlinglabs/winter-provider-conformance`
// is a root devDependency). A deep relative path into another workspace's `src/` is the drift its
// barrel exists to prevent, and it is what this file did first.
import { codexFake, startFake, xaiOauthFake } from "@yanlinglabs/winter-provider-conformance";
import { createKeychainCredentialStore, DEFAULT_KEYCHAIN_SERVICE, type SecretsBackend } from "./keychain-store.ts";

const SECRET = "test-key-do-not-use-4d9f2a";

function apiKey(key = SECRET): CredentialMaterial {
  return { kind: "api-key", key };
}

describe("the keychain account spelling (R6-10)", () => {
  test('is exactly "<providerId>:<accountId>"', () => {
    expect(providerCredentialRef({ providerId: "openai", accountId: "work" })).toEqual({ kind: "keychain", account: "openai:work" });
  });

  test("carries an explicit service, and omits the key when there is none", () => {
    expect(providerCredentialRef({ providerId: "openai", accountId: "work", service: "com.winter.core.dev" })).toEqual({
      kind: "keychain",
      account: "openai:work",
      service: "com.winter.core.dev",
    });
    expect("service" in providerCredentialRef({ providerId: "openai", accountId: "work" })).toBe(false);
  });

  test("a hyphenated provider id is fine -- every local provider has one", () => {
    expect(providerCredentialRef({ providerId: "codex-oauth", accountId: "a@b.example" }).account).toBe("codex-oauth:a@b.example");
  });

  test("an accountId MAY contain a colon (read left-to-right at the first one); a providerId may not", () => {
    expect(providerCredentialRef({ providerId: "openai", accountId: "urn:acct:1" }).account).toBe("openai:urn:acct:1");
    expect(() => providerCredentialRef({ providerId: "open:ai", accountId: "work" })).toThrow(/separator/);
  });

  test("blank ids and control characters are refused", () => {
    expect(() => providerCredentialRef({ providerId: "", accountId: "work" })).toThrow(/non-empty providerId/);
    expect(() => providerCredentialRef({ providerId: "openai", accountId: "  " })).toThrow(/non-empty accountId/);
    expect(() => providerCredentialRef({ providerId: "openai", accountId: `work${String.fromCharCode(10)}x` })).toThrow(/control characters/);
    expect(() => providerCredentialRef({ providerId: "openai", accountId: "work", service: " " })).toThrow(/may not be blank/);
  });
});

describe("storeProviderCredential", () => {
  test("writes ONE record per provider/account and answers with the ref that addresses it", async () => {
    const store = createMemoryCredentialStore();
    const first = await storeProviderCredential(store, { providerId: "openai", accountId: "work", material: apiKey() });
    const second = await storeProviderCredential(store, { providerId: "openai", accountId: "personal", material: apiKey("test-key-second") });
    expect(store.size()).toBe(2);
    expect(await store.get(first)).toEqual(apiKey());
    expect(await store.get(second)).toEqual(apiKey("test-key-second"));
  });

  test("the returned ref is the one a session config uses -- it round-trips through get()", async () => {
    const store = createMemoryCredentialStore();
    const ref = await storeProviderCredential(store, { providerId: "anthropic", accountId: "default", material: apiKey() });
    expect(await store.get(ref)).toEqual(apiKey());
  });

  test("an EMPTY secret is refused at the write door, not discovered as a 401 later", async () => {
    const store = createMemoryCredentialStore();
    await expect(storeProviderCredential(store, { providerId: "openai", accountId: "work", material: { kind: "api-key", key: "  " } })).rejects.toThrow(/empty "key"/);
    await expect(storeProviderCredential(store, { providerId: "openai", accountId: "work", material: { kind: "bearer", token: "" } })).rejects.toThrow(/empty "token"/);
    await expect(storeProviderCredential(store, { providerId: "openai", accountId: "work", material: { kind: "oauth", accessToken: "" } })).rejects.toThrow(/empty "accessToken"/);
    await expect(storeProviderCredential(store, { providerId: "bedrock", accountId: "work", material: { kind: "aws", accessKeyId: "AKIA", secretAccessKey: "" } })).rejects.toThrow(/empty "secretAccessKey"/);
    await expect(
      storeProviderCredential(store, { providerId: "vertex", accountId: "work", material: { kind: "gcp-service-account", clientEmail: "a@b.example", privateKeyPem: "", tokenUri: "https://t.example" } }),
    ).rejects.toThrow(/empty "privateKeyPem"/);
    await expect(storeProviderCredential(store, { providerId: "vertex", accountId: "work", material: { kind: "gcp-access-token", token: "" } })).rejects.toThrow(/empty "token"/);
    expect(store.size()).toBe(0);
  });

  test("a rejection for empty material never quotes the material", async () => {
    const store = createMemoryCredentialStore();
    let message = "";
    try {
      await storeProviderCredential(store, { providerId: "vertex", accountId: "work", material: { kind: "gcp-service-account", clientEmail: "svc@p.example", privateKeyPem: "", tokenUri: "https://t.example" } });
    } catch (err) {
      message = (err as Error).message;
    }
    // The FIELD is named; the sibling secret values are not.
    expect(message).toContain("privateKeyPem");
    expect(message).not.toContain("svc@p.example");
    expect(message).not.toContain("https://t.example");
  });
});

describe("deleteProviderCredential", () => {
  test("removes the record the matching store call wrote", async () => {
    const store = createMemoryCredentialStore();
    const ref = await storeProviderCredential(store, { providerId: "openai", accountId: "work", material: apiKey() });
    expect(store.size()).toBe(1);
    expect(await deleteProviderCredential(store, { providerId: "openai", accountId: "work" })).toEqual(ref);
    expect(store.size()).toBe(0);
    expect(await store.get(ref)).toBeNull();
  });

  test("deleting an absent record is not an error", async () => {
    const store = createMemoryCredentialStore();
    await expect(deleteProviderCredential(store, { providerId: "openai", accountId: "never-stored" })).resolves.toEqual({ kind: "keychain", account: "openai:never-stored" });
  });

  test("only the named record goes", async () => {
    const store = createMemoryCredentialStore();
    await storeProviderCredential(store, { providerId: "openai", accountId: "a", material: apiKey("test-key-a") });
    await storeProviderCredential(store, { providerId: "openai", accountId: "b", material: apiKey("test-key-b") });
    await deleteProviderCredential(store, { providerId: "openai", accountId: "a" });
    expect(store.size()).toBe(1);
    expect(await store.get({ kind: "keychain", account: "openai:b" })).toEqual(apiKey("test-key-b"));
  });
});

describe("MATERIAL IS REDACTED IN EVERY THROWN ERROR", () => {
  /** A store whose errors are as hostile as a third-party store's realistically could be. */
  function leakyStore(): CredentialStore {
    return {
      async get(): Promise<CredentialMaterial | null> {
        return null;
      },
      async set(ref, material): Promise<void> {
        throw new Error(`keychain write failed for item ${ref.account}: value was ${JSON.stringify(material)}`);
      },
      async delete(ref): Promise<void> {
        throw new Error(`keychain delete failed for item ${ref.account}, whose stored value is ${SECRET}`);
      },
    };
  }

  test("a store that puts the secret in its own error message does not get it back out of store()", async () => {
    let message = "";
    try {
      await storeProviderCredential(leakyStore(), { providerId: "openai", accountId: "work", material: apiKey() });
    } catch (err) {
      message = `${(err as Error).message}${JSON.stringify(err)}`;
    }
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("value was");
    // What survives is the LOCATOR and the failure class -- what makes the failure actionable.
    expect(message).toContain("keychain(default:openai:work)");
    expect(message).toContain("Error");
  });

  test("...nor out of delete()", async () => {
    let message = "";
    try {
      await deleteProviderCredential(leakyStore(), { providerId: "openai", accountId: "work" });
    } catch (err) {
      message = `${(err as Error).message}${JSON.stringify(err)}`;
    }
    expect(message).not.toContain(SECRET);
    expect(message).toContain("keychain(default:openai:work)");
  });

  test("no `cause` chain carries the original error out either", async () => {
    let caught: unknown;
    try {
      await storeProviderCredential(leakyStore(), { providerId: "openai", accountId: "work", material: apiKey() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialResolutionError);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
  });

  test("a typed store failure keeps its code", async () => {
    const store: CredentialStore = {
      async get() {
        return null;
      },
      async set() {
        throw new CredentialResolutionError("unsupported", "this store does not persist");
      },
      async delete() {},
    };
    await expect(storeProviderCredential(store, { providerId: "openai", accountId: "work", material: apiKey() })).rejects.toMatchObject({ code: "unsupported" });
  });

  test("the leak detector is REAL: the raw store error does contain the secret", async () => {
    // A negative-only assertion passes just as happily when the fixture stopped leaking.
    let raw = "";
    try {
      await leakyStore().set({ kind: "keychain", account: "openai:work" }, apiKey());
    } catch (err) {
      raw = (err as Error).message;
    }
    expect(raw).toContain(SECRET);
  });
});

// -------------------------------------------------------------------------------------------------
// validateProviderCredential
// -------------------------------------------------------------------------------------------------

// WS-13c: `modelFamily`/`canonicalModelId` are DERIVED, never hand-typed into a fixture. The
// pipeline's own `stampFamilyFields` fills them here with NO families, so a fixture row lands in
// `other` carrying the real normaliser's canonical id rather than a second, drifting spelling.
const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

function catalog(
  models: Array<{ key: string; providerId: string; upstreamId: string; aliases?: string[] }>,
  providerId = "fake",
  liveCatalogAuthority: WinterProviderDescriptor["liveCatalogAuthority"] = "partial",
): WinterCatalog {
  const provider: WinterProviderDescriptor = {
    id: providerId,
    displayName: "Fake",
    protocols: ["openai-chat-completions"],
    authKinds: ["api-key"],
    defaultEndpoints: { chat: "https://fake.invalid/v1/chat/completions" },
    modelDiscovery: "openai-models",
    liveCatalogAuthority,
    adapterId: "winter.fake",
    family: "openai",
    upstream: { project: "winter", commit: "", sourcePaths: [] },
    risk: { class: "approved", reasons: [] },
    scope: "llm",
    // WS-13b §1: both fields are REQUIRED on every provider row, so a fixture states its
    // own basis rather than inheriting one — a row-shape change fails HERE, at the fixture.
    pricingBasis: "token",
    admission: { basis: "api-key", citation: "fixture:credential-api", tier: "local" },
  };
  const verified = { source: "official-doc", confidence: "verified" } as const;
  return {
    schemaVersion: 2,
    families: [],
    catalogVersion: "0.0.0-test",
    upstream: { tag: "", tagObject: "", commit: "", extractorVersion: "", overlayVersion: "" },
    providers: [provider],
    models: models.map(
      (m): WinterModelDescriptor => stampRow({
        key: m.key,
        providerId: m.providerId,
        upstreamId: m.upstreamId,
        displayName: m.upstreamId,
        aliases: m.aliases ?? [],
        endpoints: ["chat"],
        inputModalities: { value: ["text"], ...verified },
        outputModalities: { value: ["text"], ...verified },
        toolCalling: { value: "native", ...verified },
        nativeTools: { value: true, ...verified },
        unsupportedParameters: [],
        status: "candidate",
      }),
    ),
  };
}

function fakeAdapter(validate: (ref: CredentialRef) => Promise<CredentialStatus>): ProviderAdapter {
  return {
    id: "winter.fake",
    version: "1.0.0",
    family: "openai",
    protocol: "openai-chat-completions",
    validateCredential: (ref) => validate(ref),
    listModels: async () => ({ models: [], partial: false, cached: false, warnings: [] }),
    streamTurn: async function* () {},
    mapEffort: () => ({ ok: true, value: undefined }),
    capabilities: () => ({ toolCalling: "native", readableState: "none" }),
  };
}

function ctxFor(providerId: string): ProviderContext {
  return { connection: { providerId }, credentials: createMemoryCredentialStore(), authRef: { kind: "none" }, stallTimeoutMs: 1000, log: () => {} };
}

describe("validateProviderCredential", () => {
  test("asks the provider's OWN adapter, and hands it the ref verbatim", async () => {
    const seen: CredentialRef[] = [];
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
    registry.register(
      fakeAdapter(async (ref) => {
        seen.push(ref);
        return { ok: true, accountId: "acct-1", scopes: ["chat"] };
      }),
    );
    const ref: CredentialRef = { kind: "keychain", account: "fake:work" };
    expect(await validateProviderCredential(registry, ref, ctxFor("fake"))).toEqual({ ok: true, accountId: "acct-1", scopes: ["chat"] });
    expect(seen).toEqual([ref]);
  });

  test("resolves through an ALIAS row without a provider prefix", async () => {
    // `listModelInfo` emits alias rows whose `value` is a bare alias -- resolvable only inside a
    // named provider's namespace. A lookup that forgot to name the provider would fall through
    // every row and report "no model resolves", which is why this case has its own fixture.
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m", aliases: ["speedy"] }]));
    let asked = 0;
    registry.register(
      fakeAdapter(async () => {
        asked++;
        return { ok: true };
      }),
    );
    expect((await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("fake"))).ok).toBe(true);
    expect(asked).toBe(1);
  });

  test("`none` is answered here: there is nothing to check, and no live request is made", async () => {
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
    let asked = 0;
    registry.register(
      fakeAdapter(async () => {
        asked++;
        return { ok: true };
      }),
    );
    expect(await validateProviderCredential(registry, { kind: "none" }, ctxFor("fake"))).toEqual({ ok: false, code: "missing", message: 'no credential reference is configured for provider "fake"' });
    expect(asked).toBe(0);
  });

  test("an UNKNOWN provider gets its own message, and no probe is attempted", async () => {
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
    registry.register(fakeAdapter(async () => ({ ok: true })));
    const status = await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("nobody"));
    expect(status).toEqual({ ok: false, code: "unsupported", message: 'no provider "nobody" exists in this build\'s catalog, so no adapter can check env(K)' });
  });

  test("a provider with ZERO catalog rows STILL reaches its adapter -- the local-provider case", async () => {
    // Ten of the twenty-one seed providers are exactly this: every local one ships with no catalog
    // rows because its models live on the user's own machine. A door that stopped at "no rows" would
    // be useless for the providers a host most often helps someone configure.
    const registry = createRegistry(catalog([], "local-thing"));
    let asked = 0;
    registry.register(
      fakeAdapter(async () => {
        asked++;
        return { ok: true, accountId: "local" };
      }),
    );
    expect(await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("local-thing"))).toEqual({ ok: true, accountId: "local" });
    expect(asked).toBe(1);
  });

  test("...but NOT where the live catalog is AUTHORITATIVE -- there an absent model is a fact, not a gap", async () => {
    const registry = createRegistry(catalog([], "strict-thing", "authoritative"));
    let asked = 0;
    registry.register(
      fakeAdapter(async () => {
        asked++;
        return { ok: true };
      }),
    );
    const status = await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("strict-thing"));
    expect(status.ok).toBe(false);
    expect((status as { code: string }).code).toBe("unsupported");
    expect(asked).toBe(0);
  });

  test("a zero-row provider whose adapter is not registered is answered, not thrown", async () => {
    const registry = createRegistry(catalog([], "local-thing"));
    const status = await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("local-thing"));
    expect(status.ok).toBe(false);
    expect((status as { message: string }).message).toContain("no-adapter");
  });

  test("a provider whose adapter is not registered is answered, not thrown", async () => {
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
    const status = await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("fake"));
    expect(status.ok).toBe(false);
    expect((status as { code: string }).code).toBe("unsupported");
    expect((status as { message: string }).message).toContain("no-adapter");
  });

  test("an adapter that THROWS reports UNVERIFIED, never `invalid` -- a bug is not evidence the key is bad", async () => {
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
    registry.register(
      fakeAdapter(async () => {
        throw new TypeError(`cannot read properties of undefined; Authorization: Bearer ${SECRET}`);
      }),
    );
    const status = await validateProviderCredential(registry, { kind: "inline", value: SECRET }, ctxFor("fake"));
    expect(status.ok).toBe(false);
    expect((status as { code: string }).code).toBe("unsupported");
    const message = (status as { message: string }).message;
    expect(message).toContain("UNVERIFIED");
    expect(message).toContain("TypeError");
    // The ref is rendered redacted -- `inline` is the one arm carrying live material.
    expect(message).toContain("inline(***)");
    expect(message).not.toContain(SECRET);
  });

  test("a typed credential failure maps onto the status vocabulary", async () => {
    const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
    const cases: Array<{ code: "malformed" | "io" | "unsupported"; expect: string }> = [
      { code: "malformed", expect: "invalid" },
      { code: "io", expect: "network" },
      { code: "unsupported", expect: "unsupported" },
    ];
    for (const c of cases) {
      const registry2 = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
      registry2.register(
        fakeAdapter(async () => {
          throw new CredentialResolutionError(c.code, `boom with ${SECRET}`);
        }),
      );
      const status = await validateProviderCredential(registry2, { kind: "env", name: "K" }, ctxFor("fake"));
      expect((status as { code: string }).code).toBe(c.expect);
      expect((status as { message: string }).message).not.toContain(SECRET);
    }
    void registry;
  });

  test("never throws, whatever the adapter does", async () => {
    for (const thrown of [new Error("x"), "a string", null, undefined, { weird: true }]) {
      const registry = createRegistry(catalog([{ key: "fake/m", providerId: "fake", upstreamId: "m" }]));
      registry.register(
        fakeAdapter(async () => {
          throw thrown;
        }),
      );
      const status = await validateProviderCredential(registry, { kind: "env", name: "K" }, ctxFor("fake"));
      expect(status.ok).toBe(false);
    }
  });
});

describe("over the REAL Keychain store shape, with an injected secrets double", () => {
  // The dispatch names this fixture specifically, and it asserts something the memory store cannot:
  // that the doors line up with the store a production session actually builds
  // (`createKeychainCredentialStore`) -- its JSON encoding, its service defaulting, and its typed
  // failures. The real secrets API is NEVER exercised (see keychain-store.ts's header and the
  // repo-wide grep tripwire in its test): the backend is a double, and the "keychain" here is a Map.
  function fakeSecrets(): SecretsBackend & { records: Map<string, string> } {
    const records = new Map<string, string>();
    return {
      records,
      async get({ service, name }) {
        return records.get(`${service} ${name}`) ?? null;
      },
      async set({ service, name, value }) {
        records.set(`${service} ${name}`, value);
      },
      async delete({ service, name }) {
        return records.delete(`${service} ${name}`);
      },
    };
  }

  test("a stored credential lands under the DEFAULT service at the R6-10 account name, and reads back", async () => {
    const secrets = fakeSecrets();
    const store = createKeychainCredentialStore(DEFAULT_KEYCHAIN_SERVICE, { secrets });
    const ref = await storeProviderCredential(store, { providerId: "anthropic", accountId: "work", material: apiKey() });
    expect([...secrets.records.keys()]).toEqual([`${DEFAULT_KEYCHAIN_SERVICE} anthropic:work`]);
    expect(await store.get(ref)).toEqual(apiKey());
    await deleteProviderCredential(store, { providerId: "anthropic", accountId: "work" });
    expect(secrets.records.size).toBe(0);
  });

  test("an explicit service on the ref wins over the store's default", async () => {
    const secrets = fakeSecrets();
    const store = createKeychainCredentialStore(DEFAULT_KEYCHAIN_SERVICE, { secrets });
    await storeProviderCredential(store, { providerId: "anthropic", accountId: "work", material: apiKey(), service: "com.winter.core.dev" });
    expect([...secrets.records.keys()]).toEqual(["com.winter.core.dev anthropic:work"]);
  });

  test("two accounts on one provider are two records -- the whole reason R6-10 keys by provider AND account", async () => {
    const secrets = fakeSecrets();
    const store = createKeychainCredentialStore(DEFAULT_KEYCHAIN_SERVICE, { secrets });
    await storeProviderCredential(store, { providerId: "anthropic", accountId: "work", material: apiKey("test-key-work") });
    await storeProviderCredential(store, { providerId: "anthropic", accountId: "personal", material: apiKey("test-key-personal") });
    expect(secrets.records.size).toBe(2);
    expect(await store.get({ kind: "keychain", account: "anthropic:work" })).toEqual(apiKey("test-key-work"));
    expect(await store.get({ kind: "keychain", account: "anthropic:personal" })).toEqual(apiKey("test-key-personal"));
  });

  test("a backend that throws with the secret in its message does not leak it through the door", async () => {
    const store = createKeychainCredentialStore(DEFAULT_KEYCHAIN_SERVICE, {
      secrets: {
        async get() {
          return null;
        },
        async set({ value }) {
          throw new Error(`SecKeychainItemCreate failed for value ${value}`);
        },
        async delete() {
          return true;
        },
      },
    });
    let message = "";
    try {
      await storeProviderCredential(store, { providerId: "anthropic", accountId: "work", material: apiKey() });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(SECRET);
    expect(message).toContain("keychain(default:anthropic:work)");
  });
});

describe("startProviderLogin (WS-13b): the ONE host door onto every OAuth flow", () => {
  // The union exists in full NOW, ahead of two of its four flows, on purpose: a host that wants to
  // offer sign-in for all four should compile against one door rather than discover a second one
  // later, and a case that throws a TYPED refusal is a far better thing to ship than a case that is
  // absent from the type and fails at the call site as `never`.
  test("`anthropic` answers with its TYPED refusal (P10a-1) when the broker wiring is missing -- Console OAuth is host-brokered THROUGH Anthropic's own `ant` binary, never an OAuth exchange this SDK runs itself", async () => {
    const store = createMemoryCredentialStore();
    let openUrlCalls = 0;
    const outcome: unknown = await startProviderLogin("anthropic", store, {
      openUrl: async () => {
        openUrlCalls += 1;
      },
    }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(CredentialResolutionError);
    expect((outcome as CredentialResolutionError).code).toBe("console_login_is_host_brokered");
    // Lane S round 2: gated on what the broker actually needs (anthropicConfigDir, readConsoleCode)
    // -- NEVER on claudeExecutable/claudeConfigDir, which the broker no longer reads at all.
    expect((outcome as Error).message).toContain("anthropicConfigDir");
    expect((outcome as Error).message).toContain("readConsoleCode");
    expect((outcome as Error).message).not.toContain("claude");
    // No browser opened and no record written -- a refusal that had done either would be worse than
    // one that never started.
    expect(openUrlCalls).toBe(0);
    expect(store.size()).toBe(0);
  });

  test("`anthropic` (Lane S round 2): a missing `antExecutable` alone is NOT this door's own gate -- it reaches the broker, which refuses BEFORE any spawn with its own typed reason", async () => {
    // anthropicConfigDir + readConsoleCode are both present, so this door's OWN gate passes; the
    // refusal must come from `startAnthropicConsoleBrokerLogin` itself (via `handle.done`), never a
    // duplicated message here -- proving this file does not reproduce that wording.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const anthropicConfigDir = mkdtempSync(join(tmpdir(), "winter-credential-api-noant-"));
    try {
      const store = createMemoryCredentialStore();
      let openUrlCalls = 0;
      const outcome: unknown = await startProviderLogin("anthropic", store, {
        openUrl: async () => {
          openUrlCalls += 1;
        },
        anthropicConfigDir,
        readConsoleCode: async () => "unused",
      }).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(Error);
      // The broker's OWN wording (console-broker.ts), named by the missing binary -- not this file's.
      expect((outcome as Error).message).toContain('"ant"');
      expect((outcome as Error).message).not.toContain("claude");
      expect(openUrlCalls).toBe(0);
      expect(store.size()).toBe(0);
    } finally {
      rmSync(anthropicConfigDir, { recursive: true, force: true });
    }
  });

  test("`anthropic` (Lane S round 3): with the `ant` broker fully wired, this door spawns the real `ant` stub, awaits `readConsoleCode`, and answers with the `anthropic:console` ref -- NEVER `anthropic:default`, and NO claude executable is built or supplied", async () => {
    // A real executable `ant` stub under mkdtemp, exactly like `console-broker.test.ts`'s own
    // fixtures -- this test proves the WIRING (this file's fields reach
    // `startAnthropicConsoleBrokerLogin` correctly), not the broker's own behaviour, which that file
    // already covers exhaustively. Lane S round 2: no `claudeExecutable` is passed at all -- the
    // login succeeds without it, which is the whole point.
    const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const expectedCode = "test-code-credential-api-9f2a";
    const anthropicConfigDir = mkdtempSync(join(tmpdir(), "winter-credential-api-anthropic-"));
    const binDir = mkdtempSync(join(tmpdir(), "winter-credential-api-bin-"));
    try {
      const antExecutable = join(binDir, "ant");
      writeFileSync(
        antExecutable,
        [
          "#!/bin/sh",
          `case "$2" in`,
          `login)`,
          `  echo "Open this URL to continue: https://platform.claude.com/oauth/authorize?client_id=abc&code=${expectedCode}"`,
          `  read -r pasted`,
          `  if [ "$pasted" = "${expectedCode}" ]; then`,
          '    mkdir -p "$ANTHROPIC_CONFIG_DIR/credentials"',
          '    printf \'{"expires_at":1999999999999}\' > "$ANTHROPIC_CONFIG_DIR/credentials/winter.json"',
          "    exit 0",
          "  else",
          '    echo "refused" >&2',
          "    exit 2",
          "  fi",
          "  ;;",
          `print-credentials)`,
          `  echo "fake-bearer-token"`,
          "  ;;",
          "esac",
        ].join("\n") + "\n",
        "utf8",
      );
      chmodSync(antExecutable, 0o755);

      const store = createMemoryCredentialStore();
      // Lane S round 3 (Opus review, data-loss fix): a pre-seeded API key at `anthropic:default`
      // must survive this login untouched -- the exact defect this round fixes.
      const apiKeyRef = providerCredentialRef({ providerId: "anthropic", accountId: "default" });
      const apiKeyMaterial = { kind: "api-key" as const, key: "sk-ant-api03-user-pasted-key-do-not-touch" };
      await store.set(apiKeyRef, apiKeyMaterial);
      const progressLines: string[] = [];
      const result = await startProviderLogin("anthropic", store, {
        openUrl: async () => {
          throw new Error("this flow never opens a browser -- it prints a URL through the progress channel instead");
        },
        antExecutable,
        anthropicConfigDir,
        readConsoleCode: async () => expectedCode,
        onAuthStatus: (status) => progressLines.push(...(status.output ?? [])),
      });

      expect(result.ref).toEqual(providerCredentialRef({ providerId: "anthropic", accountId: "console" }));
      expect(result.accountId).toBe("console");
      expect(result.expiresAt).toBe(1999999999999);
      expect(await store.get(result.ref)).toEqual({ kind: "bearer", token: "fake-bearer-token", expiresAt: 1999999999999 });
      // The pre-seeded API key is byte-identical -- never overwritten by the console login.
      expect(await store.get(apiKeyRef)).toEqual(apiKeyMaterial);
      // The URL reached the host over the PROGRESS channel, redacted -- never through `openUrl`.
      expect(progressLines.some((l) => l.includes("https://platform.claude.com/oauth/authorize?…"))).toBe(true);
      expect(progressLines.join("\n")).not.toContain(expectedCode);
    } finally {
      rmSync(anthropicConfigDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("`anthropic` (fix round 1, item 2, MAJOR; Lane S round 2: ant-only): a child that exits BEFORE a code arrives settles immediately -- `readConsoleCode` is never awaited to completion", async () => {
    // The stub refuses before printing any prompt at all. `readConsoleCode` below NEVER resolves --
    // if this door awaited it unconditionally (the pre-fix shape), this test would hang forever
    // rather than fail; racing it against `handle.done` is what lets it resolve at all. Lane S
    // round 2: the stub is named/shaped `ant` -- NO claude executable is built or supplied.
    const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const anthropicConfigDir = mkdtempSync(join(tmpdir(), "winter-credential-api-race-anthropic-"));
    const binDir = mkdtempSync(join(tmpdir(), "winter-credential-api-race-bin-"));
    try {
      const antExecutable = join(binDir, "ant");
      writeFileSync(antExecutable, '#!/bin/sh\necho "refused before any prompt" >&2\nexit 2\n', "utf8");
      chmodSync(antExecutable, 0o755);

      const store = createMemoryCredentialStore();
      let readConsoleCodeCalled = false;
      const outcome: unknown = await startProviderLogin("anthropic", store, {
        openUrl: async () => {
          throw new Error("this flow never opens a browser");
        },
        antExecutable,
        anthropicConfigDir,
        readConsoleCode: async () => {
          readConsoleCodeCalled = true;
          return await new Promise<string>(() => {}); // never resolves
        },
      }).catch((e: unknown) => e);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("refused before any prompt");
      expect((outcome as Error).message).not.toContain("claude");
      // `readConsoleCode` MAY have been called (the race starts both sides), but its own promise
      // never had to settle for `startProviderLogin` to resolve -- that is the property under test.
      expect(readConsoleCodeCalled).toBe(true);
      expect(store.size()).toBe(0);
    } finally {
      rmSync(anthropicConfigDir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("`codex-oauth` still routes to its own flow — adding a provider did not move an existing one", async () => {
    const fake = await startFake({ routes: [codexFake.codexTokenRoute({})] });
    try {
      const store = createMemoryCredentialStore();
      const result = await startProviderLogin("codex-oauth", store, {
        openUrl: async (url) => {
          const authorize = new URL(url);
          const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
          callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
          callback.searchParams.set("code", "test-code-authorization");
          await fetch(callback.toString()).catch(() => undefined);
        },
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: `${fake.url}/oauth/token`,
        callbackPort: 0,
      });
      expect(result.ref.account).toBe(`codex-oauth:${codexFake.FAKE_ACCOUNT_ID}`);
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("`xai-oauth` routes to the device flow — THROUGH THIS DOOR, and pointed at a fixture rather than at xAI", async () => {
    // POINTED AT A FAKE, and that is the point of the test rather than a detail of it. Before this
    // case was wired, the refusal below covered `xai-oauth` too and needed no endpoint; wiring the
    // case without also giving the call a `deviceCodeUrl` turns THIS LINE into a live request to
    // `auth.x.ai` — the review measured exactly that: a real HTTP 200 from the vendor's device
    // endpoint, then a poll against the production token endpoint until the test's own timeout.
    // `deviceCodeUrl`/`pollIntervalMs` exist on the options for this reason.
    //
    // `openUrl` is supplied and MUST NOT BE CALLED: RFC 8628 has no browser leg, and a device flow
    // that opened one would be a different flow than the one this row ships.
    const fake = await xaiOauthFake.startXaiOauthFake();
    try {
      const store = createMemoryCredentialStore();
      let openUrlCalls = 0;
      const result = await startProviderLogin("xai-oauth", store, {
        openUrl: async () => {
          openUrlCalls += 1;
        },
        deviceCodeUrl: fake.deviceCodeUrl,
        tokenUrl: fake.tokenUrl,
        pollIntervalMs: 5,
      });
      expect(result.ref.account).toBe("xai-oauth:acct-x");
      expect((await store.get(result.ref))?.kind).toBe("oauth");
      expect(openUrlCalls).toBe(0);
      // The door did not quietly lose the honest identity on its way through.
      for (const req of fake.requests) expect(new URLSearchParams(req.body).get("referrer")).toBe("winter-agent-sdk");
      // Every request went to the fixture; none reached a vendor.
      expect(fake.requests.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  }, 15_000);

  test("`qoder` is a TYPED refusal, not a crash and not a silent no-op", async () => {
    // `qoder` ALONE now. Lane O's capture established that Qoder documents no third-party OAuth
    // grant and no inference endpoint, so this row is carried rather than shipped — the refusal is
    // this id's correct end state, not a placeholder waiting on a flow.
    const store = createMemoryCredentialStore();
    const outcome: unknown = await startProviderLogin("qoder", store, { openUrl: async () => {} }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(CredentialResolutionError);
    expect((outcome as CredentialResolutionError).code).toBe("unsupported");
    expect((outcome as Error).message).toContain("qoder");
    // Nothing was opened, nothing was stored: a refusal that had already run half a flow would be
    // worse than one that never started.
    expect(store.size()).toBe(0);
  });
});
