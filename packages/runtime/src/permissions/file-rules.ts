// Fix round 4 (C-1 + SV-7, the router same-view test): PORTS claude's own file-rule pipeline --
// `jOe` -> `xi` -> `ki` -> `ln` -> `Ma` (dump-confirmed by content search, claude CLI 2.1.250 /
// agent-sdk 0.3.250) -- using the REAL `ignore` npm package at the EXACT version claude bundles.
//
// THE PINNED VERSION IS 7.0.5 (MIT, Kael Zhang <i@kael.me>). Identified from FOUR independent
// structural fingerprints in the dump (regex/parameter shapes survive minification; comments and
// identifier names do not, so none of these rely on either):
//   1. `IgnoreRule`'s constructor takes SIX positional params in the order
//      `(pattern, mark, body, ignoreCase, negative, prefix)` -- the dump's own
//      `class G{constructor(t,e,s,r,n,o){this.pattern=t,this.mark=e,this.negative=n,
//      _(this,"body",s),_(this,"ignoreCase",r),_(this,"regexPrefix",o)}}` matches this exactly.
//      This shape is 7.x-only (5.x/6.x use a 4-param `(origin, pattern, negative, regex)`).
//   2. The relative-path-prefix regex is `/^\.{0,2}\/|^\.{1,2}$/` (dump: `v=/^\.{0,2}\/|^\.{1,2}$/`)
//      -- introduced in 7.0.4 (7.0.0-7.0.3 use `/^\.*\/|^\.{1,2}$/`).
//   3. `"setupWindows"` appears as a string literal (`Symbol.for('setupWindows')`, a TESTING-ONLY
//      export) and `"IGNORE_TEST_WIN32"` does NOT appear anywhere in the dump -- 7.0.5 replaced the
//      old inline `process.env.IGNORE_TEST_WIN32`-gated top-level Windows setup with a named
//      `setupWindows` function exported (for tests only) under that symbol; 7.0.4 and earlier still
//      have the old inline shape with no such string.
//   4. The trailing-`/**`-collapse regex is `/^\^*\*\*\//` with NO `(?:` prefix (dump:
//      `[/^\^*\\\*\\\*\\\//,()=>"^(?:.*\\/)?"]`) -- 7.0.6 changed the SOURCE pattern itself to
//      `/^\^*(?:\*\*\/)?...` (a distinct regex, not just a comment/name change), so the dump
//      predates that release.
//   Fingerprints 2+3 jointly lower-bound the version at >=7.0.5; fingerprint 4 upper-bounds it at
//   <=7.0.5. The four converge on exactly one release: 7.0.5.
// `packages/runtime/package.json` pins `"ignore": "7.0.5"` (exact, no caret) for this reason -- a
// caret range could silently drift onto a LATER release with different matching semantics the two
// runtimes would then disagree about again.
//
// SUPERSEDES paths.ts's hand-rolled `matchFileRule`/`compileFsGlobToRegex` (WS-07 §3.1's own
// directory-anchored model, and SV-6's gitignore-flavoured-but-hand-ported grammar) for every
// FILE_RULE_TOOLS call. Superseded findings, kept for history rather than deleted from that file:
//   - Winter's allow-exact-only asymmetry is RETIRED by explicit controller ruling: it is not
//     claude's behaviour, and WS-21's rule is that the two runtimes behave as one. `allow foo` now
//     matches `/anywhere/foo`, exactly as it does on claude.
//   - A bare pattern with no inner `/` matches at ANY depth (the `ignore` package's own
//     `^(?=[^^])` -> `(?:^|\/)` replacer, ported for free by using the real package).
//   - `ignore#test()`'s OWN `_t()` method walks every parent directory of the target FIRST and
//     short-circuits on a parent match ("It is not possible to re-include a file if a parent
//     directory of that file is excluded" -- the package's own doc comment, index.js:713) -- this
//     is NOT reimplemented here. Do not "optimize" this module by adding an explicit ancestor loop;
//     the real package already does it, correctly, on every `.test()` call.
//
// GROUPED MATCHING IS LOAD-BEARING, NOT COSMETIC. Claude builds ONE `ignore()` instance per anchor
// ROOT, fed every applicable rule's pattern together -- never one rule at a time. This is why a
// leading `!`/`#` (gitignore negation/comment) only makes sense ported this way: `deny Read(src/**)`
// plus `deny Read(!src/keep.txt)` in the SAME group un-ignores `keep.txt`; matching them one rule at
// a time (as evaluator.ts used to) cannot reproduce that at all. `matchFileRulesGrouped` below is
// the one entry point; a caller must gather every applicable rule for a (kind, behavior) pair and
// pass them ALL in one call, never loop and call this per rule.
//
// DISCLOSED SIMPLIFICATIONS (fix round 4 report has the full list):
//   - No caching layer (claude's own `ln` memoizes compiled `ignore()` instances against an LRU
//     keyed by locale/cwd/etc, `EN()`). Correctness over performance at this stage; every call
//     rebuilds its `ignore()` instances fresh. A future perf pass can add memoization without
//     changing this module's observable behaviour.
//   - `bl`/`IDe` (claude's settings-source-directory resolver for a `/`-anchored rule) is not
//     ported: `SourcedRuleEntry` (ruleset.ts) carries no per-entry settings-source directory today
//     (a pre-existing, disclosed gap -- see evaluator.ts's own prior note), so a `/`-anchored rule
//     stays INERT here exactly as it already was before this fix round, on every direction. This
//     mirrors `MatchFileRuleOptions.sourceDir`'s own conservative "absent = inert" precedent.
//   - `Ii`'s (claude's own symlink-variant collector) platform-specific branches -- UNC paths,
//     automount `/net` detection, "collapsed landing" symlink chains -- are not ported. Winter's own
//     `resolveRealTarget`/`checkSymlinkBothEnds` (paths.ts, unchanged) already cover the two
//     candidates (the link path and its real target) that matter on macOS, which is this codebase's
//     only supported platform (CLAUDE.md's own "latest-OS floors" rule).
//   - Every `U()==="windows"` branch in claude's own pipeline (path-separator normalization, UNC
//     drive-letter handling) is skipped. Disclosed, not silently dropped.
//   - The `E.has(D+"/**")` rule-attribution PREFERENCE (which of two overlapping rules gets cited
//     in a deny/ask message when both would match) is replaced by a simpler, behaviourally
//     EQUIVALENT mechanism: this module keeps its own `Map` from a compiled pattern string straight
//     back to the rule entry that produced it, built at the same time the `ignore()` instance is
//     built, rather than reconstructing the pre-`ki` key from the post-`ki` one the way claude's own
//     code (which reuses a cache keyed by the pre-`ki` text for an unrelated reason) has to. This
//     changes AT MOST which of two otherwise-equivalent overlapping rules a caller cites in an
//     audit message -- never the allow/deny/ask verdict itself, which depends only on whether SOME
//     rule in the group matched.
import { relative } from "node:path";
import ignoreFactory from "ignore";

