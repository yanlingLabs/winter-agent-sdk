// Phase 3, Lane A, Task 4 -- Glob executor tests. Fresh mkdtemp fixture tree per test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./glob.ts";
import { getRegisteredTool, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { createSessionReadState } from "../read-state.ts";

function makeCtx(cwd: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "test-session",
    readState: createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" },
    tempDir: join(cwd, ".tmp"),
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/work", setSessionRoot() {} },
    ...overrides,
  };
}

async function runGlob(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  const tool = getRegisteredTool("Glob");
  if (!tool?.executor) throw new Error("Glob executor is not registered");
  return tool.executor.execute(input, ctx);
}

function touch(path: string, mtimeMsAgo: number): void {
  const t = new Date(Date.now() - mtimeMsAgo);
  utimesSync(path, t, t);
}

describe("Glob (Phase 3, Lane A, Task 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winter-glob-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("matches files under cwd by default and returns absolute paths", async () => {
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "b.txt"), "");
    writeFileSync(join(dir, "c.log"), "");
    const result = await runGlob({ pattern: "*.txt" }, makeCtx(dir));
    expect(result.isError).toBeUndefined();
    const lines = result.output.split("\n").filter((l) => l.length > 0);
    expect(lines.sort()).toEqual([join(dir, "a.txt"), join(dir, "b.txt")].sort());
  });

  test("results are ordered newest-first by modification time", async () => {
    const oldest = join(dir, "oldest.txt");
    const middle = join(dir, "middle.txt");
    const newest = join(dir, "newest.txt");
    writeFileSync(oldest, "");
    writeFileSync(middle, "");
    writeFileSync(newest, "");
    touch(oldest, 30_000);
    touch(middle, 20_000);
    touch(newest, 10_000);
    const result = await runGlob({ pattern: "*.txt" }, makeCtx(dir));
    expect(result.output.split("\n")).toEqual([newest, middle, oldest]);
  });

  test("caps at 100 paths and reports truncation + the real total", async () => {
    for (let i = 0; i < 105; i++) {
      writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "");
    }
    const result = await runGlob({ pattern: "*.txt" }, makeCtx(dir));
    const lines = result.output.split("\n");
    const pathLines = lines.filter((l) => l.startsWith(dir));
    expect(pathLines).toHaveLength(100);
    expect(result.output).toContain("Truncated to 100 of 105 total matches");
  });

  test(".gitignore is NOT applied by default", async () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "");
    writeFileSync(join(dir, "kept.txt"), "");
    const result = await runGlob({ pattern: "*.txt" }, makeCtx(dir));
    expect(result.output).toContain(join(dir, "ignored.txt"));
    expect(result.output).toContain(join(dir, "kept.txt"));
  });

  test("dotfiles are matched (no hidden-file filtering for Glob)", async () => {
    writeFileSync(join(dir, ".env"), "");
    const result = await runGlob({ pattern: "*" }, makeCtx(dir));
    expect(result.output).toContain(join(dir, ".env"));
  });

  test("onlyFiles: a directory itself never appears as a match", async () => {
    mkdirSync(join(dir, "subdir"));
    writeFileSync(join(dir, "subdir", "inner.txt"), "");
    const result = await runGlob({ pattern: "**/*" }, makeCtx(dir));
    const lines = result.output.split("\n");
    expect(lines).not.toContain(join(dir, "subdir"));
    expect(lines).toContain(join(dir, "subdir", "inner.txt"));
  });

  test("`path` scopes the scan to a subdirectory", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "x.txt"), "");
    writeFileSync(join(dir, "top.txt"), "");
    const result = await runGlob({ pattern: "*.txt", path: "sub" }, makeCtx(dir));
    expect(result.output).toBe(join(dir, "sub", "x.txt"));
  });

  test("an absolute pattern is resolved without double-joining onto the scan root (Bun.Glob quirk)", async () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.txt"), "");
    // A REAL but unrelated cwd -- proves the absolute pattern's own matches are used as-is (never
    // joined onto this unrelated root) without conflating that with the separate, expected
    // invariant that ctx.cwd itself must exist (a session-level guarantee, not this test's concern).
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "winter-glob-unrelated-"));
    try {
      const absolutePattern = join(dir, "**", "*.txt");
      const result = await runGlob({ pattern: absolutePattern }, makeCtx(unrelatedCwd));
      expect(result.output).toBe(join(dir, "nested", "deep.txt"));
    } finally {
      rmSync(unrelatedCwd, { recursive: true, force: true });
    }
  });

  test("a nonexistent `path` errors", async () => {
    const result = await runGlob({ pattern: "*.txt", path: "does-not-exist" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  test("a `path` that names a file, not a directory, errors", async () => {
    writeFileSync(join(dir, "afile.txt"), "");
    const result = await runGlob({ pattern: "*", path: "afile.txt" }, makeCtx(dir));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not a directory");
  });

  test("a missing pattern errors without throwing", async () => {
    const result = await runGlob({}, makeCtx(dir));
    expect(result.isError).toBe(true);
  });

  test("no matches returns an empty result, not an error", async () => {
    const result = await runGlob({ pattern: "*.nonexistent-ext" }, makeCtx(dir));
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("");
  });

  // I1 (fix wave, P3 close-out): mirrors grep.test.ts's identical scenario -- a rule-matched `path`
  // FIELD deny is not a traversal guard; a scan rooted OUTSIDE a denied subtree can still discover
  // matches INSIDE one.
  describe("I1 (fix wave, P3 close-out): probeReadAccess filters deny-read subtrees out of the scan", () => {
    test("a file under a subtree probeReadAccess denies is never listed, even though the scan root itself is not denied", async () => {
      const runDir = join(dir, ".winter", "run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "pidfile"), "x");
      writeFileSync(join(dir, "ok.txt"), "x");

      const ctx = makeCtx(dir, {
        permissions: {
          probeReadAccess: (filePath: string) => (filePath.startsWith(runDir + "/") || filePath === runDir ? "deny" : "silent"),
        },
      });
      const result = await runGlob({ pattern: "**/*" }, ctx);
      expect(result.output).toContain(join(dir, "ok.txt"));
      expect(result.output).not.toContain(join(runDir, "pidfile"));
    });
  });

  describe("extractPaths seam (RULING P3-F, fix round 1: raw passthrough, no cwd resolution)", () => {
    test("returns the RAW `path` string unresolved, even when relative", () => {
      const tool = getRegisteredTool("Glob");
      expect(tool!.extractPaths!({ pattern: "*.ts", path: "/some/dir" })).toEqual({ reads: ["/some/dir"], writes: [] });
      expect(tool!.extractPaths!({ pattern: "*.ts", path: "relative/dir" })).toEqual({ reads: ["relative/dir"], writes: [] });
    });

    test("returns no candidates when `path` is absent -- never synthesizes a cwd default", () => {
      const tool = getRegisteredTool("Glob");
      expect(tool!.extractPaths!({ pattern: "*.ts" })).toEqual({ reads: [], writes: [] });
    });
  });
});
