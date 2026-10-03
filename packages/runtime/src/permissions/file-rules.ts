// The file-rule pipeline: how a `Read(...)`/`Edit(...)` rule's pattern decides whether a path
// matches, plus the path-safety helpers the sandbox and the plugin loader share with it.
//
// MATCHING IS GITIGNORE MATCHING, BY THE `ignore` PACKAGE ITSELF. A rule's pattern is anchored to a
// root (see `resolveFileRuleAnchor`), normalised, rewritten when it ends in `/**`, and then handed to
// the real `ignore` npm package, which decides the match. The package is pinned EXACTLY at 7.0.5
// (`packages/runtime/package.json`, no caret) because the rule grammar Winter shares with Claude Code
// is defined by that release's matching: a later release with different semantics would make the
// two disagree about the same settings file. Consequences that come with the package, not code here:
//   - a pattern with no inner `/` matches at ANY depth (`allow foo` matches `/anywhere/foo`);
//   - `[...]` is a character class, `?` one character, `*` stays inside a segment, `**` crosses them;
//   - a leading `!` negates and a leading `#` is a comment, exactly as on a `.gitignore` line;
//   - matching ignores case;
//   - a path whose parent directory is matched is matched too, and cannot be re-included by a later
//     `!` rule ("it is not possible to re-include a file if a parent directory of that file is
//     excluded") -- the package walks the parents on every `.test()`; nothing here repeats that.
//
// GROUPED MATCHING IS LOAD-BEARING. All the rules that share an anchor root are fed to ONE `ignore()`
// instance, never one at a time: that is the only way a `!` rule can re-include what an earlier rule
// in the same group matched. `matchFileRulesGrouped` is the one entry point, and a caller must pass
// every applicable rule for a (kind, direction) pair in one call.
//
// Deliberately not done here:
//   - no caching: every call builds its `ignore()` instances afresh (correctness first; memoising
//     would not change any result);
//   - no Windows path handling (UNC paths, drive letters, separator normalisation): this runtime
//     targets macOS only;
//   - symlinks are handled by the callers, which match the link, its real target and its full
//     symlink chain (`evaluator.ts`, `paths.ts`).
//
// Which of two overlapping rules a match is ATTRIBUTED to is decided by a map from each compiled
// pattern back to its rule, built alongside the `ignore()` instance. That can only change which rule
// an audit message cites, never the allow/deny/ask verdict, which depends on whether SOME rule in
// the group matched.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import ignoreFactory from "ignore";
import { resolveRealTarget } from "./paths.ts";

// ---------------------------------------------------------------------------------------------
// The tool -> rule-kind map
// ---------------------------------------------------------------------------------------------

export type FileRuleKind = "edit" | "read";

/**
 * File rules come in exactly two kinds, `edit` and `read`. Every write-shaped tool (Edit, Write,
 * NotebookEdit) is checked against the `edit` kind and every read-shaped one (Read, Glob, Grep)
 * against the `read` kind, on every direction (allow, ask, deny). So an `Edit(...)` ask rule fires
 * before a Write, as it does in Claude Code.
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
 * The ONE tool name a rule must be written under to be consulted for `kind`: `Edit` for `edit`,
 * `Read` for `read`. A rule written as `Write(...)`, `NotebookEdit(...)`, `Glob(...)` or `Grep(...)`
 * still parses (grammar.ts's `FILE_RULE_TOOLS`), but is never consulted for any call -- not even one
 * from that same tool -- matching Claude Code's rule grammar, where only `Edit(...)` and `Read(...)`
 * rules are file rules. `findMatchingFileRuleEntry` (evaluator.ts) filters candidates with this.
 */
export function canonicalFileRuleAuthoringToolName(kind: FileRuleKind): "Edit" | "Read" {
  return kind === "edit" ? "Edit" : "Read";
}

// ---------------------------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------------------------

/** A sentinel distinct from `null` ("resolve against cwd"): a `/`-anchored rule with no settings-source directory is INERT, and never falls back to cwd. */
const INERT_ANCHOR = Symbol("file-rule-inert-anchor");

export interface FileRuleAnchor {
  /** The pattern text, relative to `root`, in `ignore`-package (gitignore) grammar. */
  relativePattern: string;
  /** `null` means "resolve against cwd"; the sentinel means the rule can never match anything. */
  root: string | null | typeof INERT_ANCHOR;
}

/**
 * Resolves a pattern's anchor spelling to the root it is relative to and the pattern text relative
 * to that root:
 *   - `//x`  -> root `/`, pattern `/x` (one slash dropped, the leading `/` KEPT);
 *   - `~/x`  -> root `home`, pattern `/x` (the `~` dropped, the leading `/` KEPT);
 *   - `/x`   -> root `sourceDir` (the directory of the settings file the rule came from), pattern
 *               `/x` unchanged; with no `sourceDir` -- a rule from Options, canUseTool or a plugin --
 *               the rule is INERT (`INERT_ANCHOR`) and matches nothing;
 *   - `./x`  -> root cwd (`null`), pattern `x` (the `./` dropped, NO leading `/`);
 *   - else   -> root cwd (`null`), pattern unchanged (a bare `~` included: it is a file named `~`).
 * The kept leading `/` is what anchors a pattern to its root in gitignore terms; its absence is what
 * lets `deny ./.env` also reach `pkg/.env`.
 */
