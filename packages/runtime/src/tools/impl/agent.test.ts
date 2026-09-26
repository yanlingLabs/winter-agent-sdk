// Focused unit tests for the Agent tool executor itself (input validation, request construction,
// result mapping, background-task frame emission) -- deliberately using a FAKE
// `ctx.session.spawnChild`, never a real child-engine factory: child-engine.ts's own spawning
// correctness is already exhaustively proven end-to-end in child-engine.test.ts (a real, driven
// runEngine). This file's only job is what agent.ts itself adds on top of that seam.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState } from "../read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import { AGENT_TOOL_NAME, agentExecutor } from "./agent.ts";
import { configureBackgroundTaskRoot, resetBackgroundTaskRootForTest } from "../background-tasks.ts";
// Phase 4 Task 8 (rider 24): the shared registry TaskStop/TaskOutput are implemented against, and
// those two REAL executors -- driven by task id here, never by calling their internals.
import { getTask, listRunningTasks, toBackgroundTasksChangedEntry, startTracking } from "./background-task-runtime.ts";
import { taskStopExecutor } from "./task-stop.ts";
import { taskOutputExecutor } from "./task-output.ts";
import { resetBackgroundTaskRuntimeForTest } from "./background-task-runtime.ts";
import type { SessionTempDirPaths } from "../../paths/temp.ts";
import type { ChildHandle, ChildResult, ChildSessionRecord, ChildTaskProgress, SpawnChildRequest } from "../../subagents/child-handle.ts";
import { resolveBrand, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

function fakeRecord(overrides: Partial<ChildSessionRecord> = {}): ChildSessionRecord {
  return {
    id: "child-1",
    parentSessionId: "parent-1",
    parentToolUseId: "synthetic",
    transcript: "proj/parent-1/subagents/agent-child-1.jsonl",
    status: "running",
    runtime: "winter-agent",
    model: { effectiveModel: "sonnet", effectiveEffort: "inherit" },
    permission: { effectiveMode: "bypassPermissions", parentPolicyHash: "h1", parentPolicyVersion: 1 },
    ...overrides,
  };
}

// A minimal fake ChildHandle -- `result()` is caller-controlled via an externally resolvable
// promise so a test can decide exactly when the "child" finishes, without racing real timers.
function fakeHandle(result: Promise<ChildResult>, recordOverrides: Partial<ChildSessionRecord> = {}, onStop?: () => void): ChildHandle {
  const record = fakeRecord(recordOverrides);
  return {
    record,
    status: () => record.status,
    async steer() {
      throw new Error("not used by these tests");
    },
    async resume() {
      throw new Error("not used by these tests");
    },
    async result() {
      return result;
    },
    async stop() {
      onStop?.();
    },
  };
}

interface CtxOptions {
  cwd?: string;
  home?: string;
  /** P7a fix wave (item 10, N-1): the SESSION's brand, which is what decides the agents directory this tool reads. */
  brand?: BrandProfile;
  spawnChild?: (req: SpawnChildRequest) => Promise<ChildHandle>;
  /** I4 (fix wave): mirrors ToolExecutionContext.backgroundByDefault -- this session's resolved background-by-default opt-out. */
  backgroundByDefault?: boolean;
}

function makeCtx(opts: CtxOptions = {}): { ctx: ToolExecutionContext; frames: unknown[] } {
  const frames: unknown[] = [];
  const ctx: ToolExecutionContext = {
    cwd: opts.cwd ?? "/tmp/winter-agent-test-cwd",
    home: opts.home ?? "/tmp/winter-agent-test-home-unused",
    sessionId: "test-session",
    readState: createSessionReadState({ cwd: process.cwd() }),
    emitFrame: (f) => {
      frames.push(f);
    },
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-agent-test-temp",
    sandboxSettings: {},
    ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
    ...(opts.backgroundByDefault !== undefined ? { backgroundByDefault: opts.backgroundByDefault } : {}),
    session: {
      setCwd() {},
      addBoundedRoot() {},
      removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => opts.cwd ?? "/tmp/winter-agent-test-cwd",
      setSessionRoot() {},
      ...(opts.spawnChild !== undefined ? { spawnChild: opts.spawnChild } : {}),
    },
  };
  return { ctx, frames };
}

const tempDirs: string[] = [];
function mkTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Agent tool: module wiring", () => {
  test("a real executor replaces the WS-06 stub", () => {
    const registered = getRegisteredTool(AGENT_TOOL_NAME);
    expect(registered?.executor).toBeDefined();
  });
});

