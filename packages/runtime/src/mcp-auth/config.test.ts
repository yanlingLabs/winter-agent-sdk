// WS-25 §2: the `oauth` block at the runtime's config door (`validateServerConfig`) -- accepted on a
// remote server, strict about what it may say, and never a place a secret value can live.
import { describe, expect, test } from "bun:test";
import { validateServerConfig } from "../mcp/lifecycle.ts";
import { validateMcpOAuthConfig } from "./config.ts";

const remote = (oauth: unknown, type: "http" | "sse" = "http") => validateServerConfig({ type, url: "https://mcp.example.com/mcp", oauth });

describe("validateServerConfig accepts `oauth`", () => {
  test("every field, on http and sse, and passes the block through untouched", () => {
    const oauth = { clientId: "gh-app", clientSecretRef: { kind: "keychain", account: "mcp-oauth-secret:gh", service: "com.example.svc" }, callbackPort: 47823, authServerMetadataUrl: "https://github.com/.well-known/oauth-authorization-server", scopes: ["repo", "read:org"] };
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
    expect(remote({ clientId: "a", clientSecretRef: { kind: "keychain", account: "x", value: "hunter2-value" } })).toMatchObject({ ok: false, reason: expect.stringContaining("locator") });
  });

  test("each malformed field is refused with its own reason", () => {
    const cases: Array<[unknown, string]> = [
      ["nope", "must be an object"],
      [{ clientSecretRefs: {} }, "unknown key"],
      [{ clientId: "" }, "clientId"],
      [{ clientSecretRef: { kind: "keychain", account: "x" } }, "needs 'oauth.clientId'"],
      [{ clientId: "a", clientSecretRef: { kind: "env", account: "x" } }, "kind"],
      [{ clientId: "a", clientSecretRef: { kind: "keychain", account: "" } }, "account"],
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
