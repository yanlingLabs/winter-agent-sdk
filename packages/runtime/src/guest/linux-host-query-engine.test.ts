/** Real SDK query/engine/RpcBridge tests in the local testing leg. No native admission is minted. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, decodeFrame, type Options } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import type { Provider, ToolExecutor } from "../engine.ts";

async function exercise(mode: "default" | "plan" | "bypassPermissions", answer: "allow" | "deny" | "throw" | "interrupt") {
  const home = mkdtempSync(join(tmpdir(), "winter-host-query-local-"));
  let calls = 0, prompts = 0, generation = 0, ended = false, responseAfterEnd = false, callbackCancelled = false;
  const provider: Provider = { async generate() { return generation++ === 0 ? { kind: "tool_use", calls: [{ id: "write-1", name: "Write", input: { file_path: join(home, "source"), content: "effect" } }] } : { kind: "text", text: "done" }; } };
  const tools: ToolExecutor = { async execute() { calls++; return { output: "test executor observed" }; } };
  const callback: NonNullable<Options["canUseTool"]> = async (_tool, _input, options) => {
    prompts++;
    if (answer === "throw") throw new Error("fixture callback failure");
    if (answer === "interrupt") {
      const cancelled = new Promise<void>(resolve => { options.signal.addEventListener("abort", () => { callbackCancelled = true; resolve(); }, { once: true }); });
      void q.interrupt(); await cancelled;
      return { behavior: "allow" }; // Late success must not revive the cancelled operation.
    }
    return answer === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "fixture denied" };
  };
  const q = query({ prompt: "write once", options: {
    model: "winter-test/echo", cwd: home, env: { WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" }, persistSession: false, settingSources: [], tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true,
    permissionMode: mode, permissions: { disableBypassPermissionsMode: mode !== "bypassPermissions" }, allowDangerouslySkipPermissions: mode === "bypassPermissions", canUseTool: callback,
    spawnClaudeCodeProcess(opts) {
      const proc = inMemoryProcess(opts.args, provider, tools, { WINTER_HOME: home });
      const original = proc.stdin.write.bind(proc.stdin);
      proc.stdin.write = chunk => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const frame = decodeFrame(line);
          if (frame.type === "control_request" && frame.subtype === "end_input") ended = true;
          if (frame.type === "control_response") responseAfterEnd ||= ended;
        }
        original(chunk);
      };
      return proc;
    },
  } });
  try {
    try { for await (const _ of q) {} } catch (error) { if (answer !== "interrupt") throw error; }
    return { calls, prompts, responseAfterEnd, callbackCancelled };
  } finally { await q.return(undefined); rmSync(home, { recursive: true, force: true }); }
}

test("actual SDK permission answer still reaches engine after logical end_input, once only", async () => {
  expect(await exercise("default", "allow")).toEqual({ calls: 1, prompts: 1, responseAfterEnd: true, callbackCancelled: false });
});
test("actual SDK denial and callback failure produce no tool effect", async () => {
  for (const answer of ["deny", "throw"] as const) expect(await exercise("default", answer)).toEqual({ calls: 0, prompts: 1, responseAfterEnd: true, callbackCancelled: false });
});
test("plan write is withheld on denied approval; bypass permits ordinary call without host prompt", async () => {
  expect((await exercise("plan", "deny")).calls).toBe(0);
  expect(await exercise("bypassPermissions", "deny")).toEqual({ calls: 1, prompts: 0, responseAfterEnd: false, callbackCancelled: false });
});
test("interrupt cancels actual pending host callback and its late allow cannot execute", async () => {
  const result = await exercise("default", "interrupt");
  expect(result.calls).toBe(0); expect(result.prompts).toBe(1); expect(result.callbackCancelled).toBe(true);
});
