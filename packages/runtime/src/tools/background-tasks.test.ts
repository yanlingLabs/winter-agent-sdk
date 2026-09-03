// background-tasks.ts tests (task-1 brief, Step 4). Every fixture is a fresh mkdtemp'd directory
// (phase-standing rule: tests never touch ~/.winter/real shared temp roots) -- configured directly
// via configureBackgroundTaskRoot, never through the engine, mirroring the P2 precedent this task's
// brief cites ("T5 tests populate the T1 seam directly, never via T4's own executor").
//
// BOTH beforeEach AND afterEach reset the module's singleton resolver (not afterEach alone): this
// module's state is process-wide (registry.ts's own header documents why bun's test runner shares
// one module registry across every file in a `bun test` invocation), and by the time this suite
// runs, engine.ts's own buildDefaultToolExecutor may ALREADY have called
// configureBackgroundTaskRoot for real (any earlier-running file that exercises the registry-backed
// tools default, e.g. packages/sdk/src/query.test.ts's "tooluse" scenarios) -- the
// "unconfigured" test below is meaningless unless it can force that baseline itself rather than
// merely inheriting whatever state happened to be left over from suite ordering.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackgroundTask, configureBackgroundTaskRoot, resetBackgroundTaskRootForTest } from "./background-tasks.ts";
import type { SessionTempDirPaths } from "../paths/temp.ts";

beforeEach(() => {
  resetBackgroundTaskRootForTest();
});
afterEach(() => {
  resetBackgroundTaskRootForTest();
});

function fixturePaths(): { paths: SessionTempDirPaths; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "winter-bgtask-test-"));
  const paths: SessionTempDirPaths = { root, scratchpad: join(root, "scratchpad"), tasks: join(root, "tasks") };
  return { paths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("createBackgroundTask", () => {
  test("throws a clear, actionable error when called before configureBackgroundTaskRoot", () => {
    expect(() => createBackgroundTask("bash")).toThrow(/configureBackgroundTaskRoot/);
  });

  test("D18 path shape: <session-temp>/tasks/<task-id>.output", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      configureBackgroundTaskRoot(() => paths);
      const { taskId, outputPath } = createBackgroundTask("bash");
      expect(outputPath).toBe(join(paths.tasks, `${taskId}.output`));
    } finally {
      cleanup();
    }
  });

  test("tasks/ does not exist before the first call, and exists after (lazy creation)", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      configureBackgroundTaskRoot(() => paths);
      expect(existsSync(paths.tasks)).toBe(false);
      createBackgroundTask("bash");
      expect(existsSync(paths.tasks)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("configuring the root has NO filesystem side effect until createBackgroundTask is actually called", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      let resolverCalls = 0;
      configureBackgroundTaskRoot(() => {
        resolverCalls++;
        return paths;
      });
      expect(resolverCalls).toBe(0);
      expect(existsSync(paths.tasks)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("a second call reuses the already-created tasks/ dir without error", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      configureBackgroundTaskRoot(() => paths);
      createBackgroundTask("bash");
      expect(() => createBackgroundTask("monitor")).not.toThrow();
    } finally {
      cleanup();
    }
  });

  test("every call produces a fresh, distinct taskId", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      configureBackgroundTaskRoot(() => paths);
      const a = createBackgroundTask("bash");
      const b = createBackgroundTask("bash");
      expect(a.taskId).not.toBe(b.taskId);
    } finally {
      cleanup();
    }
  });

  test("all four kinds share the SAME task-id namespace (identical output directory)", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      configureBackgroundTaskRoot(() => paths);
      const kinds = ["bash", "monitor", "workflow", "agent"] as const;
      for (const kind of kinds) {
        const { outputPath } = createBackgroundTask(kind);
        expect(outputPath.startsWith(paths.tasks)).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  test("resetBackgroundTaskRootForTest returns the module to its unconfigured state", () => {
    const { paths, cleanup } = fixturePaths();
    try {
      configureBackgroundTaskRoot(() => paths);
      createBackgroundTask("bash"); // proves it was configured
      resetBackgroundTaskRootForTest();
      expect(() => createBackgroundTask("bash")).toThrow();
    } finally {
      cleanup();
    }
  });
});
