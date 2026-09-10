// THE MESSAGING PORT (ruling P-3) — the one seam the tool handlers reach the messaging world through.
//
// WHY A PORT AND NOT THE DEPS. Two hosts hold the messaging world in two different shapes: the
// Winter runtime holds a composed `MessagingRuntimeDeps` and calls the core's three orchestration
// functions with it; the router package holds a `GlobalMessagingHandle` that has already bound its
// own directory, its two adapters and its ledger. Writing the handlers against either one would make
// them unusable by the other, and writing them twice is exactly the duplication R-8-1 exists to end.
//
// SO THE PORT IS ADDRESS-CENTRIC, not caller-centric: `from` is a `RuntimeAddress`, because that is
// the shape the router's handle already speaks and the shape the core's `callerAddress` already
// produces. The router's handle satisfies this interface STRUCTURALLY, with no adapter at all; the
// Winter runtime gets `messagingToolPortFromRuntimeDeps` below, which is the inverse translation and
// nothing more — no state, no second copy of any rule.
import {
  callerAddress,
  listAgents,
  sendMessage,
  type CallerContext,
  type ListedRuntimeObject,
  type MessagingRuntimeDeps,
  type NotificationRecord,
  type RuntimeAddress,
  type SendMessageResult,
} from "../messaging/index.ts";

export interface MessagingToolPort {
  sendDetailed(request: { from: RuntimeAddress; to: string; body: string; summary?: string; notifyWhenIdle?: boolean; originToolCallId?: string }): Promise<SendMessageResult>;
  listReachable(scope: { from: RuntimeAddress }): Promise<ListedRuntimeObject[]>;
  readNotifications(sessionId: string): { notifications: NotificationRecord[]; remaining: number };
}

/**
 * NO STABLE-LOOKING FABRICATION (ruling P-3, and the Winter runtime's own posture verbatim).
 *
 * WS-10 §12's retry key is (sender session, TOOL-CALL id): the same pair allocates the same message
 * id, and a stored outcome for it short-circuits everything. A caller with no tool-call id has
 * nothing that identifies a retry — so it gets a fresh id per call and NO dedupe. A counter plus the
 * clock, rather than anything derived from the caller or the content, because two distinct model
 * calls must never be mistaken for one retry of each other; that failure direction silently drops a
 * real message, and it is the one direction no downstream layer can detect.
 */
let fallbackCounter = 0;
function fallbackToolUseId(): string {
  return `no-tool-use-id-${++fallbackCounter}-${Date.now()}`;
}

/**
 * The inverse of `callerAddress`: an address back into the (owning session, agent) pair the core's
 * fences are keyed on.
 *
 * `buildChildAddress` sets `winterSessionId` to the PARENT, so `winterSessionId` is the owning
 * session for both object kinds — flattening a child into `sessionId: <childId>` instead would make
 * the core build the malformed `agent:<id>:<id>` and break sibling resolution silently.
 */
function callerFromAddress(from: RuntimeAddress, originToolCallId: string | undefined): CallerContext {
  return {
    sessionId: from.parentWinterSessionId ?? from.winterSessionId,
    ...(from.objectKind === "agent" && from.childId !== undefined ? { agentId: from.childId } : {}),
    toolUseId: originToolCallId ?? fallbackToolUseId(),
  };
}

/**
 * The Winter-runtime side of the port: `MessagingRuntimeDeps` in, `MessagingToolPort` out.
 *
 * `listReachable` goes through the core's own `listAgents` rather than straight to
 * `deps.adapter.listReachable`, because the core is where "never yourself" lives (WS-10 §10.2). The
 * router's handle applies the same filter in its own `listReachable`, so BOTH sides of this port
 * hand back rows the caller is already excluded from — which is why the handlers must not filter
 * again (they are the layer least able to know the caller's real address).
 */
export function messagingToolPortFromRuntimeDeps(deps: MessagingRuntimeDeps): MessagingToolPort {
  return {
    async sendDetailed(request) {
      const caller = callerFromAddress(request.from, request.originToolCallId);
      return sendMessage(deps, caller, {
        to: request.to,
        message: request.body,
        ...(request.summary === undefined ? {} : { summary: request.summary }),
        ...(request.notifyWhenIdle === undefined ? {} : { notify_when_idle: request.notifyWhenIdle }),
      });
    },

    async listReachable(scope) {
      const { rows } = await listAgents(deps, { sessionId: scope.from.parentWinterSessionId ?? scope.from.winterSessionId }, {});
      return rows;
    },

    readNotifications(sessionId) {
      return deps.notifications.drain(sessionId);
    },
  };
}

// Re-exported so a `/tools` consumer never needs a second import line into the messaging subpath for
// the one function both hosts build a caller address with.
export { callerAddress };
