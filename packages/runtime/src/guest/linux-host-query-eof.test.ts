/** Actual local SDK engine/bridge EOF behavior. No native admission or subprocess is invented. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { query, encodeFrame, splitFrames, WinterCompatibilitySessionStore, compatibilityKeys, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import type { Provider, ToolExecutor } from "../engine.ts";
import { boundedLinuxSessionInput } from "./linux-session-entry.ts";

function isTerminalResult(frame: WinterFrame): boolean {
  if (frame.type !== "data") return false;
  const message = frame.message;
  return typeof message === "object" && message !== null && "type" in message && message.type === "result";
}

async function eofRun(pendingApproval: boolean) {
  const home = mkdtempSync(join(tmpdir(), "winter-host-eof-home-")), cwd = mkdtempSync(join(tmpdir(), "winter-host-eof-source-")), sessionId = randomUUID();
  let generations = 0, calls = 0, cancelled = 0, sawPermission = false;
  const provider: Provider = { async generate() {
    return pendingApproval && generations++ === 0
      ? { kind: "tool_use", calls: [{ id: "write-pending", name: "Write", input: { file_path: join(cwd, "source"), content: "unapproved" } }] }
      : { kind: "text", text: "queued turn finished" };
  } };
  const tools: ToolExecutor = { async execute() { calls++; return { output: "test executor" }; } };
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify({ sessionId, cwd, winterHome: home, model: "winter-test/echo", persistSession: true, settingSources: [], tools: ["Read", "Edit", "Write", "Bash"], allowedTools: [], permissionMode: "default" })], provider, tools, { WINTER_HOME: home });
  try {
    const frame = encodeFrame({ type: "user", text: "finish this queued turn" });
    for await (const chunk of boundedLinuxSessionInput((async function* () { yield frame.slice(0, 10); yield frame.slice(10); })(), () => { cancelled++; })) proc.stdin.write(chunk);
    if (!pendingApproval) proc.stdin.end();
    const frames: WinterFrame[] = []; let carry = "";
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry); carry = split.carry;
      for (const frame of split.frames) {
        frames.push(frame);
        if (frame.type === "control_request" && frame.subtype === "permission") { sawPermission = true; proc.stdin.end(); }
      }
    }
    const exit = await proc.exited;
    const entries = await new WinterCompatibilitySessionStore({ winterHome: home }).load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId });
    return { exit, calls, cancelled, sawPermission, frames, entries };
  } finally { proc.stdin.end(); await proc.exited; rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
}

test("clean physical EOF after fragmented user input finishes the actual local engine and durable transcript", async () => {
  const run = await eofRun(false);
  expect(run.cancelled).toBe(0); expect(run.exit).toEqual({ code: 0, signal: null });
  expect(run.frames.some(isTerminalResult)).toBe(true);
  expect(JSON.stringify(run.entries)).toContain("queued turn finished");
  expect(JSON.stringify(run.entries)).toContain("finish this queued turn");
});
test("physical EOF while actual permission RPC is pending denies the effect and still finalizes code0/transcript", async () => {
  const run = await eofRun(true);
  expect(run.sawPermission).toBe(true); expect(run.calls).toBe(0); expect(run.cancelled).toBe(0);
  expect(run.exit).toEqual({ code: 0, signal: null });
  expect(run.frames.some(isTerminalResult)).toBe(true);
  expect(JSON.stringify(run.entries)).toContain("queued turn finished");
});


test("actual query terminal result then stdin EOF preserves post-result engine/store completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-query-eof-home-")), cwd = mkdtempSync(join(tmpdir(), "winter-query-eof-source-")), sessionId = randomUUID();
  let enqueue!: ReadableStreamDefaultController<string>, ended = false, cancelled = 0, sawTerminal = false, eofAfterTerminal = false;
  const transport = new ReadableStream<string>({ start(controller) { enqueue = controller; } });
  let underlying: ReturnType<typeof inMemoryProcess> | undefined, feed: Promise<void> | undefined;
  const provider: Provider = { async generate() { return { kind: "text", text: "terminal before transport EOF" }; } };
  const q = query({ prompt: "finish once", options: { sessionId, model: "winter-test/echo", cwd, env: { WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" }, persistSession: true, settingSources: [],
    spawnClaudeCodeProcess(options) {
      const proc = inMemoryProcess(options.args, provider, undefined, { WINTER_HOME: home }); underlying = proc;
      feed = (async () => { for await (const chunk of boundedLinuxSessionInput(transport, () => { cancelled++; })) proc.stdin.write(chunk); proc.stdin.end(); })();
      const stdout = (async function* () { let carry = ""; for await (const chunk of proc.stdout) { const split = splitFrames(chunk, carry); carry = split.carry; sawTerminal ||= split.frames.some(isTerminalResult); yield chunk; } })();
      return { ...proc, stdout, stdin: { write(chunk) { enqueue.enqueue(chunk); }, end() { if (!ended) { ended = true; eofAfterTerminal = sawTerminal; enqueue.close(); } } } };
    },
  } });
  try {
    for await (const _ of q) {}
    await feed; expect(await underlying!.exited).toEqual({ code: 0, signal: null });
    expect(sawTerminal).toBe(true); expect(eofAfterTerminal).toBe(true); expect(cancelled).toBe(0);
    const entries = await new WinterCompatibilitySessionStore({ winterHome: home }).load({ projectKey: compatibilityKeys(cwd).transcriptProjectKey, sessionId });
    expect(JSON.stringify(entries)).toContain("terminal before transport EOF");
  } finally { await q.return(undefined); if (!ended) { ended = true; enqueue.close(); } await feed; await underlying?.exited; rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});
