// Task 3 (Lane C, WS-12 "Sandbox & execution"): macOS Seatbelt (SBPL) profile GENERATION. Pure
// string-building only -- no fs stat, no child_process, no platform branching -- so this module
// stays exercisable on Linux CI (profile.test.ts is "pure generation, linux-safe" per the task
// brief). Everything platform-specific (resolving the real per-user temp dir via `getconf`,
// checking /usr/bin/sandbox-exec, actually spawning) lives in ./spawn.ts, which is this module's
// only intended production caller.
//
// PORT, NOT REWRITE (WS-12 §5.2: "MUST survive the port verbatim, Winter-renamed"). This is a
// direct port of Norma's `packages/core/src/agent/sandbox.ts` (report evidence cited by WS-12's own
// header) -- every carried rule below is copied for its BEHAVIOR, not reinvented: the mktemp
// direct-children allowance, the three control-plane filename denies (literal-per-root +
// any-depth case-folded regex), and the canonicalize-with-graceful-fallback discipline all reproduce
// Norma's hard-won fixes verbatim, renamed to the brand's own dot-dir per WS-01 §2.4. New at cutover
// (WS-12 §5.3, not present in Norma): `denyWrite`/`denyRead` layers driven by §2's `SandboxSettings`
// (Norma only ever took a fixed roots list), and the workflow-worker profile is exported from here
// too (WS-12 §5.2 "carries over for the workflow subprocess") even though no caller wires a real
// workflow worker to it yet in this phase -- WS-11 is a later phase; this ships the tested
// mechanism now, exactly as T1 shipped `buildAdvertisedSet` before anything called it.
import { join } from "node:path";
import { WINTER_BRAND, globalConfigFileName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/**
 * P7a (D19): the two dot-dir names the seatbelt fences. `homeDirName` anchors the winter root under
 * the OS home (the run-dir read deny, the backups write deny, the provider-state read deny);
 * `projectDirName` anchors the per-writable-root control plane (WS-12 §5.2's carve-out).
 */
export type SandboxBrand = Pick<BrandProfile, "homeDirName" | "projectDirName">;
import { resolveRealTarget } from "../permissions/paths.ts";
import { ancestorDirectoriesOf, recursiveGlobToSbplRegexSource, type GlobDenyEntry } from "../permissions/file-rules.ts";

// ---------------------------------------------------------------------------------------------
// WS-12 §2: the CC-shaped configuration surface, verbatim.
// ---------------------------------------------------------------------------------------------

export interface SandboxFilesystemSettings {
  allowWrite?: string[];
  denyWrite?: string[];
  // `allowRead` (WS-21 fix round 10, item C): carried for structural parity with `SandboxSettingsConfig`
  // (protocol/config.ts, whose own header requires the two stay in sync) -- NOT YET consumed by
  // `buildSeatbeltProfile` below, which has no "allow re-permit within an otherwise-denied read
  // region" SBPL mechanism at all. See that type's own doc comment for the full disclosed-gap
  // rationale (fails closed: an unenforced allowRead simply leaves the outer denyRead in effect).
  allowRead?: string[];
  denyRead?: string[];
  /**
   * Fix round 16, item 2: `sandbox.filesystem.allowGitConfig` in settings.json (default false) -- when
   * true, a sandboxed command may write `.git/config`. The ONE settings-facing door for
   * `SeatbeltProfileInput.allowGitConfigWrites`/`RunCommandOptions.allowGitConfigWrites`, which this
   * module and spawn.ts already had (round 15) but nothing set. Wired through
   * `tools/impl/{bash,monitor}.ts`'s own options-builders (each reads
   * `ctx.sandboxSettings.filesystem?.allowGitConfig` directly) -- `buildSeatbeltProfile` itself never
   * reads this field; it is CONSUMED at the caller boundary (spawn.ts's own `allowGitConfigWrites`
   * param), matching every other filesystem key's own "settings shape carries it, a caller resolves
   * it into the profile-builder's own dedicated param" pattern in this file.
   */
  allowGitConfig?: boolean;
}

// WS-12 §12 open question 1: v1 enforces a boolean network posture only (Seatbelt filters by
// socket class, not hostname) -- `allowedDomains`/`deniedDomains` are ACCEPTED by this type (the
// full CC-shaped schema, §2, MUST parse) but REJECTED at resolution time (resolveNetworkPosture,
// below) with a typed unsupported-capability error rather than silently flattened to a boolean.
// The index signature is what lets "local-binding policy, Unix socket policy, proxy ports" (§2's
// own parenthetical) parse without this type knowing their shapes; v1 does not enforce any of them
// (§12 open question 1's own "advertises boolean network control only").
export interface SandboxNetworkSettings {
  allowedDomains?: string[];
  deniedDomains?: string[];
  [key: string]: unknown;
}

export interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  filesystem?: SandboxFilesystemSettings;
  network?: SandboxNetworkSettings;
}

// A reasonable, documented default for a session with no real configured SandboxSettings.
// N1 (fix wave, P3 close-out): STALE as of T8 -- "nothing upstream threads a real one through yet"
// was accurate when this module was first written; it no longer is. RuntimeConfig.sandbox
// (SandboxSettingsConfig, protocol/config.ts) and ToolExecutionContext.sandboxSettings
// (registry.ts) both exist, and engine.ts's own buildDefaultToolExecutor resolves
// `config.sandbox ?? DEFAULT_SANDBOX_SETTINGS` once per run -- this constant is now specifically
// the "session configured nothing" fallback, not a placeholder awaiting a real wire field. Sandbox
// ON, network denied, no exclusions -- the same safe posture Norma shipped as its own hardcoded
// default (`allowNetwork` defaulting false in agent/sandbox.ts).
export const DEFAULT_SANDBOX_SETTINGS: Readonly<SandboxSettings> = Object.freeze({ enabled: true });

// WS-12 §2/§12: "a config carrying domain lists is rejected with a typed unsupported-capability
// error rather than being flattened to a boolean." A named class (not a plain Error) so a caller
// can `instanceof` it specifically -- e.g. to map it onto a distinct tool-result posture rather
// than a generic execution failure.
export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

// Resolves §2's `network` config to the boolean posture the Seatbelt profile can actually enforce
// (§5.1: "network denied unless the effective config allows it"). Judgment call, flagged per this
// module's own header: the printed §2 sketch has no explicit "allow all" field on the `network`
// object (only domain lists, which are rejected, plus an open index signature for knobs v1 does not
// implement) -- with no real producer of SandboxSettings anywhere in this phase to observe, this
// resolves conservatively (fails CLOSED) for every shape except "no network config at all," which
// is also closed. The enforcement PROOF this spec actually requires ("network boolean posture...
// fully enforced," WS-12 §2 table) lives one level down, in `buildSeatbeltProfile`'s own
// `allowNetwork: boolean` parameter (tested directly against real sandbox-exec via a loopback probe
// in spawn.test.ts/deny.darwin.test.ts) -- this function is this module's own best-effort mapping
// from the pinned config shape to that boolean, not itself a pinned contract. A future WS-17
// differential capture that pins a real "allow" trigger on this object is a one-line change here.
export function resolveNetworkPosture(network: SandboxNetworkSettings | undefined): boolean {
  if (network === undefined) return false;
  if (network.allowedDomains !== undefined || network.deniedDomains !== undefined) {
    throw new SandboxConfigError(
      "sandbox.network.allowedDomains/deniedDomains are not supported in v1 (WS-12 §2, §12 open question 1): " +
        "Seatbelt filters by socket class, not hostname, and Winter has no filtering proxy yet. " +
        "Configure a plain allow-all/deny-all network posture instead of a domain list.",
    );
  }
  // Capture-pending (R3-6 precedent): an object with only unmodeled knobs (local-binding policy,
  // Unix socket policy, proxy ports) resolves to DENY rather than a guessed ALLOW -- see this
  // function's own header.
  return false;
}