export function resolveFileRuleAnchor(pattern: string, opts: { home: string; sourceDir?: string | undefined }): FileRuleAnchor {
  // Checked longest spelling first: `//` before `/`.
  if (pattern.startsWith("//")) return { relativePattern: pattern.slice(1), root: "/" };
  if (pattern.startsWith("~/")) return { relativePattern: pattern.slice(1), root: opts.home };
  if (pattern.startsWith("/")) return { relativePattern: pattern, root: opts.sourceDir ?? INERT_ANCHOR };
  if (pattern.startsWith("./")) return { relativePattern: pattern.slice(2), root: null };
  return { relativePattern: pattern, root: null };
}

const RULE_PATH_GLOB_CHARS = /[*?[\]]/;

/**
 * A Read/Edit rule's pattern resolved to ONE absolute filesystem path, for the sandbox's `subpath`
 * rules (sandbox/profile.ts's `denyWritePaths`/`denyReadPaths`/`writableRoots`), which take a real
 * path, not a pattern; `subpath` already means "this directory and everything under it".
 *
 * `undefined` when there is no such path:
 *   - the pattern is INERT (a `/`-anchored rule with no settings-source directory);
 *   - the pattern is still glob-shaped once ONE trailing `/**` is stripped (`Edit(//repo/secrets/**)`
 *     becomes the plain path `/repo/secrets`; `src/*.ts`, `[wip]`, `a?b` cannot become one path).
 * A glob-shaped write-ALLOW entry is simply left out of the sandbox, which then does not try to
 * restrict writes through it; the permission-rule layer (`evaluate()`) still enforces the rule in
 * full.
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
 * The sibling of `resolveFileRuleAbsolutePath` that KEEPS a glob-shaped pattern: the same anchor and
 * root, the same stripping of one redundant trailing `/**`, but the absolute text comes back with any
 * remaining glob characters intact. `undefined` only for an INERT pattern.
 *
 * Used for DENY entries: a glob-shaped deny is not dropped from the sandbox but rendered as an SBPL
 * `(regex ...)` clause. Callers test the result with `isGlobShapedFileRulePattern` to choose between
 * `subpath` and `globToSbplRegexSource`/`recursiveGlobToSbplRegexSource`. ALLOW entries keep using
 * `resolveFileRuleAbsolutePath` (glob-shaped ones dropped), which is the stricter choice.
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

/** True when `text` holds any of `* ? [ ]`. The sandbox deny split classifies with `scanDenyPathGlob` instead (below). */
export function isGlobShapedFileRulePattern(text: string): boolean {
  return RULE_PATH_GLOB_CHARS.test(text);
}

/** The member of a one-character bracket class starting at `text[i]` (`[c]`), or `undefined` when `text[i]` does not open one. */
function singleCharClassMemberAt(text: string, i: number): string | undefined {
  if (text[i] !== "[" || text[i + 2] !== "]") return undefined;
  const member = text[i + 1];
  // `!`/`^` open a NEGATED class, and `/` never belongs to a path segment: all three stay glob syntax.
  if (member === undefined || member === "!" || member === "^" || member === "/") return undefined;
  return member;
}

interface DenyPathGlobScan {
  /** True when a REAL glob token (`*`, `?`, or a `[` that does not open a one-character class) is present. */
  glob: boolean;
  /**
   * The unescaped literal text read before the first real glob token (the whole path when `glob` is
   * false): each one-character class contributes its one character, a stray `]` stays `]`.
   */
  literal: string;
  /** Raw index in the input of the last `/` before the first real glob token, or -1. */
  lastSepRaw: number;
  /** `literal`'s length at that `/`, so `literal.slice(0, lastSepLiteralLength)` is the unescaped fixed prefix. */
  lastSepLiteralLength: number;
}

/**
 * The sandbox deny pipeline's glob-shape classifier and fixed-prefix scan (fix round 17, R.3 C-1).
 *
 * A bracket class holding exactly ONE character (`[[]`, `[]]`, `[*]`, `[?]`, and in general `[c]`
 * with no range and no negation) IS that character, and a `]` that closes no class is a plain `]`.
 * An entry whose only glob syntax is such classes is a LITERAL path (`(subpath …)`, brackets
 * unescaped); an entry that also carries a real glob keeps its regex but gets a fixed prefix running
 * THROUGH those classes.
 *
 * Why: a literal project root spelled for the glob grammar (`[wip] app` -> `[[]wip] app`, the
 * router's `escapeSandboxGlobPath` and the daemon's spelling of the same path) would otherwise end the
 * fixed prefix at the parent of `[[]wip] app`, so the ancestor fence would never name
 * `<root>/<projectDir>`, and renaming `<projectDir>` away, writing through the new name and renaming
 * it back would plant a file under a denied `<projectDir>/skills` (measured, the R.3 reviewer's
 * `bracket3.ts`; Claude Code's sandbox has the same gap). This only ever denies more: a one-character
 * class matches exactly the character it names, so the rendered clause matches the same paths, and
 * the ancestor fence now names more directories. `isGlobShapedFileRulePattern` and the ALLOW side's
 * glob-drop (`resolveFileRuleAbsolutePath`) are untouched.
 */
