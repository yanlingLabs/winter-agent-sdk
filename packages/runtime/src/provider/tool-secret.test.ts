// A TOOL's secret: JSON api-key material, a BARE key string, a missing item, and everything that is
// neither -- each as a VALUE, none as a throw, and never with the secret in a message.
import { describe, expect, test } from "bun:test";
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";
import { CredentialResolutionError, createMemoryCredentialStore, type CredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createKeychainSecretReader, type SecretsBackend } from "./keychain-store.ts";
import { createToolSecretResolver, interpretToolSecret } from "./tool-secret.ts";
import { buildSessionProvider } from "./session-provider.ts";

const SECRET = "exa-3f9c1b7e-THE-SECRET-VALUE";
const REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "exa", service: "com.example.throwaway" };

/** A keychain double. `items` is keyed `<service> <name>`; `reads` proves how many times the backend was touched. */
function fakeSecrets(items: Record<string, string>, opts: { failWith?: Error } = {}): SecretsBackend & { reads: Array<{ service: string; name: string }> } {
  const reads: Array<{ service: string; name: string }> = [];
  return {
    reads,
    async get(o) {
      reads.push(o);
      if (opts.failWith !== undefined) throw opts.failWith;
      return items[`${o.service} ${o.name}`] ?? null;
    },
    async set() {},
    async delete() {},
  };
}

function resolverOver(items: Record<string, string>, opts: { failWith?: Error } = {}) {
  const secrets = fakeSecrets(items, opts);
  const resolve = createToolSecretResolver({ credentials: createMemoryCredentialStore(), readKeychainSecret: createKeychainSecretReader("com.example.session-default", { secrets }) });
  return { resolve, secrets };
}

