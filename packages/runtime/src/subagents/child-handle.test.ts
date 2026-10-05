// Phase 4 Task 3 (MUST 5, WS-10 §4): transformChildFrame -- the pure host-stream correlation
// transform. registerChildEngineFactory's own registration mechanics are covered too; ChildHandle
// semantics against a fake, and the full adapter/router seam, are the seam-contracts-p4.test.ts
// file's own job (this file covers the parts genuinely local to child-handle.ts itself).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import {
  transformChildFrame,
  registerChildEngineFactory,
  getChildEngineFactory,
  resetChildEngineFactoryForTest,
  type ChildEngineDeps,
} from "./child-handle.ts";

const CORR = { parentToolUseId: "tooluse-1", agentId: "agent-1" };

describe("transformChildFrame (WS-10 §4)", () => {
  test("a child's own init handshake is swallowed", () => {
    expect(transformChildFrame({ type: "init", protocolVersion: "1.0", sessionId: "c1", cwd: "/x", model: "sonnet", permissionMode: "default", tools: [] }, CORR, false)).toBeNull();
  });

  test("control_request/control_response pass through completely unmodified, regardless of forwardSubagentText", () => {
    const req: WinterFrame = { type: "control_request", requestId: "r1", subtype: "permission", payload: { x: 1 } };
    expect(transformChildFrame(req, CORR, false)).toEqual(req);
    const res: WinterFrame = { type: "control_response", requestId: "r1", ok: true, payload: { y: 2 } };
    expect(transformChildFrame(res, CORR, true)).toEqual(res);
  });

  test("an unknown top-level frame kind passes through unchanged", () => {
    const unknown: WinterFrame = { type: "something_future", weird: true };
    expect(transformChildFrame(unknown, CORR, false)).toEqual(unknown);
  });

  test("a child's own terminal result is swallowed -- never a second top-level result on the parent stream", () => {
    const frame: WinterFrame = { type: "data", message: { type: "result", subtype: "success", is_error: false, result: "child done", permission_denials: [] } };
    expect(transformChildFrame(frame, CORR, true)).toBeNull();
  });

  test("assistant tool_use is ALWAYS forwarded, stamped with parent_tool_use_id, even with forwardSubagentText off", () => {
    const frame: WinterFrame = { type: "data", message: { type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }] } } };
    const result = transformChildFrame(frame, CORR, false) as { message: { message: { content: unknown[] }; parent_tool_use_id: string } };
    expect(result.message.message.content).toEqual([{ type: "tool_use", id: "c1", name: "Read", input: {} }]);
    expect(result.message.parent_tool_use_id).toBe("tooluse-1");
  });

  test("assistant text is SUPPRESSED when forwardSubagentText is off -- the whole frame is swallowed if nothing else survives", () => {
    const frame: WinterFrame = { type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } } };
    expect(transformChildFrame(frame, CORR, false)).toBeNull();
  });

  test("assistant text IS forwarded when forwardSubagentText is on, stamped with parent_tool_use_id", () => {
    const frame: WinterFrame = { type: "data", message: { type: "assistant", message: { content: [{ type: "text", text: "thinking out loud" }] } } };
    const result = transformChildFrame(frame, CORR, true) as { message: { message: { content: unknown[] }; parent_tool_use_id: string } };
    expect(result.message.message.content).toEqual([{ type: "text", text: "thinking out loud" }]);
    expect(result.message.parent_tool_use_id).toBe("tooluse-1");
  });

  test("a mixed assistant message (text + tool_use) with forwardSubagentText off keeps ONLY the tool_use block", () => {
    const frame: WinterFrame = {
      type: "data",
      message: { type: "assistant", message: { content: [{ type: "text", text: "narrating" }, { type: "tool_use", id: "c1", name: "Read", input: {} }] } },
    };
    const result = transformChildFrame(frame, CORR, false) as { message: { message: { content: unknown[] } } };
    expect(result.message.message.content).toEqual([{ type: "tool_use", id: "c1", name: "Read", input: {} }]);
  });

  test("a 'user' (tool_result carrier) data frame is ALWAYS forwarded, stamped with parent_tool_use_id, regardless of forwardSubagentText", () => {
    const frame: WinterFrame = { type: "data", message: { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } } };
    for (const flag of [false, true]) {
      const result = transformChildFrame(frame, CORR, flag) as { message: { parent_tool_use_id: string } };
      expect(result.message.parent_tool_use_id).toBe("tooluse-1");
    }
  });

  // WS-24 (cross-lane, the phone review): a child's own system frames carry its parent_tool_use_id, so a
  // host that threads by it files them on the child's thread, never the main one.
  test("a child's own system frames (hook lifecycle, informational, continuity_warning, model_switch, ...) carry its parent_tool_use_id, never merged into a parent message", () => {
    for (const message of [
      { type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "x", hook_event: "PreToolUse", session_id: "c1", uuid: "u1" },
      { type: "system", subtype: "informational", content: "SubagentStop blocked", level: "warning", prevent_continuation: true, session_id: "c1", uuid: "u2" },
      { type: "system", subtype: "continuity_warning", warning: "reasoning_state_unsaved", detail: "x", session_id: "c1", uuid: "u3" },
      { type: "system", subtype: "model_switch", reason: "fallback", from_model: "a", to_model: "b", provider: "p", session_id: "c1", uuid: "u4" },
    ]) {
      const frame: WinterFrame = { type: "data", message } as WinterFrame;
      expect(transformChildFrame(frame, CORR, false)).toEqual({ type: "data", message: { ...message, parent_tool_use_id: CORR.parentToolUseId } } as WinterFrame);
    }
  });

  // 0.0.47: the child's live reasoning. Its block always crosses, correlated (its own `null` overwritten,
  // like a grandchild's id); its TEXT crosses only under forwardSubagentText, the gate WS-10 §4 puts on a
  // child's thinking.
  test("a child's `reasoning_progress` crosses correlated; its `text` only when forwardSubagentText is on", () => {
    const steps = [
      { type: "system", subtype: "reasoning_progress", block_id: "b1", phase: "start", kind: "hidden", provider: "p", model: "m", parent_tool_use_id: null, session_id: "c1", uuid: "u1" },
      { type: "system", subtype: "reasoning_progress", block_id: "b1", phase: "delta", kind: "update", text: "**Looking**", part: 0, provider: "p", model: "m", parent_tool_use_id: null, session_id: "c1", uuid: "u2" },
      { type: "system", subtype: "reasoning_progress", block_id: "b1", phase: "end", kind: "update", provider: "p", model: "m", parent_tool_use_id: null, session_id: "c1", uuid: "u3" },
    ];
    for (const message of steps) {
      const frame: WinterFrame = { type: "data", message } as WinterFrame;
      // ON: verbatim, correlated.
      expect(transformChildFrame(frame, CORR, true)).toEqual({ type: "data", message: { ...message, parent_tool_use_id: CORR.parentToolUseId } } as WinterFrame);
      // OFF: the same frame minus its text -- the block still opens, changes kind and closes.
      const { text: _text, ...withoutText } = message as { text?: string };
      expect(transformChildFrame(frame, CORR, false)).toEqual({ type: "data", message: { ...withoutText, parent_tool_use_id: CORR.parentToolUseId } } as WinterFrame);
    }
    const off = steps.map((message) => (transformChildFrame({ type: "data", message } as WinterFrame, CORR, false) as { message: Record<string, unknown> }).message);
    expect(off.map((m) => [m["phase"], m["kind"], "text" in m])).toEqual([
      ["start", "hidden", false],
      ["delta", "update", false],
      ["end", "update", false],
    ]);
  });

  test("the session-level task-registry frames pass through unchanged: they are folded by their own task id", () => {
    for (const subtype of ["task_started", "task_progress", "task_notification", "task_updated", "background_tasks_changed"]) {
      const frame: WinterFrame = { type: "data", message: { type: "system", subtype, task_id: "t1", session_id: "c1", uuid: "u1" } } as WinterFrame;
      expect(transformChildFrame(frame, CORR, false)).toEqual(frame);
    }
  });
});

