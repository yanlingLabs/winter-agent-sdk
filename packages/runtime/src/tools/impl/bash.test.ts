import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskMessage } from "@yanlinglabs/winter-agent-sdk";
import "./bash.ts"; // triggers replaceExecutor("Bash", ...) at module load
import { getRegisteredTool } from "../registry.ts";
import type { ToolExecutionContext } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";
import { configureBackgroundTaskRoot, resetBackgroundTaskRootForTest } from "../background-tasks.ts";
import { resetBackgroundTaskRuntimeForTest, getTask } from "./background-task-runtime.ts";
import { parseBashInput, resolveTimeout, extractBashPaths, computeWritableRoots } from "./bash.ts";
import type { SessionTempDirPaths } from "../../paths/temp.ts";

function proj(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "winter-bash-test-")));
}

function fakeCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const frames: BackgroundTaskMessage[] = [];
  return {
    cwd: proj(),
    home: "/home/test",
    sessionId: "s1",
    readState: createSessionReadState(),
    emitFrame: (f) => frames.push(f),
    permissions: { probeReadAccess: () => "silent" },
    tempDir: proj(),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" },
    ...overrides,
  };
}

function bash() {
  const executor = getRegisteredTool("Bash")!.executor!;
  return (input: unknown, ctx: ToolExecutionContext) => executor.execute(input, ctx);
}

// test.skipIf, matching deny.darwin.test.ts's own pinned shape (not `const d = darwin ? describe :
// describe.skip`) -- a non-darwin CI run then ENUMERATES every test below as visibly skipped,
// rather than describe.skip hiding the whole block from the report.
const t = test.skipIf(process.platform !== "darwin");

// ---------------------------------------------------------------------------------------------
// Pure input validation / timeout resolution -- platform-free.
// ---------------------------------------------------------------------------------------------
describe("parseBashInput", () => {
  test("accepts a minimal valid input", () => {
    const r = parseBashInput({ command: "ls" });
    expect("error" in r).toBe(false);
  });

  test("rejects a missing/empty command", () => {
    expect("error" in parseBashInput({})).toBe(true);
    expect("error" in parseBashInput({ command: "" })).toBe(true);
  });

  test("rejects non-object input", () => {
    expect("error" in parseBashInput("ls")).toBe(true);
    expect("error" in parseBashInput(null)).toBe(true);
  });

  test("rejects wrong-typed optional fields", () => {
    expect("error" in parseBashInput({ command: "ls", timeout: "soon" })).toBe(true);
    expect("error" in parseBashInput({ command: "ls", run_in_background: "yes" })).toBe(true);
    expect("error" in parseBashInput({ command: "ls", dangerouslyDisableSandbox: "yes" })).toBe(true);
    expect("error" in parseBashInput({ command: "ls", description: 5 })).toBe(true);
  });

  test("accepts every optional field with the right type", () => {
    const r = parseBashInput({ command: "ls", timeout: 1000, description: "list", run_in_background: true, dangerouslyDisableSandbox: false });
    expect(r).toEqual({ command: "ls", timeout: 1000, description: "list", run_in_background: true, dangerouslyDisableSandbox: false });
  });
});

describe("resolveTimeout", () => {
  test("defaults to 2 minutes when omitted", () => {
    expect(resolveTimeout(undefined)).toBe(120_000);
  });
  test("passes through a value under the ceiling", () => {
    expect(resolveTimeout(5000)).toBe(5000);
  });
  test("clamps to the 600000ms ceiling (the ordinary ceiling and the declaration cap are the same number)", () => {
    expect(resolveTimeout(999_999)).toBe(600_000);
  });
  test("falls back to the default for a non-positive or non-finite value rather than erroring", () => {
    expect(resolveTimeout(0)).toBe(120_000);
    expect(resolveTimeout(-5)).toBe(120_000);
    expect(resolveTimeout(NaN)).toBe(120_000);
  });
});

describe("computeWritableRoots", () => {
  test("includes ctx.tempDir beyond cwd", () => {
    const ctx = fakeCtx();
    expect(computeWritableRoots(ctx)).toEqual([ctx.tempDir]);
  });
});