describe("Agent tool: input validation (cheap, before any spawn work)", () => {
  test("missing description -> legible error, spawnChild never called", async () => {
    let called = false;
    const { ctx } = makeCtx({ spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ prompt: "do the thing", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("description");
    expect(called).toBe(false);
  });

  test("missing prompt -> legible error, spawnChild never called", async () => {
    let called = false;
    const { ctx } = makeCtx({ spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "task", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("prompt");
    expect(called).toBe(false);
  });

  // Spawn-surface parity (research §A5, gap 8): claude's SILENT remote fallback -- no error, a
  // worktree when the session root is inside git, else a plain local agent.
  test('isolation:"remote" inside a git repository falls back SILENTLY to a worktree', async () => {
    const repo = mkTempDir("winter-agent-test-git-");
    Bun.spawnSync(["git", "init", "-q", repo]);
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({ cwd: repo, spawnChild: async (req) => ((capturedReq = req), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", isolation: "remote", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.isolation).toBe("worktree");
  });

  test('isolation:"remote" outside any git repository falls back SILENTLY to a plain local agent', async () => {
    const plain = mkTempDir("winter-agent-test-nogit-");
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({ cwd: plain, spawnChild: async (req) => ((capturedReq = req), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", isolation: "remote", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq).toBeDefined();
    expect(capturedReq?.isolation).toBeUndefined();
  });

  test("no spawnChild capability configured -> a legible, non-crashing error", async () => {
    const { ctx } = makeCtx({}); // spawnChild omitted entirely
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("no spawnChild capability configured");
  });

  test("unknown subagent_type -> claude's not-found text with the available list, spawnChild never called", async () => {
    let called = false;
    const home = mkTempDir("winter-agent-test-home-");
    const { ctx } = makeCtx({ home, spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "nonexistent", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Agent type 'nonexistent' not found. Available agents: Explore, Plan, claude, general-purpose");
    expect(called).toBe(false);
  });

  test("spawnChild throwing surfaces as a legible isError result, never an uncaught throw", async () => {
    const { ctx } = makeCtx({
      spawnChild: async () => {
        throw new Error("winter: subagent spawn refused -- depth exceeded");
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    // R-S4: claude's shape -- the thrown message itself, no wrapper prefix.
    expect(result.output).toBe("winter: subagent spawn refused -- depth exceeded");
  });
});

describe("Agent tool: subagent_type resolution (filesystem AgentDefinition, WS-10 §2)", () => {
  test("a ~/.winter/agents/*.md definition resolves and is attached to the SpawnChildRequest", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews code\ntools: [Read, Grep]\n---\nYou are a careful reviewer.");

    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "reviewed" }));
      },
    });
    const result = await agentExecutor.execute({ description: "review", prompt: "review this diff", subagent_type: "reviewer", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.definition?.description).toBe("reviews code");
    expect(capturedReq?.definition?.tools).toEqual(["Read", "Grep"]);
    expect(capturedReq?.definition?.prompt).toBe("You are a careful reviewer.");
  });

  // Review r2 finding 2: `ctx.onAgentDefinitionRejected` (threaded from engine.ts's shared reporter
  // in production) reaches `loadAgentDefinitions`' own `onReject` from THIS call site -- before this
  // fix, the Agent tool executor passed no `onReject` at all, so a rejected sibling file in the same
  // directory as a valid one vanished with no report anywhere.
  test("a rejected sibling agent file is reported through ctx.onAgentDefinitionRejected, and the valid one still resolves", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: reviews code\n---\nYou are a careful reviewer.");
    writeFileSync(join(home, ".winter", "agents", "broken.md"), "---\ndescription: has no name\n---\nBody.");

    const rejections: Array<{ source: string; filePath: string; reason: string }> = [];
    const { ctx } = makeCtx({
      home,
      spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "reviewed" })),
    });
    const result = await agentExecutor.execute(
      { description: "review", prompt: "review this diff", subagent_type: "reviewer", run_in_background: false },
      { ...ctx, onAgentDefinitionRejected: (r) => rejections.push(r) },
    );
    expect(result.isError).toBeUndefined();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.filePath).toEndWith(join("agents", "broken.md"));
    expect(rejections[0]?.reason).toContain('"name"');
  });

  // --- P7a fix wave (item 10, N-1): the BRANDED directory read ------------------------------------
  //
  // `agent.ts:305` threads `ctx.brand` into `loadAgentDefinitions`, and until now nothing drove the
  // Agent tool under a brand at all -- `makeCtx` never set one. This is the FIFTH site of the r1
  // sweep and the only one whose fix had no test behind it, and it is a real DIRECTORY READ rather
  // than prose: without the thread a branded session's Agent tool looks in `<home>/.winter/agents`,
  // which a reuser's product does not have.
  const ACME: BrandProfile = (() => {
    const resolved = resolveBrand({ productName: "Acme", homeDirName: ".acme", projectDirName: ".acme", instructionsFile: "ACME.md", envPrefix: "ACME_", mcpServerName: "acme", codexOriginator: "acme", tempRootName: "acme", pluginManifestDir: ".acme-plugin", packageName: "acme" });
    if (!resolved.ok) throw new Error(resolved.reason);
    return resolved.brand;
  })();

  test("P7a (N-1): a BRANDED session reads `<home>/.acme/agents`, and a `.winter/agents` definition beside it is invisible", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    // BOTH directories exist and BOTH declare a `reviewer`, with different bodies. A tool that read
    // the wrong one would still resolve a definition -- the whole class of bug here is a read that
    // silently succeeds against the wrong product's directory -- so the DECOY is what makes this
    // test able to fail.
    mkdirSync(join(home, ".acme", "agents"), { recursive: true });
    writeFileSync(join(home, ".acme", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: the ACME reviewer\n---\nAcme body.");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: the WINTER decoy\n---\nWinter body.");

    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      brand: ACME,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "reviewed" }));
      },
    });
    const result = await agentExecutor.execute({ description: "review", prompt: "p", subagent_type: "reviewer", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.definition?.description).toBe("the ACME reviewer");
    expect(capturedReq?.definition?.prompt).toBe("Acme body.");
  });

  test("P7a (N-1): and the MODEL-FACING not-found list is the BRANDED session's own set, never a `.winter/agents` definition", async () => {
    // The other half of the r1 fix, restated for claude's not-found text (spawn-surface parity): the
    // message no longer names a directory at all -- it lists the agents that exist, and that list
    // must come from the branded directory.
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".acme", "agents"), { recursive: true });
    writeFileSync(join(home, ".acme", "agents", "acme-helper.md"), "---\nname: acme-helper\ndescription: acme\n---\nBody.");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "winter-decoy.md"), "---\nname: winter-decoy\ndescription: decoy\n---\nBody.");
    let called = false;
    const { ctx } = makeCtx({ home, brand: ACME, spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "nonexistent", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("acme-helper");
    expect(result.output).not.toContain("winter-decoy");
    expect(result.output).not.toContain(".winter");
    expect(called).toBe(false);
  });

  test(".winter/agents/*.md in the CURRENT (untrusted) workspace does NOT resolve -- resolveWorkspaceTrust() is false", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    const cwd = mkTempDir("winter-agent-test-cwd-");
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "agents", "local-only.md"), "---\nname: local-only\ndescription: project-local\n---\nBody.");

    let called = false;
    const { ctx } = makeCtx({ home, cwd, spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "local-only", run_in_background: false }, ctx);
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toStartWith("Agent type 'local-only' not found.");
  });

  // Whole-branch M11 (fix wave follow-up 6): the trust verdict is no longer a second hardcoded
  // constant inside subagents/policy.ts -- it is the SESSION's own, threaded from engine.ts's single
  // `const trustedWorkspace` onto every ToolExecutionContext. This is the positive counterpart of the
  // test above: the identical fixture resolves once the session says the workspace is trusted, which
  // is what proves the value is CONSUMED rather than re-derived.
  test("M11: the same .winter/agents/*.md DOES resolve when the SESSION's own trust verdict says so", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    const cwd = mkTempDir("winter-agent-test-cwd-");
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "agents", "local-only.md"), "---\nname: local-only\ndescription: project-local\n---\nBody.");

    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      cwd,
      spawnChild: async (req) => ((capturedReq = req), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))),
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "local-only", run_in_background: false }, { ...ctx, trustedWorkspace: true });
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.definition?.description).toBe("project-local");
  });
});

