// WS-25 §2: the `oauth` block at the runtime's config door (`validateServerConfig`) -- accepted on a
// remote server, strict about what it may say, and never a place a secret value can live.
import { describe, expect, test } from "bun:test";
import { validateServerConfig } from "../mcp/lifecycle.ts";
import { validateMcpOAuthConfig } from "./config.ts";
import { DEFAULT_KEYCHAIN_SERVICE, WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { filterSettingsEnv } from "../settings/env-filter.ts";
import { MCP_OAUTH_TEST_STORE_ENV, mcpOAuthTestStoreEnvName, resolveSessionMcpOAuthStore } from "./store.ts";

const remote = (oauth: unknown, type: "http" | "sse" = "http") => validateServerConfig({ type, url: "https://mcp.example.com/mcp", oauth });

describe("validateServerConfig accepts `oauth`", () => {
  test("every field, on http and sse, and passes the block through untouched", () => {
    const oauth = { clientId: "gh-app", clientSecretRef: { kind: "keychain" }, callbackPort: 47823, authServerMetadataUrl: "https://github.com/.well-known/oauth-authorization-server", scopes: ["repo", "read:org"] };
    for (const type of ["http", "sse"] as const) {
      const result = remote(oauth, type);
      expect(result.ok).toBe(true);
      expect((result as { config: { oauth?: unknown } }).config.oauth).toEqual(oauth);
    }
    expect(remote({}).ok).toBe(true);
  });

  test("refused on stdio and sdk, which have no HTTP to authorize", () => {
    expect(validateServerConfig({ command: "x", oauth: {} })).toMatchObject({ ok: false, reason: expect.stringContaining("remote (http/sse)") });
    expect(validateServerConfig({ type: "sdk", name: "x", oauth: {} }).ok).toBe(false);
  });

  test("a secret VALUE is refused by name, and never echoed", () => {
    const result = remote({ clientId: "a", clientSecret: "hunter2-value" });
    const reason = result.ok ? "" : result.reason;
    expect(result.ok).toBe(false);
    expect(reason).toContain("clientSecretRef");
    expect(reason).not.toContain("hunter2-value");
    expect(remote({ clientId: "a", clientSecretRef: { kind: "keychain", value: "hunter2-value" } }).ok).toBe(false);
  });

  test("clientSecretRef can NAME no Keychain item: a config pointing it at a provider key (or any account/service) is refused", () => {
    for (const ref of [{ kind: "keychain", account: "openai:default" }, { kind: "keychain", account: "mcp-oauth-client-secret:0123456789abcdef" }, { kind: "keychain", service: "com.winter.core" }]) {
      const result = remote({ clientId: "a", clientSecretRef: ref });
      expect([JSON.stringify(ref), result.ok]).toEqual([JSON.stringify(ref), false]);
      expect(result.ok ? "" : result.reason).toContain("derived from the server URL");
    }
  });

  test("an authServerMetadataUrl may be loopback only for a loopback server (fix round 1 M4)", () => {
    expect(validateMcpOAuthConfig({ authServerMetadataUrl: "http://127.0.0.1:9/.well-known/oauth-authorization-server" }, "https://mcp.example.com/mcp")).toContain("loopback");
    expect(validateMcpOAuthConfig({ authServerMetadataUrl: "http://127.0.0.1:9/.well-known/oauth-authorization-server" }, "http://127.0.0.1:8/mcp")).toBeUndefined();
  });

  test("each malformed field is refused with its own reason", () => {
    const cases: Array<[unknown, string]> = [
      ["nope", "must be an object"],
      [{ clientSecretRefs: {} }, "unknown key"],
      [{ clientId: "" }, "clientId"],
      [{ clientSecretRef: { kind: "keychain" } }, "needs 'oauth.clientId'"],
      [{ clientId: "a", clientSecretRef: { kind: "env" } }, "kind"],
      [{ callbackPort: 0 }, "callbackPort"],
      [{ callbackPort: 70000 }, "callbackPort"],
      [{ callbackPort: 80.5 }, "callbackPort"],
      [{ authServerMetadataUrl: "http://as.example.com/.well-known/oauth-authorization-server" }, "https-only"],
      [{ authServerMetadataUrl: "https://169.254.169.254/x" }, "link-local"],
      [{ scopes: "repo" }, "scopes"],
      [{ scopes: ["a b"] }, "scopes"],
    ];
    for (const [oauth, fragment] of cases) {
      const reason = validateMcpOAuthConfig(oauth);
      expect([JSON.stringify(oauth), reason?.includes(fragment)]).toEqual([JSON.stringify(oauth), true]);
      expect(remote(oauth).ok).toBe(false);
    }
  });
});

describe("the sign-in test seam cannot be reached by configuration (fix round 1 I1)", () => {
  test("every settings tier's env refuses its (brand-derived) name", () => {
    for (const tier of ["user", "project", "local", "flag"] as const) {
      expect(filterSettingsEnv({ [MCP_OAUTH_TEST_STORE_ENV]: "/tmp/attacker.json", KEPT: "1" }, tier, { hostManaged: false })).toEqual({ KEPT: "1" });
    }
    expect(MCP_OAUTH_TEST_STORE_ENV).toBe(mcpOAuthTestStoreEnvName(WINTER_BRAND));
  });

  test("honoured only for an explicit, non-default Keychain service -- never the production default", () => {
    expect("testFile" in resolveSessionMcpOAuthStore({ keychainService: "com.winter.test.gate", testStoreFile: "/tmp/x.json" })).toBe(true);
    expect("testFile" in resolveSessionMcpOAuthStore({ keychainService: DEFAULT_KEYCHAIN_SERVICE, testStoreFile: "/tmp/x.json" })).toBe(false);
    expect("testFile" in resolveSessionMcpOAuthStore({ keychainService: `${DEFAULT_KEYCHAIN_SERVICE}.dev`, testStoreFile: "/tmp/x.json" })).toBe(false);
    expect("testFile" in resolveSessionMcpOAuthStore({ keychainService: undefined, testStoreFile: "/tmp/x.json" })).toBe(false);
    expect("testFile" in resolveSessionMcpOAuthStore({ keychainService: "com.winter.test.gate", testStoreFile: undefined })).toBe(false);
  });
});
