// D20 (RETIRED 2026-09-13, P10a-1): this file used to run the Anthropic Console PKCE login itself,
// re-implementing Claude Code's private client. On 2026-09-13 the platform refused that grant for
// every derivable request shape, and the user ruled that Console OAuth goes ONLY through Anthropic's
// own brokers -- `claude auth login --console` (the official leg) and `ant auth print-credentials`
// (the native provider) -- never a re-implementation of the OAuth protocol itself. THIS FILE must
// never implement THAT again. What replaced it -- `console-broker.ts`, which SPAWNS those two
// binaries rather than speaking OAuth to Anthropic directly -- is a same-day AMENDMENT to where the
// broker lives: the user's first ruling put it solely in Winter's daemon; the amendment puts it in
// this SDK too, beside `codex-oauth.ts`/`xai-oauth.ts`, so every login lane is in one place. See that
// file's own banner for what it does and what was measured about the binaries it drives.
//
// WHAT SURVIVES, and why each one still earns its place with no login attached to it:
//
//   `ANTHROPIC_CONSOLE_PROVIDER_ID` -- the provider-id gate `messages.ts` uses to keep the beta
//     header (and, before this retirement, the self-refresh) scoped to the `anthropic` row and never
//     a sibling `<id>-anthropic` row (R6b-5). A gate that scopes a HEADER is not part of the login.
//
//   `anthropicCredentialRef` -- the one spelling of an Anthropic credential's Keychain record name
//     (R6-10). A host still needs to name the record `ant auth print-credentials`' bearer material
//     lands in, and a host that assembled `anthropic:<id>` by hand would eventually assemble it
//     differently from whatever reads it back.
//
//   `CONSOLE_BEARER.betaHeader` -- the `anthropic-beta` value `messages.ts` sends alongside an
//     `oauth`-kind credential's bearer. Kept, not because a login produces one anymore, but because
//     retiring the header would be a SEPARATE, unmeasured decision (P10a-1's own M3 task): "keep
//     whichever works, pin by test". Renamed from `CONSOLE_OAUTH` because that name now describes a
//     login this file no longer performs; `CONSOLE_BEARER` names what is actually left.
//
// WHAT IS GONE, for good: `startAnthropicConsoleLogin`, `AnthropicConsoleLoginOptions/Result`,
// `fetchAccountId`, `materialFor`, and the login-only fields of the old `CONSOLE_OAUTH` object
// (`clientId`, `authorizeUrl`, `tokenUrl`, `profileUrl`, `callbackPort`, `callbackPath`,
// `extraAuthorizeParams`, `accountIdPath`, `scope`) — every one of them existed only to run or refresh
// the PKCE flow. `OAUTH_REFRESH_WINDOW_MS` is gone with them: renewal is the host broker's job now
// (`ant auth print-credentials`, 60 s before `expiresAt`, per P10a-4), not a self-refresh this
// adapter drove with `CONSOLE_OAUTH.tokenUrl`/`clientId`.
//
// The full derivation record — every field this file used to ship, where each one came from in the
// pinned `@anthropic-ai/claude-agent-sdk@0.3.250` artifact, and why D21 excluded the rest — stays on
// the record at `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6b.md` §2 (now headed
// "RETIRED — host-brokered per the 2026-09-13 ruling") and `derived-p6b.ts` (unchanged: the typed
// twin of that history). Nothing here disputes that derivation; it is simply no longer what ships.
import type { CredentialRef } from "../../types.ts";

/**
 * The ONE provider id whose `oauth` credential is an Anthropic Console one.
 *
 * NOT A FORMALITY, and the reason it is a named constant rather than a string literal in a
 * condition: R6b-5 makes this adapter MULTI-PROVIDER — a third party that speaks the Anthropic
 * Messages dialect ships as its own `<id>-anthropic` row on this same `adapterId`, with its own
 * `defaultEndpoints.api`. Nothing upstream of the adapter checks that a stored credential's KIND
 * matches its row's `authKinds`, so without this gate a sibling row's `oauth` credential would have
 * Anthropic's beta stamped on its request — a third party's turn wearing Anthropic's own header.
 */
export const ANTHROPIC_CONSOLE_PROVIDER_ID = "anthropic";

/**
 * What survives of the old `CONSOLE_OAUTH` object once its login-only fields are gone: the ONE header
 * value `messages.ts` still sends alongside an Anthropic Console credential's bearer -- an `oauth`-
 * kind one, or (P10a, M5) a `bearer`-kind one from the host-brokered `console-broker.ts` leg, on the
 * `anthropic` provider row only (`isConsoleProvider`).
 *
 * See the file banner for why this is renamed rather than trimmed in place. P10a-1/M3 measured that
 * the header belongs on the `anthropic` row's bearer material too, not only on `oauth`; see
 * `messages.ts`'s `buildHeaders` for the settled gate.
 */
export const CONSOLE_BEARER = {
  /** The `anthropic-beta` value that accompanies an OAuth or Console bearer on every request. */
  betaHeader: "oauth-2025-04-20",
} as const;

/**
 * The ONE spelling of an Anthropic OAuth/bearer record's name (R6-10).
 *
 * Exported and used by both a host's broker and the adapter, because a host that assembles
 * `anthropic:<id>` by hand will eventually assemble it differently from whatever reads it — a
 * credential written to a key nothing looks up, failing as "no credential configured" with the
 * record sitting right there.
 */
export function anthropicCredentialRef(accountId: string, service?: string): Extract<CredentialRef, { kind: "keychain" }> {
  return { kind: "keychain", account: `anthropic:${accountId}`, ...(service !== undefined ? { service } : {}) };
}
