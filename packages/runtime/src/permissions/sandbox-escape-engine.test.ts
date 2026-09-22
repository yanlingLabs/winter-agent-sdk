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
