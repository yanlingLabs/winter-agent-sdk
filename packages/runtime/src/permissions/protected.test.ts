// Task 7 (WS-07 §6.7/§6.8): isProtectedWrite / isCriticalRemoval fixture corpus. Pure string logic,
// no fs -- both primitives operate on path/command TEXT plus injected cwd/home, never touching disk
// (mirrors paths.ts's own synthetic-path convention for matchFileRule).
import { describe, test, expect } from "bun:test";
import { isProtectedWrite, isCriticalRemoval, PROTECTED_DIRECTORY_NAMES, PROTECTED_FILE_BASENAMES } from "./protected.ts";

const CWD = "/synthetic/proj";
const HOME = "/synthetic/home";
const ctx = { cwd: CWD, home: HOME };

describe("isProtectedWrite -- §6.7 protected directories", () => {
  test("the verbatim WS-07 §6.7 directory list is present", () => {
    for (const name of [".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn"]) {
      expect(PROTECTED_DIRECTORY_NAMES.has(name)).toBe(true);
    }
  });

  test("writing anywhere inside .git is protected, at any depth", () => {
    expect(isProtectedWrite(`${CWD}/.git/config`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/.git/hooks/pre-commit`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/.git`, ctx)).toBe(true);
  });

  test("a nested .git (e.g. a submodule) is also protected -- not anchored to cwd's own top level", () => {
    expect(isProtectedWrite(`${CWD}/vendor/lib/.git/config`, ctx)).toBe(true);
  });

  test(".config/git is protected as the specific two-segment pair, not any bare .config directory", () => {
    expect(isProtectedWrite(`${CWD}/.config/git/config`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/.config/some-other-tool/settings.json`, ctx)).toBe(false);
  });

  test("each remaining protected directory blocks a write beneath it", () => {
    for (const dir of [".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn"]) {
      expect(isProtectedWrite(`${CWD}/${dir}/something`, ctx)).toBe(true);
    }
  });

  test("the agent dot-dir .winter is protected, EXCEPT its worktree area (WS-01 .winter/worktrees)", () => {
    expect(isProtectedWrite(`${CWD}/.winter/settings.json`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/.winter/mcp.json`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/.winter`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/.winter/worktrees/feature-x/src/index.ts`, ctx)).toBe(false);
  });

  test("a worktree's OWN .git is still protected -- the worktree-area exception is not a blanket pass", () => {
    expect(isProtectedWrite(`${CWD}/.winter/worktrees/feature-x/.git/config`, ctx)).toBe(true);
  });

  test("an ordinary file outside every protected directory is not protected", () => {
    expect(isProtectedWrite(`${CWD}/src/index.ts`, ctx)).toBe(false);
  });

  test("a relative path is resolved against ctx.cwd before checking", () => {
    expect(isProtectedWrite(".git/config", ctx)).toBe(true);
    expect(isProtectedWrite("src/index.ts", ctx)).toBe(false);
  });
});

describe("isProtectedWrite -- §6.7 protected files (curated, capture-noted categories)", () => {
  test("shell startup files are protected at the resolved path's basename", () => {
    expect(isProtectedWrite(`${HOME}/.bashrc`, ctx)).toBe(true);
    expect(isProtectedWrite(`${HOME}/.zshrc`, ctx)).toBe(true);
  });

  test("package-manager lockfiles and manifests are protected", () => {
    expect(isProtectedWrite(`${CWD}/package.json`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/package-lock.json`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/Cargo.toml`, ctx)).toBe(true);
  });

  test("the upstream MCP project config literal and Winter's own root instructions file are protected", () => {
    expect(isProtectedWrite(`${CWD}/.mcp.json`, ctx)).toBe(true);
    expect(isProtectedWrite(`${CWD}/WINTER.md`, ctx)).toBe(true);
  });

  test("PROTECTED_FILE_BASENAMES is a real, non-empty, capture-noted set (not silently empty)", () => {
    expect(PROTECTED_FILE_BASENAMES.size).toBeGreaterThan(5);
  });
});

describe("isProtectedWrite -- write-shaped only (advisor-flagged: reads must never be caught by this primitive)", () => {
  test("this primitive has no read/write distinction of its own -- it just answers 'is this PATH protected', proving the boundary lives at the evaluator.ts seam, not here", () => {
    // isProtectedWrite(path, ctx) says nothing about which TOOL asked -- the seam only ever calls
    // it for a call already known to be write-shaped (an Edit/Write's own path, or a path
    // recognizeEditOperation extracted from Bash). This fixture just documents that this primitive
    // itself would answer the same either way -- the read/write gate is evaluator.ts's job.
    expect(isProtectedWrite(`${CWD}/.git/config`, ctx)).toBe(true);
  });
});

