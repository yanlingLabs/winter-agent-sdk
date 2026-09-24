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
import { realpathSync, readlinkSync } from "node:fs";
import { dirname, basename, join, resolve, isAbsolute, normalize } from "node:path";
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
// SV-6 (the router same-view test, real claude 2.1.250): the "author already said how far the rule
// reaches" test must recognise EVERY glob metacharacter claude's own grammar has, not only `*` --
// `Read(fo?)` or `Read([abc])` are just as much an explicit wildcard as `Read(fo*)`, so they must
// compile through the general glob path below rather than being treated as an exact bare name.
// Escape-aware: `\*`, `\?`, `\[` are literal characters to the AUTHOR (whatever the compiled regex
// ultimately does with them -- see globSegmentToRegexBody's own header for `\?`'s claude-side
// quirk), so a pattern that is ENTIRELY escaped metacharacters (e.g. `Read(\*)`, matching a literal
// filename "*") is still a bare single-segment name, not a wildcard.
function hasUnescapedWildcard(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++; // skip the escaped character -- it is literal, not a wildcard, regardless of which one it is
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[") return true;
  }
  return false;
}

function isSingleSegmentDirectoryPattern(anchor: AnchorResolution): boolean {
  const trimmed = stripTrailingSlash(anchor.rest);
  if (trimmed.length === 0) return true;
  return !trimmed.includes("/") && !hasUnescapedWildcard(trimmed);
}