// ---------------------------------------------------------------------------------------------
// SBPL escaping helpers (verbatim port of Norma's sbplString/sbplRegexLiteral)
// ---------------------------------------------------------------------------------------------

/** Escape a path for embedding inside an SBPL double-quoted string literal. */
function sbplString(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a string for embedding inside an SBPL `(regex #"...")` literal. */
function sbplRegexLiteral(p: string): string {
  return p.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&").replace(/"/g, '\\"');
}

/**
 * Fix round 11: escapes ONLY the `"` delimiter, for a string that is ALREADY compiled regex source
 * (`globToSbplRegexSource`/`recursiveGlobToSbplRegexSource`, permissions/file-rules.ts) and must
 * reach the SBPL `(regex #"...")` literal with its own backslash-escapes UNTOUCHED -- unlike
 * `sbplString` (which doubles every backslash, correct for a PLAIN string literal's own escaping
 * rules but wrong here: it would turn this regex's `\.` into `\\.`, changing its meaning) and unlike
 * `sbplRegexLiteral` (which escapes regex metacharacters too, correct for embedding a literal PATH as
 * fixed prefix text inside a hand-built regex, but wrong here: this text is already regex syntax, not
 * a literal to be escaped INTO regex syntax).
 */
function escapeSbplRegexDelimiter(r: string): string {
  return r.replace(/"/g, '\\"');
}

// realpath a path if it exists (canonicalizes macOS /tmp and /var symlinks); fall through to the
// raw path otherwise -- WS-12 §5.2 "graceful fall-through" is a MUST, so this catches EVERY error
// (not just ENOENT: `resolveRealTarget` itself re-throws a non-ENOENT failure encountered mid-walk,
// e.g. EACCES on an intermediate ancestor -- see that function's own header) rather than letting one
// odd root crash profile generation for an entire session. `resolveRealTarget` (permissions/paths.ts,
// Task 4/WS-07) is REUSED rather than re-implemented: it is strictly better than Norma's own
// `canon()` for a not-yet-existing path (it walks up to the nearest existing ancestor and
// canonicalizes THAT, instead of giving up the moment the full path doesn't exist outright) --
// exactly the "macOS /tmp and /var are symlinks; un-canonicalized rules silently miss" case WS-12
// §5.2 calls out.
export function canonicalizePath(p: string): string {
  try {
    return resolveRealTarget(p);
  } catch {
    return p;
  }
}
// Local alias -- keeps every call site below exactly as short as Norma's original `canon(...)`
// while the export above gives spawn.ts (the darwin-temp-dir resolver) the SAME graceful-fallback
// canonicalization, rather than a second, independently-maintained copy.
const canon = canonicalizePath;

// Clause renderers shared by the blocks below.
const subpathClause = (p: string): string => `(subpath "${sbplString(p)}")`;
const literalClause = (p: string): string => `(literal "${sbplString(p)}")`;
const regexClause = (source: string): string => `(regex #"${escapeSbplRegexDelimiter(source)}")`;

/**
 * Collects clauses for one multi-line block, keeping each distinct clause once at the position it was
 * first added, and renders them under a header: two-space indented lines, the closing `)` on the last
 * one. An empty collection renders as "" so the caller's slot is left blank.
 */
class ClauseBlock {
  private readonly seen = new Set<string>();
  private readonly clauses: string[] = [];

  add(clause: string): void {
    if (this.seen.has(clause)) return;
    this.seen.add(clause);
    this.clauses.push(clause);
  }

  render(header: string): string {
    if (this.clauses.length === 0) return "";
    const lines = this.clauses.map((c) => `  ${c}`);
    lines[lines.length - 1] += ")";
    return [header, ...lines].join("\n");
  }
}

/** Fix round 12: the ancestor-rename fence -- denies create/unlink of each denied path and of every directory above it. */
function buildAncestorRenameBypassBlock(plainDenyPaths: readonly string[], globFixedPrefixes: readonly string[]): string {
  const block = new ClauseBlock();
  // A plain denied path: the path itself (and everything below it), then each enclosing directory.
  for (const entry of plainDenyPaths) {
    const path = canon(entry);
    block.add(subpathClause(path));
    for (const dir of ancestorDirectoriesOf(path)) block.add(literalClause(dir));
  }
  // A glob's fixed prefix arrives already resolved by the caller and is used exactly as given: the
  // prefix directory itself, then each enclosing directory.
  for (const prefix of globFixedPrefixes) {
    block.add(literalClause(prefix));
    for (const dir of ancestorDirectoriesOf(prefix)) block.add(literalClause(dir));
  }
  return block.render("(deny file-write-unlink file-write-create");
}

/** Fix round 14: re-allows create/unlink inside every write root, after the read-side fence. */
function buildReadDenyWritePermitBlock(writableRoots: readonly string[]): string {
  const block = new ClauseBlock();
  for (const root of writableRoots) block.add(subpathClause(root));
  return block.render("(allow file-write-unlink file-write-create");
}

// Not emitted, deliberately: a blanket `(allow file-read-metadata (vnode-type DIRECTORY))` for sessions
// with read denies. It would not close any gap this profile has (the `touch`/`cp` case
// `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`'s header discusses concerns a denied FILE's own metadata),
// and widening what metadata reads reach on a read-denied session is a security-relevant change that
// needs its own ruling.

/** The runtime's image working directory under the winter/store home (tools/image-prep.ts) -- write-denied to the shell. */
export const IMAGE_PREP_DIRNAME = "image-prep";

/**
 * Fix round 14 (Winter hardening, found with real `sandbox-exec` runs while adding
 * `buildReadDenyWritePermitBlock`): that block is a blanket
 * `(allow file-write-unlink file-write-create (subpath <every write root>))`. Seatbelt gives a clause
 * that names `file-write-unlink`/`file-write-create` EXPLICITLY priority over one that reaches those
 * operations only through the `file-write*` wildcard, whichever comes first or last in the file -- so an
 * EARLIER explicit allow is not overridden by a LATER `(deny file-write* ...)` for the same target.
 *
 * Every Winter write-protection floor that used only the `file-write*` wildcard was therefore punched
 * through for CREATE and UNLINK/RENAME (never for `file-write-data`, `file-write-mode`, etc., which the
 * re-permit does not name): the control-plane carve-outs (WS-12 §5.2's "the seatbelt is the only
 * enforcement point left" floor -- measured: `mkdir -p .winter && echo '{}' > .winter/permissions.local.json`
 * and `rm .winter/settings.json` both SUCCEEDED against the unpatched profile), the checkpoint/backup
 * store write-deny (T8 rider 25), and a GLOB-shaped `denyWrite` entry (a plain `denyWritePaths` entry
 * was already safe: the write-side ancestor-rename fence names it explicitly; the fence's glob half only
 * names the fixed-prefix DIRECTORY, never the glob-matched files).
 *
 * The fix, verified against real `sandbox-exec` (a `(deny file-write* file-write-unlink
 * file-write-create (regex ...))` clause DOES win back the CREATE it needs): every one of those floors
 * names `file-write-unlink`/`file-write-create` EXPLICITLY alongside the `file-write*` wildcard -- this
 * constant is that shared operation list. The keep-in-place block (`buildReadDenyKeepInPlaceBlock`)
 * already names `file-write-unlink` explicitly and never `create` (it must allow creating a read-denied
 * path's name, only not removing an existing one), so it is not in the affected set.
 */
const WRITE_OPS_SURVIVING_READ_DENY_REPERMIT = "file-write* file-write-unlink file-write-create";

/**
 * Fix round 15: the default write protections. A sandboxed Bash command must not be able to plant
 * something that runs again OUTSIDE the sandbox on a later turn -- a git hook, `core.fsmonitor` in
 * `.git/config`, an `.mcp.json` server, a shell rc file -- so these entries are denied unconditionally,
 * with no opt-in flag to forget (`.git/config` alone can be exempted, `allowGitConfigWrites`).
 *
 * Nine bare shell/git/MCP config filenames, matched case-sensitively (unlike this module's own
 * `<projectDir>`/`settings.json` control-plane regexes, which are case-folded).
 */
const DEFAULT_PROTECTED_FILES = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"] as const;

/**
 * Editor and agent folders protected recursively. `.claude/commands`/`.claude/agents` keep claude's
 * literal spelling (blocking writes into a repo's `.claude/` is harmless, and WS-21 wants that dir
 * untouched anyway); the brand's own `<projectDir>` equivalents are covered separately
 * (`PROJECT_DIR_PROTECTED_KINDS`), never substituted for this spelling, so a rebranded product's dot-dir
 * is covered too.
 */
const DEFAULT_PROTECTED_DIRS = [".vscode", ".idea", ".claude/commands", ".claude/agents"] as const;

/**
 * The directories under the brand's own `projectDirName` that are protected the same way:
 * `commands`/`agents` (round 15, the counterpart of `.claude/commands`/`.claude/agents`) and, fix round
 * 17 (R.3 C-1 part 2b, spec §7.2), `skills`/`rules`/`output-styles` -- the trusted project's
 * `<projectDir>/{skills,commands,rules,output-styles}/**` load into every future session.
 */
const PROJECT_DIR_PROTECTED_KINDS = ["commands", "agents", "skills", "rules", "output-styles"] as const;

/** Fix rounds 15-17: the default write protections, anchored at cwd (plain and any-depth forms, plus their ancestor-rename fence). */
function buildDefaultWriteProtectionBlock(cwd: string, brand: SandboxBrand, allowGitConfigWrites: boolean): string {
  const proj = brand.projectDirName;
  // Each protected entry is a path relative to cwd; a directory entry also covers everything below it.
  const entries: { rel: string; isDir: boolean }[] = [
    ...DEFAULT_PROTECTED_FILES.map((rel) => ({ rel, isDir: false })),
    { rel: `${proj}/mcp.json`, isDir: false },
    ...DEFAULT_PROTECTED_DIRS.map((rel) => ({ rel, isDir: true })),
    ...PROJECT_DIR_PROTECTED_KINDS.map((kind) => ({ rel: `${proj}/${kind}`, isDir: true })),
    { rel: ".git/hooks", isDir: true },
    ...(allowGitConfigWrites ? [] : [{ rel: ".git/config", isDir: false }]),
  ];

  const plainPaths = entries.map((e) => join(cwd, e.rel));
  // The any-depth form: the same name anywhere under cwd (a nested repository, a sub-project).
  const regexSources = entries.map((e) => {
    const anyDepth = join(cwd, "**", e.rel);
    return recursiveGlobToSbplRegexSource(e.isDir ? `${anyDepth}/**` : anyDepth);
  });

  const lines = [
    ...plainPaths.map((p) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} ${subpathClause(canon(p))})`),
    ...regexSources.map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} ${regexClause(r)})`),
    buildAncestorRenameBypassBlock(plainPaths, []),
  ];
  return lines.join("\n");
}