function scanDenyPathGlob(text: string): DenyPathGlobScan {
  let literal = "";
  let lastSepRaw = -1;
  let lastSepLiteralLength = -1;
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === "[") {
      const member = singleCharClassMemberAt(text, i);
      if (member === undefined) return { glob: true, literal, lastSepRaw, lastSepLiteralLength };
      literal += member;
      i += 3;
      continue;
    }
    if (ch === "*" || ch === "?") return { glob: true, literal, lastSepRaw, lastSepLiteralLength };
    if (ch === "/") {
      lastSepRaw = i;
      lastSepLiteralLength = literal.length;
    }
    literal += ch;
    i += 1;
  }
  return { glob: false, literal, lastSepRaw, lastSepLiteralLength };
}

/** A path's characters escaped for a POSIX/SBPL regex as LITERAL text -- every regex metacharacter plus the four glob characters, so an unescaped real path (a canonicalised fixed prefix that may contain `[wip]`) cannot become regex syntax. */
function escapeRegexLiteralPath(path: string): string {
  return path.replace(/[.^$+{}()|\\[\]*?]/g, "\\$&");
}

/**
 * Whether a realpath result for a glob's fixed prefix should be REJECTED (and the prefix kept as
 * written). Both sides are first tidied with POSIX `normalize` (which keeps a trailing slash).
 *
 * The written path stands for one or two acceptable spellings: itself, and, when it lies under
 * `/tmp/` or `/var/`, the same path under `/private` (macOS's real location for both). A resolution
 * is trusted only when it is one of those spellings, or sits strictly BELOW one of them, and is not
 * also shallow (the root, `.`, or a single top-level name) or an ancestor of one of them. Anything
 * else -- climbing up, moving sideways, landing somewhere unrelated -- is rejected. Plain string
 * comparisons only; no case folding, no filesystem access.
 */
export function isSuspiciousRealpathResolution(original: string, resolved: string): boolean {
  const written = normalize(original);
  const landed = normalize(resolved);
  const spellings = acceptableSpellingsOf(written);

  if (spellings.includes(landed)) return false;

  const shallow = landed.split("/").filter((segment) => segment !== "").length <= 1;
  const climbedAbove = spellings.some((spelling) => spelling.startsWith(landed + "/"));
  const wentBelow = spellings.some((spelling) => landed.startsWith(spelling + "/"));
  return shallow || climbedAbove || !wentBelow;
}

/** A normalised path plus, for one under `/tmp/` or `/var/`, its `/private`-prefixed real spelling. */
function acceptableSpellingsOf(path: string): string[] {
  const aliased = path.startsWith("/tmp/") || path.startsWith("/var/");
  return aliased ? [path, "/private" + path] : [path];
}

/**
 * Canonicalises one path for a sandbox rule: its real target (`resolveRealTarget`, which tolerates a
 * not-yet-existing leaf), unless `isSuspiciousRealpathResolution` rejects the resolution or anything
 * throws, in which case the path is kept as written. macOS `/tmp` and `/var` are symlinks, so an
 * un-canonicalised rule silently misses (WS-12 §5.2), and a canonicalisation failure must never crash
 * profile generation or redirect a deny somewhere unrelated.
 */
function guardedCanonicalize(path: string): string {
  try {
    const resolved = resolveRealTarget(path);
    return isSuspiciousRealpathResolution(path, resolved) ? path : resolved;
  } catch {
    return path;
  }
}

/**
 * The canonicalised FIXED prefix of an absolute glob: the literal directory before the segment
 * holding the first real glob token (a glob mid-segment, `sub*dir/x`, leaves only the segments before
 * `sub*dir`). It runs THROUGH one-character bracket classes and comes back UNESCAPED
 * (`/x/[[]wip] app/**` -> `/x/[wip] app`), which is the real directory the ancestor fence and the
 * write-root comparisons need. `undefined` for a non-glob text, or when there is no prefix.
 */
function canonicalizedGlobFixedPrefix(absoluteGlob: string): string | undefined {
  const scan = scanDenyPathGlob(absoluteGlob);
  if (!scan.glob) return undefined; // not glob-shaped; nothing to canonicalize here
  if (scan.lastSepLiteralLength <= 0) return undefined; // no real prefix (glob starts at/near the root)
  return guardedCanonicalize(scan.literal.slice(0, scan.lastSepLiteralLength));
}