// ---------------------------------------------------------------------------------------------
// SV-7: the tool -> rule-kind map
// ---------------------------------------------------------------------------------------------

export type FileRuleKind = "edit" | "read";

/**
 * SV-7 (the router same-view test): claude's file-rule grammar has only TWO pattern kinds --
 * `Edit(...)` and `Read(...)`. Dump-confirmed: `ln`'s own dispatch switch has exactly two cases
 * (`case"edit":return tn;case"read":return wt`, each a SINGLE literal tool-name string `ub` filters
 * `ruleValue.toolName` against by exact equality) -- there is no third "write" kind anywhere in the
 * data model. Claude's own WRITE decision function (`zC`) ALWAYS consults `"edit"`-kind rules,
 * regardless of which literal write-shaped tool called it -- this is what makes an `Edit(...)` ask
 * rule fire before a **Write** on claude (the router's own SV-7 measurement), and what makes a
 * `Write(...)`-toolName rule a Winter-only spelling with no claude analogue at all: `ub` filtering
 * on the literal string "Write" never runs, because nothing ever calls it with that string.
 *
 * Every `FILE_RULE_TOOLS` member (grammar.ts) routes to exactly one kind, on every direction (allow,
 * ask, deny alike -- the ruling's own "for both ALLOW and DENY" instruction, extended to ask since
 * ask shares deny's conservative "cross tools" posture throughout this codebase already).
 */
