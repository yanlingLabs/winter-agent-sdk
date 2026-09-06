import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createCompositeCredentialStore } from "../../credentials/types.ts";
import { createEnvCredentialStore } from "../../credentials/env.ts";
import { createFileCredentialStore } from "../../credentials/file.ts";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import type { CredentialRef, CredentialStore, ProviderContext } from "../../types.ts";
import { requireRegion, resolveAwsCredentials } from "./credentials.ts";

// Nothing here touches the real environment, the real home directory, or the Keychain: the env and
// file stores are INJECTED with their environment and their home, which is exactly what Task 2 made
// possible, and every filesystem case runs under an mkdtemp home.

const SECRET = "test-secret-access-key-not-a-real-one";

function context(authRef: CredentialRef, credentials: CredentialStore, region = "us-east-1"): ProviderContext {
  return {
    connection: { providerId: "bedrock", region },
    credentials,
    authRef,
    stallTimeoutMs: 1000,
    log: () => {},
  };
}

async function tempHomeWithCredentialsFile(contents: string): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), "winter-bedrock-creds-"));
  await mkdir(join(home, ".aws"), { recursive: true });
  const path = join(home, ".aws", "credentials");
  await writeFile(path, contents, "utf8");
  return { home, path };
}

describe("resolveAwsCredentials", () => {
  test("aws-default-chain link 1: the injected environment triple", async () => {
    const store = createFileCredentialStore({
      env: { AWS_ACCESS_KEY_ID: "AKIDTESTONLY", AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: "test-session-token" },
      home: "/nonexistent-home-for-this-test",
    });
    expect(await resolveAwsCredentials(context({ kind: "aws-default-chain" }, store))).toEqual({
      accessKeyId: "AKIDTESTONLY",
      secretAccessKey: SECRET,
      sessionToken: "test-session-token",
    });
  });

  test("aws-default-chain link 2: the shared credentials file, when the environment has nothing", async () => {
    const { home } = await tempHomeWithCredentialsFile(`[default]\naws_access_key_id = AKIDFROMFILE\naws_secret_access_key = ${SECRET}\n`);
    const store = createFileCredentialStore({ env: {}, home });
    expect(await resolveAwsCredentials(context({ kind: "aws-default-chain" }, store))).toEqual({
      accessKeyId: "AKIDFROMFILE",
      secretAccessKey: SECRET,
    });
  });

  test("aws-default-chain has NO third link: with neither source present it is a typed refusal, not a network lookup", async () => {
    // The absent-IMDS claim, asserted the only way an absence can be: behaviourally. A chain with an
    // IMDS link would hang here for a timeout rather than refusing immediately.
    const store = createFileCredentialStore({ env: {}, home: "/nonexistent-home-for-this-test" });
    const started = Date.now();
    await expect(resolveAwsCredentials(context({ kind: "aws-default-chain" }, store))).rejects.toThrow(/does not use IMDS or STS/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a named profile resolves from the shared credentials file", async () => {
    const { path } = await tempHomeWithCredentialsFile(
      `[default]\naws_access_key_id = AKIDDEFAULT\naws_secret_access_key = ${SECRET}\n\n[work]\naws_access_key_id = AKIDWORK\naws_secret_access_key = ${SECRET}-work\n`,
    );
    const store = createFileCredentialStore({ env: {}, home: "/nonexistent-home-for-this-test" });
    const ref: CredentialRef = { kind: "file", path, format: "aws-shared-credentials", profile: "work" };
    expect(await resolveAwsCredentials(context(ref, store))).toEqual({ accessKeyId: "AKIDWORK", secretAccessKey: `${SECRET}-work` });
  });

  test("an ABSENT profile is a refusal, never a silent fall back to [default]", async () => {
    const { path } = await tempHomeWithCredentialsFile(`[default]\naws_access_key_id = AKIDDEFAULT\naws_secret_access_key = ${SECRET}\n`);
    const store = createFileCredentialStore({ env: {}, home: "/nonexistent-home-for-this-test" });
    const ref: CredentialRef = { kind: "file", path, format: "aws-shared-credentials", profile: "not-there" };
    await expect(resolveAwsCredentials(context(ref, store))).rejects.toThrow(/found no credential/);
  });

  test("aws material held in a host store (Keychain-shaped) is accepted", async () => {
    const store = createMemoryCredentialStore();
    const ref: CredentialRef = { kind: "keychain", account: "bedrock:default" };
    await store.set(ref, { kind: "aws", accessKeyId: "AKIDFROMSTORE", secretAccessKey: SECRET });
    expect(await resolveAwsCredentials(context(ref, store))).toEqual({ accessKeyId: "AKIDFROMSTORE", secretAccessKey: SECRET });
  });

  test("an `env` ref is refused BEFORE the store is asked, naming the ref that works", async () => {
    // The store would happily return `{ kind: "api-key" }` here; the refusal is about the REF, and
    // the message has to point at `aws-default-chain` or the user is left guessing.
    let asked = 0;
    const counting: CredentialStore = {
      async get(ref) {
        asked++;
        return await createEnvCredentialStore({ env: { AWS_KEY: "something" } }).get(ref);
      },
      async set() {},
      async delete() {},
    };
    await expect(resolveAwsCredentials(context({ kind: "env", name: "AWS_KEY" }, counting))).rejects.toThrow(/aws-default-chain/);
    expect(asked).toBe(0);
  });

  test("a `none` ref is a typed refusal that names the refs that would work", async () => {
    await expect(resolveAwsCredentials(context({ kind: "none" }, createMemoryCredentialStore()))).rejects.toThrow(/aws-default-chain/);
  });

  test("material of the WRONG KIND is refused, and the message carries no material", async () => {
    const store = createMemoryCredentialStore();
    const ref: CredentialRef = { kind: "keychain", account: "bedrock:default" };
    await store.set(ref, { kind: "api-key", key: "test-key-abcdefghijklmnop" });
    let message = "";
    try {
      await resolveAwsCredentials(context(ref, store));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("***(api-key)");
    expect(message).not.toContain("test-key-abcdefghijklmnop");
  });

  test("a file-format mismatch is refused without reading the file", async () => {
    const store = createFileCredentialStore({ env: {}, home: "/nonexistent-home-for-this-test" });
    const ref: CredentialRef = { kind: "file", path: "/nonexistent/sa.json", format: "gcp-service-account-json" };
    await expect(resolveAwsCredentials(context(ref, store))).rejects.toThrow(/aws-shared-credentials/);
  });

  test("an incomplete aws credential is refused rather than signed with", async () => {
    const store = createMemoryCredentialStore();
    const ref: CredentialRef = { kind: "keychain", account: "bedrock:default" };
    await store.set(ref, { kind: "aws", accessKeyId: "AKIDTESTONLY", secretAccessKey: "" });
    await expect(resolveAwsCredentials(context(ref, store))).rejects.toThrow(/incomplete/);
  });

  test("a composite chain reaches the file store for an aws-default-chain ref the env store cannot handle", async () => {
    // The production wiring shape: an env store first, a file store behind it. The env store throws
    // `unsupported` for `aws-default-chain`, and the composite must fall through rather than fail.
    const { home } = await tempHomeWithCredentialsFile(`[default]\naws_access_key_id = AKIDCHAINED\naws_secret_access_key = ${SECRET}\n`);
    const store = createCompositeCredentialStore([createEnvCredentialStore({ env: {} }), createFileCredentialStore({ env: {}, home })]);
    expect(await resolveAwsCredentials(context({ kind: "aws-default-chain" }, store))).toEqual({ accessKeyId: "AKIDCHAINED", secretAccessKey: SECRET });
  });

  test("no credential material ever reaches ProviderContext.log", async () => {
    const logged: unknown[] = [];
    const store = createFileCredentialStore({ env: { AWS_ACCESS_KEY_ID: "AKIDTESTONLY", AWS_SECRET_ACCESS_KEY: SECRET }, home: "/nonexistent" });
    const ctx: ProviderContext = { ...context({ kind: "aws-default-chain" }, store), log: (e) => logged.push(e) };
    await resolveAwsCredentials(ctx);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });
});

describe("requireRegion", () => {
  test("returns the connection's region", () => {
    expect(requireRegion(context({ kind: "none" }, createMemoryCredentialStore(), "eu-west-1"))).toBe("eu-west-1");
  });

  test("REFUSES rather than defaulting when no region is declared", () => {
    // A silent `us-east-1` would send a European operator's conversation content to a jurisdiction
    // they never chose, and would produce a signature scoped to the wrong region either way.
    const ctx = context({ kind: "none" }, createMemoryCredentialStore());
    const { region: _dropped, ...connection } = ctx.connection;
    expect(() => requireRegion({ ...ctx, connection })).toThrow(/declares no region/);
    expect(() => requireRegion({ ...ctx, connection: { ...connection, region: "   " } })).toThrow(/declares no region/);
  });

  test("REFUSES a region that is not a well-formed region name", () => {
    // The value is interpolated into a hostname; an unvalidated one is a request to a host the
    // operator never named.
    expect(() => requireRegion(context({ kind: "none" }, createMemoryCredentialStore(), "evil.example.com"))).toThrow(/not a well-formed/);
    expect(() => requireRegion(context({ kind: "none" }, createMemoryCredentialStore(), "us-east-1/../.."))).toThrow(/not a well-formed/);
  });
});
