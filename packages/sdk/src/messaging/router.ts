// The messaging router CORE (WS-10 §10-§15): message-id allocation and the retry ledger, the
// SendMessage/ListAgents/ReadNotifications orchestration, and the bounds every delivery is checked
// against before an adapter is ever reached.
//
// PHASE 7B (R-7b-4): moved out of the private Winter runtime and published here so the router
// package composes the IDENTICAL core with two `RuntimeMessagingAdapter`s (Winter, official) that
// the Winter runtime composes with its one in-process adapter. Two things stayed behind in the
// runtime, deliberately, and neither is core:
//
//   * the PROCESS-LEVEL singleton (`registerMessagingRuntime`/`getMessagingRuntime`) the Winter
//     runtime's three tool executors read -- process composition, not routing. A host that owns
//     several runtimes must not inherit one shared mutable slot from a library.
//   * `reference-adapter.ts` -- the in-process adapter itself, which is Winter-runtime-specific by
//     construction (WS-10 §15: adapters perform owner-specific operations only).
import {
  serializeRuntimeAddress,
  type RuntimeAddress,
  type ListedRuntimeObject,
  type DeliveryOutcome,
  type GlobalAgentMessage,
  type RuntimeMessagingAdapter,
  type MessagingRouterSeam,
  type ChildLike,
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

// --- The raw seam ---------------------------------------------------------------------------------

export interface MessagingRouterSeamWithRoster extends MessagingRouterSeam {
  // Additive over the MessagingRouterSeam interface: a SINGLE router serves every session in the
  // host process ("the daemon is the live registry," WS-10 §15's own title) -- each session's own
  // run contributes its roster exactly once, so `children()` must AGGREGATE across every session
  // that has ever registered a source, not merely reflect the last one. Returns an unsubscribe
  // function.
  addChildRosterSource(getChildren: () => readonly ChildLike[]): () => void;
}

// Phase 4 fix wave (whole-branch M10): every messageId-keyed map in this runtime was
// PROCESS-LIFETIME unbounded -- one entry per SendMessage, forever, in a host that never restarts.
// They are retry memory (WS-10 §12's "stable across a retry of the identical (sender, tool-call)
// pair"), not durable state, so the honest bound is a cap with oldest-first eviction: a retry
// window measured in turns is preserved, while a long-lived daemon's footprint stops growing. An
// evicted id simply behaves as a fresh allocation would -- the outcome was already delivered; only
// the ability to short-circuit an identical RE-send is lost, which is exactly the property a
// long-past message no longer needs. Deliberately not a TTL sweep: nothing here has a clock, and a
// size cap needs no timer to be correct.
export const MAX_TRACKED_MESSAGE_IDS = 10_000;

export function rememberBounded<V>(map: Map<string, V>, key: string, value: V, cap: number = MAX_TRACKED_MESSAGE_IDS): void {
  // Re-insert on update so a key that is still being used moves to the YOUNG end (a Map iterates in
  // insertion order, so deleting the first key evicts the least recently written).
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

export function createMessagingRouterSeam(): MessagingRouterSeamWithRoster {
  const outcomes = new Map<string, DeliveryOutcome>();
  const idsBySenderAndTool = new Map<string, string>();
  let sources: Array<() => readonly ChildLike[]> = [];
  let counter = 0;

  return {
    allocateMessageId(senderSessionId, toolUseId) {
      const key = JSON.stringify([senderSessionId, toolUseId]);
      const existing = idsBySenderAndTool.get(key);
      if (existing !== undefined) return existing;
      const id = `msg-${++counter}`;
      rememberBounded(idsBySenderAndTool, key, id);
      return id;
    },
    recordOutcome(messageId, outcome) {
      rememberBounded(outcomes, messageId, outcome);
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

// WS-10 §15's own `subscribeIdle(addr, {messageId})` carries NO subscriber address at all -- by the
// time an eventual idle notice fires, something must still know which session asked. This is the
// documented, in-Lane-D-files-only answer to that gap (never a change to the frozen adapter
// interface): the SAME messageId the seam already allocates 1:1 with the calling (senderSessionId,
// toolUseId) pair is also the key this directory remembers the subscriber under.
// reference-adapter.ts's own subscribeIdle-firing logic looks it up when it needs to know which
// session's NotificationQueue receives the eventual notice.
export interface SubscriberDirectory {
  remember(messageId: string, subscriberSessionId: string): void;
  lookup(messageId: string): string | undefined;
}

export function createSubscriberDirectory(): SubscriberDirectory {
  const map = new Map<string, string>();
  return {
    remember(messageId, subscriberSessionId) {
      rememberBounded(map, messageId, subscriberSessionId); // M10: see rememberBounded's own header
    },
    lookup(messageId) {
      return map.get(messageId);
    },
  };
}

// --- The composed runtime a caller hands to every function below -------------------------------

export interface MessagingRuntimeDeps {
  seam: MessagingRouterSeam;
  adapter: RuntimeMessagingAdapter;
  notifications: NotificationQueue;
  loopGuard: LoopGuard;
  subscribers: SubscriberDirectory;
  now(): number;
  /**
   * How a THROW out of an adapter delivery call is classified (R-7b-4's one behavioural seam).
   *
   * WS-10 §12's crash-window semantics make `delivery_uncertain` the honest default for an
   * unexplained throw: from here, "the call failed" and "the effect happened and then the call
   * failed" are indistinguishable. But a POLICY refusal thrown by an adapter is neither -- it is a
   * clean, side-effect-free "no", and reporting it as uncertain would be a lie in the safe-looking
   * direction.
   *
   * The core cannot recognise those classes itself: they belong to whichever runtime the adapter
   * drives (the Winter runtime's `ChildResumeModeIncomparableError` under RULING P4-D; the router
   * package's own official-branch refusals). So the owner supplies the predicate. ABSENT means
   * "everything is uncertain", which is exactly the conservative reading.
   */
  classifyDeliveryError?(err: unknown): "refused" | "uncertain";
}

// --- Caller identity -----------------------------------------------------------------------------

export interface CallerContext {
  // The OWNING top-level session id -- for a top-level caller this is its own product id; for a
  // CHILD's own tool call this is STILL the owning parent's id: one owning SESSION, N agents keyed
  // by `agentId`, which is the only thing that distinguishes a child's own call.
  //
  // A host that sets a child's session id to the child's OWN id instead breaks resolution silently:
  // `callerAddress` below then builds the malformed `agent:<id>:<id>`, and `resolveTarget`'s
  // `record.parentSessionId === caller.sessionId` filter matches that child's GRANDCHILDREN rather
  // than its siblings, so a child cannot message a sibling at all. (Measured, in the Winter runtime,
  // before its child engine was corrected to honour this.)
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

  if (wantsIdle) {
    // Remembered BEFORE either subscribeIdle call site below (SubscriberDirectory's own header,
    // above): the adapter has no other way to learn which session's NotificationQueue should
    // eventually receive the notice.
    deps.subscribers.remember(messageId, caller.sessionId);
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

  const bodyOutcome = await deliverEnvelope(deps, to, resolved.child, envelope, messageId);

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

function describeThrow(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A throw out of an adapter call becomes either a clean `refused` (the owner's predicate recognised
// a POLICY refusal -- e.g. RULING P4-D's incomparable resume-mode pair on the Winter branch) or
// `delivery_uncertain` (WS-10 §12: from here, "the call failed" and "the effect already happened"
// are indistinguishable). Never an unhandled rejection.
function outcomeForThrow(deps: MessagingRuntimeDeps, messageId: string, err: unknown): DeliveryOutcome {
  if (deps.classifyDeliveryError?.(err) === "refused") return refused(messageId, describeThrow(err));
  return deliveryUncertain(messageId, `unexpected error during delivery: ${describeThrow(err)}`);
}

async function deliverEnvelope(
  deps: MessagingRuntimeDeps,
  to: RuntimeAddress,
  child: ChildLike | undefined,
  envelope: GlobalAgentMessage,
  messageId: string,
): Promise<DeliveryOutcome> {
  if (to.objectKind === "agent") {
    if (child === undefined) return notFound(messageId, "child no longer reachable");
    try {
      // WS-10 §10.3: steer a RUNNING child; resume a TERMINAL, addressable one. Never the reverse.
      return child.status() === "running" ? await deps.adapter.steerChild(to, envelope) : await deps.adapter.resumeChild(to, envelope);
    } catch (err) {
      return outcomeForThrow(deps, messageId, err);
    }
  }
  try {
    return await deps.adapter.deliverToSession(to, envelope);
  } catch (err) {
    return outcomeForThrow(deps, messageId, err);
  }
}

// --- ListAgents --------------------------------------------------------------------------------------

export interface ListAgentsInput {
  // WS-10 §10.2: both reserved/unavailable in the pinned build -- accepted, never validated or
  // acted on (they have no effect either way, so over-validating an inert field serves no one).
  channel?: string;
  q?: string;
}

/**
 * WS-10 §10.2's line format for the one `listing` string.
 *
 * `export`ed for `../tools/messaging-handlers.ts` alone — NOT re-exported from this subpath's barrel,
 * so it stays an internal seam rather than new published surface. The tool handler needs the SAME
 * renderer this function already is: `listAgents` returns `{ listing, rows }` for a host that owns
 * the deps, while the tool handler works through the address-centric port and has only rows, and a
 * second formatter there would be a second answer to "what does the model see".
 */
export function formatListing(rows: readonly ListedRuntimeObject[]): string {
  if (rows.length === 0) return "No agents or sessions are currently reachable.";
  return rows
    .map((r) => {
      const label = r.name !== undefined ? `${r.name} (${r.address})` : r.address;
      return `- ${label} [${r.objectKind}/${r.runtimeKind}] status=${r.status} mode=${r.mode}`;
    })
    .join("\n");
}

// Narrower than CallerContext (which also carries agentId/toolUseId -- neither ListAgents nor
// ReadNotifications needs either): both only ever scope to the calling session itself, so the tool
// executors never need to fabricate a toolUseId just to satisfy an unused required field.
export interface SessionCallerContext {
  sessionId: string;
}

export async function listAgents(deps: MessagingRuntimeDeps, caller: SessionCallerContext, _input: ListAgentsInput): Promise<{ listing: string; rows: ListedRuntimeObject[] }> {
  const selfAddr = buildSessionAddress(caller.sessionId);
  const selfKey = serializeRuntimeAddress(selfAddr);
  const reachable = await deps.adapter.listReachable({ parent: selfAddr });
  const rows = reachable.filter((r) => r.address !== selfKey); // WS-10 §10.2: what SendMessage can reach -- never yourself
  return { listing: formatListing(rows), rows };
}

// --- ReadNotifications ---------------------------------------------------------------------------

export function readNotifications(deps: MessagingRuntimeDeps, caller: SessionCallerContext): { notifications: NotificationRecord[]; remaining: number } {
  return deps.notifications.drain(caller.sessionId);
}

// Re-exported so a tool executor never needs a second import line into adapter.ts for these
// pass-through type names.
export type { RuntimeAddress, ListedRuntimeObject, DeliveryOutcome };

// --- The one composed door the router package consumes by name (the 7b plan's pinned block) -------
//
// The three orchestration functions above take `deps` first because that is how the Winter runtime's
// tool executors call them (one module-level runtime, resolved per call). A HOST that owns several
// runtimes wants the opposite shape -- bind the deps once, call by name -- so this is that binding,
// and nothing more: no state, no second copy of any rule.
export interface MessagingRouter {
  sendMessage(caller: CallerContext, input: SendMessageInput): Promise<SendMessageResult>;
  listAgents(caller: SessionCallerContext, input: ListAgentsInput): Promise<{ listing: string; rows: ListedRuntimeObject[] }>;
  readNotifications(caller: SessionCallerContext): { notifications: NotificationRecord[]; remaining: number };
  readonly deps: MessagingRuntimeDeps;
}

export function createMessagingRouter(deps: MessagingRuntimeDeps): MessagingRouter {
  return {
    deps,
    sendMessage: (caller, input) => sendMessage(deps, caller, input),
    listAgents: (caller, input) => listAgents(deps, caller, input),
    readNotifications: (caller) => readNotifications(deps, caller),
  };
}
