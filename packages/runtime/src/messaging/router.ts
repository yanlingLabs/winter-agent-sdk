// Phase 4 Task 7 (Lane D, WS-10 §10-15): the composition root. Owns (1) the raw `MessagingRouterSeam`
// factory (allocateMessageId/recordOutcome/lookupOutcome/children -- the contract
// subagents/seam-contracts-p4.test.ts binds), (2) the module-singleton registration the three tool
// executors pull from (ToolExecutionContext, registry.ts, is frozen and carries no messaging field --
// this mirrors tools/impl/push-notification.ts's own identical precedent: "the seam lives here,
// module-local, exactly like createBackgroundTask's own root resolver"), and (3) the SendMessage/
// ListAgents/ReadNotifications orchestration functions the tool executors call.
//
// NEEDS_CONTEXT (flagged in the task report): `ToolExecutionContext` (registry.ts:190-311) carries
// no per-call tool-use id. `EngineToolCall.id` (registry.ts:857) exists but `buildRegistryToolExecutor`
// (registry.ts:927-960) never threads it onto the `ToolExecutionContext` it builds -- so no tool
// executor in this codebase can see its own call's id today. WS-10 §12 requires messageId stability
// "derived/persisted from the sender session plus tool-call ID" for retry idempotency. This file's
// own `CallerContext.toolUseId` is REQUIRED and the orchestration below is fully correct and fully
// tested against it; the gap is entirely at the tool-executor boundary (tools/impl/send-message.ts),
// which has no real id to pass in until a spine change adds one. See that file's own header for the
// safe-direction fallback it takes in the meantime.
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import type { ChildHandle } from "../subagents/child-handle.ts";
import { ChildResumeModeIncomparableError } from "../permissions/auto/inheritance.ts";
import {
  serializeRuntimeAddress,
  type RuntimeAddress,
  type ListedRuntimeObject,
  type DeliveryOutcome,
  type GlobalAgentMessage,
  type RuntimeMessagingAdapter,
  type MessagingRouterSeam,
} from "./adapter.ts";
import { buildSessionAddress, buildChildAddress, sameAddress } from "./addressing.ts";
import { childToListedRuntimeObject, resolveTarget } from "./resolution.ts";
import { isIdleSubscribeSenderAllowed } from "./idle.ts";
import type { NotificationQueue, NotificationRecord } from "./idle.ts";
import {
  MAX_GLOBAL_MESSAGE_SIZE,
  DEFAULT_MESSAGE_TTL_MS,
  messageExceedsMaxSize,
  hopCountExceeded,
  refused,
  notFound,
  ambiguous,
  deliveryUncertain,
  type LoopGuard,
} from "./outcomes.ts";

// --- The raw seam (subagents/seam-contracts-p4.test.ts's own authority) ----------------------------

export interface MessagingRouterSeamWithRoster extends MessagingRouterSeam {
  // Additive over the frozen MessagingRouterSeam interface: a SINGLE router serves every session in
  // the process ("the daemon is the live registry," WS-10 §15's own title) -- each session's own
  // `runEngine()` call fires `onChildRosterReady` exactly once (engine.ts), so `children()` must
  // AGGREGATE across every session that has ever registered a source, not merely reflect the last
  // one. Returns an unsubscribe function, mirroring registry.ts's own `onRegistryChange` convention.
  addChildRosterSource(getChildren: () => readonly ChildHandle[]): () => void;
}

export function createMessagingRouterSeam(): MessagingRouterSeamWithRoster {
  const outcomes = new Map<string, DeliveryOutcome>();
  const idsBySenderAndTool = new Map<string, string>();
  let sources: Array<() => readonly ChildHandle[]> = [];
  let counter = 0;

  return {
    allocateMessageId(senderSessionId, toolUseId) {
      const key = JSON.stringify([senderSessionId, toolUseId]);
      const existing = idsBySenderAndTool.get(key);
      if (existing !== undefined) return existing;
      const id = `msg-${++counter}`;
      idsBySenderAndTool.set(key, id);
      return id;
    },
    recordOutcome(messageId, outcome) {
      outcomes.set(messageId, outcome);
    },
    lookupOutcome(messageId) {
      return outcomes.get(messageId);
    },
    addChildRosterSource(getChildren) {
      sources.push(getChildren);
      return () => {
        sources = sources.filter((s) => s !== getChildren);
      };
    },
    children() {
      return sources.flatMap((getChildren) => getChildren());
    },
  };
}

