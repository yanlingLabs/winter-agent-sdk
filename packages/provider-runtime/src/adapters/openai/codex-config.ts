// Codex OAuth parity constants, ported from Norma's `packages/core/src/providers/codex-config.ts`.
//
// Every value below is carried VERBATIM from that port — which in turn tracks codex-rs
// @216dee1189fd589ea6c0741a5f92f578a3ca4640 (2026-06-12): `clientId`, `backendUrl` and `tokenUrl`
// from `login/src/auth/manager.rs`; `authorizeUrl`, `callbackPort` and `scope` from
// `login/src/server.rs`; the `OpenAI-Beta` header key from `core/src/client.rs`.
//
// ============================================================================================
// `originator` IS DELIBERATELY NOT A FIRST-PARTY VALUE, AND MUST NEVER BE MADE ONE.
//
// codex-rs sends its own first-party originator, which earns first-party treatment from the
// ChatGPT backend. Winter sends `"winter"` instead: it is an independent client and says so
// honestly rather than impersonating OpenAI's own CLI to obtain that treatment. The tradeoff is
// accepted and stated — OpenAI's backend can distinguish (and, if it ever chooses, cleanly gate)
// Winter traffic, and the BYO-API-key path through `openai-responses@1` is the sanctioned fallback
// if the ChatGPT-OAuth route is ever restricted.
//
// This is a HARD RULE (WS-01 §3, carried from Norma's own): do NOT revert it to a first-party
// value to chase fingerprint parity. `codex-oauth.test.ts` asserts the value, so a change here
// fails a test that explains itself.
// ============================================================================================

export const CODEX = {
  /** OAuth application id — shared by all Codex CLI clients. */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",

  /** Authorization endpoint: `{issuer}/oauth/authorize`. */
  authorizeUrl: "https://auth.openai.com/oauth/authorize",

  /** Token exchange + refresh endpoint. */
  tokenUrl: "https://auth.openai.com/oauth/token",

  /** Local callback port (primary). */
  callbackPort: 1455,

  /** The fallback port, per codex-rs's own allow-list. A login refuses rather than drifting onto an arbitrary port. */
  fallbackCallbackPort: 1457,

  /** OAuth scopes — codex-rs's own scope string from `build_authorize_url`. */
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",

  /** Base URL for the ChatGPT Codex backend; `/responses` is appended for a turn. */
  backendUrl: "https://chatgpt.com/backend-api/codex",

  headers: {
    /** PROTOCOL: the Responses surface on this backend requires it. */
    "OpenAI-Beta": "responses=experimental",
    /** PRIVILEGED (R6-L). See this file's header for why the value is `"winter"` and must stay that way. */
    originator: "winter",
  } as Record<string, string>,
} as const;

/** The `originator` value, exported so a fixture asserts on it by name rather than by string literal. */
export const CODEX_ORIGINATOR = "winter";

/**
 * The date `CODEX_MODELS` was last checked against the live `/models` catalogue, carried from the
 * port. It lives next to the data it dates so the two cannot drift apart.
 */
export const CODEX_MODELS_VERIFIED = "2026-07-31";

/**
 * The static Codex model set.
 *
 * The backend returns only these slugs for ChatGPT-account auth; other OpenAI model ids answer
 * HTTP 400 ("not supported when using Codex with a ChatGPT account"), so this is an ALLOW-LIST in
 * effect and not merely a convenience. `contextWindow` is 272000 for every model the catalogue
 * offers — a number the port records as having been WRONG once (372000, hand-transcribed), which
 * put an auto-compaction threshold above the backend's own hard ceiling and killed compaction
 * silently. Re-derive it from the live catalogue; never edit it by hand.
 */
export const CODEX_MODELS: ReadonlyArray<{ id: string; contextWindow: number; supportsVision: boolean }> = [
  { id: "gpt-5.6-sol", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-terra", contextWindow: 272_000, supportsVision: true },
  { id: "gpt-5.6-luna", contextWindow: 272_000, supportsVision: true },
];

export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

/** The Keychain account a codex credential occupies: `codex-oauth:<accountId>` (R6-10's one-record-per-provider/account rule). */
export function codexCredentialAccount(accountId: string): string {
  return `codex-oauth:${accountId}`;
}
