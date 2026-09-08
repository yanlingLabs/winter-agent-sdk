// The messaging seam types + the runtime adapter contract (WS-10 §11/§12/§15, messaging companion
// §4/§8/§9). NO routing/addressing/delivery logic lives here -- only the shapes every party to
// cross-runtime messaging must agree on.
//
// PHASE 7B (R-7b-4, "move down into it"): this file used to live in the private runtime package and
// name `ChildHandle` (the runtime's own child-engine handle) directly. It is now published as
// `@yanlinglabs/winter-agent-sdk/messaging`, consumed by three parties -- the Winter runtime's
// in-process reference adapter, the router package's two `RuntimeMessagingAdapter`s, and any host
// that composes them -- so the one runtime-only type it named is replaced by `ChildLike` below: the
// BOUNDARY interface stating exactly what messaging needs a child to be. The runtime's `ChildHandle`
// satisfies it structurally, with no adaptation and no import in this direction.
import type { PermissionMode } from "../permissions/types.ts";

// --- WS-10 §11: addressing (messaging companion §4, absorbed verbatim with WS-01 names applied) ---

export type RuntimeKind = "claude-agent" | "winter-agent";
export type RuntimeObjectKind = "session" | "agent";

export interface RuntimeAddress {
  objectKind: RuntimeObjectKind;
  runtimeKind: RuntimeKind;
  winterSessionId: string; // product id, s_<hex> (WS-01 §4)
  backendSessionId?: string; // absent only while "starting"
  parentWinterSessionId?: string;
  childId?: string;
}

// WS-10 §11's own opaque serialization: `session:<winterSessionId>` and
// `agent:<parentWinterSessionId>:<childId>` -- runtime kind and backend IDs live in the directory
// record, never trusted from user/model text (that's WS-15's own RuntimeDirectory, not this file).
export function serializeRuntimeAddress(addr: RuntimeAddress): string {
  if (addr.objectKind === "session") return `session:${addr.winterSessionId}`;
  if (addr.childId === undefined) {
    throw new Error("serializeRuntimeAddress: objectKind 'agent' requires childId");
  }
  const parent = addr.parentWinterSessionId ?? addr.winterSessionId;
  return `agent:${parent}:${addr.childId}`;
}

export interface ListedRuntimeObject {
  address: string; // opaque serialization above
  name?: string;
  objectKind: RuntimeObjectKind;
  runtimeKind: RuntimeKind;
  status: "starting" | "running" | "idle" | "exited" | "unavailable" | "archived";
  mode: string;
  cwd?: string;
  capabilities: { message: boolean; resume: boolean; notifyWhenIdle: boolean; reply: boolean };
}

// --- WS-10 §12 / messaging companion §9: delivery outcomes, verbatim -------------------------------

export type DeliveryOutcome =
  | { status: "delivered"; messageId: string }
  | { status: "queued"; messageId: string }
  | { status: "resumed_and_delivered"; messageId: string }
  | { status: "held"; messageId: string; reason: string }
  | { status: "subscribed"; messageId: string }
  | { status: "delivery_uncertain"; messageId: string; deliveryMayHaveOccurred: true; reason: string }
  | { status: "refused"; messageId: string; reason: string }
  | { status: "ambiguous"; messageId: string; candidates: ListedRuntimeObject[] }
  | { status: "not_found"; messageId: string; reason: string }
  | { status: "unavailable"; messageId: string; retryable: boolean; reason: string };

// --- messaging companion §8: the internal message envelope, verbatim -------------------------------
//
// NEVER the model-facing SendMessageInput schema (WS-10 §10.1 owns that, Lane D's own
// tools/impl/send-message.ts) -- this is the fully-resolved, ADDRESSED envelope a router constructs
// once a target has been selected, carrying provenance (`from`/`fromGeneration`) the model-facing
// tool call never supplies directly.
export interface GlobalAgentMessage {
  messageId: string;
  from: RuntimeAddress;
  fromGeneration: number;
  to: RuntimeAddress;
  toGeneration: number;
  body: string;
  summary?: string;
  notifyWhenIdle: boolean;
  createdAt: number;
  expiresAt: number;
  hopCount: number;
  originToolCallId?: string;
  senderPermissionClass: "prompts" | "bypasses" | "unknown";
}

// --- R-7b-4: the child BOUNDARY interface ---------------------------------------------------------
//
// "What messaging needs a child to be", and nothing more. Four members, each load-bearing for a
// named rule:
//
//   * `record.id` / `record.parentSessionId` -- WS-10 §11 rules 2/3/5 resolve a child BY id within
//     the caller's owning parent, and rule 5's stale-name refusal counts DISTINCT ids under one name.
//   * `record.name` -- rules 3/4/5 (display-name resolution, ambiguity, staleness).
//   * `record.permission.effectiveMode` -- WS-10 §13's sender/receiver permission CLASS.
//   * `status()` -- WS-10 §10.3's steer-vs-resume split (a RUNNING child is steered; a TERMINAL,
//     addressable one is resumed; never the reverse).
//   * `steer` / `resume` -- the two delivery doors an adapter drives once the router has chosen one.
//
// Deliberately NOT `result()`/`stop()`: those are the Agent tool's own lifecycle surface, and a
// messaging adapter that could reach them could stop a child it was only asked to message.
export type ChildLikeStatus = "running" | "completed" | "stopped" | "failed";

