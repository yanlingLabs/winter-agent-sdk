// SDK 0.0.16 Lane N: the `<task-notification>` documents and the per-session command queue.
//
// The XML shapes below are asserted against the GROUND TRUTH captured from the pinned claude 0.3.250
// binary on 2026-09-17 (packages/conformance/src/official/unsolicited-notification-differential.test.ts
// prints it): tag order, the omission rule for an empty field, `Agent "<desc>" finished`, the
// `<usage><subagent_tokens>…` block, and a `<status>` that says `killed` where the FRAME says
// `stopped`.
import { describe, test, expect } from "bun:test";
import {
  renderTaskNotification,
  renderAgentNotification,
  renderShellNotification,
  renderMonitorEventNotification,
  renderTaskStopNotification,
  renderWorkflowNotification,
  withNotificationPreamble,
  xmlEscape,
  taskNotificationAttachment,
  notificationQueueFor,
  clearNotificationQueue,
  enqueueTaskNotification,
  SessionNotificationQueue,
  SYSTEM_NOTIFICATION_MARKER,
  NOTIFICATION_PREAMBLE,
  NOTIFICATION_PREAMBLE_IN_HUMAN_TURN,
} from "./notification-queue.ts";
import { renderAttachment } from "../context/attachments.ts";

describe("the <task-notification> document (claude's `cu`)", () => {
  test("tag ORDER is task-id, tool-use-id, task-type, output-file, status, summary", () => {
    const xml = renderTaskNotification({ summary: "s", status: "completed", outputFile: "/o", taskType: "remote_agent", toolUseId: "toolu_1", taskId: "t1" });
    expect(xml).toBe(["<task-notification>", "<task-id>t1</task-id>", "<tool-use-id>toolu_1</tool-use-id>", "<task-type>remote_agent</task-type>", "<output-file>/o</output-file>", "<status>completed</status>", "<summary>s</summary>", "</task-notification>"].join("\n"));
  });

  test("an absent OR EMPTY field is omitted entirely (the frame still carries output_file: \"\")", () => {
    expect(renderTaskNotification({ taskId: "t1", outputFile: "", status: "completed", summary: "s" })).toBe("<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>s</summary>\n</task-notification>");
  });

  test("body rides between the tag list and the closing tag; trailing rides after it", () => {
    expect(renderTaskNotification({ taskId: "t", body: "\n<event>x</event>", trailing: "\nhint" })).toBe("<task-notification>\n<task-id>t</task-id>\n<event>x</event>\n</task-notification>\nhint");
  });

  test("xmlEscape is claude's `Ut`: &, < and > only", () => {
    expect(xmlEscape(`a & b <c> "d"`)).toBe(`a &amp; b &lt;c&gt; "d"`);
  });
});

