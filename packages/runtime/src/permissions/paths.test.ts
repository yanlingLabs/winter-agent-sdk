// Task 4 (WS-07 §3.1): file-rule anchors + path semantics fixture corpus. Every describe block
// cites the WS-07 §3.1 clause it pins, mirroring grammar.test.ts's (Task 3) per-clause convention.
//
// Two fixture regimes, per the task brief: pure-string anchor/glob/depth/readDenyBlocksEdit
// fixtures use plain synthetic literal strings (matchFileRule never touches disk -- see paths.ts's
// own header) -- no mkdtemp needed, mirroring grammar.test.ts's own use of synthetic paths like
// "/etc/passwd" as pure string literals with no real fs access. Only checkSymlinkBothEnds's real
// symlink-resolution behavior needs a real mkdtemp root (lstat/realpath demand real fs). Fixture
// privacy (name-guard): every real-fs fixture below is a fresh mkdtemp root; no real usernames or
// personal paths appear anywhere in this file.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { matchFileRule, checkSymlinkBothEnds, readDenyBlocksEdit, MAX_DOUBLE_STARS, type FileRuleEntry } from "./paths.ts";

// Shared synthetic (never-real) context for the pure-string fixture groups below.
const CWD = "/synthetic/proj";
const HOME = "/synthetic/home";
const SOURCE_DIR = "/synthetic/settings-src";

function opts(pattern_opts: {
  path: string;
  direction: "allow" | "denyAsk";
  cwd?: string;
  home?: string;
  sourceDir?: string;
}) {
  return {
    path: pattern_opts.path,
    cwd: pattern_opts.cwd ?? CWD,
    home: pattern_opts.home ?? HOME,
    direction: pattern_opts.direction,
    ...(pattern_opts.sourceDir !== undefined ? { sourceDir: pattern_opts.sourceDir } : {}),
  };
}

describe("matchFileRule -- the four anchors (WS-07 §3.1 table)", () => {
  test("`//path` anchors at the filesystem root, regardless of cwd/home/sourceDir", () => {
    expect(matchFileRule("//etc/hostname", opts({ path: "/etc/hostname", direction: "allow" }))).toBe(true);
    expect(matchFileRule("//etc/hostname", opts({ path: "/etc/hostname", direction: "denyAsk" }))).toBe(true);
    expect(matchFileRule("//etc/hostname", opts({ path: "/synthetic/proj/etc/hostname", direction: "allow" }))).toBe(
      false,
    );
  });

  test("`~/path` anchors at the injected home param, never a real env read", () => {
    expect(matchFileRule("~/notes.txt", opts({ path: "/synthetic/home/notes.txt", direction: "allow" }))).toBe(true);
    expect(matchFileRule("~/notes.txt", opts({ path: "/other/notes.txt", direction: "allow" }))).toBe(false);
    // a different injected home changes the match -- proves no real-env fallback exists.
    expect(
      matchFileRule("~/notes.txt", opts({ path: "/alt-home/notes.txt", direction: "allow", home: "/alt-home" })),
    ).toBe(true);
  });

  test("bare `~` alone means the home directory itself", () => {
    expect(matchFileRule("~", opts({ path: "/synthetic/home", direction: "allow" }))).toBe(true);
    expect(matchFileRule("~", opts({ path: "/synthetic/home/sub", direction: "allow" }))).toBe(false);
  });

  test("`/path` anchors at the settings-source directory when one is supplied", () => {
    expect(
      matchFileRule(
        "/config.json",
        opts({ path: "/synthetic/settings-src/config.json", direction: "allow", sourceDir: SOURCE_DIR }),
      ),
    ).toBe(true);
    expect(
      matchFileRule("/config.json", opts({ path: "/somewhere/else/config.json", direction: "allow", sourceDir: SOURCE_DIR })),
    ).toBe(false);
  });

  test("judgment call: a `/`-anchored rule can never match when sourceDir is absent -- documented in paths.ts", () => {
    const call = { path: "/synthetic/settings-src/config.json", cwd: CWD, home: HOME, direction: "allow" as const };
    expect(matchFileRule("/config.json", call)).toBe(false);
    expect(matchFileRule("/config.json", { ...call, direction: "denyAsk" })).toBe(false);
    // even a path that would trivially match `//config.json` (fs root) does not leak through the
    // `/`-anchor family when sourceDir is missing -- the anchor is simply inert, not reinterpreted.
    expect(matchFileRule("/config.json", { path: "/config.json", cwd: CWD, home: HOME, direction: "denyAsk" })).toBe(
      false,
    );
  });

  test("bare `path` and explicit `./path` both anchor at cwd, identically", () => {
    expect(matchFileRule("notes/todo.txt", opts({ path: "/synthetic/proj/notes/todo.txt", direction: "allow" }))).toBe(
      true,
    );
    expect(
      matchFileRule("./notes/todo.txt", opts({ path: "/synthetic/proj/notes/todo.txt", direction: "allow" })),
    ).toBe(true);
    expect(matchFileRule("notes/todo.txt", opts({ path: "/other/notes/todo.txt", direction: "allow" }))).toBe(false);
  });

  test("a caller-supplied relative `path` is resolved against cwd before matching (robustness, not the primary contract)", () => {
    expect(matchFileRule("notes/todo.txt", opts({ path: "notes/todo.txt", direction: "allow" }))).toBe(true);
  });
});

