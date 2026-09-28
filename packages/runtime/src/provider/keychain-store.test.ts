// Phase 6 Task 3 (R6-10): the Keychain store, against an INJECTED double -- and the repo-wide grep
// tripwire that keeps it that way.
//
// The real `Bun.secrets` path is never exercised here, and it never can be by accident: every
// fixture injects a backend, and the tripwire at the bottom of this file greps every `.ts` under
// `packages/` for the API name. The controller proves the real darwin path once, locally, against a
// throwaway service name it deletes in `finally` -- that is the only place it is ever touched.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { CredentialResolutionError } from "@yanlinglabs/winter-provider-runtime";
import { TEST_KEYCHAIN_ENV as SDK_TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY as SDK_TEST_KEYCHAIN_MEMORY } from "@yanlinglabs/winter-agent-sdk";
import { createKeychainCredentialStore, createKeychainRawStore, createKeychainSecretReader, keychainAccountName, DEFAULT_KEYCHAIN_SERVICE, TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY, type SecretsBackend } from "./keychain-store.ts";
import { createProductionCredentialStore } from "./session-provider.ts";
import * as keychainGuard from "../../../../scripts/test-keychain-guard.ts";

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
      // P10a-4 (2026-09-13): `expiresAt` on `bearer` -- the host-brokered Anthropic Console material
      // -- must round-trip through the REAL Keychain-backed store, not just the in-memory one; the
      // coercion in `coerceMaterial` reconstructs the object field-by-field and had silently dropped
      // it until this fixture caught it.
      { kind: "bearer", token: SECRET, expiresAt: 1_999_999_999_999 },
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

describe("WS-25: the raw store (the default McpOAuthStore)", () => {
  test("reads, writes and removes an UNINTERPRETED value under one service", async () => {
    const backend = fakeBackend();
    const store = createKeychainRawStore("svc.raw", { secrets: backend });
    expect(await store.read("mcp-oauth:0123456789abcdef")).toBeNull();
    await store.write("mcp-oauth:0123456789abcdef", "not json at all");
    expect(await store.read("mcp-oauth:0123456789abcdef")).toBe("not json at all");
    await store.remove("mcp-oauth:0123456789abcdef");
    expect(await store.read("mcp-oauth:0123456789abcdef")).toBeNull();
    expect(new Set(backend.calls.map((c) => c.service))).toEqual(new Set(["svc.raw"]));
  });

  test("a backend failure is a typed io error naming the ACCOUNT, never the value or the backend's message", async () => {
    const leaky: SecretsBackend = {
      async get() {
        throw new Error(`item says ${SECRET}`);
      },
      async set() {
        throw new Error(`item says ${SECRET}`);
      },
      async delete() {
        throw new Error(`item says ${SECRET}`);
      },
    };
    const store = createKeychainRawStore("svc.raw", { secrets: leaky });
    for (const op of [() => store.read("mcp-oauth:a"), () => store.write("mcp-oauth:a", SECRET), () => store.remove("mcp-oauth:a")]) {
      const err = await op().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect((err as CredentialResolutionError).code).toBe("io");
      expect((err as Error).message).toContain("mcp-oauth:a");
      expect((err as Error).message).not.toContain(SECRET);
    }
  });
});

