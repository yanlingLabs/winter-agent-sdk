// Phase 4 Task 3 (WS-10 §11/§12/§15, messaging companion §4/§8/§9): the messaging seam types + the
// runtime adapter contract. Lane D (Task 7) implements `RuntimeMessagingAdapter` (the in-process
// reference) and `MessagingRouterSeam`'s own routing logic; this file owns ONLY the shapes + the
// engine-side hook Lane D's router consumes (`children()`, sourced from the child roster) -- NO
// routing/addressing/delivery logic lives here (WS-10 §15's own split: "this spec owns the
// model-facing schemas/semantics... and the runtime adapter contract... WS-15 owns the
// RuntimeDirectory + global messaging service that consumes it").
//
// `ChildHandle` is imported type-only from subagents/child-handle.ts, which in turn imports
// `GlobalAgentMessage`/`DeliveryOutcome` type-only from THIS file -- a mutual type reference with no
// runtime cycle at all (both imports are erased entirely at compile time; neither file needs a VALUE
// from the other), the same pattern TypeScript supports for any two interfaces that reference each
// other structurally.
import type { ChildHandle } from "../subagents/child-handle.ts";

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

// --- Phase 4 Task 3's own addition: the router seam ---------------------------------------------
//
// Lane D (Task 7) implements the actual routing/dedup/idempotency logic; this interface is the
// contract their router satisfies, proven by the seam contract tests (subagents/seam-contracts-p4.
// test.ts). `children()` should be filled from the live child roster, but this spine does NOT
// construct a real MessagingRouterSeam anywhere -- engine.ts exposes only the roster DATA SOURCE,
// via `EngineOptions.onChildRosterReady?(getChildren)` (called once, synchronously, near the start
// of the run, handing the caller a live `() => readonly ChildHandle[]` getter -- see that field's
// own doc comment in engine.ts). Lane D's own router is what actually builds a real
// MessagingRouterSeam object, plugging `children()` in as `() => getChildren()` (or equivalent)
// against the getter this callback hands it; allocateMessageId/recordOutcome/lookupOutcome are
// entirely Lane D's own job, with no partial/fake version of them shipped here. This spine ships
// only `createFakeMessagingRouterSeam` (below), for its own contract tests.
export interface MessagingRouterSeam {
  allocateMessageId(senderSessionId: string, toolUseId: string): string;
  recordOutcome(messageId: string, outcome: DeliveryOutcome): void;
  lookupOutcome(messageId: string): DeliveryOutcome | undefined;
  children(): ChildHandle[];
}

// Test-only fake (mirrors this whole phase's own "shape + fake here, real impl is the lane's job"
// precedent -- mcp/state.ts, mcp/control-seam.ts). `allocateMessageId` is deterministic per
// (senderSessionId, toolUseId) pair, matching WS-10 §12's own "derived/persisted from the sender
// session plus tool-call ID... a retry with the same ID returns the stored outcome" requirement --
// the SAME pair always allocates the SAME id, so a caller's own retry logic can rely on it.
export interface FakeMessagingRouterSeam extends MessagingRouterSeam {
  readonly outcomes: Map<string, DeliveryOutcome>;
  setChildren(children: ChildHandle[]): void;
}

export function createFakeMessagingRouterSeam(): FakeMessagingRouterSeam {
  const outcomes = new Map<string, DeliveryOutcome>();
  const idsBySenderAndTool = new Map<string, string>();
  let children: ChildHandle[] = [];
  let counter = 0;

  return {
    outcomes,
    setChildren(next: ChildHandle[]): void {
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
    children(): ChildHandle[] {
      return children;
    },
  };
}
