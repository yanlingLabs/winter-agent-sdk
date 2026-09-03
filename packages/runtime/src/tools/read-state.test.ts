import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionReadState } from "./read-state.ts";

describe("SessionReadState (task-1 brief, Step 4)", () => {
  test("lookup on a never-read path returns undefined", () => {
    const state = createSessionReadState();
    expect(state.lookup("/never/read")).toBeUndefined();
  });

  test("recordRead then lookup round-trips complete/mtimeMs exactly", () => {
    const state = createSessionReadState();
    state.recordRead("/a.txt", { complete: true, mtimeMs: 1000 });
    expect(state.lookup("/a.txt")).toEqual({ complete: true, mtimeMs: 1000 });
  });

  test("a partial read is recorded distinctly from a complete one", () => {
    const state = createSessionReadState();
    state.recordRead("/a.txt", { complete: false, mtimeMs: 1000 });
    expect(state.lookup("/a.txt")).toEqual({ complete: false, mtimeMs: 1000 });
  });

  test("a later recordRead for the same path overwrites the earlier record", () => {
    const state = createSessionReadState();
    state.recordRead("/a.txt", { complete: false, mtimeMs: 1000 });
    state.recordRead("/a.txt", { complete: true, mtimeMs: 2000 });
    expect(state.lookup("/a.txt")).toEqual({ complete: true, mtimeMs: 2000 });
  });

  test("two different paths are tracked independently", () => {
    const state = createSessionReadState();
    state.recordRead("/a.txt", { complete: true, mtimeMs: 1000 });
    state.recordRead("/b.txt", { complete: false, mtimeMs: 2000 });
    expect(state.lookup("/a.txt")).toEqual({ complete: true, mtimeMs: 1000 });
    expect(state.lookup("/b.txt")).toEqual({ complete: false, mtimeMs: 2000 });
  });

  test("two independently-constructed states never share history", () => {
    const a = createSessionReadState();
    const b = createSessionReadState();
    a.recordRead("/a.txt", { complete: true, mtimeMs: 1 });
    expect(b.lookup("/a.txt")).toBeUndefined();
  });
});

describe("SessionReadState key canonicalization (Ruling P3-D: caller convention is irrelevant)", () => {
  // Real fs: every root below is realpath'd immediately after mkdtemp -- on macOS, $TMPDIR resolves
  // under /var, itself a symlink to /private/var; mirrors paths.test.ts's own established
  // mkdtemp/realpath-the-base convention (checkSymlinkBothEnds's freshRoot) rather than inventing a
  // second one. Fixture privacy (name-guard): every root is a fresh mkdtemp root; no real usernames.
  function freshRoot(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "winter-read-state-")));
  }

  test("record via a symlinked spelling, lookup via the real spelling finds it", () => {
    const root = freshRoot();
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir);
      const linkDir = join(root, "link");
      symlinkSync(realDir, linkDir);
      const realPath = join(realDir, "a.txt");
      writeFileSync(realPath, "content");
      const linkedPath = join(linkDir, "a.txt");

      const state = createSessionReadState();
      state.recordRead(linkedPath, { complete: true, mtimeMs: 111 });
      expect(state.lookup(realPath)).toEqual({ complete: true, mtimeMs: 111 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("record via the real spelling, lookup via a symlinked spelling finds it (the reverse)", () => {
    const root = freshRoot();
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir);
      const linkDir = join(root, "link");
      symlinkSync(realDir, linkDir);
      const realPath = join(realDir, "a.txt");
      writeFileSync(realPath, "content");
      const linkedPath = join(linkDir, "a.txt");

      const state = createSessionReadState();
      state.recordRead(realPath, { complete: true, mtimeMs: 222 });
      expect(state.lookup(linkedPath)).toEqual({ complete: true, mtimeMs: 222 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a not-yet-existing path under a symlinked parent is found via the other spelling (Write-before-read shape)", () => {
    const root = freshRoot();
    try {
      const realDir = join(root, "real");
      mkdirSync(realDir);
      const linkDir = join(root, "link");
      symlinkSync(realDir, linkDir);
      // Deliberately never created -- the read-before-edit ladder must key a not-yet-existing file
      // (e.g. one about to be Written) identically regardless of which spelling reaches it.
      const linkedPath = join(linkDir, "new-file.txt");
      const realPath = join(realDir, "new-file.txt");

      const state = createSessionReadState();
      state.recordRead(linkedPath, { complete: false, mtimeMs: 333 });
      expect(state.lookup(realPath)).toEqual({ complete: false, mtimeMs: 333 });

      const state2 = createSessionReadState();
      state2.recordRead(realPath, { complete: false, mtimeMs: 444 });
      expect(state2.lookup(linkedPath)).toEqual({ complete: false, mtimeMs: 444 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a relative path and its absolute equivalent key identically, in both directions", () => {
    const root = freshRoot();
    try {
      const stateA = createSessionReadState({ cwd: root });
      stateA.recordRead("rel.txt", { complete: true, mtimeMs: 555 });
      expect(stateA.lookup(join(root, "rel.txt"))).toEqual({ complete: true, mtimeMs: 555 });

      const stateB = createSessionReadState({ cwd: root });
      stateB.recordRead(join(root, "rel2.txt"), { complete: false, mtimeMs: 666 });
      expect(stateB.lookup("rel2.txt")).toEqual({ complete: false, mtimeMs: 666 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cwd defaults to process.cwd() when omitted, and is honored when given explicitly", () => {
    const root = freshRoot();
    try {
      writeFileSync(join(root, "only-in-root.txt"), "content");

      // No cwd override -- defaults to process.cwd(), which is not `root` (a fresh mkdtemp dir), so
      // the relative spelling below resolves elsewhere and never matches the absolute lookup.
      const defaultState = createSessionReadState();
      defaultState.recordRead("only-in-root.txt", { complete: true, mtimeMs: 777 });
      expect(defaultState.lookup(join(root, "only-in-root.txt"))).toBeUndefined();

      // With cwd explicitly fixed to root, the identical relative spelling now resolves under root.
      const rootState = createSessionReadState({ cwd: root });
      rootState.recordRead("only-in-root.txt", { complete: true, mtimeMs: 888 });
      expect(rootState.lookup(join(root, "only-in-root.txt"))).toEqual({ complete: true, mtimeMs: 888 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
