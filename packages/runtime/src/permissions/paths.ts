// Task 4 (WS-07 §3.1): file-rule anchors + path semantics. This is the FILE-pattern sibling of
// Task 3's grammar.ts: it consumes raw pattern strings (the specifier content of a `Read`/`Edit`
// rule, e.g. the "build/**" inside `Read(build/**)` -- already stripped of the `Tool(...)` wrapper
// by whoever calls in, exactly as grammar.ts's own `ParsedRule.specifier.source` would carry it for
// the generic "pattern" family), NOT a `ParsedRule` -- grammar.ts's `matchesRule` only ever reads
// `call.input.command` for its own "pattern" specifier kind (Bash-shaped), so it structurally
// cannot be reused for a Read/Edit file path. Naming/API style (the `"allow" | "denyAsk"` direction
// union, named exports, no default export) deliberately mirrors grammar.ts.
//
// SCOPE BOUNDARY: this module only ever sees SCOPED `Read(pattern)`/`Edit(pattern)` rules. A BARE
// `Read`/`Edit` deny (no specifier at all) removes the tool from the model's schema entirely
// (WS-07 §3's "Advertisement" layer / §1's five-layer table) -- that never reaches path matching in
// the first place, so it is out of scope here by construction, not by omission.
//
// Two fixture regimes (see paths.test.ts's own header): `matchFileRule` is pure string logic, no
// fs access at all -- only `checkSymlinkBothEnds` touches real disk (lstat/realpath), because
// resolving a symlink's true target is not something a string can answer.
//
// P1 paths-module reuse (context question, answered): packages/runtime/src/paths/{temp,
// project-dir-name}.ts own transcript/temp-dir KEY derivation (safe-segment validation, uid-scoped
// tmp chains) -- a completely different problem (deriving a filesystem-safe identifier) from THIS
// module's (matching a user-authored glob against an arbitrary real path). Nothing there fits
// without coupling permission-rule matching to transcript-key logic, which the brief explicitly
// forbids; this module shares no code with either file (only the mkdtemp/realpath-the-base TEST
// convention is intentionally mirrored -- see paths.test.ts).
import { realpathSync } from "node:fs";
import { dirname, basename, join, isAbsolute, normalize } from "node:path";
import type { PermissionBehavior } from "@yanlinglabs/winter-agent-sdk";

// ---------------------------------------------------------------------------------------------
// matchFileRule
// ---------------------------------------------------------------------------------------------

export interface MatchFileRuleOptions {
  path: string;
  cwd: string;
  // Judgment call (WS-07 §3.1 table row 3: "`/path` | directory associated with the settings
  // source"): the spec pins WHAT the anchor means but not what happens when the evaluator has no
  // such directory to hand -- there is no fallback settings-source concept documented anywhere in
  // WS-07. Rather than silently falling back to cwd (which would make a `/`-anchored rule
  // indistinguishable from a bare one -- actively wrong, since the two anchors are deliberately
  // listed as DISTINCT rows) or to the filesystem root (equally undocumented), an absent sourceDir
  // makes a `/`-anchored rule INERT: it can never match, on either direction. This is the
  // conservative reading for BOTH allow and deny alike -- an allow that never fires under-grants
  // (safe), a deny/ask that never fires under this one specific unresolvable anchor is a real gap,
  // but silently guessing a wrong base directory for a deny rule (potentially UNDER-matching a
  // completely different real location) is worse than a caller-visible no-match; see
  // paths.test.ts's "sourceDir is absent" fixture (pinned both directions) and the report's
  // judgment-call section.
  sourceDir?: string;
  home: string;
  direction: "allow" | "denyAsk";
}

interface AnchorResolution {
  base: string;
  rest: string;
}

function resolveAnchor(pattern: string, opts: Pick<MatchFileRuleOptions, "cwd" | "home" | "sourceDir">): AnchorResolution | null {
  if (pattern.startsWith("//")) {
    return { base: "/", rest: pattern.slice(2) };
  }
  if (pattern === "~") {
    return { base: opts.home, rest: "" };
  }
  if (pattern.startsWith("~/")) {
    return { base: opts.home, rest: pattern.slice(2) };
  }
  if (pattern.startsWith("/")) {
    if (opts.sourceDir === undefined) return null; // see MatchFileRuleOptions.sourceDir's comment
    return { base: opts.sourceDir, rest: pattern.slice(1) };
  }
  if (pattern.startsWith("./")) {
    return { base: opts.cwd, rest: pattern.slice(2) };
  }
  return { base: opts.cwd, rest: pattern };
}

