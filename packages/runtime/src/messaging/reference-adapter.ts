// Phase 4 Task 7 (Lane D, WS-10 §15, RULING R4-5): the in-process REFERENCE implementation of
// `RuntimeMessagingAdapter`. "In-process reference" per R4-5: this file proves out every WS-10
// §10-14 semantic against INJECTABLE, same-process constructs -- the live child roster (ChildHandle,
// via router.ts's own MessagingRouterSeam.children()) and an in-memory PeerSessionHandle directory
// this file itself defines. It is deliberately NOT the daemon-wide, durable, cross-process,
// authenticated RuntimeDirectory [WS-15] owns.
//
// NAMED P8 SEAM -- what a real daemon-side router/adapter must additionally supply, never
// implemented here:
//   - durable, cross-restart outcome/message-id storage (router.ts's own MessagingRouterSeam is
//     in-memory only; WS-10 §15's "the daemon authors canonical addresses, inbox state, name
//     leases, and delivery records" is durable persistence this reference does not attempt);
//   - cross-process/cross-machine delivery (every PeerSessionHandle here is same-process by
//     construction; WS-10 §13's "cross-machine/phone delivery requires an authenticated Winter
//     transport" and `Settings.isolatePeerMachines` (derived-shapes-p4.md item (e)) are both P8);
//   - per-sender/per-target RATE LIMITS (WS-10 §12 lists them as a MUST alongside the bounds
//     outcomes.ts implements; there is no notion of "scale" for a single in-process reference to
//     rate-limit against, so this reference does not implement one);
//   - authenticated routes (this reference treats every same-process peer as `authenticated: true`
//     unconditionally in deliverToSession below -- a real remote/cross-machine route is exactly what
//     inbound.ts's own `authenticated` parameter exists to gate, once a real transport exists);
//   - an automatic "session went idle" event source (real engine/session lifecycle hooks are a P8
//     wiring concern) -- this reference exposes `firePeerIdleTransition` for a caller (a real host,
//     or this file's own tests) to call explicitly instead.
import type { ChildHandle } from "../subagents/child-handle.ts";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import {
  serializeRuntimeAddress,
  type RuntimeAddress,
  type ListedRuntimeObject,
  type DeliveryOutcome,
  type GlobalAgentMessage,
  type RuntimeMessagingAdapter,
} from "./adapter.ts";
import { childToListedRuntimeObject } from "./resolution.ts";
import {
  classifyPermissionMode,
  resolveInboundDecision,
  createMailbox,
  buildDefaultHoldEntry,
  buildExplicitHoldEntry,
  type CrossSessionInbound,
  type PermissionClassLabel,
} from "./inbound.ts";
import { createIdleSubscriptionStore, createNotificationQueue, type NotificationQueue } from "./idle.ts";
import { delivered, queued, held, subscribed, refused, notFound, unavailable, createLoopGuard } from "./outcomes.ts";
import {
  createMessagingRouterSeam,
  createSubscriberDirectory,
  getMessagingRuntime,
  registerMessagingRuntime,
  type MessagingRouterSeamWithRoster,
  type MessagingRuntimeDeps,
  type SubscriberDirectory,
  rememberBounded,
} from "./router.ts";

// --- The reference's own "peer" abstraction (same-process top-level sessions) ----------------------

export interface PeerSessionHandle {
  readonly address: RuntimeAddress; // objectKind "session"
  readonly name?: string;
  readonly cwd?: string;
  status(): "starting" | "running" | "idle" | "exited" | "unavailable" | "archived";
  mode(): PermissionMode;
  // WS-10 §13: "plan is classified as bypassing when bypass is available to that session." A fact
  // about this peer's own gate configuration this reference cannot derive from `mode()` alone.
  bypassAvailable(): boolean;
  // Explicit `Settings.crossSessionInbound` override, when this peer has one configured. Absent =
  // the default class matrix applies (inbound.ts's own resolveInboundDecision).
  crossSessionInbound?(): CrossSessionInbound | undefined;
  // WS-10 §14: "adapters without a reliable idle signal MUST refuse" notify_when_idle.
  hasReliableIdleSignal(): boolean;
  // Called only once inbound policy has already decided "accept": queue at the next tool boundary
  // (running) or start a new turn (idle). The REAL engine-level mechanics of either are P8 (this
  // file's own header) -- this reference only proves the decision was reached and the call made.
  deliver(msg: GlobalAgentMessage): Promise<void>;
}

