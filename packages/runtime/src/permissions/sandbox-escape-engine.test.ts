// The escape rule through the REAL engine (dist-session fixes, lane C C3): what the host actually sees.
// A matching allow rule runs `dangerouslyDisableSandbox` with no permission request at all; one no
// rule sanctions reaches the host (canUseTool) with claude's "Run outside of the sandbox"; and under
// `allowUnsandboxedCommands: false` the flag removes no sandbox, so it is no escape.
import { expect, test } from "bun:test";
import type { ControlRequestFrame, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider, stubExecutor } from "../provider/mock.ts";

async function drive(config: Partial<RuntimeConfig>, input: Record<string, unknown>, answer: unknown): Promise<{ permissionRequests: ControlRequestFrame[]; toolResults: unknown[] }> {
  const { host, runtime } = createInMemoryChannel();
  const provider = scriptedProvider([
    { kind: "tool_use", calls: [{ id: "call1", name: "Bash", input }] },
    { kind: "text", text: "done" },
  ]);
  const done = runEngine({ config: { sessionId: "esc", cwd: "/tmp/x", model: "sonnet", persistSession: false, ...config } as RuntimeConfig, input: runtime.input, output: runtime.output, provider, tools: stubExecutor });
  host.output.write({ type: "user", text: "go" });
  const permissionRequests: ControlRequestFrame[] = [];
  const toolResults: unknown[] = [];
  for await (const f of host.input) {
    if (f.type === "control_request" && (f as ControlRequestFrame).subtype === "permission") {
      permissionRequests.push(f as ControlRequestFrame);
      host.output.write({ type: "control_response", requestId: (f as ControlRequestFrame).requestId, ok: true, payload: answer });
    }
    const message = (f as { message?: { type?: string; message?: { content?: unknown } } }).message;
    if (f.type === "data" && message?.type === "user") toolResults.push(message.message?.content);
    if (f.type === "data" && message?.type === "result") break;
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  for await (const _ of host.input as AsyncIterable<WinterFrame>) void _;
  await done;
  return { permissionRequests, toolResults };
}

test("a matching allow rule runs an escape with NO permission request", async () => {
  const r = await drive({ allowedTools: ["Bash(gh repo:*)"] }, { command: "gh repo view yanlingLabs/winter", dangerouslyDisableSandbox: true }, { behavior: "deny", message: "unused" });
  expect(r.permissionRequests).toHaveLength(0);
  expect(JSON.stringify(r.toolResults)).not.toContain("denied");
});

test("an escape no rule sanctions reaches the host with claude's reason", async () => {
  const r = await drive({}, { command: "curl -s https://example.com", dangerouslyDisableSandbox: true }, { behavior: "allow" });
  expect(r.permissionRequests).toHaveLength(1);
  expect((r.permissionRequests[0]!.payload as { decisionReason?: string }).decisionReason).toBe("Run outside of the sandbox");
});

test("allowUnsandboxedCommands: false -- the flag removes no sandbox, so a read-only `ls` stays a silent read", async () => {
  const r = await drive({ sandbox: { allowUnsandboxedCommands: false } } as Partial<RuntimeConfig>, { command: "ls", dangerouslyDisableSandbox: true }, { behavior: "deny", message: "unused" });
  expect(r.permissionRequests).toHaveLength(0);
});

// `autoAllowBashIfSandboxed` pays for containment, so it may only clear a command the Bash tool will
// actually run sandboxed. An allowed `excludedCommands` entry runs UNSANDBOXED (`resolveExecutionPath`
// row 3), and the predicate used to re-spell the table without that row.
test("autoAllowBashIfSandboxed does not clear an allowed excludedCommands entry (it runs unsandboxed)", async () => {
  const command = "touch /tmp/winter-excluded-marker";
  const sandboxed = await drive({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } } as Partial<RuntimeConfig>, { command }, { behavior: "deny", message: "unused" });
  expect(sandboxed.permissionRequests).toHaveLength(0); // control: a sandboxed run is auto-allowed
  const excluded = await drive({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true, excludedCommands: [command] } } as Partial<RuntimeConfig>, { command }, { behavior: "deny", message: "no" });
  expect(excluded.permissionRequests).toHaveLength(1);
});

// `RuntimeConfig.outputsDir` reaches the permission layer: under bypass a shell write to the literal
// outputs path inside the winter home runs with no request; without it, the protected floor asks.
test("config.outputsDir reaches the evaluator: bypass writes to the literal outputs path without a request", async () => {
  const home = "/tmp/winter-outputs-engine-home";
  const out = `${home}/outputs/s1`;
  const base = { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, winterHome: home } as Partial<RuntimeConfig>;
  const withOut = await drive({ ...base, outputsDir: out } as Partial<RuntimeConfig>, { command: `echo x > ${out}/report.txt` }, { behavior: "deny", message: "unused" });
  expect(withOut.permissionRequests).toHaveLength(0);
  const without = await drive(base, { command: `echo x > ${out}/report.txt` }, { behavior: "deny", message: "no" });
  expect(without.permissionRequests).toHaveLength(1);
});