describe("resolveToolSecret -- the keychain item may be JSON material OR a bare key", () => {
  test("JSON `api-key` credential material yields its key", async () => {
    const { resolve } = resolverOver({ "com.example.throwaway exa": JSON.stringify({ kind: "api-key", key: SECRET }) });
    expect(await resolve(REF)).toEqual({ status: "found", key: SECRET });
  });

  test("a BARE, non-JSON string IS the key (trimmed) -- the format another client of the slot depends on", async () => {
    const { resolve, secrets } = resolverOver({ "com.example.throwaway exa": `  ${SECRET}\n` });
    expect(await resolve(REF)).toEqual({ status: "found", key: SECRET });
    // ONE keychain access: every access can raise an OS consent prompt, so "try the store, then the
    // raw reader" would double them.
    expect(secrets.reads).toEqual([{ service: "com.example.throwaway", name: "exa" }]);
  });

  test("the ref's own `service` wins; without one the session's service is used", async () => {
    const { resolve, secrets } = resolverOver({ "com.example.session-default exa": SECRET });
    expect(await resolve({ kind: "keychain", account: "exa" })).toEqual({ status: "found", key: SECRET });
    expect(secrets.reads[0]).toEqual({ service: "com.example.session-default", name: "exa" });
  });

  test("a missing item, an empty item and `{kind:\"none\"}` are all `missing` -- never a throw", async () => {
    const { resolve } = resolverOver({ "com.example.throwaway blank": "   " });
    expect(await resolve(REF)).toEqual({ status: "missing" });
    expect(await resolve({ ...REF, account: "blank" })).toEqual({ status: "missing" });
    expect(await resolve({ kind: "none" })).toEqual({ status: "missing" });
  });

  test("structured JSON that is NOT an api key is `unreadable/malformed`, names the redacted ref, and never quotes the record", async () => {
    const oauth = JSON.stringify({ kind: "oauth", accessToken: SECRET });
    const { resolve } = resolverOver({ "com.example.throwaway exa": oauth });
    const result = await resolve(REF);
    expect(result.status).toBe("unreadable");
    if (result.status !== "unreadable") throw new Error("unreachable");
    expect(result.code).toBe("malformed");
    expect(result.message).toContain("keychain(com.example.throwaway:exa)");
    expect(result.message).toContain('"oauth"');
    expect(result.message).not.toContain(SECRET);
  });

  test("a keychain failure is `unreadable/io`; the backend's own message (which may quote the item) is withheld", async () => {
    const { resolve } = resolverOver({}, { failWith: new Error(`could not decrypt item with value ${SECRET}`) });
    const result = await resolve(REF);
    expect(result).toMatchObject({ status: "unreadable", code: "io" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).toContain("keychain(com.example.throwaway:exa)");
  });
});

describe("resolveToolSecret -- non-keychain refs go through the credential store", () => {
  const store = createMemoryCredentialStore([[REF, { kind: "api-key", key: SECRET }] as const]);

  test("an inline ref resolves, and is REDACTED wherever it is rendered", async () => {
    const resolve = createToolSecretResolver({ credentials: store });
    expect(await resolve({ kind: "inline", value: SECRET })).toEqual({ status: "found", key: SECRET });
    expect(await resolve({ kind: "inline", value: "" })).toEqual({ status: "missing" });
  });

  test("with NO raw reader a keychain ref is served by the injected store alone (the test-isolation arm)", async () => {
    const resolve = createToolSecretResolver({ credentials: store });
    expect(await resolve(REF)).toEqual({ status: "found", key: SECRET });
    expect(await resolve({ ...REF, account: "absent" })).toEqual({ status: "missing" });
  });

  test("non-api-key material and a store that throws are both values, not throws", async () => {
    const bearer = createMemoryCredentialStore([[REF, { kind: "bearer", token: SECRET }] as const]);
    const asBearer = await createToolSecretResolver({ credentials: bearer })(REF);
    expect(asBearer).toMatchObject({ status: "unreadable", code: "malformed" });
    expect(JSON.stringify(asBearer)).not.toContain(SECRET);

    const throwing: CredentialStore = {
      async get() {
        throw new CredentialResolutionError("malformed", `record ${SECRET} is not JSON`);
      },
      async set() {},
      async delete() {},
    };
    const refused = await createToolSecretResolver({ credentials: throwing })(REF);
    expect(refused).toMatchObject({ status: "unreadable", code: "malformed" });
    expect(JSON.stringify(refused)).not.toContain(SECRET);

    // An unsupported ref kind (the memory store serves no `env` refs) is typed too.
    expect(await createToolSecretResolver({ credentials: store })({ kind: "env", name: "WINTER_TEST_NOPE" })).toMatchObject({ status: "unreadable", code: "unsupported" });
  });
});

describe("interpretToolSecret", () => {
  test("a JSON-encoded string is unwrapped; a digits-only key (valid JSON number) is still the key", () => {
    expect(interpretToolSecret(JSON.stringify(SECRET), "loc")).toEqual({ status: "found", key: SECRET });
    expect(interpretToolSecret("1234567890", "loc")).toEqual({ status: "found", key: "1234567890" });
    expect(interpretToolSecret("[1,2]", "loc")).toMatchObject({ status: "unreadable", code: "malformed" });
    expect(interpretToolSecret(JSON.stringify({ kind: "api-key", key: " " }), "loc")).toEqual({ status: "missing" });
  });
});

describe("interpretToolSecret never quotes STORED CONTENT, and never sends a broken blob as the key", () => {
  test("an unknown `kind` is stored content -- it may BE the secret -- so it is never quoted; a KNOWN kind still is", () => {
    const leaky = interpretToolSecret(JSON.stringify({ kind: "sk-live-THE-SECRET-IN-THE-KIND-FIELD" }), "loc");
    expect(leaky).toMatchObject({ status: "unreadable", code: "malformed" });
    expect(JSON.stringify(leaky)).not.toContain("sk-live");
    expect(JSON.stringify(leaky)).toContain("structured JSON");
    expect(JSON.stringify(interpretToolSecret(JSON.stringify({ kind: "oauth", accessToken: "x" }), "loc"))).toContain("oauth");
  });

  test("a value that LOOKS structured but does not parse is refused -- never sent whole as `x-api-key`", () => {
    for (const broken of ['{"kind":"api-key","key":"k"} trailing', "{broken", "[1,2", '  {"kind":"api-key"  ']) {
      const result = interpretToolSecret(broken, "loc");
      expect([broken, result.status]).toEqual([broken, "unreadable"]);
      expect(JSON.stringify(result)).not.toContain("trailing");
    }
  });

  test("a raw key containing whitespace is refused (a header value cannot carry it, and it is far likelier a pasted sentence than a key)", () => {
    expect(interpretToolSecret("my key is abc123", "loc")).toMatchObject({ status: "unreadable", code: "malformed" });
    expect(interpretToolSecret("abc\tdef", "loc")).toMatchObject({ status: "unreadable", code: "malformed" });
    expect(JSON.stringify(interpretToolSecret("my key is abc123", "loc"))).not.toContain("abc123");
    // ...while leading/trailing whitespace is still just trimmed.
    expect(interpretToolSecret("  abc123\n", "loc")).toEqual({ status: "found", key: "abc123" });
  });

  test("the JSON literals are not keys: `null` is MISSING, `true`/`false` are unreadable; a digits-only key still is one", () => {
    expect(interpretToolSecret("null", "loc")).toEqual({ status: "missing" });
    expect(interpretToolSecret("true", "loc")).toMatchObject({ status: "unreadable" });
    expect(interpretToolSecret("false", "loc")).toMatchObject({ status: "unreadable" });
    expect(interpretToolSecret("1234567890", "loc")).toEqual({ status: "found", key: "1234567890" });
    // A JSON-encoded string is held to the same rule as a bare one.
    expect(interpretToolSecret(JSON.stringify("has space"), "loc")).toMatchObject({ status: "unreadable" });
  });
});

describe("the session wiring exposes it on every arm, and never reaches the real keychain beside an injected store", () => {
  test("a reserved-namespace session (no catalog identity) still resolves a tool secret from the injected store", async () => {
    const wiring = buildSessionProvider({
      config: { sessionId: "s", cwd: process.cwd(), model: "winter-test/echo", persistSession: false } as never,
      env: {},
      credentials: createMemoryCredentialStore([[REF, { kind: "api-key", key: SECRET }] as const]),
    });
    expect(wiring.resolveAuxiliaryModel).toBeUndefined();
    expect(await wiring.resolveToolSecret(REF)).toEqual({ status: "found", key: SECRET });
    // A bare-string item cannot exist in an injected material store, so `missing` -- and crucially
    // NOT a read of the developer's login keychain -- is the answer for an unknown account.
    expect(await wiring.resolveToolSecret({ kind: "keychain", account: "not-seeded" })).toEqual({ status: "missing" });
  });

  test("an injected raw reader is honoured (the production shape, over a fake backend)", async () => {
    const secrets = fakeSecrets({ "com.example.throwaway exa": SECRET });
    const wiring = buildSessionProvider({
      config: { sessionId: "s", cwd: process.cwd(), model: "winter-test/echo", persistSession: false } as never,
      env: {},
      credentials: createMemoryCredentialStore(),
      readKeychainSecret: createKeychainSecretReader("com.example.session-default", { secrets }),
    });
    expect(await wiring.resolveToolSecret(REF)).toEqual({ status: "found", key: SECRET });
  });
});