function stripTrailingSlash(s: string): string {
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

// Joins an anchor's absolute base directory with a (possibly glob-laden) relative rest-of-pattern.
// Deliberately NOT `node:path`'s `join` here -- `join` would be perfectly happy to collapse the
// `**` token in ways that are fine (it only special-cases `.`/`..`, and `**` is neither) but this
// keeps the seam-only responsibility explicit and cheap to reason about independent of `**`
// handling, which lives entirely in compileFsGlobToRegex below.
function joinBaseAndRest(base: string, rest: string): string {
  const cleanBase = stripTrailingSlash(base) || "/";
  const cleanRest = rest.replace(/^\/+/, "");
  if (cleanRest === "") return cleanBase;
  return (cleanBase === "/" ? "" : cleanBase) + "/" + cleanRest;
}

// A pattern's rest is a "single segment directory pattern" when, once a trailing slash is trimmed,
// it contains neither `/` nor `*` -- i.e. a bare literal name like "build", not "src/build"
// (multi-segment -- ordinary glob applies) and not "build*"/"build/**" (an explicit wildcard means
// the author already said how far the rule reaches; the asymmetry only exists to resolve what an
// UNADORNED bare name silently means).
//
// Ruling P2-D (fix round 1): this check is deliberately ANCHOR-AGNOSTIC -- it used to gate on the
// anchor being bare/`./`-anchored (cwd), on the reading that WS-07 §3.1's "single-segment RELATIVE
// directory pattern" wording was scoped to that one row. The review's fixture-gap sweep found that
// reading left `~/`, `//`, and `/`(sourceDir)-anchored bare segments fail-open on the denyAsk side
// (e.g. `deny Read(~/secrets)` did not reach `~/secrets/key.pem`) -- a real security gap, not a
// cosmetic inconsistency. Ruling P2-D: the denyAsk deep-reach behavior applies to a bare segment
// under ANY anchor. `allow` is unaffected for every NON-trailing-slash pattern -- it was already
// exact-only for every anchor (a non-cwd single segment with no wildcard degenerates to an exact
// literal match on the general glob path too). One edge DOES move on the allow side: a
// trailing-slash pattern text (e.g. `~/secrets/`) under a non-cwd anchor previously fell to the
// general path, where the trailing slash survives into the compiled regex (`.../secrets/$`) and
// can never match a `resolveTargetPath`-normalized target (which never carries a trailing slash) --
// so it matched NOTHING. Now it exact-matches the directory, like its non-trailing-slash spelling
// always did. Strictly more correct and still shallow (never widens past the exact entry), not a
// security-relevant change -- flagged here for honesty, not because it needs a different fix.
// Ruling P2-F (Task 7, rider 1): a ZERO-REST bare anchor -- pattern `~`, `~/`, `//`, or `/`
// (+sourceDir) alone, i.e. the anchor resolves to `{base, rest: ""}` with nothing after the anchor
// token itself -- was previously excluded from this function (the old `trimmed.length > 0` guard)
// and fell through to the general glob-compile path instead. That path compiles a pattern with no
// `*`/`**` at all into a plain `^literal$` regex, which matches ONLY the anchor's base directory
// itself, on EVERY direction -- so `deny Read(~)` did not reach `~/anything`, a fail-open exactly
// like the one Ruling P2-D fixed one level up (single-segment RELATIVE bare names). Folding
// "zero rest" into this SAME function, rather than adding a parallel branch, is deliberate: a bare
// anchor is structurally "zero segments after the anchor," the same family as P2-D's "one segment
// after the anchor" -- both get denyAsk deep-reach and allow exact-only, via the identical formula
// in matchFileRule below (`exact` degenerates to the anchor's base itself when rest is empty).
// Scope note: this also (harmlessly) covers a bare `""`/`"./"` pattern spelling, which resolves to
// the SAME zero-rest cwd-anchored shape via resolveAnchor's fallthrough branch -- not one of the
// four spellings WS-07 §3.1 or the task's own ruling names, but the identical shape structurally,
// and treating it identically is the more defensible single rule rather than four hand-picked
// string literals (capture-noted, like every other anchor-edge judgment call in this file).
function isSingleSegmentDirectoryPattern(anchor: AnchorResolution): boolean {
  const trimmed = stripTrailingSlash(anchor.rest);
  if (trimmed.length === 0) return true;
  return !trimmed.includes("/") && !trimmed.includes("*");
}

function resolveTargetPath(path: string, cwd: string): string {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  return stripTrailingSlash(normalize(abs));
}

// Ruling P2-F fallout: `exact + "/"` (the pre-existing denyAsk deep-reach formula below) produces
// "//" when `exact` is the filesystem root itself ("/" + "/" = "//"), which no real absolute path
// ever starts with -- silently breaking the deep-reach check for exactly the one new case this
// ruling introduces (a bare `//` anchor resolves `exact` to "/"). Never exercised before P2-F
// (every prior isSingleSegmentDirectoryPattern fixture had a non-root `exact`), so this is a
// latent formula bug this ruling's own fixture newly exposes, not a mistake in the ruling itself.
function isExactOrDescendant(targetPath: string, base: string): boolean {
  if (targetPath === base) return true;
  return targetPath.startsWith(base === "/" ? "/" : base + "/");
}

const REGEXP_SPECIAL = /[.+?^${}()|[\]\\]/;

function escapeRegexChar(ch: string): string {
  return REGEXP_SPECIAL.test(ch) ? "\\" + ch : ch;
}

// One path SEGMENT's glob body: every `*` becomes `[^/]*` (WS-07 §3.1: "`*` stays within one path
// segment" -- and, mirroring grammar.ts's own Bash-glob convention, a `*` also matches zero
// characters, so "build*" matches literal "build" too); every other character is regex-escaped.
// Never called with an actual "**" segment -- compileFsGlobToRegex intercepts that case first.
function globSegmentToRegexBody(segment: string): string {
  let out = "";
  for (const ch of segment) {
    out += ch === "*" ? "[^/]*" : escapeRegexChar(ch);
  }
  return out;
}

// Compiles a full ABSOLUTE pattern (anchor base + rest, still containing `*`/`**` tokens) into a
// regex matched against a full absolute target path. `**` (WS-07 §3.1: "`**` crosses directories")
// becomes "(?:/[^/]+)*" wherever it sits in the segment sequence -- zero or more complete
// "/segment" groups -- which uniformly covers every position:
//   ["a","**","b"] -> "/a(?:/[^/]+)*/b"   matches /a/b, /a/x/b, /a/x/y/b
//   ["**","b"]     -> "(?:/[^/]+)*/b"     matches /b, /x/b, /x/y/b
//   ["a","**"]     -> "/a(?:/[^/]+)*"     matches /a, /a/x, /a/x/y
// Judgment call (documented, not part of the required corpus): the trailing-`**` case above
// deliberately ALSO matches the bare base itself ("/a"). Real gitignore's own trailing "/**" is
// contents-only (does not match "a" itself) -- diverged here for a single uniform "zero or more"
// rule rather than three positional variants, since WS-07 §3.1 pins "`**` crosses directories" as
// one general fact, not gitignore's own fuller grammar. Flagged in the report; a one-line change
// (require 1+ reps only when the "**" is the LAST segment) if a differential capture disagrees.
// Hardening (not spec-mandated; added after a security-lens pass mirroring T3's own matcher-safety
// review of grammar.ts). WS-07 §3.2: project deny/ask rules apply WITHOUT workspace trust -- a
// hostile checked-in .winter/settings.json is a semi-trusted PATTERN source feeding this compiler
// on every file-op evaluation. Two adjacent "**" segments each compile to their own
// "(?:/[^/]+)*" group; several such groups (adjacent OR merely un-anchored by literal segments
// between them) create the classic catastrophic-backtracking shape against a sufficiently deep,
// non-matching target path. Two cheap, independent mitigations:
//   (1) collapse adjacent "**" segments into one before compiling -- semantics-preserving (zero-or-
//       more directories followed by zero-or-more directories is exactly zero-or-more directories)
//       and removes the most naive "a/**/**/**/.../b" shape for free.
//   (2) cap the total number of "**" segments (after collapsing) a single pattern may use --
//       mirrors grammar.ts's own PARSE_LIMIT precedent (T3) for bounding pathological input rather
//       than attempting to process it. Exported so the exact boundary is a named, testable
//       decision, not a magic number. 8 is generous headroom over any legitimate rule (this
//       task's own corpus never exceeds one or two) while keeping the worst-case backtracking
//       exponent fixed and small regardless of how an untrusted rule author crafts the pattern. A
//       pattern over the cap is treated as never-matching (fails closed) rather than compiled.
//
// Residual, explicitly NOT addressed by either mitigation (review fix round 1 finding; P2 fix-wave
// tracks it, no code change here): a SINGLE segment carrying many `*` tokens (e.g.
// "a*a*a*a*a*a*a*b") compiles, via globSegmentToRegexBody, to that many sequential "[^/]*" groups
// WITHIN one segment's own regex body -- untouched by MAX_DOUBLE_STARS, which only counts whole
// "**" segment tokens, never `*` occurrences inside a segment. Matched against a long, non-matching
// candidate segment this is the same shape of ambiguous-partition backtracking (polynomial in the
// star count), under the identical untrusted-rule threat model (WS-07 §3.2: project deny/ask rules
// apply without workspace trust). Deliberately deferred, not fixed in this pass.
export const MAX_DOUBLE_STARS = 8;

function collapseConsecutiveDoubleStars(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "**" && out[out.length - 1] === "**") continue;
    out.push(seg);
  }
  return out;
}

