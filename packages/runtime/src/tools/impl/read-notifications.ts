// Task 7 (Lane D, WS-10 §14 / WS-06 §3.6): the ReadNotifications executor — since R-8-1, a thin
// binding of the SDK's own handler (see impl/send-message.ts's header for the reasoning).
//
// Drains Winter's own global-messaging notification queue: the idle/exit notices a
// `notify_when_idle` subscription produced, which the messaging subpath's idle.ts documents as the
// queue's sole producer at this phase.
//
// ONE MODEL-VISIBLE CHANGE (ruling P-4): input is `{}` and a stray field is now REFUSED. This file
// used to state the opposite posture out loud — "this executor does not reject a call carrying stray
// fields; it simply never reads them" — mirroring ListAgents's own reserved-field tolerance. Both are
// corrected together: an acceptor that quietly takes an extra field is a second, undocumented schema,
// and here there is not even a reserved field to be tolerant about.
import "../descriptors/read-notifications.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { acceptNativeReadNotificationsArgs, createMessagingToolHandlers, messagingToolPortFromRuntimeDeps, READ_NOTIFICATIONS_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";
import { getMessagingRuntime } from "../../messaging/router.ts";
import { callerContextFrom } from "./send-message.ts";

/** Read off the one definition, so the registered name and the descriptor's can never disagree. */
export const READ_NOTIFICATIONS_TOOL_NAME = READ_NOTIFICATIONS_DEFINITION.builtinName ?? READ_NOTIFICATIONS_DEFINITION.toolName;

export const readNotificationsExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    // Schema first, infrastructure second -- see impl/send-message.ts's own note.
    const accepted = acceptNativeReadNotificationsArgs(input);
    if (!accepted.ok) return { output: accepted.reason, isError: true };

    const runtime = getMessagingRuntime();
    if (runtime === undefined) {
      return { output: "Error: ReadNotifications has no messaging runtime configured for this session", isError: true };
    }
    const handlers = createMessagingToolHandlers(messagingToolPortFromRuntimeDeps(runtime), callerContextFrom(ctx));
    const { text, isError } = await handlers.readNotifications(input);
    return { output: text, ...(isError === true ? { isError: true } : {}) };
  },
};

replaceExecutor(READ_NOTIFICATIONS_TOOL_NAME, readNotificationsExecutor);
