// Task 7 (Lane D, WS-10 §10.2): the ListAgents executor — since R-8-1, a thin binding of the SDK's
// own handler (see impl/send-message.ts's header for the full reasoning behind the move).
//
// Output stays exactly `{listing: string}` (WS-10 §10.2 pinned) — the structured `ListedRuntimeObject[]`
// rows the router also returns are product/UI data, never part of the model-visible result here — and
// the listing is now rendered by the SHARED formatter, so the two branches produce the same lines
// rather than two implementations of the same line format.
//
// ONE MODEL-VISIBLE CHANGE (ruling P-4): `channel`/`q` are still reserved and inert, but an argument
// that is NEITHER of them is now refused instead of silently ignored. The old posture — "an inert
// extra is not a reason to fail an otherwise-harmless call" — is right about harm and wrong about
// schemas: a model that got away with `{limit: 5}` had been told, by the runtime's own silence, that
// a `limit` exists.
import "../descriptors/list-agents.ts";
import "../descriptors/winter-list-agents.ts"; // rider 15: the canonical alias-target descriptor this file also installs an executor for.
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";
import { acceptNativeListAgentsArgs, createMessagingToolHandlers, LIST_AGENTS_DEFINITION, messagingToolPortFromRuntimeDeps } from "@yanlinglabs/winter-agent-sdk/tools";
import { getMessagingRuntime } from "../../messaging/router.ts";
// Side-effect-free (types only): importing THIS executor must not also register SendMessage and
// its canonical twin, which is what importing it from `./send-message.ts` did (SB review r1).
import { callerContextFrom } from "./_caller.ts";

/** Read off the one definition, so the registered name and the descriptor's can never disagree. */
export const LIST_AGENTS_TOOL_NAME = LIST_AGENTS_DEFINITION.builtinName ?? LIST_AGENTS_DEFINITION.toolName;

export const listAgentsExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    // Schema first, infrastructure second -- see impl/send-message.ts's own note.
    const accepted = acceptNativeListAgentsArgs(input);
    if (!accepted.ok) return { output: accepted.reason, isError: true };

    const runtime = getMessagingRuntime();
    if (runtime === undefined) {
      return { output: "Error: ListAgents has no messaging runtime configured for this session", isError: true };
    }
    const handlers = createMessagingToolHandlers(messagingToolPortFromRuntimeDeps(runtime), callerContextFrom(ctx));
    const { text, isError } = await handlers.listAgents(input);
    return { output: text, ...(isError === true ? { isError: true } : {}) };
  },
};

replaceExecutor(LIST_AGENTS_TOOL_NAME, listAgentsExecutor);

// Phase 4 Task 8 (rider 15): the canonical standing-Winter-server name, over the SAME executor
// object -- see send-message.ts's own identical block for the full rationale.
export const WINTER_CANONICAL_LIST_AGENTS_TOOL_NAME = mcpToolName(WINTER_BRAND, LIST_AGENTS_DEFINITION.toolName);
replaceExecutor(WINTER_CANONICAL_LIST_AGENTS_TOOL_NAME, listAgentsExecutor);