// SDK 0.0.16 Lane N: `run_in_background: false` is now EXPLICIT throughout this file -- the DEFAULT is
// background (as in claude), so a test that means "the foreground shape" has to say so. Each call here
// therefore names the shape it is testing instead of inheriting it.
describe("Agent tool: foreground spawn (run_in_background: false)", () => {
  test("a completed child maps to the WS-10 §1.4 result shape, keyed on the REAL prompt text", async () => {
    const { ctx } = makeCtx({
      spawnChild: async () =>
        fakeHandle(Promise.resolve({ status: "completed", content: "the answer", resolvedModel: "claude-sonnet-4-5", totalToolUseCount: 3, totalDurationMs: 250 })),
    });
    const result = await agentExecutor.execute({ description: "short label", prompt: "what is 2+2", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({
      agentId: "child-1",
      // Spawn-surface parity (research §A7): an omitted subagent_type IS general-purpose.
      agentType: "general-purpose",
      content: [{ type: "text", text: "the answer" }],
      totalToolUseCount: 3,
      totalDurationMs: 250,
      resolvedModel: "claude-sonnet-4-5",
      prompt: "what is 2+2",
    });
  });

  test("agentType is the RESOLVED type (the definition's own key)", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "explorer.md"), "---\nname: explorer\ndescription: explores\n---\nBody.");
    const { ctx } = makeCtx({ home, spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "done" })) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "explorer", run_in_background: false }, ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.agentType).toBe("explorer");
  });

  test("a failed child surfaces as Error: subagent <id> failed: <content>, isError:true", async () => {
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(Promise.resolve({ status: "failed", content: "boom: model returned an error" })) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Error: subagent child-1 failed: boom: model returned an error");
  });

  test("a stopped child surfaces the SAME error shape, never treated as success", async () => {
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(Promise.resolve({ status: "stopped", content: "stopped by request" })) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Error: subagent child-1 stopped: stopped by request");
  });

  test("model/isolation:worktree/name pass through to the SpawnChildRequest untouched", async () => {
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "x" }));
      },
    });
    await agentExecutor.execute({ description: "d", prompt: "p", model: "opus", isolation: "worktree", name: "helper", run_in_background: false }, ctx);
    expect(capturedReq?.model).toBe("opus");
    expect(capturedReq?.isolation).toBe("worktree");
    expect(capturedReq?.name).toBe("helper");
    expect(capturedReq?.runInBackground).toBe(false);
  });

  test("deprecated team_name/mode are accepted without error and influence nothing", async () => {
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "x" }));
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", team_name: "ignored", mode: "plan", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.runInBackground).toBe(false);
  });

  test("every spawn gets its own fresh synthetic parentToolUseId (Disclosed Gap #4)", async () => {
    const seen: string[] = [];
    const { ctx } = makeCtx({
      spawnChild: async (req) => {
        seen.push(req.parentToolUseId);
        return fakeHandle(Promise.resolve({ status: "completed", content: "x" }));
      },
    });
    await agentExecutor.execute({ description: "d", prompt: "p1", run_in_background: false }, ctx);
    await agentExecutor.execute({ description: "d", prompt: "p2", run_in_background: false }, ctx);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]!.length).toBeGreaterThan(10);
  });
});

// ================================================================================================
// Task-frames parity (2026-09-17 contract §4): foreground registration/termination, progress, and
// the corrected "foreground terminates through the SAME updateTask door as background" rule.
// ================================================================================================
describe("Agent tool: task-frames parity -- foreground registration and termination", () => {
  let paths: SessionTempDirPaths;
  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    const dir = mkTempDir("winter-agent-test-fg-frames-");
    paths = { root: dir, scratchpad: join(dir, "scratchpad"), tasks: join(dir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  test("registers task_started with is_backgrounded:false, task_type:local_agent, spawn_depth, tool_use_id -- and NO background_tasks_changed", async () => {
    const { ctx, frames } = makeCtx({
      spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "done" }), { spawnDepth: 1 }),
    });
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(frames.some((f) => (f as { subtype: string }).subtype === "background_tasks_changed")).toBe(false);
    const started = frames.find((f) => (f as { subtype: string }).subtype === "task_started") as {
      is_backgrounded: boolean;
      task_type: string;
      spawn_depth?: number;
      tool_use_id?: string;
      description: string;
    };
    expect(started).toBeDefined();
    expect(started.is_backgrounded).toBe(false);
    expect(started.task_type).toBe("local_agent");
    expect(started.spawn_depth).toBe(1);
    expect(typeof started.tool_use_id).toBe("string");
    expect(started.description).toBe("d");
  });

  test("CORRECTED: foreground success terminates through updateTask (task_updated then task_notification), never a remove -- output_file is the REAL path, summary is the child's final text", async () => {
    const { ctx, frames } = makeCtx({
      spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "the child's final report", usage: { totalTokens: 42, toolUses: 2, durationMs: 500 } })),
    });
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);

    const started = frames.find((f) => (f as { subtype: string }).subtype === "task_started") as { task_id: string };
    const updated = frames.find((f) => (f as { subtype: string }).subtype === "task_updated") as { task_id: string; patch: { status?: string; end_time?: number } };
    const notif = frames.find((f) => (f as { subtype: string }).subtype === "task_notification") as {
      task_id: string;
      status: string;
      output_file: string;
      summary: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    };
    expect(updated).toBeDefined();
    expect(updated.task_id).toBe(started.task_id);
    expect(updated.patch.status).toBe("completed");
    expect(typeof updated.patch.end_time).toBe("number");
    expect(notif).toBeDefined();
    expect(notif.task_id).toBe(started.task_id);
    expect(notif.status).toBe("completed");
    expect(notif.output_file).not.toBe(""); // the REAL output path, not bash's foreground "" convention
    expect(notif.output_file.length).toBeGreaterThan(0);
    expect(notif.summary).toBe("the child's final report");
    expect(notif.usage).toEqual({ total_tokens: 42, tool_uses: 2, duration_ms: 500 });
    // Ordering: task_started, task_updated, task_notification -- never a second background_tasks_changed.
    expect(frames.filter((f) => (f as { subtype: string }).subtype === "background_tasks_changed")).toHaveLength(0);
  });

  test("foreground failure: task_updated {status:failed, error} then task_notification {status:failed, usage}", async () => {
    const { ctx, frames } = makeCtx({
      spawnChild: async () => fakeHandle(Promise.resolve({ status: "failed", content: "boom: model returned an error", usage: { totalTokens: 5, toolUses: 0, durationMs: 10 } })),
    });
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);

    const updated = frames.find((f) => (f as { subtype: string }).subtype === "task_updated") as { patch: { status?: string; error?: string } };
    expect(updated.patch.status).toBe("failed");
    expect(updated.patch.error).toBe("boom: model returned an error");
    const notif = frames.find((f) => (f as { subtype: string }).subtype === "task_notification") as { status: string; summary: string; usage?: unknown };
    expect(notif.status).toBe("failed");
    expect(notif.summary).toBe("boom: model returned an error");
    expect(notif.usage).toEqual({ total_tokens: 5, tool_uses: 0, duration_ms: 10 });
  });

  test("foreground stopped: task_updated {status:killed} then task_notification {status:stopped}", async () => {
    const { ctx, frames } = makeCtx({
      spawnChild: async () => fakeHandle(Promise.resolve({ status: "stopped", content: "stopped by request" })),
    });
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);

    const updated = frames.find((f) => (f as { subtype: string }).subtype === "task_updated") as { patch: { status?: string } };
    expect(updated.patch.status).toBe("killed"); // §1: Winter's internal "stopped" patches as "killed"
    const notif = frames.find((f) => (f as { subtype: string }).subtype === "task_notification") as { status: string };
    expect(notif.status).toBe("stopped"); // ...and notifies as "stopped"
  });

  test("task_progress: onProgress fires the pinned shape, correlated on the parent's own tool_use id", async () => {
    let resolveResult!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResult = resolve;
    });
    let capturedOnProgress: ((p: ChildTaskProgress) => void) | undefined;
    const { ctx, frames } = makeCtx({
      spawnChild: async (req) => {
        capturedOnProgress = req.onProgress;
        return fakeHandle(resultPromise);
      },
    });
    const execPromise = agentExecutor.execute({ description: "explore the repo", prompt: "p", subagent_type: undefined, run_in_background: false }, ctx);
    await new Promise((r) => setTimeout(r, 10)); // let registration (and thus taskId assignment) land before onProgress fires
    expect(capturedOnProgress).toBeDefined();
    capturedOnProgress!({ toolUses: 3, totalTokens: 111, durationMs: 250, lastToolName: "Grep" });

    const progress = frames.find((f) => (f as { subtype: string }).subtype === "task_progress") as {
      description: string;
      usage: { total_tokens: number; tool_uses: number; duration_ms: number };
      last_tool_name: string;
      tool_use_id?: string;
    };
    expect(progress).toBeDefined();
    expect(progress.description).toBe("explore the repo");
    expect(progress.usage).toEqual({ total_tokens: 111, tool_uses: 3, duration_ms: 250 });
    expect(progress.last_tool_name).toBe("Grep");
    expect(typeof progress.tool_use_id).toBe("string");

    resolveResult({ status: "completed", content: "done" });
    await execPromise;
  });

  test("background_tasks_changed never lists a running FOREGROUND agent row, even while a background task is announced", async () => {
    // The bug §7 names directly: "today a running foreground agent is listed whenever anything else
    // triggers the frame." A foreground agent held open (never resolving) plus a SEPARATE background
    // agent starting is exactly the scenario that would leak it.
    const { ctx: fgCtx } = makeCtx({ spawnChild: async () => fakeHandle(new Promise(() => {})) }); // never resolves
    void agentExecutor.execute({ description: "hanging foreground", prompt: "p", run_in_background: false }, fgCtx);
    await new Promise((r) => setTimeout(r, 10)); // let the foreground registration land

    const { ctx: bgCtx, frames: bgFrames } = makeCtx({ spawnChild: async () => fakeHandle(new Promise(() => {})) });
    await agentExecutor.execute({ description: "background sibling", prompt: "p", run_in_background: true }, bgCtx);

    const changed = bgFrames.find((f) => (f as { subtype: string }).subtype === "background_tasks_changed") as { tasks: Array<{ task_id: string; description: string }> };
    expect(changed).toBeDefined();
    expect(changed.tasks.some((t) => t.description === "hanging foreground")).toBe(false);
    expect(changed.tasks.filter((t) => t.description === "background sibling")).toHaveLength(1); // listed exactly once
  });
});