export interface ChildLikeRecord {
  id: string;
  parentSessionId: string;
  name?: string;
  permission: { effectiveMode: PermissionMode };
}

export interface ChildLike {
  readonly record: ChildLikeRecord;
  status(): ChildLikeStatus;
  steer(msg: GlobalAgentMessage): Promise<DeliveryOutcome>; // running child
  resume(msg: GlobalAgentMessage): Promise<DeliveryOutcome>; // terminal child with resume state
}

// --- WS-10 §15: the runtime adapter contract, verbatim ----------------------------------------------
//
// Adapters perform owner-specific operations only; the daemon (WS-15) authors canonical addresses,
// inbox state, name leases, and delivery records. Lane D implements this as the in-process
// reference adapter; NO routing logic lives in this spine file.
export interface RuntimeMessagingAdapter {
  listReachable(scope: { parent?: RuntimeAddress }): Promise<ListedRuntimeObject[]>;
  steerChild(addr: RuntimeAddress, msg: GlobalAgentMessage): Promise<DeliveryOutcome>; // running child
  resumeChild(addr: RuntimeAddress, msg: GlobalAgentMessage): Promise<DeliveryOutcome>; // terminal child w/ resume state
  deliverToSession(addr: RuntimeAddress, msg: GlobalAgentMessage): Promise<DeliveryOutcome>; // running (queue at tool boundary) or idle (start one turn)
  subscribeIdle(addr: RuntimeAddress, req: { messageId: string }): Promise<DeliveryOutcome>; // "subscribed" or typed refusal
  senderPermissionClass(addr: RuntimeAddress): Promise<"prompts" | "bypasses" | "unknown">;
}

// --- The router seam ------------------------------------------------------------------------------
//
// The bookkeeping half of routing: message-id allocation, the outcome ledger a retry short-circuits
// on (WS-10 §12), and the live child roster resolution reads. `router.ts` implements it; a host that
// owns durable state supplies its own. `children()` is filled from whatever roster source the host
// has -- in the Winter runtime that is `EngineOptions.onChildRosterReady?(getChildren)`, called once
// per run with a live `() => readonly ChildLike[]` getter, and every run's roster is aggregated
// (`addChildRosterSource`, router.ts) because resolution rules 2/3/5 must see the whole process.
export interface MessagingRouterSeam {
  allocateMessageId(senderSessionId: string, toolUseId: string): string;
  recordOutcome(messageId: string, outcome: DeliveryOutcome): void;
  lookupOutcome(messageId: string): DeliveryOutcome | undefined;
  children(): ChildLike[];
}

// Test-only fake (mirrors this whole phase's own "shape + fake here, real impl is the lane's job"
// precedent -- mcp/state.ts, mcp/control-seam.ts). `allocateMessageId` is deterministic per
// (senderSessionId, toolUseId) pair, matching WS-10 §12's own "derived/persisted from the sender
// session plus tool-call ID... a retry with the same ID returns the stored outcome" requirement --
// the SAME pair always allocates the SAME id, so a caller's own retry logic can rely on it.
export interface FakeMessagingRouterSeam extends MessagingRouterSeam {
  readonly outcomes: Map<string, DeliveryOutcome>;
  setChildren(children: ChildLike[]): void;
}

export function createFakeMessagingRouterSeam(): FakeMessagingRouterSeam {
  const outcomes = new Map<string, DeliveryOutcome>();
  const idsBySenderAndTool = new Map<string, string>();
  let children: ChildLike[] = [];
  let counter = 0;

  return {
    outcomes,
    setChildren(next: ChildLike[]): void {
      children = next;
    },
    allocateMessageId(senderSessionId: string, toolUseId: string): string {
      const key = `${senderSessionId}:${toolUseId}`;
      const existing = idsBySenderAndTool.get(key);
      if (existing !== undefined) return existing; // same (session, tool-call) pair -- stable across retries
      const id = `msg-${++counter}`;
      idsBySenderAndTool.set(key, id);
      return id;
    },
    recordOutcome(messageId: string, outcome: DeliveryOutcome): void {
      outcomes.set(messageId, outcome);
    },
    lookupOutcome(messageId: string): DeliveryOutcome | undefined {
      return outcomes.get(messageId);
    },
    children(): ChildLike[] {
      return children;
    },
  };
}