// Fix round 4: exported so evaluator.ts's file-rules.ts-backed callers normalize a call's raw path
// field the SAME way this module's own matchFileRule always has, rather than a second, slightly
// different resolve-and-normalize step drifting in over time.
// Fix round 10, item B: claude's own `ht` (dump byte offset 12083670, pinned 2.1.250) trims its raw
// input FIRST, before anything else -- `let r=t.trim()`, both ends, not merely trailing. Without
// this, an unescaped trailing-space deny rule still failed open: round 9's own
// `escapeFileRulePathSegment` fix covers the RULE side (a Winter-built rule preserves its own real
// trailing whitespace); this covers the QUERY side (the path being CHECKED). `join`/`isAbsolute`/
// `normalize` never trim on their own, so a caller passing `"/r/sp "` straight through kept the
// space here while the real `ignore` package's own line-trimming (round 9's own finding) silently
// dropped it from an UNESCAPED rule's own pattern text -- the two sides never converged. Trimming
// here first means a plain, unescaped `Read(//r/sp )` deny rule protects a call naming `/r/sp `
// (trailing space and all) exactly as it does on claude, with no escaping required.
export function resolveTargetPath(path: string, cwd: string): string {
  const trimmed = path.trim();
  const abs = isAbsolute(trimmed) ? trimmed : join(cwd, trimmed);
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

// WS-21 fix round 4 (minors): SUPERSEDED for Read/Edit permission-rule matching by
// `permissions/file-rules.ts` (C-1, built on the real `ignore` package) -- retained here only as the
// matcher for `context/rules.ts`'s `paths:` conditional-attachment globs (F17), which were never
// asked to replicate claude's file-rule grammar bullet-for-bullet. Said plainly here, at the top,
// because two of the bullets below now say the opposite of what this block's own next two lines
// claim ("ported... exactly") -- see those two bullets' own fix-round-4 notes for which claims are
// wrong and why; this note is what makes reading top-down not land on the wrong one first.
//
// SV-6 (the router same-view test, real claude 2.1.250): the ABSOLUTE-PATH-PATTERN grammar, ported
// to match claude's own file-rule matcher exactly -- the bundled `ignore` npm package (dump-
// confirmed, claude CLI 2.1.250 / agent-sdk 0.3.250: the package's own `Ignore` class,
// `constructor({ignorecase:t=!0,ignoreCase:e=t,...})`, `ignorecase` defaulting TRUE), not Winter's
// own pre-fix-round-3 "every character but `*` is literal" grammar. Exact semantics implemented
// (measured/decoded against the bundled package's own REPLACERS pipeline, dump-confirmed):
//
//   - `*` matches zero or more characters WITHIN one path segment (unchanged from before this fix --
//     WS-07 §3.1's own "`*` stays within one path segment", and "build*" matching bare "build" too).
//   - `?` matches EXACTLY ONE character, never `/` (the `ignore` package's own
//     `[/(?!\\)\?/g, () => "[^/]"]` replacer).
//   - `[...]` is a CHARACTER CLASS, passed through to the compiled regex near-verbatim (the
//     package's own bracket-expression replacer keeps the class body largely as authored); a
//     malformed class -- unterminated, or one whose *compiled* regex construction throws for any
//     reason -- degrades HERE to an impossible class (`[]`, matches nothing) rather than a thrown
//     SyntaxError propagating out of a rule-matching call.
//     WS-21 fix round 4 (minors, review-L1a-fix3-findings.md): the line this replaces claimed that
//     was "the SAME never-match posture the package's own replacer falls back to" -- WRONG, and
//     corrected here rather than silently left. A REVERSED RANGE such as `[z-a]` is exactly the
//     case that shows the gap: the real `ignore` package (confirmed against the pinned 7.0.5 source,
//     `file-rules.ts`'s own citation) drops only the offending range and keeps matching on the rest
//     of the class, where this function's `new RegExp(...)` construction throws on the WHOLE
//     pattern and this catch degrades the WHOLE class to never-match -- a real behavioural
//     divergence from claude, not a "same posture" restated. It is left AS BEHAVIOUR here
//     deliberately: this module is no longer the claude-parity engine for `Read`/`Edit` file rules
//     (`file-rules.ts`, built on the real package, is -- see this module's own header), and its one
//     remaining production caller (`context/rules.ts`'s `paths:` conditional-attachment glob, F17)
//     was never asked to replicate claude's file-rule grammar bullet-for-bullet.
//   - `\[` (and its natural pair `\]`) escapes to a literal `[`/`]` -- the escape the package's own
//     grammar meaningfully recognises (its bracket replacer's `e===g` branch: an escaped `[` is
//     re-escaped as a literal match and never opens a class; a `]` is not a metacharacter outside
//     an open class to begin with, so escaping it is a courtesy pairing, not a distinct mechanism).
//   - `\*` escapes to a literal `*` -- recognised the same deliberate way (the package's own
//     star-wildcard replacer only ever converts a run of UNESCAPED stars).
//   - `\?` is a CLAUDE-SIDE QUIRK, not a Winter simplification, and is ported exactly rather than
//     "fixed": the package's grammar has no dedicated `\?`-escape rule the way it does for `[`/`*`,
//     so the backslash is not consumed as an escape at all -- it survives into the compiled pattern
//     as a LITERAL BACKSLASH CHARACTER requirement immediately before the (still-wildcarded) `?`
//     slot. No real path segment contains a literal backslash, so an author-written `\?` compiles
//     to something that can never match a real target -- "an escaped `\?` never matches" is
//     therefore an accurate description of the OBSERVABLE behaviour, not a bug Winter is expected to
//     paper over.
//   - `{`, `}`, `(`, `)`, `!`, `#` and a literal space all match themselves LITERALLY in THIS
//     function -- none of them carry glob meaning inside a pattern body here.
//     WS-21 fix round 4 (minors, review-L1a-fix3-findings.md): the line this replaces claimed `!`/
//     `#` "do not apply here" for a `Read`/`Edit` specifier because it is "one rule's pattern text,
//     never a multi-line ignore-file body" -- WRONG. Claude's own pipeline feeds a Read/Edit
//     specifier's pattern through the identical `ignore()` machinery a `.gitignore` LINE goes
//     through, one line at a time, so a leading `!` (negation) or `#` (comment) DOES carry its
//     gitignore meaning there, "one rule, not a multi-line file" notwithstanding -- confirmed by the
//     real `ignore` package's own replacers, which `file-rules.ts` now runs unmodified for every
//     Read/Edit rule. Left as BEHAVIOUR here deliberately, same reasoning as the character-class
//     note above: this function is no longer the claude-parity engine for those rules.
//   - Every other character is an ordinary literal, regex-escaped only when it is itself a regex
//     metacharacter (unchanged from before this fix).
//
// Case-insensitivity is applied by the CALLER (compileFsGlobToRegex, the `i` flag) rather than
// here, since it is a whole-regex construction concern, not a per-segment one.
//
// Never called with an actual "**" segment -- compileFsGlobToRegex intercepts that case first.
function globSegmentToRegexBody(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\") {
      const next = segment[i + 1];
      if (next === "[") {
        out += "\\[";
        i++;
        continue;
      }
      if (next === "]") {
        // The closing half of `\[wip\]`'s own escape: the `ignore` package's bracket replacer finds
        // a class body only up to the first UNESCAPED `]`, then trims a lone escaping backslash
        // before it to nothing -- the bare `]` that remains is not a metacharacter outside an open
        // `[` in the first place, so it already matches literally on its own. Handled explicitly
        // here (rather than relying on that fact alone) so `\]` reads as one deliberate escape pair
        // with `\[`, not as "an unrecognised escape whose backslash survives literally" the way
        // `\?` and everything else below does.
        out += "\\]";
        i++;
        continue;
      }
      if (next === "*") {
        out += "\\*";
        i++;
        continue;
      }
      if (next === "?") {
        // The "\? never matches" quirk, ported exactly -- see this function's own header. The
        // literal backslash requirement is what makes it unmatchable against a real path.
        out += "\\\\[^/]";
        i++;
        continue;
      }
      // No other escape is meaningfully recognised by claude's own grammar either -- the backslash
      // itself is just another literal character to match, like every other unescaped one.
      out += "\\\\";
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close === -1) {
        out += "[]"; // unterminated -- never-matches, mirroring the ignore package's own fallback
        break;
      }
      const body = segment.slice(i + 1, close);
      out += `[${sanitizeCharClassBody(body)}]`;
      i = close;
      continue;
    }
    out += escapeRegexChar(ch);
  }
  return out;
}