export interface PeerDirectory {
  list(): PeerSessionHandle[];
  find(address: RuntimeAddress): PeerSessionHandle | undefined;
  register(handle: PeerSessionHandle): () => void;
}

export function createInMemoryPeerDirectory(): PeerDirectory {
  let peers: PeerSessionHandle[] = [];
  return {
    list() {
      return peers;
    },
    find(address) {
      const key = serializeRuntimeAddress(address);
      return peers.find((p) => serializeRuntimeAddress(p.address) === key);
    },
    register(handle) {
      peers.push(handle);
      return () => {
        peers = peers.filter((p) => p !== handle);
      };
    },
  };
}

// --- The adapter itself ------------------------------------------------------------------------

export interface ReferenceAdapterDeps {
  getChildren(): readonly ChildHandle[];
  peers: PeerDirectory;
  notifications: NotificationQueue;
  // WS-10 §15's own `subscribeIdle(addr, {messageId})` carries NO subscriber address at all -- by
  // the time an eventual idle notice fires, something must still know which session asked. This is
  // this reference's own documented answer to that gap (never a spine change to the frozen adapter
  // interface): router.ts's own SubscriberDirectory remembers the correlation, keyed by the SAME
  // messageId the seam already allocated 1:1 with the calling session -- see router.ts's own header.
  subscribers: SubscriberDirectory;
  now(): number;
}

export interface ReferenceMessagingAdapter extends RuntimeMessagingAdapter {
  // Not part of the frozen RuntimeMessagingAdapter contract: a host integration (or this file's own
  // tests) calls this whenever a registered peer ACTUALLY transitions to idle or exited, so any
  // pending notify_when_idle subscription on it fires exactly once (WS-10 §14). A real host would
  // wire this to its own session-status-change event; R4-5's in-process reference has no such event
  // source to observe on its own.
  firePeerIdleTransition(address: RuntimeAddress): void;
  sweepExpiredIdleSubscriptions(): void;
  // WS-10 §13: "held messages are re-evaluated when the receiver's mode or settings change." Not
  // automatic here for the identical reason firePeerIdleTransition is manual -- a caller invokes
  // this once it knows `address`'s mode/settings changed. Returns every entry whose disposition
  // changed so the caller can record the new outcome against the seam (the adapter itself never
  // touches MessagingRouterSeam -- WS-10 §15's own "the daemon authors ... delivery records").
  reevaluateHeldFor(address: RuntimeAddress): Promise<Array<{ messageId: string; outcome: DeliveryOutcome }>>;
  // WS-10 §13's default-class 5-minute dialog expiry, swept lazily rather than on a timer. Same
  // "caller records the outcome" contract as reevaluateHeldFor.
  sweepExpiredHeld(): Array<{ messageId: string; outcome: DeliveryOutcome }>;
}

