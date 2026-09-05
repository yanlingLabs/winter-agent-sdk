// Phase 6 Task 3 (R6-10): the Keychain store, against an INJECTED double -- and the repo-wide grep
// tripwire that keeps it that way.
//
// The real `Bun.secrets` path is never exercised here, and it never can be by accident: every
// fixture injects a backend, and the tripwire at the bottom of this file greps every `.ts` under
// `packages/` for the API name. The controller proves the real darwin path once, locally, against a
// throwaway service name it deletes in `finally` -- that is the only place it is ever touched.
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CredentialResolutionError } from "@yanlinglabs/winter-provider-runtime";
import { createKeychainCredentialStore, keychainAccountName, DEFAULT_KEYCHAIN_SERVICE, type SecretsBackend } from "./keychain-store.ts";

const SECRET = "sk-fixture-value-never-real";

function fakeBackend(initial: Record<string, string> = {}): SecretsBackend & { rows: Map<string, string>; calls: Array<{ op: string; service: string; name: string }> } {
  const rows = new Map(Object.entries(initial));
  const calls: Array<{ op: string; service: string; name: string }> = [];
  return {
    rows,
    calls,
    async get({ service, name }) {
      calls.push({ op: "get", service, name });
      return rows.get(`${service}|${name}`) ?? null;
    },
    async set({ service, name, value }) {
      calls.push({ op: "set", service, name });
      rows.set(`${service}|${name}`, value);
    },
    async delete({ service, name }) {
      calls.push({ op: "delete", service, name });
      return rows.delete(`${service}|${name}`);
    },
  };
}