describe("the test Keychain redirect (the Keychain-dialog incident) and the preload's tripwire", () => {
  /** Runs `body` with the redirect env set to `value` (`undefined` = unset), restoring it afterwards. */
  async function withRedirect<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
    const saved = process.env[TEST_KEYCHAIN_ENV];
    if (value === undefined) delete process.env[TEST_KEYCHAIN_ENV];
    else process.env[TEST_KEYCHAIN_ENV] = value;
    try {
      return await body();
    } finally {
      if (saved === undefined) delete process.env[TEST_KEYCHAIN_ENV];
      else process.env[TEST_KEYCHAIN_ENV] = saved;
    }
  }

  test("one name, three spellings: the sdk's constant, the runtime's re-export and the preload's copy agree", () => {
    expect(TEST_KEYCHAIN_ENV).toBe(SDK_TEST_KEYCHAIN_ENV);
    expect(TEST_KEYCHAIN_MEMORY).toBe(SDK_TEST_KEYCHAIN_MEMORY);
    expect(keychainGuard.TEST_KEYCHAIN_ENV).toBe(SDK_TEST_KEYCHAIN_ENV);
    expect(keychainGuard.TEST_KEYCHAIN_MEMORY).toBe(SDK_TEST_KEYCHAIN_MEMORY);
  });

  test("the preload is active in this process: the redirect is set and the real API is the tripwire", () => {
    expect(process.env[TEST_KEYCHAIN_ENV]).toBe(TEST_KEYCHAIN_MEMORY);
    expect(keychainGuard.keychainTripwireInstalled()).toBe(true);
  });

  test("a DEFAULT store (nothing injected) on the user's real service reads ABSENT, round-trips in memory, and never reaches the real API", async () => {
    // Exactly the incident's shape: no brand, no keychainService -> `com.winter.core`, `<vendor>:default`.
    const store = createKeychainCredentialStore();
    const ref = { kind: "keychain", account: keychainAccountName("anthropic", "default") } as const;
    expect(await store.get(ref)).toBeNull();
    const probeRef = { kind: "keychain", account: `keychain-redirect-probe:${process.pid}` } as const;
    await store.set(probeRef, { kind: "api-key", key: SECRET });
    // A SECOND store in the same process sees it: one map per process, like one Keychain per user.
    expect(await createKeychainCredentialStore().get(probeRef)).toEqual({ kind: "api-key", key: SECRET });
    expect(await createKeychainSecretReader()(probeRef)).toBe(JSON.stringify({ kind: "api-key", key: SECRET }));
    await store.delete(probeRef);
    expect(await store.get(probeRef)).toBeNull();
    const raw = createKeychainRawStore(DEFAULT_KEYCHAIN_SERVICE);
    expect(await raw.read("mcp-oauth:https://example.invalid/mcp")).toBeNull();
    // Had any of that reached the real API, the tripwire would have recorded it.
    expect(keychainGuard.takeKeychainGuardViolations()).toEqual([]);
  });

  test("any other value is REFUSED typed -- a typo never falls through to the real Keychain", async () => {
    await withRedirect("memroy", async () => {
      const err = (await createKeychainCredentialStore().get({ kind: "keychain", account: "anthropic:default" }).catch((e: unknown) => e)) as CredentialResolutionError;
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect(err.code).toBe("io");
      expect(err.message).toContain(TEST_KEYCHAIN_ENV);
    });
    expect(keychainGuard.takeKeychainGuardViolations()).toEqual([]);
  });

  test("...and THROUGH the production store stack a typo stays a refusal: `io` stops the composite, where `unsupported` would have fallen through to the memory member's silent null", async () => {
    // The stack a child without host credentials builds (`buildSessionProvider` -> this function). Its
    // composite asks the NEXT member on `unsupported`, and the last member (`createMemoryCredentialStore`)
    // answers a keychain ref with `null` -- the typo would have read as "no credential", silently.
    const config = { sessionId: "keychain-typo", cwd: tmpdir() } as unknown as RuntimeConfig;
    const production = createProductionCredentialStore(config, {}, tmpdir());
    const ref = { kind: "keychain", account: "anthropic:default" } as const;
    await withRedirect("memroy", async () => {
      const err = (await production.get(ref).catch((e: unknown) => e)) as CredentialResolutionError;
      expect(err).toBeInstanceOf(CredentialResolutionError);
      expect(err.code).toBe("io");
      expect(err.message).toContain(TEST_KEYCHAIN_ENV);
    });
    // The correctly spelled value answers ABSENT through the same stack.
    expect(await production.get(ref)).toBeNull();
    expect(keychainGuard.takeKeychainGuardViolations()).toEqual([]);
  });

  test("the tripwire reads the caller's options ONCE: the service it checks is the service it would forward", () => {
    let reads = 0;
    const tricky = {
      name: "probe",
      get service(): string {
        reads += 1;
        // A first read that says "throwaway" and a second that names a real service is the attack.
        return reads === 1 ? `${keychainGuard.THROWAWAY_SERVICE_PREFIX}checked` : DEFAULT_KEYCHAIN_SERVICE;
      },
    };
    const { forward, service } = keychainGuard.snapshotSecretsCall(tricky);
    expect(reads).toBe(1);
    expect(service).toBe(`${keychainGuard.THROWAWAY_SERVICE_PREFIX}checked`);
    expect(forward.service).toBe(service);
    expect(reads).toBe(1); // reading the forwarded copy never calls back into the caller's accessor
    expect(Object.getOwnPropertyDescriptor(forward, "service")?.get).toBeUndefined();
  });

  test("the first engagement of the memory backend prints ONE stderr line per process -- never more, never a value", async () => {
    // A fresh process (this one announced long ago). Spawned through the preload's wrapper, so it carries
    // the redirect and the guard.
    const code = [
      `const { createKeychainCredentialStore } = await import(${JSON.stringify(join(import.meta.dir, "keychain-store.ts"))});`,
      `const store = createKeychainCredentialStore();`,
      `await store.set({ kind: "keychain", account: "announce:probe" }, { kind: "api-key", key: ${JSON.stringify(SECRET)} });`,
      `await store.get({ kind: "keychain", account: "announce:probe" });`,
      `await createKeychainCredentialStore().get({ kind: "keychain", account: "anthropic:default" });`,
      `console.log("done");`,
    ].join("\n");
    const proc = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("done");
    const lines = stderr.split("\n").filter((l) => l.length > 0);
    expect(lines).toEqual([`winter: ${TEST_KEYCHAIN_ENV}=${TEST_KEYCHAIN_MEMORY} -- the Keychain is replaced by an in-memory store for this process (test runs only)`]);
    expect(stderr).not.toContain(SECRET);
  });

  test("a WORKER carries the redirect and the tripwire too -- with an explicit env and with none (the preload wraps the Worker constructor)", async () => {
    // A preload does not run inside a Worker, and the embedded host builds one per session with the
    // session's env (`embedded-host.ts`: `new Worker(entry, { env })`). The script provokes the tripwire only
    // once it has proven it is installed, and on a throwaway service holding no item.
    const dir = mkdtempSync(join(tmpdir(), "winter-keychain-worker-"));
    const log = process.env.WINTER_TEST_KEYCHAIN_GUARD_LOG;
    expect(log).toBeDefined();
    try {
      const entry = join(dir, "worker.ts");
      writeFileSync(
        entry,
        [
          `const api = (globalThis as any).Bun.secrets;`,
          `const tripwire = api[Symbol.for("winter.test.keychainTripwire")] === true;`,
          `let refused = false;`,
          `if (tripwire) { try { await api.get({ service: ${JSON.stringify(`${keychainGuard.THROWAWAY_SERVICE_PREFIX}worker-selftest`)}, name: "probe" }); } catch { refused = true; } }`,
          `postMessage({ redirect: process.env.${TEST_KEYCHAIN_ENV} ?? null, tripwire, refused });`,
        ].join("\n"),
      );
      for (const options of [{ env: {} as Record<string, string> }, undefined]) {
        writeFileSync(log!, "");
        const worker = options === undefined ? new Worker(entry) : new Worker(entry, options as WorkerOptions);
        const answer = await new Promise<{ redirect: string | null; tripwire: boolean; refused: boolean }>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(String((event as ErrorEvent).message)));
        });
        worker.terminate();
        expect(answer).toEqual({ redirect: TEST_KEYCHAIN_MEMORY, tripwire: true, refused: true });
        // The Worker's refused access was REPORTED to the test process's log (consumed here, so the
        // preload's afterEach does not fail this test for the access it provoked).
        expect(readFileSync(log!, "utf8")).toContain(`Bun.secrets.get on service ${JSON.stringify(`${keychainGuard.THROWAWAY_SERVICE_PREFIX}worker-selftest`)}`);
        writeFileSync(log!, "");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the tripwire is REAL: with the redirect lifted, the default backend IS the tripwire -- it throws and the access is recorded", async () => {
    // Only ever provoked with the tripwire proven installed, and on a service that holds no item, so even
    // a broken guard could not raise a consent dialog here.
    expect(keychainGuard.keychainTripwireInstalled()).toBe(true);
    const service = `keychain-test-throwaway.keychain-tripwire-selftest.${process.pid}`;
    const err = await withRedirect(undefined, () => createKeychainRawStore(service).read("probe").catch((e: unknown) => e));
    expect(err).toBeInstanceOf(CredentialResolutionError);
    expect((err as CredentialResolutionError).code).toBe("io");
    // Consumed here, so the preload's afterEach does not fail THIS test for the access it provoked.
    expect(keychainGuard.takeKeychainGuardViolations()).toEqual([`Bun.secrets.get on service ${JSON.stringify(service)}`]);
  });
});

