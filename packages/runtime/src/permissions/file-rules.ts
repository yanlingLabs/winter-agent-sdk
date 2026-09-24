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
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import ignoreFactory from "ignore";
import { resolveRealTarget } from "./paths.ts";

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

const RULE_PATH_GLOB_CHARS = /[*?[\]]/;

/**
 * WS-21 fix round 10, item C: a Read/Edit rule's own pattern, resolved to ONE absolute filesystem
 * path -- for the sandbox's own `subpath` rule (sandbox/profile.ts's `denyWritePaths`/
 * `denyReadPaths`/`writableRoots`), which has no glob grammar of its own to hand a pattern string
 * to; a real Seatbelt `subpath` already means "this directory and everything under it," so it needs
 * ONE real path, never a pattern.
 *
 * `undefined` in two cases, matching claude's own observable posture (dump-confirmed, `Jm`: `let{
 * allowOnly:t}=at.getFsWriteConfig();if(t.some(eg))return!0` -- ANY glob-shaped entry in the
 * write-allow set makes claude's OWN sandbox stop trying to restrict writes via that mechanism at
 * all, relying on the separate, glob-aware PERMISSION-RULE layer instead, which is unaffected by
 * this and stays the real enforcement point):
 *   - the pattern is INERT (a bare `/`-anchored rule with no resolvable settings-source root --
 *     `resolveFileRuleAnchor`'s own pre-existing posture, unchanged here);
 *   - the pattern is genuinely GLOB-SHAPED once a single TRAILING `/**` is stripped (redundant with
 *     `subpath`'s own "and everything under it" semantics, so it is not itself disqualifying --
 *     `Edit(//repo/secrets/**)` becomes the plain path `/repo/secrets`) -- a glob ANYWHERE else
 *     (`src/*.ts`, `[wip]`, `a?b`) cannot become one exact path at all.
 * A caller that gets `undefined` back simply does not add this rule to the sandbox's own filesystem
 * lists; the permission-rule layer (`evaluate()`) still enforces it in full, exactly as it always has.
 */
export function resolveFileRuleAbsolutePath(pattern: string, opts: { cwd: string; home: string; sourceDir?: string }): string | undefined {
  const anchor = resolveFileRuleAnchor(pattern, { home: opts.home, sourceDir: opts.sourceDir });
  if (anchor.root === INERT_ANCHOR) return undefined;
  const rootPath = anchor.root ?? opts.cwd;
  const normalized = normalizeFileRulePattern(anchor.relativePattern);
  const withoutTrailingDoubleStar = normalized.endsWith("/**") ? normalized.slice(0, -3) : normalized;
  if (RULE_PATH_GLOB_CHARS.test(withoutTrailingDoubleStar)) return undefined;
  const relativePart = withoutTrailingDoubleStar.startsWith("/") ? withoutTrailingDoubleStar.slice(1) : withoutTrailingDoubleStar;
  if (relativePart === "" || relativePart === ".") return rootPath;
  return join(rootPath, relativePart);
}

/**
 * WS-21 fix round 11 ("important" item): the sibling of `resolveFileRuleAbsolutePath` that does NOT
 * drop a genuinely glob-shaped pattern -- it resolves the SAME anchor/root as that function but
 * returns the absolute text WITH any remaining glob characters intact (a redundant trailing `/**` is
 * still stripped first, identically, since `subpath`'s/the recursive-regex-suffix's own "and
 * everything under it" semantics already cover it). `undefined` only for the one case that has no
 * absolute form at all -- an INERT `/`-anchored pattern with no resolvable settings-source root,
 * unchanged from `resolveFileRuleAbsolutePath`'s own posture.
 *
 * Exists because claude's own deny-rendering path (`dR`, dump byte 15365699 region) does NOT drop a
 * glob-shaped deny the way `Jm`'s write-ALLOW-only short-circuit does (round 10's own `Jm` finding,
 * `resolveFileRuleAbsolutePath`'s own header) -- a glob-shaped DENY instead becomes an SBPL `(regex
 * ...)` clause (claude's `Li` (dump byte 15365905) / `Rt` (dump byte 15282610)) rather than being silently
 * unenforced by the sandbox layer. Callers check `isGlobShapedFileRulePattern` on the result to
 * decide `subpath` vs a `globToSbplRegexSource`/`recursiveGlobToSbplRegexSource` conversion; ALLOW
 * entries keep using `resolveFileRuleAbsolutePath` (glob-shaped dropped), per the controller's own
 * explicit ruling: "Dropping glob-shaped ALLOW rules stays as it is, because that's stricter."
 */
export function resolveFileRuleAbsoluteGlobText(pattern: string, opts: { cwd: string; home: string; sourceDir?: string }): string | undefined {
  const anchor = resolveFileRuleAnchor(pattern, { home: opts.home, sourceDir: opts.sourceDir });
  if (anchor.root === INERT_ANCHOR) return undefined;
  const rootPath = anchor.root ?? opts.cwd;
  const normalized = normalizeFileRulePattern(anchor.relativePattern);
  const withoutTrailingDoubleStar = normalized.endsWith("/**") ? normalized.slice(0, -3) : normalized;
  const relativePart = withoutTrailingDoubleStar.startsWith("/") ? withoutTrailingDoubleStar.slice(1) : withoutTrailingDoubleStar;
  if (relativePart === "" || relativePart === ".") return rootPath;
  return join(rootPath, relativePart);
}

