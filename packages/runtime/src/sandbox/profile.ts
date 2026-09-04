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
// Norma's hard-won fixes verbatim, renamed `.norma` -> `.winter` per WS-01 §2.4. New at cutover
// (WS-12 §5.3, not present in Norma): `denyWrite`/`denyRead` layers driven by §2's `SandboxSettings`
// (Norma only ever took a fixed roots list), and the workflow-worker profile is exported from here
// too (WS-12 §5.2 "carries over for the workflow subprocess") even though no caller wires a real
// workflow worker to it yet in this phase -- WS-11 is a later phase; this ships the tested
// mechanism now, exactly as T1 shipped `buildAdvertisedSet` before anything called it.
import { join } from "node:path";
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
const WINTER_CF = "[Ww][Ii][Nn][Tt][Ee][Rr]";
const PERMISSIONS_CF = "[Pp][Ee][Rr][Mm][Ii][Ss][Ss][Ii][Oo][Nn][Ss]";
const SETTINGS_CF = "[Ss][Ee][Tt][Tt][Ii][Nn][Gg][Ss]";
const LOCAL_CF = "[Ll][Oo][Cc][Aa][Ll]";
const JSON_CF = "[Jj][Ss][Oo][Nn]";

const RULES_FILE_REGEX = String.raw`/\.${WINTER_CF}/${PERMISSIONS_CF}\.${LOCAL_CF}\.${JSON_CF}$`;
const SETTINGS_FILE_REGEX = String.raw`/\.${WINTER_CF}/${SETTINGS_CF}\.${JSON_CF}$`;
const SETTINGS_LOCAL_FILE_REGEX = String.raw`/\.${WINTER_CF}/${SETTINGS_CF}\.${LOCAL_CF}\.${JSON_CF}$`;

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
   * WS-12 §2: "the sole baseline read denial is `<home>/.winter/run`, enforced via profile deny
   * rules layered over allow-read." The daemon's own runtime dir (control socket, PID/lock files) --
   * a bash-invoked `cat ~/.winter/run/core.sock` or similar never passes through a read-tool's own
   * permission fence at all (reads are otherwise deliberately unrestricted, per this product's own
   * tool-surface design), so the seatbelt profile is the only enforcement point left. Omitted
   * entirely -> no baseline deny is emitted, still a correct (if less defended) profile -- mirrors
   * `darwinUserTempDir`'s own "omitted is still correct" posture; there is no ToolExecutionContext
   * seam this module can reach into itself (profile.ts stays platform/context-free by design, per
   * this file's own header), so every caller (spawn.ts -> tools/impl/{bash,monitor}.ts) is
   * responsible for threading its own `ctx.home` through.
   */
  home?: string;
}

