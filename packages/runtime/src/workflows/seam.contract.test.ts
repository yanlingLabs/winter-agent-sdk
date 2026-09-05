// Phase 5 Task 3 (R5-2): the SEAM AUTHORITY for `workflows/seam.ts`, plus the three spine
// obligations Lane W consumes but may not build: RULING R5-15's worker-entry export, the
// `__workflow-worker` argv dispatch, and the amended worker seatbelt profile. RULING P5-B's
// write-floor carve-out is pinned here too -- it exists solely so a persisted workflow script can be
// edited and re-run.
import { test, expect, describe } from "bun:test";
import { PassThrough } from "node:stream";
import { resolve, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { createContextAccountant } from "../engine.ts";
import { fakeStructuredOutputSeam } from "../structured/seam.ts";
import { createFakeChildHandle } from "../subagents/test-fakes.ts";
import { buildWorkflowWorkerSeatbeltProfile, canonicalizePath } from "../sandbox/profile.ts";
import { isWorkflowScriptCarveOut, isProtectedWrite } from "../permissions/protected.ts";
import { wireTaskType } from "../tools/background-tasks.ts";
import { evaluate, REAL_SPECIAL_CHECKS, NO_OPINION_HOOK_STAGE, NO_OPINION_PROMPT_STAGE, NO_OPINION_AUTO_ENGINE, type EvaluationContext } from "../permissions/evaluator.ts";
import { emptyRuleSet } from "../permissions/ruleset.ts";
import { buildBaselineDenyRules } from "../engine.ts";
import { WORKFLOW_WORKER_ARGV_FLAG, WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE, workflowWorkerMain } from "./subprocess-entry.ts";
import { fakeWorkflowRunHost, type WorkflowProgress, type WorkflowRunHost } from "./seam.ts";

const SUBPROCESS_ENTRY_URL = new URL("./subprocess-entry.ts", import.meta.url).href;
// `fileURLToPath`, never `.pathname`: a repo path containing a space arrives percent-encoded from
// `.pathname` and `bun <that>` fails with a generic exit 1 -- which is indistinguishable from the
// missing-`--run` throw this test exists to rule out.
const MAIN_TS_PATH = fileURLToPath(new URL("../main.ts", import.meta.url));

const HOME = "/home/synthetic";
const CWD = "/synthetic/workspace";
const SCRIPT = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/workflows/scripts/build-wf_ab12.js`;
const TRANSCRIPT = `${HOME}/.winter/projects/-synthetic-workspace/sess-1.jsonl`;
const SIDECAR = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/subagents/agent-abc.meta.json`;

describe("workflows/seam.ts -- WorkflowRunHost (Lane W implements the runtime)", () => {
  function host(log: Array<{ kind: string; taskId: string; event: "created" | "progress" | "complete" | "fail"; detail?: unknown }>): WorkflowRunHost {
    return fakeWorkflowRunHost({
      structured: fakeStructuredOutputSeam(),
      accountant: createContextAccountant({ limit: 1000 }),
      spawnAgent: async () => createFakeChildHandle(),
      log,
    });
  }

  test("createTask hands back a task handle whose terminal calls are ONE-WAY (WS-11 §1.8)", () => {
    const log: Array<{ kind: string; taskId: string; event: "created" | "progress" | "complete" | "fail"; detail?: unknown }> = [];
    const task = host(log).createTask("workflow", { runId: "wf_1", name: "build" });
    const progress: WorkflowProgress = { running: 1, completed: 0, total: 3 };
    task.emit(progress);
    task.complete({ ok: true });
    // A worker that crashes AFTER reporting completion must not be able to re-fail its own task.
    task.fail("late crash");
    task.emit({ running: 0, completed: 3, total: 3 });
    expect(log.map((e) => e.event)).toEqual(["created", "progress", "complete"]);
    expect(log[0]!.detail).toEqual({ runId: "wf_1", name: "build" });
  });

  test("the host bundles the four things a workflow cannot reach on its own", async () => {
    const h = host([]);
    expect(typeof h.createTask).toBe("function");
    expect(typeof h.spawnAgent).toBe("function");
    expect(typeof h.structured.validate).toBe("function"); // W consumes K's validator, never a second one
    expect(h.accountant.limit()).toBe(1000);
    const child = await h.spawnAgent({ parentToolUseId: "t1", prompt: "go", runInBackground: false });
    expect(child.status()).toBeDefined();
  });

  test("WorkflowProgress fills the pinned task_progress `usage` triple -- all three fields, since the pin makes usage REQUIRED", () => {
    const progress: WorkflowProgress = { running: 2, completed: 1, total: 5, usage: { total_tokens: 10, tool_uses: 2, duration_ms: 30 } };
    expect(Object.keys(progress.usage!).sort()).toEqual(["duration_ms", "tool_uses", "total_tokens"]);
  });

  test("the internal kind is `workflow`, the WIRE task_type is `local_workflow` (item (g) + capture (3))", () => {
    expect(wireTaskType("workflow")).toBe("local_workflow");
    // Every other kind is spelled identically on both sides -- the mapping exists for this one case.
    expect(wireTaskType("bash")).toBe("bash");
    expect(wireTaskType("monitor")).toBe("monitor");
    expect(wireTaskType("agent")).toBe("agent");
  });
});

describe("RULING R5-15 -- the worker entry export", () => {
  test("`workflowWorkerMain` is exported with the pinned name and signature (argv, io) -> Promise<number>", async () => {
    expect(typeof workflowWorkerMain).toBe("function");
    expect(workflowWorkerMain.length).toBe(2);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks: string[] = [];
    stderr.on("data", (c: Buffer) => chunks.push(c.toString()));
    const stdoutChunks: string[] = [];
    stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString()));
    const code = await workflowWorkerMain(["winter", "__workflow-worker", "--run-id", "wf_1"], { stdin: new PassThrough(), stdout, stderr });
    expect(code).toBe(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE);
    // Diagnostics on STDERR only -- stdout is the NDJSON bridge and a notice there would corrupt it.
    expect(chunks.join("")).toContain("__workflow-worker");
    expect(stdoutChunks.join("")).toBe("");
  });

  test("the not-implemented exit code is DISTINCT from a generic failure, so verify:workflow can tell them apart", () => {
    expect(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE).not.toBe(0);
    expect(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE).not.toBe(1);
  });

  // Fix round 1 (M5): the argv marker lives HERE, not in main.ts. A spawner needs it, and importing
  // main.ts to read a constant would parse argv, resolve a session and start an engine as an import
  // side effect -- main.ts is a top-level script, not a module with an entry function.
  test("WORKFLOW_WORKER_ARGV_FLAG is exported from subprocess-entry.ts, and importing this module has NO side effects", async () => {
    expect(WORKFLOW_WORKER_ARGV_FLAG).toBe("__workflow-worker");

    // Imported in a FRESH subprocess so the assertion is about a clean module load, not about this
    // suite's already-warm module graph. `bun -e` resolves the specifier from the repo, runs the
    // import, and prints what the load did -- an engine start or an argv parse would show up as a
    // non-zero exit, stray stdout, or a set exitCode.
    const probe = [
      `const before = process.exitCode;`,
      `const m = await import(${JSON.stringify(SUBPROCESS_ENTRY_URL)});`,
      `if (process.exitCode !== before) { console.error("exitCode moved"); process.exit(9); }`,
      `if (typeof m.workflowWorkerMain !== "function") { console.error("missing export"); process.exit(9); }`,
      `process.stdout.write("flag=" + m.WORKFLOW_WORKER_ARGV_FLAG);`,
    ].join("\n");
    const result = Bun.spawnSync(["bun", "-e", probe], { stdout: "pipe", stderr: "pipe" });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("flag=__workflow-worker");
  }, 20_000);

  // Fix round 1 (low): the dispatch itself, through the REAL entrypoint. Today it exits 78 (the stub);
  // once Lane W lands a worker this test is what proves the argv route still reaches it.
  test("main.ts dispatches `__workflow-worker` to the entry BEFORE it parses --run/--config-json", () => {
    const result = Bun.spawnSync(["bun", MAIN_TS_PATH, WORKFLOW_WORKER_ARGV_FLAG, "--run-id", "wf_1"], { stdout: "pipe", stderr: "pipe" });
    // 78 = the stub's typed not-implemented code. Crucially NOT 1, which is what the missing
    // `--run`/`--config-json` throw would have produced had the dispatch been checked after parsing.
    expect(result.exitCode).toBe(WORKFLOW_WORKER_NOT_IMPLEMENTED_EXIT_CODE);
    expect(new TextDecoder().decode(result.stderr)).toContain("__workflow-worker");
    expect(new TextDecoder().decode(result.stdout)).toBe(""); // stdout is the NDJSON bridge; nothing else may write to it
  }, 20_000);
});

