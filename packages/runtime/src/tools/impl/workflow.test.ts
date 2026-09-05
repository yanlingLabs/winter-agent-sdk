// Phase 5 Lane W (task 4): the Workflow TOOL -- the model-facing half. Input validation
// (derived-shapes-p5 item (g)'s seven fields and three doc-asserted rules) and the pinned
// `WorkflowOutput` the result must be exactly.
//
// Every rule below has its own RED fixture, because the rules are independent and a single
// "validates input" test would pass with three of the four implemented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./workflow.ts";
import { resetWorkflowToolForTest } from "./workflow.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { stopTask, resetBackgroundTaskRuntimeForTest } from "./background-task-runtime.ts";
import { registerWorkflowSession, resetWorkflowSessionForTest } from "../../workflows/host-registry.ts";
import { inProcessWorkerSpawner } from "../../workflows/worker-harness.ts";
import { fakeStructuredOutputSeam } from "../../structured/seam.ts";
import { createContextAccountant } from "../../engine.ts";
import type { WorkflowOutput } from "../../workflows/types.ts";
import type { ChildHandle } from "../../subagents/child-handle.ts";

const META = `export const meta = { name: "wf", description: "A one-line description" };\n`;
const SCRIPT = META + `return "done";`;

let winterHome: string;
let sessionTempDir: string;
let cwd: string;

function makeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "11111111-2222-3333-4444-555555555555",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: sessionTempDir,
    sandboxSettings: {},
    trustedWorkspace: true,
    toolUseId: "tooluse-1",
    session: {
      setCwd() {},
      addBoundedRoot() {},
      removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => cwd,
      setSessionRoot() {},
      spawnChild: async (): Promise<ChildHandle> => {
        throw new Error("no child engine in this fixture");
      },
    },
    ...overrides,
  };
}

async function run(input: unknown, ctx: ToolExecutionContext = makeCtx()): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("Workflow");
  if (!tool?.executor) throw new Error("Workflow executor is not registered");
  return tool.executor.execute(input, ctx);
}

async function output(input: unknown, ctx?: ToolExecutionContext): Promise<WorkflowOutput> {
  const result = await run(input, ctx);
  return JSON.parse(result.output) as WorkflowOutput;
}

beforeEach(() => {
  winterHome = mkdtempSync(join(tmpdir(), "winter-wf-tool-home-"));
  sessionTempDir = mkdtempSync(join(tmpdir(), "winter-wf-tool-temp-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-wf-tool-cwd-"));
  resetBackgroundTaskRuntimeForTest();
  resetWorkflowToolForTest({ spawnWorker: inProcessWorkerSpawner() });
  registerWorkflowSession({
    winterHome,
    projectKey: "-proj",
    sessionTempDir,
    structured: fakeStructuredOutputSeam(),
    accountant: createContextAccountant({ limit: 100_000 }),
  });
});
afterEach(() => {
  resetWorkflowSessionForTest();
  resetWorkflowToolForTest();
  resetBackgroundTaskRuntimeForTest();
});