// --- The module-singleton tool executors pull from ---------------------------------------------------

export interface MessagingRuntimeDeps {
  seam: MessagingRouterSeam;
  adapter: RuntimeMessagingAdapter;
  notifications: NotificationQueue;
  loopGuard: LoopGuard;
  now(): number;
}

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

// --- Caller identity -----------------------------------------------------------------------------

export interface CallerContext {
  // The OWNING top-level session id -- for a top-level caller this is its own product id; for a
  // CHILD's own tool call this is STILL the owning parent's id (engine.ts's own child runEngine()
  // invocation reuses `config.sessionId`; only `agentId` distinguishes a child's own call -- see
  // registry.ts's ToolExecutionContext.agentId field comment).
  sessionId: string;
  agentId?: string;
  toolUseId: string;
}

export function callerAddress(caller: { sessionId: string; agentId?: string }): RuntimeAddress {
  if (caller.agentId !== undefined) return buildChildAddress(caller.sessionId, caller.agentId);
  return buildSessionAddress(caller.sessionId);
}

// --- SendMessage -----------------------------------------------------------------------------------

export interface SendMessageInput {
  to: string;
  message: string;
  summary?: string;
  notify_when_idle?: boolean;
}

export interface NotifyOutcome {
  subscribed?: true;
  refused?: string;
}

export interface SendMessageResult {
  outcome: DeliveryOutcome;
  // Present ONLY for a COMBINED call (a non-empty message plus notify_when_idle): the delivery
  // outcome is always primary (`result.outcome`); this carries the SEPARATE fact of whether the
  // idle subscription was also honored. SendMessage has no pinned outputSchema (WS-10 §10.1), so a
  // supplementary field here is the honest place for it -- never invented as a second top-level
  // DeliveryOutcome status.
  notify?: NotifyOutcome;
}

const SUCCESS_CLASS_STATUSES: ReadonlySet<DeliveryOutcome["status"]> = new Set(["delivered", "queued", "resumed_and_delivered"]);

function outcomeReason(outcome: DeliveryOutcome): string {
  return "reason" in outcome ? outcome.reason : outcome.status;
}

