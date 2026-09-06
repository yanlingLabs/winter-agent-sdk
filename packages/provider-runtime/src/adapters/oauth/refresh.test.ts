// The shared refresh-token grant, proved against a loopback token endpoint.
//
// Every server here binds 127.0.0.1:0 and stops in a `finally`; the store is in-memory, so nothing
// reaches `Bun.secrets` or a real Keychain. The ground truth is the FORM BODY the fake received.
import { describe, expect, test } from "bun:test";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import { refreshOauthMaterial } from "./refresh.ts";
import { winterUserAgent } from "../../identity.ts";

describe("refreshOauthMaterial", () => {
  test("exchanges the refresh token, persists the new material, never logs it", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const form = await req.text();
        // WS-13b: the token endpoint sees Winter's own user-agent, not Bun's default. The negative
        // is what carries it -- Bun supplies `Bun/<version>` when nothing sets the header, so a
        // presence-only check would pass on a helper that never set one.
        expect(req.headers.get("user-agent")).toBe(winterUserAgent());
        expect(form).toContain("grant_type=refresh_token");
        expect(form).toContain("client_id=client-1");
        // `extraFields` is the HONEST-IDENTITY door on a refresh: a flow that names Winter at login
        // and goes quiet when it renews the token is honest exactly once (WS-13b §4 / D21). Lane O's
        // xAI row rides its `referrer` through here, so the path is exercised rather than exported.
        expect(form).toContain("referrer=winter-agent-sdk");
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      },
    });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });
      const fresh = await refreshOauthMaterial({ store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "client-1", now: () => 1_000, extraFields: { referrer: "winter-agent-sdk" } });
      expect(fresh.accessToken).toBe("new-access");
      expect((await store.get(ref))?.kind).toBe("oauth");
      expect(fresh.expiresAt).toBe(1_000 + 3600 * 1000);
      const stored = await store.get(ref);
      expect(stored?.kind === "oauth" ? stored.accessToken : "").toBe("new-access");
    } finally {
      server.stop(true);
    }
  });

  test("a 4xx is a typed credential error naming the ref, never the token", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("invalid_grant secret-should-not-appear", { status: 400 }) });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "r", expiresAt: 1 });
      const err = await refreshOauthMaterial({ store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "c" }).catch((e: unknown) => e);
      expect((err as Error).name).toBe("CredentialResolutionError");
      expect(String(err)).not.toContain("secret-should-not-appear");
      expect(String(err)).toContain("prov:acct");
    } finally {
      server.stop(true);
    }
  });

  // THE PORT'S OWN FINDING, kept alive by the extraction. A refresh grant usually returns no id
  // token and often does not rotate the refresh token; a helper that wrote back only what the
  // response carried would erase both and make the NEXT refresh impossible. `codex-oauth.ts`
  // guarded this at its own call site; the guard now lives in the shared helper, so every future
  // OAuth row inherits it instead of re-discovering it.
  test("a partial refresh response NEVER clobbers a known-good refresh token, id token or account id", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ access_token: "rotated", expires_in: 60 }) });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "keep-me", idToken: "id-keep", accountId: "acct-keep", expiresAt: 1 });
      const fresh = await refreshOauthMaterial({ store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "c", now: () => 0 });
      expect(fresh).toEqual({ kind: "oauth", accessToken: "rotated", refreshToken: "keep-me", idToken: "id-keep", accountId: "acct-keep", expiresAt: 60_000 });
      expect(await store.get(ref)).toEqual(fresh);
    } finally {
      server.stop(true);
    }
  });

  test("a record that holds no refresh token is a typed refusal, not a request to the vendor", async () => {
    let hits = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits += 1; return Response.json({ access_token: "x", expires_in: 1 }); } });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", expiresAt: 1 });
      const err = await refreshOauthMaterial({ store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "c" }).catch((e: unknown) => e);
      expect((err as Error).name).toBe("CredentialResolutionError");
      expect(hits).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("a token endpoint that answers 200 with no access token is a refusal, and the OLD material survives", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ token_type: "bearer" }) });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "r", expiresAt: 1 });
      const err = await refreshOauthMaterial({ store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "c" }).catch((e: unknown) => e);
      expect((err as Error).name).toBe("CredentialResolutionError");
      const stored = await store.get(ref);
      expect(stored?.kind === "oauth" ? stored.accessToken : "").toBe("old");
    } finally {
      server.stop(true);
    }
  });
});

