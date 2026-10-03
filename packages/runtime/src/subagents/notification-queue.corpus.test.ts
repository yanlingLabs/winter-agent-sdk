// A recorded input -> output corpus for the `<task-notification>` renderers: 1800 generated inputs
// spread over the generic document and the five per-kind documents (agent, shell, monitor event,
// TaskStop, workflow) -- XML-special characters, already-escaped entities, newlines, unicode, empty and
// absent fields, every status and actor, fractional/negative/huge numbers -- with the exact text each
// renderer produced when the corpus was recorded. `fn` names the renderer.
import { expect, test } from "bun:test";
import {
  renderAgentNotification,
  renderMonitorEventNotification,
  renderShellNotification,
  renderTaskNotification,
  renderTaskStopNotification,
  renderWorkflowNotification,
} from "./notification-queue.ts";
import corpus from "./__corpus__/task-notification.json";

const RENDERERS: Record<string, (input: never) => string> = {
  task: renderTaskNotification,
  agent: renderAgentNotification,
  shell: renderShellNotification,
  monitor: renderMonitorEventNotification,
  stop: renderTaskStopNotification,
  workflow: renderWorkflowNotification,
};

test("the recorded corpus renders exactly as recorded", () => {
  const rows = corpus as Array<{ fn: string; input: unknown; expected: string }>;
  expect(rows.length).toBe(1800);
  const mismatches = rows.filter((row) => RENDERERS[row.fn]!(row.input as never) !== row.expected);
  expect(mismatches).toEqual([]);
});
