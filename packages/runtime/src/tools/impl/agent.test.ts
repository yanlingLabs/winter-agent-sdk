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
import { getTask } from "./background-task-runtime.ts";
import { taskStopExecutor } from "./task-stop.ts";
import { taskOutputExecutor } from "./task-output.ts";
import { resetBackgroundTaskRuntimeForTest } from "./background-task-runtime.ts";
import type { SessionTempDirPaths } from "../../paths/temp.ts";
import type { ChildHandle, ChildResult, ChildSessionRecord, SpawnChildRequest } from "../../subagents/child-handle.ts";
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
}

function makeCtx(opts: CtxOptions = {}): { ctx: ToolExecutionContext; frames: unknown[] } {
  const frames: unknown[] = [];
  const ctx: ToolExecutionContext = {
    cwd: opts.cwd ?? "/tmp/winter-agent-test-cwd",
    home: opts.home ?? "/tmp/winter-agent-test-home-unused",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: (f) => {
      frames.push(f);
    },
    permissions: { probeReadAccess: () => "silent" },
    tempDir: "/tmp/winter-agent-test-temp",
    sandboxSettings: {},
    ...(opts.brand !== undefined ? { brand: opts.brand } : {}),
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
    const result = await agentExecutor.execute({ prompt: "do the thing" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("description");
    expect(called).toBe(false);
  });

  test("missing prompt -> legible error, spawnChild never called", async () => {
    let called = false;
    const { ctx } = makeCtx({ spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "task" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("prompt");
    expect(called).toBe(false);
  });

  test('isolation:"remote" -> a typed unsupported-capability error (WS-10 §8), spawnChild never called', async () => {
    let called = false;
    const { ctx } = makeCtx({ spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", isolation: "remote" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('isolation:"remote"');
    expect(result.output).toContain("not available");
    expect(called).toBe(false);
  });

  test("no spawnChild capability configured -> a legible, non-crashing error", async () => {
    const { ctx } = makeCtx({}); // spawnChild omitted entirely
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("no spawnChild capability configured");
  });

  test("unknown subagent_type -> a legible error naming what was checked, spawnChild never called", async () => {
    let called = false;
    const home = mkTempDir("winter-agent-test-home-");
    const { ctx } = makeCtx({ home, spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('unknown subagent_type "nonexistent"');
    expect(called).toBe(false);
  });

  test("spawnChild throwing surfaces as a legible isError result, never an uncaught throw", async () => {
    const { ctx } = makeCtx({
      spawnChild: async () => {
        throw new Error("winter: subagent spawn refused -- depth exceeded");
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("subagent spawn failed");
    expect(result.output).toContain("depth exceeded");
  });
});

describe("Agent tool: subagent_type resolution (filesystem AgentDefinition, WS-10 §2)", () => {
  test("a ~/.winter/agents/*.md definition resolves and is attached to the SpawnChildRequest", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\ndescription: reviews code\ntools: [Read, Grep]\n---\nYou are a careful reviewer.");

    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "reviewed" }));
      },
    });
    const result = await agentExecutor.execute({ description: "review", prompt: "review this diff", subagent_type: "reviewer" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.definition?.description).toBe("reviews code");
    expect(capturedReq?.definition?.tools).toEqual(["Read", "Grep"]);
    expect(capturedReq?.definition?.prompt).toBe("You are a careful reviewer.");
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
    writeFileSync(join(home, ".acme", "agents", "reviewer.md"), "---\ndescription: the ACME reviewer\n---\nAcme body.");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "reviewer.md"), "---\ndescription: the WINTER decoy\n---\nWinter body.");

    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      brand: ACME,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(Promise.resolve({ status: "completed", content: "reviewed" }));
      },
    });
    const result = await agentExecutor.execute({ description: "review", prompt: "p", subagent_type: "reviewer" }, ctx);
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.definition?.description).toBe("the ACME reviewer");
    expect(capturedReq?.definition?.prompt).toBe("Acme body.");
  });

  test("P7a (N-1): and the MODEL-FACING message names the branded directory, not `~/.winter/agents`", async () => {
    // The other half of the r1 fix. A message naming a directory the reuser's product does not have
    // teaches the model to look in the wrong place, and it is the half a directory-read assertion
    // alone would never catch.
    const home = mkTempDir("winter-agent-test-home-");
    let called = false;
    const { ctx } = makeCtx({ home, brand: ACME, spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "nonexistent" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(".acme/agents");
    expect(result.output).not.toContain(".winter/agents");
    expect(called).toBe(false);
  });

  test(".winter/agents/*.md in the CURRENT (untrusted) workspace does NOT resolve -- resolveWorkspaceTrust() is false", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    const cwd = mkTempDir("winter-agent-test-cwd-");
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "agents", "local-only.md"), "---\ndescription: project-local\n---\nBody.");

    let called = false;
    const { ctx } = makeCtx({ home, cwd, spawnChild: async () => ((called = true), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "local-only" }, ctx);
    expect(called).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('unknown subagent_type "local-only"');
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
    writeFileSync(join(cwd, ".winter", "agents", "local-only.md"), "---\ndescription: project-local\n---\nBody.");

    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      cwd,
      spawnChild: async (req) => ((capturedReq = req), fakeHandle(Promise.resolve({ status: "completed", content: "x" }))),
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "local-only" }, { ...ctx, trustedWorkspace: true });
    expect(result.isError).toBeUndefined();
    expect(capturedReq?.definition?.description).toBe("project-local");
  });
});