// ---------------------------------------------------------------------------------------------
// extractPaths -- pure, no ctx (registry.ts's own extractPaths contract has none).
// ---------------------------------------------------------------------------------------------
describe("extractBashPaths (P2-T11 carry)", () => {
  test("a plain command with no redirect extracts nothing", () => {
    expect(extractBashPaths({ command: "ls -la" })).toEqual({ reads: [], writes: [] });
  });

  test("a redirect target becomes a write candidate, relative to the implicit base", () => {
    expect(extractBashPaths({ command: "echo hi > out.txt" })).toEqual({ reads: [], writes: ["out.txt"] });
  });

  test("an absolute redirect target is left untouched", () => {
    expect(extractBashPaths({ command: "echo hi > /etc/passwd" })).toEqual({ reads: [], writes: ["/etc/passwd"] });
  });

  test("cwd-drift: a `cd` before a later subcommand's redirect shifts the base for THAT redirect only", () => {
    const r = extractBashPaths({ command: "cd sub && echo hi > out.txt" });
    expect(r.writes).toEqual(["sub/out.txt"]);
  });

  test("multiple chained cds compose", () => {
    const r = extractBashPaths({ command: "cd a && cd b && echo hi > out.txt" });
    expect(r.writes).toEqual(["a/b/out.txt"]);
  });

  test("a redirect BEFORE a later cd is unaffected by that later cd", () => {
    const r = extractBashPaths({ command: "echo hi > out.txt && cd sub" });
    expect(r.writes).toEqual(["out.txt"]);
  });

  test("duplicate candidates are de-duplicated", () => {
    const r = extractBashPaths({ command: "echo a > out.txt; echo b > out.txt" });
    expect(r.writes).toEqual(["out.txt"]);
  });

  test("an unparseable command (unterminated quote) extracts nothing rather than guessing", () => {
    expect(extractBashPaths({ command: "echo 'unterminated" })).toEqual({ reads: [], writes: [] });
  });

  test("invalid tool input extracts nothing rather than throwing", () => {
    expect(extractBashPaths({})).toEqual({ reads: [], writes: [] });
    expect(extractBashPaths(null)).toEqual({ reads: [], writes: [] });
  });

  test("reads stays empty -- Bash's grammar has no read-candidate extraction, only redirect (write) targets", () => {
    expect(extractBashPaths({ command: "cat secret.txt" }).reads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real end-to-end executor behavior (darwin-gated -- this dev box has sandbox-exec).
// ---------------------------------------------------------------------------------------------
describe("Bash executor (real sandboxed spawn)", () => {
  t("runs a command, reports stdout and exit 0, and shows the sandbox posture", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: "echo hello-winter" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("hello-winter");
    expect(res.output).toContain("[exit 0]");
    expect(res.output).toContain("[sandbox: sandboxed]");
  });

  t("stdout and stderr are shown separately, not merged (§6.4 retirement delta)", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: "echo on-out; echo on-err 1>&2" }, ctx);
    expect(res.output).toContain("on-out");
    expect(res.output).toContain("[stderr]");
    expect(res.output).toContain("on-err");
  });

  t("no stderr section at all when stderr is empty", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: "echo only-stdout" }, ctx);
    expect(res.output).not.toContain("[stderr]");
  });

  t("a nonzero exit is reported in the text, not as a tool-level isError", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: "exit 7" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("[exit 7]");
  });

  t("a command that exceeds its timeout is killed and reported", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: "sleep 5", timeout: 300 }, ctx);
    expect(res.output).toMatch(/timed out/);
  });

  t("cannot write outside the session cwd under the default sandbox", async () => {
    const ctx = fakeCtx();
    const sibling = proj();
    const target = join(sibling, "escaped.txt");
    const res = await bash()({ command: `echo pwned > ${target}` }, ctx);
    expect(existsSync(target)).toBe(false);
    expect(res.output).not.toContain("[exit 0]");
  });

  t("can write into $TMPDIR (ctx.tempDir)", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: 'echo scratch > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"' }, ctx);
    expect(res.output).toContain("scratch");
    expect(res.output).toContain("[exit 0]");
  });

  t("dangerouslyDisableSandbox: true escapes the write fence and is shown as override-requested", async () => {
    const ctx = fakeCtx();
    const sibling = proj();
    const target = join(sibling, "escaped.txt");
    const res = await bash()({ command: `echo pwned > ${target}`, dangerouslyDisableSandbox: true }, ctx);
    expect(res.output).toContain("[exit 0]");
    expect(existsSync(target)).toBe(true);
    expect(res.output).toContain("[sandbox: override-requested]");
  });

  // T8 fix round 1 (coordinator-required, brief item 7): runForeground wraps the model's raw
  // command in a pwd-capture script before spawning (buildPwdCaptureScript) but passes
  // matchCommand: input.command through to runCommand -- excludedCommands must match what the
  // model/settings author actually wrote, never the wrapper. This was already true in the
  // production code (spawn.ts:210, bash.ts:266) but had ZERO fixture coverage at the executor
  // level; spawn.test.ts's own sibling fixture proves the lower-level runCommand mechanism, this
  // one proves it reaches the real Bash tool end-to-end.
  t("excludedCommands matches the model's RAW command, not bash.ts's own pwd-capture wrapper", async () => {
    const ctx = fakeCtx({ sandboxSettings: { excludedCommands: ["echo raw-command"], allowUnsandboxedCommands: true } });
    const res = await bash()({ command: "echo raw-command" }, ctx);
    expect(res.output).toContain("[sandbox: excluded]");
  });

  t("bad args are a tool error, never a throw", async () => {
    const ctx = fakeCtx();
    const res = await bash()({ command: "" }, ctx);
    expect(res.isError).toBe(true);
  });

  // WS-12 §6.1: "each call starts a separate, fresh shell; env exports do NOT persist." Two real
  // calls against the SAME ctx (only cwd-carry is meant to survive between calls, never shell
  // state) -- the first exports a var from inside its own spawned shell, the second (a genuinely
  // separate bash()() invocation) must not see it. This is the one property in the Bash contract
  // that is invisible to any single-call test, however many of those a suite accumulates.
  t("env exports from one call do NOT persist to the next -- fresh shell per call", async () => {
    const ctx = fakeCtx();
    const first = await bash()({ command: "export WINTER_PROBE=leaked" }, ctx);
    expect(first.output).toContain("[exit 0]");
    const second = await bash()({ command: 'echo "val:${WINTER_PROBE:-absent}"' }, ctx);
    expect(second.output).toContain("val:absent");
  });

  // --- cwd-carry (WS-06 §6.1) ---
  describe("cwd-carry", () => {
    t("a cd that lands within an allowed dir (ctx.tempDir) persists via ctx.session.setCwd", async () => {
      const cwd = proj();
      const tempDir = proj();
      mkdirSync(join(tempDir, "sub"));
      let carried: string | undefined;
      const ctx = fakeCtx({ cwd, tempDir, session: { setCwd: (p) => (carried = p), addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" } });
      const res = await bash()({ command: `cd ${join(tempDir, "sub")} && pwd` }, ctx);
      expect(res.output).toContain("[exit 0]");
      expect(carried).toBe(realpathSync(join(tempDir, "sub")));
    });

    t("a cd OUTSIDE every allowed dir does not persist", async () => {
      const cwd = proj();
      let carried: string | undefined;
      const ctx = fakeCtx({ cwd, session: { setCwd: (p) => (carried = p), addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" } });
      const res = await bash()({ command: "cd /var && pwd" }, ctx);
      expect(res.output).toContain("[exit 0]");
      expect(carried).toBeUndefined();
    });

    t("no cd at all -- setCwd is never called", async () => {
      let called = false;
      const ctx = fakeCtx({ session: { setCwd: () => (called = true), addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" } });
      await bash()({ command: "echo hi" }, ctx);
      expect(called).toBe(false);
    });

    t("a command that itself calls exit early (never reaching the trailing pwd capture) does not crash and does not carry cwd", async () => {
      let called = false;
      const ctx = fakeCtx({ session: { setCwd: () => (called = true), addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" } });
      const res = await bash()({ command: "exit 3" }, ctx);
      expect(res.output).toContain("[exit 3]");
      expect(called).toBe(false);
    });
  });

  // --- output capping ---
  describe("output capping", () => {
    t("small output is never persisted", async () => {
      const ctx = fakeCtx();
      const res = await bash()({ command: "echo small" }, ctx);
      expect(res.output).not.toContain("truncated");
    });

    t("large SUCCESSFUL stdout is capped at ~30k chars with a persisted-output path", async () => {
      const ctx = fakeCtx();
      const res = await bash()({ command: "yes x | head -c 40000" }, ctx);
      expect(res.output).toContain("[stdout truncated");
      const m = /full output: (\S+)\]/.exec(res.output);
      expect(m).not.toBeNull();
      const persisted = readFileSync(m![1]!, "utf8");
      expect(persisted.length).toBeGreaterThan(30_000);
    });

    t("a large FAILURE gets a smaller head/tail excerpt, not the full 30k", async () => {
      const ctx = fakeCtx();
      const res = await bash()({ command: "yes x | head -c 40000; exit 1" }, ctx);
      expect(res.output).toContain("[exit 1]");
      expect(res.output).toContain("excerpt");
      const m = /full output: (\S+)\]/.exec(res.output);
      expect(m).not.toBeNull();
      expect(readFileSync(m![1]!, "utf8").length).toBeGreaterThan(30_000);
    });
  });

  // --- run_in_background ---
  describe("run_in_background", () => {
    let paths: SessionTempDirPaths;
    let cleanupDir: string;

    beforeEach(() => {
      resetBackgroundTaskRootForTest();
      resetBackgroundTaskRuntimeForTest();
      cleanupDir = mkdtempSync(join(tmpdir(), "winter-bgtask-bash-"));
      paths = { root: cleanupDir, scratchpad: join(cleanupDir, "scratchpad"), tasks: join(cleanupDir, "tasks") };
      configureBackgroundTaskRoot(() => paths);
    });
    afterEach(() => {
      resetBackgroundTaskRootForTest();
      resetBackgroundTaskRuntimeForTest();
    });

    t("returns immediately with a task id and output_file, without waiting for completion", async () => {
      const ctx = fakeCtx();
      const started = Date.now();
      const res = await bash()({ command: "sleep 2 && echo done", run_in_background: true }, ctx);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(res.output).toContain("background task");
      expect(res.output).toContain("output_file:");
    });

    t("a background override call reports override-requested in BOTH the started message and the task_notification summary (WS-12 §4 MUST)", async () => {
      const frames: BackgroundTaskMessage[] = [];
      const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
      const res = await bash()({ command: "echo hi", run_in_background: true, dangerouslyDisableSandbox: true }, ctx);
      expect(res.output).toContain("[sandbox: override-requested]");
      for (let i = 0; i < 50 && !frames.some((f) => f.subtype === "task_notification"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const notif = frames.find((f) => f.subtype === "task_notification") as { summary: string };
      expect(notif.summary).toContain("[sandbox: override-requested]");
    });

    t("an ordinary sandboxed background call reports [sandbox: sandboxed] in both surfaces too (not just the override case)", async () => {
      const frames: BackgroundTaskMessage[] = [];
      const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
      const res = await bash()({ command: "echo hi", run_in_background: true }, ctx);
      expect(res.output).toContain("[sandbox: sandboxed]");
      for (let i = 0; i < 50 && !frames.some((f) => f.subtype === "task_notification"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const notif = frames.find((f) => f.subtype === "task_notification") as { summary: string };
      expect(notif.summary).toContain("[sandbox: sandboxed]");
    });

    t("emits task_started and background_tasks_changed synchronously before returning", async () => {
      const frames: BackgroundTaskMessage[] = [];
      const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
      await bash()({ command: "echo hi", run_in_background: true }, ctx);
      expect(frames.some((f) => f.subtype === "task_started")).toBe(true);
      expect(frames.some((f) => f.subtype === "background_tasks_changed")).toBe(true);
    });

    // Task 8 (found via a real differential-scenario repro, not assumed): the sibling test above only
    // ever checked the FRAME EXISTS, never its own CONTENTS -- runCommand's spawn is asynchronous
    // (onSpawned fires on a later tick), so without registering the task synchronously up front,
    // this frame's own `tasks` list was ALWAYS EMPTY at the exact moment it announced the task that
    // had just started. Proves the real content, not just the frame's presence.
    t("background_tasks_changed's own tasks list already contains the just-started task, not an empty list", async () => {
      const frames: BackgroundTaskMessage[] = [];
      const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
      await bash()({ command: "echo hi", run_in_background: true }, ctx);
      const started = frames.find((f) => f.subtype === "task_started") as { task_id: string };
      const changed = frames.find((f) => f.subtype === "background_tasks_changed") as { tasks: Array<{ task_id: string }> };
      expect(changed.tasks.map((t) => t.task_id)).toContain(started.task_id);
    });

    t("appends stdout to the task's own output file, and emits task_notification on completion", async () => {
      const frames: BackgroundTaskMessage[] = [];
      const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
      const res = await bash()({ command: "echo from-background", run_in_background: true }, ctx);
      const m = /output_file: (\S+)/.exec(res.output);
      expect(m).not.toBeNull();
      const outputPath = m![1]!;
      // wait for the detached process to actually finish and the completion handler to fire
      for (let i = 0; i < 50 && !frames.some((f) => f.subtype === "task_notification"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(frames.some((f) => f.subtype === "task_notification")).toBe(true);
      expect(readFileSync(outputPath, "utf8")).toContain("from-background");
      expect(getTask((frames.find((f) => f.subtype === "task_started") as { task_id: string }).task_id)?.status).toBe("completed");
    });

    t("a failing background command is reported as a failed task_notification", async () => {
      const frames: BackgroundTaskMessage[] = [];
      const ctx = fakeCtx({ emitFrame: (f) => frames.push(f) });
      await bash()({ command: "exit 1", run_in_background: true }, ctx);
      for (let i = 0; i < 50 && !frames.some((f) => f.subtype === "task_notification"); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const notif = frames.find((f) => f.subtype === "task_notification") as { status: string };
      expect(notif.status).toBe("failed");
    });

    t("foreground calls never touch the background task registry/output dir", async () => {
      const ctx = fakeCtx();
      const res = await bash()({ command: "echo hi" }, ctx);
      expect(res.output).not.toContain("output_file");
      expect(existsSync(paths.tasks)).toBe(false);
    });
  });
});
