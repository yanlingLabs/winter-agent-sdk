// notebook-edit.ts tests (Phase 3, Lane B / task-5). Real mkdtemp'd fixture trees, no real usernames,
// cleaned up per-test (try/finally). readState is populated DIRECTLY via the SessionReadState seam
// (never through a Read executor -- lane independence from Lane A).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState, type SessionReadState } from "../read-state.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import "./notebook-edit.ts";

function fixtureDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "winter-nbedit-test-"));
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
    sandboxSettings: {},
    session: { setCwd() {}, addBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default" },
  };
}

function notebookEditExecutor() {
  const tool = getRegisteredTool("NotebookEdit");
  if (!tool?.executor) throw new Error("NotebookEdit executor not registered");
  return tool.executor;
}

function readFully(state: SessionReadState, filePath: string): void {
  state.recordRead(filePath, { complete: true, mtimeMs: statSync(filePath).mtimeMs });
}

interface FixtureCell {
  id: string;
  cell_type: "code" | "markdown";
  source: string;
}

function buildNotebook(cells: FixtureCell[]): Record<string, unknown> {
  return {
    cells: cells.map((c) => ({
      id: c.id,
      cell_type: c.cell_type,
      metadata: {},
      source: c.source,
      ...(c.cell_type === "code" ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: { kernelspec: { name: "python3", language: "python", display_name: "Python 3" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function writeNotebook(dir: string, name: string, cells: FixtureCell[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify(buildNotebook(cells)));
  return filePath;
}

function readNotebook(filePath: string): { cells: Array<Record<string, unknown>>; [k: string]: unknown } {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("NotebookEdit -- input validation", () => {
  test("rejects a non-object input", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await notebookEditExecutor().execute("nope", makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rejects an invalid cell_type", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", cell_type: "prose" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rejects an invalid edit_mode", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", edit_mode: "append" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("insert without cell_type errors", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", edit_mode: "insert" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cell_type");
    } finally {
      cleanup();
    }
  });

  test("replace without cell_id errors", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cell_id");
    } finally {
      cleanup();
    }
  });

  test("delete without cell_id errors", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", edit_mode: "delete" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cell_id");
    } finally {
      cleanup();
    }
  });

  test("errors when the notebook does not exist", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await notebookEditExecutor().execute({ notebook_path: "missing.ipynb", new_source: "x", cell_id: "a" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("does not exist");
    } finally {
      cleanup();
    }
  });

  test("errors when the notebook path is a directory", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      mkdirSync(join(dir, "adir"));
      const result = await notebookEditExecutor().execute({ notebook_path: "adir", new_source: "x", cell_id: "a" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("errors on malformed JSON", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "nb.ipynb");
      writeFileSync(filePath, "{not json");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", cell_id: "a" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not valid JSON");
    } finally {
      cleanup();
    }
  });

  test("errors when 'cells' is missing", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "nb.ipynb");
      writeFileSync(filePath, JSON.stringify({ metadata: {}, nbformat: 4, nbformat_minor: 5 }));
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", cell_id: "a" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("cells");
    } finally {
      cleanup();
    }
  });
});

describe("NotebookEdit -- the read-before-edit ladder gates the target", () => {
  test("strict + never read -> denied, file left untouched", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const before = readFileSync(filePath, "utf8");
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("a complete, fresh read allows the edit", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("relaxed + never read + silent probe is NOT enough on its own to test here (profile isn't plumbed in) -- default strict still denies", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir, { probe: "silent" }));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a drifted notebook is ALWAYS denied, even with a silent probe -- no drift rescue for notebooks", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      utimesSync(filePath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir, { readState: state, probe: "silent" }));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("NotebookEdit -- replace", () => {
  test("replaces the target cell's source, preserving its cell_type", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [
        { id: "a", cell_type: "code", source: "print(1)" },
        { id: "b", cell_type: "markdown", source: "# hi" },
      ]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "print(2)", cell_id: "a" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      const nb = readNotebook(filePath);
      expect(nb.cells[0]!["source"]).toBe("print(2)");
      expect(nb.cells[0]!["cell_type"]).toBe("code");
      expect(nb.cells.length).toBe(2);
      const parsed = JSON.parse(result.output);
      expect(parsed.oldSource).toBe("print(1)");
      expect(parsed.newSource).toBe("print(2)");
      expect(parsed.cellId).toBe("a");
      expect(parsed.editMode).toBe("replace");
      expect(parsed.language).toBe("python");
    } finally {
      cleanup();
    }
  });

  test("replace can also change the cell_type when cell_type is provided", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "print(1)" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute(
        { notebook_path: "nb.ipynb", new_source: "# now prose", cell_id: "a", cell_type: "markdown" },
        makeCtx(dir, { readState: state }),
      );
      expect(result.isError).toBeUndefined();
      const nb = readNotebook(filePath);
      expect(nb.cells[0]!["cell_type"]).toBe("markdown");
    } finally {
      cleanup();
    }
  });

  test("changing cell_type from code to markdown strips execution_count/outputs", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "print(1)" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "# prose", cell_id: "a", cell_type: "markdown" }, makeCtx(dir, { readState: state }));
      const nb = readNotebook(filePath);
      expect(nb.cells[0]!["execution_count"]).toBeUndefined();
      expect(nb.cells[0]!["outputs"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("changing cell_type from markdown to code adds execution_count/outputs", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "markdown", source: "# hi" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "print(1)", cell_id: "a", cell_type: "code" }, makeCtx(dir, { readState: state }));
      const nb = readNotebook(filePath);
      expect(nb.cells[0]!["execution_count"]).toBeNull();
      expect(nb.cells[0]!["outputs"]).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("replace with an unknown cell_id errors and leaves the file untouched", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "print(1)" }]);
      const before = readFileSync(filePath, "utf8");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "x", cell_id: "nope" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("nbformat/nbformat_minor/top-level metadata are preserved verbatim", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir, { readState: state }));
      const nb = readNotebook(filePath);
      expect(nb["nbformat"]).toBe(4);
      expect(nb["nbformat_minor"]).toBe(5);
      expect((nb["metadata"] as Record<string, unknown>)["kernelspec"]).toEqual({ name: "python3", language: "python", display_name: "Python 3" });
    } finally {
      cleanup();
    }
  });
});