// The interior of a `[...]` character class, made SAFE for a real JS regex character class while
// keeping it near-verbatim: a literal backslash inside the class is re-escaped (so it can never be
// misread as an unintended JS regex class escape, e.g. `\d`, that the pattern's author did not
// write with regex-metacharacter intent) -- everything else, including `^` (negation) and `-`
// (ranges), passes through exactly as authored, matching the `ignore` package's own
// near-verbatim-passthrough posture for a class body.
function sanitizeCharClassBody(body: string): string {
  return body.replace(/\\/g, "\\\\");
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
// P2 fix-wave item 3 (was: "Residual, explicitly NOT addressed by either mitigation ... P2 fix-wave
// tracks it" -- now closed, see MAX_STARS_PER_SEGMENT below): a SINGLE segment carrying many `*`
// tokens (e.g. "a*a*a*a*a*a*a*b") compiles, via globSegmentToRegexBody, to that many sequential
// "[^/]*" groups WITHIN one segment's own regex body -- untouched by MAX_DOUBLE_STARS, which only
// counts whole "**" segment tokens, never `*` occurrences inside a segment. Matched against a long,
// non-matching candidate segment this is the same shape of ambiguous-partition backtracking
// (polynomial in the star count), under the identical untrusted-rule threat model (WS-07 §3.2:
// project deny/ask rules apply without workspace trust).
export const MAX_DOUBLE_STARS = 8;

function collapseConsecutiveDoubleStars(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "**" && out[out.length - 1] === "**") continue;
    out.push(seg);
  }
  return out;
}

