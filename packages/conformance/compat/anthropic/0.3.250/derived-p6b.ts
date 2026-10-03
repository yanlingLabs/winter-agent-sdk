// The §3 table of `derived-shapes-p6b.md`, as typed data.
//
// RETIRED AS A LOGIN, KEPT AS A RECORD (2026-09-13, P10a-1). The login these values once shipped as
// `CONSOLE_OAUTH` is gone -- Console OAuth is host-brokered now (`console-broker.ts`, spawning
// `ant`, never speaking OAuth to Anthropic directly). The table is unchanged; only `betaHeader` still
// has a shipped consumer (`CONSOLE_BEARER.betaHeader` in `console-oauth.ts`, asserted against
// `DERIVED.consoleOauth.betaHeader` alone, not field-by-field). See `derived-shapes-p6b.md` §1.
//
// WHY A SECOND FILE SAYING THE SAME THING. `derived-shapes-p6b.md` is prose a human reads; nothing
// makes the code agree with it. This file is the same values in a form a TEST can compare against,
// so a constant that drifts fails a test rather than quietly diverging.
//
// This file holds NO credential: a public OAuth client id, three vendor URLs, two scope strings and
// a beta header value are configuration.

/** The Anthropic Console OAuth constants (D20) for the pinned 0.3.250 runtime. */
export const DERIVED = {
  consoleOauth: {
    /** The client id. A PUBLIC PKCE client id -- no client secret exists. */
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    /**
     * The Console authorize endpoint -- the Console host, which is what D20 is. The consumer
     * subscription login's authorize host is recorded in the document as excluded by D13/D14 and is
     * deliberately NOT here: a constant that exists is a constant something can come to use.
     */
    authorizeUrl: "https://platform.claude.com/oauth/authorize",
    /** The token endpoint. Serves both the authorization-code and the refresh grant. */
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    /** Where the account id comes from -- a separate authenticated GET, NOT a claim in the token response. */
    profileUrl: "https://api.anthropic.com/api/oauth/profile",
    /**
     * A WINTER-AUTHORED SUBSET of the vendor's scope vocabulary, space-joined. `user:inference` is the
     * scope a token needs to run a turn; `user:profile` authorises the account lookup that names the
     * credential record. The vendor's default list is excluded whole: it carries the vendor
     * application's own entitlements and the API-key-minting scope, whose only consumer is a
     * `claude_cli`-scoped endpoint (D21).
     */
    scope: "user:inference user:profile",
    /** `code=true` is the authorize request's first parameter. */
    extraAuthorizeParams: { code: "true" },
    /**
     * `0` -- an ephemeral port. The redirect URI is `http://localhost:<port>/callback` with a
     * caller-chosen port, so this client's registration accepts a loopback URI on any port
     * (RFC 8252 §7.3). That is the opposite of codex, whose 1455/1457 pair is fixed because its
     * registration is.
     */
    callbackPort: 0,
    /** The callback PATH. Not `pkce.ts`'s own default of `/auth/callback`. */
    callbackPath: "/callback",
    /** The `oauth_auth` beta header value. It always travels with an `Authorization: Bearer`, never `x-api-key`. */
    betaHeader: "oauth-2025-04-20",
    /** The profile-response field that names the record: `{ account: { uuid } }`. */
    accountIdPath: "account.uuid",
  },
} as const;
