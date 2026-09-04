// Task 7 (Lane D, WS-10 §14 / WS-06 §3.6): the ReadNotifications executor -- drains Winter's own
// global-messaging notification queue (idle/exit notices from notify_when_idle subscriptions;
// messaging/idle.ts's own header documents this as the queue's sole producer at this phase). Input
// is `{}` (additionalProperties: false, per the pinned descriptor) -- there is nothing to validate
// beyond "an object, if anything was even passed at all," so this executor does not reject a
// call carrying stray fields; it simply never reads them (mirrors ListAgents's own `channel`/`q`
// posture: an inert extra is not a reason to fail an otherwise-harmless call).
import "../descriptors/read-notifications.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { getMessagingRuntime, readNotifications } from "../../messaging/router.ts";

export const READ_NOTIFICATIONS_TOOL_NAME = "ReadNotifications";

export const readNotificationsExecutor: ToolExecutor = {
  async execute(_input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const runtime = getMessagingRuntime();
    if (runtime === undefined) {
      return { output: "Error: ReadNotifications has no messaging runtime configured for this session", isError: true };
    }
    const { notifications, remaining } = readNotifications(runtime, { sessionId: ctx.sessionId });
    return { output: JSON.stringify({ notifications, remaining }) };
  },
};

replaceExecutor(READ_NOTIFICATIONS_TOOL_NAME, readNotificationsExecutor);
