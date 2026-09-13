// Phase 6 Task 6 (Lane B): the Anthropic family's own barrel.
//
// The package barrel (`src/index.ts`) is FROZEN (R6-12) and this package's `exports` map publishes
// only `.`, so a consumer outside the package reaches an adapter through a relative path to THIS
// file. Keeping the family's surface in one place is what makes that path stable.
export {
  ANTHROPIC_ADAPTER_ID,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  createAnthropicMessagesAdapter,
  findDescriptor,
  mapAnthropicEffort,
  toWireMessages,
} from "./messages.ts";
export type { AnthropicAdapterOptions, EffortMapping } from "./messages.ts";
// D20 (RETIRED 2026-09-13, P10a-1): the derived-PKCE Console OAuth login (Claude Code's own private
// client id, re-implemented) is gone for good -- `console-oauth.ts`'s banner has the full account.
// What remains from that file is the credential-naming helper and the `anthropic-beta` value
// `messages.ts` still sends alongside an `oauth`-kind Anthropic credential's bearer. See
// `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6b.md` §2 (headed RETIRED) for the
// full derivation record that login once shipped.
export { ANTHROPIC_CONSOLE_ACCOUNT_ID, ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT, CONSOLE_BEARER, anthropicCredentialRef } from "./console-oauth.ts";
// D20, host-brokered (P10a-1 AMENDMENT, 2026-09-13; corrected Lane S round 2): Console sign-in
// through Anthropic's OWN `ant` broker binary (`auth login`/`auth logout`/`auth print-credentials`)
// -- spawned by the SDK runtime, never a re-implementation of the OAuth protocol, and never `claude`
// (a live measurement found `claude auth login --console` writes no Anthropic profile for this org).
// See `console-broker.ts`'s own banner for the full measured account.
export {
  DEFAULT_ANTHROPIC_CONSOLE_PROFILE,
  anthropicConsoleProfileExists,
  logoutAnthropicConsole,
  refreshAnthropicBearer,
  startAnthropicConsoleBrokerLogin,
} from "./console-broker.ts";
export type { AnthropicConsoleBrokerOptions, AnthropicConsoleLoginHandle } from "./console-broker.ts";