export function createReferenceMessagingAdapter(deps: ReferenceAdapterDeps): ReferenceMessagingAdapter {
  const mailbox = createMailbox();
  const idleSubs = createIdleSubscriptionStore();
  // The envelope behind each currently-held messageId -- inbound.ts's own Mailbox is deliberately
  // envelope-agnostic (cap/expiry/reevaluation bookkeeping only); re-evaluating a hold into an
  // "accept" needs the ORIGINAL message to actually deliver, so this reference keeps it here.
  const heldEnvelopes = new Map<string, GlobalAgentMessage>();

  // Both child lookups in this file (here and `listReachable` below) filter the PROCESS-WIDE roster
  // by `record.parentSessionId === <the owning session id>`. P4 fix wave (I1) note, because the
  // invariant that makes this correct used to be false: a child engine's own `RuntimeConfig.sessionId`
  // IS its parent's now (one owning SESSION, N AGENTS keyed by agentId), so a caller's ctx.sessionId
  // and every one of that session's children's `record.parentSessionId` are the same value at EVERY
  // nesting level -- which is what makes a child able to see its SIBLINGS here rather than only its
  // own grandchildren. Nothing in this file changed; the identity it always assumed is now true.
  function findChild(addr: RuntimeAddress): ChildHandle | undefined {
    if (addr.objectKind !== "agent") return undefined;
    const owningParent = addr.parentWinterSessionId ?? addr.winterSessionId;
    return deps.getChildren().find((c) => c.record.id === addr.childId && c.record.parentSessionId === owningParent);
  }

  function permissionClassFor(addr: RuntimeAddress): PermissionClassLabel {
    if (addr.objectKind === "agent") {
      const child = findChild(addr);
      if (child === undefined) return "unknown";
      // T8 FLAG: ChildSessionRecord carries no bypass-availability signal of its own (only the
      // parent policy hash/version) -- conservatively `false` (see inbound.ts's own
      // classifyPermissionMode doc for why this is never silently guessed as `true`).
      return classifyPermissionMode(child.record.permission.effectiveMode, { bypassAvailable: false });
    }
    const peer = deps.peers.find(addr);
    if (peer === undefined) return "unknown";
    return classifyPermissionMode(peer.mode(), { bypassAvailable: peer.bypassAvailable() });
  }

  // Fix-round item 1 (WS-10 §10.2 MUST: "eligible LIVE peer sessions ... does NOT enumerate exited
  // transcripts"). "running"/"idle" are the only statuses under which deliverToSession's own
  // reachability short-circuit (below) runs ordinary inbound policy at all -- every other status
  // (exited/archived/unavailable, AND "starting") is refused or reported unavailable there with NO
  // mailbox side effect, before a receiver even exists to apply a policy decision against. DECISION:
  // "starting" is excluded from listing too, not just exited/archived/unavailable -- a message to a
  // "starting" peer is never queued (deliverToSession reports a bare retryable `unavailable` for it,
  // same as "unavailable"), so listing it as reachable would advertise a delivery guarantee this
  // reference cannot back up. This is the ONE gate listReachable's own peer loop (below) consults;
  // `peerRow` itself stays pure/unconditional so it remains correct if ever reused for a single
  // already-known-live peer instead of the full list.
  function isLiveForListing(status: ReturnType<PeerSessionHandle["status"]>): boolean {
    return status === "running" || status === "idle";
  }

  function peerRow(peer: PeerSessionHandle): ListedRuntimeObject {
    const status = peer.status();
    const reachableForMessage = status === "running" || status === "idle";
    return {
      address: serializeRuntimeAddress(peer.address),
      ...(peer.name !== undefined ? { name: peer.name } : {}),
      objectKind: "session",
      runtimeKind: "winter-agent",
      status,
      // T8 FLAG: see resolution.ts's own childToListedRuntimeObject for the identical note --
      // WS-10 §11 leaves `mode` as an untyped `string`; the companion doc's directory record types
      // it as the session/product mode ("code"|"chat"|"cowork"|"dispatch"|"build"), not a
      // PermissionMode. `PeerSessionHandle` (this file's own in-process abstraction) exposes only
      // `mode(): PermissionMode` -- there is no product-mode source to plug in here instead, so this
      // reference adapter substitutes the permission axis. Nothing downstream consumes this field
      // yet; a real daemon-side adapter (P8) would need an actual product-mode source.
      mode: peer.mode(),
      ...(peer.cwd !== undefined ? { cwd: peer.cwd } : {}),
      capabilities: {
        message: reachableForMessage,
        // Fix-round item 1: a PEER (a top-level session) is NEVER resume-capable through SendMessage
        // -- WS-10 §10.3: "Cold-resume ... is a separate session-resume operation, never SendMessage;
        // resumed_and_delivered MUST NOT be claimed for resume alone." The previous `status ===
        // "exited"` formula was backwards (it claimed a peer BECOMES resumable once exited, when the
        // truth is a peer is NEVER resumable this way, unlike a CHILD -- see
        // childToListedRuntimeObject's own `resume: !running`, which genuinely does depend on status).
        // Now moot in practice too: `isLiveForListing` above means this function only ever runs
        // against "running"/"idle" peers, where the old formula already produced `false` -- but the
        // field is hardcoded here rather than left as a status-keyed expression that would be WRONG
        // again the moment anything calls `peerRow` with a non-live peer in the future.
        resume: false,
        notifyWhenIdle: peer.hasReliableIdleSignal(),
        reply: reachableForMessage, // T8 FLAG: unpinned anywhere in WS-10/the companion doc; mirrors `message`
      },
    };
  }

  function reducedStatusFor(targetPeer: PeerSessionHandle, subscriberSessionId: string): boolean {
    const senderClass = classifyPermissionMode(targetPeer.mode(), { bypassAvailable: targetPeer.bypassAvailable() });
    const subscriberPeer = deps.peers.find({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: subscriberSessionId });
    // T8 FLAG: the subscriber (an ordinary main top-level session) is not necessarily registered as
    // a PEER of its own adapter instance -- when unknown, default conservatively to "prompts" (the
    // class most likely to hold an unrecognized/bypassing sender, per the WS-10 §13 matrix).
    const receiverClass: PermissionClassLabel = subscriberPeer !== undefined ? classifyPermissionMode(subscriberPeer.mode(), { bypassAvailable: subscriberPeer.bypassAvailable() }) : "prompts";
    // Fix-round item 2: idle.ts's own `fireIdle` contract calls this "the SAME inbound-policy
    // decision" deliverToSession/reevaluateHeldFor make for a REAL message -- both of which thread
    // the receiver's own explicit `crossSessionInbound` setting (resolveInboundDecision's contract:
    // an explicit setting always wins over the default matrix). Here the "receiver" role is the
    // SUBSCRIBER (the one who would hypothetically be receiving a message from the idling target),
    // so its explicit override -- not the target's -- is what must be threaded; an unregistered
    // subscriber has none to read, same as any other unknown-subscriber field above.
    const explicitSetting = subscriberPeer?.crossSessionInbound?.();
    return (
      resolveInboundDecision({
        authenticated: true,
        ...(explicitSetting !== undefined ? { explicitSetting } : {}),
        receiverClass,
        senderClass,
      }) === "hold"
    );
  }

  function pushIdleNotice(peer: PeerSessionHandle, messageId: string): void {
    const subscriberKey = deps.subscribers.lookup(messageId);
    if (subscriberKey === undefined) return; // defensive: router.ts always remembers before calling subscribeIdle
    const originLabel = peer.name !== undefined ? `${peer.name} (${serializeRuntimeAddress(peer.address)})` : serializeRuntimeAddress(peer.address);
    const reducedStatus = reducedStatusFor(peer, subscriberKey);
    deps.notifications.push(subscriberKey, {
      origin: originLabel,
      content: reducedStatus
        ? `${originLabel} changed state (reduced-status notice: the subscribing session is currently holding cross-session messages from this sender's class)`
        : `${originLabel} is now idle`,
      queuedAtMs: deps.now(),
    });
  }

  return {
    async listReachable(scope) {
      const rows: ListedRuntimeObject[] = [];
      if (scope.parent !== undefined) {
        const parentSessionId = scope.parent.winterSessionId;
        for (const child of deps.getChildren()) {
          if (child.record.parentSessionId === parentSessionId) rows.push(childToListedRuntimeObject(parentSessionId, child));
        }
      }
      for (const peer of deps.peers.list()) {
        if (isLiveForListing(peer.status())) rows.push(peerRow(peer));
      }
      return rows;
    },

    async steerChild(addr, msg) {
      const child = findChild(addr);
      if (child === undefined) return notFound(msg.messageId, "child no longer reachable");
      if (child.status() !== "running") return notFound(msg.messageId, `child ${addr.childId ?? "?"} is not running`);
      return child.steer(msg);
    },

    async resumeChild(addr, msg) {
      const child = findChild(addr);
      if (child === undefined) return notFound(msg.messageId, "child no longer reachable");
      // May throw ChildResumeModeIncomparableError (RULING P4-D) -- router.ts's own deliverEnvelope
      // is the catch boundary that turns it into a legible `refused` outcome; this adapter never
      // swallows it.
      return child.resume(msg);
    },

    async deliverToSession(addr, msg) {
      const peer = deps.peers.find(addr);
      if (peer === undefined) {
        return unavailable(msg.messageId, false, "target session is not reachable in-process (a real cross-process peer is a P8/host-integration concern)");
      }

      // WS-10 §10.3: "Cold-resume an exited top-level session ... is a separate session-resume
      // operation, never SendMessage; resumed_and_delivered MUST NOT be claimed for resume alone."
      // Only "running" and "idle" are ordinary deliverable states -- every other status is a
      // reachability short-circuit BEFORE inbound policy even runs (there is no receiver to apply a
      // policy decision against yet).
      const status = peer.status();
      if (status === "exited") {
        return unavailable(msg.messageId, false, "target session has exited; cold-resuming an exited session is a separate product operation, never a SendMessage side effect (WS-10 §10.3)");
      }
      if (status === "archived") {
        // Companion doc §10: "Archived session: refuse until a deliberate user/product resume
        // unarchives it" -- a policy refusal, not a transient unavailability.
        return refused(msg.messageId, "target session is archived; refused until a deliberate product-level resume unarchives it");
      }
      if (status === "starting" || status === "unavailable") {
        return unavailable(msg.messageId, true, `target session is currently "${status}", not yet reachable`);
      }
      // status is "running" or "idle" from here on -- ordinary deliverable states.

      const receiverKey = serializeRuntimeAddress(addr);
      const receiverClass = classifyPermissionMode(peer.mode(), { bypassAvailable: peer.bypassAvailable() });
      const explicitSetting = peer.crossSessionInbound?.();
      const decision = resolveInboundDecision({
        authenticated: true, // R4-5: every same-process peer here IS authenticated by construction; see this file's own header.
        ...(explicitSetting !== undefined ? { explicitSetting } : {}),
        receiverClass,
        senderClass: msg.senderPermissionClass,
      });

      if (decision === "refuse") {
        return refused(msg.messageId, "receiver's inbound policy refuses messages from this sender's permission class");
      }

      if (decision === "hold") {
        const now = deps.now();
        const entry =
          explicitSetting === "hold"
            ? buildExplicitHoldEntry(msg.messageId, "receiver holds all cross-session messages (explicit crossSessionInbound: hold)", now)
            : buildDefaultHoldEntry(msg.messageId, "receiver's default inbound policy holds this sender's permission class (WS-10 §13)", now);
        const ok = mailbox.hold(receiverKey, entry);
        if (!ok) return refused(msg.messageId, "held-message inbox is full (cap 100, WS-10 §13); refused visibly rather than silently dropped");
        rememberBounded(heldEnvelopes, msg.messageId, msg); // M10: bounded, oldest-first -- see router.ts's own rememberBounded header
        return held(msg.messageId, entry.reason);
      }

      // decision === "accept"
      const acceptedOk = mailbox.accept(receiverKey);
      if (!acceptedOk) return refused(msg.messageId, "accepted-message queue is full (cap 50, WS-10 §13); refused visibly rather than silently dropped");
      const wasRunning = peer.status() === "running";
      await peer.deliver(msg);
      // This reference's own `deliver` call is synchronous-complete (a direct, fire-and-forget call
      // into the fake/real peer) -- a real host's own queue would drain this over time (P8); this
      // reference releases the accepted-slot immediately rather than pretending to model that delay.
      mailbox.releaseAccepted(receiverKey);
      return wasRunning ? queued(msg.messageId) : delivered(msg.messageId);
    },

    async subscribeIdle(addr, req) {
      if (addr.objectKind !== "session") {
        return refused(req.messageId, "notify_when_idle targets a top-level session only (WS-10 §14)");
      }
      const peer = deps.peers.find(addr);
      if (peer === undefined || !peer.hasReliableIdleSignal()) {
        return refused(req.messageId, "adapter has no reliable idle signal for this target (WS-10 §14)");
      }
      const status = peer.status();
      if (status === "idle" || status === "exited") {
        // WS-10 §14: "send the notice immediately when the target is already idle."
        pushIdleNotice(peer, req.messageId);
        return subscribed(req.messageId);
      }
      // Deferred case: register a pending subscription keyed by the SUBSCRIBER's own session (via
      // SubscriberDirectory, this file's own header) -- NOT the target's address, which is what
      // `targetKey` already is. Getting these two swapped silently pushes every future notice into
      // the wrong queue (the target's own, which nothing ever drains).
      const subscriberKey = deps.subscribers.lookup(req.messageId);
      if (subscriberKey === undefined) {
        return refused(req.messageId, "internal: no subscriber was recorded for this messageId before subscribeIdle was called");
      }
      idleSubs.subscribe({ messageId: req.messageId, subscriberKey, targetKey: serializeRuntimeAddress(addr) }, deps.now());
      return subscribed(req.messageId);
    },

    async senderPermissionClass(addr) {
      return permissionClassFor(addr);
    },

    firePeerIdleTransition(address) {
      const peer = deps.peers.find(address);
      const targetKey = serializeRuntimeAddress(address);
      if (peer === undefined) {
        idleSubs.sweepExpired(deps.now());
        return;
      }
      const originLabel = peer.name !== undefined ? `${peer.name} (${targetKey})` : targetKey;
      // Each firing subscriber gets its OWN reducedStatus computation (idle.ts's own fireIdle
      // signature) -- a target with several simultaneous subscribers may owe a full notice to one
      // and a reduced-status notice to another, since each subscriber's own class against the SAME
      // idling target's class can differ.
      idleSubs.fireIdle(targetKey, deps.now(), (subscriberKey) => reducedStatusFor(peer, subscriberKey), deps.notifications, originLabel);
    },

    sweepExpiredIdleSubscriptions() {
      idleSubs.sweepExpired(deps.now());
    },

    async reevaluateHeldFor(address) {
      const peer = deps.peers.find(address);
      if (peer === undefined) return [];
      const receiverKey = serializeRuntimeAddress(address);
      const receiverClass = classifyPermissionMode(peer.mode(), { bypassAvailable: peer.bypassAvailable() });
      const explicitSetting = peer.crossSessionInbound?.();
      const promoted = mailbox.reevaluate(receiverKey, (entry) => {
        const envelope = heldEnvelopes.get(entry.messageId);
        const senderClass = envelope?.senderPermissionClass ?? "unknown";
        return resolveInboundDecision({ authenticated: true, ...(explicitSetting !== undefined ? { explicitSetting } : {}), receiverClass, senderClass });
      });

      const results: Array<{ messageId: string; outcome: DeliveryOutcome }> = [];
      for (const { entry, next } of promoted) {
        const envelope = heldEnvelopes.get(entry.messageId);
        heldEnvelopes.delete(entry.messageId);
        if (next === "refuse" || envelope === undefined) {
          results.push({ messageId: entry.messageId, outcome: refused(entry.messageId, "receiver's inbound policy now refuses this sender's permission class") });
          continue;
        }
        // next === "accept"
        const acceptedOk = mailbox.accept(receiverKey);
        if (!acceptedOk) {
          results.push({ messageId: entry.messageId, outcome: refused(entry.messageId, "accepted-message queue is full (cap 50, WS-10 §13); refused visibly rather than silently dropped") });
          continue;
        }
        const wasRunning = peer.status() === "running";
        await peer.deliver(envelope);
        mailbox.releaseAccepted(receiverKey);
        results.push({ messageId: entry.messageId, outcome: wasRunning ? queued(entry.messageId) : delivered(entry.messageId) });
      }
      return results;
    },

    sweepExpiredHeld() {
      const now = deps.now();
      const receiverKeys = deps.peers.list().map((p) => serializeRuntimeAddress(p.address));
      const results: Array<{ messageId: string; outcome: DeliveryOutcome }> = [];
      for (const receiverKey of receiverKeys) {
        // The 5-minute DEFAULT-class dialog expiry (WS-10 §13) -- mailbox.sweepExpired only ever
        // removes "default" entries; an "explicit" hold is untouched by this call by design (it
        // "persists ... until a later applicable accept, refusal, session end, or explicit bounded
        // product-retention rule," WS-10 §13).
        for (const entry of mailbox.sweepExpired(receiverKey, now)) {
          heldEnvelopes.delete(entry.messageId);
          results.push({ messageId: entry.messageId, outcome: refused(entry.messageId, "held message expired without a response (5-minute default dialog expiry, WS-10 §13)") });
        }
        // WS-10 §12's own "finite default TTL" MUST applies to EVERY message, independent of hold
        // kind -- an explicit hold has no dialog-expiry sweep of its own, so without this second
        // check it would sit in the mailbox forever. The message's own `expiresAt` (stamped at send
        // time, router.ts) is exactly the "explicit bounded product-retention rule" WS-10 §13 itself
        // names as the one thing that CAN still end an explicit hold's indefinite persistence.
        for (const entry of mailbox.listHeld(receiverKey)) {
          const envelope = heldEnvelopes.get(entry.messageId);
          if (envelope === undefined || envelope.expiresAt > now) continue;
          mailbox.takeHeld(receiverKey, entry.messageId);
          heldEnvelopes.delete(entry.messageId);
          results.push({ messageId: entry.messageId, outcome: refused(entry.messageId, "held message expired without a response (message TTL elapsed, WS-10 §12)") });
        }
      }
      return results;
    },
  };
}