describe("isCriticalRemoval -- §6.8 roots, home, cwd and parents", () => {
  test("the filesystem root itself", () => {
    expect(isCriticalRemoval("rm -rf /", ctx).critical).toBe(true);
  });

  test("a direct child of the filesystem root", () => {
    expect(isCriticalRemoval("rm -rf /etc", ctx).critical).toBe(true);
    expect(isCriticalRemoval("rm -rf /anything-at-all", ctx).critical).toBe(true);
  });

  test("a nested path is NOT a 'direct child of root' just for being absolute", () => {
    expect(isCriticalRemoval(`rm -rf ${CWD}/tmp/scratch.txt`, ctx).critical).toBe(false);
  });

  test("the user's home directory, both as an absolute path and as bare `~`", () => {
    expect(isCriticalRemoval(`rm -rf ${HOME}`, ctx).critical).toBe(true);
    expect(isCriticalRemoval("rm -rf ~", ctx).critical).toBe(true);
  });

  test("a path under home is NOT critical just for being under home", () => {
    expect(isCriticalRemoval("rm -rf ~/scratch/notes.txt", ctx).critical).toBe(false);
  });

  test("the working directory itself (`.`, or its absolute form)", () => {
    expect(isCriticalRemoval("rm -rf .", ctx).critical).toBe(true);
    expect(isCriticalRemoval(`rm -rf ${CWD}`, ctx).critical).toBe(true);
  });

  test("an ancestor of the working directory (`..`, `../..`)", () => {
    expect(isCriticalRemoval("rm -rf ..", ctx).critical).toBe(true);
    expect(isCriticalRemoval("rm -rf ../..", ctx).critical).toBe(true);
  });

  test("an ordinary in-tree removal is NOT critical", () => {
    expect(isCriticalRemoval("rm ./tmp/scratch.txt", ctx)).toEqual({ critical: false });
    expect(isCriticalRemoval("rmdir ./tmp/emptydir", ctx)).toEqual({ critical: false });
  });

  test("rmdir is checked identically to rm", () => {
    expect(isCriticalRemoval("rmdir /", ctx).critical).toBe(true);
  });
});

describe("isCriticalRemoval -- §6.8 dangerous glob shapes at the top of a working/granted directory", () => {
  test("a broad glob directly at the top of cwd (`./*`, bare `*`)", () => {
    expect(isCriticalRemoval("rm -rf ./*", ctx).critical).toBe(true);
    expect(isCriticalRemoval("rm -rf *", ctx).critical).toBe(true);
  });

  test("a broad glob at the top of an additionalDirectory grant", () => {
    const withGrant = { ...ctx, additionalDirectories: ["/synthetic/extra"] };
    expect(isCriticalRemoval("rm -rf /synthetic/extra/*", withGrant).critical).toBe(true);
    // the SAME glob is not flagged without the grant present (nothing pins it as special otherwise)
    expect(isCriticalRemoval("rm -rf /synthetic/extra/*", ctx).critical).toBe(false);
  });

  test("a glob nested deeper than the top of a granted directory is NOT this shape", () => {
    expect(isCriticalRemoval("rm -rf ./src/*.ts", ctx).critical).toBe(false);
  });
});

describe("isCriticalRemoval -- §6.8 variable-rooted globs, command substitution, process substitution (conservative-critical)", () => {
  test("a variable-rooted target (the task's own fixture: `rm $VAR/...`)", () => {
    const result = isCriticalRemoval("rm -rf $VAR/subpath", ctx);
    expect(result.critical).toBe(true);
    expect(result.reason).toMatch(/variable-rooted/);
  });

  test("a bare variable-rooted target with no glob is still conservative-critical", () => {
    expect(isCriticalRemoval("rm -rf $HOME", ctx).critical).toBe(true);
  });

  test("command substitution anywhere in the target (`$(...)`, backtick)", () => {
    expect(isCriticalRemoval("rm -rf /tmp/$(whoami)", ctx).critical).toBe(true);
    expect(isCriticalRemoval("rm -rf /tmp/`whoami`", ctx).critical).toBe(true);
  });

  test("process substitution in the target", () => {
    expect(isCriticalRemoval("rm -rf <(echo x)", ctx).critical).toBe(true);
  });
});

describe("isCriticalRemoval -- compound commands (every subcommand independently checked)", () => {
  test("a dangerous rm hidden behind a benign leading subcommand still taints the whole compound", () => {
    expect(isCriticalRemoval("ls && rm -rf /", ctx).critical).toBe(true);
  });

  test("`--` ends flag parsing: rm -rf -- / is still recognized", () => {
    expect(isCriticalRemoval("rm -rf -- /", ctx).critical).toBe(true);
  });

  test("a wholly ordinary compound command is not critical", () => {
    expect(isCriticalRemoval("ls && rm ./tmp/a.txt", ctx).critical).toBe(false);
  });
});

describe("isCriticalRemoval -- unparseable/non-removal fallbacks", () => {
  test("an unparseable command (unterminated quote) still gets a best-effort scan over the raw text (stricter, never looser)", () => {
    // splitCompound returns null here; isCriticalRemoval falls back to the whole raw text as one
    // candidate rather than silently declaring "not critical" just because it can't be split. The
    // degraded tokenizer still recovers an "unterminated" operand from this specific string, but it
    // isn't one of the dangerous shapes -- correctly not critical, not a false negative masquerading
    // as one (the NEXT test proves the best-effort scan actually catches a dangerous shape).
    expect(isCriticalRemoval("rm -rf 'unterminated", ctx).critical).toBe(false);
  });

  test("an unparseable command that STILL contains a genuinely dangerous shape is caught by the best-effort scan", () => {
    expect(isCriticalRemoval("rm -rf / 'unterminated", ctx).critical).toBe(true);
  });

  test("a command that isn't rm/rmdir at all is never critical", () => {
    expect(isCriticalRemoval("cat /etc/passwd", ctx)).toEqual({ critical: false });
  });

  test("an empty command is never critical", () => {
    expect(isCriticalRemoval("", ctx)).toEqual({ critical: false });
  });
});
