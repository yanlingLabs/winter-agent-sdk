// The Winter runtime's messaging COMPOSITION module: the process-level runtime singleton the three
// messaging tool executors read, over the router core published as
// `@yanlinglabs/winter-agent-sdk/messaging`.
//
// PHASE 7B (R-7b-4): every routing rule that used to live in this file -- message-id allocation and
// the retry ledger, resolution, the bounds, the SendMessage/ListAgents/ReadNotifications
// orchestration -- moved into the SDK subpath so the router package composes the IDENTICAL core with
// its two cross-runtime adapters. Nothing about the behaviour moved with it; this file re-exports
// the core's names so no call site in this package changed, and keeps the ONE thing that is not
// core:
//
//   THE SINGLETON. `registerMessagingRuntime`/`getMessagingRuntime` is process composition, not
//   routing. A published library must not hand every consumer one shared mutable slot -- a host that
//   owns several runtimes (which is precisely what the router package is) would inherit a
//   last-writer-wins global. It stays here, where there IS exactly one runtime per process by
//   design: a child engine is another `runEngine` loop in the SAME process (RULING R4-4), so a
//   per-run registration would be clobbered by every child spawn -- the parent's own peers, held
//   messages, notification queue and messageId ledger all silently replaced mid-turn by the child's
//   fresh ones. See `ensureDefaultMessagingRuntimeRegistered` (reference-adapter.ts) for the lazy,
//   idempotent registrar built on top of this.
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import type { MessagingRuntimeDeps } from "@yanlinglabs/winter-agent-sdk/messaging";

// The core, re-exported under the names this package has always imported from here.
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
} from "@yanlinglabs/winter-agent-sdk/messaging";
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
  RuntimeAddress,
  ListedRuntimeObject,
  DeliveryOutcome,
} from "@yanlinglabs/winter-agent-sdk/messaging";
export type { PermissionMode };

let activeRuntime: MessagingRuntimeDeps | undefined;

export function registerMessagingRuntime(runtime: MessagingRuntimeDeps): void {
  activeRuntime = runtime;
}
export function getMessagingRuntime(): MessagingRuntimeDeps | undefined {
  return activeRuntime;
}
// Test-only escape hatch (child-handle.ts / push-notification.ts precedent): resets the module-level
// singleton so one test file's registration never leaks into another's assertions.
export function resetMessagingRuntimeForTest(): void {
  activeRuntime = undefined;
}
