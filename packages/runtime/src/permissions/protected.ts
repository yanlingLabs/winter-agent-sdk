// Task 7 (WS-07 §6.7/§6.8): protected-path writes + critical `rm`/`rmdir` removals. Both are
// "standing exceptions" (WS-07 §2 stage 5) that apply BEFORE any mode baseline or allow-rule
// resolution, in every permission mode -- the evaluator.ts seam adapters that consult these two
// primitives run first, unconditionally, per call (see evaluator.ts's own SpecialChecks wiring).
//
// Signatures mirror the brief's own bare-primitive shapes exactly: `isProtectedWrite` takes ONE
// resolved-or-resolvable path, `isCriticalRemoval` takes ONE raw command string (which may itself
// be compound) -- the WHOLE-call extraction (which tool field is "the path", whether a Bash call
// even IS a removal at all) is the evaluator.ts seam's own job (its header comment explains why).
import { resolve } from "node:path";
import { splitCompound, stripWrappers } from "./grammar.ts";
import { tokenizeWords, nonFlagOperands } from "./edit-recognition.ts";

// ---------------------------------------------------------------------------------------------
// §6.7 Protected paths -- exported data constants (extensible, capture-noted per the task brief)
// ---------------------------------------------------------------------------------------------

// WS-07 §6.7, verbatim directory list, PLUS the agent dot-dir. `.config/git` is a two-SEGMENT
// path (not a directory literally named ".config" -- that name is far too common across unrelated
// tools to protect wholesale) and is matched as a consecutive pair below, not via this flat set.
// `.winter` carries its own worktree-area exception (WS-07 §6.7: "except its worktree area" --
// `.winter/worktrees/`, WS-01 §2.4) and so is also handled specially below rather than via this set.
export const PROTECTED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);

// WS-07 §6.7's protected-FILE bullet is prose categories, not an enumerated list (unlike the
// directory table) -- report §31 / WS-07 §13 Open Question 2 explicitly acknowledge this ("the
// report... found detailed public behavior but not every internal parser/canonicalization branch")
// and license Winter to be "stricter but never looser." Curated per category below, independently
// authored (WS-07 §10.3's own "independently authored" posture for exactly this kind of
// underspecified list), capture-noted like grammar.ts's DANGEROUS_ASSIGNMENT_NAMES precedent --
// NOT confirmed exhaustive against any pinned runtime; extend here, not by restructuring the
// mechanism, the moment a differential capture (WS-17) pins a real list.
export const PROTECTED_FILE_BASENAMES: ReadonlySet<string> = new Set([
  // shell startup files
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  // package-manager / build configuration -- lockfiles weighted heaviest (the highest supply-chain
  // risk artifact: a silent lockfile edit can pin a malicious package version), then manifests
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "go.sum",
  "package.json",
  "Cargo.toml",
  "Gemfile",
  "pyproject.toml",
  "go.mod",
  // MCP project config: the UPSTREAM literal `.mcp.json` (defense in depth for an upstream-shaped
  // repo); Winter-native `.winter/mcp.json` is already covered by the `.winter` directory rule.
  ".mcp.json",
  // Winter's own root instructions/config file (WS-01 §2.4: WINTER.md is Winter's CLAUDE.md)
  "WINTER.md",
]);

function pathSegments(absPath: string): string[] {
  return absPath.split("/").filter((s) => s.length > 0);
}

function isInsideProtectedDirectory(absPath: string): boolean {
  const segments = pathSegments(absPath);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === ".config" && segments[i + 1] === "git") return true;
    if (seg === ".winter") {
      if (segments[i + 1] === "worktrees") continue; // worktree-area exception -- keep scanning deeper segments normally (a worktree's OWN .git is still protected, see the test corpus)
      return true;
    }
    if (PROTECTED_DIRECTORY_NAMES.has(seg)) return true;
  }
  return false;
}

function basenameOf(absPath: string): string {
  const idx = absPath.lastIndexOf("/");
  return idx === -1 ? absPath : absPath.slice(idx + 1);
}

// WS-07 §6.7 protects WRITES specifically ("Writes to repository/runtime configuration are not
// auto-approved") -- this primitive has no opinion on WHICH operation kind `path` came from; that
// is the evaluator.ts seam's job (it only ever calls this for a call already known to be
// write-shaped -- an Edit/Write's own file_path, or a path recognizeEditOperation extracted from a
// Bash call). A plain Read of a protected path is correctly UNAFFECTED by this primitive because
// the seam never calls it for a Read at all, not because of anything checked in here.
export function isProtectedWrite(path: string, ctx: { cwd: string; home: string }): boolean {
  const absPath = resolve(ctx.cwd, path);
  return isInsideProtectedDirectory(absPath) || PROTECTED_FILE_BASENAMES.has(basenameOf(absPath));
}

// ---------------------------------------------------------------------------------------------
// §6.8 Critical removals
// ---------------------------------------------------------------------------------------------