export async function sendMessage(deps: MessagingRuntimeDeps, caller: CallerContext, input: SendMessageInput): Promise<SendMessageResult> {
  const now = deps.now();
  const messageId = deps.seam.allocateMessageId(caller.sessionId, caller.toolUseId);

  // WS-10 §12: allocation is stable across a retry of the identical (sender, tool-call) pair, and a
  // stored outcome for it short-circuits EVERYTHING below -- including re-running resolution -- so a
  // retry can never start a second turn or re-evaluate a decision that already settled.
  const existing = deps.seam.lookupOutcome(messageId);
  if (existing !== undefined) return { outcome: existing };

  function settle(outcome: DeliveryOutcome, notify?: NotifyOutcome): SendMessageResult {
    deps.seam.recordOutcome(messageId, outcome);
    return notify !== undefined ? { outcome, notify } : { outcome };
  }

  const from = callerAddress(caller);
  const fromKey = serializeRuntimeAddress(from);
  const wantsIdle = input.notify_when_idle === true;
  const isPureSubscription = input.message.length === 0;

  // WS-10 §14 sender-side eligibility, checked first since it does not depend on the target at all.
  if (wantsIdle && !isIdleSubscribeSenderAllowed({ isChild: caller.agentId !== undefined })) {
    return settle(refused(messageId, "notify_when_idle: only a main conversation may subscribe (WS-10 §14)"));
  }

  if (!isPureSubscription) {
    // Bounds that don't depend on the target (WS-10 §12): body size and the loop/rapid-repeat guard.
    if (messageExceedsMaxSize(input.message)) {
      return settle(refused(messageId, `message exceeds MAX_GLOBAL_MESSAGE_SIZE (${MAX_GLOBAL_MESSAGE_SIZE} chars)`));
    }
    if (deps.loopGuard.check(fromKey, input.to, input.message, now) === "duplicate") {
      return settle(refused(messageId, "identical message to the same target was sent moments ago (rapid repeat suppressed, WS-10 §12)"));
    }
  }

  const reachable = await deps.adapter.listReachable({ parent: buildSessionAddress(caller.sessionId) });
  const peers = reachable.filter((r): r is ListedRuntimeObject => r.objectKind === "session");
  const resolved = resolveTarget({ to: input.to, callerParentSessionId: caller.sessionId, children: deps.seam.children(), peers });

  if (resolved.kind === "not_found") return settle(notFound(messageId, resolved.message));
  if (resolved.kind === "stale") return settle(refused(messageId, resolved.message));
  if (resolved.kind === "ambiguous") return settle(ambiguous(messageId, resolved.candidates));

  // resolved.kind === "resolved" from here on.
  const to = resolved.address;

  if (sameAddress(to, from)) {
    return settle(refused(messageId, "cannot SendMessage to your own session (self-target, WS-10 §16)"));
  }

  const targetRow: ListedRuntimeObject | undefined =
    to.objectKind === "agent" && resolved.child !== undefined
      ? childToListedRuntimeObject(caller.sessionId, resolved.child)
      : reachable.find((r) => r.address === serializeRuntimeAddress(to));

  // WS-10 §14 target-side eligibility, driven by the PINNED `ListedRuntimeObject.capabilities.
  // notifyWhenIdle` flag (WS-10 §11) rather than a side-effecting probe call: a subagent/child always
  // carries `notifyWhenIdle: false` (resolution.ts's own childToListedRuntimeObject), and a peer
  // whose adapter has no reliable idle signal is expected to report the same -- see
  // reference-adapter.ts's own PeerSessionHandle. Checking this BEFORE any delivery attempt is what
  // makes "refuse the entire call, including any attached message" (WS-10 §14) correct: nothing is
  // ever delivered and then un-delivered.
  if (wantsIdle && (targetRow === undefined || !targetRow.capabilities.notifyWhenIdle)) {
    return settle(
      refused(
        messageId,
        "notify_when_idle: target does not support idle notification (subagents, teammates, remote peers, and adapters without a reliable idle signal refuse the WHOLE call, WS-10 §14)",
      ),
    );
  }

  if (isPureSubscription) {
    // No message body at all -- the ENTIRE call is the subscription; its own outcome is primary.
    return settle(await deps.adapter.subscribeIdle(to, { messageId }));
  }

  // Hop count: SendMessageInput has no model-facing hop-count field (WS-10 §10.1) -- every call this
  // router originates starts at hop 0. The bound is still real, enforced machinery (not merely
  // documented) for the day a relay/forward path exists; it is not reachable through today's schema.
  const hopCount = 0;
  if (hopCountExceeded(hopCount)) return settle(refused(messageId, "message exceeds MAX_HOP_COUNT"));

  const senderPermissionClass = await deps.adapter.senderPermissionClass(from);
  const envelope: GlobalAgentMessage = {
    messageId,
    from,
    fromGeneration: 0, // T8 FLAG: RuntimeAddress carries no generation field (WS-10 §11); real generation tracking against a durable RuntimeDirectory is a P8/host-integration concern (see reference-adapter.ts's own header).
    to,
    toGeneration: 0,
    body: input.message,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    notifyWhenIdle: wantsIdle,
    createdAt: now,
    expiresAt: now + DEFAULT_MESSAGE_TTL_MS,
    hopCount,
    originToolCallId: caller.toolUseId,
    senderPermissionClass,
  };

  const bodyOutcome = await deliverEnvelope(deps.adapter, to, resolved.child, envelope, messageId);

  if (!wantsIdle) return settle(bodyOutcome);

  // Combined call: eligibility was already confirmed above via targetRow.capabilities.notifyWhenIdle,
  // so subscribeIdle is expected to succeed -- but only attempted when delivery itself succeeded
  // (advisor guidance: never layer a subscription confirmation on top of a held/refused/uncertain
  // delivery). A subscribeIdle failure here (a genuine race against the eligibility check above) is
  // reported in the supplementary `notify` field, never by mutating the already-settled delivery
  // outcome.
  if (!SUCCESS_CLASS_STATUSES.has(bodyOutcome.status)) {
    return settle(bodyOutcome, { refused: `message was not delivered (status: ${bodyOutcome.status}); notify_when_idle was not attempted` });
  }
  const idleOutcome = await deps.adapter.subscribeIdle(to, { messageId });
  return settle(bodyOutcome, idleOutcome.status === "subscribed" ? { subscribed: true } : { refused: outcomeReason(idleOutcome) });
}