describe("matchFileRule -- glob semantics (WS-07 §3.1: `*` stays within one segment; `**` crosses)", () => {
  test("a single `*` does not cross a path separator", () => {
    expect(matchFileRule("src/*.ts", opts({ path: "/synthetic/proj/src/foo.ts", direction: "allow" }))).toBe(true);
    expect(matchFileRule("src/*.ts", opts({ path: "/synthetic/proj/src/sub/foo.ts", direction: "allow" }))).toBe(
      false,
    );
  });

  test("`**` crosses directories at a middle position, including zero intervening segments", () => {
    expect(matchFileRule("src/**/*.ts", opts({ path: "/synthetic/proj/src/foo.ts", direction: "allow" }))).toBe(
      true,
    );
    expect(matchFileRule("src/**/*.ts", opts({ path: "/synthetic/proj/src/a/b/foo.ts", direction: "allow" }))).toBe(
      true,
    );
    expect(matchFileRule("src/**/*.ts", opts({ path: "/synthetic/proj/src/foo.js", direction: "allow" }))).toBe(
      false,
    );
  });

  test("`**` crosses directories at a leading position", () => {
    expect(matchFileRule("**/secret.txt", opts({ path: "/synthetic/proj/secret.txt", direction: "allow" }))).toBe(
      true,
    );
    expect(matchFileRule("**/secret.txt", opts({ path: "/synthetic/proj/a/b/secret.txt", direction: "allow" }))).toBe(
      true,
    );
  });

  test("judgment call: a trailing `**` also matches the base directory itself (simplification -- see paths.ts header; gitignore's own trailing `/**` is contents-only, diverged deliberately for a uniform zero-or-more rule)", () => {
    expect(matchFileRule("logs/**", opts({ path: "/synthetic/proj/logs", direction: "allow" }))).toBe(true);
    expect(matchFileRule("logs/**", opts({ path: "/synthetic/proj/logs/today/app.log", direction: "allow" }))).toBe(
      true,
    );
    expect(matchFileRule("logs/**", opts({ path: "/synthetic/proj/other", direction: "allow" }))).toBe(false);
  });

  test("hardening: adjacent `**` segments collapse and behave identically to a single `**` (semantics-preserving)", () => {
    expect(matchFileRule("a/**/**/b", opts({ path: "/synthetic/proj/a/b", direction: "allow" }))).toBe(
      matchFileRule("a/**/b", opts({ path: "/synthetic/proj/a/b", direction: "allow" })),
    );
    expect(matchFileRule("a/**/**/b", opts({ path: "/synthetic/proj/a/x/y/b", direction: "allow" }))).toBe(
      matchFileRule("a/**/b", opts({ path: "/synthetic/proj/a/x/y/b", direction: "allow" })),
    );
    expect(matchFileRule("a/**/**/b", opts({ path: "/synthetic/proj/a/x/y/b", direction: "allow" }))).toBe(true);
  });

  test("hardening: a pattern with more `**` segments than MAX_DOUBLE_STARS fails closed (never matches) instead of compiling", () => {
    // N segments joined by "/**/" produce N-1 "**" separators; MAX_DOUBLE_STARS+2 segments yields
    // MAX_DOUBLE_STARS+1 stars, one over the cap.
    const segmentCount = MAX_DOUBLE_STARS + 2;
    const overCapRest = Array.from({ length: segmentCount }, (_, i) => `seg${i}`).join("/**/");
    expect((overCapRest.match(/\*\*/g) ?? []).length).toBe(MAX_DOUBLE_STARS + 1);
    for (const direction of ["allow", "denyAsk"] as const) {
      expect(matchFileRule(overCapRest, opts({ path: "/synthetic/proj/anything", direction }))).toBe(false);
    }
  });

  test("boundary (review fix round 1): EXACTLY MAX_DOUBLE_STARS distinct, non-adjacent `**` groups still compiles and matches -- pins the cap check is `>`, not an accidental `>=`", () => {
    // N segments joined by "/**/" produce N-1 "**" separators; MAX_DOUBLE_STARS+1 segments yields
    // exactly MAX_DOUBLE_STARS stars -- AT the cap, not over it.
    const segments = Array.from({ length: MAX_DOUBLE_STARS + 1 }, (_, i) => `seg${i}`);
    const pattern = segments.join("/**/");
    expect((pattern.match(/\*\*/g) ?? []).length).toBe(MAX_DOUBLE_STARS);

    const zeroRepPath = "/synthetic/proj/" + segments.join("/"); // every "**" matches zero segments
    expect(matchFileRule(pattern, opts({ path: zeroRepPath, direction: "allow" }))).toBe(true);

    const withGapsPath = "/synthetic/proj/" + segments.join("/gap/"); // every "**" matches one segment
    expect(matchFileRule(pattern, opts({ path: withGapsPath, direction: "allow" }))).toBe(true);
  });

  test("hardening (review fix round 1): adjacent `**` collapse also agrees on a NON-matching case -- collapsed and uncollapsed forms fail identically", () => {
    const path = "/synthetic/proj/a/x/c"; // doesn't end in "b" -- neither form should match
    const collapsed = matchFileRule("a/**/b", opts({ path, direction: "allow" }));
    const uncollapsed = matchFileRule("a/**/**/b", opts({ path, direction: "allow" }));
    expect(collapsed).toBe(false);
    expect(uncollapsed).toBe(false);
    expect(collapsed).toBe(uncollapsed);
  });

  test("a literal multi-segment pattern with no wildcard matches only that exact path, identically on both directions (no depth asymmetry outside the single-segment case)", () => {
    for (const direction of ["allow", "denyAsk"] as const) {
      expect(matchFileRule("src/config.json", opts({ path: "/synthetic/proj/src/config.json", direction }))).toBe(
        true,
      );
      expect(
        matchFileRule("src/config.json", opts({ path: "/synthetic/proj/src/sub/config.json", direction })),
      ).toBe(false);
    }
  });
});

