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
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/**
 * P7a (D19): the three brand fields the protected-path floor needs.
 *
 * A `Pick`, and OPTIONAL at every entry point, for the same reason as everywhere else in this
 * sweep: ~30 hand-built contexts in this package's tests call these primitives directly, and
 * `WINTER_BRAND` as the default keeps every one of them byte-identical.
 */
export type ProtectedBrand = Pick<BrandProfile, "homeDirName" | "projectDirName" | "instructionsFile">;
import { splitCompound, stripWrappers } from "./grammar.ts";
import { tokenizeWords, nonFlagOperands } from "./edit-recognition.ts";

// ---------------------------------------------------------------------------------------------
// §6.7 Protected paths -- exported data constants (extensible, capture-noted per the task brief)
// ---------------------------------------------------------------------------------------------

// WS-07 §6.7, verbatim directory list, PLUS the agent dot-dir. `.config/git` is a two-SEGMENT
// path (not a directory literally named ".config" -- that name is far too common across unrelated
// tools to protect wholesale) and is matched as a consecutive pair below, not via this flat set.
// The BRAND's own dot-dir carries a worktree-area exception (WS-07 §6.7: "except its worktree area"
// -- `<projectDir>/worktrees/`, WS-01 §2.4) and so is handled specially below rather than via this
// set: it is not a fixed literal, it is `brand.projectDirName`/`brand.homeDirName`.
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
  // repo); the native `<projectDir>/mcp.json` is already covered by the dot-dir rule below.
  ".mcp.json",
  // P7a (D19): the brand's own root instructions file (WS-01 §2.4: the `CLAUDE.md` convention with
  // the session's token) is added PER CALL from the profile -- see `isProtectedWrite`. Winter's own
  // value is seeded here so every caller that threads no brand keeps exactly today's set.
  WINTER_BRAND.instructionsFile,
]);

// --- RULING P5-B: the model-writable workflow-script carve-out ------------------------------------
//
// `~/.winter/projects/<project-key>/<session-uuid>/workflows/scripts/**` is MODEL-WRITABLE. That is
// not a relaxation for convenience: WS-11 §1.3's Edit-then-rerun contract REQUIRES it -- every
// Workflow invocation persists its script to that path and returns the path in its result
// (capture (3)), and the documented iterate loop is "edit the persisted script, re-invoke with
// `scriptPath`". A model that cannot write there cannot iterate on a workflow at all.
//
// SCOPED AS TIGHTLY AS THE CONTRACT ALLOWS, and the shape is the enforcement: the subtree must be
// EXACTLY `<home>/.winter/projects/<key>/<uuid>/workflows/scripts/...` -- six fixed positions with
// exactly two wildcards between them. A `projects/**/workflows/scripts` style match would let a
// session write into another session's area by nesting; a prefix match on `workflows/scripts` alone
// would open one anywhere under `projects/`. Everything else under `projects/` -- the JSONL
// transcripts a resume rebuilds from, the roster sidecars, the provider-state sidecars -- stays
// write-denied by the M13 baseline rules (engine.ts's buildBaselineDenyRules) and by this module.
const WINTER_PROJECTS_SEGMENT = "projects";
const WORKFLOW_SCRIPTS_SEGMENTS = ["workflows", "scripts"] as const;

/**
 * True when `absPath` is inside a session's own persisted-workflow-script directory under `home`.
 *
 * Takes an ALREADY-ABSOLUTE path (every caller here resolves first) and `home` explicitly -- this
 * module resolves no environment of its own, matching `isProtectedWrite`'s existing `ctx.home`
 * contract.
 */
