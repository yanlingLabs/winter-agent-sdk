// Task 7 (Lane D, WS-10 §10.2): the ListAgents executor. `channel`/`q` are reserved and unavailable
// in the pinned build (WS-10 §10.2: "the ordinary call is effectively `{}`") -- accepted without
// validation since they have no effect either way; over-validating an inert field would only reject
// otherwise-harmless calls for no behavioral reason. Output is exactly `{listing: string}`
// (WS-10 §10.2 pinned) -- the structured `ListedRuntimeObject[]` rows router.ts's own listAgents
// also returns are product/UI data, never part of the model-visible result here.
import "../descriptors/list-agents.ts";
import "../descriptors/winter-list-agents.ts"; // rider 15: the canonical alias-target descriptor this file also installs an executor for.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { getMessagingRuntime, listAgents } from "../../messaging/router.ts";
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";

export const LIST_AGENTS_TOOL_NAME = "ListAgents";

// NEEDS_CONTEXT: see send-message.ts's own identical note -- the same canonical-MCP-alias /
// deferred-at-the-source obligation applies verbatim to this tool's own canonical standing-server
// duplicate (WS-10 §15/WS-14), which likewise has no descriptor anywhere in this repo yet and is
// outside this lane's file permissions to create.

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

// Phase 4 Task 8 (rider 15): the canonical standing-Winter-server name, over the SAME executor
// object -- see send-message.ts's own identical block for the full rationale.
export const WINTER_CANONICAL_LIST_AGENTS_TOOL_NAME = mcpToolName(WINTER_BRAND, "list_agents");
replaceExecutor(WINTER_CANONICAL_LIST_AGENTS_TOOL_NAME, listAgentsExecutor);
