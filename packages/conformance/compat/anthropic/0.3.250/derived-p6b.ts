// The §3 table of `derived-shapes-p6b.md`, as typed data.
//
// WHY A SECOND FILE SAYING THE SAME THING. `derived-shapes-p6b.md` is prose a human reads; nothing
// makes the code agree with it. This file is the same values in a form a TEST can compare against,
// and `packages/provider-runtime/src/adapters/anthropic/console-oauth.test.ts` asserts
// `CONSOLE_OAUTH` field-by-field against it. So a constant that drifts — in either direction — fails
// a test rather than quietly diverging from its own derivation.
//
// EVERY VALUE HERE WAS READ OUT OF THE PINNED ARTIFACT, never typed from memory. The document beside
// this file records the byte offset each one came from and the two-artifact checksum chain that made
// the read hermetic. Nothing else from the artifact is committed.
//
// This file holds NO credential: a public OAuth client id, three vendor URLs, two scope strings and
// a beta header value are configuration, all of them shipped in a public npm package.

/** The Anthropic Console OAuth constants (D20) derived from `@anthropic-ai/claude-agent-sdk@0.3.250`. */
export const DERIVED = {
  consoleOauth: {
    /** `CLIENT_ID`. A PUBLIC PKCE client id from a public artifact — no client secret exists. */
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    /**
     * `CONSOLE_AUTHORIZE_URL` — the Console host, which is what D20 is.
     * The artifact's OTHER authorize host (`CLAUDE_AI_AUTHORIZE_URL`, the consumer subscription
     * login) is recorded in the document as excluded by D13/D14 and is deliberately NOT here: a
     * constant that exists is a constant something can come to use.
     */
    authorizeUrl: "https://platform.claude.com/oauth/authorize",
    /** `TOKEN_URL`. Serves both the authorization-code and the refresh grant. */
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    /** Where the account id comes from — a separate authenticated GET, NOT a claim in the token response. */
    profileUrl: "https://api.anthropic.com/api/oauth/profile",
    /**
     * A WINTER-AUTHORED SUBSET of the artifact's scope vocabulary, space-joined as its own builder
     * joins them. `user:inference` is the artifact's own inference scope (its "can this token run a
     * turn" predicate tests for exactly it); `user:profile` authorises the account lookup that names
     * the credential record. The artifact's DEFAULT list is the union of two larger lists and is
     * excluded whole: it carries the vendor application's own entitlements and the API-key-minting
     * scope whose only consumer is a `claude_cli`-scoped endpoint (D21).
     */
    scope: "user:inference user:profile",
    /**
     * `0` — an ephemeral port, which is the DERIVED behaviour rather than a fallback.
     * The artifact builds its redirect URI as `http://localhost:${port}/callback` with a runtime
     * variable, so this client's registration accepts a loopback URI on any port (RFC 8252 §7.3).
     * That is the opposite of codex, whose 1455/1457 pair is fixed because its registration is.
     */
    callbackPort: 0,
    /** The artifact's callback PATH. Not `pkce.ts`'s own default of `/auth/callback`. */
    callbackPath: "/callback",
    /**
     * The header value of the beta the artifact itself names `oauth_auth`. All 13 sites that set it
     * also set an `Authorization: Bearer`, and none of those sites sends `x-api-key`.
     */
    betaHeader: "oauth-2025-04-20",
    /** The profile-response field that names the record: `{ account: { uuid } }`. */
    accountIdPath: "account.uuid",
  },
} as const;