describe("Agent tool: background setup failure never orphans an already-spawned child", () => {
  test("createBackgroundTask throwing (root never configured) stops the already-running child and returns a legible error", async () => {
    resetBackgroundTaskRootForTest(); // deliberately NOT configureBackgroundTaskRoot -- createBackgroundTask("agent") throws
    let stopped = false;
    const { ctx } = makeCtx({
      spawnChild: async () => fakeHandle(new Promise(() => {}), {}, () => (stopped = true)),
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: true }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("child-1");
    expect(result.output).toContain("orphan");
    expect(stopped).toBe(true);
  });
});

describe("Agent tool: background spawn (run_in_background:true, WS-06 §3.5 / WS-12 §7)", () => {
  let paths: SessionTempDirPaths;

  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    const dir = mkTempDir("winter-agent-test-bgtask-");
    paths = { root: dir, scratchpad: join(dir, "scratchpad"), tasks: join(dir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  // SDK 0.0.16 Lane N: the DEFAULT, which is the whole point of the flip.
  test("run_in_background OMITTED now launches in the background -- claude's own default", async () => {
    const requests: SpawnChildRequest[] = [];
    const { ctx } = makeCtx({
      spawnChild: async (req) => {
        requests.push(req);
        return fakeHandle(new Promise<ChildResult>(() => {}));
      },
    });
    const result = await agentExecutor.execute({ description: "unflagged", prompt: "p" }, ctx);
    expect(JSON.parse(result.output).status).toBe("async_launched");
    expect(requests[0]?.runInBackground).toBe(true);
  });

  test("the host kill switch restores the old foreground default wholesale", async () => {
    const requests: SpawnChildRequest[] = [];
    const { ctx } = makeCtx({
      spawnChild: async (req) => {
        requests.push(req);
        return fakeHandle(Promise.resolve({ status: "completed", content: "the answer" }));
      },
    });
    const result = await agentExecutor.execute({ description: "unflagged", prompt: "p" }, { ...ctx, env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" } });
    expect(JSON.parse(result.output).content).toEqual([{ type: "text", text: "the answer" }]);
    expect(requests[0]?.runInBackground).toBe(false);
  });

  test("returns async_launched immediately, without awaiting the child's own result()", async () => {
    let resolveResult!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResult = resolve;
    });
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(resultPromise) });

    const started = Date.now();
    const result = await agentExecutor.execute({ description: "long task", prompt: "p", run_in_background: true }, ctx);
    expect(Date.now() - started).toBeLessThan(500); // never blocked on the still-pending result()
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe("async_launched");
    expect(parsed.agentId).toBe("child-1");
    expect(typeof parsed.taskId).toBe("string");
    expect(parsed.outputFile).toContain(parsed.taskId);

    resolveResult({ status: "completed", content: "done later" }); // let the background chain settle before the test ends
    await new Promise((r) => setTimeout(r, 20));
  });

  test("emits task_started + background_tasks_changed synchronously, then task_updated + task_notification + background_tasks_changed once the child settles", async () => {
    let resolveResult!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResult = resolve;
    });
    const { ctx, frames } = makeCtx({ spawnChild: async () => fakeHandle(resultPromise) });

    const result = await agentExecutor.execute({ description: "long task", prompt: "p", run_in_background: true }, ctx);
    const { taskId } = JSON.parse(result.output) as { taskId: string };

    expect(frames.length).toBe(2);
    expect((frames[0] as { subtype: string }).subtype).toBe("task_started");
    expect((frames[0] as { task_id: string }).task_id).toBe(taskId);
    expect((frames[0] as { is_backgrounded: boolean }).is_backgrounded).toBe(true);
    // Task-frames parity: the pinned wire spelling is `local_agent`, never the internal kind "agent".
    expect((frames[0] as { task_type: string }).task_type).toBe("local_agent");
    expect((frames[1] as { subtype: string; tasks: unknown[] }).subtype).toBe("background_tasks_changed");
    expect((frames[1] as { tasks: Array<{ task_id: string; task_type: string; description: string }> }).tasks).toContainEqual({
      task_id: taskId,
      task_type: "local_agent",
      description: "long task",
    });

    resolveResult({ status: "completed", content: "done later" });
    await new Promise((r) => setTimeout(r, 20));

    // Task-frames parity (contract §1/§4): the terminal transition now goes through the registry's
    // ONE update door -- task_updated {status, end_time} lands BEFORE task_notification, same
    // synchronous call.
    expect(frames.length).toBe(5);
    expect((frames[2] as { subtype: string; patch: { status?: string } }).subtype).toBe("task_updated");
    expect((frames[2] as { patch: { status?: string } }).patch.status).toBe("completed");
    expect((frames[3] as { subtype: string; status: string }).subtype).toBe("task_notification");
    expect((frames[3] as { status: string }).status).toBe("completed");
    expect((frames[3] as { output_file: string }).output_file).toContain(taskId);
    expect((frames[3] as { usage?: { total_tokens: number; tool_uses: number; duration_ms: number } }).usage).toBeUndefined(); // fakeHandle's ChildResult carries no usage
    expect((frames[4] as { subtype: string; tasks: unknown[] }).subtype).toBe("background_tasks_changed");
    // The agent task is no longer reported once settled -- listRunningTasks excludes a terminal row.
    expect((frames[4] as { tasks: Array<{ task_id: string }> }).tasks.find((t) => t.task_id === taskId)).toBeUndefined();
  });

  test("writes a stub .output file naming the durable transcript, never a growing copy (WS-12 §7.2)", async () => {
    let resolveResult!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResult = resolve;
    });
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(resultPromise, { transcript: "proj/parent-1/subagents/agent-child-1.jsonl" }) });

    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: true }, ctx);
    const { outputFile } = JSON.parse(result.output) as { outputFile: string };
    expect(existsSync(outputFile)).toBe(true);
    const initial = readFileSync(outputFile, "utf8");
    expect(initial).toContain("proj/parent-1/subagents/agent-child-1.jsonl");
    expect(initial).toContain("child-1");

    resolveResult({ status: "failed", content: "it broke" });
    await new Promise((r) => setTimeout(r, 20));

    const after = readFileSync(outputFile, "utf8");
    expect(after.startsWith(initial)).toBe(true); // appended, never rewritten
    expect(after).toContain("failed");
  });

  test("AgentDefinition.background:true forces background even with run_in_background omitted", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "bg-forced.md"), "---\nname: bg-forced\ndescription: always background\nbackground: true\n---\nBody.");
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(new Promise(() => {})); // never resolves within this test -- proves we did NOT await it
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "bg-forced", run_in_background: false }, ctx);
    expect(capturedReq?.runInBackground).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe("async_launched");
  });

  // I4 (fix wave): ctx.backgroundByDefault is this session's resolved opt-out, threaded straight
  // into resolveForegroundBackground's own stage 5 -- an OMITTED run_in_background follows it.
  test("ctx.backgroundByDefault: false restores the foreground default for an omitted run_in_background", async () => {
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      backgroundByDefault: false,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "done", resolvedModel: "m", totalToolUseCount: 0, totalDurationMs: 1 }));
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, ctx);
    expect(capturedReq?.runInBackground).toBe(false);
    const parsed = JSON.parse(result.output);
    // A foreground result is the WS-10 §1.4 shape, never the async_launched envelope.
    expect(parsed.status).not.toBe("async_launched");
  });

  test("ctx.backgroundByDefault: false is still overridden by an explicit run_in_background: true", async () => {
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      backgroundByDefault: false,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(new Promise(() => {})); // never resolves within this test -- proves we did NOT await it
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: true }, ctx);
    expect(capturedReq?.runInBackground).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe("async_launched");
  });
});