// P2 fix-wave item 3: the same-segment multiple-`*` cap named above. 8 mirrors MAX_DOUBLE_STARS'
// own generous-headroom rationale (this module's own corpus never exceeds one or two `*` in a
// single segment). Excludes "**" segments themselves -- those are governed entirely by the
// SEPARATE MAX_DOUBLE_STARS mechanism (a "**" segment never goes through globSegmentToRegexBody at
// all, so counting its own two characters here would conflate two independent bounds).
//
// DIRECTION-AWARE, UNLIKE MAX_DOUBLE_STARS (below, deliberately unchanged -- match-time-inert on
// BOTH directions, per Ruling P2-E's own "deferred to T5" comment at this function's call site):
// this cap is checked and resolved BEFORE compilation is ever attempted (matchFileRule, below),
// never by returning `null` from inside a compiler and letting that resolve to a uniform `false`.
// On "allow" it resolves to `false` (a too-complex allow simply never grants -- safe under-grant,
// the SAME posture MAX_DOUBLE_STARS' own inertness already has). On "denyAsk" it resolves to `true`
// (a too-complex safety rule fails SAFE -- counts as matching, denies/asks broadly -- rather than
// silently doing nothing) if it somehow reaches match time without having been rejected at add time
// (ruleset.ts's validateNewRule extends Ruling P2-E's own add-time-rejection precedent to this cap,
// via the exported probe below) -- closing, for THIS cap specifically, the identical "fail-open gap
// for deny/ask" class Ruling P2-E's own comment names as an accepted, add-time-mitigated residual
// for MAX_DOUBLE_STARS.
export const MAX_STARS_PER_SEGMENT = 8;

function countStars(segment: string): number {
  let count = 0;
  for (const ch of segment) if (ch === "*") count++;
  return count;
}

function exceedsStarsPerSegment(segments: string[]): boolean {
  return segments.some((seg) => seg !== "**" && countStars(seg) > MAX_STARS_PER_SEGMENT);
}

// Rule-add-time probe for MAX_STARS_PER_SEGMENT, mirroring exceedsDoubleStarCap's own precedent
// exactly (same caller -- ruleset.ts's validateNewRule; same "raw, pre-anchor pattern text, no
// leading '/' required" scope; same collapse-then-count shape). A future task adding a THIRD
// segment-shaped cap should extend this pairing pattern, not invent a new one.
export function exceedsStarsPerSegmentCap(pattern: string): boolean {
  return exceedsStarsPerSegment(collapseConsecutiveDoubleStars(pattern.split("/")));
}

// Compiles an already-split, already-capped segment sequence into a regex matched against a full
// absolute target path. Takes `segments` (never a raw pattern string) because BOTH caps above must
// be checked, on the SAME segment sequence, before this is ever called -- see matchFileRule, the
// only caller, for why that ordering matters (MAX_STARS_PER_SEGMENT resolves directionally and
// never reaches this function at all; MAX_DOUBLE_STARS resolves uniformly and also short-circuits
// before this point). `**` (WS-07 §3.1: "`**` crosses directories") becomes "(?:/[^/]+)*" wherever
// it sits in the segment sequence -- zero or more complete "/segment" groups -- which uniformly
// covers every position:
//   ["a","**","b"] -> "/a(?:/[^/]+)*/b"   matches /a/b, /a/x/b, /a/x/y/b
//   ["**","b"]     -> "(?:/[^/]+)*/b"     matches /b, /x/b, /x/y/b
//   ["a","**"]     -> "/a(?:/[^/]+)*"     matches /a, /a/x, /a/x/y
// Judgment call (documented, not part of the required corpus): the trailing-`**` case above
// deliberately ALSO matches the bare base itself ("/a"). Real gitignore's own trailing "/**" is
// contents-only (does not match "a" itself) -- diverged here for a single uniform "zero or more"
// rule rather than three positional variants, since WS-07 §3.1 pins "`**` crosses directories" as
// one general fact, not gitignore's own fuller grammar. Flagged in the report; a one-line change
// (require 1+ reps only when the "**" is the LAST segment) if a differential capture disagrees.
// SV-6: `i` (case-insensitive), matching claude's own matcher exactly -- the bundled `ignore`
// package's `ignorecase` option defaults TRUE (dump-confirmed, this function's own sibling comment
// on globSegmentToRegexBody). A character class whose body is malformed enough to make the FINAL
// regex construction itself throw (a real, if rare, possibility despite sanitizeCharClassBody's own
// escaping) degrades to never-matching rather than propagating a SyntaxError out of a rule-matching
// call -- the same never-match posture this compiler already gives an unterminated `[...]`.
function compileFsGlobToRegex(segments: string[]): RegExp {
  let out = "";
  for (const seg of segments) {
    out += seg === "**" ? "(?:/[^/]+)*" : "/" + globSegmentToRegexBody(seg);
  }
  try {
    return new RegExp(`^${out}$`, "i");
  } catch {
    return /(?!)/; // never matches anything -- fails closed for a malformed class, not a throw
  }
}