export function fileRuleKindFor(toolName: string): FileRuleKind | undefined {
  switch (toolName) {
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Read":
    case "Glob":
    case "Grep":
      return "read";
    default:
      return undefined;
  }
}

/**
 * The ONE literal tool name a rule must be AUTHORED under to ever be consulted for `kind` -- claude's
 * own `ub` filters `ruleValue.toolName` by EXACT STRING EQUALITY against a single literal per kind
 * (`tn`/`"Edit"` for `"edit"`, `wt`/`"Read"` for `"read"`; dump-confirmed, `ln`'s own two-case
 * switch), never against every tool that happens to share the kind. This is what makes SV-7's
 * "reverse" finding true: a rule AUTHORED as `Write(...)`, `NotebookEdit(...)`, `Glob(...)` or
 * `Grep(...)` is dead code claude never reads for ANY call -- not even a call from that SAME literal
 * tool -- because `ub` was never invoked with that string. `Write`/`NotebookEdit`/`Glob`/`Grep`
 * remain valid rule-authoring tool names SYNTACTICALLY (grammar.ts's `FILE_RULE_TOOLS` still parses
 * them -- Winter does not forbid authoring one), but this function is what `findMatchingFileRuleEntry`
 * (evaluator.ts) filters CANDIDATES with, so only `Edit(...)`/`Read(...)`-authored rules ever reach
 * a group.
 */
export function canonicalFileRuleAuthoringToolName(kind: FileRuleKind): "Edit" | "Read" {
  return kind === "edit" ? "Edit" : "Read";
}

// ---------------------------------------------------------------------------------------------
// `jOe`: anchor resolution
// ---------------------------------------------------------------------------------------------

/** A sentinel distinct from `null` ("resolve against cwd"): a `/`-anchored rule with no resolvable settings-source directory is INERT, never falls back to cwd. */
const INERT_ANCHOR = Symbol("file-rule-inert-anchor");

export interface FileRuleAnchor {
  /** The pattern text, relative to `root`, in `ignore`-package (gitignore) grammar. */
  relativePattern: string;
  /** `null` means "resolve against cwd" (`Ma`'s own `P ?? te()`, ported as `root ?? opts.cwd`); the sentinel means the anchor can never match anything. */
  root: string | null | typeof INERT_ANCHOR;
}

/**
 * `jOe` (dump-confirmed): the FOUR anchor spellings WS-07 §3.1 documents, resolved to a
 * `{relativePattern, root}` pair -- ported exactly, including the leading-slash-KEPT behaviour on
 * the three anchored forms (`//x`, `~/x`, `/x`) that is what makes them root-anchored in gitignore
 * terms, and its ABSENCE on `./x`/bare `x` that is what lets `deny ./.env` reach `pkg/.env` (C-1's
 * own example) -- a bare pattern with no leading slash and no inner slash is exactly the shape the
 * `ignore` package's own `^(?=[^^])` -> `(?:^|\/)` replacer un-anchors.
 *
 * A bare `~` (no trailing slash) is NOT specially handled by claude's own `jOe` either -- it falls
 * through to the final else branch as a literal filename pattern `"~"`, cwd-anchored. Ported
 * faithfully rather than "fixed", matching this module's own "port what was measured" discipline.
 *
 * `sourceDir` is claude's `bl(source)` -- the settings-source-derived root for a `/`-anchored rule.
 * `SourcedRuleEntry` carries no such value today (a pre-existing, disclosed gap), so every caller in
 * this codebase passes `undefined`, making a `/`-anchored rule inert (`root: undefined` below,
 * treated as "no group to match against" by `matchFileRulesGrouped`) -- unchanged from before this
 * fix round.
 */
