// Edge cases of the `<task-notification>` renderers: which values are escaped where, which fields are
// omitted, and the fallback wordings. Every expectation here is the current output, recorded.
import { describe, expect, test } from "bun:test";
import {
  renderAgentNotification,
  renderMonitorEventNotification,
  renderShellNotification,
  renderTaskNotification,
  renderTaskStopNotification,
  renderWorkflowNotification,
  xmlEscape,
} from "./notification-queue.ts";

const NOTE =
  "<note>This notification fires each time the agent stops with no background work of its own still running, so the same task-id can notify more than once. Send it another message with SendMessage to resume it.</note>";

describe("xmlEscape", () => {
  test("escapes & first, then < and >; quotes and apostrophes pass through", () => {
    expect(xmlEscape(`&lt; & <a> 'q' "d"`)).toBe(`&amp;lt; &amp; &lt;a&gt; 'q' "d"`);
  });
});

describe("renderTaskNotification", () => {
  test("no fields at all: just the root tag pair on two lines", () => {
    expect(renderTaskNotification({})).toBe("<task-notification>\n</task-notification>");
    expect(renderTaskNotification({ taskId: "", body: "", trailing: "" })).toBe("<task-notification>\n</task-notification>");
  });

  test("values are inserted as given -- the generic document escapes nothing itself", () => {
    expect(renderTaskNotification({ summary: "<b>&", taskId: "t" })).toBe("<task-notification>\n<task-id>t</task-id>\n<summary><b>&</summary>\n</task-notification>");
  });
});

describe("renderAgentNotification", () => {
  test("ids are escaped; the whole summary (description and error included) is escaped once; an empty output file is omitted", () => {
    expect(renderAgentNotification({ taskId: "t<1>", toolUseId: "tu&", description: 'a<b>"c"&', status: "failed", error: "x<y>", outputFile: "" })).toBe(
      `<task-notification>\n<task-id>t&lt;1&gt;</task-id>\n<tool-use-id>tu&amp;</tool-use-id>\n<status>failed</status>\n<summary>Agent "a&lt;b&gt;"c"&amp;" failed: x&lt;y&gt;</summary>\n${NOTE}\n</task-notification>`,
    );
  });

  test("a turn limit of 0 still uses the turn-limit wording; on a failure the limit is ignored and an empty error reads Unknown error", () => {
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "completed", maxTurnsReached: 0 })).toContain(
      '<summary>Agent "d" stopped at its 0-turn limit (partial result; SendMessage to task-id to continue)</summary>',
    );
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "failed", maxTurnsReached: 3, error: "" })).toContain('<summary>Agent "d" failed: Unknown error</summary>');
  });

  test("stoppedBy is ignored unless stopped; an empty final message adds no <result>; zero usage still renders", () => {
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "completed", stoppedBy: "user", finalMessage: "", usage: { totalTokens: 0, toolUses: 0, durationMs: 0 } })).toBe(
      `<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n<summary>Agent "d" finished</summary>\n${NOTE}\n<usage><subagent_tokens>0</subagent_tokens><tool_uses>0</tool_uses><duration_ms>0</duration_ms></usage>\n</task-notification>`,
    );
  });

  test("worktree block: path always, branch only when given, both escaped; it follows result and usage", () => {
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "completed", finalMessage: "r<", worktree: { path: "/w<t>" } })).toBe(
      `<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n<summary>Agent "d" finished</summary>\n${NOTE}\n<result>r&lt;</result>\n<worktree><worktreePath>/w&lt;t&gt;</worktreePath></worktree>\n</task-notification>`,
    );
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "completed", worktree: { path: "/w", branch: "b&r" }, usage: { totalTokens: 1.5, toolUses: -1, durationMs: 2 } })).toBe(
      `<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n<summary>Agent "d" finished</summary>\n${NOTE}\n<usage><subagent_tokens>1.5</subagent_tokens><tool_uses>-1</tool_uses><duration_ms>2</duration_ms></usage>\n<worktree><worktreePath>/w</worktreePath><worktreeBranch>b&amp;r</worktreeBranch></worktree>\n</task-notification>`,
    );
  });
});

describe("the other kinds", () => {
  test("shell: the summary is escaped; an empty output file is omitted", () => {
    expect(renderShellNotification({ taskId: "t", status: "failed", summary: "a<b>", outputFile: "" })).toBe("<task-notification>\n<task-id>t</task-id>\n<status>failed</status>\n<summary>a&lt;b&gt;</summary>\n</task-notification>");
  });

  test("monitor event with no task id: no task-id tag; description and event escaped", () => {
    expect(renderMonitorEventNotification({ description: 'd"<x>', event: "e&" })).toBe('<task-notification>\n<summary>Monitor event: "d"&lt;x&gt;"</summary>\n<event>e&amp;</event>\n</task-notification>');
  });

  test("TaskStop with no actor reads 'by user'", () => {
    expect(renderTaskStopNotification({ taskId: "t", description: "d<" })).toBe('<task-notification>\n<task-id>t</task-id>\n<status>stopped</status>\n<summary>Task "d&lt;" was stopped by user</summary>\n</task-notification>');
  });

  test("workflow: an empty name reads 'Dynamic workflow'; the error is escaped; the summary is not escaped a second time", () => {
    expect(renderWorkflowNotification({ taskId: "t", status: "failed", name: "", error: "<e>" })).toBe(
      '<task-notification>\n<task-id>t</task-id>\n<status>failed</status>\n<summary>Dynamic workflow "Dynamic workflow" failed: &lt;e&gt;</summary>\n</task-notification>',
    );
    expect(renderWorkflowNotification({ taskId: "t", status: "completed", name: 'a&"b"', result: "", failures: [], agentCount: 2 })).toBe(
      '<task-notification>\n<task-id>t</task-id>\n<status>completed</status>\n<summary>Dynamic workflow "a&amp;"b"" completed</summary>\n<usage><agent_count>2</agent_count><subagent_tokens>0</subagent_tokens><tool_uses>0</tool_uses><duration_ms>0</duration_ms></usage>\n</task-notification>',
    );
  });

  test("workflow: usage alone still renders agent_count 0; failures are joined by newlines and escaped", () => {
    expect(renderWorkflowNotification({ taskId: "t", status: "stopped", usage: { totalTokens: 5, toolUses: 1, durationMs: 9 }, failures: ["<a>", "b"] })).toBe(
      '<task-notification>\n<task-id>t</task-id>\n<status>killed</status>\n<summary>Dynamic workflow "Dynamic workflow" was stopped</summary>\n<failures>&lt;a&gt;\nb</failures>\n<usage><agent_count>0</agent_count><subagent_tokens>5</subagent_tokens><tool_uses>1</tool_uses><duration_ms>9</duration_ms></usage>\n</task-notification>',
    );
  });
});
