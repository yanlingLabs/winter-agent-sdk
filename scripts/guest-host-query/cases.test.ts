import { expect, test } from "bun:test";
import { CASES, fixtureCase, toolScript } from "./cases.ts";
import { fixturePermission, fixtureTranscript, hostOptions, hostFailure } from "./host-client.ts";
import { assertLinuxHostQueryConfig } from "../../packages/runtime/src/guest/linux-host-query-profile.ts";
function frames(kind: typeof CASES[number]) {
  return toolScript(kind).flatMap((call, index) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `call-${index}`, ...call }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `call-${index}`, is_error: (kind === "bypass" && index >= 3) || (kind === "plan" && index === 1), denied: kind === "ask-deny" && (index === 1 || index === 2), content: kind === "plan" && index === 1 ? "Error [read_only]: guest file operation refused" : kind === "plan" && index === 2 ? "Read-only file system\nhost-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]" : index === 0 ? "hello\n" : index === 2 ? "host-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]" : "fixture" }] } },
  ]);
}
test("closed fixture cases and bypass callback cannot be relaxed", () => {
  expect(() => fixtureCase("other")).toThrow();
  for (const kind of CASES) {
    const write = toolScript(kind)[1]!;
    if (kind === "bypass") expect(() => fixturePermission(kind, write.name, write.input)).toThrow();
    else expect(fixturePermission(kind, write.name, write.input).behavior).toBe(kind === "ask-allow" || kind === "plan" ? "allow" : "deny");
    expect(() => fixturePermission(kind, "Bash", { command: "different" })).toThrow();
    expect(fixtureTranscript(kind, frames(kind)).toolCalls).toBe(kind === "bypass" ? 6 : 3);
  }
});
test("tool outcome oracle rejects missing/foreign/error results and changed exact Read/Bash", () => {
  for (const mutate of [
    (data: any[]) => data.pop(), (data: any[]) => { data[1].message.content[0].tool_use_id = "other"; },
    (data: any[]) => { data[1].message.content[0].content = "wrong"; },
    (data: any[]) => { data[3].message.content[0].is_error = true; },
    (data: any[]) => { data[5].message.content[0].content = "not actual Bash output"; },
    (data: any[]) => { data[0].message.content[0].input = { file_path: "other" }; },
  ]) { const data = frames("ask-allow"); mutate(data); expect(() => fixtureTranscript("ask-allow", data)).toThrow(); }
});
test("host SDK options never derive native config authority from environment or preapproved tools", () => {
  const config: any = { executionPosture: "confined-guest", sessionId: "backend", model: "model", cwd: "/workspace/folders/source", winterHome: "/run/winter/conversations/logical", storeHome: "/workspace/.winter/conversations/logical", persistSession: true, tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], settingSources: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "bypassPermissions", permissions: { disableBypassPermissionsMode: false }, allowDangerouslySkipPermissions: true };
  assertLinuxHostQueryConfig(config); const options = hostOptions(config);
  expect(options.env).toEqual({}); expect(options.allowedTools).toEqual([]); expect(options.permissionMode).toBe("bypassPermissions");
});

