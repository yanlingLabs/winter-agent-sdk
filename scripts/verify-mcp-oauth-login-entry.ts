// WS-25 -- `verify:mcp-oauth`'s LOGIN leg, as its own compiled entry: the host's sign-in door
// (`@yanlinglabs/winter-agent-runtime/mcp-auth`'s `startMcpOAuthLogin`) run from a `bun build --compile`d
// binary, so the MCP client package's `auth()` (discovery, registration, PKCE, the code exchange) is
// proved to survive `$bunfs` exactly as a host that compiles it (Winter's daemon) would run it.
//
// Protocol with the gate (stdout, one JSON line each): `{"authUrl","issuerOrigin"}` once the listener is
// up, then `{"done": <outcome>}`. The sign-in lands in the TEST file store named by `--store` -- the gate
// is hermetic and never touches a Keychain.
//
// Usage: <binary> --server <mcp url> --store <file>
import { startMcpOAuthLogin } from "@yanlinglabs/winter-agent-runtime/mcp-auth";
import { createTestFileMcpOAuthStore } from "../packages/runtime/src/mcp-auth/store.ts";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined) throw new Error(`verify-mcp-oauth-login-entry: missing ${name}`);
  return value;
}

const login = await startMcpOAuthLogin({ serverUrl: arg("--server"), store: createTestFileMcpOAuthStore(arg("--store")), timeoutMs: 60_000 });
process.stdout.write(`${JSON.stringify({ authUrl: login.authUrl, issuerOrigin: login.issuerOrigin })}\n`);
process.stdout.write(`${JSON.stringify({ done: await login.done })}\n`);
