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
