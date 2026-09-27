// WS-25 (MCP OAuth) §2: the two records an MCP sign-in is stored as -- JSON in a Keychain item, never on
// disk -- and their codec.
//
// VALIDATED ON READ, never cast. A Keychain item can be written by an older or NEWER Winter, by a host's
// own tooling, or by hand; a cast would let a malformed one surface as an unreadable failure deep inside a
// transport's `Authorization` header. A record from an unknown `v` is refused TYPED
// (`unsupported_record_version`) rather than read as far as it happens to parse: a newer Winter may have
// changed what a field means, and a downgrade must not act on a guess. Unknown EXTRA keys on a known `v`
// are dropped (a newer minor addition is not a reason to lose the sign-in).
//
// No message here ever quotes a value -- the values are the secrets.
import { McpOAuthError } from "./errors.ts";

/**
 * The sign-in a SESSION reads (`mcp-oauth:<id>`). `generation` counts writes: every refresh and every new
 * sign-in bumps it, and the `mcp_oauth_refresh` request carries the generation the session last read, so a
 * host that already refreshed past it answers without posting again.
 *
 * `expiresAt` is epoch MILLISECONDS, absent when the token endpoint gave no `expires_in` -- such a token is
 * treated as valid until the server answers 401 (spec §1.2).
 */
export interface McpOAuthTokenRecord {
  v: 1;
  kind: "mcp-oauth";
  serverUrl: string;
  issuer: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  generation: number;
}

/**
 * The client registration only the HOST reads (`mcp-oauth-client:<id>`): which client Winter is to this
 * server's authorization server, how it got that identity, and where the sign-in's callback listens.
 *
 * - `registeredVia` -- `"preregistered"` (the config's `oauth.clientId`), `"cimd"` (the client id IS the
 *   Client ID Metadata Document's URL) or `"dcr"` (RFC 7591 Dynamic Client Registration).
 * - `redirectUri` -- the exact loopback redirect this client registered or last used,
 *   `http://127.0.0.1:<port>/callback`. For DCR it is the registration's own, and its port is reused on
 *   the next sign-in (spec §1.6).
 * - `resourceMetadataUrl` / `authorizationServerUrl` -- where discovery found the RFC 9728 and RFC 8414
 *   documents, so a refresh re-reads them without a probe of the MCP server.
 * - `stepUpScope` -- a scope a `403 insufficient_scope` asked for; the next sign-in requests it.
 */
export interface McpOAuthClientRecord {
  v: 1;
  kind: "mcp-oauth-client";
  serverUrl: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  registeredVia: "dcr" | "cimd" | "preregistered";
  redirectUri: string;
  resourceMetadataUrl?: string;
  authorizationServerUrl?: string;
  stepUpScope?: string;
}

const REGISTERED_VIA: ReadonlySet<string> = new Set(["dcr", "cimd", "preregistered"]);