function compileFsGlobToRegex(absPattern: string): RegExp | null {
  const segments = collapseConsecutiveDoubleStars(absPattern.slice(1).split("/")); // absPattern always starts with "/"
  const doubleStarCount = segments.filter((seg) => seg === "**").length;
  if (doubleStarCount > MAX_DOUBLE_STARS) return null;
  let out = "";
  for (const seg of segments) {
    out += seg === "**" ? "(?:/[^/]+)*" : "/" + globSegmentToRegexBody(seg);
  }
  return new RegExp(`^${out}$`);
}

// Task 5 (Ruling P2-E): rule-add-time probe for the SAME cap compileFsGlobToRegex enforces at match
// time, so a Read/Edit rule store (packages/runtime/src/permissions/ruleset.ts) can reject an
// over-cap pattern when it is ADDED rather than let it silently compile to `null` (never-matching,
// including for deny/ask -- a fail-open gap for those two directions, see compileFsGlobToRegex's
// call site comment above) at match time. Reuses collapseConsecutiveDoubleStars + MAX_DOUBLE_STARS
// rather than letting a caller re-derive the collapse/count algorithm independently, which would
// drift the moment either changes here. Anchor-independent: an absolute pattern's segments are
// exactly [...anchor's literal base segments, ...this raw pattern's own segments], and a literal
// base segment is by definition never "**" -- so prepending it can never change the "**" count.
// The caller may therefore pass the RAW, pre-anchor rule pattern exactly as authored (this
// function does not require -- and must not require -- a leading "/", unlike
// compileFsGlobToRegex's own `absPattern` parameter).
export function exceedsDoubleStarCap(pattern: string): boolean {
  const segments = collapseConsecutiveDoubleStars(pattern.split("/"));
  return segments.filter((seg) => seg === "**").length > MAX_DOUBLE_STARS;
}