export function isWorkflowScriptCarveOut(absPath: string, home: string, resolvedWinterHome?: string, brand?: ProtectedBrand): boolean {
  // Phase 5 fix wave, I1: the carve-out must name the directory a script is ACTUALLY persisted to.
  // `workflows/store.ts` writes under `<winterHome>/projects/...`; this function compared against
  // `<osHome>/<homeDirName>/projects/...`. Under a `<PREFIX>HOME` pointing elsewhere the two disagreed, and
  // the edit-then-rerun loop WS-11 §1.3 documents worked only because nothing denied the real
  // location either -- which the companion floor in `buildBaselineDenyRules` now does, so the
  // carve-out has to follow or the loop breaks as collateral damage.
  if (resolvedWinterHome !== undefined && matchesCarveOut(pathSegments(absPath), [...pathSegments(resolve(resolvedWinterHome)), WINTER_PROJECTS_SEGMENT])) return true;
  const homeSegments = pathSegments(resolve(home));
  const segments = pathSegments(absPath);
  // Must start with <home>/<homeDirName>/projects/<key>/<uuid>/workflows/scripts/ and have at least one
  // more segment after it (the script file itself) -- the DIRECTORY is not itself writable, only its
  // contents, so a `Write` targeting the directory path is still denied.
  return matchesCarveOut(segments, [...homeSegments, (brand ?? WINTER_BRAND).homeDirName, WINTER_PROJECTS_SEGMENT]);
}

/**
 * `<prefix>/<project-key>/<session-uuid>/workflows/scripts/<file>` -- the shape, factored so the two
 * anchors (the OS-home one and the resolved-root one) cannot drift apart.
 *
 * SIX FIXED POSITIONS WITH EXACTLY TWO WILDCARDS BETWEEN THEM, unchanged: a `projects/**` style
 * match would let a session write into another session's area by nesting, and a prefix match on
 * `workflows/scripts` alone would open one anywhere under `projects/`.
 */
function matchesCarveOut(segments: readonly string[], prefix: readonly string[]): boolean {
  // The DIRECTORY itself is not writable -- only its contents -- so at least one segment must follow.
  if (segments.length < prefix.length + 2 + WORKFLOW_SCRIPTS_SEGMENTS.length + 1) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (segments[i] !== prefix[i]) return false;
  }
  const scriptsStart = prefix.length + 2;
  for (let i = 0; i < WORKFLOW_SCRIPTS_SEGMENTS.length; i++) {
    if (segments[scriptsStart + i] !== WORKFLOW_SCRIPTS_SEGMENTS[i]) return false;
  }
  return true;
}

function pathSegments(absPath: string): string[] {
  return absPath.split("/").filter((s) => s.length > 0);
}

function isInsideProtectedDirectory(absPath: string, brand: ProtectedBrand): boolean {
  const segments = pathSegments(absPath);
  // Both dot-dirs, because they are independently configurable: `homeDirName` names the winter root
  // and `projectDirName` the per-repository one, and Winter's own profile happens to make them the
  // same string. A reuser who splits them must have BOTH protected.
  const ownDirs = new Set([brand.projectDirName, brand.homeDirName]);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === ".config" && segments[i + 1] === "git") return true;
    if (ownDirs.has(seg)) {
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
export function isProtectedWrite(path: string, ctx: { cwd: string; home: string; winterHome?: string; brand?: ProtectedBrand }): boolean {
  const brand = ctx.brand ?? WINTER_BRAND;
  const absPath = resolve(ctx.cwd, path);
  // RULING P5-B: checked FIRST, because the carve-out lives INSIDE the brand's own dot-dir, which
  // `isInsideProtectedDirectory` would otherwise reject unconditionally. Same shape as the
  // pre-existing worktree-area exception one function down, and for the same reason: a subtree
  // the agent is meant to work in cannot also be protected from it.
  if (isWorkflowScriptCarveOut(absPath, ctx.home, ctx.winterHome, brand)) return false;
  const basename = basenameOf(absPath);
  // The instructions file is brand-derived, so it is matched from the PROFILE as well as from the
  // seeded default set -- a reuser's ACME.md must be as protected as Winter's own file is.
  return isInsideProtectedDirectory(absPath, brand) || PROTECTED_FILE_BASENAMES.has(basename) || basename === brand.instructionsFile;
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
    // `ctx.cwd` is listed explicitly because a direct caller of isCriticalRemoval (e.g. this
    // module's own unit tests) may pass no `additionalDirectories` at all -- but the SEAM caller
    // (evaluator.ts's REAL_SPECIAL_CHECKS.isCriticalRemoval) already threads `boundedRoots(ctx)` in
    // as `additionalDirectories`, which itself starts with cwd -- deduped via Set so cwd is never
    // checked twice (cosmetic only; `.includes()` is idempotent to duplicates either way).
    const grantedRoots = [...new Set([ctx.cwd, ctx.home, ...(ctx.additionalDirectories ?? [])])].map((d) => resolveToken(d, ctx));
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