describe("the REPO-WIDE Bun.secrets tripwire", () => {
  test("no `.ts` in the REPOSITORY reaches the secrets API except keychain-store.ts itself", () => {
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
    // THE REPO ROOT, not `packages/` (review round 1, M5). `scripts/` holds the release and gate
    // scripts, and a repo-root `.ts` is equally capable of reaching the login keychain -- a sweep
    // that stops at `packages/` is a sweep with two whole directories of blind spot.
    const packagesRoot = join(import.meta.dir, "..", "..", "..", "..");
    // TWO files may name it: this store, and the test preload that REPLACES it with a tripwire
    // (`scripts/test-keychain-guard.ts`, which forwards only a throwaway-service measurement gate).
    const allowed = new Set([join(import.meta.dir, "keychain-store.ts"), join(packagesRoot, "scripts", "test-keychain-guard.ts")]);
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        // `.worktrees` joins the skip list for a different reason than the rest: it is not build
        // output, it is OTHER CHECKOUTS OF THIS SAME REPOSITORY (git worktrees, locally excluded via
        // `.git/info/exclude`, absent in CI). Each one runs its own copy of this sweep over its own
        // files, so scanning them here checks nothing twice -- what it does instead is report a
        // SIBLING branch's `keychain-store.ts` as an offender of THIS branch's tripwire, which is how
        // a real finding would get lost in 23 lines of noise.
        if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "third_party" || entry === ".worktrees") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        if (allowed.has(full)) continue;
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
    expect(reachesSecretsApi(readFileSync(join(import.meta.dir, "..", "..", "..", "..", "scripts", "test-keychain-guard.ts"), "utf8"))).toBe(true);
    expect(reachesSecretsApi("await Bun.secrets.get({ service: 's', name: 'n' });")).toBe(true);
    // The named-import door (`import { secrets } from "bun"`), which the dotted pattern never saw.
    expect(reachesSecretsApi('import { secrets } from "bun";\nawait secrets.get({ service: "s", name: "n" });')).toBe(true);
    expect(reachesSecretsApi("import { spawn, secrets as s } from 'bun';")).toBe(true);
    expect(reachesSecretsApi('const { secrets } = require("bun");')).toBe(true);
    expect(reachesSecretsApi('import { spawn } from "bun";')).toBe(false);
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
  const uncommented = stripComments(text);
  // The MODULE door: a named import or a destructured/dotted require of `secrets` from the `bun` module
  // reaches the same object. Checked on text whose literals are blanked EXCEPT a bare "bun" specifier, so
  // a tripwire's own pattern strings (like the ones in this file) never count.
  const withSpecifiers = stripStringLiterals(uncommented, (literal) => literal.slice(1, -1) === "bun");
  if (/\bimport\s*(?:type\s+)?\{[^}]*\bsecrets\b[^}]*\}\s*from\s*["']bun["']/.test(withSpecifiers)) return true;
  if (/\{[^}]*\bsecrets\b[^}]*\}\s*=\s*(?:await\s+import|require)\s*\(\s*["']bun["']\s*\)/.test(withSpecifiers)) return true;
  if (/(?:require|import)\s*\(\s*["']bun["']\s*\)\s*\)?\s*\??\.\s*secrets\b/.test(withSpecifiers)) return true;
  const code = stripStringLiterals(uncommented);
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
function stripStringLiterals(text: string, keep: (literal: string) => boolean = () => false): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => (keep(m) ? m : m[0]! + m[0]!));
}
