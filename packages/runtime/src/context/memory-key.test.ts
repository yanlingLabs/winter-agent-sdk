// Phase 5 Lane C (task 6) -- the memory KEY and DIRECTORY (WS-11 §3, WS-05 §11).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { memoryDirFor, memoryProjectKeyFor, RESERVED_MEMORY_KEYS, _clearMemoryKeyCacheForTests } from "./memory-key.ts";
import { makeGitFixture, type GitFixture } from "./git-fixture.ts";

describe("context/memory-key.ts -- the memory project key", () => {
  beforeEach(() => _clearMemoryKeyCacheForTests());

  test("a non-repo cwd keys off the cwd itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-memkey-"));
    try {
      expect(memoryProjectKeyFor(dir, {})).toBe(compatibilityKeys(dir).memoryProjectKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WINTER_PROJECT_DIR_NAME relocates the memory directory too (disclosed widening of P1-N)", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-memkey-"));
    try {
      expect(memoryProjectKeyFor(dir, { WINTER_PROJECT_DIR_NAME: "pinned-name" })).toBe("pinned-name");
      expect(memoryDirFor({ cwd: dir, home: "/h", env: { WINTER_PROJECT_DIR_NAME: "pinned-name" } })).toBe(join("/h", "projects", "pinned-name", "memory"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the resolved directory is <home>/projects/<key>/memory", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-memkey-"));
    try {
      const key = memoryProjectKeyFor(dir, {});
      expect(memoryDirFor({ cwd: dir, home: "/winter-home", env: {} })).toBe(join("/winter-home", "projects", key, "memory"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an override REPLACES the computed path entirely, with ~ expanded and no further per-project nesting", () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-memkey-"));
    try {
      expect(memoryDirFor({ cwd: dir, home: "/h", env: {}, override: "/elsewhere/mem" })).toBe("/elsewhere/mem");
      expect(memoryDirFor({ cwd: dir, home: "/h", env: {}, override: "~/mem" })).toBe(join(homedir(), "mem"));
      // Whitespace-only is "absent", never a resolution to `home` itself.
      expect(memoryDirFor({ cwd: dir, home: "/h", env: {}, override: "   " })).toBe(join("/h", "projects", memoryProjectKeyFor(dir, {}), "memory"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the product buckets `_global`/`_assistant` are reserved and unreachable from a computed key", () => {
    expect(RESERVED_MEMORY_KEYS).toEqual(["_global", "_assistant"]);
    const dir = mkdtempSync(join(tmpdir(), "winter-memkey-"));
    try {
      // The sanitizer maps every non-alphanumeric to "-", so a leading "_" is unproducible by
      // construction; this asserts the property rather than one lucky path.
      for (const name of ["_global", "_assistant"]) {
        const nested = join(dir, name);
        mkdirSync(nested, { recursive: true });
        expect(RESERVED_MEMORY_KEYS).not.toContain(memoryProjectKeyFor(nested, {}));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("context/memory-key.ts -- REAL git worktrees share the main repository's memory", () => {
  let fx: GitFixture | undefined;
  beforeEach(() => {
    _clearMemoryKeyCacheForTests();
    fx = makeGitFixture();
  });
  afterEach(() => {
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    fx = undefined;
  });

  test("a linked worktree and its main checkout resolve to the SAME memory directory", () => {
    const f = fx!;
    const home = "/winter-home";
    expect(memoryDirFor({ cwd: f.worktree, home, env: {} })).toBe(memoryDirFor({ cwd: f.main, home, env: {} }));
  });

  test("a SUBDIRECTORY of the main checkout also shares it (the key is the repo root, not the cwd)", () => {
    const f = fx!;
    const sub = join(f.main, "packages", "deep");
    mkdirSync(sub, { recursive: true });
    expect(memoryDirFor({ cwd: sub, home: "/h", env: {} })).toBe(memoryDirFor({ cwd: f.main, home: "/h", env: {} }));
  });

  test("the resolution is memoized per cwd, and the test-only reset clears it", () => {
    const f = fx!;
    const first = memoryProjectKeyFor(f.main, {});
    const second = memoryProjectKeyFor(f.main, {});
    expect(second).toBe(first);
    _clearMemoryKeyCacheForTests();
    expect(memoryProjectKeyFor(f.main, {})).toBe(first);
  });
});