// ================================================================================================
// Phase 4 Task 8 (rider 24): TaskStop / TaskOutput reach a BACKGROUND AGENT task.
// ================================================================================================
//
// Lane C disclosed the asymmetry: an agent task allocated a task id through the SPINE seam
// (createBackgroundTask("agent")) but could not be tracked in background-task-runtime.ts's registry,
// which is the entire implementation of TaskStop and TaskOutput -- so neither tool could ever reach
// one. The mechanical blocker was that registry's own narrower BackgroundTaskKind union.
describe("rider 24: a background agent task is reachable through the unified task namespace", () => {
  // Same fixture setup as the background-spawn describe above -- createBackgroundTask("agent")
  // throws without a configured root, which is exactly what a bare JSON.parse of the error string
  // would surface as an unhelpful syntax error.
  let paths: SessionTempDirPaths;
  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    const dir = mkTempDir("winter-agent-test-rider24-");
    paths = { root: dir, scratchpad: join(dir, "scratchpad"), tasks: join(dir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  test("the spawned task is registered with kind 'agent' and a stop callback, and TaskStop genuinely aborts the child", async () => {
    let stopped = false;
    let resolveResult!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResult = resolve;
    });
    const handle = fakeHandle(resultPromise);
    // A child is an in-process runEngine loop (RULING R4-4), so there is no OS process and no pid --
    // the registry's generic `stop` callback is the whole mechanism, and this proves it is wired to
    // the REAL handle rather than merely marking a row.
    handle.stop = async () => {
      stopped = true;
      resolveResult({ status: "stopped", content: "stopped by request" });
    };
    const { ctx } = makeCtx({ spawnChild: async () => handle });

    const launched = JSON.parse((await agentExecutor.execute({ description: "bg", prompt: "p", run_in_background: true }, ctx)).output) as { taskId: string };
    const tracked = getTask(launched.taskId);
    expect(tracked, "the agent task must be visible to the registry TaskStop/TaskOutput are built on").toBeDefined();
    expect(tracked!.kind).toBe("agent");
    expect(tracked!.pid).toBeUndefined(); // never a fabricated pid for a process that does not exist
    expect(tracked!.status).toBe("running");

    // Through the REAL TaskStop executor, by task id -- not by calling the callback directly.
    const stopResult = await taskStopExecutor.execute({ task_id: launched.taskId }, ctx);
    expect(stopResult.isError).toBeUndefined();
    expect(stopped, "TaskStop must reach the child's own stop()").toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    // The registry reflects the child's own terminal status, so listRunningTasks stops reporting it.
    expect(getTask(launched.taskId)?.status).not.toBe("running");
  });

  test("TaskOutput reads the agent task's .output stub by task id", async () => {
    let resolveResult!: (r: ChildResult) => void;
    const resultPromise = new Promise<ChildResult>((resolve) => {
      resolveResult = resolve;
    });
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(resultPromise) });
    const launched = JSON.parse((await agentExecutor.execute({ description: "bg", prompt: "p", run_in_background: true }, ctx)).output) as { taskId: string };
    const out = await taskOutputExecutor.execute({ task_id: launched.taskId, block: false, timeout: 0 }, ctx);
    // The stub's own CONTENT is what matters here -- it names the durable transcript, per WS-12
    // §7.2's "expose a small generated reference/stub and return the durable transcript path". Note
    // deliberately NOT asserting `isError` is unset: TaskOutput reports a still-RUNNING task through
    // its own status channel, which is orthogonal to whether the stub was readable.
    expect(out.output).toContain("Background agent task");
    resolveResult({ status: "completed", content: "done" });
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ================================================================================================
// Spawn-surface parity (lane L2b): name resolution, omitted type, fork gate, launch result.
// ================================================================================================
describe("Agent tool: spawn-surface parity (research §A4/§A7/§A8, R-S5)", () => {
  let paths: SessionTempDirPaths;
  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    const dir = mkTempDir("winter-agent-test-l2b-");
    paths = { root: dir, scratchpad: join(dir, "scratchpad"), tasks: join(dir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  function capturing(): { ctx: ToolExecutionContext; frames: unknown[]; reqs: SpawnChildRequest[] } {
    const reqs: SpawnChildRequest[] = [];
    const home = mkTempDir("winter-agent-test-home-");
    const { ctx, frames } = makeCtx({ home, spawnChild: async (req) => (reqs.push(req), fakeHandle(Promise.resolve({ status: "completed", content: "ok" }))) });
    return { ctx, frames, reqs };
  }

  for (const guess of ["general", "explorer"]) {
    test(`"${guess}" does NOT resolve (normalization is not prefix matching): claude's not-found text with the list`, async () => {
      const { ctx, reqs } = capturing();
      const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: guess, run_in_background: false }, ctx);
      expect(result).toEqual({ output: `Agent type '${guess}' not found. Available agents: Explore, Plan, claude, general-purpose`, isError: true });
      expect(reqs).toHaveLength(0);
    });
  }

  test('"explore" resolves to the Explore built-in, and the frames carry the RESOLVED name', async () => {
    const { ctx, frames, reqs } = capturing();
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "explore", run_in_background: false }, ctx);
    expect(result.isError).toBeUndefined();
    expect(reqs[0]?.definition?.omitProjectContext).toBe(true);
    expect((frames.find((f) => (f as { subtype: string }).subtype === "task_started") as { subagent_type?: string }).subagent_type).toBe("Explore");
    expect(JSON.parse(result.output).agentType).toBe("Explore");
  });

  test("an ambiguous normalized name refuses with the exact names", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    const { ctx } = makeCtx({ home, spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "x" })) });
    const agents = { "my-helper": { description: "a", prompt: "a" }, my_helper: { description: "b", prompt: "b" } };
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "MyHelper", run_in_background: false }, { ...ctx, agents });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Agent type 'MyHelper' is ambiguous — matches my-helper, my_helper. Use the exact name: my-helper or my_helper.");
  });

  test("omitted subagent_type -> the general-purpose definition, and every frame says so", async () => {
    const { ctx, frames, reqs } = capturing();
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(reqs[0]?.definition?.tools).toEqual(["*"]);
    const withType = frames.filter((f) => ["task_started", "task_progress"].includes((f as { subtype: string }).subtype));
    expect(withType.length).toBeGreaterThan(0);
    for (const f of withType) expect((f as { subagent_type?: string }).subagent_type).toBe("general-purpose");
  });

  test("omitted subagent_type with every built-in disabled -> the required-type refusal naming the available agents", async () => {
    const { ctx, reqs } = capturing();
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, { ...ctx, env: { WINTER_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" } });
    expect(result).toEqual({ output: "subagent_type is required: the general-purpose agent is not available in this session. Available agents: none", isError: true });
    expect(reqs).toHaveLength(0);
  });

  test("fork gate OFF: subagent_type 'fork' is an unknown agent", async () => {
    const { ctx, reqs } = capturing();
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "fork", run_in_background: false }, { ...ctx, forkSubagentEnabled: false });
    expect(result.isError).toBe(true);
    expect(result.output).toStartWith("Agent type 'fork' not found.");
    expect(reqs).toHaveLength(0);
  });

  test("fork gate ON: 'fork' sets SpawnChildRequest.fork, uses the fork definition, and IGNORES model", async () => {
    const { ctx, reqs } = capturing();
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "fork", model: "opus", run_in_background: false }, { ...ctx, forkSubagentEnabled: true, env: {} });
    expect(result.isError).toBeUndefined();
    expect(reqs[0]?.fork).toBe(true);
    expect(reqs[0]?.model).toBeUndefined();
    expect(reqs[0]?.definition?.maxTurns).toBe(200);
  });

  test("fork gate ON via the session env fallback when the ctx carries no resolved gate", async () => {
    const { ctx, reqs } = capturing();
    await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "fork", run_in_background: false }, { ...ctx, env: { WINTER_FORK_SUBAGENT: "1" } });
    expect(reqs[0]?.fork).toBe(true);
  });

  // Review r2 finding 8: `isFork` used to be decided from the RAW `subagent_type` string
  // (`requestedType === "fork"`), before `findAgentByType`'s own case-insensitive normalization ran
  // -- so a differently-cased request resolved to the SAME fork definition (tools: ["*"], the
  // placeholder prompt) while every fork-specific behavior (the two refusals, ignoring `model`,
  // `SpawnChildRequest.fork`) silently did not apply, because the string comparison had already
  // failed. "fork" and "Fork" must behave identically.
  test.each(["fork", "Fork"])("fork gate ON: subagent_type %p resolves to the fork definition byte-identically to 'fork'", async (requestedType) => {
    const { ctx, reqs } = capturing();
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: requestedType, model: "opus", run_in_background: false }, { ...ctx, forkSubagentEnabled: true, env: {} });
    expect(result.isError).toBeUndefined();
    expect(reqs[0]?.fork).toBe(true);
    expect(reqs[0]?.model).toBeUndefined();
    expect(reqs[0]?.definition?.maxTurns).toBe(200);
  });

  test.each(["fork", "Fork"])("fork refusals fire for subagent_type %p (case must not bypass them)", async (requestedType) => {
    const { ctx, reqs } = capturing();
    const inside = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: requestedType, run_in_background: false }, { ...ctx, forkSubagentEnabled: true, insideFork: true });
    expect(inside).toEqual({ output: "Fork is not available inside a forked worker. Complete your task directly using your tools.", isError: true });
    const remote = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: requestedType, isolation: "remote", run_in_background: false }, { ...ctx, forkSubagentEnabled: true });
    expect(remote.isError).toBe(true);
    expect(remote.output).toStartWith('Fork cannot use isolation: "remote" — ');
    expect(reqs).toHaveLength(0);
  });

  test("fork refusals: a fork inside a fork, and a fork with isolation:remote -- claude's wording, nothing spawned", async () => {
    const { ctx, reqs } = capturing();
    const inside = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "fork", run_in_background: false }, { ...ctx, forkSubagentEnabled: true, insideFork: true });
    expect(inside).toEqual({ output: "Fork is not available inside a forked worker. Complete your task directly using your tools.", isError: true });
    const remote = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "fork", isolation: "remote", run_in_background: false }, { ...ctx, forkSubagentEnabled: true });
    expect(remote.isError).toBe(true);
    expect(remote.output).toStartWith('Fork cannot use isolation: "remote" — ');
    expect(reqs).toHaveLength(0);
  });

  test("the web-fetch built-in ignores isolation (gate on)", async () => {
    const { ctx, reqs } = capturing();
    await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "web-fetch", isolation: "worktree", run_in_background: false }, { ...ctx, env: { WINTER_WEB_FETCH_AGENT: "1" } });
    expect(reqs[0]?.isolation).toBeUndefined();
  });

  test("background launch result: claude's shape + Winter-worded guidance (notification, no predicting, no mid-run reads, SendMessage)", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    const { ctx } = makeCtx({ home, spawnChild: async () => fakeHandle(new Promise(() => {})) });
    const result = await agentExecutor.execute({ description: "scan repo", prompt: "look around", run_in_background: true }, { ...ctx, advertisedToolNames: () => ["Read", "Agent"] });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["agentId", "canReadOutputFile", "description", "message", "outputFile", "prompt", "status", "taskId"]);
    expect(parsed).toMatchObject({ status: "async_launched", agentId: "child-1", description: "scan repo", prompt: "look around", canReadOutputFile: true });
    const message = parsed["message"] as string;
    expect(message).toContain('SendMessage with to: "child-1"');
    expect(message).toContain("notified automatically when it finishes");
    expect(message).toContain("Do not guess at or describe its results");
    expect(message).toContain(`Do not read or tail that file while the agent is still running`);
    expect(message).toContain(String(parsed["outputFile"]));

    const noRead = await agentExecutor.execute({ description: "scan", prompt: "p", run_in_background: true }, { ...ctx, advertisedToolNames: () => ["Agent"] });
    const parsedNoRead = JSON.parse(noRead.output) as { canReadOutputFile: boolean; message: string };
    expect(parsedNoRead.canReadOutputFile).toBe(false);
    expect(parsedNoRead.message).toContain("Briefly tell the user what you launched");
    expect(parsedNoRead.message).not.toContain("Do not read or tail");
  });
});

