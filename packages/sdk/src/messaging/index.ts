// `@yanlinglabs/winter-agent-sdk/messaging` — the cross-runtime messaging contract and its router
// core (WS-10 §10–§15), published under R-7b-4 ("move down into it").
//
// WHAT IS HERE, and why it is a SUBPATH rather than part of the main barrel. Three parties must
// agree on these shapes and share these rules:
//
//   * the Winter runtime, whose in-process reference adapter serves a session's own children;
//   * `@yanlinglabs/winter-runtime-sdk`, whose RuntimeDirectory composes this same core with TWO
//     `RuntimeMessagingAdapter`s (Winter, official) so a Claude-driven session can resume a Winter
//     agent and a Winter session can resume a Claude child;
//   * any host that wires the two together.
//
// A separate subpath because a consumer of `query()` needs none of it, and because "the messaging
// contract" is a thing a reuser can implement against without taking the wrapper's surface with it.
//
// WHAT IS DELIBERATELY NOT HERE:
//   * the process-level runtime SINGLETON (`registerMessagingRuntime`/`getMessagingRuntime`) — that
//     is host composition, and a library must not hand every consumer one shared mutable slot;
//   * any ADAPTER. WS-10 §15: "adapters perform owner-specific operations only." The Winter
//     runtime's in-process reference adapter stays in the runtime; the router package writes its own
//     two. This module owns the CONTRACT they satisfy and the rules that run before any of them.
//   * the model-facing `SendMessage`/`ListAgents` tool schemas (WS-10 §10.1/§10.2) — those are a
//     runtime's tool surface, not a messaging seam.

// --- the contract: addresses, listings, outcomes, the envelope, the adapter, the child boundary ---
export {
  serializeRuntimeAddress,
  createFakeMessagingRouterSeam,
} from "./adapter.ts";
export type {
  RuntimeKind,
  RuntimeObjectKind,
  RuntimeAddress,
  ListedRuntimeObject,
  DeliveryOutcome,
  GlobalAgentMessage,
  RuntimeMessagingAdapter,
  MessagingRouterSeam,
  FakeMessagingRouterSeam,
  ChildLike,
  ChildLikeRecord,
  ChildLikeStatus,
} from "./adapter.ts";

// --- addressing: the `to`-field grammar and the inverse of the canonical serialization ------------
export {
  REFERENCE_RUNTIME_KIND,
  validateToField,
  buildSessionAddress,
  buildChildAddress,
  parseRuntimeAddress,
  sameAddress,
} from "./addressing.ts";
export type { ToFieldValidation } from "./addressing.ts";

// --- the numeric bounds, the DeliveryOutcome factories, the loop guard ----------------------------
export {
  MAX_GLOBAL_MESSAGE_SIZE,
  DEFAULT_MESSAGE_TTL_MS,
  MAX_HOP_COUNT,
  RAPID_REPEAT_WINDOW_MS,
  HELD_INBOX_CAP,
  ACCEPTED_QUEUE_CAP,
  DEFAULT_HOLD_EXPIRY_MS,
  NOTIFY_IDLE_EXPIRY_MS,
  messageExceedsMaxSize,
  hopCountExceeded,
  delivered,
  queued,
  resumedAndDelivered,
  held,
  subscribed,
  deliveryUncertain,
  refused,
  ambiguous,
  notFound,
  unavailable,
  createLoopGuard,
} from "./outcomes.ts";
export type { LoopGuard } from "./outcomes.ts";

// --- resolution: WS-10 §11 rules 1–6, MUST, in order ---------------------------------------------
export { childToListedRuntimeObject, resolveTarget } from "./resolution.ts";
export type { ResolutionInputs, ResolutionResult } from "./resolution.ts";

// --- inbound policy (WS-10 §13) and the bounded held/accepted mailbox -----------------------------
export {
  classifyPermissionMode,
  mapFromModeToPermissionClass,
  defaultInboundResult,
  resolveInboundDecision,
  createMailbox,
  buildDefaultHoldEntry,
  buildExplicitHoldEntry,
} from "./inbound.ts";
export type { PermissionClassLabel, CrossSessionInbound, InboundDecisionParams, HeldEntry, Mailbox } from "./inbound.ts";

// --- notify_when_idle: eligibility, the one-shot subscription store, the notification queue -------
export {
  isIdleSubscribeSenderAllowed,
  isIdleSubscribeTargetAllowed,
  createNotificationQueue,
  createIdleSubscriptionStore,
} from "./idle.ts";
export type { NotificationRecord, NotificationQueue, PendingIdleSubscription, IdleSubscriptionStore } from "./idle.ts";

// --- the router core -----------------------------------------------------------------------------
export {
  MAX_TRACKED_MESSAGE_IDS,
  rememberBounded,
  createMessagingRouterSeam,
  createSubscriberDirectory,
  callerAddress,
  sendMessage,
  listAgents,
  readNotifications,
  createMessagingRouter,
} from "./router.ts";
export type {
  MessagingRouterSeamWithRoster,
  SubscriberDirectory,
  MessagingRuntimeDeps,
  CallerContext,
  SessionCallerContext,
  SendMessageInput,
  NotifyOutcome,
  SendMessageResult,
  ListAgentsInput,
  MessagingRouter,
} from "./router.ts";
