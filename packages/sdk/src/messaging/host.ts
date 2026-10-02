// Host messaging: the seam through which a session's `SendMessage` and `ListAgents` reach the sessions
// its HOST owns (`Options.hostMessaging`, the `host_message_send` / `host_message_list` control requests).
//
// WHY A SEAM AND NOT A PEER. The in-process reference adapter's peer directory holds what this process
// holds: the calling session, and nothing else, because every other session of a multi-session host
// (the Winter daemon) is another process or another Worker. Registering fake peers for them would make
// the adapter answer for deliveries it cannot perform -- and §11's resolution rules would start
// resolving host session NAMES against local ones. So the router core asks the host only after its own
// resolution came back `not_found`, with the model's raw `to`, and the host resolves in its own
// directory. What stays in-process stays exactly as it was: subagents, the self-target refusal, the
// stale-name and ambiguity rules, the bounds and the loop guard (all of which run BEFORE this seam).
//
// Both sides validate: the wrapper checks the host callback's answer before it goes on the wire
// (`query.ts`), and the runtime checks the wire answer before the router core reads it. The same guards,
// once, here.
import type { HostMessageListAnswer, HostMessageListRequest, HostMessageSendAnswer, HostMessageSendRequest, HostReachableSession } from "../protocol/config.ts";
import type { DeliveryOutcome, ListedRuntimeObject } from "./adapter.ts";
import { validateToField } from "./addressing.ts";

/** What the router core needs from a host: the two halves of `Options.hostMessaging`, already bound to one session. */
export interface HostMessagingPort {
  send(request: HostMessageSendRequest): Promise<HostMessageSendAnswer>;
  list(request: HostMessageListRequest): Promise<HostMessageListAnswer>;
}

const SEND_STATUSES: ReadonlySet<string> = new Set(["delivered", "queued", "resumed_and_delivered", "refused", "not_found", "unavailable", "delivery_uncertain"]);
const NEEDS_REASON: ReadonlySet<string> = new Set(["refused", "not_found", "unavailable", "delivery_uncertain"]);
const LISTED_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "idle", "exited", "unavailable", "archived"]);
/** A host's sentence for the model is bounded: it is rendered into a tool result. */
export const HOST_MESSAGE_NOTE_MAX = 500;
/** A host listing is bounded: it is rendered into a tool result, one line per row. */
export const HOST_MESSAGE_LIST_MAX = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The request shape, checked on the WRAPPER side before the host's callback sees it. */
export function isHostMessageSendRequest(payload: unknown): payload is HostMessageSendRequest {
  if (!isRecord(payload)) return false;
  return (
    typeof payload.to === "string" &&
    typeof payload.message === "string" &&
    typeof payload.messageId === "string" &&
    (payload.summary === undefined || typeof payload.summary === "string") &&
    (payload.notifyWhenIdle === undefined || typeof payload.notifyWhenIdle === "boolean") &&
    (payload.fromAgentId === undefined || typeof payload.fromAgentId === "string")
  );
}

export function isHostMessageListRequest(payload: unknown): payload is HostMessageListRequest {
  if (payload === undefined) return true;
  return isRecord(payload) && (payload.fromAgentId === undefined || typeof payload.fromAgentId === "string");
}

/** A well-formed send answer: a known status, a reason wherever one is required, the optional facts typed. */
export function isHostMessageSendAnswer(value: unknown): value is HostMessageSendAnswer {
  if (!isRecord(value)) return false;
  if (typeof value.status !== "string" || !SEND_STATUSES.has(value.status)) return false;
  if (value.reason !== undefined && typeof value.reason !== "string") return false;
  if (NEEDS_REASON.has(value.status) && (typeof value.reason !== "string" || value.reason.length === 0)) return false;
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") return false;
  if (value.note !== undefined && typeof value.note !== "string") return false;
  if (value.notify !== undefined) {
    if (!isRecord(value.notify)) return false;
    if (value.notify.subscribed !== undefined && value.notify.subscribed !== true) return false;
    if (value.notify.refused !== undefined && typeof value.notify.refused !== "string") return false;
  }
  return true;
}

function isHostReachableSession(value: unknown): value is HostReachableSession {
  if (!isRecord(value)) return false;
  if (typeof value.address !== "string" || !validateToField(value.address).ok) return false;
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.includes("\n"))) return false;
  if (typeof value.status !== "string" || !LISTED_STATUSES.has(value.status)) return false;
  if (typeof value.mode !== "string") return false;
  if (value.cwd !== undefined && typeof value.cwd !== "string") return false;
  return true;
}

/**
 * A list answer, normalised: every malformed row is DROPPED (one bad row must not hide the others, and
 * an unaddressable row would advertise a target the model cannot name), and the listing is capped.
 * `undefined` for an answer that is not a listing at all.
 */
export function normaliseHostMessageListAnswer(value: unknown): HostMessageListAnswer | undefined {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return undefined;
  const sessions = value.sessions.filter(isHostReachableSession).slice(0, HOST_MESSAGE_LIST_MAX);
  return {
    sessions: sessions.map((s) => ({
      address: s.address,
      ...(s.name !== undefined ? { name: s.name } : {}),
      status: s.status,
      mode: s.mode,
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
    })),
  };
}

/** A host's session row as a ListAgents row: always a `session` of the Winter runtime, never resumable "for free" or idle-notifiable unless the host says so through SendMessage itself. */
export function hostSessionToListed(row: HostReachableSession): ListedRuntimeObject {
  const reachable = row.status !== "archived" && row.status !== "unavailable";
  return {
    address: row.address,
    ...(row.name !== undefined ? { name: row.name } : {}),
    objectKind: "session",
    runtimeKind: "winter-agent",
    status: row.status,
    mode: row.mode,
    ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
    capabilities: { message: reachable, resume: reachable, notifyWhenIdle: false, reply: reachable },
  };
}

/** The host's answer as the router's outcome, under the RUNTIME's message id. Assumes `isHostMessageSendAnswer`. */
export function hostAnswerToOutcome(messageId: string, answer: HostMessageSendAnswer): DeliveryOutcome {
  const reason = answer.reason ?? answer.status;
  switch (answer.status) {
    case "delivered":
    case "queued":
    case "resumed_and_delivered":
      return { status: answer.status, messageId };
    case "refused":
      return { status: "refused", messageId, reason };
    case "not_found":
      return { status: "not_found", messageId, reason };
    case "unavailable":
      return { status: "unavailable", messageId, retryable: answer.retryable === true, reason };
    case "delivery_uncertain":
      return { status: "delivery_uncertain", messageId, deliveryMayHaveOccurred: true, reason };
  }
}

/** A host note, cut to its bound (it is model-visible). Empty and absent read the same. */
export function boundedHostNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > HOST_MESSAGE_NOTE_MAX ? `${trimmed.slice(0, HOST_MESSAGE_NOTE_MAX - 1)}…` : trimmed;
}