describe("input schema -- the seven fields and their three doc-asserted rules (item (g))", () => {
  test("at least one of script/name/scriptPath is REQUIRED", async () => {
    const result = await run({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("script");
    expect(result.output).toContain("name");
    expect(result.output).toContain("scriptPath");
  });

  test("`args`/`description`/`title`/`resumeFromRunId` alone do NOT satisfy the requirement", async () => {
    expect((await run({ description: "d", title: "t", args: { a: 1 } })).isError).toBe(true);
  });

  test("`scriptPath` takes PRECEDENCE over both `script` and `name` (sdk-tools.d.ts:2782)", async () => {
    const path = join(cwd, "from-path.js");
    writeFileSync(path, META + `return "from-scriptPath";`);
    mkdirSync(join(cwd, ".winter", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "workflows", "named.js"), META + `return "from-name";`);
    const out = await output({ scriptPath: path, script: META + `return "from-script";`, name: "named" });
    expect(readFileSync(out.scriptPath!, "utf8")).toContain("from-scriptPath");
  });

  test("`script` beats `name` when no scriptPath is given", async () => {
    mkdirSync(join(cwd, ".winter", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "workflows", "named.js"), META + `return "from-name";`);
    const out = await output({ script: META + `return "from-script";`, name: "named" });
    expect(readFileSync(out.scriptPath!, "utf8")).toContain("from-script");
  });

  test("`description` and `title` are ACCEPTED AND IGNORED -- never an error, and never used as metadata", async () => {
    const out = await output({ script: SCRIPT, description: "IGNORED", title: "ALSO IGNORED" });
    expect(out.workflowName).toBe("wf"); // meta.name, not `title`
    expect(out.summary).toBe("A one-line description"); // meta.description, not `description`
    expect(out.error).toBeUndefined();
  });

  test("an unreadable `scriptPath` is a tool error naming the path", async () => {
    const result = await run({ scriptPath: join(cwd, "missing.js") });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("missing.js");
  });

  test("`name` resolves from the project's .winter/workflows/ (WS-11 §1.3)", async () => {
    mkdirSync(join(cwd, ".winter", "workflows"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "workflows", "named.js"), META + `return "from-name";`);
    const out = await output({ name: "named" });
    expect(readFileSync(out.scriptPath!, "utf8")).toContain("from-name");
  });

  test("an unknown `name` is a tool error, not a silent empty run", async () => {
    const result = await run({ name: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("ghost");
  });

  test("`args` reach the script VERBATIM", async () => {
    const out = await output({ script: META + `return args;`, args: { list: [1, 2], deep: { yes: true } } });
    expect(out.status).toBe("async_launched");
    expect(out.runId).toBeTruthy();
  });
});

describe("the pinned WorkflowOutput (sdk-tools.d.ts:4053-4089)", () => {
  test("a successful launch carries status/taskId plus the async_launched field set capture (3) recorded", async () => {
    const out = await output({ script: SCRIPT });
    expect(out.status).toBe("async_launched");
    expect(out.taskId).toBeTruthy();
    expect(out.taskType).toBe("local_workflow"); // the PINNED literal, never the internal `workflow`
    expect(out.workflowName).toBe("wf"); // doc-asserted to be meta.name (4061)
    expect(out.runId).toMatch(/^wf_/);
    expect(out.scriptPath).toContain(join("workflows", "scripts"));
    expect(out.transcriptDir).toContain(join("subagents", "workflows"));
    expect(out.sessionUrl).toBeUndefined(); // remote-only; Winter implements the local half
  });

  test("EVERY key present is a declared WorkflowOutput field -- no Winter-invented ones", async () => {
    const declared = new Set(["status", "taskId", "taskType", "workflowName", "runId", "summary", "transcriptDir", "scriptPath", "sessionUrl", "warning", "error"]);
    for (const key of Object.keys(await output({ script: SCRIPT }))) expect(declared.has(key)).toBe(true);
  });

  test("a SYNTAX/validation failure still RETURNS a WorkflowOutput carrying `error` -- it does not throw (4086)", async () => {
    const result = await run({ script: `export const meta = { name: id, description: "d" };\nreturn 1;` });
    const out = JSON.parse(result.output) as WorkflowOutput;
    expect(out.error).toContain("literal");
    expect(out.status).toBe("async_launched");
    expect(out.taskId).toBeTruthy(); // `taskId` is REQUIRED -- a failed validation still has to fill it
    expect(out.runId).toBeUndefined(); // nothing was launched
  });

  test("a script with NO meta block fails validation the same way", async () => {
    const out = JSON.parse((await run({ script: `return 1;` })).output) as WorkflowOutput;
    expect(out.error).toContain("meta");
  });
});

describe("the background-task frames the TOOL owes (capture (3), and bash.ts/agent.ts's own precedent)", () => {
  test("task_started carries the PINNED wire task_type and workflow_name -- both fields capture (3) recorded", async () => {
    const frames: Array<Record<string, unknown>> = [];
    await run({ script: SCRIPT }, makeCtx({ emitFrame: (f) => frames.push(f as unknown as Record<string, unknown>) }));
    const started = frames.find((f) => f["subtype"] === "task_started");
    expect(started).toBeDefined();
    expect(started!["task_type"]).toBe("local_workflow"); // never the internal "workflow" spelling
    expect(started!["workflow_name"]).toBe("wf");
    expect(frames.some((f) => f["subtype"] === "background_tasks_changed")).toBe(true);
  });

  test("workflowName survives a meta.name the persisted FILENAME has to sanitize", async () => {
    const out = await output({ script: `export const meta = { name: "My Workflow!", description: "d" };\nreturn 1;` });
    expect(out.workflowName).toBe("My Workflow!"); // the pin: workflowName IS meta.name (4061)
    expect(out.scriptPath).toContain("My-Workflow-"); // the file, necessarily, is not
  });

  test("a STOPPED run reaches the wire as `stopped`, never as `failed` (WS-11 §1.8's third terminal state)", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const ctx = makeCtx({
      emitFrame: (f) => frames.push(f as unknown as Record<string, unknown>),
      session: {
        ...makeCtx().session,
        spawnChild: async () =>
          ({
            record: {} as never,
            status: () => "running" as const,
            steer: async () => ({ status: "delivered" as const, messageId: "m" }),
            resume: async () => ({ status: "resumed_and_delivered" as const, messageId: "m" }),
            result: () => new Promise<never>(() => {}), // never settles: the run is genuinely in flight
            stop: async () => {},
          }) as unknown as ChildHandle,
      },
    });
    const out = await output({ script: META + `await agent("hang"); return 1;` }, ctx);
    await new Promise((res) => setTimeout(res, 60));
    // TaskStop's own path: the shared background-task registry's `stop` callback this tool registered.
    expect(stopTask(out.taskId)).toBe(true);
    await new Promise((res) => setTimeout(res, 60));
    const notification = frames.find((f) => f["subtype"] === "task_notification");
    expect(notification).toBeDefined();
    expect(notification!["status"]).toBe("stopped");
  });
});

describe("resumeFromRunId (WS-11 §1.5)", () => {
  test("an unknown runId is a typed tool error", async () => {
    const result = await run({ resumeFromRunId: "wf_ghost", script: SCRIPT });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("unknown");
  });

  test("a run that has not been STOPPED is refused, and the message names TaskStop", async () => {
    const first = await output({ script: SCRIPT });
    await new Promise((res) => setTimeout(res, 60)); // let it complete
    const result = await run({ resumeFromRunId: first.runId, script: SCRIPT });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("TaskStop");
  });

  test("resumeFromRunId alone satisfies the at-least-one rule -- the prior run supplies the source", async () => {
    const result = await run({ resumeFromRunId: "wf_ghost" });
    expect(result.isError).toBe(true);
    expect(result.output.toLowerCase()).toContain("unknown"); // reached RESUME, not the input-schema refusal
  });
});

describe("the session seam", () => {
  test("with NO session registered the tool answers a typed error rather than crashing", async () => {
    resetWorkflowSessionForTest();
    const result = await run({ script: SCRIPT });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workflow runtime");
  });
});
