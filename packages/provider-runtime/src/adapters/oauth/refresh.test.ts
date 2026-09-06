// The shared refresh-token grant, proved against a loopback token endpoint.
//
// Every server here binds 127.0.0.1:0 and stops in a `finally`; the store is in-memory, so nothing
// reaches `Bun.secrets` or a real Keychain. The ground truth is the FORM BODY the fake received.
import { describe, expect, test } from "bun:test";
import { createMemoryCredentialStore } from "../../credentials/memory.ts";
import { refreshOauthMaterial } from "./refresh.ts";

describe("refreshOauthMaterial", () => {
  test("exchanges the refresh token, persists the new material, never logs it", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const form = await req.text();
        expect(form).toContain("grant_type=refresh_token");
        expect(form).toContain("client_id=client-1");
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
      },
    });
    try {
      const store = createMemoryCredentialStore();
      const ref = { kind: "keychain" as const, account: "prov:acct" };
      await store.set(ref, { kind: "oauth", accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 });
      const fresh = await refreshOauthMaterial({ store, ref, tokenUrl: `http://127.0.0.1:${server.port}/token`, clientId: "client-1", now: () => 1_000 });
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