describe("Agent tool: foreground spawn (default; run_in_background omitted)", () => {
  test("a completed child maps to the WS-10 §1.4 result shape, keyed on the REAL prompt text", async () => {
    const { ctx } = makeCtx({
      spawnChild: async () =>
        fakeHandle(Promise.resolve({ status: "completed", content: "the answer", resolvedModel: "claude-sonnet-4-5", totalToolUseCount: 3, totalDurationMs: 250 })),
    });
    const result = await agentExecutor.execute({ description: "short label", prompt: "what is 2+2" }, ctx);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output);
    expect(parsed).toEqual({
      agentId: "child-1",
      content: [{ type: "text", text: "the answer" }],
      totalToolUseCount: 3,
      totalDurationMs: 250,
      resolvedModel: "claude-sonnet-4-5",
      prompt: "what is 2+2",
    });
  });

  test("agentType is included only when subagent_type was given", async () => {
    const home = mkTempDir("winter-agent-test-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "explorer.md"), "---\ndescription: explores\n---\nBody.");
    const { ctx } = makeCtx({ home, spawnChild: async () => fakeHandle(Promise.resolve({ status: "completed", content: "done" })) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "explorer" }, ctx);
    const parsed = JSON.parse(result.output);
    expect(parsed.agentType).toBe("explorer");
  });

  test("a failed child surfaces as Error: subagent <id> failed: <content>, isError:true", async () => {
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(Promise.resolve({ status: "failed", content: "boom: model returned an error" })) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Error: subagent child-1 failed: boom: model returned an error");
  });

  test("a stopped child surfaces the SAME error shape, never treated as success", async () => {
    const { ctx } = makeCtx({ spawnChild: async () => fakeHandle(Promise.resolve({ status: "stopped", content: "stopped by request" })) });
    const result = await agentExecutor.execute({ description: "d", prompt: "p" }, ctx);
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
    await agentExecutor.execute({ description: "d", prompt: "p", model: "opus", isolation: "worktree", name: "helper" }, ctx);
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
    const result = await agentExecutor.execute({ description: "d", prompt: "p", team_name: "ignored", mode: "plan" }, ctx);
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
    await agentExecutor.execute({ description: "d", prompt: "p1" }, ctx);
    await agentExecutor.execute({ description: "d", prompt: "p2" }, ctx);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]!.length).toBeGreaterThan(10);
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

  test("emits task_started + background_tasks_changed synchronously, then task_notification + background_tasks_changed once the child settles", async () => {
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
    expect((frames[1] as { subtype: string; tasks: unknown[] }).subtype).toBe("background_tasks_changed");
    expect((frames[1] as { tasks: Array<{ task_id: string; task_type: string; description: string }> }).tasks).toContainEqual({
      task_id: taskId,
      task_type: "agent",
      description: "long task",
    });

    resolveResult({ status: "completed", content: "done later" });
    await new Promise((r) => setTimeout(r, 20));

    expect(frames.length).toBe(4);
    expect((frames[2] as { subtype: string; status: string }).subtype).toBe("task_notification");
    expect((frames[2] as { status: string }).status).toBe("completed");
    expect((frames[2] as { output_file: string }).output_file).toContain(taskId);
    expect((frames[3] as { subtype: string; tasks: unknown[] }).subtype).toBe("background_tasks_changed");
    // The agent task is no longer reported once settled -- backgroundAgentTasks cleans itself up.
    expect((frames[3] as { tasks: Array<{ task_id: string }> }).tasks.find((t) => t.task_id === taskId)).toBeUndefined();
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
    writeFileSync(join(home, ".winter", "agents", "bg-forced.md"), "---\ndescription: always background\nbackground: true\n---\nBody.");
    let capturedReq: SpawnChildRequest | undefined;
    const { ctx } = makeCtx({
      home,
      spawnChild: async (req) => {
        capturedReq = req;
        return fakeHandle(new Promise(() => {})); // never resolves within this test -- proves we did NOT await it
      },
    });
    const result = await agentExecutor.execute({ description: "d", prompt: "p", subagent_type: "bg-forced" }, ctx);
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
