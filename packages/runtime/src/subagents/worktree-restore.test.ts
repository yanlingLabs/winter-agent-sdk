import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINTER_BRAND, WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";
import { runEngine } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { userMessageText } from "../provider/mock.ts";
import { runGit } from "../tools/impl/enter-worktree.ts";
import { createChildEngineFactory } from "./child-engine.ts";
import { registerChildEngineFactory, resetChildEngineFactoryForTest, type ChildInheritance, type ChildSessionRecord } from "./child-handle.ts";
import { resetSpawnLimitsForTest, currentRunningSubagentCount } from "./limits.ts";
import { bindRestoredChildren, restoredChildHandle } from "./restore.ts";

const homes: string[] = [];
afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function fixture(external = false) {
  const home = mkdtempSync(join(tmpdir(), "winter-worktree-restore-"));
  homes.push(home);
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  async function git(args: string[]) {
    const result = await runGit(args, cwd);
    if (!result.ok) throw new Error(result.stderr);
  }
  await git(["init", "--initial-branch=main"]);
  writeFileSync(join(cwd, "tracked.txt"), "original\n");
  await git(["add", "tracked.txt"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  const worktrees = join(cwd, WINTER_BRAND.projectDirName, "worktrees");
  const worktree = external ? join(home, "external-entered") : join(worktrees, "entered");
  mkdirSync(worktrees, { recursive: true });
  await git(["worktree", "add", worktree]);
  const store = new WinterCompatibilitySessionStore({ winterHome: join(home, "store") });
  const sessionId = randomUUID();
  const inheritance: ChildInheritance = { policy: { effectiveMode: "default", parentPolicyHash: "original", parentPolicyVersion: 1 }, tools: [], model: "winter-test/echo", effort: "inherit", thinking: undefined, systemPrompt: "", sessionRoot: worktree };
  const child = await createChildEngineFactory({ store, winterHome: home, provider: { async generate() { return { kind: "text", text: "original answer" }; } } })({ parentSessionId: sessionId, forwardChildFrame() {} }).spawn({ parentToolUseId: "original-call", prompt: "original task", runInBackground: false }, inheritance);
  await child.result();
  await child.generationDone?.();
  return { home, cwd, worktree, worktrees, store, sessionId, git, record: structuredClone(child.record) };
}

test("a normal child spawned in an entered worktree resumes after the parent restarts at its original root", async () => {
  const f = await fixture();
  const requests: string[] = [];
  const factory = createChildEngineFactory({ store: f.store, winterHome: f.home, provider: { async generate({ messages }) { requests.push(JSON.stringify(messages)); return { kind: "text", text: "continued answer" }; } } })({ parentSessionId: f.sessionId, getParentWorkspace: () => ({ cwd: f.cwd, projectKey: f.record.execution!.projectKey }), forwardChildFrame() {} });
  const restored = restoredChildHandle(f.record);
  bindRestoredChildren([restored], factory.restore!);
  expect(await restored.resume({ messageId: randomUUID(), body: "followup" } as never)).toMatchObject({ status: "resumed_and_delivered" });
  await restored.result();
  await restored.generationDone?.();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("original task");
  expect(requests[0]).toContain("original answer");
  expect(requests[0]).toContain("followup");
  expect(restored.record.execution!.workspace.root).toBe(f.worktree);
  expect(currentRunningSubagentCount()).toBe(0);
});

test("a live parent EnterWorktree switch binds child resume to its actual session root", async () => {
  const f = await fixture(true);
  const child = restoredChildHandle(f.record);
  const provider = { async generate({ messages }: Parameters<import("../engine.ts").Provider["generate"]>[0]) {
    if (messages.some((entry) => userMessageText(entry).includes("original task"))) return { kind: "text" as const, text: "child continued in entered workspace" };
    const entered = messages.some((entry) => entry.role === "assistant" && Array.isArray(entry.content) && entry.content.some((block) => block.type === "tool_use" && block.name === "EnterWorktree"));
    return entered ? { kind: "text" as const, text: "parent entered worktree" } : { kind: "tool_use" as const, calls: [{ id: "enter-call", name: "EnterWorktree", input: { path: f.worktree } }] };
  } };
  registerChildEngineFactory(createChildEngineFactory({ store: f.store, winterHome: f.home, provider }));
  const { host, runtime } = createInMemoryChannel();
  let entered = false;
  const done = runEngine({ config: { sessionId: f.sessionId, cwd: f.cwd, model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, tools: ["EnterWorktree"] }, input: runtime.input, output: runtime.output, provider, winterHome: f.home, restoredChildren: [child] });
  const reader = (async () => { for await (const frame of host.input) if (frame.type === "data" && JSON.stringify(frame.message).includes("parent entered worktree")) entered = true; })();
  try {
    host.output.write({ type: "user", text: "enter selected worktree" });
    const deadline = Date.now() + 3_000;
    while (!entered) {
      if (Date.now() > deadline) throw new Error("parent EnterWorktree did not complete");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // This worktree lies outside the cold fallback's owned directory. Only the live, authorized
    // session-root switch can make it match this child's saved root.
    expect(await child.resume({ messageId: randomUUID(), body: "followup" } as never)).toMatchObject({ status: "resumed_and_delivered" });
    await child.result();
    await child.generationDone?.();
    expect(child.status()).toBe("completed");
    expect(currentRunningSubagentCount()).toBe(0);
  } finally {
    await child.stop();
    host.output.write({ type: "control_request", requestId: "finish", subtype: "end_input", payload: undefined });
    await done;
    await reader;
  }
});

test.each(["unregistered", "prefix-sibling", "external-registered", "removed"])("cold restore refuses a %s saved parent workspace before provider dispatch", async (kind) => {
  const f = await fixture();
  let root = f.worktree;
  if (kind === "unregistered") { root = join(f.worktrees, "unregistered"); mkdirSync(root); }
  if (kind === "prefix-sibling") { root = join(`${f.worktrees}-other`, "escaped"); mkdirSync(root, { recursive: true }); }
  if (kind === "external-registered") { root = join(f.home, "external"); await f.git(["worktree", "add", root]); }
  if (kind === "removed") await f.git(["worktree", "remove", f.worktree]);
  const record = structuredClone(f.record) as ChildSessionRecord;
  record.execution!.inheritance.sessionRoot = root;
  record.execution!.workspace.root = root;
  let calls = 0;
  const factory = createChildEngineFactory({ store: f.store, winterHome: f.home, provider: { async generate() { calls++; return { kind: "text", text: "must not run" }; } } })({ parentSessionId: f.sessionId, getParentWorkspace: () => ({ cwd: f.cwd, projectKey: record.execution!.projectKey }), forwardChildFrame() {} });
  const restored = restoredChildHandle(record);
  bindRestoredChildren([restored], factory.restore!);
  expect(await restored.resume({ messageId: randomUUID(), body: "followup" } as never)).toMatchObject({ status: "unavailable", retryable: false });
  expect(calls).toBe(0);
  expect(currentRunningSubagentCount()).toBe(0);
});
