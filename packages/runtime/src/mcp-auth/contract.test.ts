// WS-25 §2: the contract the daemon lane builds against -- the account ids, the record codec and the
// public subpath. Behaviour, not shape: each test pins a rule a host relies on.
import { describe, expect, test } from "bun:test";
import * as subpath from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { canonicalMcpServerUrl, clientAccountForTokenAccount, mcpOAuthAccountId, mcpOAuthClientAccount, mcpOAuthTokenAccount } from "./account.ts";
import { McpOAuthError } from "./errors.ts";
import { decodeMcpOAuthClientRecord, decodeMcpOAuthTokenRecord, encodeMcpOAuthTokenRecord, type McpOAuthTokenRecord } from "./records.ts";
import { createMemoryMcpOAuthStore, readTokenRecordLenient } from "./store.ts";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof McpOAuthError ? err.code : `untyped:${String(err)}`;
  }
  return undefined;
}

describe("account ids: one sign-in per canonical server URL", () => {
  test("case of scheme/host, a default port and trailing slashes never split a server", () => {
    const id = mcpOAuthAccountId("https://mcp.example.com/mcp");
    for (const same of ["HTTPS://MCP.Example.COM/mcp", "https://mcp.example.com:443/mcp", "https://mcp.example.com/mcp/", "https://mcp.example.com/mcp//", "https://mcp.example.com/mcp?x=1#frag"]) {
      expect([same, mcpOAuthAccountId(same)]).toEqual([same, id]);
    }
    expect(canonicalMcpServerUrl("https://x.example/")).toBe("https://x.example");
    expect(mcpOAuthAccountId("https://x.example/")).toBe(mcpOAuthAccountId("https://x.example"));
  });

  test("the path, the host, a non-default port and the scheme DO split servers", () => {
    const base = mcpOAuthAccountId("https://mcp.example.com/mcp");
    for (const other of ["https://mcp.example.com/sse", "https://mcp.example.com/MCP", "https://other.example.com/mcp", "https://mcp.example.com:8443/mcp", "http://mcp.example.com/mcp"]) {
      expect([other, mcpOAuthAccountId(other) === base]).toEqual([other, false]);
    }
  });

  test("the id is sha256(canonical) truncated to 16 hex, and the two account names derive from it", () => {
    const id = mcpOAuthAccountId("https://mcp.example.com/mcp");
    expect(id).toBe(new Bun.CryptoHasher("sha256").update("https://mcp.example.com/mcp").digest("hex").slice(0, 16));
    expect(mcpOAuthTokenAccount("https://mcp.example.com/mcp")).toBe(`mcp-oauth:${id}`);
    expect(mcpOAuthClientAccount("https://mcp.example.com/mcp")).toBe(`mcp-oauth-client:${id}`);
    expect(clientAccountForTokenAccount(`mcp-oauth:${id}`)).toBe(`mcp-oauth-client:${id}`);
  });

  test("refused typed: a non-http(s) URL, userinfo, garbage -- and the userinfo is never echoed", () => {
    expect(codeOf(() => mcpOAuthAccountId("ftp://x.example/mcp"))).toBe("invalid_server_url");
    expect(codeOf(() => mcpOAuthAccountId("not a url"))).toBe("invalid_server_url");
    let message = "";
    try {
      mcpOAuthAccountId("https://alice:hunter2@x.example/mcp");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("userinfo");
    expect(message).not.toContain("hunter2");
    expect(codeOf(() => clientAccountForTokenAccount("anthropic:default"))).toBe("invalid_account");
  });
});

const TOKEN: McpOAuthTokenRecord = { v: 1, kind: "mcp-oauth", serverUrl: "https://mcp.example.com/mcp", issuer: "https://as.example.com", accessToken: "at-secret-value", refreshToken: "rt-secret-value", expiresAt: 1_900_000_000_000, scope: "read", generation: 3 };

describe("the record codec validates on read", () => {
  test("round-trips, and drops unknown extra keys on a known version", () => {
    expect(decodeMcpOAuthTokenRecord(encodeMcpOAuthTokenRecord(TOKEN))).toEqual(TOKEN);
    expect(decodeMcpOAuthTokenRecord(JSON.stringify({ ...TOKEN, somethingNewer: true }))).toEqual(TOKEN);
  });

  test("an unknown `v` is refused TYPED (unsupported_record_version), never read as far as it parses", () => {
    expect(codeOf(() => decodeMcpOAuthTokenRecord(JSON.stringify({ ...TOKEN, v: 2 })))).toBe("unsupported_record_version");
    expect(codeOf(() => decodeMcpOAuthClientRecord(JSON.stringify({ v: 2, kind: "mcp-oauth-client" })))).toBe("unsupported_record_version");
  });

  test("malformed records are malformed_record, and no message quotes a value", () => {
    const cases = ["{", "[]", JSON.stringify({ ...TOKEN, kind: "mcp-oauth-client" }), JSON.stringify({ ...TOKEN, accessToken: 7 }), JSON.stringify({ ...TOKEN, generation: -1 }), JSON.stringify({ ...TOKEN, expiresAt: "soon" })];
    for (const raw of cases) {
      let err: unknown;
      try {
        decodeMcpOAuthTokenRecord(raw);
      } catch (e) {
        err = e;
      }
      expect([raw.slice(0, 20), (err as McpOAuthError).code]).toEqual([raw.slice(0, 20), "malformed_record"]);
      expect((err as Error).message).not.toContain("secret-value");
    }
    expect(codeOf(() => decodeMcpOAuthClientRecord(JSON.stringify({ v: 1, kind: "mcp-oauth-client", serverUrl: "https://x", issuer: "https://x", clientId: "c", registeredVia: "magic", redirectUri: "http://127.0.0.1:1/callback" })))).toBe("malformed_record");
  });

  test("the lenient read treats a malformed item as not-signed-in but still refuses a NEWER version", async () => {
    const store = createMemoryMcpOAuthStore({ "mcp-oauth:0000000000000000": "{broken", "mcp-oauth:1111111111111111": JSON.stringify({ ...TOKEN, v: 9 }) });
    expect(await readTokenRecordLenient(store, "mcp-oauth:0000000000000000")).toBeNull();
    await expect(readTokenRecordLenient(store, "mcp-oauth:1111111111111111")).rejects.toMatchObject({ code: "unsupported_record_version" });
  });
});

describe("the public subpath", () => {
  test("resolves by its PUBLIC specifier and exports the contract's names", () => {
    expect(subpath.mcpOAuthAccountId).toBe(mcpOAuthAccountId);
    expect(typeof subpath.startMcpOAuthLogin).toBe("function");
    expect(typeof subpath.refreshMcpOAuthToken).toBe("function");
    expect(typeof subpath.revokeMcpOAuth).toBe("function");
    expect(subpath.MCP_OAUTH_REFRESH_SUBTYPE).toBe("mcp_oauth_refresh");
    expect(subpath.MCP_STATUS_NEEDS_AUTH).toBe("needs-auth");
    expect(subpath.WINTER_MCP_CLIENT_METADATA_URL).toBe("https://yanlinglabs.com/winter/oauth-client.json");
  });
});
