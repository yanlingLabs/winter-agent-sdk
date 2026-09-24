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
   * Fix round 16, item 2 (claude's own `ag()`, dump-verified: `function ag(){return
   * pe?.filesystem?.allowGitConfig??!1}`): `sandbox.filesystem.allowGitConfig` in settings.json --
   * the ONE settings-facing door for `SeatbeltProfileInput.allowGitConfigWrites`/
   * `RunCommandOptions.allowGitConfigWrites`, which this module and spawn.ts already had (round 15)
   * but nothing set. Wired through `tools/impl/{bash,monitor}.ts`'s own options-builders (each reads
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

/**
 * Fix round 12 ("Important" item, claude's own `Ch`, dump byte 15368116, pinned 2.1.250,
 * ground-truth byte-slice-verified against the SAME chunk as `mR`/`pR`/`ed`): the ancestor-rename-
 * bypass fix, ported as one function both the write-deny call site and the read-deny call site use
 * (`mR`/`pR` each call claude's own `Ch` with their own deny list; ported here as two call sites
 * sharing one implementation rather than two hand-copies).
 *
 * For every plain denied path: adds `(subpath "<canon(path)>")` (claude's own `ri(u)`, the SAME
 * recursive clause shape `denyWriteRules`/`denyReadRules` already render for the ORDINARY
 * `file-write*`/`file-read*` deny -- claude's own `Ch` adds it a SECOND time here, for these two
 * specific operations, rather than relying on `file-write*`'s own wildcard to already cover them;
 * ported faithfully rather than "optimized away" on an unverified redundancy assumption) and a
 * `(literal "<ancestor>")` for every ancestor directory of it (`ancestorDirectoriesOf`, claude's `ed`).
 *
 * For every glob-shaped denied path's own fixed prefix (`globFixedPrefixes`, already canonicalized
 * and already `/`-filtered by `splitDenyPathsByGlobShape`): adds `(literal "<prefix>")` itself (claude's
 * own `if(p!=="/")r.add(literal p)`) plus a `(literal "<ancestor>")` for every ancestor of THAT.
 *
 * Returns `""` (no block at all) when there is nothing to deny -- matching claude's own `Cs`
 * (`if(r.size===0)return[]`), so a session with no denies emits byte-identical output to before this
 * fix.
 */
function buildAncestorRenameBypassBlock(plainDenyPaths: readonly string[], globFixedPrefixes: readonly string[]): string {
  const clauses = new Set<string>();
  for (const path of plainDenyPaths) {
    const canonical = canon(path);
    clauses.add(`(subpath "${sbplString(canonical)}")`);
    for (const ancestor of ancestorDirectoriesOf(canonical)) clauses.add(`(literal "${sbplString(ancestor)}")`);
  }
  for (const prefix of globFixedPrefixes) {
    clauses.add(`(literal "${sbplString(prefix)}")`);
    for (const ancestor of ancestorDirectoriesOf(prefix)) clauses.add(`(literal "${sbplString(ancestor)}")`);
  }
  if (clauses.size === 0) return "";
  return [`(deny file-write-unlink file-write-create`, ...[...clauses].map((c) => `  ${c}`)].join("\n") + ")";
}

/**
 * Fix round 14 (CRITICAL item 1, claude's own `pR`'s own trailing re-permit -- dump-verified in the
 * SAME chunk as `Ch`/`mR`/`fR`/`Li`/`Cs` from rounds 11-13, content-search-confirmed against the
 * pinned 2.1.250 dump, not trusted from any coordinator-cited byte offset alone): `pR` does NOT end
 * with its own call to `Ch` -- round 12's own port stopped there. `pR`'s own LAST TWO LINES,
 * immediately following `r.push(...Ch(e.denies.map((A)=>A.path),t))`, are:
 *   `let w=new Set(e.writeRoots.map((A)=>Li(A.path)));`
 *   `return r.push(...Cs("allow",["file-write-unlink","file-write-create"],w,t)),r`
 * -- an EXPLICIT `(allow file-write-unlink file-write-create (subpath <each write root>))` re-permit,
 * one clause per write root, emitted RIGHT AFTER `Ch`'s own read-side ancestor-rename-bypass deny
 * (`denyReadAncestorRenameBlock`, above) and BEFORE `mR`/`fR`.
 *
 * Without it (round 12's own gap, and what production-wiring.test.ts's real sandbox-exec runs
 * proved): `Ch`'s own read-side block denies `file-write-unlink`/`file-write-create` on every
 * read-denied path UNCONDITIONALLY -- it has no carve-out of its own -- and round 13's own empirical
 * finding (this codebase's own controlled sandbox-exec experiments, `buildReadDenyKeepInPlaceBlock`'s
 * own header) is that Seatbelt does NOT let a LATER, broader `(allow file-write* (subpath <root>))`
 * override an EARLIER, narrower, explicitly-named `(deny file-write-unlink file-write-create ...)`
 * for the SAME target -- only an explicitly-named ALLOW of the identical operations does. So with
 * `Ch` alone, `cp .env.example .env` (creating `.env`, which the read-deny protects) was blocked even
 * though claude allows it, and a legitimate write root nested inside a read-denied directory stayed
 * unwritable even though `fR`'s own carve-out (round 13) is independently correct in isolation.
 *
 * This block restores claude's own net result: `Ch` denies unconditionally, THIS re-permit re-allows
 * `file-write-unlink`/`file-write-create` on every ordinary write root (an EXPLICIT, same-named
 * allow, so it wins over `Ch`'s own explicit deny under the SAME last-explicit-match-wins rule that
 * made `Ch` win over the plain `file-write*` allow in the first place), and `fR` (emitted later still,
 * round 13) narrows it back down for the one case that still needs protection -- an EXISTING
 * read-denied path's own unlink/rename -- while `fR`'s own `require-not` carve-out leaves a nested
 * write root's OWN re-permit from this block intact. Net: no delete or rename of a read-denied path,
 * creation allowed, and a write root nested inside a read-denied directory is writable again -- this
 * is ALSO the exact fix for round 13's own disclosed "nested write root shadowed by Ch" finding
 * (`buildReadDenyKeepInPlaceBlock`'s own header, above): `fR`'s carve-out was never broken, `Ch`'s
 * own missing re-permit was simply what left nothing for it to narrow back down from.
 *
 * Reuses the SAME canonicalized `roots` array (cwd + writableRoots) the write-allow block already
 * builds below -- claude's own `w=new Set(e.writeRoots.map((A)=>Li(A.path)))` is exactly that set.
 * Returns `""` when there is nothing to permit (`writableRoots.length === 0`), matching claude's own
 * `Cs`'s `if(r.size===0)return[]` -- structurally unreachable in practice (`roots` always includes
 * `cwd`), kept for the same "no set, no clause" discipline every other block in this module follows.
 *
 * DISCLOSED, NOT dump-confirmed either way: this block fires on the Winter side whenever there is a
 * write-roots set at all -- i.e. unconditionally in practice. Claude's own call site (dump byte
 * 15376527) gates `pR`'s ENTIRE first argument on a truthy outer `e` (`let X=e?uR(e,t?.allowOnly):
 * void 0`, then `B.push(...pR(X,F))`), and `fR` is called only `if(X)` too -- but `uR(e,t)` (dump byte
 * 15366505: `{denies:(e.denyOnly||[]).map(zu),allows:(e.allowWithinDeny||[]).map(zu),writeRoots:
 * (t||[]).map(zu)}`) builds a non-null OBJECT from `e` regardless of whether `e.denyOnly`/
 * `e.allowWithinDeny` are themselves EMPTY arrays -- so `X`'s truthiness turns on whether that OUTER
 * `e` (a read-restriction config object, one level up, its own producer not traced) exists for this
 * session at ALL, not on whether there are any ACTUAL denyRead entries. Left an open question for a
 * future round rather than assumed either way; Winter's own unconditional posture is, AT WORST, wider
 * than claude's real one in some unmeasured case, never narrower -- and `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`
 * below means that width costs nothing observable to Winter's OWN write-protection floors either way.
 */
function buildReadDenyWritePermitBlock(writableRoots: readonly string[]): string {
  if (writableRoots.length === 0) return "";
  const clauses = new Set(writableRoots.map((r) => `(subpath "${sbplString(r)}")`));
  return [`(allow file-write-unlink file-write-create`, ...[...clauses].map((c) => `  ${c}`)].join("\n") + ")";
}

// DISCLOSED, NOT ported (flagged for a future ruling, out of round 14's own scope): `pR`'s own body
// (dump byte 15368389, full transcription verified) has a THIRD line this port still does not carry,
// between the read-allow/deny stages and `Ch`'s own call: `if(e.denies.length>0)r.push("(allow
// file-read-metadata","  (vnode-type DIRECTORY))")` -- a BLANKET `(allow file-read-metadata (vnode-type
// DIRECTORY))`, gated only on "are there any denyRead entries at all," never path-scoped. It would not
// have closed the `touch`/`cp` gap `WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`'s own header discloses
// (that gap is about a denied FILE's own metadata, not directory metadata), so it is unrelated to this
// round's own fix -- but it IS a real, unported piece of claude's own `pR`, left for a deliberate
// ruling rather than added unasked: loosening what `file-read-metadata` reaches on a read-denied
// session is its own security-relevant surface, not implied by "port pR's trailing re-permit."

/**
 * Fix round 14 (Winter-specific hardening, NOT itself a claude port -- empirically discovered and
 * verified while implementing `buildReadDenyWritePermitBlock` above, disclosed prominently rather
 * than smoothed over): `pR`'s own trailing re-permit is a BLANKET, UNCONDITIONAL
 * `(allow file-write-unlink file-write-create (subpath <every write root>))`, ported faithfully per
 * the controller's own explicit instruction. Real `sandbox-exec` runs proved this is not merely
 * "narrower than a later wildcard deny wins" (round 13's own finding, about an EARLIER explicit deny
 * surviving a LATER broad `file-write*` allow) -- it runs the OTHER direction too: an EARLIER
 * EXPLICIT `file-write-unlink`/`file-write-create` ALLOW is not overridden by a LATER, broader
 * `(deny file-write* ...)` for the SAME target either. Seatbelt appears to give a clause naming
 * `file-write-unlink`/`file-write-create` explicitly priority over one that only reaches those
 * operations via the `file-write*` wildcard, independent of which clause is textually first or last.
 *
 * Every OTHER Winter-owned write-protection floor in this module that used only the `file-write*`
 * wildcard was therefore silently punched through for CREATE and UNLINK/RENAME specifically (never
 * for `file-write-data`, `file-write-mode`, etc., which this re-permit never names) by this ONE new
 * block: the control-plane carve-outs (WS-12 §5.2's own "the seatbelt is the only enforcement point
 * left" floor -- verified empirically: `mkdir -p .winter && echo '{}' > .winter/permissions.local.json`
 * and `rm .winter/settings.json` both SUCCEEDED against the unpatched fix), the checkpoint/backup
 * store write-deny (T8 rider 25's own identical floor), and a GLOB-shaped `denyWrite` entry (a plain
 * `denyWritePaths` entry was already safe -- `Ch`'s own write-side ancestor-rename block, round 12,
 * already emits an explicit `(subpath <path>)` deny for it; `Ch`'s own GLOB branch, by contrast, only
 * ever emits a `(literal <fixedPrefix>)` -- protecting the prefix DIRECTORY's own identity against a
 * rename-shuffle, never the glob-matched files themselves).
 *
 * The fix, verified against real `sandbox-exec` (a `(deny file-write* file-write-unlink
 * file-write-create (regex ...))` clause DOES win back the CREATE it needs to, confirmed by a direct
 * before/after run rather than assumed): every one of those floors now names
 * `file-write-unlink`/`file-write-create` EXPLICITLY, alongside the `file-write*` wildcard it already
 * carried (for the OTHER write operations the wildcard alone still covers correctly) -- this constant
 * is that shared operation-name list, applied wherever `file-write*` ALONE previously appeared on a
 * deny this round's own re-permit could otherwise reach. `fR` (`buildReadDenyKeepInPlaceBlock`) is
 * deliberately NOT touched here: it already names `file-write-unlink` explicitly (never `create`, by
 * claude's own design -- see that function's own header), so it was never in the affected set.
 */
const WRITE_OPS_SURVIVING_READ_DENY_REPERMIT = "file-write* file-write-unlink file-write-create";

/**
 * Fix round 15 (CRITICAL, claude's own `cR`, dump byte 15365486, ground-truth byte-slice-verified,
 * full body transcribed): claude's write profile ALWAYS adds `cR(e)`'s own default-protected
 * entries to the write denies -- `mR`'s own combined deny list is `p=[...denyWithinAllow,...cR(r)]`,
 * fed to `Ch(p,t)` -- with no opt-in flag to forget. Winter's profile had none of these: a sandboxed
 * Bash command could plant a git hook, set `core.fsmonitor` in `.git/config`, or add an `.mcp.json`
 * server, all of which run again OUTSIDE the sandbox on the session's next turn.
 *
 * `Do` (dump byte 15282344): `[".gitconfig",".gitmodules",".bashrc",".bash_profile",".zshrc",
 * ".zprofile",".profile",".ripgreprc",".mcp.json"]` -- nine bare shell/git/mcp config filenames, NOT
 * case-folded (unlike this module's own `.winter`/`settings.json` control-plane regexes) -- claude's
 * own `Po`/`Cv` never case-fold these either, per the dump; a case-insensitive-volume bypass is a
 * shared, pre-existing property of claude's own design, not a Winter regression or invented laxity.
 */
const DEFAULT_PROTECTED_FILES = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".ripgreprc", ".mcp.json"] as const;

/**
 * `qa()` (dump byte 15282484): `function qa(){return[...dv.filter((e)=>e!==".git"),".claude/commands",
 * ".claude/agents"]}` where `dv=[".git",".vscode",".idea"]` -- i.e. `[".vscode",".idea",
 * ".claude/commands",".claude/agents"]`. `.claude/commands`/`.claude/agents` are kept VERBATIM
 * (controller's own branding ruling: blocking writes into a repo's `.claude/` is harmless, and WS-21
 * wants that dir untouched anyway) -- Winter's OWN `brand.projectDirName` equivalents
 * (`<projectDir>/commands`, `<projectDir>/agents`) are ADDED separately by
 * `buildDefaultWriteProtectionEntries` below, never substituted for claude's own literal spelling, so
 * a rebranded product's own dot-dir is covered too.
 */
const DEFAULT_PROTECTED_DIRS = [".vscode", ".idea", ".claude/commands", ".claude/agents"] as const;

/**
 * Fix round 16 (over-deny correction; supersedes round 15's own `unanchoredEntryRegex`, which was
 * WRONG -- see below): renders claude's own globstar-prefixed pattern (two asterisks, a slash, the
 * entry name, for a directory a trailing slash-globstar too) the way claude ACTUALLY does, not the
 * way its own literal source text looks in isolation. claude's `mR` renders every `cR`-derived entry
 * via `ri(Cv(w))` (dump-verified, round 12's own `ri`/`Cv` citations): `Cv` (dump byte 15283956)
 * canonicalizes ANY relative path by unconditionally joining it onto `process.cwd()` FIRST (`let
 * t=process.cwd();...else if(!In.isAbsolute(e))r=In.resolve(t,e)`) -- the two-asterisk-slash-prefixed
 * `.git/hooks` pattern is relative (does not start with `/`), so `Cv` turns it into
 * `<cwd>` + that same two-asterisk-slash prefix + `.git/hooks` BEFORE it is ever treated as a glob at
 * all. Only THEN does `Cv`'s own glob-fixed-prefix canonicalization run, and by that point the fixed
 * prefix is `<cwd>` itself (a REAL, canonicalizable filesystem path), not empty. Round 15's own
 * reading -- "the first glob character is the pattern's own first character, so there is nothing to
 * canonicalize" -- was wrong: it looked at the pattern in isolation and never accounted for `Cv`'s
 * own unconditional cwd-join happening BEFORE the glob-shape analysis. The observable consequence,
 * confirmed against real `sandbox-exec`: Winter's round-15 rendering denied the pattern EVERYWHERE
 * (every writable root, not just cwd), so `git clone <url> "$TMPDIR/x"` -- writing `.git/hooks` under
 * a DIFFERENT writable root entirely -- failed on Winter and succeeds on claude.
 *
 * The fix: build the SAME absolute glob text `Cv` would (`<cwd>` + the two-asterisk-slash prefix +
 * `<entry>`, with a trailing slash-globstar too for a directory) and reuse
 * `recursiveGlobToSbplRegexSource` (file-rules.ts) -- the SAME primitive every OTHER glob-shaped deny
 * in this module already goes through, which is claude's own `Po`/`td` (dump-verified in
 * file-rules.ts's own header): it now correctly canonicalizes `<cwd>` as the fixed prefix via
 * `resolveRealTarget`/`ko`, anchors the regex with `^`, and widens with the SAME `(/.*)?$` recursive
 * suffix `ri`'s own `td` call always applies -- so `entry`'s own file-vs-directory distinction in the
 * SOURCE TEXT (whether a trailing slash-globstar is appended before this call) is preserved for
 * fidelity to claude's own literal `cR` text, even though `recursiveGlobToSbplRegexSource`'s own
 * unconditional trailing widening makes the two forms render equivalently either way.
 */
function cwdAnchoredEntryRegex(cwd: string, entry: string, recursive: boolean): string {
  const absoluteGlob = join(cwd, "**", entry) + (recursive ? "/**" : "");
  return recursiveGlobToSbplRegexSource(absoluteGlob);
}

/**
 * Every entry gets TWO forms, matching `cR`'s own `r.push(a),r.push(b)` pairing exactly: a PLAIN
 * path anchored at `cwd` (claude has no multi-root concept -- `process.cwd()` is `cR`'s own ONLY
 * anchor; Winter's own `writableRoots` are NOT separately covered here, matching claude's own
 * single-cwd anchor exactly -- port what's measured, not what a multi-root architecture COULD want),
 * and an unanchored, any-depth regex (covers every writable root for free, since it is unanchored by
 * construction and the write-allow region is bounded elsewhere regardless).
 *
 * `.git/hooks` is always protected, both ways; `.git/config` is too, UNLESS `allowGitConfigWrites`
 * -- claude's own `cR(e=false)` / `mR`'s own `r=false` default parameter, threaded here as
 * `SeatbeltProfileInput.allowGitConfigWrites` (absent = false = protected, matching claude's own
 * default). No caller sets it true yet; kept for parity since claude's own signature carries the
 * knob and a future caller (e.g. an explicit user opt-in to let a session manage git config) should
 * not need a NEW field invented later.
 *
 * `chPlainPaths` is a SUBSET of `plainPaths` (every claude-literal entry: `Do`'s files, `qa()`'s
 * dirs including `.claude/commands`/`.claude/agents` verbatim, `.git/hooks`, `.git/config`) --
 * DELIBERATELY EXCLUDING Winter's own brand-derived additions (`<projectDir>/mcp.json`,
 * `<projectDir>/commands`, `<projectDir>/agents`). This is a Winter-specific judgment call, not a
 * claude port: `Ch`'s own ancestor-literal protection denies `file-write-create` on the ANCESTOR
 * itself (not just the protected leaf), and Winter's own `<projectDir>` (`.winter` by default) is
 * NOT claude's `.claude` -- it is Winter's OWN control-plane/memory directory, which a session
 * routinely needs to create FRESH, unlike `.claude`, which claude itself never needs to create.
 *
 * Round 16 follow-up (the reviewer's own question: "if adding `<cwd>/.winter` to `Ch` causes no real
 * regression, add it for symmetry; if it does, explain the concrete case"): re-tested directly --
 * feeding `.winter`'s own entries into `Ch` (a temporary patch, reverted after the experiment) breaks
 * a PRE-EXISTING, already-committed test, unrelated to this lane's own work: `deny.darwin.test.ts`'s
 * "the carve-out stays filename-specific -- sibling files and the MEMDIR remain writable" (under
 * "regex arm 2 + control-plane carve-out"), which runs `mkdir -p <freshCwd>/.winter/memory && echo o
 * > .winter/other.json && echo m > .winter/memory/x.md` in a brand-new project directory and asserts
 * `exitCode === 0`. Confirmed by direct re-run: with `.winter`'s entries fed into `Ch`, that exact
 * command's exit code flips from 0 to 1 (`Ch`'s own literal-ancestor deny on `.winter` itself, hit by
 * the `mkdir -p` needing to CREATE it fresh) -- reverting the patch restores the pass. Whether the
 * DEFAULT auto-memory mechanism itself lives under `<cwd>/.winter` or under `storeHome`
 * (`context/memory-key.ts`'s own `memoryDirFor`: `join(storeHome??home,"projects",<key>,"memory")`
 * absent an `autoMemoryDirectory` override -- it is the LATTER by default) does not change this: the
 * pinned test fixture uses `<cwd>/.winter/memory` regardless, and it is a real, currently-passing
 * assertion this lane may not silently regress. `plainPaths` (the FULL set) still gets the ordinary
 * subpath+regex deny either way, so `<projectDir>/mcp.json`/`commands`/`agents` themselves stay
 * protected from create/unlink at their OWN exact path -- only the ANCESTOR-rename-bypass fence on
 * `.winter` ITSELF is what's excluded, a narrow, disclosed gap traded for keeping Winter's own
 * control-plane directory creatable. `.git`'s OWN ancestor gets no such exclusion -- Winter never
 * needs `.git` to stay freshly creatable inside the sandbox the way it needs `.winter` to, and this
 * is `cR`'s own literal, faithfully-ported entry.
 */
function buildDefaultWriteProtectionEntries(cwd: string, brand: SandboxBrand, allowGitConfigWrites: boolean): { plainPaths: string[]; chPlainPaths: string[]; regexes: string[] } {
  const plainPaths: string[] = [];
  const chPlainPaths: string[] = [];
  const regexes: string[] = [];
  for (const f of DEFAULT_PROTECTED_FILES) {
    plainPaths.push(join(cwd, f));
    chPlainPaths.push(join(cwd, f));
    regexes.push(cwdAnchoredEntryRegex(cwd, f, false));
  }
  const winterMcpJson = join(brand.projectDirName, "mcp.json");
  plainPaths.push(join(cwd, winterMcpJson));
  regexes.push(cwdAnchoredEntryRegex(cwd, winterMcpJson, false));
  for (const d of DEFAULT_PROTECTED_DIRS) {
    plainPaths.push(join(cwd, d));
    chPlainPaths.push(join(cwd, d));
    regexes.push(cwdAnchoredEntryRegex(cwd, d, true));
  }
  for (const d of [join(brand.projectDirName, "commands"), join(brand.projectDirName, "agents")]) {
    plainPaths.push(join(cwd, d));
    regexes.push(cwdAnchoredEntryRegex(cwd, d, true));
  }
  plainPaths.push(join(cwd, ".git", "hooks"));
  chPlainPaths.push(join(cwd, ".git", "hooks"));
  regexes.push(cwdAnchoredEntryRegex(cwd, ".git/hooks", true));
  if (!allowGitConfigWrites) {
    plainPaths.push(join(cwd, ".git", "config"));
    chPlainPaths.push(join(cwd, ".git", "config"));
    regexes.push(cwdAnchoredEntryRegex(cwd, ".git/config", false));
  }
  return { plainPaths, chPlainPaths, regexes };
}

/**
 * The FULL rendered block: every entry from `buildDefaultWriteProtectionEntries` above, denied with
 * the WIDENED operation list (`WRITE_OPS_SURVIVING_READ_DENY_REPERMIT`) so round 14's own read-deny
 * re-permit cannot punch through this floor either -- the identical reasoning that constant's own
 * header already carries, applied to a NEW deny source rather than the caller-configured
 * `denyWritePaths`/`denyWriteRegexes`. Kept as its OWN, separate block (not merged into
 * `input.denyWritePaths`/`denyWriteRegexes` themselves) so this unconditional, claude-mandated floor
 * never depends on -- or gets confused with -- a caller's own optional configuration.
 *
 * The claude-literal plain paths (`chPlainPaths`) are ALSO fed into `Ch`
 * (`buildAncestorRenameBypassBlock`, round 12) on their own, so an ancestor of e.g.
 * `<cwd>/.git/hooks` cannot be renamed out of the way and back to slip a write past this floor --
 * matching claude's own `mR`, which calls `Ch(p,t)` on the SAME combined
 * `p=[...denyWithinAllow,...cR(r)]` list. `plainPaths`' own Winter-specific additions are
 * deliberately excluded from THIS call -- see `buildDefaultWriteProtectionEntries`'s own header for
 * why. `Ch`'s own glob branch is NOT fed the regex half here (`cwdAnchoredEntryRegex`'s own output,
 * round 16) -- `Ch` wants a canonicalized FIXED-PREFIX DIRECTORY string (`Rh`'s own output on
 * claude's side), not a compiled regex, and `cwd` itself is already independently protected via the
 * plain-path half above; the regex clause's own survival against the re-permit comes entirely from
 * the widened operation list on its own deny clause, exactly like every other glob-shaped deny in
 * this module.
 */
function buildDefaultWriteProtectionBlock(cwd: string, brand: SandboxBrand, allowGitConfigWrites: boolean): string {
  const { plainPaths, chPlainPaths, regexes } = buildDefaultWriteProtectionEntries(cwd, brand, allowGitConfigWrites);
  const plainDenyClauses = plainPaths.map((p) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(p))}"))`).join("\n");
  const regexDenyClauses = regexes.map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (regex #"${escapeSbplRegexDelimiter(r)}"))`).join("\n");
  const ancestorFence = buildAncestorRenameBypassBlock(chPlainPaths, []);
  return [plainDenyClauses, regexDenyClauses, ancestorFence].filter((s) => s.length > 0).join("\n");
}

// A STRICT "is candidate a proper descendant of root" check -- claude's own `Sc` (dump byte 15366000
// region, ground-truth-verified in round 11's own reading), reduced to its plain-path form: Winter's
// write roots and glob-fixed-prefix denies are never themselves glob-shaped (round 10's own `Jm`
// finding -- a glob-shaped ALLOW/writeRoot entry is dropped entirely, never reaches this module), so
// `Sc`'s own `vh`-neutralized glob-text branch is structurally unreachable here and not ported.
// Deliberately EXCLUDES equality (`candidate === root`) -- matches `Sc`'s own `r!==t` check exactly;
// `fR`'s own skip-condition for a glob entry (below) is the one place claude's OWN code ALSO checks
// equality, ported as its own separate inline condition rather than folded into this helper.
function isProperDescendantOf(candidate: string, root: string): boolean {
  return root === "/" ? candidate !== "/" && candidate.startsWith("/") : candidate !== root && candidate.startsWith(root + "/");
}

/**
 * Fix round 13 ("Important" item 1, claude's own `fR`, dump byte 15367091, pinned 2.1.250,
 * ground-truth byte-slice-verified in the SAME chunk as `Ch`/`mR`/`pR`/`dR`/`Li`/`ri` from rounds
 * 11/12): "keep read-denied paths inside write roots in place" -- see
 * `SeatbeltProfileInput.denyReadGlobEntries`'s own header for the full rationale. `writableRoots`
 * here is the SAME canonicalized `roots` array (cwd + writableRoots) `buildSeatbeltProfile`'s own
 * write-allow block already builds -- reused, not re-derived.
 *
 * Scope note (disclosed, not silently narrowed): claude's own `fR` ALSO carves allow-within-deny
 * ("allowRead") entries out of the resulting deny clause (`A(N)`'s own `[...o,...u]`, `o` being the
 * allow list) -- Winter has no SBPL rendering for `allowRead` at all yet (round 10's own disclosed
 * gap, `SeatbeltProfileInput.denyWriteRegexes`'s sibling `allowRead` field, "fails closed: an
 * unenforced allowRead simply leaves the outer denyRead in effect"). This port carves out only
 * NESTED WRITE ROOTS (the `u`/`writeRoots` half of claude's own `[...o,...u]`), which Winter DOES
 * have -- the `allowRead` half stays part of that SAME pre-existing gap, not a new one.
 *
 * RESOLVED (round 14, CRITICAL item 1 -- see `buildReadDenyWritePermitBlock`'s own header): round 13
 * found, empirically, that the nested-write-root carve-out this function builds was, in the CURRENT
 * combined profile, shadowed by `Ch` (round 12, `buildAncestorRenameBypassBlock`, called on the SAME
 * `denyReadPaths` list) whenever both cover the identical denied path -- `Ch` has NO carve-out
 * mechanism of its own and its own EARLIER, unconditional deny covered the nested write root too,
 * with no exemption, and THAT clause was what a real sandbox-exec test observed deciding the outcome.
 * The root cause was never a bug in `fR` (isolated testing, at the time, already confirmed this
 * function's own carve-out clause was correctly generated and independently functional) -- it was
 * that Winter's round-12 port of claude's own `pR` stopped at its `Ch` call and never carried `pR`'s
 * own TRAILING lines, an explicit `(allow file-write-unlink file-write-create <every write root>)`
 * re-permit emitted right after `Ch`. With that re-permit now in place (`buildReadDenyWritePermitBlock`,
 * called from `buildSeatbeltProfile` immediately after `Ch`'s own read-side block), a real sandbox-exec
 * run confirms the nested write root is writable again -- production-wiring.test.ts's own round-13
 * fixture, once asserting the disclosed-limitation outcome, now asserts the restored one, re-verified
 * against real `sandbox-exec`, not assumed.
 */
function buildReadDenyKeepInPlaceBlock(plainDenyReadPaths: readonly string[], globDenyReadEntries: readonly GlobDenyEntry[], writableRoots: readonly string[]): string {
  if (writableRoots.length === 0) return "";
  const isUnderAnyWriteRoot = (path: string): boolean => writableRoots.some((root) => isProperDescendantOf(path, root));
  const nestedWriteRootCarveOuts = (deniedPath: string): string[] => writableRoots.filter((root) => isProperDescendantOf(root, deniedPath)).map((root) => `(subpath "${sbplString(root)}")`);
  const withCarveOuts = (base: string, carveOuts: readonly string[]): string => (carveOuts.length === 0 ? base : `(require-all ${base} ${carveOuts.map((c) => `(require-not ${c})`).join(" ")})`);
  const addAncestorLiterals = (clauses: Set<string>, ancestors: readonly string[]): void => {
    for (const ancestor of ancestors) if (isUnderAnyWriteRoot(ancestor)) clauses.add(`(literal "${sbplString(ancestor)}")`);
  };

  const clauses = new Set<string>();
  for (const rawPath of plainDenyReadPaths) {
    const path = canon(rawPath);
    if (!isUnderAnyWriteRoot(path)) continue; // claude's own w(N) -- nothing to "keep in place" outside a write root
    clauses.add(withCarveOuts(`(subpath "${sbplString(path)}")`, nestedWriteRootCarveOuts(path)));
    addAncestorLiterals(clauses, ancestorDirectoriesOf(path));
  }
  for (const entry of globDenyReadEntries) {
    // claude's own skip-condition (the ONE place equality is ALSO checked, unlike w() above).
    const relatesToAWriteRoot = writableRoots.some((root) => entry.fixedPrefix === root || isProperDescendantOf(entry.fixedPrefix, root) || isProperDescendantOf(root, entry.fixedPrefix));
    if (!relatesToAWriteRoot) continue;
    const regex = new RegExp(entry.regex);
    const carveOuts = writableRoots.filter((root) => regex.test(root)).map((root) => `(subpath "${sbplString(root)}")`);
    clauses.add(withCarveOuts(`(regex #"${escapeSbplRegexDelimiter(entry.regex)}")`, carveOuts));
    if (entry.fixedPrefix !== "/") addAncestorLiterals(clauses, [entry.fixedPrefix, ...ancestorDirectoriesOf(entry.fixedPrefix)]);
  }
  if (clauses.size === 0) return "";
  return [`(deny file-write-unlink`, ...[...clauses].map((c) => `  ${c}`)].join("\n") + ")";
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
 * it renders `\.[Ww][Ii][Nn][Tt][Ee][Rr]`, byte for byte what the constant it replaces spelled, so
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
   * Fix round 11 (claude's `Li`/`Rt`, dump byte 15365905/15282610, pinned 2.1.250): glob-shaped
   * deny entries, PRE-CONVERTED by the caller to SBPL regex SOURCE TEXT (`permissions/file-rules.ts`'s
   * `globToSbplRegexSource`/`recursiveGlobToSbplRegexSource`/`splitDenyPathsByGlobShape`) -- this
   * module has no glob grammar of its own (mirrors `denyWritePaths`/`denyReadPaths`'s own "already
   * resolved by the caller" posture) and only quotes/renders. Claude's own macOS sandbox profile
   * builder renders a glob-shaped deny as `(regex ...)` and a plain one as `(subpath ...)` (`Li`); a
   * `subpath` deny alone -- Winter's pre-round-11 posture -- silently drops a glob-shaped Edit deny
   * (e.g. a globstar-anchored `.env` pattern) or `denyWrite` entry from the sandbox layer entirely
   * (the PERMISSION-RULE layer still enforced it for a recognized tool call; a bash-invoked
   * `tee`/`cp` bypassing that layer did not).
   */
  denyWriteRegexes?: string[];
  denyReadRegexes?: string[];
  /**
   * Fix round 12 ("Important" item, claude's own `Ch`/`ed`/`mR`/`pR`, dump byte 15368116/15367994/
   * 15369065/15368380, pinned 2.1.250): the ancestor-rename-bypass fix. `denyWriteGlobFixedPrefixes`/
   * `denyReadGlobFixedPrefixes` are the CANONICALIZED fixed-prefix directory of each glob-shaped
   * denyWrite/denyRead entry (`permissions/file-rules.ts`'s `splitDenyPathsByGlobShape`, its own
   * `globFixedPrefixes` output) -- this module has no glob grammar of its own, mirrors the other
   * caller-pre-resolved fields above. Combined with `denyWritePaths`/`denyReadPaths` (the PLAIN
   * entries, reused directly -- no new field needed for those), `buildAncestorRenameBypassBlock`
   * below builds a `(deny file-write-unlink file-write-create ...)` clause naming every ANCESTOR of
   * each denied path/glob-fixed-prefix, PLUS the fixed prefix itself, so a sandboxed `mv <ancestor>
   * <elsewhere> && <write inside where it used to be> && mv <elsewhere> <ancestor>` cannot rename an
   * ancestor of a denied path out of the way (and back) to slip a write past the deny.
   */
  denyWriteGlobFixedPrefixes?: string[];
  denyReadGlobFixedPrefixes?: string[];
  /**
   * Fix round 13 ("Important" item 1, claude's own `fR`, dump byte 15367091): "keep read-denied
   * paths inside write roots in place." Winter's read-deny/write-allow sections previously composed
   * exactly the way claude's OWN `mR`/`pR` alone would -- last-match-wins, and the write-allow
   * (`(allow file-write* (subpath <root>))`) is emitted AFTER the read-deny section, so it silently
   * overrides any read-deny's own implicit protection against being UNLINKED (renamed away): with
   * `Read(.env)` denied and cwd writable, a sandboxed `mv .env x && cat x` renamed the read-denied
   * file to a new, non-denied name and read the secret through it. claude closes this with a THIRD
   * section, `fR`, emitted AFTER the write-allow block: for each read-denied path (or glob-shaped
   * entry, `denyReadGlobEntries` below) that sits inside a write root, denies `file-write-unlink` on
   * its own recursive clause (minus any write root nested INSIDE it, carved back out) and on every
   * one of its ancestor directories that is ALSO inside a write root.
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
   * Fix round 15 (claude's own `cR(e=false)` / `mR`'s own `r=false` default parameter): when true,
   * `.git/config` is NOT added to the default write-protected entries (`buildDefaultWriteProtectionBlock`
   * above) -- every OTHER default protection (shell/tool config files, editor/agent dot-dirs,
   * `.git/hooks`) is unaffected; this flag only ever gates `.git/config`, matching `cR`'s own `!e`
   * guard exactly. Omitted = `false` = protected, matching claude's own default. No caller sets this
   * true yet -- kept for parity since claude's own signature carries the knob.
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

  // Fix round 11: the GLOB-shaped siblings of the two rules just above (claude's own `Li`/`Rt`,
  // dump byte 15365905/15282610) -- `(regex #"...")` rather than `(subpath ...)`, since SBPL's
  // `subpath` operator has no glob grammar of its own and would otherwise treat e.g. `**/.env`
  // as a LITERAL directory name (matching nothing real). The caller has already converted these to
  // regex SOURCE TEXT (`permissions/file-rules.ts`'s `splitDenyPathsByGlobShape`, the recursive form
  // -- "and everything under it," matching `subpath`'s own implicit recursive semantics).
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
  // Deliberately NOT `canon()`-ed HERE -- unlike the plain-path rules above, there is no real
  // filesystem path in the REGEX TEXT ITSELF to canonicalize (it is already a compiled regex pattern,
  // wildcards included). The glob's own fixed PREFIX IS canonicalized, through a real symlink, guarded
  // by claude's own `ko` -- one level upstream, before conversion (`permissions/file-rules.ts`'s
  // `canonicalizeGlobFixedPrefix`/`isSuspiciousRealpathResolution`; fix round 11 + round 12's own
  // disclosure correction -- claude's `Cv` DOES perform real, `ko`-guarded symlink resolution here,
  // this codebase's round-11 disclosure claiming otherwise was wrong, corrected in file-rules.ts's own
  // header).
  const denyWriteRegexRules = (input.denyWriteRegexes ?? []).map((r) => `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (regex #"${escapeSbplRegexDelimiter(r)}"))`).join("\n");
  const denyReadRegexRules = (input.denyReadRegexes ?? []).map((r) => `(deny file-read* (regex #"${escapeSbplRegexDelimiter(r)}"))`).join("\n");

  // Fix round 12 ("Important" item, claude's own `Ch`/`ed`): the ancestor-rename-bypass fix. For
  // EVERY write-denied path (plain OR glob-shaped) and EVERY read-denied path, additionally deny
  // `file-write-unlink`/`file-write-create` on the denied path itself (or a glob's own fixed prefix)
  // and on every ANCESTOR directory of it -- so a sandboxed `mv <ancestor> <elsewhere> && echo x >
  // <where the ancestor used to be>/... && mv <elsewhere> <ancestor>` cannot rename an ancestor out
  // of the way (and back) to slip a write past the deny. claude's own `mR` (write profile) and `pR`
  // (read profile) each call `Ch` with their OWN deny list -- ported as two independent blocks below,
  // matching that structure exactly rather than merging them into one.
  const denyWriteAncestorRenameBlock = buildAncestorRenameBypassBlock(input.denyWritePaths ?? [], input.denyWriteGlobFixedPrefixes ?? []);
  const denyReadAncestorRenameBlock = buildAncestorRenameBypassBlock(input.denyReadPaths ?? [], input.denyReadGlobFixedPrefixes ?? []);

  // Fix round 14 (CRITICAL item 1, claude's own `pR`'s own trailing re-permit): see
  // `buildReadDenyWritePermitBlock`'s own header for the full rationale. Reuses the SAME
  // canonicalized `roots` array the write-allow block below builds.
  const denyReadWritePermitBlock = buildReadDenyWritePermitBlock(roots);

  // Fix round 15 (CRITICAL, claude's own `cR`): see `buildDefaultWriteProtectionBlock`'s own header
  // for the full rationale.
  const defaultWriteProtectionBlock = buildDefaultWriteProtectionBlock(input.cwd, brand, input.allowGitConfigWrites ?? false);

  // Fix round 13 ("Important" item 1, claude's own fR): emitted AFTER the write-allow block (`roots`/
  // `writeRules`, above) -- see `buildReadDenyKeepInPlaceBlock`'s own header for the full rationale.
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
  const denyBackupsDirRule = [
    input.home ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(input.home, brand.homeDirName, "file-history")))}"))` : "",
    // I1: same reasoning as the run deny above -- the store the sink actually writes to is the
    // RESOLVED root's `file-history/`, which is what `checkpoint/sink.ts` has always used. WS-21
    // §3.7: `durableRoot` prefers `storeHome`.
    durableRoot && canon(durableRoot) !== canon(join(input.home ?? "", brand.homeDirName)) ? `(deny ${WRITE_OPS_SURVIVING_READ_DENY_REPERMIT} (subpath "${sbplString(canon(join(durableRoot, "file-history")))}"))` : "",
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