describe("matchFileRule -- single-segment directory pattern depth asymmetry (WS-07 §3.1: 'deliberately different depth behavior for allow vs ask/deny'; direction still capture-verification-pending; ANCHOR SCOPE now settled by Ruling P2-D)", () => {
  // Judgment call (paths.ts header): WS-07 §3.1 pins the ASYMMETRY but not which side is deeper --
  // conservative reading pinned here: allow reaches LESS (exact entry only -- an allow rule can't
  // silently widen), denyAsk reaches MORE (the entry and any depth beneath it -- a deny/ask rule
  // can't be defeated by one extra directory level). STILL capture-verification-pending.
  //
  // Ruling P2-D (fix round 1, superseding this task's original anchor-scope judgment call): the
  // denyAsk deep-reach side applies REGARDLESS of anchor -- `~/`, `//`, and `/`(sourceDir) bare
  // segments all get it too, not just bare/`./`-anchored ones. The original per-anchor reading left
  // `deny Read(~/secrets)` (and the `//`/`/`-anchored equivalents) fail-open against a nested path;
  // the reviewer's fixture gap enumeration caught all three. `allow` is UNCHANGED for every
  // non-trailing-slash pattern (exact-only for every anchor either way, so P2-D has no observable
  // effect on that side) -- the one exception: a TRAILING-SLASH pattern under a non-cwd anchor
  // moved never-matching -> exact-matching (still shallow, a bug fix not a widening; see
  // paths.ts's own P2-D comment for the full accounting).
  test("PAIR (capture-verification-pending): cwd-anchored bare segment -- allow is exact-only", () => {
    expect(matchFileRule("build", opts({ path: "/synthetic/proj/build", direction: "allow" }))).toBe(true);
    expect(matchFileRule("build", opts({ path: "/synthetic/proj/build/output.txt", direction: "allow" }))).toBe(
      false,
    );
    expect(
      matchFileRule("build", opts({ path: "/synthetic/proj/build/nested/deep.txt", direction: "allow" })),
    ).toBe(false);
  });

  test("PAIR (capture-verification-pending): the SAME cwd-anchored bare segment -- denyAsk reaches any depth beneath it", () => {
    expect(matchFileRule("build", opts({ path: "/synthetic/proj/build", direction: "denyAsk" }))).toBe(true);
    expect(matchFileRule("build", opts({ path: "/synthetic/proj/build/output.txt", direction: "denyAsk" }))).toBe(
      true,
    );
    expect(
      matchFileRule("build", opts({ path: "/synthetic/proj/build/nested/deep.txt", direction: "denyAsk" })),
    ).toBe(true);
  });

  test("sibling-name guard: a bare segment pattern never matches a same-prefix sibling (`build` vs `buildx`)", () => {
    for (const direction of ["allow", "denyAsk"] as const) {
      expect(matchFileRule("build", opts({ path: "/synthetic/proj/buildx", direction }))).toBe(false);
      expect(matchFileRule("build", opts({ path: "/synthetic/proj/buildx/output.txt", direction }))).toBe(false);
    }
  });

  test("Ruling P2-D: a `~`-anchored bare segment -- allow stays exact-only (unchanged); denyAsk NOW reaches any depth beneath it (previously fail-open, flipped by this fix round)", () => {
    expect(matchFileRule("~/secrets", opts({ path: "/synthetic/home/secrets", direction: "allow" }))).toBe(true);
    expect(matchFileRule("~/secrets", opts({ path: "/synthetic/home/secrets/key.pem", direction: "allow" }))).toBe(
      false,
    );
    expect(matchFileRule("~/secrets", opts({ path: "/synthetic/home/secrets", direction: "denyAsk" }))).toBe(true);
    expect(
      matchFileRule("~/secrets", opts({ path: "/synthetic/home/secrets/key.pem", direction: "denyAsk" })),
    ).toBe(true);
  });

  test("Ruling P2-D: a `//`-anchored (filesystem root) bare segment -- allow stays exact-only; denyAsk reaches any depth beneath it", () => {
    expect(matchFileRule("//etc", opts({ path: "/etc", direction: "allow" }))).toBe(true);
    expect(matchFileRule("//etc", opts({ path: "/etc/hostname", direction: "allow" }))).toBe(false);
    expect(matchFileRule("//etc", opts({ path: "/etc", direction: "denyAsk" }))).toBe(true);
    expect(matchFileRule("//etc", opts({ path: "/etc/hostname", direction: "denyAsk" }))).toBe(true);
  });

  test("Ruling P2-D: a `/`-anchored (settings-source) bare segment -- allow stays exact-only; denyAsk reaches any depth beneath it", () => {
    expect(
      matchFileRule("/config", opts({ path: "/synthetic/settings-src/config", direction: "allow", sourceDir: SOURCE_DIR })),
    ).toBe(true);
    expect(
      matchFileRule(
        "/config",
        opts({ path: "/synthetic/settings-src/config/secret.txt", direction: "allow", sourceDir: SOURCE_DIR }),
      ),
    ).toBe(false);
    expect(
      matchFileRule("/config", opts({ path: "/synthetic/settings-src/config", direction: "denyAsk", sourceDir: SOURCE_DIR })),
    ).toBe(true);
    expect(
      matchFileRule(
        "/config",
        opts({ path: "/synthetic/settings-src/config/secret.txt", direction: "denyAsk", sourceDir: SOURCE_DIR }),
      ),
    ).toBe(true);
  });

  test("a single-segment pattern WITH a wildcard is never treated as the special depth case -- ordinary glob rules apply symmetrically", () => {
    for (const direction of ["allow", "denyAsk"] as const) {
      expect(matchFileRule("build*", opts({ path: "/synthetic/proj/buildx", direction }))).toBe(true);
      expect(matchFileRule("build*", opts({ path: "/synthetic/proj/build/output.txt", direction }))).toBe(false);
    }
  });
});

