import { describe, test, expect } from "bun:test";
import { resolveCandidatePaths, mergePathSets, emptyPathSet } from "./paths-seam.ts";

describe("resolveCandidatePaths", () => {
  test("resolves a relative candidate against baseDir", () => {
    expect(resolveCandidatePaths(["file.txt"], "/work")).toEqual(["/work/file.txt"]);
  });

  test("leaves an already-absolute candidate untouched", () => {
    expect(resolveCandidatePaths(["/etc/passwd"], "/work")).toEqual(["/etc/passwd"]);
  });

  test("resolves the cwd-drift case: a candidate against a DIFFERENT baseDir than the call's own cwd", () => {
    // Simulates a Bash extractor that has already advanced past an embedded `cd sub` -- the
    // candidate is resolved against the post-`cd` directory, not the call's starting cwd.
    expect(resolveCandidatePaths(["file.txt"], "/work/sub")).toEqual(["/work/sub/file.txt"]);
  });

  test("de-duplicates while preserving first-seen order", () => {
    expect(resolveCandidatePaths(["a.txt", "b.txt", "a.txt"], "/work")).toEqual(["/work/a.txt", "/work/b.txt"]);
  });

  test("an empty candidate list resolves to an empty list", () => {
    expect(resolveCandidatePaths([], "/work")).toEqual([]);
  });
});

describe("mergePathSets", () => {
  test("unions reads and writes independently, de-duplicated", () => {
    const merged = mergePathSets({ reads: ["/a"], writes: ["/b"] }, { reads: ["/a", "/c"], writes: ["/d"] });
    expect(merged.reads.sort()).toEqual(["/a", "/c"]);
    expect(merged.writes.sort()).toEqual(["/b", "/d"]);
  });

  test("merging with an empty set is a no-op", () => {
    const a = { reads: ["/a"], writes: ["/b"] };
    expect(mergePathSets(a, emptyPathSet())).toEqual(a);
  });
});

describe("emptyPathSet", () => {
  test("is the correct default for a tool with nothing path-shaped in its input", () => {
    expect(emptyPathSet()).toEqual({ reads: [], writes: [] });
  });
});
