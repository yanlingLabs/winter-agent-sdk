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
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/**
 * P7a (D19): the two dot-dir names the seatbelt fences. `homeDirName` anchors the winter root under
 * the OS home (the run-dir read deny, the backups write deny, the provider-state read deny);
 * `projectDirName` anchors the per-writable-root control plane (WS-12 §5.2's carve-out).
 */
export type SandboxBrand = Pick<BrandProfile, "homeDirName" | "projectDirName">;
import { resolveRealTarget } from "../permissions/paths.ts";

// ---------------------------------------------------------------------------------------------
// WS-12 §2: the CC-shaped configuration surface, verbatim.
// ---------------------------------------------------------------------------------------------

export interface SandboxFilesystemSettings {
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
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
 * leading `.` -- which MUST be escaped or it matches any character). `caseFoldSegment(".winter")` is
 * `\.[Ww][Ii][Nn][Tt][Ee][Rr]`, byte for byte what the constant it replaces spelled, so the rendered
 * profile is unchanged under `WINTER_BRAND` (a test diffs the whole profile text).
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
   * P7a (D19): the brand whose dot-dir and project dot-dir this profile fences.
   *
   * Every winter-owned path segment below is `brand.homeDirName` (the root under the OS home) or
   * `brand.projectDirName` (the per-writable-root control plane). Omitted = `WINTER_BRAND`, so a
   * caller that threads none emits byte-identical SBPL -- which is what the carried WS-12 §5.2 deny
   * corpus and the darwin deny suite assert.
   */
  brand?: SandboxBrand;
}

/**
 * Build a macOS Seatbelt (SBPL) profile: deny-by-default, read anywhere (minus configured
 * denyRead layers and, when `home` is given, the WS-12 §2 baseline `<home>/<homeDirName>/run` denial --
 * see `SeatbeltProfileInput.home`'s own header), write only under the given roots (minus configured
 * denyWrite layers), network denied unless explicitly allowed.
 *
 * WS-12 §5.2 (verbatim carry, Winter-renamed): EVERY writable root (cwd + each of `writableRoots`)
 * additionally gets an explicit `(deny file-write* (literal "<root>/<projectDir>/<file>"))` line, for
 * each of `permissions.local.json`/`settings.json`/`settings.local.json`, unconditionally, with no
 * opt-in flag to forget -- a bash-invoked `echo x > <projectDir>/permissions.local.json` never passes
 * through a write/edit TOOL's own permission fence at all, so the seatbelt is the only enforcement
 * point left for a shell-invoked write to the permission/settings control plane. SBPL evaluates a
 * profile's rules for a given operation in FILE ORDER, last-match-wins (verified against real
 * sandbox-exec) -- placing these denies AFTER the `(allow file-write* (subpath ...))` block carves
 * out exactly these files from an otherwise-writable subpath, without touching a sibling file or an
 * entire OTHER subdirectory like the MEMDIR.
 *
 * A companion `(deny file-write* (regex ...))` per filename, placed after the per-root literals,
 * closes the NESTED-store hole a literal-only deny misses: a broad `writableRoots` entry makes a
 * nested `<root>/projB/<projectDir>/settings.json` writable too, with no literal deny naming that exact
 * path. Case-folded per character (see the module-level regex constants' own comment).
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const brand = input.brand ?? WINTER_BRAND;
  const roots = [input.cwd, ...(input.writableRoots ?? [])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");

  const denyRulesFileRules = roots
    .flatMap((r) => CONTROL_PLANE_FILES.map((f) => `(deny file-write* (literal "${sbplString(canon(join(r, brand.projectDirName, f)))}"))`))
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
  const denyRulesFileRegex = controlPlane.map((r) => `(deny file-write* (regex #"${r.rules}"))`).join("\n");
  const denySettingsFileRegex = controlPlane.map((r) => `(deny file-write* (regex #"${r.settings}"))`).join("\n");
  const denySettingsLocalFileRegex = controlPlane.map((r) => `(deny file-write* (regex #"${r.settingsLocal}"))`).join("\n");

  // WS-12 §5.3 (new at cutover): user-configured filesystem.denyWrite/denyRead, rendered as
  // (subpath ...) denies -- UNLIKE the control-plane carve-outs above (filename-literal/regex
  // only), a user-supplied entry is an arbitrary path the user intends to protect wholesale
  // (typically a directory), so it gets the SAME subpath shape the write-allow block itself uses.
  // Placed after the allow blocks (last-match-wins) but BEFORE the mktemp allowance and the
  // control-plane denies, so neither carried protection can be defeated by a user's own denyWrite
  // entry happening to shadow them.
  const denyWriteRules = (input.denyWritePaths ?? []).map((p) => `(deny file-write* (subpath "${sbplString(canon(p))}"))`).join("\n");
  const denyReadRules = (input.denyReadPaths ?? []).map((p) => `(deny file-read* (subpath "${sbplString(canon(p))}"))`).join("\n");

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

  // T8 rider 25 (SECURITY): the checkpoint BACKUP STORE, write-side. `<home>/<homeDirName>/backups/`
  // holds the pre-image bytes a `rewind_files` writes back over the user's own files, plus the
  // `index.jsonl` that says which files those bytes go to. The managed permission floor
  // (engine.ts's buildBaselineDenyRules) binds a Write/Edit/NotebookEdit TOOL call -- but a
  // bash-invoked `echo x >> ~/<homeDirName>/backups/<s>/index.jsonl` never passes through a write tool's
  // fence at all, so the seatbelt is the only enforcement point left. Exactly the reasoning WS-12
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
    // The RESOLVED root's own projects directory, when it is not `<home>/<homeDirName>` (Phase 5 fix wave I1).
    input.winterHome && canon(input.winterHome) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny file-read* (regex #"${providerStateReadDenyRegex(sbplRegexLiteral(canon(input.winterHome)))}"))` : "",
  ]
    .filter((r) => r.length > 0)
    .join("\n");

  const denyBackupsDirRule = [
    input.home ? `(deny file-write* (subpath "${sbplString(canon(join(input.home, brand.homeDirName, "backups")))}"))` : "",
    // I1: same reasoning as the run deny above -- the store the sink actually writes to is the
    // RESOLVED root's `backups/`, which is what `checkpoint/sink.ts` has always used.
    input.winterHome && canon(input.winterHome) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny file-write* (subpath "${sbplString(canon(join(input.winterHome, "backups")))}"))` : "",
  ]
    .filter((r) => r.length > 0)
    .join("\n");

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
${denyRunDirRule}
${denyProviderStateReadRule}
(allow file-write*
${writeRules})
${denyWriteRules}
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr") (path "/dev/dtracehelper"))
${allowDarwinTempFiles}
${network}
${denyBackupsDirRule}
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