export interface CriticalRemovalResult {
  critical: boolean;
  reason?: string;
}

function isRootOrDirectChild(absPath: string): boolean {
  return pathSegments(absPath).length <= 1; // "/" itself (0 segments) or "/etc" (1 segment)
}

function isAncestorOfOrEqual(candidate: string, target: string): boolean {
  if (candidate === target) return true;
  return target.startsWith(candidate === "/" ? "/" : candidate + "/");
}

function expandTilde(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return home + raw.slice(1);
  return raw;
}

function resolveToken(raw: string, ctx: { cwd: string; home: string }): string {
  return resolve(ctx.cwd, expandTilde(raw, ctx.home));
}

// WS-07 §6.8: "variable-rooted globs, command substitution, and process substitution receive
// special recognition" -- we cannot statically know what a variable/substitution expands to, so
// ANY occurrence is conservative-critical (WS-07 §13: "stricter, never looser"). "Variable-rooted"
// is checked at the START of the token specifically (the spec's own phrasing); command/process
// substitution are checked anywhere in the token, since an embedded `$(...)` mid-path is just as
// unpredictable as a rooted one (e.g. `rm -rf /tmp/$(whoami)`).
function isConservativeCriticalShape(rawToken: string): string | null {
  if (rawToken.startsWith("$")) return `variable-rooted target: ${rawToken}`;
  if (rawToken.includes("$(") || rawToken.includes("`")) return `command substitution in target: ${rawToken}`;
  if (rawToken.includes("<(") || rawToken.includes(">(")) return `process substitution in target: ${rawToken}`;
  return null;
}

// A trailing "/*"/"/**" (one or more stars as the WHOLE last segment) on an ALREADY-RESOLVED
// absolute path -- returns the parent directory the glob would empty, or null if the path doesn't
// have this shape at all (mid-token stars like "a*b" are an ordinary glob, not this "delete
// everything under X" shape).
function trailingGlobParent(absPath: string): string | null {
  const m = /^(.*)\/\*+$/.exec(absPath);
  if (!m) return null;
  return m[1] === "" ? "/" : m[1]!;
}

function classifyRemovalTarget(rawToken: string, ctx: { cwd: string; home: string; additionalDirectories?: string[] }): CriticalRemovalResult {
  const conservative = isConservativeCriticalShape(rawToken);
  if (conservative !== null) return { critical: true, reason: conservative };

  const resolved = resolveToken(rawToken, ctx);
  if (isRootOrDirectChild(resolved)) return { critical: true, reason: `filesystem root or a direct child of it: ${resolved}` };
  if (resolved === ctx.home) return { critical: true, reason: "the user's home directory" };
  if (isAncestorOfOrEqual(resolved, ctx.cwd)) return { critical: true, reason: `the working directory or an ancestor of it: ${resolved}` };

  const globParent = trailingGlobParent(resolved);
  if (globParent !== null) {
    const grantedRoots = [ctx.cwd, ctx.home, ...(ctx.additionalDirectories ?? [])].map((d) => resolveToken(d, ctx));
    if (globParent === "/" || isRootOrDirectChild(globParent) || grantedRoots.includes(globParent)) {
      return { critical: true, reason: `broad glob at the top of a working/granted directory: ${rawToken}` };
    }
  }
  return { critical: false };
}

// WS-07 §6.8: "rm/rmdir targeting a critical path is NEVER silently approved." Scans the WHOLE
// (possibly compound) command: every subcommand is independently checked (mirroring the "every
// subcommand must be independently permitted" pattern elsewhere in this phase) -- ANY dangerous
// rm/rmdir anywhere in a compound command taints the whole thing, matching the deny/ask precedent.
//
// Unparseable input (`splitCompound` returns `null`) is treated as ONE candidate part -- the raw
// text itself -- rather than "no opinion": we cannot structurally decompose it, but a best-effort
// scan over the raw text can still catch an `rm -rf /` hidden behind broken quoting, and WS-07 §13
// licenses being stricter here, never looser. An empty/all-separator command (`splitCompound`
// returns `[]`, NOT `null` -- the same shape edit-recognition.ts's own header warns about) falls
// back to the identical raw-text treatment, which is harmless (an empty string tokenizes to zero
// words, so nothing is ever flagged) rather than a special-cased early return.
export function isCriticalRemoval(command: string, ctx: { cwd: string; home: string; additionalDirectories?: string[] }): CriticalRemovalResult {
  const split = splitCompound(command);
  const parts = split !== null && split.length > 0 ? split : [command];

  for (const part of parts) {
    const stripped = stripWrappers(part, "denyAsk");
    const tokens = tokenizeWords(stripped);
    if (tokens.length === 0) continue;
    const [cmd, ...rest] = tokens;
    if (cmd !== "rm" && cmd !== "rmdir") continue;
    for (const operand of nonFlagOperands(rest)) {
      const result = classifyRemovalTarget(operand, ctx);
      if (result.critical) return result;
    }
  }
  return { critical: false };
}