/**
 * Build a macOS Seatbelt (SBPL) profile: deny-by-default, read anywhere (minus configured
 * denyRead layers and, when `home` is given, the WS-12 §2 baseline `<home>/.winter/run` denial --
 * see `SeatbeltProfileInput.home`'s own header), write only under the given roots (minus configured
 * denyWrite layers), network denied unless explicitly allowed.
 *
 * WS-12 §5.2 (verbatim carry, Winter-renamed): EVERY writable root (cwd + each of `writableRoots`)
 * additionally gets an explicit `(deny file-write* (literal "<root>/.winter/<file>"))` line, for
 * each of `permissions.local.json`/`settings.json`/`settings.local.json`, unconditionally, with no
 * opt-in flag to forget -- a bash-invoked `echo x > .winter/permissions.local.json` never passes
 * through a write/edit TOOL's own permission fence at all, so the seatbelt is the only enforcement
 * point left for a shell-invoked write to the permission/settings control plane. SBPL evaluates a
 * profile's rules for a given operation in FILE ORDER, last-match-wins (verified against real
 * sandbox-exec) -- placing these denies AFTER the `(allow file-write* (subpath ...))` block carves
 * out exactly these files from an otherwise-writable subpath, without touching a sibling file or an
 * entire OTHER subdirectory like `.winter/memory/` (the MEMDIR).
 *
 * A companion `(deny file-write* (regex ...))` per filename, placed after the per-root literals,
 * closes the NESTED-store hole a literal-only deny misses: a broad `writableRoots` entry makes a
 * nested `<root>/projB/.winter/settings.json` writable too, with no literal deny naming that exact
 * path. Case-folded per character (see the module-level regex constants' own comment).
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  const roots = [input.cwd, ...(input.writableRoots ?? [])].map(canon);
  const writeRules = roots.map((r) => `  (subpath "${sbplString(r)}")`).join("\n");

  const denyRulesFileRules = roots
    .flatMap((r) => CONTROL_PLANE_FILES.map((f) => `(deny file-write* (literal "${sbplString(canon(join(r, ".winter", f)))}"))`))
    .join("\n");
  const denyRulesFileRegex = `(deny file-write* (regex #"${RULES_FILE_REGEX}"))`;
  const denySettingsFileRegex = `(deny file-write* (regex #"${SETTINGS_FILE_REGEX}"))`;
  const denySettingsLocalFileRegex = `(deny file-write* (regex #"${SETTINGS_LOCAL_FILE_REGEX}"))`;

  // WS-12 §5.3 (new at cutover): user-configured filesystem.denyWrite/denyRead, rendered as
  // (subpath ...) denies -- UNLIKE the control-plane carve-outs above (filename-literal/regex
  // only), a user-supplied entry is an arbitrary path the user intends to protect wholesale
  // (typically a directory), so it gets the SAME subpath shape the write-allow block itself uses.
  // Placed after the allow blocks (last-match-wins) but BEFORE the mktemp allowance and the
  // control-plane denies, so neither carried protection can be defeated by a user's own denyWrite
  // entry happening to shadow them.
  const denyWriteRules = (input.denyWritePaths ?? []).map((p) => `(deny file-write* (subpath "${sbplString(canon(p))}"))`).join("\n");
  const denyReadRules = (input.denyReadPaths ?? []).map((p) => `(deny file-read* (subpath "${sbplString(canon(p))}"))`).join("\n");

  // WS-12 §2: "the sole baseline read denial is <home>/.winter/run" -- a subpath deny (not a
  // filename literal/regex like the control-plane carve-outs above): the WHOLE directory tree is
  // off-limits, not one specific filename within it. Placed AFTER the user-configured denyReadRules
  // (this file's own placement convention: a carried/baseline protection sits after user config, so
  // a user's own denyRead entries can never accidentally reorder around it) -- though for two
  // DENY rules of possibly-overlapping scope, unlike an allow/deny pair, relative order does not
  // change which paths end up denied; this ordering is for readability/convention, not correctness.
  const denyRunDirRule = input.home ? `(deny file-read* (subpath "${sbplString(canon(join(input.home, ".winter", "run")))}"))` : "";

  // WS-12 §5.2 (verbatim carry): macOS `mktemp(1)` (and anything else calling
  // confstr(_CS_DARWIN_USER_TEMP_DIR)) writes to the PER-USER temp dir and ignores $TMPDIR
  // entirely -- without this rule bare `mktemp` dies "Operation not permitted," which is enough to
  // fail an ordinary `git commit` whenever a hook shells out to it. DIRECT CHILDREN ONLY
  // (`[^/]+$`): a `(subpath ...)` here would be a real fence regression, and it is also the exact
  // shape the deny suite's own "outside the fence" assertions build two levels down in this same
  // directory. Placed BEFORE the control-plane denies so SBPL's last-match-wins keeps those denies
  // structurally overriding (no control-plane file can be a direct child of this dir anyway --
  // they all sit under a `.winter/` component -- but the ordering makes that structural rather than
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
(allow file-write*
${writeRules})
${denyWriteRules}
(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr") (path "/dev/dtracehelper"))
${allowDarwinTempFiles}
${network}
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
 * R5-5: "the P3 worker seatbelt profile PLUS the ledgered `~/.winter/run` deny"). `opts.home`, when
 * supplied, emits the same baseline `<home>/.winter/run` read-deny rule the ordinary Bash profile
 * carries (buildSeatbeltProfile's own `home` field), making this profile a strict superset of that
 * one's denials on every axis.
 *
 * `home` is OPTIONAL rather than required, deliberately: this module is platform- and
 * context-free by design (it resolves no paths of its own), and every pre-P5 caller -- profile.test.ts
 * and the darwin deny suite -- constructs the profile with no session to take a home from. Omitting
 * it still yields a correct, if less defended, profile, exactly as buildSeatbeltProfile documents for
 * its own `home`. LANE W'S SPAWNER MUST PASS IT: a real worker launched without `home` reproduces the
 * pre-P5 gap silently.
 *
 * THE #1 RISK (verified empirically by the Norma original): a blanket `(deny process-exec*)` makes
 * sandbox-exec's own execvp() of the target fail ("Operation not permitted"), because the
 * sandbox->target transition is itself an exec checked against the profile. So this allows exec of
 * EXACTLY `selfExecPath` (canonicalized) and nothing else -- enough for the runtime binary to boot
 * (it dyld-loads its libs via the allowed file-read*), while a workflow script still cannot exec
 * /bin/sh etc. Note the operation is `process-fork` (no star) -- `process-fork*` is an unbound
 * variable that fails to load.
 */
export function buildWorkflowWorkerSeatbeltProfile(selfExecPath: string, opts?: { home?: string }): string {
  const self = canon(selfExecPath);
  // Placed with the other denies (below), after `(allow file-read*)`, so SBPL's last-match-wins makes
  // it actually bind -- emitted before the blanket read-allow it would be dead text.
  const denyRunDirRule = opts?.home !== undefined ? `\n(deny file-read* (subpath "${sbplString(canon(join(opts.home, ".winter", "run")))}"))` : "";
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