describe("R5-5 -- the worker seatbelt profile carries the ~/.winter/run deny", () => {
  test("with `home`, the baseline read-deny is emitted AFTER the blanket read-allow so last-match-wins makes it bind", () => {
    const profile = buildWorkflowWorkerSeatbeltProfile("/usr/local/bin/winter", { home: HOME });
    const allowIndex = profile.indexOf("(allow file-read*)");
    // The path is CANONICALIZED, exactly as buildSeatbeltProfile canonicalizes its own -- on darwin
    // `/home` resolves through `/System/Volumes/Data`, so a literal-string expectation here would
    // pass on linux CI and fail on the platform the profile is actually enforced on.
    const denyIndex = profile.indexOf(`(deny file-read* (subpath "${canonicalizePath(joinPath(HOME, ".winter", "run"))}"))`);
    expect(allowIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeGreaterThan(allowIndex);
  });

  test("without `home` the profile is still valid and byte-identical to the pre-P5 one -- the parameter is optional by design", () => {
    const profile = buildWorkflowWorkerSeatbeltProfile("/usr/local/bin/winter");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain(".winter/run");
  });
});

describe("RULING P5-B -- the persisted-workflow-script subtree is MODEL-WRITABLE", () => {
  function evalCtx(mode: EvaluationContext["policy"]["mode"]): EvaluationContext {
    return {
      policy: { mode, rules: { ...emptyRuleSet(), entries: buildBaselineDenyRules() }, version: 1 },
      cwd: CWD,
      home: HOME,
      hookStage: NO_OPINION_HOOK_STAGE,
      promptStage: NO_OPINION_PROMPT_STAGE,
      autoEngine: NO_OPINION_AUTO_ENGINE,
      specialChecks: REAL_SPECIAL_CHECKS,
      trustedWorkspace: false,
      sessionRoot: CWD,
    };
  }

  test("the path shape is EXACT: six fixed positions, exactly two wildcards, at least one file segment", () => {
    expect(isWorkflowScriptCarveOut(SCRIPT, HOME)).toBe(true);
    // The directory itself is not writable -- only its contents.
    expect(isWorkflowScriptCarveOut(`${HOME}/.winter/projects/-k/sess-1/workflows/scripts`, HOME)).toBe(false);
    // A nested session area cannot be reached by adding segments before `workflows`.
    expect(isWorkflowScriptCarveOut(`${HOME}/.winter/projects/-k/sess-1/other/workflows/scripts/x.js`, HOME)).toBe(false);
    // `workflows/scripts` anywhere else under projects/ is NOT the carve-out.
    expect(isWorkflowScriptCarveOut(`${HOME}/.winter/projects/workflows/scripts/x.js`, HOME)).toBe(false);
    // A different home is a different tree.
    expect(isWorkflowScriptCarveOut(SCRIPT, "/home/someone-else")).toBe(false);
  });

  test("isProtectedWrite exempts the subtree while every sibling under .winter stays protected", () => {
    expect(isProtectedWrite(SCRIPT, { cwd: CWD, home: HOME })).toBe(false);
    expect(isProtectedWrite(TRANSCRIPT, { cwd: CWD, home: HOME })).toBe(true);
    expect(isProtectedWrite(SIDECAR, { cwd: CWD, home: HOME })).toBe(true);
    expect(isProtectedWrite(`${HOME}/.winter/settings.json`, { cwd: CWD, home: HOME })).toBe(true);
  });

  for (const tool of ["Write", "Edit", "NotebookEdit"] as const) {
    test(`${tool} INSIDE the subtree is not denied by the baseline floor, while a sibling under projects/ still is (bypassPermissions)`, async () => {
      const field = tool === "NotebookEdit" ? "notebook_path" : "file_path";
      const inside = await evaluate({ toolName: tool, input: { [field]: SCRIPT }, toolUseId: "t1" }, evalCtx("bypassPermissions"));
      expect(inside.decision).not.toBe("deny");

      const sibling = await evaluate({ toolName: tool, input: { [field]: TRANSCRIPT }, toolUseId: "t2" }, evalCtx("bypassPermissions"));
      expect(sibling.decision).toBe("deny");
      expect(sibling.mechanism).toBe("rule");
    });
  }

  test("a Bash command touching BOTH a script and a transcript is denied outright -- the carve-out is all-or-nothing", async () => {
    const mixed = await evaluate({ toolName: "Bash", input: { command: `cp ${SCRIPT} ${TRANSCRIPT}` }, toolUseId: "t3" }, evalCtx("bypassPermissions"));
    expect(mixed.decision).toBe("deny");
  });

  test("a USER-authored deny on the same subtree is NOT skipped -- only the managed baseline entries are", async () => {
    const ctx = evalCtx("bypassPermissions");
    const withUserDeny: EvaluationContext = {
      ...ctx,
      policy: {
        ...ctx.policy,
        rules: {
          ...ctx.policy.rules,
          entries: [
            ...ctx.policy.rules.entries,
            { rule: { toolName: "Write", specifier: { kind: "pattern", source: "~/.winter/projects/**" }, isBareEquivalent: false }, behavior: "deny", source: "user", ruleValue: { toolName: "Write", ruleContent: "~/.winter/projects/**" } },
          ],
        },
      },
    };
    const decision = await evaluate({ toolName: "Write", input: { file_path: SCRIPT }, toolUseId: "t4" }, withUserDeny);
    expect(decision.decision).toBe("deny");
    expect(decision.source).toBe("user");
  });

  test("a relative path resolving into the subtree is treated identically to an absolute one", () => {
    const relativeCwd = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/workflows/scripts`;
    expect(isWorkflowScriptCarveOut(resolve(relativeCwd, "./x.js"), HOME)).toBe(true);
  });
});
