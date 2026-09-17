// Spawn-surface parity (research §A6, ruling scope item 10): the two claude-pinned tool pools every
// subagent's own tool set is built from -- a "removed from every subagent" exclusion set, and a
// STRICTER allowlist that further narrows a BACKGROUNDED subagent. Both are DATA ONLY (plain string
// arrays of Winter's own canonical tool names): the actual application -- intersecting these against
// `ChildInheritance.tools`, depth-gating `Agent` itself, keeping `ExitPlanMode` alive in plan mode --
// is `child-engine.ts`'s own job (lane L2b; this lane's hard file boundary excludes that file).
//
// WHY CANONICAL-NAME LITERALS AND NOT DESCRIPTOR IMPORTS. Every `tools/descriptors/*.ts` file is a
// `stub(...)` REGISTRATION with a side effect on import (registry.ts's own header); importing one
// here just to read a string would run that registration as a side effect of loading this data-only
// module. The four Winter-OWN default tools (`SendMessage`/`ListAgents`/`ReadNotifications`/
// `advisor`) are the one case with a real risk of drift, so those four are read from
// `@yanlinglabs/winter-agent-sdk/tools`'s own plain-data `WinterToolDefinition` constants (no `stub`
// call lives there) via the SAME `builtinNameOf` helper every descriptor uses -- everything else is a
// canonical tool name this codebase spells as a bare literal in a dozen descriptor files already
// (`"Read"`, `"Grep"`, ...), so a literal here carries no more drift risk than those do.
import { SEND_MESSAGE_DEFINITION, READ_NOTIFICATIONS_DEFINITION } from "@yanlinglabs/winter-agent-sdk/tools";
import { AGENT_TOOL_CANONICAL_NAME } from "../provider/slots.ts";

function builtinNameOf(def: { builtinName?: string; toolName: string }): string {
  return def.builtinName ?? def.toolName;
}

/**
 * Research §A6, "Removed from EVERY subagent": TaskOutput, ExitPlanMode (kept in plan mode --
 * CALLER's job: this set is applied UNLESS the child's own permission mode is `plan`, exactly as
 * claude's own parenthetical says), EnterPlanMode, memory_list/read/write, AskUserQuestion, Poll,
 * ConnectGitHub, WaitForMcpServers, RefreshMcpTools, Workflow (non-internal), ScheduleWakeup,
 * ReadNotifications, ProposeGoal, EndConversation.
 *
 * THREE OF THE FOURTEEN HAVE NO WINTER EQUIVALENT AND ARE OMITTED, DISCLOSED (not silently dropped):
 *   - `memory_list`/`memory_read`/`memory_write` -- Winter's memory is FILE-BASED (CLAUDE.md's own
 *     "a MEMDIR of markdown written with ordinary write/edit -- no dedicated memory tools"). There is
 *     nothing named `memory_*` to exclude; a subagent's memory access is already governed by whether
 *     it holds `Read`/`Write`/`Edit` at all, which this pool does not touch.
 *   - `Poll` -- no Winter tool of this name or shape exists.
 *   - `ConnectGitHub` -- no Winter tool of this name or shape exists.
 * Every other claude name below has a Winter tool of the identical shape and an unchanged name
 * (`Agent`/`Artifact`/`ExitPlanMode`/`Edit`/`Write`/`NotebookEdit`/`AskUserQuestion`/
 * `WaitForMcpServers`/`RefreshMcpTools`/`Workflow`/`ScheduleWakeup`/`ProposeGoal`/`EndConversation`/
 * `TaskOutput` all register under their own bare names -- see `tools/descriptors/*.ts`), so no
 * rename table is needed for those.
 */
export const SUBAGENT_EXCLUDED_TOOLS: readonly string[] = [
  "TaskOutput",
  "ExitPlanMode",
  "EnterPlanMode",
  "AskUserQuestion",
  "WaitForMcpServers",
  "RefreshMcpTools",
  "Workflow",
  "ScheduleWakeup",
  builtinNameOf(READ_NOTIFICATIONS_DEFINITION),
  "ProposeGoal",
  "EndConversation",
];

/**
 * Research §A6: a BACKGROUNDED subagent's tool pool is further limited to this allowlist (on top of
 * whatever `SUBAGENT_EXCLUDED_TOOLS` above already removed) -- "`Agent` (depth-gated) and MCP tools
 * pass regardless", which is why neither rides in this literal list: the depth gate and the MCP
 * passthrough are structural exceptions the CALLER applies alongside this allowlist, not members of
 * it (mirroring claude's own "pass regardless" wording exactly).
 *
 * ONE CLAUDE ENTRY HAS NO WINTER EQUIVALENT, DISCLOSED: "Search/List Plugins/Skills" -- Winter has no
 * tool that enumerates installed plugins or searches the skill catalog (its `Skill` tool INVOKES a
 * named skill, already listed below; there is no separate discovery tool to allow through).
 *
 * `GetTask` (claude's name) is Winter's `TaskGet`.
 */
export const BACKGROUND_AGENT_TOOL_ALLOWLIST: readonly string[] = [
  "Read",
  "WebSearch",
  "TodoWrite",
  "Grep",
  "WebFetch",
  "Glob",
  "Bash",
  "PowerShell",
  "Edit",
  "Write",
  "NotebookEdit",
  "Skill",
  "StructuredOutput",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
  "REPL",
  "Monitor",
  "TaskStop",
  "TaskGet",
  builtinNameOf(SEND_MESSAGE_DEFINITION),
  "Artifact",
];

/**
 * Tools that pass a background subagent's allowlist REGARDLESS of the literal list above -- claude's
 * own "Agent (depth-gated) and MCP tools pass regardless." `Agent` itself is named so the CALLER can
 * union it in only when the depth gate (research §A6's own nesting-limit check, `subagents/limits.ts`)
 * still permits a further spawn; MCP tools are recognised by their `mcp__` prefix, not by name, so
 * there is nothing to list for them here.
 */
export const BACKGROUND_AGENT_ALWAYS_ALLOWED_TOOL: string = AGENT_TOOL_CANONICAL_NAME;