/**
 * Every ANCESTOR directory of `path`, nearest first: `path.dirname` applied repeatedly, starting from
 * `path`'s parent and stopping before `/` or `.` (neither is included, nor is `path` itself), or when
 * `dirname` stops changing the value.
 *
 * Feeds the sandbox's ancestor-rename fence: the profile also denies unlinking/creating every
 * ancestor of a denied path (and of a glob deny's fixed prefix), so `mv <ancestor> <elsewhere>`,
 * a write inside, and a rename back cannot slip a write past the deny.
 */
export function ancestorDirectoriesOf(path: string): string[] {
  const ancestors: string[] = [];
  let current = path;
  for (;;) {
    const parent = dirname(current);
    if (parent === current || parent === "/" || parent === ".") return ancestors;
    ancestors.push(parent);
    current = parent;
  }
}

// Converts glob text to a POSIX extended-regex source anchored with `^...$`, for an SBPL
// `(regex #"...")` clause, in one left-to-right pass:
//   - regex metacharacters (and a backslash, which escapes nothing in the glob) are backslashed;
//     `?` is one non-`/` character; brackets pass through as class syntax, except the single `[`
//     that no later `]` could close, which becomes a literal `\[`;
//   - a run of stars becomes "within a segment" (`[^/]*`, one star) and "anything" (`.*`, a pair)
//     pieces, pairs first; when two or more stars are directly followed by `/`, the last pair and
//     that `/` instead mean "any number of whole directories" (`(.*/)?`);
//   - a stretch made only of the characters `_ABGHLORST` and pair/directory pieces is gathered and
//     rendered as a whole from its SPELLING, in which a pair reads `__GLOBSTAR__` and a directory
//     piece `__GLOBSTAR_SLASH__` (see `renderWordRun`). This reproduces a long-standing quirk: those
//     two texts expand wherever they appear in such a stretch, typed or produced.
function globToAnchoredRegex(glob: string): string {
  const literalBracketAt = glob.indexOf("[", glob.lastIndexOf("]") + 1);
  let body = "";
  let wordRun = "";
  const emit = (rendered: string): void => {
    if (wordRun !== "") {
      body += renderWordRun(wordRun);
      wordRun = "";
    }
    body += rendered;
  };

  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      let runEnd = i;
      while (glob.charAt(runEnd) === "*") runEnd++;
      let stars = runEnd - i;
      const intoDirectory = stars >= 2 && glob.charAt(runEnd) === "/";
      if (intoDirectory) stars -= 2;
      for (let pair = 0; pair < Math.floor(stars / 2); pair++) wordRun += GLOBSTAR_SPELLING;
      if (stars % 2 === 1) emit(SINGLE_SEGMENT_REGEX);
      if (intoDirectory) wordRun += GLOBSTAR_SLASH_SPELLING;
      i = intoDirectory ? runEnd + 1 : runEnd;
      continue;
    }
    if (WORD_RUN_CHARACTERS.has(ch)) wordRun += ch;
    else emit(renderGlobCharacter(ch, i === literalBracketAt));
    i++;
  }
  emit("");
  return "^" + body + "$";
}

const SINGLE_SEGMENT_REGEX = "[^/]*";
const GLOBSTAR_SPELLING = "__GLOBSTAR__";
const GLOBSTAR_SLASH_SPELLING = "__GLOBSTAR_SLASH__";
/** Every character of the two spellings above; none is a regex metacharacter. */
const WORD_RUN_CHARACTERS = new Set(GLOBSTAR_SPELLING + GLOBSTAR_SLASH_SPELLING);
const ESCAPED_REGEX_CHARACTERS = new Set(".^$+{}()|\\");

/** One glob character outside any star run and outside the word-run alphabet, as regex text. */
function renderGlobCharacter(ch: string, isLiteralBracket: boolean): string {
  if (ESCAPED_REGEX_CHARACTERS.has(ch)) return "\\" + ch;
  if (ch === "?") return "[^/]";
  if (ch === "[" && isLiteralBracket) return "\\[";
  return ch;
}

// Renders a word run from its spelling: every `__GLOBSTAR_SLASH__` (leftmost first, never
// overlapping, searched over the WHOLE spelling) becomes `(.*/)?`; within each stretch left between
// those, every `__GLOBSTAR__` (same search) becomes `.*`; everything else stays as written.
function renderWordRun(spelling: string): string {
  return expandOccurrences(spelling, GLOBSTAR_SLASH_SPELLING, "(.*/)?", (stretch) => expandOccurrences(stretch, GLOBSTAR_SPELLING, ".*", (plain) => plain));
}

/** Scans `text` for non-overlapping `needle`s, leftmost first; each becomes `expansion`, and the text between them is passed through `between`. */
function expandOccurrences(text: string, needle: string, expansion: string, between: (stretch: string) => string): string {
  let out = "";
  let from = 0;
  for (let hit = text.indexOf(needle); hit !== -1; hit = text.indexOf(needle, from)) {
    out += between(text.slice(from, hit)) + expansion;
    from = hit + needle.length;
  }
  return out + between(text.slice(from));
}

