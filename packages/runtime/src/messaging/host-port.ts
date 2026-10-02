// Host messaging, the runtime's half: a `HostMessagingPort` (the router core's seam to a multi-session
// host's OTHER sessions) over this session's own control bridge -- `host_message_send` and
// `host_message_list`, runtime -> host, answered by the wrapper's `Options.hostMessaging`.
//
// Built only for a TOP-LEVEL run whose config says `hostMessaging: true` (a flag `query()` sets exactly
// when the host passed the handler, so this never asks a host that cannot answer), and registered
// against that run's session id in the process-level messaging runtime. A subagent shares its parent's
// session id, so its SendMessage reaches the same port through the same lookup, and a child engine never
// registers one of its own. Identical in the two topologies: a spawned `winter` process and an embedded
// Worker both run this engine over the same frame stream.
import { HOST_MESSAGE_LIST_SUBTYPE, HOST_MESSAGE_SEND_SUBTYPE } from "@yanlinglabs/winter-agent-sdk";
import { isHostMessageSendAnswer, normaliseHostMessageListAnswer, type HostMessagingPort } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { HostRequestSender } from "../provider/host-credentials.ts";

/**
 * How long one delivery may take. Generous on purpose: a host may RESUME a finished session for the
 * message (start its runtime, replay its transcript, connect its MCP servers) before it can answer. A
 * timeout is `delivery_uncertain`, never `not_found` -- by then the host may well have delivered.
 */
export const HOST_MESSAGE_SEND_TIMEOUT_MS = 180_000;
/** How long a listing may take; a slow one lists nothing more (ListAgents still shows the subagents). */
export const HOST_MESSAGE_LIST_TIMEOUT_MS = 15_000;

/** Thrown for a malformed send answer, so the router core reports it as `delivery_uncertain`. */
export class HostMessagingAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostMessagingAnswerError";
  }
}

export function createHostMessagingPort(sender: HostRequestSender): HostMessagingPort {
  return {
    async send(request) {
      const answer = await sender.request(HOST_MESSAGE_SEND_SUBTYPE, request, { timeoutMs: HOST_MESSAGE_SEND_TIMEOUT_MS });
      if (!isHostMessageSendAnswer(answer)) throw new HostMessagingAnswerError("the host answered host_message_send with a malformed outcome");
      return answer;
    },
    async list(request) {
      const answer = await sender.request(HOST_MESSAGE_LIST_SUBTYPE, request, { timeoutMs: HOST_MESSAGE_LIST_TIMEOUT_MS });
      return normaliseHostMessageListAnswer(answer) ?? { sessions: [] };
    },
  };
}
