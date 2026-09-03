// WS-06 §3.1 "Glob" -- the real executor (Phase 3, Lane A / Task 4). Registers over the stub
// descriptors/glob.ts already put in the registry.
//
// *** T8 SCHEMA-SWEEP NOTE (flag in task-4-report.md) ***
// WS-06 §3.1 pins Glob's input verbatim but only describes the result in prose ("max 100 paths,
// modification-time ordered, truncation/total metadata"). Choices made here, none pinned anywhere
// in scope:
//   - Result shape: a plain newline-separated list of ABSOLUTE paths (mirrors both Norma's own
//     precedent, packages/core/src/agent/tools/fs-read.ts, and Claude Code's own observable Glob
//     output), with an appended bracketed note ONLY when truncated -- that note carries BOTH the
//     truncation fact and the real total, which is the only place §3.1's "truncation/total
//     metadata" phrase plausibly requires total to be surfaced at all (an untruncated result's
//     total is just the number of lines already shown). No JSON envelope: unlike Read, Glob never
//     carries a non-text block type, so the envelope machinery that file needs has nothing to do
//     here.
//   - Sort DIRECTION (newest-first vs. oldest-first) is not pinned by the prose at all; newest-
//     first is chosen (matches this task's own recollection of Claude Code's real Glob behavior --
//     surfacing recently-touched files first) and pinned by a test below.
//   - `.gitignore NOT applied by default (environment-changeable)`: the "environment-changeable"
//     aside names no env var anywhere in scope (WS-01's naming/env-var map does not mention one
//     either) -- implemented as "never applied," full stop; no toggle exists to honor.
//   - Hidden files/directories (dotfiles): Glob's own spec paragraph discusses NO filtering axis
//     other than gitignore (which is explicitly OFF by default) -- read as "show everything by
//     default" in spirit, so `dot: true` is passed to Bun.Glob's scan (Grep, by contrast, is
//     "ripgrep-style" and hides dotfiles by default -- a deliberately different choice, made in
//     that file).
//   - `onlyFiles: true` (directories are never themselves a match) -- mirrors Norma's own Glob
//     precedent; WS-06 does not discuss directory matches at all.
//
// I1 (fix wave, P3 close-out): ctx.permissions.probeReadAccess IS now used (see execute() below) --
// the standing evaluator gates the CALL itself (its own `path` input field) before this executor
// ever runs, but that is not a traversal guard: a scan rooted OUTSIDE a denied subtree can still
// discover matches INSIDE one. This executor's own probeReadAccess filter is what closes that.
import "../descriptors/index.ts";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { emptyPathSet, type ExtractedPaths } from "../paths-seam.ts";

interface GlobInput {
  pattern: string;
  path?: string;
}

function parseInput(raw: unknown): GlobInput {
  if (typeof raw !== "object" || raw === null) throw new Error("input must be an object");
  const o = raw as Record<string, unknown>;
  const pattern = o["pattern"];
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("pattern must be a non-empty string");
  const path = o["path"];
  if (path !== undefined && typeof path !== "string") throw new Error("path must be a string");
  return { pattern, ...(path !== undefined ? { path } : {}) };
}

const MAX_PATHS = 100;

// Bun's Glob.scan ignores `cwd` for an absolute PATTERN and yields absolute paths directly --
// joining those onto scanRoot would fabricate a bogus in-root path (Norma's own fs-read.ts carries
// this exact lesson, credited in this task's report). Only join a RELATIVE yielded match; an
// absolute yielded match is used as-is. This is keyed off the yielded string `p`, not off whether
// the pattern itself looked absolute -- the same test Norma's own `combine()` applies.
async function scan(pattern: string, scanRoot: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const out = new Set<string>();
  for await (const p of glob.scan({ cwd: scanRoot, onlyFiles: true, dot: true, followSymlinks: false })) {
    out.add(isAbsolute(p) ? resolve(p) : resolve(scanRoot, p));
  }
  return [...out];
}

async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: GlobInput;
  try {
    input = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  const scanRoot = input.path !== undefined ? resolve(ctx.cwd, input.path) : ctx.cwd;
  try {
    const rootStat = statSync(scanRoot);
    if (!rootStat.isDirectory()) {
      return { output: `Error: path is not a directory: ${input.path ?? scanRoot}`, isError: true };
    }
  } catch {
    return { output: `Error: path not found: ${input.path ?? scanRoot}`, isError: true };
  }

  let matched: string[];
  try {
    matched = await scan(input.pattern, scanRoot);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  // I1 (fix wave, P3 close-out): see grep.ts's identical filter for the full rationale -- a
  // rule-matched `path` FIELD deny (the baseline `~/.winter/run` denial included) is not a
  // traversal guard; a broad `Glob({pattern:"**/*", path:"<home>"})` would otherwise still surface
  // matches from inside a denied subtree it never named directly.
  matched = matched.filter((p) => ctx.permissions.probeReadAccess(p) !== "deny");

  const withMtime = matched.map((p) => {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      // Vanished between scan and stat (a real, if rare, TOCTOU race) -- sorts to the back
      // (mtimeMs=0) rather than dropping the match or aborting the whole call.
    }
    return { p, mtimeMs };
  });
  // Newest first; ties (including the mtimeMs=0 stat-failure bucket) broken by path for a
  // deterministic, testable order.
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs || a.p.localeCompare(b.p));

  const total = withMtime.length;
  const truncated = total > MAX_PATHS;
  const shown = withMtime.slice(0, MAX_PATHS).map((x) => x.p);

  let body = shown.join("\n");
  if (truncated) {
    body += (shown.length > 0 ? "\n\n" : "") + `[Truncated to ${MAX_PATHS} of ${total} total matches, sorted by modification time (newest first). Narrow the pattern or path for a smaller result.]`;
  }
  return { output: body };
}

const globExecutor: ToolExecutor = { execute };

// RULING P3-F (fix round 1): returns the RAW input-derived string, UNRESOLVED -- no process.cwd()
// baked in here anymore. This seam's signature (registry.ts's `RegisteredTool.extractPaths`,
// `(input) => {reads,writes}`) carries no ctx/cwd parameter; the eventual CONSUMER resolves each
// candidate against its own session ctx.cwd (the seam-level contract itself lands at T8). Absent
// `path` -> emptyPathSet() -- there is no raw string to derive when the caller never supplied one;
// synthesizing a "." or a resolved default would be exactly the kind of baked-in assumption this
// ruling retires.
function extractGlobPaths(input: unknown): ExtractedPaths {
  const path = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["path"] : undefined;
  if (typeof path !== "string" || path.length === 0) return emptyPathSet();
  return { reads: [path], writes: [] };
}

replaceExecutor("Glob", globExecutor, extractGlobPaths);