/** claude's own `Rt` (dump byte 15282610: `e.includes("*")||e.includes("?")||e.includes("[")||e.includes("]")`), confirmed byte-equivalent to this module's own pre-existing glob-char test. Exported so callers outside this module can classify a `resolveFileRuleAbsoluteGlobText` result without re-deriving the char set. */
export function isGlobShapedFileRulePattern(text: string): boolean {
  return RULE_PATH_GLOB_CHARS.test(text);
}

// Fix round 12 (correcting round 11's own disclosure): claude's own `ko` (dump byte 15283072, in the
// SAME chunk as `Cv`, 884 bytes away). `Cv` (claude's glob/path normalizer, ahead of `Rt`/`Po` in its
// pipeline) DOES perform real symlink resolution on the glob's own fixed prefix -- round 11's own
// disclosure ("NOT a claude-parity item... Cv does not perform real symlink resolution either") was
// WRONG, corrected by the controller's own re-review and confirmed by re-reading `Cv`'s FULL body
// (round 11's own reading was truncated mid-function): `Cv` ends `try{let o=Qs.realpathSync(r);
// if(ko(r,o));else r=o}catch{}return r` for a non-glob path, and for a glob-shaped one resolves
// `realpathSync` on the fixed prefix's own dirname the SAME way, both GUARDED by `ko(original,
// resolved)`. `canonicalizeGlobFixedPrefix` (below) already matched `Cv`'s own prefix-extraction and
// realpath-then-rejoin shape exactly (verified: `Rh`, claude's own fixed-prefix extractor,
// `e.split(/[*?[\]]/)[0]` then dirname-or-strip-trailing-slash, is algebraically identical to this
// function's own `lastIndexOf("/", firstGlobCharIndex)` slice) -- what it LACKED was `ko`'s own guard,
// ported here. Per the controller: "the missing ko guard only makes Winter deny more" -- a resolution
// `ko` would have rejected still gets USED without the guard, which can only narrow/redirect a DENY's
// own anchor, never widen what gets denied into an allow.
//
// `ko(e,t)` (`e`=original, `t`=realpath's result): returns `true` ("suspicious -- reject the
// resolution, keep the original text") UNLESS the resolution is one of three safe shapes: no change;
// the boring macOS `/tmp`<->`/private/tmp` or `/var`<->`/private/var` alias (either direction, exact
// match only); or the resolved path is a proper DEEPER descendant of the original (or its
// private-alias form) -- i.e. realpath only added detail, never collapsed the path upward into
// something shorter, a top-level directory, or the filesystem root outright.
function isSuspiciousRealpathResolution(original: string, resolved: string): boolean {
  const r = normalize(original);
  const o = normalize(resolved);
  if (o === r) return false;
  if (r.startsWith("/tmp/") && o === "/private" + r) return false;
  if (r.startsWith("/var/") && o === "/private" + r) return false;
  if (r.startsWith("/private/tmp/") && o === r) return false;
  if (r.startsWith("/private/var/") && o === r) return false;
  if (o === "/") return true;
  if (o.split("/").filter(Boolean).length <= 1) return true;
  if (r.startsWith(o + "/")) return true;
  let p = r;
  if (r.startsWith("/tmp/")) p = "/private" + r;
  else if (r.startsWith("/var/")) p = "/private" + r;
  if (p !== r && p.startsWith(o + "/")) return true;
  const linkUnderOriginal = o.startsWith(r + "/");
  const linkUnderPrivateAlias = p !== r && o.startsWith(p + "/");
  if (o !== r && !(p !== r && o === p) && !linkUnderOriginal && !linkUnderPrivateAlias) return true;
  return false;
}

/**
 * Fix round 11 (disclosure corrected round 12 -- see `isSuspiciousRealpathResolution`'s own header):
 * canonicalizes the FIXED (non-glob) prefix of an absolute glob pattern before conversion, matching
 * claude's own `Cv`. Winter's own pre-existing, independent requirement (WS-12 §5.2: "macOS /tmp and
 * /var are symlinks; un-canonicalized rules silently miss," `canon()`'s own header in
 * sandbox/profile.ts) turns out to ALSO be exactly what claude's `Cv` does here -- not a
 * Winter-only addition after all. Best-effort: `resolveRealTarget` already tolerates a not-yet-
 * existing LEAF (walks to the nearest existing ancestor); any error canonicalizing the prefix, OR a
 * resolution `isSuspiciousRealpathResolution` rejects (claude's own `ko` guard), falls back to the
 * UNCANONICALIZED text -- matching `canon()`'s own "graceful fall-through... catches EVERY error"
 * contract, so a symlink-canonicalization failure never crashes profile generation and never silently
 * redirects a deny's own anchor to somewhere `ko` itself would flag as suspicious.
 *
 * Split from `globToSbplRegexSource`'s own inline version (round 11) so the CANONICALIZED PREFIX
 * ALONE, without the glob suffix rejoined, is available to the fix round 12 ancestor-rename-bypass
 * port below (`Ch`'s own `Rh(u)` needs exactly this value, separately from the regex-conversion path).
 */