describe("the keychain store's own behaviour", () => {
  test("account naming is `<providerId>:<accountId>` -- one record per provider/account", () => {
    // The point of the shape: a single fixed secret name cannot hold two accounts on one provider,
    // nor two providers at once, which is exactly what a per-provider layer needs.
    expect(keychainAccountName("openai", "work")).toBe("openai:work");
    expect(DEFAULT_KEYCHAIN_SERVICE).toBe("com.winter.core");
  });

  test("a round trip stores JSON material and reads it back structurally", async () => {
    const backend = fakeBackend();
    const store = createKeychainCredentialStore(DEFAULT_KEYCHAIN_SERVICE, { secrets: backend });
    const ref = { kind: "keychain", account: keychainAccountName("openai", "work") } as const;
    await store.set(ref, { kind: "api-key", key: SECRET });
    expect(await store.get(ref)).toEqual({ kind: "api-key", key: SECRET });
    expect(backend.calls.map((c) => c.op)).toEqual(["set", "get"]);
    expect(backend.calls[0]!.service).toBe("com.winter.core");
    expect(backend.calls[0]!.name).toBe("openai:work");
  });

  test("a ref's own `service` overrides the store default (the dev profile's `com.winter.core.dev`)", async () => {
    const backend = fakeBackend();
    const store = createKeychainCredentialStore(DEFAULT_KEYCHAIN_SERVICE, { secrets: backend });
    await store.set({ kind: "keychain", account: "openai:work", service: "com.winter.core.dev" }, { kind: "bearer", token: SECRET });
    expect(backend.calls[0]!.service).toBe("com.winter.core.dev");
  });

  test("every material kind round-trips, and an unknown shape is a TYPED malformed error", async () => {
    const backend = fakeBackend();
    const store = createKeychainCredentialStore("svc", { secrets: backend });
    const materials = [
      { kind: "api-key", key: SECRET },
      { kind: "bearer", token: SECRET },
      { kind: "oauth", accessToken: SECRET, refreshToken: "r", expiresAt: 1, accountId: "a" },
      { kind: "aws", accessKeyId: "AKIA", secretAccessKey: SECRET, sessionToken: "t" },
      { kind: "gcp-service-account", clientEmail: "a@b", privateKeyPem: SECRET, tokenUri: "https://x" },
      { kind: "gcp-access-token", token: SECRET },
    ] as const;
    for (const material of materials) {
      const ref = { kind: "keychain", account: `p:${material.kind}` } as const;
      await store.set(ref, material);
      expect(await store.get(ref)).toEqual(material);
    }

    backend.rows.set("svc|p:bogus", JSON.stringify({ kind: "not-a-kind", key: "x" }));
    await expect(store.get({ kind: "keychain", account: "p:bogus" })).rejects.toBeInstanceOf(CredentialResolutionError);
  });

  test("an absent record is `null`, and a ref this store does not OWN is `null` too", async () => {
    // A composite store tries each member in turn; a member that threw on someone else's ref kind
    // would break the composition rather than defer to the next one.
    const store = createKeychainCredentialStore("svc", { secrets: fakeBackend() });
    expect(await store.get({ kind: "keychain", account: "absent" })).toBeNull();
    expect(await store.get({ kind: "env", name: "SOME_KEY" })).toBeNull();
    expect(await store.get({ kind: "inline", value: SECRET })).toBeNull();
    expect(await store.get({ kind: "none" })).toBeNull();
  });

  test("NO error message ever contains the stored value, or the backend's own message", async () => {
    // A keychain error can quote the item it failed on, and these strings reach a log and a frame.
    const backend = fakeBackend();
    backend.rows.set("svc|p:malformed", `{not json ${SECRET}`);
    const store = createKeychainCredentialStore("svc", { secrets: backend });
    const parseErr = (await store.get({ kind: "keychain", account: "p:malformed" }).catch((e: unknown) => e)) as Error;
    expect(parseErr.message).not.toContain(SECRET);
    expect(parseErr.message).toContain("keychain");

    const throwing = createKeychainCredentialStore("svc", {
      secrets: {
        async get() {
          throw new Error(`SecItemCopyMatching failed for value ${SECRET}`);
        },
        async set() {
          throw new Error(`SecItemAdd failed for value ${SECRET}`);
        },
        async delete() {
          throw new Error(`SecItemDelete failed for value ${SECRET}`);
        },
      },
    });
    for (const op of [
      () => throwing.get({ kind: "keychain", account: "p:a" }),
      () => throwing.set({ kind: "keychain", account: "p:a" }, { kind: "api-key", key: SECRET }),
      () => throwing.delete({ kind: "keychain", account: "p:a" }),
    ]) {
      const err = (await op().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect(err.message).not.toContain(SECRET);
      expect(err.message).not.toContain("SecItem");
    }
  });

  test("delete removes the record", async () => {
    const backend = fakeBackend();
    const store = createKeychainCredentialStore("svc", { secrets: backend });
    const ref = { kind: "keychain", account: "p:a" } as const;
    await store.set(ref, { kind: "api-key", key: SECRET });
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });
});

describe("the REPO-WIDE Bun.secrets tripwire", () => {
  test("no `.ts` under packages/ reaches the secrets API except keychain-store.ts itself", () => {
    // Global Constraints call for a repo-wide grep pinning that no test ever calls it. Task 2's
    // tripwire covered `credentials/**` only and flagged this file as the place the repo-wide one
    // belongs, because this is where the POSITIVE case exists.
    //
    // COMMENTS ARE STRIPPED FIRST, carrying Task 2's own finding forward: its first version failed on
    // a header that EXPLAINED the absence, and a tripwire that fires on its own documentation trains
    // the next person to delete the documentation -- precisely the wrong repair. This file's own
    // header would trip it otherwise.
    //
    // STRING LITERALS ARE STRIPPED TOO, and that is a rule rather than an exemption list. Two files
    // in this repository legitimately contain the text `Bun.secrets` in CODE -- this one and Task 2's
    // own `credentials.test.ts` -- because a grep tripwire has to name what it greps for. Both
    // occurrences are inside string literals; a REAL call site never is. Exempting the two files by
    // name would also blind the sweep to a genuine call added to either of them later.
    const packagesRoot = join(import.meta.dir, "..", "..", "..");
    const allowed = join(import.meta.dir, "keychain-store.ts");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        if (full === allowed) continue;
        if (reachesSecretsApi(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(packagesRoot);

    expect(offenders).toEqual([]);
  });

  test("the tripwire is REAL: the detector fires on the one file that is allowed to reach the API", () => {
    // A negative-only assertion passes just as happily when the scan is broken -- so the detector is
    // run against the file that genuinely does reach it, and against a synthetic call site.
    expect(reachesSecretsApi(readFileSync(join(import.meta.dir, "keychain-store.ts"), "utf8"))).toBe(true);
    expect(reachesSecretsApi("await Bun.secrets.get({ service: 's', name: 'n' });")).toBe(true);
    expect(reachesSecretsApi("const s = Bun?.secrets;")).toBe(true);
    expect(reachesSecretsApi('const s = Bun["sec" + "rets"];')).toBe(true); // the computed-key evasion
    // ...and NOT on prose or on a tripwire's own pattern string.
    expect(reachesSecretsApi('// never call Bun.secrets from a test\nconst x = 1;')).toBe(false);
    expect(reachesSecretsApi('expect(code.includes("Bun.secrets")).toBe(false);')).toBe(false);
  });
});

/**
 * True when `text` actually REACHES the secrets API in code.
 *
 * Comments and string literals are removed first; what remains is executable. The two access shapes
 * checked are the dotted one (optional-chained or not, which is how `keychain-store.ts` reads the
 * global defensively) and the indirect bracket lookup a plain substring search would miss.
 */
function reachesSecretsApi(text: string): boolean {
  const code = stripStringLiterals(stripComments(text));
  // The bracket form is checked WITHOUT its key, because the key was inside a literal and has just
  // been blanked. That makes the check "any dynamic property access on the Bun global", which is
  // broader than it strictly needs to be -- and deliberately so: `Bun[someName]` is precisely the
  // shape an evasion would take, nothing in this repository legitimately does it, and a tripwire
  // that can be walked around by a computed key is not a tripwire.
  return /\bBun\s*\??\s*\.\s*secrets\b/.test(code) || /\bBun\s*\??\s*\[/.test(code);
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx < 0 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** Blanks the CONTENTS of every string/template literal, keeping the quotes so nothing else shifts. */
function stripStringLiterals(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => m[0]! + m[0]!);
}
