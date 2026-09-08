// The `winter` wire's per-session MESSAGING FACET: six control-request subtypes, their payload
// shapes, and the structural guards BOTH sides run (R-7b-4).
//
// WHY IT EXISTS. `@yanlinglabs/winter-runtime-sdk` runs in the HOST process and owns the
// RuntimeDirectory plus the cross-runtime router. A spawned Winter session's children live inside
// THAT process, behind a pipe -- so without this facet the router can address a `winter` session but
// nothing inside it, and WS-15 §6.2's routing-behaviour table has no rows for "running Winter
// child" / "terminal Winter child" at all.
//
// WHAT IT IS, exactly: `RuntimeMessagingAdapter` (WS-10 §15) on the wire, 1:1, six methods to six
// subtypes. It is the ADAPTER, never the router. Resolution (WS-10 §11's rules 1-6), ambiguity,
// dedupe, the loop guard, hold/refuse policy, retries and the outcome ledger all run in the ROUTER,
// in the host's process, ABOVE this -- exactly where they run for the official branch, which is what
// makes one set of rules govern both runtimes. A facet that resolved names itself would be a second
// implementation of §11, reachable only from one runtime.
//
// ADDRESSING ON THE WIRE. `deliver` carries a fully-addressed `GlobalAgentMessage`, so its target is
// `message.to` and nothing else. The three id-taking calls accept EITHER a canonical serialized
// address (`session:<id>` / `agent:<parent>:<child>`, WS-10 §11) or a bare stable child id, which is
// interpreted within the receiving session -- `resolveFacetTarget` below is the one place that rule
// is written, and it never falls back to display-name lookup (that is the router's rule 3, and it
// needs the whole directory to be correct).
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress, RuntimeObjectKind, RuntimeKind } from "../messaging/index.ts";

/** The six subtypes, in one place, so neither side spells a literal the other does not. */
export const MESSAGING_CONTROL_SUBTYPES = {
  listReachable: "messaging.list_reachable",
  deliver: "messaging.deliver",
  steerChild: "messaging.steer_child",
  resumeChild: "messaging.resume_child",
  subscribeIdle: "messaging.subscribe_idle",
  senderClass: "messaging.sender_class",
} as const;

export type MessagingControlSubtype = (typeof MESSAGING_CONTROL_SUBTYPES)[keyof typeof MESSAGING_CONTROL_SUBTYPES];

/** Every subtype this facet serves, for a runtime-side dispatch check and for the parity test. */
export const MESSAGING_CONTROL_SUBTYPE_LIST: readonly MessagingControlSubtype[] = Object.values(MESSAGING_CONTROL_SUBTYPES);

// --- request payloads ----------------------------------------------------------------------------

/** `messaging.list_reachable` and `messaging.sender_class` are payload-free (like the pinned `list_models`). */
export interface MessagingDeliverRequest {
  message: GlobalAgentMessage;
}

export interface MessagingChildRequest {
  /** A canonical address, or a bare child id read within the receiving session. */
  id: string;
  message: GlobalAgentMessage;
}

export interface MessagingSubscribeIdleRequest {
  /** A canonical address, or a bare child id read within the receiving session. */
  id: string;
  /**
   * The HOST's own message id. The facet never allocates one: allocation is the router's
   * (WS-10 §12 keys it to the sender session plus tool-call id), and a second allocator on the far
   * side of a pipe would break the retry idempotency that key exists for.
   */
  messageId: string;
  /**
   * Whose notification queue an eventual idle notice belongs to. WS-10 §15's `subscribeIdle(addr,
   * {messageId})` carries no subscriber at all, and the in-process reference answers that gap with a
   * router-side directory keyed by messageId -- which a REMOTE caller cannot write into. So the
   * caller names it here; absent means the receiving session itself.
   */
  subscriberSessionId?: string;
}

// --- response payloads ---------------------------------------------------------------------------

export interface MessagingSenderClassResponse {
  senderClass: PermissionClassLabel;
}

// --- structural guards, run on BOTH sides ---------------------------------------------------------
//
// Hand-rolled, in the style of `isModelFamilyListing` (query.ts) and the engine's own `set_model`
// payload check: this repository carries no schema library, and the shapes are small and closed.
// Deliberately STRUCTURAL rather than deep -- each guard checks exactly the fields the consumer
// then branches on, because a check nobody branches on is a check that only fails on honest input.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const RUNTIME_OBJECT_KINDS: readonly RuntimeObjectKind[] = ["session", "agent"];
const RUNTIME_KINDS: readonly RuntimeKind[] = ["claude-agent", "winter-agent"];
const PERMISSION_CLASS_LABELS: readonly PermissionClassLabel[] = ["prompts", "bypasses", "unknown"];
const DELIVERY_STATUSES: readonly DeliveryOutcome["status"][] = [
  "delivered",
  "queued",
  "resumed_and_delivered",
  "held",
  "subscribed",
  "delivery_uncertain",
  "refused",
  "ambiguous",
  "not_found",
  "unavailable",
];