/**
 * An absolute glob as a whole-path SBPL regex. The fixed prefix is canonicalised first
 * (`canonicalizedGlobFixedPrefix`) and spliced back as ESCAPED LITERAL text (`escapeRegexLiteralPath`);
 * only the rest goes through `globToAnchoredRegex`. The prefix may hold `[`/`]` (it runs through
 * one-character classes, `scanDenyPathGlob`), which must not become a class again. A glob-free text
 * (reachable only by a direct call; the deny split sends it to `(subpath …)`) renders as the whole
 * escaped, canonicalised literal.
 */
export function globToSbplRegexSource(absoluteGlob: string): string {
  const scan = scanDenyPathGlob(absoluteGlob);
  if (!scan.glob) return "^" + escapeRegexLiteralPath(guardedCanonicalize(scan.literal)) + "$";
  const canonicalPrefix = canonicalizedGlobFixedPrefix(absoluteGlob);
  if (canonicalPrefix === undefined) return globToAnchoredRegex(absoluteGlob);
  return "^" + escapeRegexLiteralPath(canonicalPrefix) + globToAnchoredRegex(absoluteGlob.slice(scan.lastSepRaw)).slice(1);
}

/**
 * `globToSbplRegexSource`, widened to also match everything BELOW a match: its final `$` is replaced
 * by `(/.*)?$`. The regex counterpart of `subpath`'s "and everything under it"; a glob-shaped deny's
 * own clause always uses this form.
 */
export function recursiveGlobToSbplRegexSource(absoluteGlob: string): string {
  return globToSbplRegexSource(absoluteGlob).replace(/\$$/, "(/.*)?$");
}

/**
 * The ONE place a plain `sandbox.filesystem.denyWrite`/`denyRead` list (settings.json's own,
 * user-typed, and `deriveSandboxPathsFromRules`' rule-derived denies, which may be glob-shaped -- see
 * `resolveFileRuleAbsoluteGlobText`) is split by glob shape before reaching `SeatbeltProfileInput`/
 * `RunCommandOptions`: a non-glob entry stays a plain path (`subpath`); a glob-shaped one becomes a
 * `recursiveGlobToSbplRegexSource` regex. Shared by tools/impl/bash.ts and tools/impl/monitor.ts
 * rather than copied into each.
 *
 * Also returns `globFixedPrefixes`: for each glob-shaped entry, its canonicalised fixed-prefix
 * directory, dropped when it is `/`. The ancestor-rename fence
 * (`SeatbeltProfileInput.denyWriteGlobFixedPrefixes`/`denyReadGlobFixedPrefixes`) walks a plain
 * entry's own ancestors (`ancestorDirectoriesOf`); a glob-shaped deny also needs its fixed prefix
 * walked, and the prefix itself denied as a literal target.
 *
 * Classified by `scanDenyPathGlob`: an entry whose only glob syntax is one-character bracket classes
 * (`/x/[[]wip] app/.winter/skills`) lands in `paths` UNESCAPED (`/x/[wip] app/.winter/skills`).
 */
export function splitDenyPathsByGlobShape(paths: readonly string[]): { paths: string[]; regexes: string[]; globFixedPrefixes: string[] } {
  const plain: string[] = [];
  const regexes: string[] = [];
  const globFixedPrefixes: string[] = [];
  for (const p of paths) {
    const scan = scanDenyPathGlob(p);
    if (scan.glob) {
      regexes.push(recursiveGlobToSbplRegexSource(p));
      const prefix = canonicalizedGlobFixedPrefix(p);
      if (prefix !== undefined && prefix !== "/") globFixedPrefixes.push(prefix);
    } else {
      plain.push(scan.literal);
    }
  }
  return { paths: plain, regexes, globFixedPrefixes };
}

/** One glob-shaped deny entry: its recursive SBPL regex PAIRED with its own fixed-prefix directory.
 * `splitDenyPathsByGlobShape`'s `regexes`/`globFixedPrefixes` are two independently filtered arrays
 * (the latter drops a `/` prefix) with no positional correspondence; `fixedPrefix` here is never
 * dropped -- it is the string `"/"` when there is no deeper prefix. */
export interface GlobDenyEntry {
  regex: string;
  fixedPrefix: string;
}

/**
 * The PAIRED form `buildReadDenyKeepInPlaceBlock` (sandbox/profile.ts) needs -- see `GlobDenyEntry`.
 * Glob-shaped entries only (a plain entry's own path is both its clause anchor and its ancestor-walk
 * root), classified by the same `scanDenyPathGlob` as `splitDenyPathsByGlobShape`.
 */