describe("NotebookEdit -- delete", () => {
  test("removes the targeted cell and reports its prior source", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [
        { id: "a", cell_type: "code", source: "keep" },
        { id: "b", cell_type: "code", source: "drop me" },
      ]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "", cell_id: "b", edit_mode: "delete" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      const nb = readNotebook(filePath);
      expect(nb.cells.length).toBe(1);
      expect(nb.cells[0]!["id"]).toBe("a");
      const parsed = JSON.parse(result.output);
      expect(parsed.oldSource).toBe("drop me");
      expect(parsed.newSource).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("delete with an unknown cell_id errors", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "", cell_id: "nope", edit_mode: "delete" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("NotebookEdit -- insert", () => {
  test("inserts after cell_id, giving the new cell a fresh id", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [
        { id: "a", cell_type: "code", source: "first" },
        { id: "b", cell_type: "code", source: "third" },
      ]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute(
        { notebook_path: "nb.ipynb", new_source: "second", cell_id: "a", cell_type: "code", edit_mode: "insert" },
        makeCtx(dir, { readState: state }),
      );
      expect(result.isError).toBeUndefined();
      const nb = readNotebook(filePath);
      expect(nb.cells.length).toBe(3);
      expect(nb.cells.map((c) => c["source"])).toEqual(["first", "second", "third"]);
      const insertedId = nb.cells[1]!["id"];
      expect(typeof insertedId).toBe("string");
      expect(insertedId).not.toBe("a");
      expect(insertedId).not.toBe("b");
      expect(nb.cells[1]!["execution_count"]).toBeNull();
      expect(nb.cells[1]!["outputs"]).toEqual([]);
      const parsed = JSON.parse(result.output);
      expect(parsed.cellId).toBe(insertedId);
      expect(parsed.editMode).toBe("insert");
      expect(parsed.oldSource).toBeUndefined();
      expect(parsed.newSource).toBe("second");
    } finally {
      cleanup();
    }
  });

  test("inserts at the start when cell_id is omitted", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "was-first" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute(
        { notebook_path: "nb.ipynb", new_source: "now-first", cell_type: "markdown", edit_mode: "insert" },
        makeCtx(dir, { readState: state }),
      );
      expect(result.isError).toBeUndefined();
      const nb = readNotebook(filePath);
      expect(nb.cells.map((c) => c["source"])).toEqual(["now-first", "was-first"]);
      expect(nb.cells[0]!["cell_type"]).toBe("markdown");
      expect(nb.cells[0]!["execution_count"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("insert with an unknown cell_id (to insert after) errors", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await notebookEditExecutor().execute(
        { notebook_path: "nb.ipynb", new_source: "x", cell_id: "nope", cell_type: "code", edit_mode: "insert" },
        makeCtx(dir, { readState: state }),
      );
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("NotebookEdit -- post-edit read state", () => {
  test("carries a prior complete read forward as complete at the new mtime", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir, { readState: state }));
      const record = state.lookup(filePath);
      expect(record?.complete).toBe(true);
      expect(record?.mtimeMs).toBe(statSync(filePath).mtimeMs);
    } finally {
      cleanup();
    }
  });

  test("consecutive edits on the same notebook stay eligible without an intervening Read", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = writeNotebook(dir, "nb.ipynb", [{ id: "a", cell_type: "code", source: "1" }]);
      const state = createSessionReadState();
      readFully(state, filePath);
      const first = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "2", cell_id: "a" }, makeCtx(dir, { readState: state, probe: "deny" }));
      expect(first.isError).toBeUndefined();
      const second = await notebookEditExecutor().execute({ notebook_path: "nb.ipynb", new_source: "3", cell_id: "a" }, makeCtx(dir, { readState: state, probe: "deny" }));
      expect(second.isError).toBeUndefined();
      expect(readNotebook(filePath).cells[0]!["source"]).toBe("3");
    } finally {
      cleanup();
    }
  });
});
