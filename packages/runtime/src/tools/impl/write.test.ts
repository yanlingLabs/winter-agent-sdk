// write.ts tests (Phase 3, Lane B / task-5). Real mkdtemp'd fixture trees, no real usernames, cleaned
// up per-test (try/finally) -- mirrors tools/background-tasks.test.ts's own fixture convention.
// readState is populated DIRECTLY via the SessionReadState seam (never through a Read executor).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState, type SessionReadState } from "../read-state.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import "./write.ts";
import { computeLineDiff } from "./write.ts";

function fixtureDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "winter-write-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeCtx(cwd: string, opts?: { readState?: SessionReadState; probe?: ReadAccessProbe }): ToolExecutionContext {
  return {
    cwd,
    home: "/home/test",
    sessionId: "test-session",
    readState: opts?.readState ?? createSessionReadState(),
    emitFrame: () => {},
    permissions: { probeReadAccess: () => opts?.probe ?? "silent" },
    tempDir: "/unused",
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {} },
  };
}

function writeExecutor() {
  const tool = getRegisteredTool("Write");
  if (!tool?.executor) throw new Error("Write executor not registered");
  return tool.executor;
}

describe("Write -- input validation", () => {
  test("rejects a non-object input", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await writeExecutor().execute("nope", makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Error");
    } finally {
      cleanup();
    }
  });

  test("rejects input missing 'content'", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await writeExecutor().execute({ file_path: "a.txt" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("Write -- new files have no precondition", () => {
  test("creates a brand-new file with no prior read at all", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await writeExecutor().execute({ file_path: "new.txt", content: "hello\n" }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("hello\n");
      const parsed = JSON.parse(result.output);
      expect(parsed.type).toBe("create");
      expect(parsed.previousContent).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("auto-creates missing parent directories for a new file", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await writeExecutor().execute({ file_path: "nested/deep/new.txt", content: "x" }, makeCtx(dir));
      expect(result.isError).toBeUndefined();
      expect(existsSync(join(dir, "nested/deep/new.txt"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a new file's diff shows every line as an addition", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await writeExecutor().execute({ file_path: "new.txt", content: "a\nb" }, makeCtx(dir));
      const parsed = JSON.parse(result.output);
      expect(parsed.diff).toEqual([
        { type: "add", newLineNumber: 1, content: "a" },
        { type: "add", newLineNumber: 2, content: "b" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("records a full (complete:true) read after creating a new file", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const state = createSessionReadState();
      const filePath = join(dir, "new.txt");
      await writeExecutor().execute({ file_path: "new.txt", content: "x" }, makeCtx(dir, { readState: state }));
      const record = state.lookup(filePath);
      expect(record?.complete).toBe(true);
      expect(record?.mtimeMs).toBe(statSync(filePath).mtimeMs);
    } finally {
      cleanup();
    }
  });
});

describe("Write -- overwriting an existing file honors the ladder", () => {
  test("strict + never read -> denied, file left untouched", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "existing.txt");
      writeFileSync(filePath, "original");
      const result = await writeExecutor().execute({ file_path: "existing.txt", content: "changed" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("original");
    } finally {
      cleanup();
    }
  });

  test("a complete, fresh read allows the overwrite", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "existing.txt");
      writeFileSync(filePath, "original");
      const state = createSessionReadState();
      state.recordRead(filePath, { complete: true, mtimeMs: statSync(filePath).mtimeMs });
      const result = await writeExecutor().execute({ file_path: "existing.txt", content: "changed" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("changed");
      const parsed = JSON.parse(result.output);
      expect(parsed.type).toBe("update");
      expect(parsed.previousContent).toBe("original");
    } finally {
      cleanup();
    }
  });

  test("a partial read never satisfies Write-overwrite, even under a relaxed caller intent (no profile plumbed in yet, but the override closes it regardless)", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "existing.txt");
      writeFileSync(filePath, "original");
      const state = createSessionReadState();
      state.recordRead(filePath, { complete: false, mtimeMs: statSync(filePath).mtimeMs });
      const result = await writeExecutor().execute({ file_path: "existing.txt", content: "changed" }, makeCtx(dir, { readState: state, probe: "silent" }));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("original");
    } finally {
      cleanup();
    }
  });

  test("a notebook target never satisfies Write-overwrite without a complete fresh read", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "nb.ipynb");
      writeFileSync(filePath, '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}');
      const result = await writeExecutor().execute({ file_path: "nb.ipynb", content: "{}" }, makeCtx(dir, { probe: "silent" }));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a drifted (previously read, since changed) file is denied -- Write has no drift rescue", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "existing.txt");
      writeFileSync(filePath, "original");
      const state = createSessionReadState();
      state.recordRead(filePath, { complete: true, mtimeMs: statSync(filePath).mtimeMs });
      utimesSync(filePath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      const result = await writeExecutor().execute({ file_path: "existing.txt", content: "changed" }, makeCtx(dir, { readState: state, probe: "silent" }));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("original");
    } finally {
      cleanup();
    }
  });

  test("overwriting a directory errors", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const nested = join(dir, "adir");
      mkdirSync(nested);
      const result = await writeExecutor().execute({ file_path: "adir", content: "x" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("records a carried-forward-to-complete read after a successful overwrite (Write always ends up 'full')", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "existing.txt");
      writeFileSync(filePath, "original");
      const state = createSessionReadState();
      state.recordRead(filePath, { complete: true, mtimeMs: statSync(filePath).mtimeMs });
      await writeExecutor().execute({ file_path: "existing.txt", content: "changed" }, makeCtx(dir, { readState: state }));
      const record = state.lookup(filePath);
      expect(record?.complete).toBe(true);
      expect(record?.mtimeMs).toBe(statSync(filePath).mtimeMs);
    } finally {
      cleanup();
    }
  });
});

describe("computeLineDiff", () => {
  test("identical text produces an all-context diff", () => {
    expect(computeLineDiff("a\nb", "a\nb")).toEqual([
      { type: "context", oldLineNumber: 1, newLineNumber: 1, content: "a" },
      { type: "context", oldLineNumber: 2, newLineNumber: 2, content: "b" },
    ]);
  });

  test("a pure addition", () => {
    expect(computeLineDiff("a", "a\nb")).toEqual([
      { type: "context", oldLineNumber: 1, newLineNumber: 1, content: "a" },
      { type: "add", newLineNumber: 2, content: "b" },
    ]);
  });

  test("a pure removal", () => {
    expect(computeLineDiff("a\nb", "a")).toEqual([
      { type: "context", oldLineNumber: 1, newLineNumber: 1, content: "a" },
      { type: "remove", oldLineNumber: 2, content: "b" },
    ]);
  });

  test("a single-line change is a remove+add pair, not a wholesale replace", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nX\nc");
    expect(diff).toEqual([
      { type: "context", oldLineNumber: 1, newLineNumber: 1, content: "a" },
      { type: "remove", oldLineNumber: 2, content: "b" },
      { type: "add", newLineNumber: 2, content: "X" },
      { type: "context", oldLineNumber: 3, newLineNumber: 3, content: "c" },
    ]);
  });

  test("empty old text against non-empty new text is all additions (no spurious blank-line artifact)", () => {
    expect(computeLineDiff("", "a")).toEqual([{ type: "add", newLineNumber: 1, content: "a" }]);
  });

  test("two empty texts diff to nothing", () => {
    expect(computeLineDiff("", "")).toEqual([]);
  });
});