export function matchFileRule(pattern: string, opts: MatchFileRuleOptions): boolean {
  const anchor = resolveAnchor(pattern, opts);
  if (anchor === null) return false;

  const targetPath = resolveTargetPath(opts.path, opts.cwd);

  if (isSingleSegmentDirectoryPattern(anchor)) {
    // WS-07 §3.1: "a single-segment directory pattern has deliberately different depth behavior
    // for allow vs ask/deny." Direction reading (provisional, capture-verification-pending -- see
    // paths.test.ts's PAIR fixtures): allow reaches LESS (the exact entry only, so a bare
    // `Read(build)` allow can't silently widen into everything nested under build/ that the
    // settings author never explicitly reviewed); denyAsk reaches MORE (the entry AND everything
    // beneath it at any depth, so a bare `Read(build)` deny/ask can't be defeated by writing one
    // directory deeper than the author pictured) -- ANCHOR-AGNOSTIC per Ruling P2-D (see
    // isSingleSegmentDirectoryPattern's own comment).
    const exact = resolveTargetPath(joinBaseAndRest(anchor.base, stripTrailingSlash(anchor.rest)), opts.cwd);
    if (opts.direction === "allow") return targetPath === exact;
    return isExactOrDescendant(targetPath, exact);
  }

  const fullPattern = normalize(joinBaseAndRest(anchor.base, anchor.rest));
  const regex = compileFsGlobToRegex(fullPattern);
  // Ruling P2-E (deferred to T5, NOT changed here): an over-cap pattern (compileFsGlobToRegex
  // returned null) is inert here for EVERY direction, including deny/ask -- itself a fail-open gap
  // (a too-complex deny rule silently never fires, rather than being rejected). The real fix is
  // LOADER-side rejection at rule-*add* time (T5's rule store), using this module's exported
  // MAX_DOUBLE_STARS as the pre-check threshold, so an over-complex rule is refused before it ever
  // reaches match-time semantics -- deliberately not match-time behavior, so not touched here.
  return regex !== null && regex.test(targetPath);
}

