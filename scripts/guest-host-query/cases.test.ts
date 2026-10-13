import { expect, test } from "bun:test";
import { CASES, fixtureCase, toolScript } from "./cases.ts";
import { fixturePermission, fixtureTranscript, hostOptions } from "./host-client.ts";
import { assertLinuxHostQueryConfig } from "../../packages/runtime/src/guest/linux-host-query-profile.ts";
function frames(kind: typeof CASES[number]) {
  return toolScript(kind).flatMap((call, index) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: `call-${index}`, ...call }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: `call-${index}`, is_error: kind === "bypass" && index >= 3, denied: (kind === "plan" || kind === "ask-deny") && (index === 1 || index === 2), content: index === 0 ? "hello\n" : index === 2 ? "host-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]" : "fixture" }] } },
  ]);
}
test("closed fixture cases and bypass callback cannot be relaxed", () => {
  expect(() => fixtureCase("other")).toThrow();
  for (const kind of CASES) {
    const write = toolScript(kind)[1]!;
    if (kind === "bypass") expect(() => fixturePermission(kind, write.name, write.input)).toThrow();
    else expect(fixturePermission(kind, write.name, write.input).behavior).toBe(kind === "ask-allow" ? "allow" : "deny");
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
    const home = mkdtempSync(join(tmpdir(), "winter-host-case-")); let at = 0, callbacks = 0; const observed: unknown[] = [], script = toolScript(kind);
    const provider: any = { async generate() { const call = script[at]; return call ? { kind: "tool_use", calls: [{ id: `call-${at++}`, ...call }] } : { kind: "text", text: `host-query-${kind}-complete` }; } };
    const tools: any = { async execute(call: any) { const index = Number(call.id.slice(5)); return { isError: kind === "bypass" && index >= 3, output: index === 0 ? "hello\n" : index === 2 ? "host-query-boundary-ok\n[Exit code: 0; cwd changes apply to this command only]" : "fixture" }; } };
    const q = query({ prompt: "fixed local test", options: { model: "winter-test/echo", cwd: home, env: { WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" }, persistSession: false, settingSources: [], tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], permissionMode: kind === "bypass" ? "bypassPermissions" : kind === "plan" ? "plan" : "default", permissions: { disableBypassPermissionsMode: kind !== "bypass" }, allowDangerouslySkipPermissions: kind === "bypass",
      canUseTool: async (tool, input) => { callbacks++; return fixturePermission(kind, tool, input); },
      spawnClaudeCodeProcess(options) {
        // Explicit local testing leg with injected provider/executor, NEVER a native admission.
        const proc = inMemoryProcess(options.args, provider, tools, { WINTER_HOME: home });
        return { ...proc, stdout: (async function* () { let carry = ""; for await (const chunk of proc.stdout) { const split = splitFrames(chunk, carry); carry = split.carry; for (const frame of split.frames) if (frame.type === "data") observed.push(frame.message); yield chunk; } })() };
      },
    } });
    try { for await (const _ of q) {} expect(callbacks).toBe(kind === "bypass" ? 0 : 2); expect(fixtureTranscript(kind, observed).toolResults).toBe(script.length); }
    finally { await q.return(undefined); rmSync(home, { recursive: true, force: true }); }
  }
});
