import { expect, test } from "bun:test";
import { parseRuntimeContextConfig, parseRuntimeContextRequest, parseRuntimeContextSnapshot, RUNTIME_CONTEXT_MAX_BYTES } from "./runtime-context.ts";
const request = { bindingId: "binding", sessionId: "session", cwd: "/fixture", purpose: "generation", attempt: 1 };
const snapshot = { revision: "revision:1", facts: "facts", instructions: "guidance" };
test("closed context request and snapshot accept only bounded inert data", () => {
  expect(parseRuntimeContextConfig({ version: 1, bindingId: "binding" })).toEqual({ version: 1, bindingId: "binding" });
  expect(Object.isFrozen(parseRuntimeContextRequest(request))).toBe(true);
  expect(Object.isFrozen(parseRuntimeContextSnapshot(snapshot))).toBe(true);
  for (const value of [null, [], { ...request, grants: [] }, { ...request, project: "project" }, { ...request, agentId: undefined },
    { ...request, cwd: "a".repeat(4097) }, { ...request, cwd: "a\0b" }, { ...request, attempt: 0 }, { ...request, attempt: Infinity },
    { ...request, purpose: "startup" }, { ...request, sessionId: "" }]) expect(() => parseRuntimeContextRequest(value)).toThrow("required_context_unavailable");
  for (const value of [null, [], { ...snapshot, grants: true }, { ...snapshot, revision: "a/b" },
    { ...snapshot, facts: 1 }, { ...snapshot, instructions: "é".repeat(RUNTIME_CONTEXT_MAX_BYTES / 2 + 1) }]) expect(() => parseRuntimeContextSnapshot(value)).toThrow("required_context_unavailable");
  for (const value of [{ version: 2, bindingId: "binding" }, { version: 1, bindingId: "binding", callback: true }]) expect(() => parseRuntimeContextConfig(value)).toThrow("required_context_unavailable");
});
test("context validators refuse accessors and symbols without invoking getters", () => {
  let reads = 0;
  for (const parse of [parseRuntimeContextConfig, parseRuntimeContextRequest, parseRuntimeContextSnapshot]) {
    expect(() => parse(Object.defineProperty({}, "facts", { get() { reads++; return "secret"; } }))).toThrow();
  }
  expect(() => parseRuntimeContextSnapshot({ ...snapshot, [Symbol("authority")]: true })).toThrow();
  expect(reads).toBe(0);
});