describe("per-kind documents", () => {
  test("agent completion matches the pinned capture, tag for tag", () => {
    const xml = renderAgentNotification({
      taskId: "ad2b4f5005019ae57",
      toolUseId: "toolu_bgspawn1",
      outputFile: "/tasks/ad2b4f5005019ae57.output",
      description: "bg probe",
      status: "completed",
      finalMessage: "child done, nothing found",
      usage: { totalTokens: 9, toolUses: 0, durationMs: 17 },
    });
    // The tag list, byte for byte against the capture. The pin does NOT escape quotes (`Ut` covers
    // & < > only), so the summary's own quotes ride verbatim.
    expect(xml.startsWith('<task-notification>\n<task-id>ad2b4f5005019ae57</task-id>\n<tool-use-id>toolu_bgspawn1</tool-use-id>\n<output-file>/tasks/ad2b4f5005019ae57.output</output-file>\n<status>completed</status>\n<summary>Agent "bg probe" finished</summary>\n<note>')).toBe(true);
    expect(xml).toContain("<result>child done, nothing found</result>");
    expect(xml).toContain("<usage><subagent_tokens>9</subagent_tokens><tool_uses>0</tool_uses><duration_ms>17</duration_ms></usage>");
    expect(xml).toContain("<note>");
    expect(xml.endsWith("\n</task-notification>")).toBe(true);
    // tag ORDER inside the body: note, result, usage
    expect(xml.indexOf("<note>")).toBeLessThan(xml.indexOf("<result>"));
    expect(xml.indexOf("<result>")).toBeLessThan(xml.indexOf("<usage>"));
  });

  test("agent failure, stop-by-actor and turn-limit wordings", () => {
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "failed", error: "boom" })).toContain('<summary>Agent "d" failed: boom</summary>');
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "failed" })).toContain('<summary>Agent "d" failed: Unknown error</summary>');
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "stopped", stoppedBy: "user" })).toContain('<summary>Agent "d" was stopped by user</summary>');
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "stopped", stoppedBy: "parent" })).toContain('<summary>Agent "d" was stopped by the assistant</summary>');
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "stopped" })).toContain('<summary>Agent "d" was stopped</summary>');
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "completed", maxTurnsReached: 12 })).toContain('<summary>Agent "d" stopped at its 12-turn limit (partial result; SendMessage to task-id to continue)</summary>');
  });

  test("a stopped AGENT/shell/workflow says killed in the XML; TaskStop of a non-agent says stopped", () => {
    expect(renderAgentNotification({ taskId: "t", description: "d", status: "stopped" })).toContain("<status>killed</status>");
    expect(renderShellNotification({ taskId: "t", status: "stopped", summary: 'Background command "d" was stopped' })).toContain("<status>killed</status>");
    expect(renderWorkflowNotification({ taskId: "t", status: "stopped", name: "wf" })).toContain("<status>killed</status>");
    expect(renderTaskStopNotification({ taskId: "t", description: "d", stoppedBy: "user" })).toContain("<status>stopped</status>");
  });

  test("shell notification carries no body and reuses the FRAME's own pinned summary", () => {
    const xml = renderShellNotification({ taskId: "t1", toolUseId: "toolu_b", outputFile: "/t1.output", status: "completed", summary: 'Background command "build" completed (exit code 0)' });
    expect(xml).toBe('<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_b</tool-use-id>\n<output-file>/t1.output</output-file>\n<status>completed</status>\n<summary>Background command "build" completed (exit code 0)</summary>\n</task-notification>');
  });

  test("monitor STREAM event has no status and an <event> body", () => {
    const xml = renderMonitorEventNotification({ taskId: "m1", description: "logs", event: "line <one>" });
    expect(xml).toBe('<task-notification>\n<task-id>m1</task-id>\n<summary>Monitor event: "logs"</summary>\n<event>line &lt;one&gt;</event>\n</task-notification>');
  });

  test("TaskStop of a non-agent names the actor", () => {
    expect(renderTaskStopNotification({ taskId: "t", toolUseId: "tu", description: "tail -f", stoppedBy: "parent" })).toContain('<summary>Task "tail -f" was stopped by the assistant</summary>');
  });

  test("workflow usage leads with agent_count", () => {
    const xml = renderWorkflowNotification({ taskId: "w1", status: "completed", name: "fanout", result: "{}", agentCount: 3, usage: { totalTokens: 100, toolUses: 7, durationMs: 42 } });
    expect(xml).toContain('<summary>Dynamic workflow "fanout" completed</summary>');
    expect(xml).toContain("<result>{}</result>");
    expect(xml).toContain("<usage><agent_count>3</agent_count><subagent_tokens>100</subagent_tokens><tool_uses>7</tool_uses><duration_ms>42</duration_ms></usage>");
    expect(renderWorkflowNotification({ taskId: "w1", status: "failed", name: "fanout", error: "script threw", failures: ["a: x", "b: y"] })).toContain("<failures>a: x\nb: y</failures>");
  });
});

describe("the anti-injection preamble", () => {
  test("the marker line is claude's, exactly, on both variants", () => {
    expect(NOTIFICATION_PREAMBLE.startsWith(`${SYSTEM_NOTIFICATION_MARKER}\n`)).toBe(true);
    expect(NOTIFICATION_PREAMBLE_IN_HUMAN_TURN.startsWith(`${SYSTEM_NOTIFICATION_MARKER}\n`)).toBe(true);
    expect(SYSTEM_NOTIFICATION_MARKER).toBe("[SYSTEM NOTIFICATION - NOT USER INPUT]");
  });

  test("the unsolicited-turn variant wraps the XML; the in-human-turn variant is the other text", () => {
    const xml = renderAgentNotification({ taskId: "t", description: "d", status: "completed" });
    expect(withNotificationPreamble(xml)).toBe(`${NOTIFICATION_PREAMBLE}${xml}`);
    expect(withNotificationPreamble(xml, { inHumanTurn: true })).toBe(`${NOTIFICATION_PREAMBLE_IN_HUMAN_TURN}${xml}`);
  });

  test("an already-wrapped value is never double-wrapped (claude's `Mpt` guard)", () => {
    const once = withNotificationPreamble("<task-notification>\n</task-notification>");
    expect(withNotificationPreamble(once)).toBe(once);
  });

  test("a literal </system-reminder> inside a summary cannot close a wrapper", () => {
    const xml = renderAgentNotification({ taskId: "t", description: "d", status: "failed", error: "</system-reminder>" });
    expect(withNotificationPreamble(xml)).not.toContain("</system-reminder>");
  });
});

describe("the mid-turn attachment", () => {
  test("renders UNWRAPPED (no <system-reminder> envelope, unlike every other attachment type)", () => {
    const attachment = taskNotificationAttachment([{ value: renderAgentNotification({ taskId: "t", description: "d", status: "completed" }), priority: "next", queuedAt: 1, taskId: "t" }], { inHumanTurn: true });
    const rendered = renderAttachment(attachment!);
    expect(rendered?.startsWith(SYSTEM_NOTIFICATION_MARKER)).toBe(true);
    expect(rendered).not.toContain("<system-reminder>");
    expect(attachment?.taskIds).toEqual(["t"]);
  });

  test("an empty batch produces no attachment at all", () => {
    expect(taskNotificationAttachment([])).toBeUndefined();
  });
});