async function deliverEnvelope(
  adapter: RuntimeMessagingAdapter,
  to: RuntimeAddress,
  child: ChildHandle | undefined,
  envelope: GlobalAgentMessage,
  messageId: string,
): Promise<DeliveryOutcome> {
  if (to.objectKind === "agent") {
    if (child === undefined) return notFound(messageId, "child no longer reachable");
    try {
      // WS-10 §10.3: steer a RUNNING child; resume a TERMINAL, addressable one. Never the reverse.
      return child.status() === "running" ? await adapter.steerChild(to, envelope) : await adapter.resumeChild(to, envelope);
    } catch (err) {
      // RULING P4-D: resume fails closed with a typed ChildResumeModeIncomparableError on an
      // incomparable recorded-vs-current-parent mode pair -- a clean, side-effect-free policy
      // refusal, surfaced legibly rather than as an unhandled rejection or a misleading "uncertain."
      if (err instanceof ChildResumeModeIncomparableError) return refused(messageId, err.message);
      // Any OTHER throw is indistinguishable, from here, from "the effect may have already happened
      // before the process/call failed" -- WS-10 §12's own crash-window semantics apply generically,
      // not only to an official cross-restart crash.
      return deliveryUncertain(messageId, `unexpected error during delivery: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    return await adapter.deliverToSession(to, envelope);
  } catch (err) {
    return deliveryUncertain(messageId, `unexpected error during delivery: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- ListAgents --------------------------------------------------------------------------------------

export interface ListAgentsInput {
  // WS-10 §10.2: both reserved/unavailable in the pinned build -- accepted, never validated or
  // acted on (they have no effect either way, so over-validating an inert field serves no one).
  channel?: string;
  q?: string;
}

function formatListing(rows: readonly ListedRuntimeObject[]): string {
  if (rows.length === 0) return "No agents or sessions are currently reachable.";
  return rows
    .map((r) => {
      const label = r.name !== undefined ? `${r.name} (${r.address})` : r.address;
      return `- ${label} [${r.objectKind}/${r.runtimeKind}] status=${r.status} mode=${r.mode}`;
    })
    .join("\n");
}

export async function listAgents(deps: MessagingRuntimeDeps, caller: CallerContext, _input: ListAgentsInput): Promise<{ listing: string; rows: ListedRuntimeObject[] }> {
  const selfAddr = buildSessionAddress(caller.sessionId);
  const selfKey = serializeRuntimeAddress(selfAddr);
  const reachable = await deps.adapter.listReachable({ parent: selfAddr });
  const rows = reachable.filter((r) => r.address !== selfKey); // WS-10 §10.2: what SendMessage can reach -- never yourself
  return { listing: formatListing(rows), rows };
}

// --- ReadNotifications ---------------------------------------------------------------------------

export function readNotifications(deps: MessagingRuntimeDeps, caller: CallerContext): { notifications: NotificationRecord[]; remaining: number } {
  return deps.notifications.drain(caller.sessionId);
}

// Re-exported so tools/impl/*.ts never needs a second import line into adapter.ts/idle.ts for these
// pass-through type names.
export type { RuntimeAddress, ListedRuntimeObject, DeliveryOutcome, PermissionMode };
