import { describe, test, expect } from "bun:test";
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