describe("checkSymlinkBothEnds (WS-07 §3.1: 'symlinks are checked at both ends')", () => {
  // Real fs: every root below is realpath'd immediately after mkdtemp -- on macOS, $TMPDIR resolves
  // under /var, itself a symlink to /private/var; skipping this step would make a matcher built
  // from the un-realpath'd mkdtemp path silently disagree with checkSymlinkBothEnds's own
  // realpathSync output (temp.ts's sessionTempDir / temp.test.ts's own fixtures hit this exact trap
  // and fixed it the same way -- realpath the base ONCE, up front).
  function freshRoot(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), "winter-paths-symlink-")));
  }

  test("no symlink involved: both formulas degenerate to the plain matcher result", () => {
    const root = freshRoot();
    try {
      const filePath = join(root, "plain.txt");
      writeFileSync(filePath, "content");
      const matches = (p: string) => p === filePath;
      const notMatches = (p: string) => p === "/nowhere";

      expect(checkSymlinkBothEnds(filePath, matches)).toEqual({ allowRequiresBoth: true, denyIfEither: true });
      expect(checkSymlinkBothEnds(filePath, notMatches)).toEqual({ allowRequiresBoth: false, denyIfEither: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("both ends match: allow succeeds, deny fires (ordinary in-bounds symlink)", () => {
    const root = freshRoot();
    try {
      const projectDir = join(root, "project");
      mkdirSync(projectDir);
      const realFile = join(projectDir, "real.txt");
      writeFileSync(realFile, "content");
      const linkPath = join(projectDir, "link");
      symlinkSync(realFile, linkPath); // link AND target both live inside project/

      const matchesProject = (p: string) => p === projectDir || p.startsWith(projectDir + "/");
      const result = checkSymlinkBothEnds(linkPath, matchesProject);
      expect(result.allowRequiresBoth).toBe(true);
      expect(result.denyIfEither).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("target escapes the matched subtree: allow MUST fail (link matches, target doesn't)", () => {
    const root = freshRoot();
    try {
      const projectDir = join(root, "project");
      const sensitiveDir = join(root, "sensitive");
      mkdirSync(projectDir);
      mkdirSync(sensitiveDir);
      const secretFile = join(sensitiveDir, "secret.txt");
      writeFileSync(secretFile, "top secret");
      const linkPath = join(projectDir, "link"); // sits INSIDE project/, but escapes OUT to sensitive/
      symlinkSync(secretFile, linkPath);

      const matchesProject = (p: string) => p === projectDir || p.startsWith(projectDir + "/");
      const result = checkSymlinkBothEnds(linkPath, matchesProject);
      // link (inside project/) matches; resolved target (inside sensitive/) does not -- an allow
      // rule scoped to project/** must NOT authorize following this link.
      expect(result.allowRequiresBoth).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("target escapes the matched subtree: deny MUST fire via the resolved target, even though the link path itself doesn't match", () => {
    const root = freshRoot();
    try {
      const projectDir = join(root, "project");
      const sensitiveDir = join(root, "sensitive");
      mkdirSync(projectDir);
      mkdirSync(sensitiveDir);
      const secretFile = join(sensitiveDir, "secret.txt");
      writeFileSync(secretFile, "top secret");
      const linkPath = join(projectDir, "link");
      symlinkSync(secretFile, linkPath);

      const matchesSensitive = (p: string) => p === sensitiveDir || p.startsWith(sensitiveDir + "/");
      const result = checkSymlinkBothEnds(linkPath, matchesSensitive);
      // link (inside project/) does NOT match a deny rule scoped to sensitive/**; but the RESOLVED
      // TARGET does -- this is the real escape-prevention case: a deny on sensitive/** must still
      // block reaching it THROUGH a symlink planted elsewhere.
      expect(result.denyIfEither).toBe(true);
      // and, symmetrically, an allow rule scoped to sensitive/** must not fire either, since the
      // LINK itself (the thing actually being opened) doesn't live in the allowed tree.
      expect(result.allowRequiresBoth).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-existent leaf path (e.g. a new file about to be Written) resolves via its real parent directory chain", () => {
    const root = freshRoot();
    try {
      const projectDir = join(root, "project");
      mkdirSync(projectDir);
      const newFilePath = join(projectDir, "not-yet-created.txt");
      const matchesProject = (p: string) => p.startsWith(projectDir + "/");
      expect(checkSymlinkBothEnds(newFilePath, matchesProject)).toEqual({
        allowRequiresBoth: true,
        denyIfEither: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dangling symlink does not throw -- degrades to treating the link's own path as the target", () => {
    const root = freshRoot();
    try {
      const projectDir = join(root, "project");
      mkdirSync(projectDir);
      const linkPath = join(projectDir, "dangling-link");
      symlinkSync(join(projectDir, "never-created.txt"), linkPath);

      const matchesProject = (p: string) => p.startsWith(projectDir + "/");
      expect(() => checkSymlinkBothEnds(linkPath, matchesProject)).not.toThrow();
      expect(checkSymlinkBothEnds(linkPath, matchesProject)).toEqual({
        allowRequiresBoth: true,
        denyIfEither: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readDenyBlocksEdit (WS-07 §3.1: 'a Read deny also blocks current Edit/Write operations on the same path')", () => {
  const ctx = { cwd: CWD, home: HOME };

  test("a matching Read deny rule blocks Edit/Write on the same path", () => {
    const rules: FileRuleEntry[] = [{ toolName: "Read", pattern: "secrets/**", behavior: "deny" }];
    expect(readDenyBlocksEdit(rules, "/synthetic/proj/secrets/key.pem", ctx)).toBe(true);
  });

  test("a non-matching Read deny rule does not block", () => {
    const rules: FileRuleEntry[] = [{ toolName: "Read", pattern: "secrets/**", behavior: "deny" }];
    expect(readDenyBlocksEdit(rules, "/synthetic/proj/public/readme.txt", ctx)).toBe(false);
  });

  test("boundary: a Read ASK rule (not deny) does not block, even if the path matches -- WS-07 §3.1 names deny specifically", () => {
    const rules: FileRuleEntry[] = [{ toolName: "Read", pattern: "secrets/**", behavior: "ask" }];
    expect(readDenyBlocksEdit(rules, "/synthetic/proj/secrets/key.pem", ctx)).toBe(false);
  });

  test("boundary: an Edit deny rule (not Read) does not trip this primitive -- Edit needs its own deny per every editing surface", () => {
    const rules: FileRuleEntry[] = [{ toolName: "Edit", pattern: "secrets/**", behavior: "deny" }];
    expect(readDenyBlocksEdit(rules, "/synthetic/proj/secrets/key.pem", ctx)).toBe(false);
  });

  test("a Read ALLOW rule does not block (only deny blocks)", () => {
    const rules: FileRuleEntry[] = [{ toolName: "Read", pattern: "secrets/**", behavior: "allow" }];
    expect(readDenyBlocksEdit(rules, "/synthetic/proj/secrets/key.pem", ctx)).toBe(false);
  });

  test("an empty rule set never blocks", () => {
    expect(readDenyBlocksEdit([], "/synthetic/proj/secrets/key.pem", ctx)).toBe(false);
  });

  test("multiple rules: any single matching Read deny is enough, order-independent", () => {
    const rules: FileRuleEntry[] = [
      { toolName: "Read", pattern: "public/**", behavior: "allow" },
      { toolName: "Edit", pattern: "secrets/**", behavior: "deny" },
      { toolName: "Read", pattern: "secrets/**", behavior: "deny" },
    ];
    expect(readDenyBlocksEdit(rules, "/synthetic/proj/secrets/key.pem", ctx)).toBe(true);
  });

  test("a rule's own sourceDir is honored for `/`-anchored patterns (per-rule, not per-evaluation)", () => {
    const rules: FileRuleEntry[] = [
      { toolName: "Read", pattern: "/config.json", behavior: "deny", sourceDir: SOURCE_DIR },
    ];
    expect(readDenyBlocksEdit(rules, "/synthetic/settings-src/config.json", ctx)).toBe(true);
    expect(readDenyBlocksEdit(rules, "/somewhere/else/config.json", ctx)).toBe(false);
  });

  test("a `/`-anchored deny rule with no sourceDir never blocks (same sourceDir-absent rule as matchFileRule)", () => {
    const rules: FileRuleEntry[] = [{ toolName: "Read", pattern: "/config.json", behavior: "deny" }];
    expect(readDenyBlocksEdit(rules, "/synthetic/settings-src/config.json", ctx)).toBe(false);
  });
});