function parseObject(raw: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpOAuthError("malformed_record", `the ${what} record is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new McpOAuthError("malformed_record", `the ${what} record is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function checkEnvelope(o: Record<string, unknown>, kind: string, what: string): void {
  // `v` FIRST: a newer record is refused as newer, even when its `kind` or fields also moved.
  if (o.v !== 1) {
    throw new McpOAuthError(typeof o.v === "number" ? "unsupported_record_version" : "malformed_record", `the ${what} record has ${typeof o.v === "number" ? `version ${o.v}, which this Winter does not read` : "no version"}`);
  }
  if (o.kind !== kind) throw new McpOAuthError("malformed_record", `the ${what} record is not of kind "${kind}"`);
}

function requireString(o: Record<string, unknown>, key: string, what: string): string {
  const value = o[key];
  if (typeof value !== "string" || value.length === 0) throw new McpOAuthError("malformed_record", `the ${what} record has no "${key}"`);
  return value;
}

function optionalString(o: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new McpOAuthError("malformed_record", `the ${what} record's "${key}" is not a string`);
  return value;
}

export function decodeMcpOAuthTokenRecord(raw: string): McpOAuthTokenRecord {
  const what = "MCP sign-in";
  const o = parseObject(raw, what);
  checkEnvelope(o, "mcp-oauth", what);
  const generation = o.generation;
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) {
    throw new McpOAuthError("malformed_record", `the ${what} record's "generation" is not a non-negative integer`);
  }
  const expiresAt = o.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) {
    throw new McpOAuthError("malformed_record", `the ${what} record's "expiresAt" is not a number`);
  }
  const refreshToken = optionalString(o, "refreshToken", what);
  const scope = optionalString(o, "scope", what);
  return {
    v: 1,
    kind: "mcp-oauth",
    serverUrl: requireString(o, "serverUrl", what),
    issuer: requireString(o, "issuer", what),
    accessToken: requireString(o, "accessToken", what),
    ...(refreshToken !== undefined && refreshToken !== "" ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(scope !== undefined ? { scope } : {}),
    generation,
  };
}

export function decodeMcpOAuthClientRecord(raw: string): McpOAuthClientRecord {
  const what = "MCP client registration";
  const o = parseObject(raw, what);
  checkEnvelope(o, "mcp-oauth-client", what);
  const registeredVia = o.registeredVia;
  if (typeof registeredVia !== "string" || !REGISTERED_VIA.has(registeredVia)) {
    throw new McpOAuthError("malformed_record", `the ${what} record's "registeredVia" is not dcr, cimd or preregistered`);
  }
  const clientSecret = optionalString(o, "clientSecret", what);
  const resourceMetadataUrl = optionalString(o, "resourceMetadataUrl", what);
  const authorizationServerUrl = optionalString(o, "authorizationServerUrl", what);
  const stepUpScope = optionalString(o, "stepUpScope", what);
  return {
    v: 1,
    kind: "mcp-oauth-client",
    serverUrl: requireString(o, "serverUrl", what),
    issuer: requireString(o, "issuer", what),
    clientId: requireString(o, "clientId", what),
    ...(clientSecret !== undefined && clientSecret !== "" ? { clientSecret } : {}),
    registeredVia: registeredVia as McpOAuthClientRecord["registeredVia"],
    redirectUri: requireString(o, "redirectUri", what),
    ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
    ...(authorizationServerUrl !== undefined ? { authorizationServerUrl } : {}),
    ...(stepUpScope !== undefined && stepUpScope !== "" ? { stepUpScope } : {}),
  };
}

/** Serialises a token record (re-validated, so an in-memory object built by hand cannot store garbage). */
export function encodeMcpOAuthTokenRecord(record: McpOAuthTokenRecord): string {
  const text = JSON.stringify(record);
  decodeMcpOAuthTokenRecord(text);
  return text;
}

/** Serialises a client record (re-validated, like `encodeMcpOAuthTokenRecord`). */
export function encodeMcpOAuthClientRecord(record: McpOAuthClientRecord): string {
  const text = JSON.stringify(record);
  decodeMcpOAuthClientRecord(text);
  return text;
}

// --- Fix round 2 (I-A): the pre-registered client secret, BOUND TO ITS ISSUER --------------------------

/**
 * The item at `mcp-oauth-client-secret:<id>`. A secret is only ever sent to the authorization server it
 * belongs to: a config source that can redeclare the server (a trusted project overriding the user's
 * scope) could otherwise point `authServerMetadataUrl` at its own token endpoint and have a Sign in click
 * post the user's secret there.
 *
 * - `issuer` present: the secret goes to that issuer only (the host set it when the user knew it --
 *   `encodeMcpOAuthClientSecretItem(secret, expectedIssuer)`, or the sign-in stamped it, below).
 * - `issuer` absent: TRUST ON FIRST USE -- the first SUCCESSFUL pre-registered sign-in stamps the issuer it
 *   used, and every later sign-in must match it (so does an existing pre-registered client record's).
 *
 * A bare string (a secret a host wrote before this shape) reads as `{ secret, issuer: undefined }`.
 */
export interface McpOAuthClientSecretItem {
  secret: string;
  issuer?: string;
}

export function decodeMcpOAuthClientSecretItem(raw: string): McpOAuthClientSecretItem {
  if (raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === "object" && parsed !== null && (parsed as { kind?: unknown }).kind === "mcp-oauth-client-secret") {
      const o = parsed as Record<string, unknown>;
      if (o.v !== 1) throw new McpOAuthError(typeof o.v === "number" ? "unsupported_record_version" : "malformed_record", "the MCP client secret record has an unreadable version");
      if (typeof o.secret !== "string" || o.secret === "") throw new McpOAuthError("malformed_record", 'the MCP client secret record has no "secret"');
      if (o.issuer !== undefined && (typeof o.issuer !== "string" || o.issuer === "")) throw new McpOAuthError("malformed_record", 'the MCP client secret record\'s "issuer" is not a string');
      return { secret: o.secret, ...(typeof o.issuer === "string" ? { issuer: o.issuer } : {}) };
    }
  }
  return { secret: raw };
}

/** What a host writes at `mcpOAuthClientSecretAccount(serverUrl)`; `expectedIssuer` binds it up front. */
export function encodeMcpOAuthClientSecretItem(secret: string, expectedIssuer?: string): string {
  if (secret === "") throw new McpOAuthError("malformed_record", "an MCP client secret cannot be empty");
  return JSON.stringify({ v: 1, kind: "mcp-oauth-client-secret", secret, ...(expectedIssuer !== undefined ? { issuer: expectedIssuer } : {}) });
}

/** Issuer equality as the MCP client compares it: exact, or differing only by one trailing slash. */
export function sameIssuer(a: string, b: string): boolean {
  return a === b || a === `${b}/` || `${a}/` === b;
}