// --- One-call wiring for a real host (or an integration test) --------------------------------------

export interface DefaultMessagingRuntime extends MessagingRuntimeDeps {
  adapter: ReferenceMessagingAdapter;
  peers: PeerDirectory;
}

// Builds a complete, self-consistent MessagingRuntimeDeps: the real seam (router.ts) + the reference
// adapter (this file) + a fresh peer directory + a fresh notification queue, all sharing the SAME
// clock. `getChildren` defaults to the seam's own aggregated roster (the ordinary case: the adapter
// sees every child any session in this process has registered); a caller MAY override it to scope
// the adapter to a narrower roster in a test.
export function createDefaultMessagingRuntime(opts: { now?: () => number; getChildren?: () => readonly ChildHandle[] } = {}): DefaultMessagingRuntime {
  const seam = createMessagingRouterSeam();
  const now = opts.now ?? (() => Date.now());
  const peers = createInMemoryPeerDirectory();
  const notifications = createNotificationQueue();
  const subscribers = createSubscriberDirectory();
  const adapter = createReferenceMessagingAdapter({
    getChildren: opts.getChildren ?? (() => seam.children()),
    peers,
    notifications,
    subscribers,
    now,
  });
  return { seam, adapter, notifications, loopGuard: createLoopGuard(), subscribers, now, peers };
}