/** True when `candidate` lies strictly inside `root` (equality excluded). */
function isProperDescendantOf(candidate: string, root: string): boolean {
  if (root === "/") return candidate !== "/" && candidate.startsWith("/");
  return candidate !== root && candidate.startsWith(`${root}/`);
}

/**
 * Wraps a base clause so it does not apply inside any of the carve-out directories (write roots nested
 * inside a denied path stay fully usable). No carve-outs leaves the base clause unchanged.
 */
function withCarveOuts(base: string, carveOuts: readonly string[]): string {
  if (carveOuts.length === 0) return base;
  const exclusions = carveOuts.map((x) => `(require-not ${subpathClause(x)})`).join(" ");
  return `(require-all ${base} ${exclusions})`;
}

/** Fix round 13: denies unlinking (and so renaming away) read-denied paths that sit inside a write root. */
function buildReadDenyKeepInPlaceBlock(plainDenyReadPaths: readonly string[], globDenyReadEntries: readonly GlobDenyEntry[], writableRoots: readonly string[]): string {
  if (writableRoots.length === 0) return "";
  const insideSomeRoot = (p: string): boolean => writableRoots.some((root) => isProperDescendantOf(p, root));
  const block = new ClauseBlock();

  for (const entry of plainDenyReadPaths) {
    const path = canon(entry);
    if (!insideSomeRoot(path)) continue;
    const nestedRoots = writableRoots.filter((root) => isProperDescendantOf(root, path));
    block.add(withCarveOuts(subpathClause(path), nestedRoots));
    for (const dir of ancestorDirectoriesOf(path)) {
      if (insideSomeRoot(dir)) block.add(literalClause(dir));
    }
  }

  for (const { regex, fixedPrefix } of globDenyReadEntries) {
    const prefix = fixedPrefix;
    const relates = writableRoots.some((root) => prefix === root || isProperDescendantOf(prefix, root) || isProperDescendantOf(root, prefix));
    if (!relates) continue;
    // Only compiled for an entry that relates to a root; an invalid pattern propagates its SyntaxError.
    const compiled = new RegExp(regex);
    const matchedRoots = writableRoots.filter((root) => compiled.test(root));
    block.add(withCarveOuts(regexClause(regex), matchedRoots));
    if (prefix !== "/") {
      for (const dir of [prefix, ...ancestorDirectoriesOf(prefix)]) {
        if (insideSomeRoot(dir)) block.add(literalClause(dir));
      }
    }
  }

  return block.render("(deny file-write-unlink");
}

// ---------------------------------------------------------------------------------------------
// Control-plane file denies (WS-12 §5.2, carried verbatim, Winter-renamed)
// ---------------------------------------------------------------------------------------------

const CONTROL_PLANE_FILES = ["permissions.local.json", "settings.json", "settings.local.json"] as const;

// Per-character case-folding classes -- SBPL's regex engine does not honor `(?i)` (verified against
// real sandbox-exec by the Norma original: with `(?i)` the write sailed through) and the default
// macOS volume is case-insensitive, so `.WINTER/Settings.json` reaches the same file a case-exact
// regex would miss. Three SEPARATE regexes, never merged by alternation (WS-12 §5.2: "never merged
// by alternation -- only the per-character-class form is verified").