// ---------------------------------------------------------------------------------------------
// checkSymlinkBothEnds
// ---------------------------------------------------------------------------------------------

export interface SymlinkBothEndsResult {
  allowRequiresBoth: boolean;
  denyIfEither: boolean;
}

// Resolves `path` to its real, fully-symlink-resolved target -- tolerating a missing LEAF (e.g. a
// new file about to be Written, which cannot exist yet) by realpath-ing the nearest real ancestor
// and rejoining the remainder, so a symlinked PARENT directory is still honored even though the
// leaf itself has nothing to lstat. A DANGLING symlink (the leaf exists as a link, but its target
// does not) hits the identical ENOENT branch and degrades the same way: this function only ever
// walks `path`'s OWN ancestor chain on failure, never the broken target string the symlink points
// at, so the "resolved target" for a dangling link is just `path` itself, unresolved -- neither
// more nor less permissive than an ordinary non-symlink path (both formulas below collapse to the
// plain single-path check). Not spec-mandated (WS-07 §3.1 never mentions dangling links); pinned
// as a documented, deliberately conservative-by-neutrality choice rather than left to crash.
//
// Task 11 fix-round 1 (Ruling P2-K): exported for permissions/approvals.ts's own "normalized
// paths/destinations" revalidation axis, reused rather than duplicated -- a durable approval's
// execution-time gate is the SOLE check standing between a resumed "allowed" record and
// `tools.execute()` (no second evaluate() pass, no deny-rule re-check, no
// matchFileRuleAtBothEnds composition happens on that path), so it needs the IDENTICAL
// symlink-chasing behavior this file's own callers already get, not a second, independently-
// maintained copy that could silently drift from it.
export function resolveRealTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    const dir = dirname(path);
    if (dir === path) return path; // reached the fs root and still nothing resolves -- give up
    return join(resolveRealTarget(dir), basename(path));
  }
}

// WS-07 §3.1: "Symlinks are checked at both ends: allow requires link AND resolved target to both
// match; deny applies if EITHER matches." `matcher` tests ONE candidate path string against
// whatever rule pattern the caller is evaluating (typically `(p) => matchFileRule(pattern, {...,
// path: p})`, but kept as a plain predicate here so this function stays pure-decision and never
// itself re-derives anchor/opts plumbing) -- composing a matcher with `matchFileRule` for the
// pattern-plus-anchors case is T7's job at the evaluator layer, not this primitive's.
export function checkSymlinkBothEnds(
  path: string,
  matcher: (candidatePath: string) => boolean,
): SymlinkBothEndsResult {
  const target = resolveRealTarget(path);
  const linkMatches = matcher(path);
  const targetMatches = matcher(target);
  return {
    allowRequiresBoth: linkMatches && targetMatches,
    denyIfEither: linkMatches || targetMatches,
  };
}