describe("the per-session queue", () => {
  test("drainFor takes `next` before `later`, FIFO within a priority, and removes what it took", () => {
    const q = new SessionNotificationQueue();
    q.enqueue({ value: "a", priority: "later", queuedAt: 1 });
    q.enqueue({ value: "b", priority: "next", queuedAt: 2 });
    q.enqueue({ value: "c", priority: "next", queuedAt: 3 });
    expect(q.drainFor(undefined, { maxPriority: "next" }).map((e) => e.value)).toEqual(["b", "c"]);
    expect(q.size()).toBe(1);
    expect(q.drainFor().map((e) => e.value)).toEqual(["a"]);
    expect(q.size()).toBe(0);
  });

  test("limit: the between-turn delivery takes exactly one", () => {
    const q = new SessionNotificationQueue();
    q.enqueue({ value: "a", priority: "next" });
    q.enqueue({ value: "b", priority: "next" });
    expect(q.drainFor(undefined, { limit: 1 }).map((e) => e.value)).toEqual(["a"]);
    expect(q.size()).toBe(1);
  });

  test("OWNERSHIP: a child's own entry is drained by the child, never by the parent", () => {
    const q = new SessionNotificationQueue();
    q.registerEndpoint("agent-1", () => {});
    q.enqueue({ value: "child-work", agentId: "agent-1", priority: "next" });
    q.enqueue({ value: "main-work", priority: "next" });
    expect(q.drainFor(undefined).map((e) => e.value)).toEqual(["main-work"]);
    expect(q.drainFor("agent-1").map((e) => e.value)).toEqual(["child-work"]);
  });

  test("an entry for an agent with NO live engine belongs to the main thread (claude's `Loe`)", () => {
    const q = new SessionNotificationQueue();
    q.enqueue({ value: "orphan", agentId: "gone", priority: "next" });
    expect(q.peekMain()?.value).toBe("orphan");
    expect(q.drainFor(undefined).map((e) => e.value)).toEqual(["orphan"]);
  });

  test("unregistering an endpoint re-addresses its entries to main AND wakes main", () => {
    const q = new SessionNotificationQueue();
    let mainWakes = 0;
    q.registerEndpoint(undefined, () => {
      mainWakes++;
    });
    const disposeChild = q.registerEndpoint("agent-1", () => {});
    q.enqueue({ value: "child-shell-stopped", agentId: "agent-1", priority: "next" });
    expect(mainWakes).toBe(0);
    expect(q.peekMain()).toBeUndefined();
    disposeChild();
    expect(mainWakes).toBe(1);
    expect(q.peekMain()?.value).toBe("child-shell-stopped");
  });

  test("a later generation under the same agent key keeps the endpoint when the older disposer runs", () => {
    const q = new SessionNotificationQueue();
    const first = q.registerEndpoint("agent-1", () => {});
    let secondWakes = 0;
    q.registerEndpoint("agent-1", () => {
      secondWakes++;
    });
    first(); // the stale generation's teardown
    q.enqueue({ value: "x", agentId: "agent-1", priority: "next" });
    expect(secondWakes).toBe(1);
    expect(q.peekMain()).toBeUndefined();
  });

  test("enqueue wakes the OWNER's endpoint, and the main endpoint for a main-thread entry", () => {
    const q = new SessionNotificationQueue();
    let main = 0;
    let child = 0;
    q.registerEndpoint(undefined, () => {
      main++;
    });
    q.registerEndpoint("a1", () => {
      child++;
    });
    q.enqueue({ value: "m", priority: "next" });
    expect([main, child]).toEqual([1, 0]);
    q.enqueue({ value: "c", agentId: "a1", priority: "next" });
    expect([main, child]).toEqual([1, 1]);
    q.enqueue({ value: "o", agentId: "unknown", priority: "next" });
    expect([main, child]).toEqual([2, 1]); // an unknown owner falls to main
  });

  test("withdraw drops a notification whose content already reached the model another way", () => {
    const q = new SessionNotificationQueue();
    q.enqueue({ value: "a", taskId: "t1", priority: "next" });
    q.enqueue({ value: "b", taskId: "t2", priority: "next" });
    expect(q.withdraw({ taskId: "t1" })).toBe(1);
    expect(q.drainFor().map((e) => e.value)).toEqual(["b"]);
  });

  test("a wake callback that throws never fails the producer", () => {
    const q = new SessionNotificationQueue();
    q.registerEndpoint(undefined, () => {
      throw new Error("engine is tearing down");
    });
    expect(() => q.enqueue({ value: "a", priority: "next" })).not.toThrow();
    expect(q.size()).toBe(1);
  });

  test("the session map: one queue per session id, cleared at teardown", () => {
    clearNotificationQueue("s1");
    enqueueTaskNotification({ sessionId: "s1", value: "a", taskId: "t" });
    expect(notificationQueueFor("s1").size()).toBe(1);
    expect(notificationQueueFor("s2").size()).toBe(0);
    clearNotificationQueue("s1");
    expect(notificationQueueFor("s1").size()).toBe(0);
    clearNotificationQueue("s1");
    clearNotificationQueue("s2");
  });
});