function canonicalizedGlobFixedPrefix(absoluteGlob: string): string | undefined {
  const firstGlobCharIndex = absoluteGlob.search(RULE_PATH_GLOB_CHARS);
  if (firstGlobCharIndex === -1) return undefined; // not glob-shaped; nothing to canonicalize here
  // The fixed prefix ends at the last path separator BEFORE the first glob character -- a glob
  // character can appear mid-segment (`sub*dir/x`), where the "fixed prefix" is only the segments
  // strictly before `sub*dir`, never a partial segment.
  const lastSepBeforeGlob = absoluteGlob.lastIndexOf("/", firstGlobCharIndex);
  if (lastSepBeforeGlob <= 0) return undefined; // no real prefix (glob starts at/near the root)
  const prefix = absoluteGlob.slice(0, lastSepBeforeGlob);
  try {
    const resolved = resolveRealTarget(prefix);
    return isSuspiciousRealpathResolution(prefix, resolved) ? prefix : resolved;
  } catch {
    return prefix;
  }
}

function canonicalizeGlobFixedPrefix(absoluteGlob: string): string {
  const firstGlobCharIndex = absoluteGlob.search(RULE_PATH_GLOB_CHARS);
  if (firstGlobCharIndex === -1) return absoluteGlob;
  const lastSepBeforeGlob = absoluteGlob.lastIndexOf("/", firstGlobCharIndex);
  if (lastSepBeforeGlob <= 0) return absoluteGlob;
  const suffix = absoluteGlob.slice(lastSepBeforeGlob);
  const canonicalPrefix = canonicalizedGlobFixedPrefix(absoluteGlob);
  return canonicalPrefix === undefined ? absoluteGlob : canonicalPrefix + suffix;
}

/**
 * Fix round 12 ("Important" item, claude's own `ed`, dump byte 15367994, found in the SAME chunk as
 * `Ch`/`mR`/`pR` below): every ANCESTOR directory of `path`, walking up via `dirname` until reaching
 * `/` or a fixed point -- does NOT include `path` itself, nor `/`. Feeds the ancestor-rename-bypass
 * fix: claude's own write/read sandbox profiles additionally deny `file-write-unlink`/
 * `file-write-create` on every ancestor of a denied path (and of a glob deny's own fixed prefix), so
 * a sandboxed `mv <ancestor> <elsewhere> && <write inside where it used to be> && mv <elsewhere>
 * <ancestor>` cannot rename the ancestor out of the way and back to slip a write past the deny.
 */