export function resolveFileRuleAnchor(pattern: string, opts: { home: string; sourceDir?: string | undefined }): FileRuleAnchor {
  if (pattern.startsWith("//")) {
    return { relativePattern: pattern.slice(1), root: "/" };
  }
  if (pattern.startsWith("~/")) {
    return { relativePattern: pattern.slice(1), root: opts.home };
  }
  if (pattern.startsWith("/")) {
    if (opts.sourceDir === undefined) return { relativePattern: pattern, root: INERT_ANCHOR };
    return { relativePattern: pattern, root: opts.sourceDir };
  }
  if (pattern.startsWith("./")) {
    return { relativePattern: pattern.slice(2), root: null };
  }
  return { relativePattern: pattern, root: null };
}

// ---------------------------------------------------------------------------------------------
// `xi`: leading-BOM handling
// ---------------------------------------------------------------------------------------------

/**
 * `xi` (dump-confirmed): collapses repeated slashes, and specially handles a LEADING BOM so it
 * cannot accidentally trigger gitignore's own `!`/`#` line-directive meaning (negation/comment). A
 * bare leading BOM with no `!`/`#` after it is DELETED outright (empirically verified: the first of
 * the two `.replace()` calls below always consumes a leading BOM, since `^﻿` in its own regex
 * is unconditional and only the FOLLOWING `[!#]?` is optional -- the second `.replace(/^﻿/,
 * "[﻿]")` is therefore unreachable dead code in the pinned binary's own source whenever the
 * input genuinely starts with a BOM, ported here as harmless dead code too rather than "corrected"
 * into a change of behaviour this module was not asked to make). A leading BOM immediately followed
 * by `!` or `#` becomes an escaped literal `!`/`#` (so the directive character survives as TEXT to
 * match, not as a line-level instruction).
 */