export function isRuntimeAddress(v: unknown): v is RuntimeAddress {
  if (!isRecord(v)) return false;
  if (!RUNTIME_OBJECT_KINDS.includes(v.objectKind as RuntimeObjectKind)) return false;
  if (!RUNTIME_KINDS.includes(v.runtimeKind as RuntimeKind)) return false;
  if (typeof v.winterSessionId !== "string" || v.winterSessionId.length === 0) return false;
  // An `agent` address without a childId cannot even be SERIALIZED (serializeRuntimeAddress throws),
  // so accepting one here would push a programmer error one layer deeper before it surfaced.
  if (v.objectKind === "agent" && (typeof v.childId !== "string" || v.childId.length === 0)) return false;
  return true;
}

export function isGlobalAgentMessage(v: unknown): v is GlobalAgentMessage {
  if (!isRecord(v)) return false;
  if (typeof v.messageId !== "string" || v.messageId.length === 0) return false;
  if (!isRuntimeAddress(v.from) || !isRuntimeAddress(v.to)) return false;
  if (typeof v.body !== "string") return false;
  if (typeof v.notifyWhenIdle !== "boolean") return false;
  if (typeof v.hopCount !== "number") return false;
  if (!PERMISSION_CLASS_LABELS.includes(v.senderPermissionClass as PermissionClassLabel)) return false;
  return true;
}

export function isDeliveryOutcome(v: unknown): v is DeliveryOutcome {
  if (!isRecord(v)) return false;
  if (!DELIVERY_STATUSES.includes(v.status as DeliveryOutcome["status"])) return false;
  if (typeof v.messageId !== "string") return false;
  // The two variants a consumer reads a SECOND field off: an `ambiguous` outcome whose candidates
  // were dropped would look like an empty candidate list -- "the router never chooses arbitrarily"
  // (WS-10 §11) then has nothing to offer the user; an `unavailable` without `retryable` would be
  // read as `retryable: undefined`, which is neither of the two answers §6.2 defines.
  if (v.status === "ambiguous" && !Array.isArray(v.candidates)) return false;
  if (v.status === "unavailable" && typeof v.retryable !== "boolean") return false;
  return true;
}

export function isListedRuntimeObjectArray(v: unknown): v is ListedRuntimeObject[] {
  return (
    Array.isArray(v) &&
    v.every((row) => isRecord(row) && typeof row.address === "string" && RUNTIME_OBJECT_KINDS.includes(row.objectKind as RuntimeObjectKind) && isRecord(row.capabilities))
  );
}

export function isPermissionClassLabel(v: unknown): v is PermissionClassLabel {
  return typeof v === "string" && PERMISSION_CLASS_LABELS.includes(v as PermissionClassLabel);
}

export function isMessagingDeliverRequest(v: unknown): v is MessagingDeliverRequest {
  return isRecord(v) && isGlobalAgentMessage(v.message);
}

export function isMessagingChildRequest(v: unknown): v is MessagingChildRequest {
  return isRecord(v) && typeof v.id === "string" && v.id.length > 0 && isGlobalAgentMessage(v.message);
}

export function isMessagingSubscribeIdleRequest(v: unknown): v is MessagingSubscribeIdleRequest {
  if (!isRecord(v)) return false;
  if (typeof v.id !== "string" || v.id.length === 0) return false;
  if (typeof v.messageId !== "string" || v.messageId.length === 0) return false;
  if (v.subscriberSessionId !== undefined && typeof v.subscriberSessionId !== "string") return false;
  return true;
}

// --- the one addressing rule the facet owns -------------------------------------------------------

/**
 * Turns a facet `id` into a `RuntimeAddress` within the receiving session.
 *
 * TWO forms, and no third:
 *   1. a CANONICAL address (`session:<id>` / `agent:<parent>:<child>`) -- parsed by WS-10 §11's own
 *      inverse, so a router that already holds a directory entry addresses it exactly;
 *   2. a bare stable CHILD id -- read within the receiving session, which is the only scope in which
 *      a child id means anything (WS-10 §10.3: a child is reachable only through its owning parent).
 *
 * It deliberately does NOT fall back to display-name lookup. That is resolution rule 3, and rules
 * 3/4/5 are inseparable -- a name that resolves here would be a name that never got its ambiguity
 * and staleness checks, because those need the whole directory the router holds and this side does
 * not.
 */
export function resolveFacetTarget(sessionId: string, id: string, parse: (s: string) => RuntimeAddress | undefined, buildChild: (parent: string, childId: string) => RuntimeAddress): RuntimeAddress {
  return parse(id) ?? buildChild(sessionId, id);
}
