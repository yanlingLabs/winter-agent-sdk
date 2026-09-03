// Side-effect-only barrel: importing this module registers every WS-06 §2 tool name's stub
// descriptor. Deliberately the ONE place that imports both registry.ts (transitively, through each
// descriptor file) and every descriptor file itself -- registry.ts never imports this file (or any
// descriptor file), which is what keeps this a one-directional fan-in rather than a cycle: each
// descriptor file's own `import { stub } from "./_shared.ts"` (which itself imports
// `registerTool`/`ToolDescriptor` from "../registry.ts") runs registry.ts's module body to
// completion (the Map is constructed) BEFORE any descriptor file's own top-level `stub({...})` call
// executes, because ES module evaluation order guarantees a module's imports finish evaluating
// before its own body runs.
//
// engine.ts imports this module purely for its side effects (`import "./tools/descriptors/index.ts"`)
// so the registry is guaranteed populated before the first tool_use dispatch of any run; nothing
// here is meant to be imported by name.
import "./agent.ts";
import "./artifact.ts";
import "./ask-user-question.ts";
import "./advisor.ts";
import "./bash.ts";
import "./claude-design.ts";
import "./cron-create.ts";
import "./cron-delete.ts";
import "./cron-list.ts";
import "./edit.ts";
import "./end-conversation.ts";
import "./enter-plan-mode.ts";
import "./enter-worktree.ts";
import "./exit-plan-mode.ts";
import "./exit-worktree.ts";
import "./glob.ts";
import "./grep.ts";
import "./list-agents.ts";
import "./list-mcp-resources-tool.ts";
import "./lsp.ts";
import "./monitor.ts";
import "./notebook-edit.ts";
import "./powershell.ts";
import "./projects.ts";
import "./propose-goal.ts";
import "./propose-skills.ts";
import "./push-notification.ts";
import "./read.ts";
import "./read-mcp-resource-dir-tool.ts";
import "./read-mcp-resource-tool.ts";
import "./read-notifications.ts";
import "./refresh-mcp-tools.ts";
import "./remote-trigger.ts";
import "./repl.ts";
import "./report-findings.ts";
import "./schedule-wakeup.ts";
import "./send-feedback.ts";
import "./send-message.ts";
import "./send-user-file.ts";
import "./share-onboarding-guide.ts";
import "./show-onboarding-role-picker.ts";
import "./skill.ts";
import "./structured-output.ts";
import "./task-create.ts";
import "./task-get.ts";
import "./task-list.ts";
import "./task-output.ts";
import "./task-stop.ts";
import "./task-update.ts";
import "./todo-write.ts";
import "./tool-search.ts";
import "./wait-for-mcp-servers.ts";
import "./web-fetch.ts";
import "./web-search.ts";
import "./workflow.ts";
import "./write.ts";

// A named export so a consumer can force this module to evaluate at an explicit point (rather than
// relying on a bare side-effect import surviving a bundler/tree-shaker) and so registry.test.ts can
// assert "the descriptor barrel imported without throwing" as a real value, not just an import
// statement with nothing to assert against.
export const DESCRIPTORS_REGISTERED = true;