export function normalizeFileRulePattern(relativePattern: string): string {
  const collapsed = relativePattern.replace(/\/{2,}/g, "/");
  if (/^\s*(?:\/\*\*)?$/.test(collapsed)) return collapsed;
  return collapsed.replace(/^﻿([!#]?)/, (_m, directive: string) => (directive ? "\\" + directive : "")).replace(/^﻿/, "[﻿]");
}

// ---------------------------------------------------------------------------------------------
// `ki`: the trailing-`/**` unanchoring transform (allow/deny asymmetry)
// ---------------------------------------------------------------------------------------------

/**
 * `ki` (dump-confirmed): a pattern ending in `/**` is rewritten before being fed to `ignore()`.
 * - For DENY/ASK (`isAllow: false`): the trailing `/**` is simply dropped (`x/**` -> `x`), and the
 *   result is left UNANCHORED (no leading `/` added) whenever it already has an inner `/`, is not an
 *   allow rule, or already starts with `!`/`#` -- i.e. almost always for deny/ask. This is C-1's own
 *   "`ki` turns a deny `x/**` into an unanchored `x`" finding: the bare `x` then matches at ANY
 *   depth under the `ignore` package's own un-anchoring rule, covering everything under a directory
 *   named `x` anywhere, not merely the literal anchor-relative `x/`.
 * - For ALLOW, when the stripped form has NO inner `/` (a single segment) and does not start with
 *   `!`/`#`: the result is instead explicitly re-anchored (`x/**` -> `/x`), so `allow x/**` stays
 *   scoped to the anchor root rather than becoming an anywhere-match the way the deny/ask case does.
 *   This asymmetry is real and claude's own (not the allow-exact-only asymmetry the controller
 *   retired) -- it survives because it is measured, not invented.
 * - A pattern whose stripped form is empty or all-slashes (`/**`, `//**`) is left as `/**`.
 * - Any pattern that does NOT end in `/**` passes through unchanged.
 */
export function unanchorTrailingDoubleStar(pattern: string, isAllow: boolean): string {
  if (!pattern.endsWith("/**")) return pattern;
  const stripped = pattern.slice(0, -3);
  if (/[^/]/.test(stripped)) {
    return stripped.includes("/") || !isAllow || /^[!#]/.test(stripped) ? stripped : "/" + stripped;
  }
  return "/**";
}

// ---------------------------------------------------------------------------------------------
// `ln` + `Ma`: grouped compilation and matching
// ---------------------------------------------------------------------------------------------

export interface FileRuleCandidate<TEntry> {
  entry: TEntry;
  /** The rule's own specifier text, exactly as authored (the `jOe`/`xi`/`ki` chain runs on this). */
  pattern: string;
  /** `bl(source)`'s stand-in for a `/`-anchored rule -- see `resolveFileRuleAnchor`'s own header. Absent = every `/`-anchored candidate is inert. */
  sourceDir?: string | undefined;
}

interface RootGroup<TEntry> {
  /** Keyed by the `ki`-compiled pattern text actually fed to `ignore()` -- see this module's header on why this replaces claude's own `E.has(D+"/**")` reconstruction. */
  byCompiledPattern: Map<string, TEntry>;
  ig: ReturnType<typeof ignoreFactory>;
}

function isPathValidRelative(rel: string): boolean {
  // `ignore#isPathValid`'s own job for a RELATIVE path candidate: never absolute, never escaping
  // the root via a leading `..` segment. `relative()` already normalizes `.`/`..` internally, so a
  // target outside `root` shows up here as a string starting with `..`.
  return rel !== "" && !rel.startsWith("..") && rel !== ".";
}

/**
 * `ln`+`Ma`, combined into one grouped match: builds ONE `ignore()` instance per anchor ROOT from
 * every candidate (see this module's header for why grouping is load-bearing, not cosmetic), then
 * tests `path` against each root's group in turn, returning the FIRST candidate's own `entry` whose
 * group matched -- `null` when nothing matched anywhere. `behavior` is `"allow"` or `"denyAsk"`,
 * mirroring `matchFileRule`'s own existing direction vocabulary (never allow AND denyAsk on the
 * page a caller passed to `ki`, exactly as `ln`'s `r==="allow"` check is exactly `behavior==="allow"`
 * here too).
 */
export function matchFileRulesGrouped<TEntry>(candidates: readonly FileRuleCandidate<TEntry>[], path: string, opts: { cwd: string; home: string }, behavior: "allow" | "denyAsk"): TEntry | null {
  if (candidates.length === 0) return null;
  const groups = new Map<string, RootGroup<TEntry>>();
  const groupOrder: string[] = [];
  for (const candidate of candidates) {
    const anchor = resolveFileRuleAnchor(candidate.pattern, { home: opts.home, sourceDir: candidate.sourceDir });
    if (anchor.root === INERT_ANCHOR) continue; // see resolveFileRuleAnchor's own header
    const rootKey = anchor.root ?? opts.cwd;
    const normalized = normalizeFileRulePattern(anchor.relativePattern);
    const compiled = unanchorTrailingDoubleStar(normalized, behavior === "allow");
    let group = groups.get(rootKey);
    if (group === undefined) {
      group = { byCompiledPattern: new Map(), ig: ignoreFactory({ ignorecase: true }) };
      groups.set(rootKey, group);
      groupOrder.push(rootKey);
    }
    group.byCompiledPattern.set(compiled, candidate.entry);
    group.ig.add(compiled);
  }
  for (const rootKey of groupOrder) {
    const group = groups.get(rootKey)!;
    const rel = relative(rootKey, path);
    if (!isPathValidRelative(rel)) continue;
    const result = group.ig.test(rel);
    if (result.ignored && result.rule) {
      const winner = group.byCompiledPattern.get(result.rule.pattern);
      if (winner !== undefined) return winner;
    }
  }
  return null;
}

/**
 * A SINGLE pattern against a SINGLE path -- for a caller that is already iterating rule entries one
 * at a time for a reason unrelated to C-1/SV-7 (e.g. evaluator.ts's own cross-tool
 * `findFileDenyBlockingEdit`, a Winter-invented safety net with no claude analogue: claude's own
 * Write decision never consults `Read(...)` rules at all, so "a Read deny also blocks a Write" is
 * this codebase's own extension, not a ported behaviour). Grouping (this module's own header)
 * therefore does not apply across DIFFERENT callers' unrelated single-pattern checks the way it does
 * within one `matchFileRulesGrouped` call -- this is a thin, no-negation-support convenience, not a
 * second matching engine.
 */
export function matchesSingleFileRulePattern(pattern: string, path: string, opts: { cwd: string; home: string }, behavior: "allow" | "denyAsk"): boolean {
  return matchFileRulesGrouped([{ entry: true, pattern }], path, opts, behavior) !== null;
}