// --- Phase 4 Task 8: the PROCESS-LEVEL default messaging runtime ---------------------------------
//
// Lane D's three tool executors (SendMessage/ListAgents/ReadNotifications) read a module singleton
// via `getMessagingRuntime()`, and nothing in this repository ever registered one -- so every one of
// them answered "no messaging runtime configured for this session" in a live session, however
// correct the router beneath them was. This is that registrar.
//
// PROCESS-level, deliberately, not per-run. A child engine is another `runEngine` loop in the SAME
// process (RULING R4-4), so a per-run `registerMessagingRuntime` would be clobbered by every child
// spawn -- the parent's own peers, held messages, notification queue and messageId ledger would all
// be silently replaced mid-turn by the child's fresh ones. One runtime per process, with each run
// CONTRIBUTING its own child roster through `addChildRosterSource` (router.ts's own seam, built for
// exactly this) and withdrawing it at teardown, is the shape that composes: the adapter's
// `children()` is then the union of every live session's roster, which is precisely what WS-10 §11's
// resolution rules need to see in order to resolve a name across the process.
//
// Idempotent and lazy: the first run to ask builds it; every later run reuses it. A host that wants
// its own real (daemon-backed, cross-process, durable) runtime registers one BEFORE any session
// starts and this function leaves it alone -- WS-10 §15's own split of ownership, unchanged.
export function ensureDefaultMessagingRuntimeRegistered(): MessagingRouterSeamWithRoster {
  const existing = getMessagingRuntime();
  if (existing !== undefined) return existing.seam as MessagingRouterSeamWithRoster;
  const runtime = createDefaultMessagingRuntime();
  registerMessagingRuntime(runtime);
  return runtime.seam as MessagingRouterSeamWithRoster;
}
