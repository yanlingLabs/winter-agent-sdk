// `@yanlinglabs/winter-agent-sdk/tools` — WINTER'S DEFAULT TOOLS, declared and implemented once
// (user ruling R-8-1, 2026-09-10).
//
// THE RULING, and why this subpath is its shape. The router owns NO tool. The daemon owns the
// capability tools (computer/browser/office) and passes them down. Winter's own default tools —
// `send_message`, `list_agents`, `read_notifications`, `advisor` — are WINTER'S: the router PULLS
// them from here and binds them under the official runtime's built-in names, and nothing is ever
// re-bound back into Winter. So the definitions, the acceptors, the handler factories and the
// advisor live in the one package both hosts already depend on.
//
// WHAT WAS TRUE BEFORE IT: three copies. The Winter runtime held its own descriptors and executors;
// the router package held a second set of schemas and acceptors (`src/native-args.ts`) and a second
// set of handlers (`src/messaging/handlers.ts`). They were near-identical — and where they differed,
// they differed on the MODEL-VISIBLE contract: one refused a bare `"*"` and the other refused `"*"`
// anywhere; one refused an overlong `summary` and the other truncated it; one marked a `refused`
// outcome as an error result and the other did not. WS-10 §10.1 requires "this exact model-facing
// schema" on both branches, so a second copy is not duplication to tidy up: it is the schema
// drifting between branches, in the one place a test in either host alone cannot see. Ruling P-4
// settled each divergence; this subpath is where the settlement lives.
//
// A SEPARATE SUBPATH because a consumer of `query()` needs none of it, and because a host that binds
// Winter's tools should not have to take the wrapper's whole surface to do it.
//
// WHAT IS DELIBERATELY NOT HERE (ruling P-8): registry POLICY. `source`, `exposure`, `availability`,
// `capabilityRequirements`, `disposition` and `deferred` are each host's own answer — the Winter
// runtime's `resolveDeferral` short-circuits `source: "builtin"` to eager unconditionally, so the
// value is not even portable. A shared field would silently decide Tool-Search eligibility for both
// hosts from a package neither of them owns.

// --- the schemas and their bounds (WS-10 §10.1/§10.2, WS-06 §4) -----------------------------------
export {
  SEND_MESSAGE_TO_MAX,
  SEND_MESSAGE_SUMMARY_MAX,
  LIST_AGENTS_FIELD_MAX,
  NATIVE_SEND_MESSAGE_SCHEMA,
  NATIVE_LIST_AGENTS_SCHEMA,
  NATIVE_LIST_AGENTS_OUTPUT_SCHEMA,
  NATIVE_READ_NOTIFICATIONS_SCHEMA,
  NATIVE_READ_NOTIFICATIONS_OUTPUT_SCHEMA,
  NATIVE_ADVISOR_SCHEMA,
  NATIVE_ADVISOR_OUTPUT_SCHEMA,
} from "./schemas.ts";
export type { JsonSchemaObject } from "./schemas.ts";

// --- the four definitions: one tool, declared once; BARE names ------------------------------------
export { SEND_MESSAGE_DEFINITION, LIST_AGENTS_DEFINITION, READ_NOTIFICATIONS_DEFINITION, ADVISOR_DEFINITION, WINTER_DEFAULT_TOOL_DEFINITIONS } from "./definitions.ts";
export type { WinterToolDefinition } from "./definitions.ts";

// --- the acceptors: strict on unknown fields, summary truncated, the empty-message rule (P-4) -----
export { acceptNativeSendMessageArgs, acceptNativeListAgentsArgs, acceptNativeReadNotificationsArgs, deriveSendMessageSummary } from "./accept.ts";
export type { NativeSendMessageArgs, NativeListAgentsArgs, NativeArgsResult } from "./accept.ts";

// --- the messaging port (ruling P-3) --------------------------------------------------------------
export { messagingToolPortFromRuntimeDeps, callerAddress } from "./port.ts";
export type { MessagingToolPort } from "./port.ts";

// --- the handler factories ------------------------------------------------------------------------
export { createMessagingToolHandlers, toolUseIdFromExtra, VENDOR_TOOL_USE_ID_META_KEY } from "./messaging-handlers.ts";
export type { WinterToolCaller, WinterToolResult, WinterToolHandler, MessagingToolHandlers } from "./messaging-handlers.ts";

// --- the advisor (ruling P-6) ---------------------------------------------------------------------
export { ADVISOR_DEFAULT_MAX_CHARS, OPAQUE_MARKERS, stripOpaqueMarkers, assembleReviewerMessages, createAdvisorToolHandler, transcriptSourceForSessionKey } from "./advisor.ts";
export type { TranscriptEntry, TranscriptSource, AdvisorReviewerRequest, AdvisorReviewerTurn, AdvisorReviewer, ResolvedReviewer, ReviewerResolver, AdvisorToolDeps } from "./advisor.ts";

// --- pass-through re-exports, so a `/tools` consumer needs ONE import ------------------------------
//
// Every one of these is already published from another subpath; re-exporting the TYPES here costs a
// consumer nothing at runtime and saves it from importing `/messaging` purely to name the argument
// of a function this module handed it.
export type { RuntimeAddress, ListedRuntimeObject, SendMessageResult, NotificationRecord, MessagingRuntimeDeps } from "../messaging/index.ts";
export type { SessionKey, SessionStore } from "../store/session-store.ts";