// ================================================================================================
// Review r1 findings 3, 4, 6, 9, 12 and contract §8 at the Agent tool's own seam.
// ================================================================================================
describe("Agent tool: review r1 regressions", () => {
  let paths: SessionTempDirPaths;
  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    const dir = mkTempDir("winter-agent-test-r1-");
    paths = { root: dir, scratchpad: join(dir, "scratchpad"), tasks: join(dir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });
  const subtypes = (frames: unknown[]): string[] => frames.map((f) => (f as { subtype: string }).subtype);

  test("finding 9: task_started is emitted from onSpawned -- BEFORE spawnChild resolves, so nothing the child produces can precede it", async () => {
    let framesAtSpawnReturn: string[] = [];
    const { ctx, frames } = makeCtx({
      spawnChild: async (req) => {
        const handle = fakeHandle(Promise.resolve({ status: "completed", content: "x" }));
        req.onSpawned?.(handle);
        req.onProgress?.({ toolUses: 1, totalTokens: 1, durationMs: 1, lastToolName: "Glob" });
        framesAtSpawnReturn = subtypes(frames);
        return handle;
      },
    });
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    expect(framesAtSpawnReturn).toEqual(["task_started", "task_progress"]);
    expect(subtypes(frames).filter((s) => s === "task_started")).toHaveLength(1); // the post-spawn fallback is a no-op
  });

  test("finding 3: a progress callback after the task's notification (a resumed child, a late buffered frame) emits nothing", async () => {
    let onProgress: ((p: ChildTaskProgress) => void) | undefined;
    const { ctx, frames } = makeCtx({ spawnChild: async (req) => ((onProgress = req.onProgress), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, ctx);
    const before = frames.length;
    onProgress!({ toolUses: 9, totalTokens: 9, durationMs: 9, lastToolName: "Read" });
    expect(frames).toHaveLength(before);
  });

  test("§8: task_progress.description is the progress activity when present, else the task description", async () => {
    let onProgress: ((p: ChildTaskProgress) => void) | undefined;
    let finish!: (r: ChildResult) => void;
    const { ctx, frames } = makeCtx({ spawnChild: async (req) => ((onProgress = req.onProgress), fakeHandle(new Promise((r) => (finish = r)))) });
    const running = agentExecutor.execute({ description: "child probe", prompt: "p", run_in_background: false }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    onProgress!({ toolUses: 1, totalTokens: 1, durationMs: 1, lastToolName: "Bash", activity: "Running echo hi" });
    onProgress!({ toolUses: 2, totalTokens: 2, durationMs: 2, lastToolName: "TodoWrite" });
    finish({ status: "completed", content: "done" });
    await running;
    const progress = frames.filter((f) => (f as { subtype: string }).subtype === "task_progress") as Array<{ description: string }>;
    expect(progress.map((p) => p.description)).toEqual(["Running echo hi", "child probe"]);
  });

  test("finding 4 + 13: TaskStop on a BACKGROUND agent reports the child's live usage and the same summary a parent abort does -- one task_updated, one notification, even after the child settles", async () => {
    let settle!: (r: ChildResult) => void;
    const handle = fakeHandle(new Promise((r) => (settle = r)));
    handle.usage = () => ({ totalTokens: 77, toolUses: 3, durationMs: 40 });
    handle.stop = async () => settle({ status: "stopped", content: "stopped by request", usage: { totalTokens: 77, toolUses: 3, durationMs: 41 } });
    const { ctx, frames } = makeCtx({ spawnChild: async () => handle });
    const { taskId } = JSON.parse((await agentExecutor.execute({ description: "bg", prompt: "p", run_in_background: true }, ctx)).output) as { taskId: string };
    await taskStopExecutor.execute({ task_id: taskId }, ctx);
    await new Promise((r) => setTimeout(r, 20)); // the child's own settle -> result() chain runs
    const own = frames.filter((f) => (f as { task_id?: string }).task_id === taskId);
    expect(subtypes(own)).toEqual(["task_started", "task_updated", "task_notification"]);
    expect(own[2]).toMatchObject({ status: "stopped", summary: "stopped by request", usage: { total_tokens: 77, tool_uses: 3, duration_ms: 40 } });
  });

  test("finding 6 + 13: TaskStop on a FOREGROUND agent -- exactly one task_updated and one notification in TOTAL, no stray end_time after it", async () => {
    let settle!: (r: ChildResult) => void;
    const handle = fakeHandle(new Promise((r) => (settle = r)));
    handle.stop = async () => settle({ status: "stopped", content: "stopped by request" });
    const { ctx, frames } = makeCtx({ spawnChild: async () => handle });
    const running = agentExecutor.execute({ description: "fg", prompt: "p", run_in_background: false }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    const taskId = (frames.find((f) => (f as { subtype: string }).subtype === "task_started") as { task_id: string }).task_id;
    await taskStopExecutor.execute({ task_id: taskId }, ctx);
    const result = await running;
    expect(result.isError).toBe(true);
    expect(subtypes(frames)).toEqual(["task_started", "task_updated", "task_notification"]);
  });

  test("finding 12: a registration that throws after the row exists leaves no running row behind (foreground degrades, the call still returns)", async () => {
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "fine" })) });
    const throwing: ToolExecutionContext = {
      ...ctx,
      emitFrame: () => {
        throw new Error("torn down");
      },
    };
    const result = await agentExecutor.execute({ description: "d", prompt: "p", run_in_background: false }, throwing);
    expect(result.isError).toBeUndefined();
    expect(listRunningTasks()).toHaveLength(0);
    const { listTasks } = await import("./background-task-runtime.ts");
    expect(listTasks()).toHaveLength(0);
  });
});