describe("refreshOauthMaterial: the body encoding and the in-flight dedup (P6.5 rulings R-A2-1 / R-A2-3)", () => {
  test('R-A2-1: `bodyEncoding: "json"` posts a JSON object under a JSON content type, and the default stays form', async () => {
    const seen: Array<{ contentType: string; body: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        seen.push({ contentType: req.headers.get("content-type") ?? "", body: await req.text() });
        return Response.json({ access_token: "new-access", expires_in: 3600 });
      },
    });
    try {
      const tokenUrl = `http://127.0.0.1:${server.port}/token`;
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });

      await refreshOauthMaterial({ store, ref, tokenUrl, clientId: "client-1", bodyEncoding: "json", extraFields: { scope: "a b" } });
      expect(seen[0]!.contentType).toBe("application/json");
      // Parsed rather than substring-matched: a form body happens to CONTAIN every one of these
      // names too, so only decoding it as JSON proves the encoding.
      expect(JSON.parse(seen[0]!.body)).toEqual({ grant_type: "refresh_token", client_id: "client-1", refresh_token: "old-refresh", scope: "a b" });

      // THE DEFAULT IS UNCHANGED, which is what keeps codex byte-identical. Asserted here rather
      // than assumed, because "adding an option" is exactly when a default quietly moves.
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });
      await refreshOauthMaterial({ store, ref, tokenUrl, clientId: "client-1" });
      expect(seen[1]!.contentType).toBe("application/x-www-form-urlencoded");
      expect(seen[1]!.body).toBe("grant_type=refresh_token&client_id=client-1&refresh_token=old-refresh");
    } finally {
      server.stop(true);
    }
  });

  test("R-A2-3: two concurrent refreshes of the SAME record make ONE token request, and both callers get the same material", async () => {
    let requests = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        requests++;
        // HELD OPEN until both callers have started. Without this the first refresh could complete
        // before the second begins, the map entry would already be gone, and the test would pass on
        // a helper with no dedup at all — green for the wrong reason.
        await held;
        return Response.json({ access_token: `rotated-${requests}`, refresh_token: `rotated-refresh-${requests}`, expires_in: 3600 });
      },
    });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });
      const input = { store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "client-1" };

      const first = refreshOauthMaterial(input);
      const second = refreshOauthMaterial(input);
      release();
      const [a, b] = await Promise.all([first, second]);

      // ONE grant. A second would replay the same refresh token, which RFC 9700 §4.14 lets an
      // authorization server read as theft and answer by revoking the whole family.
      expect(requests).toBe(1);
      expect(a).toEqual(b);
      expect(a.accessToken).toBe("rotated-1");
      // And the record holds the winner's material rather than a loser's stale overwrite.
      const stored = await store.get(ref);
      expect(stored?.kind === "oauth" ? stored.accessToken : "").toBe("rotated-1");
      expect(stored?.kind === "oauth" ? stored.refreshToken : "").toBe("rotated-refresh-1");
    } finally {
      server.stop(true);
    }
  });

  test("R-A2-3: the dedup is per RECORD — two different accounts refresh independently rather than sharing one grant", async () => {
    const accounts: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = new URLSearchParams(await req.text());
        accounts.push(body.get("refresh_token") ?? "");
        await held;
        return Response.json({ access_token: `for-${accounts.length}`, expires_in: 3600 });
      },
    });
    try {
      const store = createMemoryCredentialStore();
      const tokenUrl = `http://127.0.0.1:${server.port}/token`;
      const refA = { kind: "keychain" as const, account: "prov:a" };
      const refB = { kind: "keychain" as const, account: "prov:b" };
      await store.set(refA, { kind: "oauth", accessToken: "old-a", refreshToken: "refresh-a", expiresAt: 1 });
      await store.set(refB, { kind: "oauth", accessToken: "old-b", refreshToken: "refresh-b", expiresAt: 1 });
      const both = Promise.all([refreshOauthMaterial({ store, ref: refA, tokenUrl, clientId: "c" }), refreshOauthMaterial({ store, ref: refB, tokenUrl, clientId: "c" })]);
      release();
      await both;
      // Two grants, each carrying its OWN refresh token. A key that ignored the account would have
      // handed account B the material minted for account A.
      expect(accounts.sort()).toEqual(["refresh-a", "refresh-b"]);
    } finally {
      server.stop(true);
    }
  });

  test("R-A2-3: a FAILED refresh is not cached — the next caller retries instead of inheriting the rejection", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++;
        return requests === 1 ? new Response("nope", { status: 500 }) : Response.json({ access_token: "recovered", expires_in: 3600 });
      },
    });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });
      const input = { store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "client-1" };
      await expect(refreshOauthMaterial(input)).rejects.toThrow(/HTTP 500/);
      // A map entry left behind by a rejection would make the record permanently unrefreshable for
      // the life of the process, which is a far worse failure than the one it came from.
      expect((await refreshOauthMaterial(input)).accessToken).toBe("recovered");
      expect(requests).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