// Task 5 (Ruling P2-E): rule-add-time probe for the SAME cap compileFsGlobToRegex's own caller
// (matchFileRule) enforces at match time, so a Read/Edit rule store (packages/runtime/src/
// permissions/ruleset.ts) can reject an over-cap pattern when it is ADDED rather than let it
// silently resolve to never-matching, including for deny/ask -- a fail-open gap for those two
// directions, see matchFileRule's own comment for where that gap is now closed one layer more
// directly for MAX_STARS_PER_SEGMENT specifically) at match time. Reuses
// collapseConsecutiveDoubleStars + MAX_DOUBLE_STARS rather than letting a caller re-derive the
// collapse/count algorithm independently, which would drift the moment either changes here.
// Anchor-independent: an absolute pattern's segments are exactly [...anchor's literal base
// segments, ...this raw pattern's own segments], and a literal base segment is by definition never
// "**" -- so prepending it can never change the "**" count. The caller may therefore pass the RAW,
// pre-anchor rule pattern exactly as authored (this function does not require -- and must not
// require -- a leading "/", unlike matchFileRule's own internal `fullPattern`).
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
  const segments = collapseConsecutiveDoubleStars(fullPattern.slice(1).split("/")); // fullPattern always starts with "/"

  // P2 fix-wave item 3: checked FIRST, before MAX_DOUBLE_STARS or compilation -- see
  // MAX_STARS_PER_SEGMENT's own header for the direction-aware resolution this cap uses, unlike
  // MAX_DOUBLE_STARS immediately below.
  if (exceedsStarsPerSegment(segments)) {
    return opts.direction === "denyAsk";
  }

  // Ruling P2-E (deferred to T5, NOT changed here): an over-cap MAX_DOUBLE_STARS pattern is inert
  // here for EVERY direction, including deny/ask -- itself a fail-open gap (a too-complex deny rule
  // silently never fires, rather than being rejected). The real fix is LOADER-side rejection at
  // rule-*add* time (T5's rule store), using this module's exported MAX_DOUBLE_STARS as the
  // pre-check threshold, so an over-complex rule is refused before it ever reaches match-time
  // semantics -- deliberately not match-time behavior, so not touched here.
  const doubleStarCount = segments.filter((seg) => seg === "**").length;
  if (doubleStarCount > MAX_DOUBLE_STARS) return false;

  return compileFsGlobToRegex(segments).test(targetPath);
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

// Fix round 13 (Important item 2, claude's own `Ii`/here named `yh` in its own dump chunk -- see
// this function's own citation below): a MANUAL, ITERATIVE symlink-chain resolver, distinct from
// `resolveRealTarget` above and NOT a replacement for it -- `resolveRealTarget` is correct and
// unchanged for its own, much more common purpose ("a not-yet-existing WRITE target with no symlink
// involved at all," where falling back to the literal path text is exactly right). This one exists
// for a narrower, security-relevant case `resolveRealTarget` cannot answer: a symlink whose ULTIMATE
// target does not (yet) fully exist on disk -- a dangling link, or a link into a not-yet-created
// subtree (`ln -s .git/hooks/pre-commit innocent` in a fresh repo with no hooks installed yet).
// `realpathSync` throws for the WHOLE chain in that case, and `resolveRealTarget`'s own ENOENT
// fallback walks up `path`'s OWN ancestors -- it never reads what the symlink ITSELF points at, so
// it falls back to the LINK'S OWN literal name, silently losing the fact that it was ever a symlink
// at all.
//
// claude's own `Ii` (dump byte 15346812; minified as `yh` in the chunk it was found in --
// content-search on `readlinkSync` near the sandbox/permissions super-region, since a name search
// for the literal `Ii` collides with unrelated same-named functions in other bundle chunks, the
// SAME cross-chunk problem this whole engagement keeps hitting): up to `eR` (40) hops, each one
// tries `realpathSync` on the whole current candidate; on failure, walks UP via `dirname` to find
// the DEEPEST ancestor that DOES fully resolve, then `readlinkSync`s the immediate child under that
// ancestor (works even when that child is a DANGLING symlink, unlike `realpathSync`) -- a non-symlink
// (readlink itself throws) returns the reconstructed "resolved-ancestor + literal remainder" path,
// matching `resolveRealTarget`'s own fallback shape exactly; a symlink (readlink succeeds) splices
// its OWN raw target text in place of the unresolved child and loops again, so a CHAIN of dangling
// symlinks is followed just as far as claude's own `Ii` follows it.
const MAX_SYMLINK_CHAIN_HOPS = 40;