export function globDenyEntriesOf(paths: readonly string[]): GlobDenyEntry[] {
  const out: GlobDenyEntry[] = [];
  for (const p of paths) {
    if (!scanDenyPathGlob(p).glob) continue;
    out.push({ regex: recursiveGlobToSbplRegexSource(p), fixedPrefix: canonicalizedGlobFixedPrefix(p) ?? "/" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pattern normalisation
// ---------------------------------------------------------------------------------------------

/**
 * Normalises a root-relative pattern before it reaches `ignore()`.
 *
 * Every run of slashes collapses to one. Then a leading byte-order mark (U+FEFF) is dealt with, one
 * level deep, so it can neither vanish in a way that promotes the next character to a gitignore
 * directive nor linger as an invisible first character:
 *   - a pattern that is only whitespace (JS `\s`, which includes the BOM), optionally ending in
 *     exactly `/**`, is left as it is;
 *   - a BOM followed by `!` or `#` becomes a backslash, so the directive character stays literal;
 *   - two BOMs become a one-character class holding a BOM (`[<BOM>]`), keeping the second literal;
 *   - a lone BOM before anything else is dropped.
 * A pattern with no leading BOM is returned after the slash collapse alone.
 */
export function normalizeFileRulePattern(relativePattern: string): string {
  const collapsed = relativePattern.replace(/\/{2,}/g, "/");
  switch (leadingBomTreatment(collapsed)) {
    case "keep":
      return collapsed;
    case "escape-directive":
      return "\\" + collapsed.slice(1);
    case "bracket-second-bom":
      return `[${BYTE_ORDER_MARK}]` + collapsed.slice(2);
    case "drop":
      return collapsed.slice(1);
  }
}

const BYTE_ORDER_MARK = "﻿";

type LeadingBomTreatment = "keep" | "escape-directive" | "bracket-second-bom" | "drop";

/** How `normalizeFileRulePattern` must treat the (slash-collapsed) pattern's first character. */
function leadingBomTreatment(pattern: string): LeadingBomTreatment {
  if (/^\s*(?:\/\*\*)?$/.test(pattern) || !pattern.startsWith(BYTE_ORDER_MARK)) return "keep";
  const next = pattern.charAt(1);
  if (next === "!" || next === "#") return "escape-directive";
  return next === BYTE_ORDER_MARK ? "bracket-second-bom" : "drop";
}

/**
 * The trailing-`/**` rewrite, which differs by direction:
 *   - a pattern NOT ending in `/**` is returned unchanged;
 *   - if what precedes the `/**` is empty or only slashes, the result is `/**`;
 *   - otherwise the `/**` is dropped. For DENY/ASK (`isAllow: false`) the rest is returned as it is:
 *     a single segment `x` then matches a directory `x` at any depth and everything under it. For
 *     ALLOW, a rest that is a single segment (no `/`) not starting with `!` or `#` gets a leading `/`
 *     (`x/**` -> `/x`), so the allow stays scoped to the anchor root; a rest with a `/` in it, or
 *     starting with `!`/`#`, is returned as it is.
 */
export function unanchorTrailingDoubleStar(pattern: string, isAllow: boolean): string {
  if (!pattern.endsWith("/**")) return pattern;
  const rest = pattern.slice(0, -3);
  if (/^\/*$/.test(rest)) return "/**";
  if (!isAllow) return rest;
  const singleSegment = !rest.includes("/");
  const directive = rest.startsWith("!") || rest.startsWith("#");
  return singleSegment && !directive ? "/" + rest : rest;
}

// ---------------------------------------------------------------------------------------------
// Grouped compilation and matching
// ---------------------------------------------------------------------------------------------

export interface FileRuleCandidate<TEntry> {
  entry: TEntry;
  /** The rule's own pattern text, exactly as written (anchor resolution, normalisation and the trailing-`/**` rewrite run on this). */
  pattern: string;
  /** The settings-source directory for a `/`-anchored rule -- see `resolveFileRuleAnchor`. Absent = every `/`-anchored candidate is inert. */
  sourceDir?: string | undefined;
}

/**
 * A malformed pattern's compile failure is a THROW out of `matchFileRulesGrouped`, the same on every
 * direction: one broken group aborts the whole permission check for that call. This class makes that
 * propagation typed; it is caught exactly once, at `evaluator.ts`'s `evaluate()` (the "decide this one
 * call" boundary), and turned into a generic fail-closed deny.
 */
export class FileRuleCompileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FileRuleCompileError";
  }
}

/**
 * Matches `path` against `candidates`, grouped by anchor root:
 *   - each candidate's anchor is resolved (`resolveFileRuleAnchor`, with its own `sourceDir`); an
 *     INERT candidate is skipped; a `null` root means `opts.cwd`;
 *   - its pattern is normalised (`normalizeFileRulePattern`) and then rewritten
 *     (`unanchorTrailingDoubleStar`, `isAllow` = `behavior === "allow"`);
 *   - all candidates with the same root go into one case-insensitive `ignore()` instance, in candidate
 *     order; the roots are kept in the order they first appear;
 *   - for each root in that order, `path` is made relative to the root (`path.relative`). A relative
 *     path that is empty, starts with `/`, `./` or `../`, or is exactly `.` or `..` is outside the
 *     root, and that group is skipped -- the `ignore` package's own rule for an invalid path, so a
 *     name that merely starts with `..` (`..x/evil.sh`) is inside;
 *   - the first group that reports the path ignored decides: the result is the entry of the candidate
 *     whose compiled pattern text the package names as the matching rule (when two candidates in a
 *     group compiled to the same text, the LATER one); if that text maps to no entry, the next group
 *     is tried;
 *   - `null` when no group matches.
 * THROWS `FileRuleCompileError` when the package fails while testing a group (a malformed pattern
 * only fails then, on first use, never when it is added). The message names the group's root:
 * `a file-rule pattern under <JSON-quoted root> failed to compile`, with the package's error as `cause`.
 */
export function matchFileRulesGrouped<TEntry>(candidates: readonly FileRuleCandidate<TEntry>[], path: string, opts: { cwd: string; home: string }, behavior: "allow" | "denyAsk"): TEntry | null {
  const isAllow = behavior === "allow";
  // Insertion order of a Map is the order each root first appears.
  const groups = new Map<string, { matcher: ReturnType<typeof ignoreFactory>; entryByPattern: Map<string, TEntry> }>();
  for (const candidate of candidates) {
    const anchor = resolveFileRuleAnchor(candidate.pattern, { home: opts.home, sourceDir: candidate.sourceDir });
    if (anchor.root === INERT_ANCHOR) continue;
    const root = anchor.root ?? opts.cwd;
    const compiled = unanchorTrailingDoubleStar(normalizeFileRulePattern(anchor.relativePattern), isAllow);
    let group = groups.get(root);
    if (group === undefined) {
      group = { matcher: ignoreFactory({ ignorecase: true }), entryByPattern: new Map() };
      groups.set(root, group);
    }
    group.matcher.add(compiled);
    group.entryByPattern.set(compiled, candidate.entry); // a later candidate with the same text wins
  }

  for (const [root, group] of groups) {
    const rel = relative(root, path);
    if (isOutsideIgnoreRoot(rel)) continue;
    let result: { ignored: boolean; rule?: { pattern: string } | undefined };
    try {
      result = group.matcher.test(rel);
    } catch (err) {
      throw new FileRuleCompileError(`a file-rule pattern under ${JSON.stringify(root)} failed to compile`, { cause: err });
    }
    if (!result.ignored) continue;
    const matchedPattern = result.rule?.pattern;
    if (matchedPattern !== undefined && group.entryByPattern.has(matchedPattern)) return group.entryByPattern.get(matchedPattern) as TEntry;
  }
  return null;
}

/** A root-relative path the `ignore` package would refuse as not relative: empty, `.`/`..`, or starting `/`, `./`, `../`. */
function isOutsideIgnoreRoot(rel: string): boolean {
  return rel === "" || rel === "." || rel === ".." || rel.startsWith("/") || rel.startsWith("./") || rel.startsWith("../");
}

// ---------------------------------------------------------------------------------------------
// macOS's trusted system symlinks -- used ONLY by the allow-rule retry in `evaluator.ts`'s
// `findMatchingFileRuleEntry`; the acceptEdits boundary (`isPathWithinRoot`) has its own, narrower
// alias handling.
// ---------------------------------------------------------------------------------------------

/**
 * Rewrites a path that starts with one of macOS's real system directories back to the short symlink
 * spelling users type: `/private/tmp` -> `/tmp`, `/private/var` -> `/var`, `/private/etc` -> `/etc`,
 * `/usr/bin` -> `/bin`, `/usr/lib` -> `/lib`, `/usr/sbin` -> `/sbin`, checked in that order. A path
 * matches a pair when it equals the real directory or starts with it followed by `/`. Each pair is
 * VERIFIED once per process (`realpathSync(alias) === real`) rather than assumed, and a pair that
 * does not resolve that way on this machine is never applied. Any other path is returned unchanged.
 */
export function canonicalizeTrustedSymlinkPath(path: string): string {
  for (const { real, alias } of verifiedTrustedSymlinkPairs()) {
    if (path === real) return alias;
    if (path.startsWith(real + "/")) return alias + path.slice(real.length);
  }
  return path;
}

/** macOS's system symlinks, as (real directory, short alias), in the order they are tried. */
const TRUSTED_SYMLINK_PAIRS: readonly { real: string; alias: string }[] = [
  { real: "/private/tmp", alias: "/tmp" },
  { real: "/private/var", alias: "/var" },
  { real: "/private/etc", alias: "/etc" },
  { real: "/usr/bin", alias: "/bin" },
  { real: "/usr/lib", alias: "/lib" },
  { real: "/usr/sbin", alias: "/sbin" },
];

let trustedSymlinkPairsCache: readonly { real: string; alias: string }[] | undefined;

/** The pairs that really resolve that way on this machine, checked on first use and then remembered for the process. */
function verifiedTrustedSymlinkPairs(): readonly { real: string; alias: string }[] {
  if (trustedSymlinkPairsCache === undefined) {
    trustedSymlinkPairsCache = TRUSTED_SYMLINK_PAIRS.filter(({ real, alias }) => {
      try {
        return realpathSync(alias) === real;
      } catch {
        return false;
      }
    });
  }
  return trustedSymlinkPairsCache;
}

/**
 * The acceptEdits working-directory boundary: is `childPath` inside `rootPath`? A plain path-prefix
 * test, never a glob, so a root containing `[`, `]`, `*` or `\` (a cwd named `[wip] app`) needs no
 * escaping.
 *
 *   1. On each path (independently), a leading `/private/var/` becomes `/var/`, and a leading
 *      `/private/tmp` followed by `/` or the end of the path becomes `/tmp` (case-sensitive tests);
 *      macOS keeps both short spellings as symlinks, and `os.tmpdir()` resolves through
 *      `/private/var/folders/...`.
 *   2. With `caseFold` (default `true`), both are then lower-cased.
 *   3. The answer comes from `path.relative(root, child)`: `""` is inside; `..` or anything starting
 *      `../` is outside; otherwise inside unless the relative path is absolute.
 */
export function isPathWithinRoot(childPath: string, rootPath: string, opts: { caseFold?: boolean } = {}): boolean {
  const caseFold = opts.caseFold ?? true;
  const prepare = (p: string): string => {
    const short = shortSystemAlias(p);
    return caseFold ? short.toLowerCase() : short;
  };
  const rel = relative(prepare(rootPath), prepare(childPath));
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith("../")) return false;
  return !isAbsolute(rel);
}

/** `/private/var/...` -> `/var/...`, and `/private/tmp` (whole, or followed by `/`) -> `/tmp`. */
function shortSystemAlias(p: string): string {
  if (p.startsWith("/private/var/")) return "/var/" + p.slice("/private/var/".length);
  if (p === "/private/tmp" || p.startsWith("/private/tmp/")) return "/tmp" + p.slice("/private/tmp".length);
  return p;
}

// ---------------------------------------------------------------------------------------------
// The plugin-manifest traversal fence
// ---------------------------------------------------------------------------------------------

/**
 * Whether a path a plugin MANIFEST declares for a component (`commands`/`agents`/`skills`/
 * `output-styles`/`workflows`/`hooks`) stays inside the plugin:
 *   1. a candidate containing a backslash is refused;
 *   2. both the candidate and the plugin root are resolved to their real targets
 *      (`resolveRealTarget`, which walks up to the nearest existing ancestor for a path that does not
 *      exist yet); any failure there (a symlink loop, a permission error) refuses;
 *   3. `path.relative(realRoot, realCandidate)`: `""` is inside; ANY relative path starting with the
 *      two characters `..` is refused -- `..x/agents` included, a naive string test kept on purpose;
 *      otherwise inside unless the relative path is absolute.
 * Case-sensitive, and with no `/tmp`-style alias mapping (both sides are already real paths).
 * Resolving symlinks first refuses an override that points outside the plugin.
 */
export function resolvesWithinPluginRoot(candidatePath: string, pluginRoot: string): boolean {
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
// Escaping a REAL filesystem path before it becomes rule PATTERN text
// ---------------------------------------------------------------------------------------------

/**
 * A real path (e.g. `resolve(winterHome)`) can contain `[`, `]`, `*` or `\`, all of which are glob
 * syntax to `matchFileRulesGrouped`. A caller building a rule PATTERN from a real path
 * (`buildBaselineDenyRules`, engine.ts) escapes it with this first, or a home named
 * `/Users/name[wip]` would have its own floor's `[wip]` read back as a character class.
 *
 *   1. a backslash goes before every `[`, `]`, `*` and `\`;
 *   2. then the trailing run of whitespace (`\s`), if any, gets a backslash before EACH of its
 *      characters -- the `ignore` package trims unescaped trailing whitespace off a pattern, so a path
 *      ending in a space would otherwise lose its own protection.
 *
 * `?` is deliberately left raw: the grammar has no working escape for it (`\?` would demand a literal
 * backslash the real path never has, so it would match nothing). A raw `?` is a one-character
 * wildcard, which still matches the real `?` -- over-matching by one character is the safe direction
 * for a DENY floor, where an escape that matched nothing would be a hole.
 */
export function escapeFileRulePathSegment(path: string): string {
  const escaped = path.replace(/[[\]*\\]/g, "\\$&");
  // Find the trailing whitespace run by walking back from the end.
  let start = escaped.length;
  while (start > 0 && /\s/.test(escaped[start - 1]!)) start--;
  if (start === escaped.length) return escaped;
  let tail = "";
  for (const ch of escaped.slice(start)) tail += "\\" + ch;
  return escaped.slice(0, start) + tail;
}

/**
 * A SINGLE pattern against a SINGLE path -- for a caller already iterating rule entries one at a time
 * for its own reason (e.g. evaluator.ts's cross-tool `findFileDenyBlockingEdit`, a Winter-only safety
 * net: a Read deny also blocks a Write). Grouping does not apply across such unrelated single checks;
 * this is a thin convenience, not a second matching engine.
 */
export function matchesSingleFileRulePattern(pattern: string, path: string, opts: { cwd: string; home: string }, behavior: "allow" | "denyAsk"): boolean {
  return matchFileRulesGrouped([{ entry: true, pattern }], path, opts, behavior) !== null;
}