test("actual local SDK query/engine callback routing matches fixed allow/deny/plan/bypass cases", async () => {
  const { query, splitFrames } = await import("@yanlinglabs/winter-agent-sdk");
  const { inMemoryProcess } = await import("../../packages/runtime/src/testing.ts");
  const { mkdtempSync, rmSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  for (const kind of CASES) {
    const home = mkdtempSync(join(tmpdir(), "winter-host-case-")); let at = 0, callbacks = 0, requests = 0, responses = 0; const observed: unknown[] = [], script = toolScript(kind);
    const provider: any = { async generate() { const call = script[at]; return call ? { kind: "tool_use", calls: [{ id: `call-${at++}`, ...call }] } : { kind: "text", text: `host-query-${kind}-complete` }; } };
    const tools: any = { async execute(call: any) { const index = Number(call.id.slice(5)); return { isError: (kind === "bypass" && index >= 3) || (kind === "plan" && index === 1), output: kind === "plan" && index === 1 ? "Error [read_only]: guest file operation refused" : kind === "plan" && index === 2 ? "Read-only file system\nhost-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]" : index === 0 ? "hello\n" : index === 2 ? "host-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]" : "fixture" }; } };
    const q = query({ prompt: "fixed local test", options: { model: "winter-test/echo", cwd: home, env: { WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" }, persistSession: false, settingSources: [], tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], permissionMode: kind === "bypass" ? "bypassPermissions" : kind === "plan" ? "plan" : "default", permissions: { disableBypassPermissionsMode: kind !== "bypass" }, allowDangerouslySkipPermissions: kind === "bypass",
      canUseTool: async (tool, input) => { callbacks++; return fixturePermission(kind, tool, input); },
      spawnClaudeCodeProcess(options) {
        // Explicit local testing leg with injected provider/executor, NEVER a native admission.
        const proc = inMemoryProcess(options.args, provider, tools, { WINTER_HOME: home });
        let inputCarry = "";
        return { ...proc, stdin: { ...proc.stdin, write(chunk) { const split = splitFrames(chunk, inputCarry); inputCarry = split.carry; responses += split.frames.filter(frame => frame.type === "control_response").length; proc.stdin.write(chunk); } }, stdout: (async function* () { let carry = ""; for await (const chunk of proc.stdout) { const split = splitFrames(chunk, carry); carry = split.carry; for (const frame of split.frames) { if (frame.type === "data") observed.push(frame.message); if (frame.type === "control_request") requests++; } yield chunk; } })() };
      },
    } });
    try { for await (const _ of q) {} expect(callbacks).toBe(kind === "bypass" ? 0 : 2); expect(requests).toBe(callbacks); expect(responses).toBe(callbacks); expect(fixtureTranscript(kind, observed).toolResults).toBe(script.length); }
    finally { await q.return(undefined); rmSync(home, { recursive: true, force: true }); }
  }
});

test("plan oracle requires independent readonly errors after deliberately allowed callbacks", () => {
  const script = toolScript("plan");
  expect(fixturePermission("plan", script[1]!.name, script[1]!.input).behavior).toBe("allow");
  expect(fixturePermission("plan", script[2]!.name, script[2]!.input).behavior).toBe("allow");
  for (const change of ["permission-denied", "missing-EROFS", "unexpected-success"]) {
    const data = frames("plan") as any[];
    if (change === "permission-denied") { data[3].message.content[0].denied = true; data[3].message.content[0].is_error = false; }
    if (change === "missing-EROFS") data[5].message.content[0].content = "host-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]";
    if (change === "unexpected-success") data[3].message.content[0].is_error = false;
    expect(() => fixtureTranscript("plan", data)).toThrow();
  }
});
test("actual readonly helper error code is distinct from a permission denial and never calls its port", async () => {
  const { createGuestFileHelper, GuestFileHelperError } = await import("../../packages/runtime/src/guest/file-helper.ts");
  const { guestFileError } = await import("../../packages/runtime/src/guest/file-session.ts");
  let effects = 0;
  const helper = createGuestFileHelper({ authority: { workspaceId: "workspace", sessionId: "session", incarnationId: "incarnation", leaseEpoch: 1, configRevision: 1, grantRevision: 1, policyRevision: 1 }, roots: [{ id: "source", guestPath: "/workspace/folders/source", readOnly: true }], expectedUid: 10001, port: { async execute() { effects++; throw new Error("must not reach port"); } } });
  try { await helper.write("source", "approved-write", new Uint8Array([1])); throw new Error("missing refusal"); }
  catch (error) { expect(error).toBeInstanceOf(GuestFileHelperError); expect(guestFileError(error)).toEqual({ output: "Error [read_only]: guest file operation refused", isError: true }); }
  expect(effects).toBe(0);
});

test("host failure diagnostics retain only closed classes/reasons and known errno", () => {
  expect(hostFailure(new Error("fixture callback correlation"))).toEqual({ class: "Error", code: "callback_binding" });
  const error = Object.assign(new Error("secret /foreign/path bearer abc"), { code: "EPIPE" });
  expect(hostFailure(error)).toEqual({ class: "Error", code: "host_failure", errnoCode: "EPIPE" });
  expect(hostFailure({ message: "secret", code: "/private/path" })).toEqual({ class: "NonError", code: "host_failure" });
  expect(hostFailure(null)).toEqual({ class: "NonError", code: "host_failure" });
});

test("actual SDK error diagnostics preserve only bounded process facts and closed result subtypes", async () => {
  const { CLIConnectionError, ProcessError, ProtocolDecodeError, ResultError, AbortError } = await import("@yanlinglabs/winter-agent-sdk");
  for (const error of [new CLIConnectionError("secret /path"), new ProtocolDecodeError("foreign frame"), new AbortError("secret abort")]) expect(hostFailure(error)).toEqual({ class: error.name, code: "host_failure" });
  expect(hostFailure(new ProcessError("foreign output", 77, "SIGTRAP"))).toEqual({ class: "ProcessError", code: "host_failure", processCode: 77, signal: "SIGTRAP" });
  expect(hostFailure(new ProcessError("foreign output", null, null))).toEqual({ class: "ProcessError", code: "host_failure", processCode: null, signal: null });
  for (const code of [-1, 256, 1.5, NaN, Infinity]) expect(hostFailure(new ProcessError("secret", code, "/foreign/signal"))).toEqual({ class: "ProcessError", code: "host_failure" });
  expect(hostFailure(new ResultError({ type: "result", subtype: "error_during_execution", permission_denials: [], is_error: true, result: "secret /path" }))).toEqual({ class: "ResultError", code: "host_failure", resultSubtype: "error_during_execution" });
  expect(hostFailure(new ResultError({ type: "result", subtype: "/foreign/subtype", permission_denials: [], result: "secret" }))).toEqual({ class: "ResultError", code: "host_failure" });
  expect(hostFailure(Object.assign(new Error("secret"), { name: "ProcessError", code: 77, signal: "SIGTRAP" }))).toEqual({ class: "Error", code: "host_failure" });
});
