import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialMaterial, CredentialRef } from "../types.ts";
import { CredentialResolutionError, createCompositeCredentialStore, redactMaterial, redactRef } from "./types.ts";
import { createMemoryCredentialStore } from "./memory.ts";
import { createEnvCredentialStore } from "./env.ts";
import { createFileCredentialStore } from "./file.ts";

// Every literal below is a TEST value. Real credentials never enter this repository — the catalog
// validator greps for key shapes, and these strings are deliberately outside every pattern it knows.
const TEST_KEY = "test-key-abc123";
const TEST_SECRET = "test-key-secret-xyz";

let home: string;
beforeAll(async () => {
  // A mkdtemp home, never `~`. Nothing in this file reads $HOME, ~/.winter, ~/.aws or the Keychain.
  home = await mkdtemp(join(tmpdir(), "winter-cred-test-"));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("redaction (Global Constraints: credential material is redacted EVERYWHERE)", () => {
  test("redactMaterial renders the kind and never the material", () => {
    const materials: CredentialMaterial[] = [
      { kind: "api-key", key: TEST_KEY },
      { kind: "bearer", token: TEST_KEY },
      { kind: "oauth", accessToken: TEST_KEY, refreshToken: TEST_SECRET, idToken: TEST_KEY, accountId: "acct-1" },
      { kind: "aws", accessKeyId: TEST_KEY, secretAccessKey: TEST_SECRET, sessionToken: TEST_KEY },
      { kind: "gcp-service-account", clientEmail: "svc@example.test", privateKeyPem: TEST_SECRET, tokenUri: "https://oauth2.example.test/token" },
      { kind: "gcp-access-token", token: TEST_KEY },
    ];
    for (const m of materials) {
      const rendered = redactMaterial(m);
      expect(rendered).toContain("***");
      expect(rendered).toContain(m.kind);
      expect(rendered).not.toContain(TEST_KEY);
      expect(rendered).not.toContain(TEST_SECRET);
    }
  });

  test("redactRef keeps the non-secret locator and hides an inline value", () => {
    expect(redactRef({ kind: "env", name: "WINTER_TEST_KEY" })).toContain("WINTER_TEST_KEY");
    expect(redactRef({ kind: "keychain", account: "openai:acct-1", service: "com.winter.test" })).toContain("openai:acct-1");
    const inline = redactRef({ kind: "inline", value: TEST_KEY });
    expect(inline).toContain("***");
    expect(inline).not.toContain(TEST_KEY);
  });
});

describe("memory store", () => {
  test("round-trips a keychain ref through set/get/delete", async () => {
    const store = createMemoryCredentialStore();
    const ref: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "openai:acct-1" };
    expect(await store.get(ref)).toBeNull();
    await store.set(ref, { kind: "api-key", key: TEST_KEY });
    expect(await store.get(ref)).toEqual({ kind: "api-key", key: TEST_KEY });
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });

  test("keys keychain records by service AND account — one record per provider/account (R6-10)", async () => {
    const store = createMemoryCredentialStore();
    await store.set({ kind: "keychain", account: "openai:a", service: "com.winter.core" }, { kind: "api-key", key: TEST_KEY });
    expect(await store.get({ kind: "keychain", account: "openai:a", service: "com.winter.core.dev" })).toBeNull();
    expect(await store.get({ kind: "keychain", account: "openai:b", service: "com.winter.core" })).toBeNull();
  });

  test("resolves an inline ref without ever storing it (R6-10: a host responsibility)", async () => {
    const store = createMemoryCredentialStore();
    expect(await store.get({ kind: "inline", value: TEST_KEY })).toEqual({ kind: "api-key", key: TEST_KEY });
  });

  test("`none` resolves to null on every store — it means \"send no credential\", not \"lookup failed\"", async () => {
    for (const store of [createMemoryCredentialStore(), createEnvCredentialStore({ env: {} }), createFileCredentialStore({ env: {}, home })]) {
      expect(await store.get({ kind: "none" })).toBeNull();
    }
  });

  test("refuses a kind it does not handle with a TYPED error, not null", async () => {
    const store = createMemoryCredentialStore();
    const err = await store.get({ kind: "env", name: "ANYTHING" }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialResolutionError);
    expect((err as CredentialResolutionError).code).toBe("unsupported");
  });
});

describe("env store (R6-10: ambient keys are NEVER scanned implicitly)", () => {
  test("resolves only the variable the ref NAMES", async () => {
    const store = createEnvCredentialStore({ env: { WINTER_TEST_OPENAI: TEST_KEY, ANTHROPIC_API_KEY: TEST_SECRET } });
    expect(await store.get({ kind: "env", name: "WINTER_TEST_OPENAI" })).toEqual({ kind: "api-key", key: TEST_KEY });
  });

  test("an ambient key nobody named is invisible — there is no implicit scan", async () => {
    const store = createEnvCredentialStore({ env: { ANTHROPIC_API_KEY: TEST_SECRET, OPENAI_API_KEY: TEST_SECRET } });
    // The only way to reach a variable is to name it. Nothing enumerates the environment.
    expect(await store.get({ kind: "env", name: "SOMETHING_ELSE" })).toBeNull();
  });

  test("an empty or whitespace-only value is MISSING, not a credential", async () => {
    const store = createEnvCredentialStore({ env: { A: "", B: "   " } });
    expect(await store.get({ kind: "env", name: "A" })).toBeNull();
    expect(await store.get({ kind: "env", name: "B" })).toBeNull();
  });

  test("never reads process.env implicitly", async () => {
    const marker = `WINTER_TEST_MARKER_${process.pid}`;
    process.env[marker] = TEST_KEY;
    try {
      const store = createEnvCredentialStore({ env: {} });
      expect(await store.get({ kind: "env", name: marker })).toBeNull();
    } finally {
      delete process.env[marker];
    }
  });
});

describe("file store", () => {
  test("reads a `raw` single-value file and trims it", async () => {
    const path = join(home, "raw.key");
    await writeFile(path, `${TEST_KEY}\n`, "utf8");
    const store = createFileCredentialStore({ env: {}, home });
    expect(await store.get({ kind: "file", path, format: "raw" })).toEqual({ kind: "api-key", key: TEST_KEY });
  });

  test("parses an AWS shared-credentials file, honouring the named profile", async () => {
    const path = join(home, "aws-credentials");
    await writeFile(
      path,
      [
        "[default]",
        `aws_access_key_id = test-key-default-id`,
        `aws_secret_access_key = ${TEST_SECRET}`,
        "",
        "[work]",
        `aws_access_key_id = test-key-work-id`,
        `aws_secret_access_key = test-key-work-secret`,
        `aws_session_token = test-key-work-token`,
      ].join("\n"),
      "utf8",
    );
    const store = createFileCredentialStore({ env: {}, home });
    expect(await store.get({ kind: "file", path, format: "aws-shared-credentials" })).toEqual({
      kind: "aws",
      accessKeyId: "test-key-default-id",
      secretAccessKey: TEST_SECRET,
    });
    expect(await store.get({ kind: "file", path, format: "aws-shared-credentials", profile: "work" })).toEqual({
      kind: "aws",
      accessKeyId: "test-key-work-id",
      secretAccessKey: "test-key-work-secret",
      sessionToken: "test-key-work-token",
    });
  });

  test("a missing profile is null, not the default profile silently", async () => {
    const path = join(home, "aws-credentials");
    const store = createFileCredentialStore({ env: {}, home });
    expect(await store.get({ kind: "file", path, format: "aws-shared-credentials", profile: "nonexistent" })).toBeNull();
  });

  test("parses a GCP service-account JSON", async () => {
    const path = join(home, "svc.json");
    await writeFile(
      path,
      JSON.stringify({ type: "service_account", client_email: "svc@example.test", private_key: TEST_SECRET, token_uri: "https://oauth2.example.test/token" }),
      "utf8",
    );
    const store = createFileCredentialStore({ env: {}, home });
    expect(await store.get({ kind: "file", path, format: "gcp-service-account-json" })).toEqual({
      kind: "gcp-service-account",
      clientEmail: "svc@example.test",
      privateKeyPem: TEST_SECRET,
      tokenUri: "https://oauth2.example.test/token",
    });
  });

  test("a missing file is null; a MALFORMED file is a typed error whose message carries no file content", async () => {
    const store = createFileCredentialStore({ env: {}, home });
    expect(await store.get({ kind: "file", path: join(home, "no-such-file"), format: "raw" })).toBeNull();

    const bad = join(home, "bad.json");
    await writeFile(bad, `{"private_key": "${TEST_SECRET}", `, "utf8");
    const err = await store.get({ kind: "file", path: bad, format: "gcp-service-account-json" }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialResolutionError);
    expect((err as Error).message).not.toContain(TEST_SECRET);
  });

  test("an oversized credentials file is refused by a STAT, before it is pulled into memory", async () => {
    // Checking the length after reading means a multi-gigabyte file named by a `{ kind: "file" }`
    // ref is fully buffered first and rejected second. The stat is what makes the cap bound what is
    // PULLED IN. Proven by observing that the reader is never called.
    const path = join(home, "huge.key");
    let readCalls = 0;
    const store = createFileCredentialStore({
      env: {},
      home,
      readFile: async () => {
        readCalls += 1;
        return "x";
      },
      stat: async () => ({ size: 8 * 1024 * 1024 }),
    });
    const err = await store.get({ kind: "file", path, format: "raw" }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialResolutionError);
    expect((err as CredentialResolutionError).code).toBe("malformed");
    expect(readCalls).toBe(0);
  });

  test("a stat reporting ENOENT is `null`, exactly like a missing read", async () => {
    const store = createFileCredentialStore({
      env: {},
      home,
      readFile: async () => "unused",
      stat: async () => {
        const err = new Error("no such file") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      },
    });
    expect(await store.get({ kind: "file", path: join(home, "absent"), format: "raw" })).toBeNull();
  });

  test("aws-default-chain: env FIRST", async () => {
    const store = createFileCredentialStore({
      env: { AWS_ACCESS_KEY_ID: "test-key-env-id", AWS_SECRET_ACCESS_KEY: "test-key-env-secret", AWS_SESSION_TOKEN: "test-key-env-token" },
      home,
    });
    expect(await store.get({ kind: "aws-default-chain" })).toEqual({
      kind: "aws",
      accessKeyId: "test-key-env-id",
      secretAccessKey: "test-key-env-secret",
      sessionToken: "test-key-env-token",
    });
  });

  test("aws-default-chain: then the shared-credentials file, at AWS_SHARED_CREDENTIALS_FILE or <home>/.aws/credentials, with AWS_PROFILE", async () => {
    const explicit = join(home, "chain-credentials");
    await writeFile(explicit, ["[default]", "aws_access_key_id = test-key-file-id", "aws_secret_access_key = test-key-file-secret", "", "[alt]", "aws_access_key_id = test-key-alt-id", "aws_secret_access_key = test-key-alt-secret"].join("\n"), "utf8");
    const store = createFileCredentialStore({ env: { AWS_SHARED_CREDENTIALS_FILE: explicit }, home });
    expect(await store.get({ kind: "aws-default-chain" })).toEqual({ kind: "aws", accessKeyId: "test-key-file-id", secretAccessKey: "test-key-file-secret" });

    const profiled = createFileCredentialStore({ env: { AWS_SHARED_CREDENTIALS_FILE: explicit, AWS_PROFILE: "alt" }, home });
    expect(await profiled.get({ kind: "aws-default-chain" })).toEqual({ kind: "aws", accessKeyId: "test-key-alt-id", secretAccessKey: "test-key-alt-secret" });
  });

  test("aws-default-chain: NOTHING beyond env and the file — no IMDS, no STS (R6-16)", async () => {
    // A default chain that reached 169.254.169.254 would hang or silently succeed on an EC2 host.
    // The only proof that matters is behavioural: with neither source present the answer is null.
    const empty = await mkdtemp(join(tmpdir(), "winter-cred-empty-"));
    try {
      const store = createFileCredentialStore({ env: {}, home: empty });
      expect(await store.get({ kind: "aws-default-chain" })).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("composite store", () => {
  test("tries each store in order and returns the first HANDLED answer", async () => {
    const composite = createCompositeCredentialStore([
      createEnvCredentialStore({ env: { NAMED: TEST_KEY } }),
      createMemoryCredentialStore(),
      createFileCredentialStore({ env: {}, home }),
    ]);
    expect(await composite.get({ kind: "env", name: "NAMED" })).toEqual({ kind: "api-key", key: TEST_KEY });
    expect(await composite.get({ kind: "inline", value: TEST_KEY })).toEqual({ kind: "api-key", key: TEST_KEY });
  });

  test("a store that HANDLES the kind but finds nothing returns null — it does not fall through", async () => {
    const memory = createMemoryCredentialStore();
    await memory.set({ kind: "keychain", account: "a" }, { kind: "api-key", key: TEST_KEY });
    const composite = createCompositeCredentialStore([createEnvCredentialStore({ env: {} }), memory]);
    // The env store handles `env` and finds nothing; the memory store is NOT consulted for it, so a
    // null here proves "handled, empty" rather than "nobody handled it".
    expect(await composite.get({ kind: "env", name: "ABSENT" })).toBeNull();
  });

  test("rethrows `unsupported` only when NO store handles the kind", async () => {
    const composite = createCompositeCredentialStore([createEnvCredentialStore({ env: {} })]);
    const err = await composite.get({ kind: "keychain", account: "a" }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialResolutionError);
    expect((err as CredentialResolutionError).code).toBe("unsupported");
  });

  test("set/delete route to the first store that supports writing", async () => {
    const memory = createMemoryCredentialStore();
    const composite = createCompositeCredentialStore([createEnvCredentialStore({ env: {} }), memory]);
    await composite.set({ kind: "keychain", account: "acct" }, { kind: "api-key", key: TEST_KEY });
    expect(await memory.get({ kind: "keychain", account: "acct" })).toEqual({ kind: "api-key", key: TEST_KEY });
    await composite.delete({ kind: "keychain", account: "acct" });
    expect(await memory.get({ kind: "keychain", account: "acct" })).toBeNull();
  });

  test("an empty composite is a typed refusal, never a silent null", async () => {
    const composite = createCompositeCredentialStore([]);
    await expect(composite.get({ kind: "env", name: "X" })).rejects.toBeInstanceOf(CredentialResolutionError);
  });
});

describe("no store ever touches the Keychain or a real home", () => {
  test("this module never references Bun.secrets", async () => {
    // A grep tripwire on the production sources themselves: `Bun.secrets` is the ONE API that would
    // reach the user's real login Keychain from a test run, and the constraint is that no test can.
    // The keychain-backed store is a runtime-side deliverable (provider/keychain-store.ts, T3+),
    // deliberately NOT in this package.
    // `import.meta.dir`, not `new URL(...).pathname` — the repo path contains a space, and a
    // file:// URL's pathname is PERCENT-ENCODED, so the naive spelling opens "…Xcode%20progects/…"
    // and ENOENTs. (Found by this very test; the same trap would silently break any fixture path.)
    // COMMENTS ARE STRIPPED FIRST, and that is not a convenience: the naive `text.includes(...)`
    // version of this test failed on memory.ts's own header, which EXPLAINS why `Bun.secrets` is
    // absent. A tripwire that fires on its own documentation trains the next person to delete the
    // documentation, which is precisely the wrong repair.
    const files = ["types.ts", "memory.ts", "env.ts", "file.ts"];
    for (const f of files) {
      const text = await Bun.file(join(import.meta.dir, f)).text();
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("//");
          return idx < 0 ? line : line.slice(0, idx);
        })
        .join("\n");
      expect(code.includes("Bun.secrets")).toBe(false);
      // A second spelling the first would miss: an indirect lookup off the Bun global.
      expect(/\bsecrets\s*\[/.test(code) || /Bun\s*\[\s*["'`]secrets/.test(code)).toBe(false);
    }
  });
});