/**
 * P7a fix r1 (Important-1): render ONE brand token as a case-insensitive, regex-escaped SBPL literal.
 *
 * The three any-depth control-plane regexes below used to hard-code `[Ww][Ii][Nn][Tt][Ee][Rr]` while
 * the per-root LITERAL denies beside them already derived from `brand.projectDirName`. WS-12 §5.2
 * names those regexes as the closure for the nested-store hole -- a broad writable parent makes
 * `<parent>/proj/<dot-dir>/settings.json` writable with no literal deny for it -- and §5.2 also
 * records that the seatbelt is the ONLY enforcement point left for a bash-invoked write to the
 * permission control plane. Hard-coded, they fenced a directory a reuser's product never reads while
 * leaving the reuser's own control plane open to `echo x > <root>/<nested>/.acme/settings.json`.
 *
 * ESCAPE FIRST, FOLD SECOND, per character: a letter becomes `[Xx]`, and everything else is escaped
 * exactly as `sbplRegexLiteral` escapes it (the brand grammar admits `-` and, for a dot-dir, the
 * leading `.` -- which MUST be escaped or it matches any character). Applied to Winter's own dot-dir
 * it renders `\.[Ww][Ii][Nn][Tt][Ee][Rr]`, exactly what the constant it replaces spelled, so
 * the rendered profile is unchanged under `WINTER_BRAND` (a test diffs the whole profile text).
 *
 * Exported so the deny suite can assert the rendering directly rather than by reading the profile.
 */
export function caseFoldSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (/[A-Za-z]/.test(ch)) out += `[${ch.toUpperCase()}${ch.toLowerCase()}]`;
    else out += sbplRegexLiteral(ch);
  }
  return out;
}

const PERMISSIONS_CF = "[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]";
const SETTINGS_CF = "[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]";
const LOCAL_CF = "[Ll][Oo][Cc][Aa][Ll]";
const JSON_CF = "[Jj][Ss][Oo][Nn]";

/**
 * The three control-plane regexes for ONE dot-dir name (P7a fix r1). A function, not a constant,
 * because the segment is `brand.projectDirName` / `brand.homeDirName` and both arrive per session.
 *
 * STILL THREE SEPARATE REGEXES, never merged by alternation -- WS-12 §5.2 is categorical about that
 * and only the per-character-class form is verified against real `sandbox-exec`.
 */
function controlPlaneRegexes(dotDir: string): { rules: string; settings: string; settingsLocal: string } {
  const dir = caseFoldSegment(dotDir);
  return {
    rules: String.raw`/${dir}/${PERMISSIONS_CF}\.${LOCAL_CF}\.${JSON_CF}$`,
    settings: String.raw`/${dir}/${SETTINGS_CF}\.${JSON_CF}$`,
    settingsLocal: String.raw`/${dir}/${SETTINGS_CF}\.${LOCAL_CF}\.${JSON_CF}$`,
  };
}
// Phase 6 Task 3 (R6-7's P4-M MUST): the provider-state sidecar filename, case-folded per character
// for exactly the reason above -- SBPL ignores `(?i)` and the default macOS volume is
// case-insensitive, so `Sess-1.Provider-State.JSONL` reaches the same file a case-exact regex misses.
const PROVIDER_CF = "[Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr]";
const STATE_CF = "[Ss][Tt][Aa][Tt][Ee]";
const JSONL_CF = "[Jj][Ss][Oo][Nn][Ll]";
const PROJECTS_CF = "[Pp][Rr][Oo][Jj][Ee][Cc][Tt][Ss]";
// ANCHORED AT THE PROJECTS ROOT, never at the filename globally: a user's own
// `~/notes/foo.provider-state.jsonl` is their file, and a bare-suffix regex would deny reading it.
// `<projectsRoot>` is interpolated per call because it depends on the resolved winter root.
// The `projects` SEGMENT is case-folded too, for the same reason the filename is: this rule owns
// that segment in both anchors, and on a case-insensitive volume `.../Projects/s.provider-state.jsonl`
// reaches the same file. The root prefix above it is left exactly as resolved -- identical posture to
// the run-dir and backups denies in this file, which anchor on the resolved path verbatim.
const providerStateReadDenyRegex = (winterRootRegexSafe: string): string =>
  String.raw`^${winterRootRegexSafe}/${PROJECTS_CF}/.*\.${PROVIDER_CF}-${STATE_CF}\.${JSONL_CF}$`;

/**
 * Fix round 17 (R.3 I-2, a WS-21 regression): the SDK's own write floor on its OWN homes.
 *
 * `00717d9` moved the default home to `~/<homeDirName>/sdk` (`resolveWinterHome`, WS-21 §6.3 item 8),
 * and under the router `winterHome` is the per-run folder and `storeHome` the shared home. Neither is
 * a folder NAMED `<homeDirName>`, so the per-root control-plane literals (`<root>/<projectDir>/<file>`)
 * and the any-depth control-plane regexes (`/<dot-dir>/settings.json$`) never reach a settings file
 * directly under them, and nothing named the global config file at all. Measured by the R.3 reviewer
 * with cwd = home and no host deny list: `<home>/<homeDirName>/settings.json` blocked, but
 * `<home>/<homeDirName>/sdk/settings.json` and `<home>/<homeDirName>/sdk/<globalConfigFile>` WRITTEN
 * by a sandboxed command. Under the daemon both are already in its `sandboxConfigFor` deny list; this
 * is the floor for a standalone run or a third-party host, which have no such list.
 *
 * For each of `winterHome` and `storeHome` (canonicalized, deduped when they are the same directory):
 * `(literal …)` denies on `settings.json`, `settings.local.json` and the global config file
 * (`globalConfigFileName(brand)`, `<homeDirName>.json`: claude's `.claude.json` in shape, spec §6.3
 * item 3), and `(subpath …)` denies on `agents/` and `plugins/` -- the self-grant surface spec §7.1's
 * write table lists for the home. Every clause uses `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`, so round
 * 14's read-deny re-permit cannot punch through it (that constant's own header). Winter's own floor:
 * claude's config dir is outside its sandbox's write roots unless a user makes it one; this is
 * Winter's standing "the seatbelt is the only enforcement point left for a shell-invoked write to the
 * control plane" floor (WS-12 §5.2), carried onto the homes WS-21 introduced.
 */
function buildHomeSelfGrantFloor(anchors: readonly (string | undefined)[], brand: SandboxBrand): string {
  const roots = [...new Set(anchors.filter((a): a is string => a !== undefined && a.length > 0).map(canon))];
  const files = ["settings.json", "settings.local.json", globalConfigFileName(brand)];
  const dirs = ["agents", "plugins"];
  const denies = roots.flatMap((root) => [
    ...files.map((f) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (literal "${sbplString(join(root, f))}"))`),
    ...dirs.map((d) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(join(root, d))}"))`),
  ]);
  // Fix round 18 (the R.3 re-review of round 17): every floor path ALSO feeds the ancestor-rename
  // fence (`buildAncestorRenameBypassBlock`), like every other deny list in this profile: each path's
  // own subpath, plus every ancestor as a `(literal …)`, denied `file-write-unlink`/`file-write-create`.
  // Without it the floor named the files but not the home folder holding them, so `mv <home> <home>2 &&
  // echo … > <home>2/settings.json && mv <home>2 <home>` rewrote the settings file (measured, the
  // reviewer's `sdkhome-rename.ts`: exit 0). The consequence, as for any fenced path: a sandboxed command
  // cannot create, remove or rename `winterHome`/`storeHome` or any of their ancestors; files inside them
  // are unaffected.
  const fence = buildAncestorRenameBypassBlock(roots.flatMap((root) => [...files, ...dirs].map((name) => join(root, name))), []);
  return [...denies, fence].filter((s) => s.length > 0).join("\n");
}

// ---------------------------------------------------------------------------------------------
// buildSeatbeltProfile
// ---------------------------------------------------------------------------------------------