export function ancestorDirectoriesOf(path: string): string[] {
  const out: string[] = [];
  let current = dirname(path);
  while (current !== "/" && current !== ".") {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * claude's own `Po` (dump byte 15287939, pinned 2.1.250, ground-truth byte-slice-verified), converting
 * a glob pattern (already resolved to one absolute string, glob characters intact) to a POSIX
 * extended-regex source string suitable for an SBPL `(regex #"...")` clause. Chained `.replace()`
 * calls, IN THIS EXACT ORDER (order is load-bearing -- swapping steps 3/4 before step 5 would let a
 * literal `*` inside an already-placeholder-substituted globstar get re-matched by the bare-`*` rule):
 *   1. escape everything a regex treats specially EXCEPT the four glob metacharacters `* ? [ ]`
 *      (claude's own `[...]` character-class syntax is already valid regex syntax verbatim, so it is
 *      deliberately left untouched, not escaped);
 *   2. escape an UNCLOSED trailing `[` (no matching `]`) too, defensively -- a malformed bracket
 *      class must not produce an invalid regex;
 *   3. a globstar segment (two stars followed by a slash) -> a placeholder (BEFORE the bare-`**`/`*`
 *      rules touch it);
 *   4. remaining `**` -> a placeholder;
 *   5. `*` -> `[^/]*` (any run of non-separator characters);
 *   6. `?` -> `[^/]` (exactly one non-separator character);
 *   7/8. restore the two placeholders: the globstar-segment placeholder becomes a group matching
 *      zero or more whole path segments each followed by a separator (or nothing at all); bare `**`
 *      becomes `.` `*` (anything, separators included).
 * Wrapped in `^...$` (whole-string anchor) -- callers needing the "and everything under it" semantics
 * `subpath` has built in use `recursiveGlobToSbplRegexSource` instead, matching claude's own `td`.
 * The fixed prefix is canonicalized FIRST (`canonicalizeGlobFixedPrefix`, above, this codebase's own
 * addition, not claude's) -- everything downstream of that call is the verbatim `Po` port.
 */
export function globToSbplRegexSource(absoluteGlob: string): string {
  return (
    "^" +
    canonicalizeGlobFixedPrefix(absoluteGlob)
      .replace(/[.^$+{}()|\\]/g, "\\$&")
      .replace(/\[([^\]]*?)$/g, "\\[$1")
      .replace(/\*\*\//g, "__GLOBSTAR_SLASH__")
      .replace(/\*\*/g, "__GLOBSTAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/__GLOBSTAR_SLASH__/g, "(.*/)?")
      .replace(/__GLOBSTAR__/g, ".*") +
    "$"
  );
}

/**
 * claude's own `td` (dump byte 15365977: `Po(e).slice(0,-1)+"(/.*)?$"`) -- `globToSbplRegexSource`'s
 * own whole-string match, WIDENED to also match "the pattern's own match point, optionally followed
 * by `/` and anything deeper" -- the regex equivalent of `subpath`'s own implicit recursive semantics
 * (a plain, non-glob deny already renders as `subpath`, which covers a directory AND everything under
 * it with no extra syntax). claude's own `dR` (the deny-clause builder, same dump region) always uses
 * this recursive form for a glob-shaped deny's OWN base clause -- never the bare `Li`/
 * `globToSbplRegexSource` form, which claude reserves for an ALLOW-carve-out entry nested inside a
 * deny (a feature this port does not carry -- see `resolveFileRuleAbsoluteGlobText`'s own header).
 */
export function recursiveGlobToSbplRegexSource(absoluteGlob: string): string {
  const base = globToSbplRegexSource(absoluteGlob);
  return base.slice(0, -1) + "(/.*)?$";
}

/**
 * WS-21 fix round 11: the ONE place a plain `sandbox.filesystem.denyWrite`/`denyRead` string list
 * (settings.json's own, user-typed, and `deriveSandboxPathsFromRules`'s own rule-derived denies,
 * which now may ALSO contain glob-shaped text -- see `resolveFileRuleAbsoluteGlobText`'s own header)
 * gets split by glob-shape before reaching `SeatbeltProfileInput`/`RunCommandOptions`: a non-glob
 * entry stays a plain path (`subpath`, unchanged); a glob-shaped one is converted via
 * `recursiveGlobToSbplRegexSource` (the recursive form, matching `subpath`'s own implicit
 * "and everything under it" semantics and claude's own `dR`, which always uses the recursive form for
 * a deny's own base clause). Called once per caller (tools/impl/bash.ts, tools/impl/monitor.ts) --
 * kept as one shared, tested primitive rather than two hand-copies, per this codebase's own
 * "a second copy would be exactly the kind of drift risk this whole phase's review lens exists to
 * catch" precedent (evaluator.ts's `extractCandidateWritePaths`, verbatim).
 *
 * Fix round 12: also returns `globFixedPrefixes` -- for each glob-shaped entry, its OWN canonicalized
 * fixed-prefix directory (claude's own `Rh(u)`, `undefined`/dropped when it resolves to `/`, matching
 * `Ch`'s own `if(p==="/")continue`). Feeds the ancestor-rename-bypass port
 * (`SeatbeltProfileInput.denyWriteGlobFixedPrefixes`/`denyReadGlobFixedPrefixes`, sandbox/profile.ts):
 * the plain `paths` entries need only their OWN ancestors walked (`ed`, `ancestorDirectoriesOf`
 * above) to close the bypass; a glob-shaped deny ALSO needs its fixed prefix walked, and the prefix
 * itself added as a literal deny target (claude's own `Ch` adds both).
 */
export function splitDenyPathsByGlobShape(paths: readonly string[]): { paths: string[]; regexes: string[]; globFixedPrefixes: string[] } {
  const plain: string[] = [];
  const regexes: string[] = [];
  const globFixedPrefixes: string[] = [];
  for (const p of paths) {
    if (isGlobShapedFileRulePattern(p)) {
      regexes.push(recursiveGlobToSbplRegexSource(p));
      const prefix = canonicalizedGlobFixedPrefix(p);
      if (prefix !== undefined && prefix !== "/") globFixedPrefixes.push(prefix);
    } else {
      plain.push(p);
    }
  }
  return { paths: plain, regexes, globFixedPrefixes };
}

/** One glob-shaped deny entry, its recursive SBPL regex source PAIRED with its own fixed-prefix
 * directory -- `splitDenyPathsByGlobShape`'s own `regexes`/`globFixedPrefixes` are two independently
 * FILTERED flat arrays (the latter drops a "/" prefix entirely) with no positional correspondence
 * once any entry is dropped from one but not the other; `fixedPrefix` here is NEVER dropped -- it is
 * always the literal string `"/"` in that case (claude's own `Rh` returns `"/"` too, and `fR`'s own
 * skip/ancestor logic reads that value directly rather than treating "no prefix" as a distinct case). */
export interface GlobDenyEntry {
  regex: string;
  fixedPrefix: string;
}

/**
 * Fix round 13 ("Important" item 1, claude's own `fR`, dump byte 15367091): the PAIRED form
 * `buildReadDenyKeepInPlaceBlock` (sandbox/profile.ts) needs -- see `GlobDenyEntry`'s own header for
 * why `splitDenyPathsByGlobShape`'s own two flat arrays cannot answer this. Scoped to glob-shaped
 * entries only (a plain entry needs no pairing at all -- its own path IS both its recursive-clause
 * anchor and its ancestor-walk root, `buildReadDenyKeepInPlaceBlock` uses `paths` directly for that).
 */
export function globDenyEntriesOf(paths: readonly string[]): GlobDenyEntry[] {
  const out: GlobDenyEntry[] = [];
  for (const p of paths) {
    if (!isGlobShapedFileRulePattern(p)) continue;
    out.push({ regex: recursiveGlobToSbplRegexSource(p), fixedPrefix: canonicalizedGlobFixedPrefix(p) ?? "/" });
  }
  return out;
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

/**
 * Item 2 (fix round 9), REVISED by round 10's own item-3 ruling: a malformed pattern's own compile
 * failure is a THROW out of `matchFileRulesGrouped`, not a direction-aware return value. Round 9
 * tried to resolve the failure INSIDE this function (denyAsk -> the broken group's first entry,
 * allow -> null); round 10's controller ruling is that this is not what claude does -- claude's own
 * `Ma` has no per-group catch at all (only the per-TOOL-CALL one far above it, at `d8t`/`ome`'s own
 * boundary), so ONE throwing group aborts the WHOLE permission check for that call, exactly the same
 * way regardless of which direction (deny/ask/allow) was being evaluated when it happened. This
 * class is what makes that propagation typed rather than "any thrown Error" -- caught exactly once,
 * at `evaluator.ts`'s own `evaluate()` (the "decide this one call" boundary), and turned into the
 * generic fail-closed deny `d8t`'s own hardcoded fallback produces.
 */
export class FileRuleCompileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FileRuleCompileError";
  }
}

// Fix round 5, N-1 (the re-review of 57e7fef..20b623e, Important): the pre-fix version below
// rejected every relative path starting with the literal two characters ".." -- a substring-prefix
// test, not a path-segment test -- which silently skipped an entire rule group for a real,
// non-escaping name like "..x/evil.sh" or "..cache/.env". Ported exactly from the real package's own
// `isPathValid` (index.js, `ignore@7.0.5`): `checkPath.isNotRelative` tests
// `REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/` -- a LEADING `/`, `./` or `../` segment, or the
// bare strings "." / ".." exactly, never a name that merely starts with ".." without a following
// separator. `relative()` already normalizes `.`/`..` internally, so a target genuinely outside
// `root` shows up here as a string starting with `../` (or being exactly `..`), which this regex
// still catches -- N-1 narrows the check, it does not remove the traversal guard.
const INVALID_RELATIVE_PATH = /^\.{0,2}\/|^\.{1,2}$/;

function isPathValidRelative(rel: string): boolean {
  // The real package's own `checkPath` rejects an EMPTY path as a separate, prior case (`ignore#test`
  // throws on it rather than falling through to `isPathValid`'s regex, which does not itself match
  // "") -- kept as an explicit guard here for the same reason.
  return rel !== "" && !INVALID_RELATIVE_PATH.test(rel);
}

/**
 * `ln`+`Ma`, combined into one grouped match: builds ONE `ignore()` instance per anchor ROOT from
 * every candidate (see this module's header for why grouping is load-bearing, not cosmetic), then
 * tests `path` against each root's group in turn, returning the FIRST candidate's own `entry` whose
 * group matched -- `null` when nothing matched anywhere. `behavior` is `"allow"` or `"denyAsk"`,
 * mirroring `matchFileRule`'s own existing direction vocabulary (never allow AND denyAsk on the
 * page a caller passed to `ki`, exactly as `ln`'s `r==="allow"` check is exactly `behavior==="allow"`
 * here too).
 *
 * THROWS `FileRuleCompileError` (fix round 10, item 3) when any consulted anchor root's own
 * candidate patterns fail to compile into a real `ignore()` instance -- never resolved to `null`
 * or a particular entry here; see that class's own header for why, and `evaluator.ts`'s `evaluate()`
 * for the one place it is caught.
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
    // `.add()` itself does not throw for a malformed pattern (confirmed empirically against the
    // real package: it only THROWS lazily, the first time `.test()` forces the combined regex to
    // compile -- see the `.test()` call below, which is where this is actually caught).
    group.ig.add(compiled);
  }
  for (const rootKey of groupOrder) {
    const group = groups.get(rootKey)!;
    const rel = relative(rootKey, path);
    if (!isPathValidRelative(rel)) continue;
    // Item 2, fix round 9 (REVISED by round 10 item 3): a malformed pattern (e.g. an unterminated
    // `[...]` character class followed by another path segment) makes the real `ignore` package's
    // own regex construction throw HERE, at `.test()` -- confirmed empirically, not assumed:
    // `.add()` alone never throws for the same input; the combined regex is compiled lazily, on
    // first use.
    //
    // Round 9 tried to resolve this INSIDE the function, direction-aware. Round 10's controller
    // ruling: that is not what claude does. Claude's own `Ma` has NO per-group catch at all -- only
    // the per-TOOL-CALL one far above it (`d8t`'s hardcoded fallback, reached when a tool declares
    // no custom `permissionCheckFailureDecision`; Read/Edit do not) -- so ONE throwing group aborts
    // the WHOLE check for that call, deny/ask/allow alike, the same way `Ma` itself would simply
    // throw and let its own caller's try/catch decide. This function now matches that shape exactly:
    // it throws a typed `FileRuleCompileError`, uncaught HERE, for `evaluator.ts`'s own `evaluate()`
    // (the "decide this one call" boundary) to catch exactly once and turn into the generic
    // fail-closed deny `d8t`'s fallback produces -- never a propagating crash of the whole run,
    // because THAT catch exists, just one layer higher than round 9 placed it.
    let result: { ignored: boolean; rule?: { pattern: string } };
    try {
      result = group.ig.test(rel);
    } catch (cause) {
      throw new FileRuleCompileError(`a file-rule pattern under ${JSON.stringify(rootKey)} failed to compile`, { cause });
    }
    if (result.ignored && result.rule) {
      const winner = group.byCompiledPattern.get(result.rule.pattern);
      if (winner !== undefined) return winner;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// SV-8: the acceptEdits working-directory boundary -- a plain path-prefix test, NOT a glob
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Fix round 5: claude's trusted-symlink equivalences (`ni`/`QCt`, dump-confirmed) -- shared by the
// acceptEdits boundary check below and the allow-rule matching fallback in `evaluator.ts`'s
// `findMatchingFileRuleEntry`.
// ---------------------------------------------------------------------------------------------

/**
 * The SIX real-directory/trusted-alias pairs claude's own `ni()` checks (content-search confirmed
 * against the installed claude CLI binary, 2.1.280 -- the pinned 2.1.250 build was unavailable
 * locally): `/private/tmp`↔`/tmp`, `/private/var`↔`/var`, `/private/etc`↔`/etc`, `/usr/bin`↔`/bin`,
 * `/usr/lib`↔`/lib`, `/usr/sbin`↔`/sbin`. Round 4's own `isPathWithinRoot` only ever hardcoded the
 * first two; this round widens it to all six and, matching `ni()` exactly, VERIFIES each pair
 * dynamically (`realpathSync(alias) === real`) rather than assuming it holds -- macOS maintains
 * these as symlinks, but a pair that does not resolve that way on a given machine is excluded, never
 * assumed. Memoized: these are real, stable OS paths that do not change within one process's
 * lifetime, mirroring `ni()`'s own caching.
 */
const TRUSTED_SYMLINK_CANDIDATES: readonly (readonly [real: string, alias: string])[] = [
  ["/private/tmp", "/tmp"],
  ["/private/var", "/var"],
  ["/private/etc", "/etc"],
  ["/usr/bin", "/bin"],
  ["/usr/lib", "/lib"],
  ["/usr/sbin", "/sbin"],
];

let cachedTrustedSymlinkEquivalences: Map<string, string> | undefined;

function trustedSymlinkEquivalences(): Map<string, string> {
  if (cachedTrustedSymlinkEquivalences !== undefined) return cachedTrustedSymlinkEquivalences;
  const result = new Map<string, string>();
  for (const [real, alias] of TRUSTED_SYMLINK_CANDIDATES) {
    try {
      if (realpathSync(alias) === real) result.set(real, alias);
    } catch {
      // not present (or not a symlink to the expected target) on this machine -- excluded, not assumed
    }
  }
  cachedTrustedSymlinkEquivalences = result;
  return result;
}

/**
 * `QCt`'s own job: rewrite a path through its REAL prefix (e.g. `/private/tmp/x`, what
 * `realpathSync` actually returns) back to the commonly-typed TRUSTED alias (`/tmp/x`) -- the
 * direction a real, resolved path needs to go to be compared against a rule an author wrote in the
 * short form. A path with no matching real prefix passes through unchanged.
 */
export function canonicalizeTrustedSymlinkPath(path: string): string {
  for (const [real, alias] of trustedSymlinkEquivalences()) {
    if (path === real || path.startsWith(real + sep)) return alias + path.slice(real.length);
  }
  return path;
}

/**
 * SV-8 (the router same-view test on the 57e7fef binary): claude's own acceptEdits
 * working-directory boundary check is `sm` (dump-confirmed by content search) -- a plain RELATIVE-
 * PATH PREFIX test, never a compiled glob at all. Winter's own `isWithinBounds` (evaluator.ts) used
 * to reuse the general file-rule matcher with a `"**"` sentinel pattern -- harmless before SV-6/C-1,
 * but once the general matcher started interpreting `[`, `]`, `*` and `\` as glob metacharacters, a
 * cwd or additional-directory root containing any of them (e.g. `[wip] app`) made `"**"` fail to
 * compile the way the caller intended, and acceptEdits asked for every write inside that cwd instead
 * of auto-approving them.
 *
 * This function sidesteps the escaping question SV-8 raises entirely, the same way claude's own `sm`
 * does: a plain path-prefix test never interprets EITHER path as glob syntax, so a root containing a
 * glob-special character needs no escaping here at all -- unlike a real RULE pattern (I-G's own
 * concern), which does.
 *
 * Ported: `caseFold` (default `true`, matching `sm`'s own default and I-D's case-insensitivity
 * finding generally) folds BOTH paths before computing the relative path between them; the macOS
 * `/private/var` -> `/var` and `/private/tmp` -> `/tmp` aliasing is real-symlink-aware -- macOS
 * itself maintains both as symlinks to the `/private/...` originals, so a session cwd resolved
 * through one spelling and a root configured with the other name the SAME real directory (this
 * matters in practice: `os.tmpdir()` on macOS resolves through `/private/var/folders/...`, which is
 * exactly the shape every mkdtemp-based fixture in this codebase's own test suite produces). Not
 * ported: `sm`'s own `uncShapeParity` and `skipPrivateAlias` options (Windows-only concerns) and its
 * `Gn`/`Ha` UNC-path checks -- this codebase supports macOS only (CLAUDE.md's own "latest-OS
 * floors" rule).
 *
 * Fix round 6 (R5-2, the re-review against the pinned 2.1.250 dump): ONLY these TWO pairs -- round
 * 5 widened this to the full six-pair `ni()`/`Sl()` map (`/private/etc`, `/usr/bin`, `/usr/lib`,
 * `/usr/sbin` included), which was WRONG for `sm` specifically: content search against the pinned
 * 2.1.250 dump (not the 2.1.280 build round 5 was cited against) found `sm`'s own alias regexes
 * verbatim -- `g=r?/^\/private\/var\//i:/^\/private\/var\//,w=r?/^\/private\/tmp(\/|$)/i:/^\/private\/
 * tmp(\/|$)/` -- exactly these two, unconditionally, never the wider six-pair set. Reverted to match;
 * the six-pair map (`trustedSymlinkEquivalences`/`canonicalizeTrustedSymlinkPath`) stays, but is now
 * used ONLY by the allow-rule retry in evaluator.ts (`cqe`'s own scope, confirmed at the same dump
 * site), never by this function.
 */
export function isPathWithinRoot(childPath: string, rootPath: string, opts: { caseFold?: boolean } = {}): boolean {
  const caseFold = opts.caseFold ?? true;
  const alias = (p: string): string => p.replace(/^\/private\/var\//, "/var/").replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
  const fold = (p: string): string => (caseFold ? p.toLowerCase() : p);
  const rel = relative(fold(alias(rootPath)), fold(alias(childPath)));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

// ---------------------------------------------------------------------------------------------
// Fix round 5: the plugin-manifest traversal fence (Aoe/KGe)
// ---------------------------------------------------------------------------------------------

/**
 * The traversal fence for a plugin MANIFEST's own declared component paths (`commands`/`agents`/
 * `skills`/`output-styles`/`workflows`/`hooks`).
 *
 * Fix round 6 (R5-1 + a promoted minor, the re-review against the PINNED 2.1.250 dump): claude's own
 * check here is `nV` (dump-confirmed by content search against the pinned dump directly, at the
 * scratchpad path the controller named -- superseding fix round 5's citation of `KGe`/`Aoe` against
 * the INSTALLED 2.1.280 binary, which this round's own ruling says is not the parity authority):
 * `nV(root,entry)` resolves `entry` against `root`, computes `u=path.relative(root,resolved)`, and
 * refuses (`return null`) when `u.startsWith("..")`. Three ways this DIFFERS from `isPathWithinRoot`/
 * `sm` above, all ported exactly rather than reused:
 *   1. CASE-SENSITIVE, always -- `nV`'s own body has no folding call anywhere (confirmed by reading
 *      it in full), unlike `sm`'s own `r?/.../i:/.../ ` case-fold branching. Fix round 5's own
 *      `resolvesWithinPluginRoot` wrongly delegated to `isPathWithinRoot`'s DEFAULT `caseFold:true`,
 *      so on a case-sensitive volume a manifest entry like `../FOO/agents` under a root
 *      `.../plugins/foo` was admitted (folded, `FOO` read as `foo`) where claude's own `nV` (and
 *      this rewrite) refuses it.
 *   2. NAIVE STRING-PREFIX, not segment-aware -- `u.startsWith("..")` is a bare string test, unlike
 *      `sm`'s own `uj` (`/(?:^|[\\/])\.\.(?:[\\/]|$)/`, confirmed by reading ITS full definition too),
 *      which requires a `..` SEGMENT bounded by a separator or a string edge. This means a component
 *      name that merely STARTS WITH the two characters `..` -- e.g. `"..x/agents"`, a real,
 *      non-escaping subdirectory name -- is REFUSED by claude too, not only a genuine `"../"` escape.
 *      Matched here rather than "fixed", per the ruling: claude's own inconsistency between its two
 *      path-safety mechanisms is not this codebase's to resolve by choosing the more correct one.
 *   3. NO trusted-symlink alias mapping at all -- `nV`'s own body never calls anything resembling
 *      `Smt`/`canonicalizeTrustedSymlinkPath`. Moot in practice here regardless, since both operands
 *      below are ALREADY realpath'd before this comparison runs (a real, resolved path from
 *      `/tmp`/`/var` already comes back in its long `/private/...` form either way).
 *
 * DISCLOSED DIVERGENCE FROM THE PINNED 2.1.250, kept as DELIBERATE HARDENING (the controller's own
 * explicit ruling): `nV` itself is PURELY LEXICAL -- 2.1.250 has no symlink-following/realpath step
 * for a plugin component path at all. This function still realpaths both the candidate and the
 * plugin root first (originally ported from the INSTALLED 2.1.280 binary's own `KGe`/`Aoe`, which DID
 * add this in a build newer than the pin), refusing a symlinked override that points outside the
 * plugin where 2.1.250 would load it -- the safe direction, and it matches claude's own newer
 * behaviour. `nV`'s own comparison shape (case-sensitive, naive-prefix, no alias) is then applied to
 * the REALPATH'D forms rather than to the raw ones `nV` itself compares. `resolveRealTarget` (paths.ts)
 * has the graceful "walk up to the nearest existing ancestor" fallback for a candidate that does not
 * exist YET, and rethrows a non-ENOENT failure (ELOOP on a symlink cycle, EACCES, ...), caught here
 * and treated as a refusal rather than letting a malformed manifest entry crash the whole
 * plugin-loading pass.
 */
export function resolvesWithinPluginRoot(candidatePath: string, pluginRoot: string): boolean {
  // A literal backslash "is not resolved reliably on this platform" -- ported from the 2.1.280
  // binary's own `KGe` for parity; inert on macOS, the only platform this codebase targets
  // (CLAUDE.md's own latest-OS-floors rule), and genuinely one line either way.
  if (candidatePath.includes("\\")) return false;
  let realCandidate: string;
  let realRoot: string;
  try {
    realCandidate = resolveRealTarget(candidatePath);
    realRoot = resolveRealTarget(pluginRoot);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realCandidate);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !isAbsolute(rel);
}

// ---------------------------------------------------------------------------------------------
// I-G: escaping a REAL filesystem path before it becomes rule PATTERN TEXT
// ---------------------------------------------------------------------------------------------

/**
 * Fix round 4 (I-G): a real, resolved filesystem path (e.g. `resolve(winterHome)`) can legitimately
 * contain `[`, `]`, `*` or `\` -- none of which were glob-special under Winter's pre-fix-round-4
 * grammar, but all four are now, since `matchFileRulesGrouped` compiles every pattern through the
 * real `ignore` package. A caller building a rule PATTERN out of a real path (`buildBaselineDenyRules`,
 * engine.ts) must escape these four before interpolating the path into pattern text, or a home
 * directory literally named e.g. `/Users/name[wip]` would have its OWN floor's `[wip]` read back as
 * a character class instead of the four literal characters it names on disk.
 *
 * `?` is DELIBERATELY LEFT RAW, per the controller's own ruling: claude's grammar has no working
 * escape for `?` at all (this module's own `unanchorTrailingDoubleStar`/`\?`-quirk sibling
 * documentation) -- an escaped `\?` would require a literal backslash the real path never has, so it
 * would never match the floor's own intended directory at all. A bare `?` in the pattern instead acts
 * as a single-character wildcard, which still MATCHES a real `?` in the path (a wildcard matches
 * anything, including the literal character) -- over-matching by one character class is the safe
 * direction for a DENY floor (WS-07 §3.1's own posture: a deny that reaches slightly too far is a
 * false-negative-avoiding cost, never a hole), where an escape that matches NOTHING would be a hole.
 */
// Fix round 9 (a divergence the router measured): claude's own path-to-pattern escaper, `I_t`
// (dump-confirmed, the same region as `c`/`jr`), ALSO escapes a trailing whitespace run, character
// by character:
//   t.replace(/\s+$/, (n) => Array.from(n, (s) => `\${s}`).join(""))
// The real `ignore` package trims an UNESCAPED trailing whitespace run off a pattern line, exactly
// like real gitignore -- confirmed empirically (`ignoreFactory().add("repo/sp ").test("repo/sp ")`
// is `false`; the same call with the space escaped, `"repo/sp\\ "`, is `true`). Before this fix, a
// path ending in a space (or any trailing whitespace) built into a deny rule through this function
// silently lost its own protection: the compiled pattern named the file WITHOUT the trailing
// whitespace, so a write to the real file WITH it went through, unsandboxed by that rule -- a
// fail-open specific to this direction (path -> pattern); a rule typed directly into settings.json
// with the space ALREADY escaped by hand was never affected, since round 8's `unescapeRuleContent`
// doesn't touch `\ ` at all (it only recognises `\(`, `\)`, `\\`) and the `ignore` layer itself
// already honours the escape correctly, as it does for claude.
//
// Runs AFTER the `[`, `]`, `*`, `\` escaping below (matching `I_t`'s own order): backslash-escaping
// never introduces a new trailing whitespace character, so the two passes commute for every
// realistic path this codebase's own macOS-only target ever produces.
export function escapeFileRulePathSegment(path: string): string {
  const bracketsAndStar = path.replace(/[[\]*\\]/g, (ch) => "\\" + ch);
  return bracketsAndStar.replace(/\s+$/, (run) => Array.from(run, (ch) => "\\" + ch).join(""));
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
