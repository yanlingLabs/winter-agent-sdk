// Phase 5 Lane W (task 4): the Workflow TOOL -- the model-facing half. Input validation
// (derived-shapes-p5 item (g)'s seven fields and three doc-asserted rules) and the pinned
// `WorkflowOutput` the result must be exactly.
//
// Every rule below has its own RED fixture, because the rules are independent and a single
// "validates input" test would pass with three of the four implemented.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./workflow.ts";
import { resetWorkflowToolForTest } from "./workflow.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { stopTask, getTask, resetBackgroundTaskRuntimeForTest } from "./background-task-runtime.ts";
import { configureBackgroundTaskRoot, resetBackgroundTaskRootForTest } from "../background-tasks.ts";
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
  // The SAME wiring engine.ts does once per run -- `createBackgroundTask` owns the
  // `<root>/tasks/<taskId>.output` path shape AND ensures the directory, which is exactly why the
  // lane must call it rather than hand-rolling the join (F5).
  configureBackgroundTaskRoot(() => ({ root: sessionTempDir, scratchpad: join(sessionTempDir, "scratchpad"), tasks: join(sessionTempDir, "tasks") }));
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
  resetBackgroundTaskRootForTest();
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

  test("the validation-failure task_started OMITS workflow_name rather than inventing one -- the meta block is what did not parse", async () => {
    const frames: Array<Record<string, unknown>> = [];
    await run({ script: `export const meta = { name: id, description: "d" };\nreturn 1;` }, makeCtx({ emitFrame: (f) => frames.push(f as unknown as Record<string, unknown>) }));
    const started = frames.find((f) => f["subtype"] === "task_started");
    expect(started).toBeDefined();
    expect("workflow_name" in started!).toBe(false);
    expect(started!["description"]).toContain("failed validation");
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

describe("F5 -- the run's return value must actually REACH the conversation (WS-11 §1.4)", () => {
  // `task_notification.summary` is a 500-char PREVIEW, and `WorkflowOutput` carries no result field
  // (correctly -- the pin has none). So the only durable channel for the return value is the
  // `output_file` the notification names. Capture (3) records the pinned runtime emitting one.
  const LONG = "x".repeat(2000);

  test("a return value over 500 chars is written IN FULL to the output_file the notification names", async () => {
    const frames: Array<Record<string, unknown>> = [];
    const out = await output({ script: META + `return ${JSON.stringify(LONG)};` }, makeCtx({ emitFrame: (f) => frames.push(f as unknown as Record<string, unknown>) }));
    await new Promise((res) => setTimeout(res, 80));
    const notification = frames.find((f) => f["subtype"] === "task_notification") as { output_file: string; summary: string } | undefined;
    expect(notification).toBeDefined();
    // The advertised path EXISTS and holds the whole value -- not the 500-char preview.
    expect(existsSync(notification!.output_file)).toBe(true);
    expect(readFileSync(notification!.output_file, "utf8")).toBe(LONG);
    expect(notification!.summary.length).toBeLessThan(LONG.length); // a PREVIEW, not the value
    expect(notification!.summary).toContain("truncated");
    expect(out.taskId).toBeTruthy();
  });

  test("the output file is the one `createBackgroundTask` owns, so TaskOutput can read it", async () => {
    const frames: Array<Record<string, unknown>> = [];
    await output({ script: META + `return "short result";` }, makeCtx({ emitFrame: (f) => frames.push(f as unknown as Record<string, unknown>) }));
    await new Promise((res) => setTimeout(res, 80));
    const notification = frames.find((f) => f["subtype"] === "task_notification") as { task_id: string; output_file: string };
    // TaskOutput resolves the path from the shared registry, so the two must agree.
    expect(getTask(notification.task_id)?.outputPath).toBe(notification.output_file);
    expect(notification.output_file).toBe(join(sessionTempDir, "tasks", `${notification.task_id}.output`));
    expect(readFileSync(notification.output_file, "utf8")).toBe("short result");
  });

  test("a FAILED run writes its error to the same file -- the diagnostic is never lost either", async () => {
    const frames: Array<Record<string, unknown>> = [];
    await output({ script: META + `throw new Error("the failure detail");` }, makeCtx({ emitFrame: (f) => frames.push(f as unknown as Record<string, unknown>) }));
    await new Promise((res) => setTimeout(res, 80));
    const notification = frames.find((f) => f["subtype"] === "task_notification") as { output_file: string; status: string };
    expect(notification.status).toBe("failed");
    expect(readFileSync(notification.output_file, "utf8")).toContain("the failure detail");
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

describe("F11 -- `parentToolUseId` is the MODEL's tool_use id or nothing at all", () => {
  test("a context with no toolUseId is refused LOUDLY rather than correlating children to a fabricated id", async () => {
    const ctx = makeCtx();
    delete (ctx as { toolUseId?: string }).toolUseId;
    const result = await run({ script: SCRIPT }, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("tool_use");
  });

  test("the real id reaches SpawnChildRequest.parentToolUseId, so WS-10 §4 correlation is rooted in the model's own block", async () => {
    const seen: string[] = [];
    const ctx = makeCtx({
      toolUseId: "tooluse-real",
      session: {
        ...makeCtx().session,
        spawnChild: async (req) => {
          seen.push(req.parentToolUseId);
          return {
            record: {} as never,
            status: () => "completed" as const,
            steer: async () => ({ status: "delivered" as const, messageId: "m" }),
            resume: async () => ({ status: "resumed_and_delivered" as const, messageId: "m" }),
            result: async () => ({ status: "completed" as const, content: "ok" }),
            stop: async () => {},
          } as unknown as ChildHandle;
        },
      },
    });
    await output({ script: META + `await agent("a"); return 1;` }, ctx);
    await new Promise((res) => setTimeout(res, 80));
    expect(seen).toEqual(["tooluse-real"]);
  });
});

describe("F10 -- the THREE ways this lane is inert until T8 wires it, each pinned separately", () => {
  // The report's concern 1 is that a merge landing two of the three looks like a working feature.
  // Each leg fails differently and silently, so each gets its own assertion rather than one test
  // standing in for all three.

  test("leg 1: the tools/impl barrel DOES install the Workflow executor -- T8's `import \"./workflow.ts\"` landed", () => {
    // A FRESH process, because this file imports ./workflow.ts directly (line 11) and therefore
    // always has the executor installed -- the very reason the gap is invisible to the suite. The
    // probe imports only the barrel, exactly as a live session does.
    const probe = [
      `await import(${JSON.stringify(fileURLToPath(new URL("./index.ts", import.meta.url)))});`,
      `const { getRegisteredTool } = await import(${JSON.stringify(fileURLToPath(new URL("../registry.ts", import.meta.url)))});`,
      `process.stdout.write(String(getRegisteredTool("Workflow")?.executor !== undefined));`,
    ].join("\n");
    const result = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    // FLIPPED BY T8 (rider 21), exactly as this fixture's own comment said it would be: "when T8
    // adds the barrel import this flips to 'true' and this expectation is what tells them the gap is
    // closed -- the test is the ledger entry, not a permanent invariant." It is now a permanent
    // invariant: a barrel that stops importing ./workflow.ts fails HERE, in the lane's own file, as
    // well as in tools/impl/partial-wiring.test.ts, which carries the same probe for both P5 tools
    // plus the counterfactual (descriptors-only => "false,false").
    expect(new TextDecoder().decode(result.stdout)).toBe("true");
  }, 20_000);

  test("leg 2: with NO session registered the tool answers a typed error rather than crashing", async () => {
    resetWorkflowSessionForTest();
    const result = await run({ script: SCRIPT });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("workflow runtime");
  });

  test("leg 3: the descriptor is gated on the `winter.workflows` capability -- something must grant it or the tool is never advertised", () => {
    const descriptor = getRegisteredTool("Workflow")?.descriptor;
    expect(descriptor?.capabilityRequirements).toContain("winter.workflows");
  });
});