export function resolveSymlinkTargetChain(path: string): string | undefined {
  let current = path;
  for (let hop = 0; hop < MAX_SYMLINK_CHAIN_HOPS; hop++) {
    try {
      return realpathSync(current);
    } catch {
      // fall through to the manual, one-hop-at-a-time walk below
    }
    let probe = current;
    const remainder: string[] = [];
    let deepestReal: string | null = null;
    while (deepestReal === null) {
      const parent = dirname(probe);
      if (parent === probe) return undefined; // reached the fs root and still nothing resolves -- give up
      remainder.unshift(basename(probe));
      probe = parent;
      try {
        deepestReal = realpathSync(probe);
      } catch {
        // keep walking up
      }
    }
    const firstUnresolved = join(deepestReal, remainder[0]!);
    let linkValue: string | null = null;
    try {
      linkValue = readlinkSync(firstUnresolved);
    } catch {
      // not a symlink at all -- linkValue stays null, matching claude's own w===null branch
    }
    if (linkValue === null) return join(deepestReal, ...remainder);
    current = join(resolve(dirname(firstUnresolved), linkValue), ...remainder.slice(1));
  }
  return undefined;
}

// WS-07 §3.1: "Symlinks are checked at both ends: allow requires link AND resolved target to both
// match; deny applies if EITHER matches." `matcher` tests ONE candidate path string against
// whatever rule pattern the caller is evaluating (typically `(p) => matchFileRule(pattern, {...,
// path: p})`, but kept as a plain predicate here so this function stays pure-decision and never
// itself re-derives anchor/opts plumbing) -- composing a matcher with `matchFileRule` for the
// pattern-plus-anchors case is T7's job at the evaluator layer, not this primitive's.
//
// Fix round 13: a THIRD candidate, `resolveSymlinkTargetChain`'s own result, joins the SAME "deny if
// any end matches, allow only if every end does" composition -- `checkSymlinkBothEnds`'s own header
// already calls this "a bare predicate-composer" (Ruling P2-J, a Winter-specific mechanism, not
// itself a direct claude port), so extending its own "both/either" rule to a third candidate is this
// module's own consistent choice, not a claim about claude's own (different) allow-retry mechanism.
// `undefined` when the chain resolver gives up entirely (mirrors `resolveRealTarget`'s own
// "give up at the fs root" case) -- simply omitted from the candidate set, never treated as a match.
export function checkSymlinkBothEnds(
  path: string,
  matcher: (candidatePath: string) => boolean,
): SymlinkBothEndsResult {
  const target = resolveRealTarget(path);
  const chainTarget = resolveSymlinkTargetChain(path);
  const linkMatches = matcher(path);
  const targetMatches = matcher(target);
  const chainTargetMatches = chainTarget !== undefined ? matcher(chainTarget) : undefined;
  return {
    allowRequiresBoth: linkMatches && targetMatches && (chainTargetMatches ?? true),
    denyIfEither: linkMatches || targetMatches || (chainTargetMatches ?? false),
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
