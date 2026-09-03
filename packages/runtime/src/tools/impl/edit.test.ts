// edit.ts tests (Phase 3, Lane B / task-5). Real mkdtemp'd fixture trees, no real usernames, cleaned
// up per-test (try/finally). readState is populated DIRECTLY via the SessionReadState seam (never
// through a Read executor -- lane independence from Lane A).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState, type SessionReadState } from "../read-state.ts";
import type { ReadAccessProbe } from "../../permissions/evaluator.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../registry.ts";
import "./edit.ts";

function fixtureDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "winter-edit-test-"));
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

function editExecutor() {
  const tool = getRegisteredTool("Edit");
  if (!tool?.executor) throw new Error("Edit executor not registered");
  return tool.executor;
}

function readFully(withCompleteRead: SessionReadState, filePath: string): void {
  withCompleteRead.recordRead(filePath, { complete: true, mtimeMs: statSync(filePath).mtimeMs });
}

describe("Edit -- input validation", () => {
  test("rejects a non-object input", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await editExecutor().execute("nope", makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rejects a non-boolean replace_all", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "a", new_string: "b", replace_all: "yes" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rejects an empty old_string", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "", new_string: "x" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("rejects old_string === new_string as a no-op", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "hello" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("errors when the target does not exist -- Edit never creates files", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const result = await editExecutor().execute({ file_path: "missing.txt", old_string: "a", new_string: "b" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("does not exist");
    } finally {
      cleanup();
    }
  });

  test("errors when the target is a directory", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      mkdirSync(join(dir, "adir"));
      const result = await editExecutor().execute({ file_path: "adir", old_string: "a", new_string: "b" }, makeCtx(dir));
      expect(result.isError).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("Edit -- the read-before-edit ladder gates the target", () => {
  test("strict + never read -> denied, file left untouched", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "goodbye" }, makeCtx(dir));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("hello world");
    } finally {
      cleanup();
    }
  });

  test("a complete, fresh read allows the edit", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "goodbye" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("goodbye world");
    } finally {
      cleanup();
    }
  });

  test("a drifted file with an unambiguous current match + silent probe is rescued (rung 3)", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      utimesSync(filePath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "goodbye" }, makeCtx(dir, { readState: state, probe: "silent" }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("goodbye world");
    } finally {
      cleanup();
    }
  });

  test("a drifted file where the probe would prompt is denied, even with an unambiguous match", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      utimesSync(filePath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "goodbye" }, makeCtx(dir, { readState: state, probe: "prompt" }));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("hello world");
    } finally {
      cleanup();
    }
  });

  test("a drifted file where the current match is ambiguous (2 occurrences) is denied even though it would read silently", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello hello");
      const state = createSessionReadState();
      readFully(state, filePath);
      utimesSync(filePath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "hi" }, makeCtx(dir, { readState: state, probe: "silent" }));
      expect(result.isError).toBe(true);
      expect(readFileSync(filePath, "utf8")).toBe("hello hello");
    } finally {
      cleanup();
    }
  });
});

describe("Edit -- match-count semantics", () => {
  test("zero matches errors, even on a properly-read file", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "nope", new_string: "x" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    } finally {
      cleanup();
    }
  });

  test("multiple matches without replace_all errors and mentions the count", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "a a a");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "a", new_string: "b" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("3 times");
    } finally {
      cleanup();
    }
  });

  test("multiple matches WITH replace_all replaces every occurrence", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "a a a");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "a", new_string: "b", replace_all: true }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("b b b");
      const parsed = JSON.parse(result.output);
      expect(parsed.replaceAll).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a single occurrence succeeds without replace_all", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "one two three");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "two", new_string: "TWO" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("one TWO three");
    } finally {
      cleanup();
    }
  });
});

describe("Edit -- replacement is fully literal, never regex/$-pattern interpreted", () => {
  test("a new_string containing '$&' is inserted literally, not as 'the matched text'", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "$& literally" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("$& literally world");
    } finally {
      cleanup();
    }
  });

  test("a new_string of '$$' is inserted as two literal dollar signs, not collapsed to one", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "$$" }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("$$ world");
    } finally {
      cleanup();
    }
  });

  test("a shell-variable-shaped new_string ($HOME) round-trips exactly, with replace_all too", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "export X=old\nexport Y=old");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "old", new_string: "$HOME/bin", replace_all: true }, makeCtx(dir, { readState: state }));
      expect(result.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("export X=$HOME/bin\nexport Y=$HOME/bin");
    } finally {
      cleanup();
    }
  });
});

describe("Edit -- result shape and post-edit read state", () => {
  test("result carries filePath, a line diff, originalContent, replaceAll, and userModified:false", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "line one\nline two");
      const state = createSessionReadState();
      readFully(state, filePath);
      const result = await editExecutor().execute({ file_path: "a.txt", old_string: "one", new_string: "1" }, makeCtx(dir, { readState: state }));
      const parsed = JSON.parse(result.output);
      expect(parsed.filePath).toBe(filePath);
      expect(parsed.originalContent).toBe("line one\nline two");
      expect(parsed.replaceAll).toBe(false);
      expect(parsed.userModified).toBe(false);
      expect(parsed.diff).toEqual([
        { type: "remove", oldLineNumber: 1, content: "line one" },
        { type: "add", newLineNumber: 1, content: "line 1" },
        { type: "context", oldLineNumber: 2, newLineNumber: 2, content: "line two" },
      ]);
    } finally {
      cleanup();
    }
  });

  test("after a successful edit, a prior complete read carries forward as complete at the new mtime", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "hello world");
      const state = createSessionReadState();
      readFully(state, filePath);
      await editExecutor().execute({ file_path: "a.txt", old_string: "hello", new_string: "goodbye" }, makeCtx(dir, { readState: state }));
      const record = state.lookup(filePath);
      expect(record?.complete).toBe(true);
      expect(record?.mtimeMs).toBe(statSync(filePath).mtimeMs);
    } finally {
      cleanup();
    }
  });

  test("consecutive edits on the same path stay eligible without an intervening Read (post-edit record prevents self-inflicted drift)", async () => {
    const { dir, cleanup } = fixtureDir();
    try {
      const filePath = join(dir, "a.txt");
      writeFileSync(filePath, "one two three");
      const state = createSessionReadState();
      readFully(state, filePath);
      const first = await editExecutor().execute({ file_path: "a.txt", old_string: "one", new_string: "1" }, makeCtx(dir, { readState: state, probe: "deny" }));
      expect(first.isError).toBeUndefined();
      const second = await editExecutor().execute({ file_path: "a.txt", old_string: "two", new_string: "2" }, makeCtx(dir, { readState: state, probe: "deny" }));
      expect(second.isError).toBeUndefined();
      expect(readFileSync(filePath, "utf8")).toBe("1 2 three");
    } finally {
      cleanup();
    }
  });
});
