import { expect, test } from "bun:test";
import { createHostCodeHookStage } from "./host-stage.ts";
import type { EvaluationContext } from "../permissions/evaluator.ts";
import type { SourcedHookEntry } from "./registry.ts";
const context = { policy: { version: 3 } } as EvaluationContext;
const call = { toolName: "Bash", input: { command: "original" } };
const entry = (id: string, overrides: Partial<SourcedHookEntry> = {}): SourcedHookEntry => ({ id, event: "PreToolUse", source: "sdk", ...overrides });
const raw = (decision: string | undefined, command?: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...(decision ? { permissionDecision: decision } : {}), ...(command ? { updatedInput: { command } } : {}) } });

test("host hooks retain real exact/regex matching and untrusted project exclusion", async () => {
  const seen: string[] = [];
  const stage = createHostCodeHookStage({ entries: [entry("exact", { matcher: "BashOutput" }), entry("regex", { matcher: "^Bash$" }), entry("untrusted", { source: "project" })], sessionId: "s", trustedWorkspace: false, invoker: { async invoke(request) { seen.push(request.hookId); return raw("allow"); } } });
  expect((await stage.preToolUse(call, context)).decision).toBe("allow");
  expect(seen).toEqual(["regex"]);
});

test("completed reviewers preserve invocation input chaining and final reducer precedence", async () => {
  const seen: unknown[] = [];
  let release!: (value: unknown) => void;
  const stage = createHostCodeHookStage({ entries: [entry("allow"), entry("review"), entry("none")], sessionId: "s", trustedWorkspace: false, invoker: { async invoke(request) {
    seen.push(request.input);
    if (request.hookId === "allow") return raw("allow", "losing-transform");
    if (request.hookId === "review") return new Promise(resolve => { release = resolve; });
    return raw(undefined, "final-transform");
  } } });
  let settled = false;
  const pending = stage.preToolUse(call, context).then(value => { settled = true; return value; });
  while (!release) await Promise.resolve();
  expect(settled).toBe(false);
  release(raw("ask", "reviewed-transform"));
  expect(await pending).toMatchObject({ decision: "ask", hookId: "review", transformedInput: { command: "final-transform" } });
  expect(seen).toEqual([{ command: "original" }, { command: "losing-transform" }, { command: "reviewed-transform" }]);
});

test("fail-closed malformed matcher and reviewer failure deny and short circuit", async () => {
  const seen: string[] = [];
  const stage = createHostCodeHookStage({ entries: [entry("floor", { matcher: "[", failClosed: true }), entry("later")], sessionId: "s", trustedWorkspace: false, warn() {}, invoker: { async invoke(request) { seen.push(request.hookId); throw new Error("reviewer unavailable"); } } });
  expect(await stage.preToolUse(call, context)).toMatchObject({ decision: "deny", hookId: "floor" });
  expect(seen).toEqual(["floor"]);
});

test("PermissionRequest uses its own interpreter and preserves allowed input", async () => {
  const stage = createHostCodeHookStage({ entries: [entry("approval", { event: "PermissionRequest", matcher: "Bash" })], sessionId: "s", trustedWorkspace: false, invoker: { async invoke() { return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "approved" } } } }; } } });
  expect(await stage.permissionRequest!(call, context, { decisionReason: "fixture" })).toMatchObject({ decision: "allow", transformedInput: { command: "approved" } });
});
