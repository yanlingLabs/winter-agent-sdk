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
// D20: the Console OAuth login and its DERIVED constants. A credential lifecycle, not a second
// adapter -- an Anthropic Console token speaks the ordinary Messages dialect to the ordinary
// endpoint, so `messages.ts` gains an arm and the `anthropic` row gains an `authKind`. See
// `packages/conformance/compat/anthropic/0.3.250/derived-shapes-p6b.md` for where every constant
// came from and for the whole of that artifact's OAuth surface that Winter deliberately refuses.
export { CONSOLE_OAUTH, OAUTH_REFRESH_WINDOW_MS, anthropicCredentialRef, startAnthropicConsoleLogin } from "./console-oauth.ts";
export type { AnthropicConsoleLoginOptions, AnthropicConsoleLoginResult } from "./console-oauth.ts";