describe("registerChildEngineFactory / getChildEngineFactory (registration mechanics)", () => {
  // Phase 4 Task 8: `beforeEach` joins the pre-existing `afterEach`. The registry is a process-wide
  // module singleton and bun shares one process across every test FILE, so "absent by default" is a
  // claim about THIS describe's own starting state, not about the process's -- and as of rider 18 a
  // real production registration happens inside `inMemoryProcess` (testing.ts), which many other
  // files exercise. Without the reset this test passed only when it happened to run before any of
  // them: green in `bun test packages/runtime`, red in a whole-repo run. Resetting on BOTH sides is
  // exactly what `resetChildEngineFactoryForTest`'s own doc comment exists for ("so one test file's
  // registration never leaks into another's assertions").
  beforeEach(() => {
    resetChildEngineFactoryForTest();
  });
  afterEach(() => {
    resetChildEngineFactoryForTest();
  });

  test("absent by default", () => {
    expect(getChildEngineFactory()).toBeUndefined();
  });

  test("registers and is retrievable", () => {
    const deps: ChildEngineDeps = { spawn: async () => { throw new Error("not implemented in this fixture"); } };
    registerChildEngineFactory(() => deps);
    expect(getChildEngineFactory()?.({ parentSessionId: "p1", forwardChildFrame: () => {} })).toBe(deps);
  });

  test("resetChildEngineFactoryForTest clears a prior registration -- no leakage across test files", () => {
    registerChildEngineFactory(() => ({ spawn: async () => { throw new Error("x"); } }));
    resetChildEngineFactoryForTest();
    expect(getChildEngineFactory()).toBeUndefined();
  });
});