export interface SeatbeltProfileInput {
  /** The session's own working directory -- always a writable root. */
  cwd: string;
  /** Extra writable subpaths: session scratch (ctx.tempDir), configured filesystem.allowWrite, outputs dir, etc. */
  writableRoots?: string[];
  /** WS-12 §5.3: filesystem.denyWrite, layered AFTER the write-allow block (last-match-wins). */
  denyWritePaths?: string[];
  /** WS-12 §5.3: filesystem.denyRead, layered AFTER the read-allow block (last-match-wins). */
  denyReadPaths?: string[];
  /**
   * Fix round 11: glob-shaped deny entries, PRE-CONVERTED by the caller to SBPL regex SOURCE TEXT
   * (`permissions/file-rules.ts`'s `globToSbplRegexSource`/`recursiveGlobToSbplRegexSource`/
   * `splitDenyPathsByGlobShape`) -- this module has no glob grammar of its own (mirrors
   * `denyWritePaths`/`denyReadPaths`'s own "already resolved by the caller" posture) and only
   * quotes/renders. A glob-shaped deny renders as `(regex ...)` and a plain one as `(subpath ...)`, as
   * claude's macOS sandbox does; a `subpath` deny alone -- Winter's pre-round-11 posture -- silently
   * dropped a glob-shaped Edit deny (e.g. a globstar-anchored `.env` pattern) or `denyWrite` entry from
   * the sandbox layer entirely (the PERMISSION-RULE layer still enforced it for a recognized tool call;
   * a bash-invoked `tee`/`cp` bypassing that layer did not).
   */
  denyWriteRegexes?: string[];
  denyReadRegexes?: string[];
  /**
   * Fix round 12: the ancestor-rename fence. `denyWriteGlobFixedPrefixes`/`denyReadGlobFixedPrefixes`
   * are the CANONICALIZED fixed-prefix directory of each glob-shaped denyWrite/denyRead entry
   * (`permissions/file-rules.ts`'s `splitDenyPathsByGlobShape`, its own `globFixedPrefixes` output) --
   * this module has no glob grammar of its own, mirrors the other caller-pre-resolved fields above.
   * Combined with `denyWritePaths`/`denyReadPaths` (the PLAIN entries, reused directly),
   * `buildAncestorRenameBypassBlock` builds a `(deny file-write-unlink file-write-create ...)` clause
   * naming every ANCESTOR of each denied path/glob-fixed-prefix, PLUS the fixed prefix itself, so a
   * sandboxed `mv <ancestor> <elsewhere> && <write inside where it used to be> && mv <elsewhere>
   * <ancestor>` cannot rename an ancestor of a denied path out of the way (and back) to slip a write
   * past the deny.
   */
  denyWriteGlobFixedPrefixes?: string[];
  denyReadGlobFixedPrefixes?: string[];
  /**
   * Fix round 13: "keep read-denied paths inside write roots in place." The write-allow block
   * (`(allow file-write* (subpath <root>))`) is emitted AFTER the read-deny section and, last match
   * winning, overrode a read-deny's implicit protection against being UNLINKED (renamed away): with
   * `Read(.env)` denied and cwd writable, a sandboxed `mv .env x && cat x` renamed the read-denied file
   * to a new, non-denied name and read the secret through it. claude closes this too. A third section,
   * emitted AFTER the write-allow block (`buildReadDenyKeepInPlaceBlock`), denies `file-write-unlink`
   * for each read-denied path (or glob-shaped entry, this field) that sits inside a write root -- minus
   * any write root nested INSIDE it, carved back out -- and for each of its ancestor directories that is
   * ALSO inside a write root. Each entry pairs the glob's regex with its own fixed prefix.
   */
  denyReadGlobEntries?: GlobDenyEntry[];
  /** Resolved network posture -- see resolveNetworkPosture's own header for why this is a plain boolean here. */
  allowNetwork: boolean;
  /**
   * The real per-user temp dir (`confstr(_CS_DARWIN_USER_TEMP_DIR)`, exposed by `getconf
   * DARWIN_USER_TEMP_DIR` -- resolved by spawn.ts, never by this module, to keep profile.ts
   * platform-free). Omitted entirely -> the mktemp convenience rule is simply not emitted, which is
   * still a CORRECT (if less ergonomic) profile -- mirrors Norma's own "a profile without this
   * convenience rule is still a correct profile" comment.
   */
  darwinUserTempDir?: string;
  /**
   * WS-12 §2: "the sole baseline read denial is `<home>/<homeDirName>/run`, enforced via profile
   * deny rules layered over allow-read." The daemon's own runtime dir (control socket, PID/lock
   * files) -- a bash-invoked `cat ~/<homeDirName>/run/core.sock` never passes through a read-tool's own
   * permission fence at all (reads are otherwise deliberately unrestricted, per this product's own
   * tool-surface design), so the seatbelt profile is the only enforcement point left. Omitted
   * entirely -> no baseline deny is emitted, still a correct (if less defended) profile -- mirrors
   * `darwinUserTempDir`'s own "omitted is still correct" posture; there is no ToolExecutionContext
   * seam this module can reach into itself (profile.ts stays platform/context-free by design, per
   * this file's own header), so every caller (spawn.ts -> tools/impl/{bash,monitor}.ts) is
   * responsible for threading its own `ctx.home` through.
   */
  home?: string;
  /**
   * Phase 5 fix wave, I1: the RESOLVED winter root (`<PREFIX>HOME` when set), when it differs
   * from `<home>/<homeDirName>`.
   *
   * `home` above is the OS home and this module appends `brand.homeDirName` to it -- correct only
   * when the resolved root is literally named that. Under a `<PREFIX>HOME` pointing anywhere
   * else, the run read-deny and the backups write-deny both landed on a directory that does not
   * exist while the real one stayed open.
   *
   * ADDED, NEVER SWAPPED: both anchors are emitted, because the carried WS-12 §5.2 deny corpus and
   * every default-home session still assume the literal default, and two denies of overlapping scope
   * cost nothing.
   */
  winterHome?: string;
  /**
   * WS-21 §3.7/§6.3 item 11: the shared runtime home's durable-paths root (`config.storeHome`),
   * preferred over `winterHome` for the two DURABLE denies below -- the checkpoint (backups) write
   * deny and the provider-state read deny, both of which protect `projects/`-rooted content that
   * lives under the store home once the router links `buildRunHome`, a directory now DISTINCT from
   * the per-run folder `winterHome` names. The run-dir read deny is left anchored on `winterHome`
   * unchanged: it protects the daemon's own `run/` (sockets, pidfiles), which is neither the
   * per-run folder nor the store home in the WS-21 layout, so this module has no better anchor for
   * it than it already had -- a disclosed, unchanged limitation, not a regression.
   */
  storeHome?: string;
  /**
   * P7a (D19): the brand whose dot-dir and project dot-dir this profile fences.
   *
   * Every winter-owned path segment below is `brand.homeDirName` (the root under the OS home) or
   * `brand.projectDirName` (the per-writable-root control plane). Omitted = `WINTER_BRAND`, so a
   * caller that threads none emits byte-identical SBPL -- which is what the carried WS-12 §5.2 deny
   * corpus and the darwin deny suite assert.
   */
  brand?: SandboxBrand;
  /**
   * Fix round 15: when true, `.git/config` is NOT among the default write-protected entries
   * (`buildDefaultWriteProtectionBlock`) -- every OTHER default protection (shell/tool config files,
   * editor/agent dot-dirs, `.git/hooks`) is unaffected; this flag only ever gates `.git/config`.
   * Omitted = `false` = protected, claude's default too. Set from `sandbox.filesystem.allowGitConfig`
   * (round 16).
   */
  allowGitConfigWrites?: boolean;
}