// ---------------------------------------------------------------------------------------------
// matchFileRuleAtBothEnds -- Ruling P2-J (Task 7, rider 2): the symlink-both-ends composition
// ---------------------------------------------------------------------------------------------
//
// checkSymlinkBothEnds (above) is a bare predicate-composer; T6's report flagged that NOTHING
// actually wired it into the general file-rule matching path (evaluator.ts's `matchesRuleForCall`
// FILE_RULE_TOOLS branch, stages 2/3/5) or into the `default`/`dontAsk`/`bypassPermissions`
// cwd-read baseline (`isReadWithinCwd`) -- both called `matchFileRule` directly against the raw,
// un-resolved path, so `deny Read(//etc/passwd)` did not fire on a Read of a SYMLINK whose target
// is `/etc/passwd`, and a cwd-read baseline would affirmatively ALLOW a symlinked read whose real
// target escapes cwd. This is that composition, written ONCE, here, rather than at each call site
// (both call sites need the identical "resolve the pattern, both ends, one direction-appropriate
// verdict" shape) -- evaluator.ts imports and calls this instead of `matchFileRule` directly for
// both of those uses; `readDenyBlocksEdit` below is upgraded to use it internally too (closing the
// identical gap for its own "Read deny blocks Edit" check, for free, with no call-site changes at
// ITS two current callers).
//
// `opts.path` is pre-resolved to an ABSOLUTE path via the same `resolveTargetPath` matchFileRule
// itself uses, BEFORE handing it to checkSymlinkBothEnds/realpathSync -- realpathSync resolves a
// relative path against the REAL PROCESS cwd, not `opts.cwd`, so skipping this step would silently
// symlink-resolve against the wrong base whenever a caller passes a cwd-relative `path` (the common
// case for a tool call's own `file_path` input). The `matcher` closure re-resolves each candidate
// (link path, then real target) through the identical `matchFileRule` semantics, including its own
// (already-absolute) `resolveTargetPath` call -- calling it twice on an already-absolute string is
// a no-op past the first `isAbsolute` check, not a second resolution.
export function matchFileRuleAtBothEnds(pattern: string, opts: MatchFileRuleOptions): boolean {
  const absPath = resolveTargetPath(opts.path, opts.cwd);
  const matcher = (candidatePath: string): boolean => matchFileRule(pattern, { ...opts, path: candidatePath });
  const { allowRequiresBoth, denyIfEither } = checkSymlinkBothEnds(absPath, matcher);
  return opts.direction === "allow" ? allowRequiresBoth : denyIfEither;
}

// ---------------------------------------------------------------------------------------------
// readDenyBlocksEdit
// ---------------------------------------------------------------------------------------------

// Interface judgment call (concern for T5/T7, flagged the same way T3's report flagged concerns
// for its downstream consumers): the brief's own signature sketch, `readDenyBlocksEdit(rules,
// path): boolean`, has no room for the cwd/home/sourceDir context matchFileRule requires to
// resolve anchors -- that context cannot be invented from nowhere, so it is threaded through as a
// third `ctx` param, mirroring grammar.ts's own `(rule, call, opts)` shape (data, data, options)
// rather than smearing cwd/home onto every rule entry. `sourceDir` stays PER-RULE (on
// `FileRuleEntry`, not `ctx`) because it is genuinely a per-SOURCE fact (WS-07 §3.2: rules arrive
// from managed/user/project/local sources, each potentially its own settings-source directory) --
// cwd/home are the same for every rule in one evaluation, sourceDir is not.
export interface FileRuleEntry {
  toolName: string;
  pattern: string;
  // WS-07 §3.1 says "a Read DENY" specifically, not "deny/ask" -- unlike matchFileRule's own
  // internal "denyAsk" grouping (which is about SHARING conservative matching semantics between
  // deny and ask), this primitive only fires for an actual `deny` behavior. An `ask` on Read means
  // "prompt before reading", which doesn't carry the same "you may not even look at this" signal an
  // outright deny does -- see paths.test.ts's boundary fixture pinning this exactly.
  behavior: PermissionBehavior;
  sourceDir?: string;
}

export function readDenyBlocksEdit(rules: FileRuleEntry[], path: string, ctx: { cwd: string; home: string }): boolean {
  return rules.some((rule) => {
    if (rule.toolName !== "Read" || rule.behavior !== "deny") return false;
    // Ruling P2-J (rider 2): symlink-both-ends composed here too -- a Read deny on
    // `secrets/**` must also block editing a symlink whose real target resolves into `secrets/`,
    // matching the same "deny fires if EITHER end matches" rule the general file-rule path gets.
    return matchFileRuleAtBothEnds(rule.pattern, {
      path,
      cwd: ctx.cwd,
      home: ctx.home,
      direction: "denyAsk",
      // exactOptionalPropertyTypes: conditional spread rather than `sourceDir: rule.sourceDir`,
      // which would assign a statically `string | undefined`-typed value into an optional-but-not-
      // undefined property -- same convention as dialect.ts's appendWithDialectRecord.
      ...(rule.sourceDir !== undefined ? { sourceDir: rule.sourceDir } : {}),
    });
  });
}