// ================================================================================================
// SDK 0.0.16 Lane P (R3b §4): ctx.agentAvailability -- the seam engine.ts wires from
// permissions/evaluator.ts's findAgentDenyRule + subagents/availability.ts, exercised here
// standalone (constructed by hand, exactly like `forkSubagentEnabled`/`insideFork` above) so this
// file's own resolution-region logic is proven independent of a full engine/query() setup.
// ================================================================================================
describe("Agent tool: agentAvailability (SDK 0.0.16 Lane P, R3b §4)", () => {
  let paths: SessionTempDirPaths;
  beforeEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
    const dir = mkTempDir("winter-agent-test-avail-");
    paths = { root: dir, scratchpad: join(dir, "scratchpad"), tasks: join(dir, "tasks") };
    configureBackgroundTaskRoot(() => paths);
  });
  afterEach(() => {
    resetBackgroundTaskRootForTest();
    resetBackgroundTaskRuntimeForTest();
  });

  function capturing(): { ctx: ToolExecutionContext; reqs: SpawnChildRequest[] } {
    const reqs: SpawnChildRequest[] = [];
    const home = mkTempDir("winter-agent-test-avail-home-");
    const { ctx } = makeCtx({ home, spawnChild: async (req) => (reqs.push(req), fakeHandle(Promise.resolve({ status: "completed", content: "ok" }))) });
    return { ctx, reqs };
  }

  test("a denied type refuses with claude's exact text and never spawns, even when it still resolves by name", async () => {
    const { ctx, reqs } = capturing();
    const avail: NonNullable<ToolExecutionContext["agentAvailability"]> = () => ({
      availableNames: ["Plan", "claude", "general-purpose"],
      unavailableMessage: (t) => (t === "Explore" ? "Agent type 'Explore' has been denied by permission rule 'Agent(Explore)' from sdk." : undefined),
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "Explore" }, { ...ctx, agentAvailability: avail });
    expect(result).toEqual({ output: "Agent type 'Explore' has been denied by permission rule 'Agent(Explore)' from sdk.", isError: true });
    expect(reqs).toHaveLength(0);
  });

  test("Agent(fork) is deniable exactly like any other type -- fork gate ON, but denied", async () => {
    const { ctx, reqs } = capturing();
    const avail: NonNullable<ToolExecutionContext["agentAvailability"]> = () => ({
      availableNames: ["Explore", "Plan", "claude", "general-purpose"],
      unavailableMessage: (t) => (t === "fork" ? "Agent type 'fork' has been denied by permission rule 'Agent(fork)' from user." : undefined),
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "fork" }, { ...ctx, forkSubagentEnabled: true, agentAvailability: avail });
    expect(result).toEqual({ output: "Agent type 'fork' has been denied by permission rule 'Agent(fork)' from user.", isError: true });
    expect(reqs).toHaveLength(0);
  });

  test("a type excluded by allowedAgentTypes reuses the plain not-found shape, listing ONLY the allowed names", async () => {
    const { ctx, reqs } = capturing();
    const avail: NonNullable<ToolExecutionContext["agentAvailability"]> = () => ({
      availableNames: ["Explore", "Plan"],
      unavailableMessage: () => undefined,
    });
    // "claude" genuinely EXISTS (it is a default-on built-in) but is not in the allowed set.
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "claude" }, { ...ctx, agentAvailability: avail });
    expect(result).toEqual({ output: "Agent type 'claude' not found. Available agents: Explore, Plan", isError: true });
    expect(reqs).toHaveLength(0);
  });

  test("omitted subagent_type with general-purpose excluded from availableNames -> the required-type refusal, listing only what IS available", async () => {
    const { ctx, reqs } = capturing();
    const avail: NonNullable<ToolExecutionContext["agentAvailability"]> = () => ({
      availableNames: ["Explore", "Plan", "claude"],
      unavailableMessage: () => undefined,
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, { ...ctx, agentAvailability: avail });
    expect(result).toEqual({ output: "subagent_type is required: the general-purpose agent is not available in this session. Available agents: Explore, Plan, claude", isError: true });
    expect(reqs).toHaveLength(0);
  });

  test("omitted subagent_type WITH general-purpose available -- unaffected by an unrelated restriction", async () => {
    const { ctx, reqs } = capturing();
    const avail: NonNullable<ToolExecutionContext["agentAvailability"]> = () => ({
      availableNames: ["Explore", "general-purpose"],
      unavailableMessage: () => undefined,
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, { ...ctx, agentAvailability: avail });
    expect(result.isError).toBeUndefined();
    expect(reqs[0]?.definition?.tools).toEqual(["*"]);
  });

  test("all-tools-denied: its own exact text, distinct from a per-type deny rule's wording", async () => {
    const { ctx, reqs } = capturing();
    const avail: NonNullable<ToolExecutionContext["agentAvailability"]> = () => ({
      availableNames: ["Explore", "Plan", "general-purpose"],
      unavailableMessage: (t) => (t === "claude" ? "Agent type 'claude' is unavailable because every tool it may use is denied by the current permission settings." : undefined),
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "claude" }, { ...ctx, agentAvailability: avail });
    expect(result).toEqual({ output: "Agent type 'claude' is unavailable because every tool it may use is denied by the current permission settings.", isError: true });
    expect(reqs).toHaveLength(0);
  });

  test("no agentAvailability wired at all -- byte-identical to the pre-existing unrestricted behavior", async () => {
    const { ctx, reqs } = capturing();
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "Explore" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(reqs[0]?.definition?.omitProjectContext).toBe(true);
  });

  test("builtinAgentType is stamped on the request ONLY for a resolved built-in, never a same-named filesystem override", async () => {
    const home = mkTempDir("winter-agent-test-avail-home2-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "explore-override.md"), "---\nname: Explore\ndescription: a user's own Explore\n---\nYou are a custom explorer.");
    const reqs: SpawnChildRequest[] = [];
    const { ctx } = makeCtx({ home, spawnChild: async (req) => (reqs.push(req), fakeHandle(Promise.resolve({ status: "completed", content: "ok" }))) });
    await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "Explore" }, ctx);
    expect(reqs[0]?.builtinAgentType).toBeUndefined();
    expect(reqs[0]?.definition?.description).toBe("a user's own Explore");
  });

  test("builtinAgentType IS stamped for the real built-in Explore", async () => {
    const { ctx, reqs } = capturing();
    await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "Explore" }, ctx);
    expect(reqs[0]?.builtinAgentType).toBe("Explore");
  });
});