/**
 * Build a macOS Seatbelt (SBPL) profile: deny-by-default, read anywhere (minus configured
 * denyRead layers and, when `home` is given, the WS-12 §2 baseline `<home>/<homeDirName>/run` denial --
 * see `SeatbeltProfileInput.home`'s own header), write only under the given roots (minus configured
 * denyWrite layers), network denied unless explicitly allowed.
 *
 * WS-12 §5.2 (verbatim carry, Winter-renamed): EVERY writable root (cwd + each of `writableRoots`)
 * additionally gets an explicit `(deny <ops> (literal "<root>/<projectDir>/<file>"))` line, for
 * each of `permissions.local.json`/`settings.json`/`settings.local.json`, unconditionally, with no
 * opt-in flag to forget -- a bash-invoked `echo x > <projectDir>/permissions.local.json` never passes
 * through a write/edit TOOL's own permission fence at all, so the seatbelt is the only enforcement
 * point left for a shell-invoked write to the permission/settings control plane. SBPL evaluates a
 * profile's rules for a given operation in FILE ORDER, last-match-wins, WITH ONE EMPIRICALLY-VERIFIED
 * EXCEPTION (fix round 14, `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`'s own header): a clause naming
 * `file-write-unlink`/`file-write-create` EXPLICITLY beats one that only reaches them via the
 * `file-write*` wildcard, independent of file order -- which is why `<ops>` here is
 * `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT` (`file-write* file-write-unlink file-write-create`), not a
 * bare `file-write*`, since round 14 added an EARLIER, blanket, explicit-named re-permit
 * (`buildReadDenyWritePermitBlock`) that a bare-wildcard deny here would no longer survive. Ordinary
 * last-match-wins still governs every OTHER write operation (`file-write-data`, etc.) and governs
 * `<ops>` vs. `<ops>` ties among explicit-named clauses -- placing these denies AFTER the
 * `(allow file-write* (subpath ...))` block carves out exactly these files from an otherwise-writable
 * subpath, without touching a sibling file or an entire OTHER subdirectory like the MEMDIR.
 *
 * A companion `(deny <ops> (regex ...))` per filename, placed after the per-root literals, closes
 * the NESTED-store hole a literal-only deny misses: a broad `writableRoots` entry makes a nested
 * `<root>/projB/<projectDir>/settings.json` writable too, with no literal deny naming that exact
 * path. Case-folded per character (see the module-level regex constants' own comment).
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const brand = input.brand ?? WINTER_BRAND;
  // WS-21 §3.7: the two DURABLE denies (backups/checkpoint write, provider-state read) prefer the
  // shared store home -- see `SeatbeltProfileInput.storeHome`'s own header. The run-dir read deny
  // stays on `input.winterHome`, unchanged.
  const durableRoot = input.storeHome ?? input.winterHome;
  const roots = [input.cwd, ...(input.writableRoots ?? [])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");

  const denyRulesFileRules = roots
    .flatMap((r) => CONTROL_PLANE_FILES.map((f) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (literal "${sbplString(canon(join(r, brand.projectDirName, f)))}"))`))
    .join("\n");
  // P7a fix r1 (Important-1): the any-depth companions to the per-root literals above, now derived.
  //
  // BOTH dot-dir names, deduped, and for the same reason `isInsideProtectedDirectory` checks both
  // (permissions/protected.ts): `homeDirName` and `projectDirName` are independently configurable
  // and a control-plane file exists under each -- the user tier's `settings.json` under the winter
  // root, the project tier's under the repository's dot-dir. Winter's own profile makes them the
  // same string, so exactly one set is emitted and the default profile is byte-identical.
  const controlPlaneDirs = [...new Set([brand.projectDirName, brand.homeDirName])];
  const controlPlane = controlPlaneDirs.map(controlPlaneRegexes);
  const denyRulesFileRegex = controlPlane.map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (regex #"${r.rules}"))`).join("\n");
  const denySettingsFileRegex = controlPlane.map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (regex #"${r.settings}"))`).join("\n");
  const denySettingsLocalFileRegex = controlPlane.map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (regex #"${r.settingsLocal}"))`).join("\n");

  // WS-12 §5.3 (new at cutover): user-configured filesystem.denyWrite/denyRead, rendered as
  // (subpath ...) denies -- UNLIKE the control-plane carve-outs above (filename-literal/regex
  // only), a user-supplied entry is an arbitrary path the user intends to protect wholesale
  // (typically a directory), so it gets the SAME subpath shape the write-allow block itself uses.
  // Placed after the allow blocks (last-match-wins) but BEFORE the mktemp allowance and the
  // control-plane denies, so neither carried protection can be defeated by a user's own denyWrite
  // entry happening to shadow them.
  const denyWriteRules = (input.denyWritePaths ?? []).map((p) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(p))}"))`).join("\n");
  const denyReadRules = (input.denyReadPaths ?? []).map((p) => `(deny file-read* (subpath "${sbplString(canon(p))}"))`).join("\n");

  // Fix round 11: the GLOB-shaped siblings of the two rules just above -- `(regex #"...")` rather than
  // `(subpath ...)`, since SBPL's `subpath` operator has no glob grammar of its own and would otherwise
  // treat e.g. `**/.env` as a LITERAL directory name (matching nothing real). The caller has already
  // converted these to regex SOURCE TEXT (`permissions/file-rules.ts`'s `splitDenyPathsByGlobShape`, the
  // recursive form -- "and everything under it," matching `subpath`'s own implicit recursive semantics).
  //
  // Deliberately NOT `sbplString()`-quoted -- discovered empirically (a real darwin sandbox-exec
  // test went GREEN for the `subpath` siblings but silently failed to block for these until this was
  // fixed): `sbplString` doubles every backslash for a PLAIN `"..."` string literal's own escaping
  // rules, but an SBPL `(regex #"...")` literal's content is NOT run through that same unescaping --
  // doubling turns this regex's own `\.` (an escaped literal dot) into `\\.` (a literal backslash
  // followed by "any character"), which no longer means what the regex intends. This module's OWN
  // pre-existing regex clauses (`controlPlaneRegexes`/`providerStateReadDenyRegex`, above) already
  // establish the real convention: a `(regex #"...")` clause's content is embedded WITH NO
  // backslash-doubling at all -- only the outer `#"..."` quote character itself needs escaping, which
  // `escapeSbplRegexDelimiter` (below) does and nothing else.
  //
  // Deliberately NOT `canon()`-ed HERE -- there is no real filesystem path in the REGEX TEXT ITSELF to
  // canonicalize (it is already a compiled regex pattern, wildcards included). The glob's own fixed
  // PREFIX IS canonicalized, through a real symlink and guarded against suspicious resolutions, one
  // level upstream before conversion (`permissions/file-rules.ts`'s `canonicalizeGlobFixedPrefix`/
  // `isSuspiciousRealpathResolution`).
  const denyWriteRegexRules = (input.denyWriteRegexes ?? []).map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (regex #"${escapeSbplRegexDelimiter(r)}"))`).join("\n");
  const denyReadRegexRules = (input.denyReadRegexes ?? []).map((r) => `(deny file-read* (regex #"${escapeSbplRegexDelimiter(r)}"))`).join("\n");

  // Fix round 12: the ancestor-rename fence. For EVERY write-denied path (plain OR glob-shaped) and
  // EVERY read-denied path, additionally deny `file-write-unlink`/`file-write-create` on the denied path
  // itself (or a glob's own fixed prefix) and on every ANCESTOR directory of it -- so a sandboxed
  // `mv <ancestor> <elsewhere> && echo x > <where the ancestor used to be>/... && mv <elsewhere>
  // <ancestor>` cannot rename an ancestor out of the way (and back) to slip a write past the deny. The
  // write side and the read side each get their own block, built from their own deny lists.
  const denyWriteAncestorRenameBlock = buildAncestorRenameBypassBlock(input.denyWritePaths ?? [], input.denyWriteGlobFixedPrefixes ?? []);
  const denyReadAncestorRenameBlock = buildAncestorRenameBypassBlock(input.denyReadPaths ?? [], input.denyReadGlobFixedPrefixes ?? []);

  // Fix round 14: the write-root create/unlink re-permit -- see `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`'s
  // header. Reuses the SAME canonicalized `roots` array the write-allow block below builds.
  const denyReadWritePermitBlock = buildReadDenyWritePermitBlock(roots);

  // Fix round 15: the default write protections -- see `DEFAULT_PROTECTED_FILES`'s header.
  const defaultWriteProtectionBlock = buildDefaultWriteProtectionBlock(input.cwd, brand, input.allowGitConfigWrites ?? false);

  // Fix round 13: emitted AFTER the write-allow block (`roots`/`writeRules`, above) -- see
  // `SeatbeltProfileInput.denyReadGlobEntries`'s header for the rationale.
  const denyReadKeepInPlaceBlock = buildReadDenyKeepInPlaceBlock(input.denyReadPaths ?? [], input.denyReadGlobEntries ?? [], roots);

  // WS-12 §2: "the sole baseline read denial is <home>/<homeDirName>/run" -- a subpath deny (not a
  // filename literal/regex like the control-plane carve-outs above): the WHOLE directory tree is
  // off-limits, not one specific filename within it. Placed AFTER the user-configured denyReadRules
  // (this file's own placement convention: a carried/baseline protection sits after user config, so
  // a user's own denyRead entries can never accidentally reorder around it) -- though for two
  // DENY rules of possibly-overlapping scope, unlike an allow/deny pair, relative order does not
  // change which paths end up denied; this ordering is for readability/convention, not correctness.
  const denyRunDirRule = [
    input.home ? `(deny file-read* (subpath "${sbplString(canon(join(input.home, brand.homeDirName, "run")))}"))` : "",
    // I1: the resolved root's own run directory, when it is not `<home>/<homeDirName>`.
    input.winterHome && canon(input.winterHome) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny file-read* (subpath "${sbplString(canon(join(input.winterHome, "run")))}"))` : "",
  ]
    .filter((r) => r.length > 0)
    .join("\n");

  // T8 rider 25 (SECURITY): the checkpoint BACKUP STORE, write-side. `<home>/<homeDirName>/file-history/`
  // (renamed from `backups/`, WS-21 §6.3 item 6 fix round 1 -- see this rule's own header below)
  // holds the pre-image bytes a `rewind_files` writes back over the user's own files, plus the
  // `index.jsonl` that says which files those bytes go to. The managed permission floor
  // (engine.ts's buildBaselineDenyRules) binds a Write/Edit/NotebookEdit TOOL call -- but a
  // bash-invoked `echo x >> ~/<homeDirName>/file-history/<s>/index.jsonl` never passes through a
  // write tool's fence at all, so the seatbelt is the only enforcement point left. Exactly the reasoning WS-12
  // §5.2's control-plane carve-out already records for the project `permissions.local.json`, applied to
  // a store whose whole purpose is to be replayed over the user's files later.
  //
  // A `(subpath ...)` deny, like the run-dir read deny above and unlike the control-plane
  // filename literals: the WHOLE tree is off-limits, not one filename within it. Only load-bearing
  // when `home` is itself inside a writable root (cwd == home, or a writableRoots entry above it) --
  // otherwise `(deny default)` already covers it, and an unconditional deny costs nothing.
  // Phase 6 Task 3 (R6-7's P4-M MUST): the provider-state sidecars, READ-side.
  //
  // A bash-invoked `cat ~/<homeDirName>/projects/<key>/sess-1.provider-state.jsonl` never passes through a
  // read TOOL's permission fence at all -- reads are otherwise deliberately unrestricted in this
  // product -- so the seatbelt is the only enforcement point left for a shell-invoked read of the one
  // file that holds opaque provider state. Exactly the reasoning WS-12 §2 already records for
  // the run directory, applied to a file whose whole purpose is to hold what the model must not see.
  //
  // A REGEX ON THE FILENAME UNDER THE PROJECTS ROOT, never a `(subpath ...)` deny of the projects tree
  // -- a subpath deny would also block `cat`-ing a transcript, regressing the model-facing `.output`
  // stub contract that M13's own read-side scoping decision exists to preserve.
  const denyProviderStateReadRule = [
    input.home ? `(deny file-read* (regex #"${providerStateReadDenyRegex(sbplRegexLiteral(canon(join(input.home, brand.homeDirName))))}"))` : "",
    // The RESOLVED root's own projects directory, when it is not `<home>/<homeDirName>` (Phase 5 fix
    // wave I1). WS-21 §3.7: `durableRoot` prefers `storeHome` -- see this function's own header.
    durableRoot && canon(durableRoot) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny file-read* (regex #"${providerStateReadDenyRegex(sbplRegexLiteral(canon(durableRoot)))}"))` : "",
  ]
    .filter((r) => r.length > 0)
    .join("\n");

  // WS-21 §6.3 item 6, fix round 1: renamed from "backups" here. The checkpoint store's own on-disk
  // dirname (`checkpoint/file-history.ts`'s `CHECKPOINT_BACKUPS_DIRNAME`) is a separate constant,
  // owned by lane L1b, which renames it to match -- until both land the two are momentarily out of
  // step; see this fix round's report.
  // Code-mode images: the runtime's own image working directory, `<root>/image-prep/` (tools/image-prep.ts's
  // `IMAGE_PREP_DIRNAME`). The runtime writes a copy of an image there and runs `sips` on it, reading the
  // result back; a sandboxed shell that could plant a link there (a symlink named like `sips`'s output)
  // would make `sips` write through it. So the whole tree is off-limits to the shell -- the same subpath
  // deny, anchors and precedence as `file-history/` below -- and the runtime never works under the
  // session temp dir, which the shell CAN write.
  const denyImagePrepDirRule = [
    input.home ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(input.home, brand.homeDirName, IMAGE_PREP_DIRNAME)))}"))` : "",
    durableRoot && canon(durableRoot) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(durableRoot, IMAGE_PREP_DIRNAME)))}"))` : "",
    input.winterHome && canon(input.winterHome) !== canon(join(input.home ?? "", brand.homeDirName)) && canon(input.winterHome) !== (durableRoot ? canon(durableRoot) : "")
      ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(input.winterHome, IMAGE_PREP_DIRNAME)))}"))`
      : "",
  ]
    .filter((r) => r.length > 0)
    .join("\n");

  const denyBackupsDirRule = [
    input.home ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(input.home, brand.homeDirName, "file-history")))}"))` : "",
    // I1: same reasoning as the run deny above -- the store the sink actually writes to is the
    // RESOLVED root's `file-history/`, which is what `checkpoint/sink.ts` has always used. WS-21
    // §3.7: `durableRoot` prefers `storeHome`.
    durableRoot && canon(durableRoot) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(durableRoot, "file-history")))}"))` : "",
  ]
    .filter((r) => r.length > 0)
    .join("\n");

  // Fix round 17 (R.3 I-2): see `buildHomeSelfGrantFloor`'s own header.
  const denyHomeSelfGrantRules = buildHomeSelfGrantFloor([input.winterHome, input.storeHome], brand);

  // WS-12 §5.2 (verbatim carry): macOS `mktemp(1)` (and anything else calling
  // confstr(_CS_DARWIN_USER_TEMP_DIR)) writes to the PER-USER temp dir and ignores $TMPDIR
  // entirely -- without this rule bare `mktemp` dies "Operation not permitted," which is enough to
  // fail an ordinary `git commit` whenever a hook shells out to it. DIRECT CHILDREN ONLY
  // (`[^/]+$`): a `(subpath ...)` here would be a real fence regression, and it is also the exact
  // shape the deny suite's own "outside the fence" assertions build two levels down in this same
  // directory. Placed BEFORE the control-plane denies so SBPL's last-match-wins keeps those denies
  // structurally overriding (no control-plane file can be a direct child of this dir anyway --
  // they all sit under the project dot-dir -- but the ordering makes that structural rather than
  // incidental).
  const allowDarwinTempFiles = input.darwinUserTempDir
    ? `(allow file-write* (regex #"^${sbplRegexLiteral(input.darwinUserTempDir)}/[^/]+$"))`
    : "";

  const network = input.allowNetwork ? "(allow network*)" : "(deny network*)";

  // Minimal mach services: deny blanket lookup so open/launchctl/osascript can't ask a privileged,
  // unsandboxed service to act out-of-band on our behalf.
  const machRules = [
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.CoreServices.coreservicesd",
    // Resolves per-user temp/cache dir paths for confstr(_CS_DARWIN_USER_TEMP_DIR/_CACHE_DIR),
    // which xcrun/git-CLT-stubs (and swift, xcodebuild) call into on every invocation. Without
    // this, those tools still exit 0 but spam stderr with confstr()/DVT FSEvents noise that reads
    // like a real failure. Grants no spawning -- safe, defense-in-depth stays intact.
    "com.apple.bsd.dirhelper",
  ]
    .map((s) => `  (global-name "${sbplString(s)}")`)
    .join("\n");

  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup
