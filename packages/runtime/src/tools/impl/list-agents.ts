// Task 7 (Lane D, WS-10 §10.2): the ListAgents executor. `channel`/`q` are reserved and unavailable
// in the pinned build (WS-10 §10.2: "the ordinary call is effectively `{}`") -- accepted without
// validation since they have no effect either way; over-validating an inert field would only reject
// otherwise-harmless calls for no behavioral reason. Output is exactly `{listing: string}`
// (WS-10 §10.2 pinned) -- the structured `ListedRuntimeObject[]` rows router.ts's own listAgents
// also returns are product/UI data, never part of the model-visible result here.
import "../descriptors/list-agents.ts";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { getMessagingRuntime, listAgents } from "../../messaging/router.ts";

export const LIST_AGENTS_TOOL_NAME = "ListAgents";

export const listAgentsExecutor: ToolExecutor = {
  async execute(_input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    const runtime = getMessagingRuntime();
    if (runtime === undefined) {
      return { output: "Error: ListAgents has no messaging runtime configured for this session", isError: true };
    }
    const { listing } = await listAgents(runtime, { sessionId: ctx.sessionId }, {});
    return { output: JSON.stringify({ listing }) };
  },
};

replaceExecutor(LIST_AGENTS_TOOL_NAME, listAgentsExecutor);