${machRules})
(allow file-read*)
${denyReadRules}
${denyReadRegexRules}
${denyReadAncestorRenameBlock}
${denyReadWritePermitBlock}
${denyRunDirRule}
${denyProviderStateReadRule}
(allow file-write*
${writeRules})
${denyWriteRules}
${denyWriteRegexRules}
${denyWriteAncestorRenameBlock}
${defaultWriteProtectionBlock}
${denyReadKeepInPlaceBlock}
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr") (path "/dev/dtracehelper"))
${allowDarwinTempFiles}
${network}
${denyBackupsDirRule}
${denyImagePrepDirRule}
${denyHomeSelfGrantRules}
${denyRulesFileRules}
${denyRulesFileRegex}
${denySettingsFileRegex}
${denySettingsLocalFileRegex}
`;
}

// ---------------------------------------------------------------------------------------------
// buildWorkflowWorkerSeatbeltProfile (WS-12 §5.2 "carries over for the workflow subprocess")
// ---------------------------------------------------------------------------------------------

/**
 * Tight Seatbelt profile for a workflow-worker subprocess (WS-11 §1.7's own consumer -- that phase
 * has not shipped a real worker yet; this ships the tested mechanism now, verbatim-ported from
 * Norma's `workflows/sandbox.ts`). Strictly tighter than the ordinary Bash profile:
 *   - deny file-write* EVERYWHERE (the worker writes nothing; the journal is appended parent-side),
 *   - deny network*,
 *   - deny process-fork AND allow process-exec ONLY for the self binary.
 *
 * Part B item 2 (fix wave, P3 close-out) -- THE READ-AXIS CARRY IS NOW CLOSED (Phase 5 Task 3,
 * R5-5: "the P3 worker seatbelt profile PLUS the ledgered run-directory deny"). `opts.home`, when
 * supplied, emits the same baseline `<home>/<homeDirName>/run` read-deny rule the ordinary Bash profile
 * carries (buildSeatbeltProfile's own `home` field), making this profile a strict superset of that
 * one's denials on every axis.
 *
 * `opts` is REQUIRED and `opts.home` is `string | undefined` -- NOT an optional property (fix round
 * 1): "Lane W's spawner must remember to pass it" is exactly the obligation that gets forgotten, and
 * an optional parameter makes forgetting compile. Making the argument mandatory while allowing an
 * explicit `undefined` turns the silent gap into a compile error at every call site, and leaves the
 * genuinely home-less callers (profile.test.ts, the string-shape half of the darwin suite) able to
 * state that they mean it. A profile built with `{ home: undefined }` is still correct, just less
 * defended -- exactly as buildSeatbeltProfile documents for its own `home`.
 *
 * THE #1 RISK (verified empirically by the Norma original): a blanket `(deny process-exec*)` makes
 * sandbox-exec's own execvp() of the target fail ("Operation not permitted"), because the
 * sandbox->target transition is itself an exec checked against the profile. So this allows exec of
 * EXACTLY `selfExecPath` (canonicalized) and nothing else -- enough for the runtime binary to boot
 * (it dyld-loads its libs via the allowed file-read*), while a workflow script still cannot exec
 * /bin/sh etc. Note the operation is `process-fork` (no star) -- `process-fork*` is an unbound
 * variable that fails to load.
 */
export function buildWorkflowWorkerSeatbeltProfile(selfExecPath: string, opts: { home: string | undefined; winterHome?: string; brand?: SandboxBrand }): string {
  const brand = opts.brand ?? WINTER_BRAND;
  const self = canon(selfExecPath);
  // Placed with the other denies (below), after `(allow file-read*)`, so SBPL's last-match-wins makes
  // it actually bind -- emitted before the blanket read-allow it would be dead text.
  // Phase 5 fix wave, I1: BOTH anchors. `opts.home` is the OS home and this appends
  // `brand.homeDirName`; `opts.winterHome` is the RESOLVED root, which is where a real session's run
  // directory actually is when `<PREFIX>HOME` points anywhere else. Emitted together for the reason
  // `SeatbeltProfileInput.winterHome` states: two denies of overlapping scope cost nothing, and
  // swapping would unprotect every default-home session.
  const denyRunDirRule = [
    opts.home !== undefined ? `\n(deny file-read* (subpath "${sbplString(canon(join(opts.home, brand.homeDirName, "run")))}"))` : "",
    opts.winterHome !== undefined && canon(opts.winterHome) !== canon(join(opts.home ?? "", brand.homeDirName))
      ? `\n(deny file-read* (subpath "${sbplString(canon(join(opts.winterHome, "run")))}"))`
      : "",
  ].join("");
  const machRules = [
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.CoreServices.coreservicesd",
    "com.apple.bsd.dirhelper",
  ]
    .map((s) => `  (global-name "${sbplString(s)}")`)
    .join("\n");
  return `(version 1)
(deny default)
(allow process-exec (literal "${sbplString(self)}"))
(deny process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup
${machRules})
(allow file-read*)${denyRunDirRule}
(deny file-write*)
(deny network*)
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr"))
`;
}
