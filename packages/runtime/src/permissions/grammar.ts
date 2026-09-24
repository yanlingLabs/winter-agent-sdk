// Task 3 (WS-07 §3): the permission rule-grammar core. Pure functions only -- no fs, no engine
// imports, no Bun-only APIs (this file is exercised by the sdk-fence-adjacent typecheck sweep only
// indirectly, but the whole package still ships as part of the runtime binary; staying host-
// agnostic keeps it trivially unit-testable). Public types (`PermissionMode` etc.) are owned by
// the sdk package (WS-02 §3: the runtime imports sdk types, never the reverse) --
// packages/sdk/src/permissions/types.ts.
//
// ARCHITECTURE (how the six exports compose -- later tasks are the callers):
//   - `splitCompound` decomposes a full (possibly compound) Bash command string into independently
//     -permitted subcommands (WS-07 §3's compound-command clause). It is the ONLY function here
//     that deals with compound structure; every other function operates on a single atomic
//     command/subcommand string. Callers (T6's evaluator, T7's recognizers) call this FIRST on the
//     whole command, then loop per-subcommand.
//   - `stripWrappers` normalizes a single (sub)command by removing a harmless wrapper prefix
//     (WS-07 §3's fixed set + leading env assignments) before recognition/matching. It is called
//     BOTH internally by `matchesRule` (for Bash pattern-kind rules, using the rule's own
//     direction) AND externally by T7's edit/critical recognizers, which need the normalized text
//     for their own classification, independent of any specific rule.
//   - `matchesRule` matches ONE parsed rule against ONE atomic call. `opts.direction` matters in
//     exactly two places: the wrapper-strip asymmetry (Bash pattern rules) and MCP allow-glob
//     server-prefix anchoring. It does not itself split compound commands (see above) and does not
//     gate on redirect targets (see `extractRedirectTargets` below).
//   - `extractRedirectTargets` is fully independent of rule matching: WS-07 §3 is explicit that
//     "a Bash allow for a command never authorizes its redirect target" -- the target is a SEPARATE
//     file-write check (Task 4/7's path rules), never folded into `matchesRule`'s own verdict.
//   - `isRecognizedReadOnly` is a standalone pre-approval predicate (WS-07 §6.1's "recognized read-
//     only shell forms run without prompting"), not consulted by `matchesRule`.

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

// A parsed rule's specifier family. Judgment call (spec-cited below): `parseRule` is a TOTAL
// function -- it never throws, even for WS-07 §3 shapes the spec calls "rejected". Two kinds exist
// specifically to represent syntactically-valid-but-semantically-forbidden content without an
// exception: `invalid` (an MCP tool with any parenthetical specifier -- WS-07 §3: "parenthetical
// parameter rules in settings are rejected"). The OTHER documented rejection -- an unanchored MCP
// allow-side glob ("mcp__* allow REJECTED") -- is direction-conditional (fine for denyAsk, invalid
// for allow), so it can't be a parse-time sentinel at all; `matchesRule` encodes it as an
// unconditional `false` for that direction (see `isAnchoredMcpAllowGlob` below).
//
// CONCERN FOR T5 (flagged per the brief's "grammar-reading judgment calls" instruction, restated
// in the report): an `invalid` rule sitting in a DENY list is silently inert at the grammar layer
// -- matchesRule(rule, call, {direction:"denyAsk"}) just returns false, exactly like a rule that
// never matches anything. A user who wrote a deny rule expecting it to fire gets no error from
// this module. Task 5's settings/PermissionUpdate loader should surface
// `parsedRule.specifier?.kind === "invalid"` as a validation error when a rule is ADDED, not rely
// on grammar.ts to reject it at match time.
export type Specifier =
  | { kind: "wildcardAll" } // `Tool(*)` -- WS-07 §3: treated like bare `Tool`, including schema removal as a deny (that half is a registry/T6 concern; this module only carries the flag).
  | { kind: "pattern"; source: string } // Bash-style command glob/prefix grammar (WS-07 §3's general `*`/`:*` rule), matched against `call.input.command` by `matchesRule` (see that function's comment for why non-Bash tools fail closed there). ALSO used verbatim (fix round 2, Ruling P2-G) for `FILE_RULE_TOOLS` (Read/Edit) content, where `source` carries the untouched WS-07 §3.1 gitignore-like pattern for Task 4's matchFileRule to consume directly -- `matchesRule` is never the file-rule dispatch point, so its command-matching semantics are simply inert (not consulted) for that case.
  | { kind: "param"; field: string; value: string | boolean } // top-level scalar rule, e.g. `Agent(model:opus)`, `Bash(run_in_background:true)` (WS-07 §3).
  | { kind: "webFetchDomain"; source: string } // `WebFetch(domain:...)` -- WS-07 §3's own "native" content-field grammar, NOT a generic param rule (see matchesRule).
  | { kind: "invalid"; reason: string }; // syntactically parsed, never matches -- see the type-level comment above.

export interface ParsedRule {
  toolName: string;
  specifier?: Specifier;
  // WS-07 §3: "`Bash(*)` is treated like bare `Bash`". True for an actual bare rule (no specifier
  // at all) AND for an explicit `Tool(*)` -- callers that only care about "does this rule apply
  // regardless of input" (e.g. a future schema-removal-as-deny check) can test this flag alone
  // rather than re-deriving the equivalence from `specifier`.
  isBareEquivalent: boolean;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

// Provisional parser input-length cap (WS-07 §3: "commands over the parser limit... fall back to
// permission handling"). No public value is pinned anywhere in scope for this task; 50k chars is
// comfortably above any realistic single shell invocation while still bounding the scan cost of a
// pathological input. Revisit if a differential capture (WS-17) pins a real number.
//
// Fix round 1, Finding A / P2 fix-wave item 2 correction: this comment used to claim TWO things
// that are no longer (and, for the second, were never actually) true. (1) "Scoped to splitCompound
// only" -- false since fix round 1's own isRecognizedReadOnly guard (scanIfParseable, above) also
// consults it; both of scanIfParseable's two callers share this one cap. (2) "the other functions
// here ... simply do proportionally more linear work" -- also false as originally stated:
// stripWrappers/stripLeadingAssignments/extractRedirectTargets each had an internal loop that
// re-derived a fresh scanShellLike over an ever-shrinking SLICED substring once per
// wrapper/flag/redirect, making their worst case polynomial, not linear, for an input with many of
// those (e.g. many single-char flags, or many chained redirects) -- PARSE_LIMIT alone never bounded
// that cost, since it only bounds the INITIAL scan's own starting length, not how many times a
// downstream loop re-scans a shrinking tail of it. The fix-wave's own threading change
// (leadingWordAt/stripLeadingAssignmentsAt below, sharing ONE scan across a whole call via a plain
// integer offset into the unchanging original string, never a re-scanned slice) is what actually
// makes those three functions linear; this cap remains a separate, complementary bound on the
// scan's own starting length, orthogonal to that fix.
export const PARSE_LIMIT = 50_000;

// WS-07 §3's minimum read-only recognition list, verbatim from the task brief. Exported (named
// constant, not inlined) so P3's tool work can extend it per the brief's own instruction.
//
// TODO(P3): WS-07 §3's same sentence also names "remote daemon selectors" and "certain glob forms"
// as read-only fallback categories (falling back to permission handling, like write-capable
// flags) -- e.g. an ssh/kubectl/docker-style remote-target selector mixed into an otherwise-
// recognized command, or a glob shape broad enough that "read-only" stops being a safe
// characterization of its effect. Neither is in Task 3's fixture corpus (the brief's own minimum
// list never exercises them) and none of the base commands above take a remote-selector argument
// today, so there is nothing to plug in yet -- P3's tool work should re-check this the moment any
// added command *can* take one, rather than assuming the current minimum list stays selector-free.
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "find",
  "pwd",
  "echo",
]);

// Fix round 1, Finding B / Ruling P2-C: env-variable NAMES whose assignment can change what a
// subsequent command actually does regardless of how innocuous the ASSIGNED VALUE looks
// syntactically -- e.g. `LD_PRELOAD=/tmp/evil.so cat /etc/passwd` has a value with no `$(`/
// backtick/`${` in it, so `isSafeAssignmentValue` alone would call it safe and strip it, but a
// real shell still loads the preload library before `cat` ever runs. A NAME match makes the
// assignment un-strippable on the ALLOW side regardless of its value; denyAsk's existing "look
// through ANY leading assignment" is unaffected (dangerous-by-name is a strict subset of "any").
// Matching is case-exact (env var names are case-sensitive in every shell/OS environ this targets)
// -- deliberately NOT normalized to upper/lower case before the `.has()` check. Exported,
// independently curated, and capture-noted: this list is not confirmed exhaustive against any
// pinned runtime, and P3/a future WS-17 differential capture may extend it.
export const DANGEROUS_ASSIGNMENT_NAMES: ReadonlySet<string> = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "PERL5LIB",
  "PYTHONPATH",
  "NODE_OPTIONS",
]);

// git's read-only subcommand allowlist (WS-07 §3: "git status, git log, git diff... git push not").
const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff"]);

// Write-capable flags that disqualify an otherwise-recognized read-only command (WS-07 §3: "write-
// capable flags... fall back to permission handling"), keyed by the leading command word. Only
// `find -delete` is in the brief's required corpus; the table itself is intentionally generic/
// extensible (P3's tool work is expected to add entries here, not restructure the mechanism).
// Judgment call: `sed -i` is NOT added as a base entry, and `sed` is NOT added to
// READ_ONLY_COMMANDS above -- sed isn't part of the brief's own "minimum list", and adding it would
// newly recognize a command this task was never asked to authorize as auto-approved. The mechanism
// below is shaped so a later task can add `sed: /(^|\s)-i\b/` alongside a `sed` entry in
// READ_ONLY_COMMANDS without touching isRecognizedReadOnly's logic at all.
//
// claude's read-only find excludes every action that writes or runs a command (readOnlyValidation.ts:
// -delete, -exec, -execdir, -ok, -okdir, -fprint, -fprint0, -fprintf, -fls); rg's `--pre` runs a
// command on every file. For both, ANY `$`/backtick is refused too: an expansion can assemble the flag
// (`rg . "$Z--pre=bash" FILE` -- claude's own example).
const WRITE_CAPABLE_FLAGS: Readonly<Record<string, RegExp>> = {
  find: /(^|\s)-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)(\s|$)|[$`]/,
  rg: /--pre|[$`]/,
};

// `git diff/log --output=<file>` WRITES that file (`--output=.git/hooks/pre-commit`).
const GIT_WRITE_CAPABLE_FLAGS = /--output|[$`]/;

// Fixed wrapper set (WS-07 §3, verbatim list) stripped for POSITIVE (allow) matching recognition;
// `xargs` is handled separately below because of its flag-free precondition.
const FIXED_WRAPPERS: ReadonlySet<string> = new Set([
  "timeout",
  "time",
  "nice",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
  "noglob",
]);
const XARGS = "xargs";

// Judgment call: the fixed wrapper set is documented by name only (WS-07 §3 doesn't describe each
// wrapper's own argument shape). Stripping only the bare word "timeout" would leave its required
// positional duration argument (e.g. the "30" in `timeout 30 ls`) in front of the real command,
// defeating the entire point of wrapper-stripping (the remainder would never match a plain
// `Bash(ls *)` rule). `timeout` is the one fixed-set wrapper with a well-known REQUIRED positional
// argument; every other fixed wrapper is modeled as flags-only before the wrapped command begins.
const WRAPPERS_WITH_POSITIONAL_ARG: ReadonlySet<string> = new Set(["timeout"]);

// Bash's own non-command parameter fields (WS-07 §3's own example: `run_in_background`). A
// `field:value`-shaped Bash specifier is only ever a param rule when the field is in this
// allowlist -- Bash's PRIMARY grammar is the command-glob string itself, which can legitimately
// contain colons (e.g. `Bash(curl http://example.com:8080/*)`), so an unrestricted "any colon
// means params" rule would misparse ordinary command patterns. This also protects the `:*`
// trailing-wildcard sugar (`Bash(ls:*)`) from ever being misread as a param rule on a field named
// "ls" -- pinned by its own fixture.
const BASH_PARAM_FIELDS: ReadonlySet<string> = new Set(["run_in_background"]);

// Fix round 2, Ruling P2-G: file-rule tools (WS-07 §3.1's gitignore-like Read/Edit patterns) --
// for these, the specifier content ALWAYS parses as a file pattern; the generic param branch below
// must NEVER apply, because a file path can legitimately contain a colon (a Windows drive letter
// in `Edit(C:/Users/x/**)`, or any other path segment in `Read(a:b/**)`) that would otherwise be
// misread as a `field:value` param rule -- silently turning a deny/ask rule into one that can
// never match (the same fail-open class as this phase's other findings). Expressed as DATA (this
// exported set), not a scattered per-tool conditional, so extending it is a one-line addition.
// Task 4's matchFileRule (paths.ts) is the actual file-glob engine; this table only decides
// DISPATCH -- which Specifier kind a given tool's parenthetical content becomes at parse time.
//
// Task 8 (P3 close-out, RULING P3-E + advisor-ratified extension): "Write" and "NotebookEdit" join
// Read/Edit here -- the P3 lane's own registry now has real descriptors with `permissionClass:
// "edit"`/"read"` for every one of these four names, so this table is no longer a P3-carried TODO.
// Before this fix, a `Write(secrets/**)` or `NotebookEdit(secrets/**)` deny/ask/allow rule fell
// through to the GENERIC branch below, which reads `call.input["command"]` (a Bash-shaped field
// neither tool call ever has) -- silently NEVER matching, the identical fail-open class RULING
// P3-E's own NotebookEdit finding named for the write-path-EXTRACTION side. `evaluator.ts`'s
// `matchesRuleForCall` FILE_RULE_TOOLS branch (and `edit-recognition.ts`'s own `fileRulePathField`)
// is what makes this table's EXTENSIBILITY promise ("extending it is a one-line addition") true in
// practice, not just in the comment above.
// I1 (fix wave, P3 close-out): "Glob" and "Grep" join the family here too -- the dedicated
// read/search tools WS-07 §6.1 (line 136) names alongside plain Read ("Reads within
// working/additional directories, dedicated read/search tools, and recognized read-only shell forms
// run without prompting"). The P2 evaluator predates Glob/Grep (T8's own P3-E extension only ever
// added Write/NotebookEdit); this table's own "extending it is a one-line addition" promise is what
// makes THIS addition equally mechanical -- evaluator.ts's `matchesRuleForCall` FILE_RULE_TOOLS
// branch and `edit-recognition.ts`'s own `fileRulePathField` both grow the matching Glob/Grep case.
export const FILE_RULE_TOOLS: ReadonlySet<string> = new Set(["Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep"]);

// ---------------------------------------------------------------------------------------------
// Shared low-level shell-like scanner
// ---------------------------------------------------------------------------------------------
//
// One shared quote/paren-depth scan powers splitCompound, stripWrappers' word/assignment reading,
// and extractRedirectTargets' target reading, so quoting is handled identically everywhere. Known,
// deliberate limitations (not in this task's fixture corpus, flagged rather than built): brace
// expansion / `${...}` is not depth-tracked (only `(...)`, which also covers `$(...)` and process
// substitution `<(...)`/`>(...)` for free, since only the paren itself is special); a heredoc BODY
// is not excluded from the scan (only the introducing `<<` operator is recognized-and-skipped by
// `extractRedirectTargets`), so a body that itself contains a top-level `>`-family sequence could
// false-positive as a redirect target.
interface ScanInfo {
  // topLevel[i] === true means s[i] sits at paren-depth 0 and outside any quote/backtick span --
  // i.e. a position where an operator or whitespace is structurally meaningful. Positions inside
  // quotes or parens are always false, so callers naturally skip over them without special-casing.
  topLevel: boolean[];
  ok: boolean; // false => unterminated quote or unbalanced parens (unparseable)
}

function scanShellLike(s: string): ScanInfo {
  const topLevel: boolean[] = new Array<boolean>(s.length).fill(false);
  let depth = 0;
  // `$'` is bash's ANSI-C quoting: single-quoted, but `\'` does NOT end it. Treating it as a plain
  // single quote ended it early, and the rest of the string was read with the wrong quote parity.
  let quote: '"' | "'" | "`" | "$'" | null = null;
  let ok = true;
  let dollarAt = -2; // index of the last UNQUOTED, UNESCAPED `$`

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (quote === "'") {
        if (ch === "'") quote = null;
      } else if (quote === "$'") {
        if (ch === "\\" && i + 1 < s.length) {
          i++;
          continue;
        }
        if (ch === "'") quote = null;
      } else {
        // double-quote or backtick: backslash escapes the next character
        if (ch === "\\" && i + 1 < s.length) {
          i++;
          continue;
        }
        if (ch === quote) quote = null;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < s.length) i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch === "'" && dollarAt === i - 1 ? "$'" : ch;
      continue;
    }
    if (ch === "$") dollarAt = i;
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth === 0) ok = false;
      else depth--;
      continue;
    }
    if (depth === 0) topLevel[i] = true;
  }
  if (quote !== null) ok = false;
  if (depth !== 0) ok = false;
  return { topLevel, ok };
}

// Fix round 1, Finding A: the shared "is this command parseable at all" gate (WS-07 §3:
// "unparseable commands, commands over the parser limit... fall back to permission handling").
// Threads ONE scan result out to both `splitCompound` (structural decomposition) and
// `isRecognizedReadOnly` (a pre-approval shortcut that must not fire on text it can't confidently
// analyze) rather than each re-deriving the same length-check-then-scan inline, which would mean
// two full rescans of the same string for two callers checking the identical precondition. Returns
// `null` for "not parseable" (over limit, or scanShellLike reports unterminated
// quote/unbalanced parens); the caller never needs to call scanShellLike a second time on success.
function scanIfParseable(command: string): ScanInfo | null {
  if (command.length > PARSE_LIMIT) return null;
  const info = scanShellLike(command);
  return info.ok ? info : null;
}

// P2 fix-wave item 2 (Finding C / "O(n^2) worst case in stripWrappers/stripLeadingAssignments/
// extractRedirectTargets", refused at the trivial-bar during T3's own round): reads one
// whitespace-delimited "word" starting at `start` within `s`, using an ALREADY-COMPUTED ScanInfo
// for the FULL string `s` -- never re-scanned here. Returns the END index (exclusive), never a
// sliced "rest of string", so a caller walking `s` left-to-right in a loop (stripWrappers' own
// wrapper/flag-stripping loop, extractRedirectTargets' own operator loop) shares ONE scan across
// every word it reads, via a plain integer offset into the SAME unchanging string, instead of each
// call re-deriving topLevel/ok from scratch over an ever-shrinking SLICED tail substring. That
// repeated re-derivation was the actual O(n^2) shape: k words/flags/redirects in a command of
// length n cost O(n) each to (re)scan, O(n*k) total, k ~ n in the worst case (many chained
// single-char flags, or many chained "xargs xargs xargs ... cmd" wrappers, or many redirects).
//
// A word may itself contain top-level whitespace's OPPOSITE -- non-top-level spans (quoted/
// parenthesized) -- without ending; it only stops at whitespace that is itself top-level. Returns
// `undefined` word when nothing top-level remains from `start` onward.
function leadingWordAt(s: string, info: ScanInfo, start: number): { word: string | undefined; end: number } {
  const isTop = (i: number) => (info.ok ? info.topLevel[i] === true : true); // defensive fallback: plain whitespace split if the fragment itself is malformed
  let i = start;
  while (i < s.length && isTop(i) && /\s/.test(s[i]!)) i++;
  if (i >= s.length) return { word: undefined, end: i };
  const wordStart = i;
  while (i < s.length && !(isTop(i) && /\s/.test(s[i]!))) i++;
  return { word: s.slice(wordStart, i), end: i };
}

// Single-shot convenience wrapper for a caller that reads AT MOST one or two words and never loops
// (isRecognizedReadOnly's own two call sites, below) -- scans once, reads once. Byte-identical
// public contract to the pre-fix-wave `leadingWord` this replaces; a looping caller should use
// `leadingWordAt` directly against one shared, precomputed ScanInfo instead of this wrapper.
// N4 (fix wave, P3 close-out): exported -- bash.ts's own `extractBashPaths` cd-tracking used a
// quote-UNAWARE regex (`/^cd\s+(\S+)/`) instead of this scanner, so `cd "my dir" && echo x > f`
// mis-based `f` (the regex's own `\S+` stops at the first whitespace, even inside quotes). This is
// the exact "single word, no loop" shape this wrapper was built for -- reused, not duplicated.
export function leadingWord(s: string): { word: string | undefined; afterWord: string } {
  const { word, end } = leadingWordAt(s, scanShellLike(s), 0);
  return { word, afterWord: s.slice(end) };
}

// ---------------------------------------------------------------------------------------------
// Line continuations
// ---------------------------------------------------------------------------------------------

/**
 * Joins backslash-newline continuations the way bash does before it parses: an ODD run of
 * backslashes before a newline ends in a continuation (the last backslash and the newline vanish);
 * an even run is escaped backslashes followed by a real newline. Without this, `echo x >
 * \<newline>.git/config` read its target as `\<newline>.git/config` -- a name with no `.git`
 * segment -- while bash wrote `.git/config` (claude joins them before its own redirect scan).
 */
export function joinLineContinuations(command: string): string {
  if (!command.includes("\\\n")) return command;
  return command.replace(/\\+\n/g, (run) => {
    const backslashes = run.length - 1;
    return backslashes % 2 === 1 ? "\\".repeat(backslashes - 1) : run;
  });
}

// ---------------------------------------------------------------------------------------------
// splitCompound
// ---------------------------------------------------------------------------------------------

export function splitCompound(rawCommand: string): string[] | null {
  const command = joinLineContinuations(rawCommand);
  const info = scanIfParseable(command);
  if (!info) return null;
  const { topLevel } = info;

  const parts: string[] = [];
  let segStart = 0;
  let i = 0;
  while (i < command.length) {
    if (!topLevel[i]) {
      i++;
      continue;
    }
    // `>|` is the noclobber-overriding REDIRECT, not a pipe: `echo x >| .git/config` is one command
    // writing `.git/config`, never `echo x >` piped into a command named `.git/config`.
    if (command[i] === "|" && i > 0 && topLevel[i - 1] && command[i - 1] === ">") {
      i++;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") {
      parts.push(command.slice(segStart, i));
      i += 2;
      segStart = i;
      continue;
    }
    if (two === "&>") {
      // redirect-both-streams -- NOT the background operator; pass both characters through.
      i += 2;
      continue;
    }
    const ch = command[i]!;
    if (ch === "&") {
      // A `&` immediately after `>` is the second half of a `>&` dup-redirect (e.g. `2>&1`), not
      // the background operator -- `>` itself is ordinary/unspecial to this function, so by the
      // time we reach this `&` the `>` has already been walked over as plain text.
      if (command[i - 1] === ">") {
        i++;
        continue;
      }
      parts.push(command.slice(segStart, i));
      i += 1;
      segStart = i;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      parts.push(command.slice(segStart, i));
      i += 1;
      segStart = i;
      continue;
    }
    i++;
  }
  parts.push(command.slice(segStart));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------------------------
// stripWrappers
// ---------------------------------------------------------------------------------------------

function isSafeAssignmentValue(value: string): boolean {
  // "known-safe" (allow-direction) leading assignments: a plain literal/quoted literal with no
  // command execution or expansion hiding inside it. Anything with command substitution or
  // parameter/arithmetic expansion could make the ACTUAL executed text differ from what an allow
  // rule's glob was written against, so it is not safe to look through when deciding whether an
  // ALLOW rule applies.
  return !/\$\(|`|\$\{/.test(value);
}

// P2 fix-wave item 2: threaded sibling of stripLeadingAssignments (below) -- operates on `s`/`info`
// (the SAME string and precomputed scan stripWrappers' own loop shares across every wrapper/
// assignment/flag it strips) starting at `start`, returning the new offset rather than a sliced
// string. A STICKY (non-global, `y` flag) regex anchors the assignment-name match at exactly
// `start` without a fresh `.slice(pos)` allocation on every iteration, closing the identical rescan
// shape one level down (many chained leading assignments, e.g. "A=1 B=2 C=3 ... cmd").
const ASSIGNMENT_NAME_RE = /[A-Za-z_][A-Za-z0-9_]*=/y;
function stripLeadingAssignmentsAt(s: string, info: ScanInfo, start: number, direction: "allow" | "denyAsk"): number {
  const isTop = (i: number) => (info.ok ? info.topLevel[i] === true : true);
  let pos = start;
  for (;;) {
    while (pos < s.length && isTop(pos) && /\s/.test(s[pos]!)) pos++;
    if (pos >= s.length || !isTop(pos)) break;
    ASSIGNMENT_NAME_RE.lastIndex = pos;
    const nameMatch = ASSIGNMENT_NAME_RE.exec(s);
    if (!nameMatch) break;
    const name = nameMatch[0]!.slice(0, -1); // strip the trailing "="
    const eqEnd = pos + nameMatch[0]!.length;
    let vEnd = eqEnd;
    while (vEnd < s.length && !(isTop(vEnd) && /\s/.test(s[vEnd]!))) vEnd++;
    const value = s.slice(eqEnd, vEnd);
    // Fix round 1, Finding B / Ruling P2-C: a dangerous NAME is un-strippable on allow regardless
    // of its value's syntax; stop BEFORE this assignment either way, leaving it and everything
    // after it intact (denyAsk is unaffected -- it never reaches this branch at all).
    if (direction !== "denyAsk" && (DANGEROUS_ASSIGNMENT_NAMES.has(name) || !isSafeAssignmentValue(value))) break;
    pos = vEnd;
  }
  return pos;
}

export function stripWrappers(rawCmd: string, direction: "allow" | "denyAsk"): string {
  const cmd = joinLineContinuations(rawCmd);
  // P2 fix-wave item 2: ONE scan for this whole call, threaded through every helper below via a
  // plain integer offset into this SAME, unchanging `cmd` string -- never a re-scan of a
  // progressively-sliced substring (see leadingWordAt/stripLeadingAssignmentsAt's own headers for
  // the O(n^2) shape this closes).
  const info = scanShellLike(cmd);
  let pos = 0;
  for (;;) {
    pos = stripLeadingAssignmentsAt(cmd, info, pos, direction);
    const { word: rawWord, end: afterWordEnd } = leadingWordAt(cmd, info, pos);
    if (rawWord === undefined) return cmd.slice(pos);
    // After quote removal, as bash sees it: `'timeout' 5 rm -rf ~` runs `rm` under `timeout`.
    const word = dequoteShellWord(rawWord);

    if (word === XARGS) {
      const { word: next } = leadingWordAt(cmd, info, afterWordEnd);
      if (next !== undefined && next.startsWith("-")) return cmd.slice(pos); // not flag-free -- stop stripping
      pos = afterWordEnd;
      continue;
    }

    if (!FIXED_WRAPPERS.has(word)) return cmd.slice(pos);

    let remainderPos = afterWordEnd;
    for (;;) {
      const { word: flag, end: afterFlagEnd } = leadingWordAt(cmd, info, remainderPos);
      if (flag === undefined || !flag.startsWith("-")) break;
      remainderPos = afterFlagEnd;
    }
    if (WRAPPERS_WITH_POSITIONAL_ARG.has(word)) {
      const { word: posArg, end: afterPosEnd } = leadingWordAt(cmd, info, remainderPos);
      if (posArg !== undefined && !posArg.startsWith("-")) remainderPos = afterPosEnd;
    }
    pos = remainderPos;
  }
}

// ---------------------------------------------------------------------------------------------
// extractRedirectTargets
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Shell words: bash's quote removal, the ONE implementation every path is derived through
// ---------------------------------------------------------------------------------------------
//
// bash removes EVERY quote and backslash inside a word, not a pair around the whole of it: `'.git'/config`,
// `.g"i"t/config`, `.\git/config`, `''.git/config` and `.git''/config` all name `.git/config`. A path
// derived any other way can name a different file than the one bash writes, and the protected floor,
// the deny rules and the working-directory check then judge the wrong file.

/** One word of a command: its text after quote removal, as written, and whether any of it was quoted. */
export interface ShellWord {
  word: string;
  raw: string;
  quoted: boolean;
}

const ANSI_C_SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Decodes the escape at `s[i]` (just after a backslash) inside `$'…'`; returns the text and the next index. */
function decodeAnsiCEscape(s: string, i: number): { text: string; next: number } {
  const ch = s[i];
  if (ch === undefined) return { text: "\\", next: i };
  const simple = ANSI_C_SIMPLE_ESCAPES[ch];
  if (simple !== undefined) return { text: simple, next: i + 1 };
  const numeric = (pattern: RegExp, radix: number): { text: string; next: number } | undefined => {
    const m = pattern.exec(s.slice(i + 1));
    if (m === null || m[0].length === 0) return undefined;
    return { text: String.fromCodePoint(Number.parseInt(m[0], radix) % 0x110000), next: i + 1 + m[0].length };
  };
  if (ch === "x") return numeric(/^[0-9a-fA-F]{1,2}/, 16) ?? { text: "\\x", next: i + 1 };
  if (ch === "u") return numeric(/^[0-9a-fA-F]{1,4}/, 16) ?? { text: "\\u", next: i + 1 };
  if (ch === "U") return numeric(/^[0-9a-fA-F]{1,8}/, 16) ?? { text: "\\U", next: i + 1 };
  if (/[0-7]/.test(ch)) {
    const m = /^[0-7]{1,3}/.exec(s.slice(i))!;
    return { text: String.fromCharCode(Number.parseInt(m[0], 8) & 0xff), next: i + m[0].length };
  }
  if (ch === "c" && s[i + 1] !== undefined) return { text: String.fromCharCode(s.charCodeAt(i + 1) & 0x1f), next: i + 2 };
  return { text: `\\${ch}`, next: i + 1 };
}

/**
 * bash's quote removal (and, with `split`, its word splitting at unquoted blanks) over one command's
 * text: single quotes, double quotes (a backslash there drops -- stricter than bash, which keeps it
 * before an ordinary character, and never naming a DIFFERENT protected file), backslash escapes,
 * ANSI-C `$'…'` (decoded) and locale `$"…"` (as double quotes). Expansions are left as written. An
 * unterminated quote runs to the end.
 */
export function shellWords(s: string, split = true): ShellWord[] {
  const words: ShellWord[] = [];
  let cur = "";
  let start = -1;
  let quoted = false;
  let quote: '"' | "'" | "$'" | null = null;
  const end = (i: number): void => {
    if (start !== -1) words.push({ word: cur, raw: s.slice(start, i), quoted });
    cur = "";
    start = -1;
    quoted = false;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      i++;
      continue;
    }
    if (quote === "$'") {
      if (ch === "'") {
        quote = null;
        i++;
      } else if (ch === "\\") {
        const decoded = decodeAnsiCEscape(s, i + 1);
        cur += decoded.text;
        i = decoded.next;
      } else {
        cur += ch;
        i++;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < s.length) {
        if (s[i + 1] !== "\n") cur += s[i + 1];
        i++;
      } else cur += ch;
      i++;
      continue;
    }
    if (split && /\s/.test(ch)) {
      end(i);
      i++;
      continue;
    }
    if (start === -1) start = i;
    if (ch === "\\") {
      quoted = true;
      if (i + 1 < s.length && s[i + 1] !== "\n") cur += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === "$" && (s[i + 1] === "'" || s[i + 1] === '"')) {
      quote = s[i + 1] === "'" ? "$'" : '"';
      quoted = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  end(s.length);
  return words;
}

/** `word` after bash's quote removal, as ONE word (blanks inside it are kept). */
export function dequoteShellWord(word: string): string {
  return shellWords(word, false)[0]?.word ?? "";
}

/** One file-writing redirection: the target word as written (`raw`) and after bash's quote removal. */
export interface RedirectWrite {
  raw: string;
  target: string;
}

const REDIRECT_WORD_STOP = /[\s;&|<>()]/;

/** The word starting at `start` (after blanks), ended by top-level whitespace or an operator char. */
function redirectWordAt(s: string, info: ScanInfo, start: number): { word: string | undefined; end: number } {
  let i = start;
  while (i < s.length && info.topLevel[i] === true && (s[i] === " " || s[i] === "\t")) i++;
  const wordStart = i;
  while (i < s.length && !(info.topLevel[i] === true && REDIRECT_WORD_STOP.test(s[i]!))) i++;
  return { word: i > wordStart ? s.slice(wordStart, i) : undefined, end: i };
}

/**
 * Every FILE-writing redirection at the top level of one (sub)command -- the operators bash writes a
 * file through: `>`, `>>`, `>|` (noclobber override), `&>`, `&>>`, `<>` (read-write open), any of them
 * fd-prefixed (`2>`), and `>&word` / `N>&word` whose word is NOT a descriptor (`>&file` is the old
 * spelling of `&>file`; `2>&1`, `>&2`, `>&-` stay descriptor copies). `<<`/`<<<` feed input and
 * `>(`/`<(` are process substitutions -- neither is a file target (the permission layer asks for a
 * process substitution separately). Bash runs without history expansion here, so a target that
 * begins with `!` is ALSO read with the `!` removed (zsh's `>!` clobber), which only adds a path.
 *
 * An unparseable command yields `[]` here; every security caller asks for such a command on its own
 * (`shellWriteConstraint`), because a scan it could not complete proves nothing about its writes.
 */
export function extractRedirectWrites(rawCommand: string): RedirectWrite[] {
  const command = joinLineContinuations(rawCommand);
  const info = scanShellLike(command);
  if (!info.ok) return [];
  const { topLevel } = info;

  const writes: RedirectWrite[] = [];
  const push = (raw: string): void => {
    writes.push({ raw, target: dequoteShellWord(raw) });
    if (raw.length > 1 && raw.startsWith("!")) writes.push({ raw: raw.slice(1), target: dequoteShellWord(raw.slice(1)) });
  };
  let i = 0;
  while (i < command.length) {
    if (!topLevel[i]) {
      i++;
      continue;
    }
    if (command.startsWith("<<", i)) {
      // here-doc / here-string -- input, never a file write (WS-07 §3).
      i += command[i + 2] === "<" ? 3 : 2;
      continue;
    }
    // An fd prefix (`2>`, `10>>`) is a digit run directly before the operator.
    let k = i;
    while (k < command.length && topLevel[k] && /[0-9]/.test(command[k]!)) k++;
    let opEnd = -1;
    let descriptorCopy = false;
    if (command[i] === "&" && command[i + 1] === ">") {
      opEnd = command[i + 2] === ">" ? i + 3 : i + 2; // &>> / &>
    } else if (command[k] === "<" && command[k + 1] === ">") {
      opEnd = k + 2; // <> opens for writing
    } else if (command[k] === ">") {
      const next = command[k + 1];
      if (next === "(") {
        i = k + 1; // `>(`: a process substitution, not a file
        continue;
      }
      if (next === ">") opEnd = k + 2;
      else if (next === "|") opEnd = k + 2;
      else if (next === "&") {
        opEnd = k + 2;
        descriptorCopy = true;
      } else opEnd = k + 1;
    } else {
      i = k > i ? k : i + 1;
      continue;
    }

    const { word, end } = redirectWordAt(command, info, opEnd);
    if (word === undefined) {
      i = opEnd;
      continue;
    }
    if (!(descriptorCopy && /^(?:[0-9]+|-)$/.test(dequoteShellWord(word)))) push(word);
    i = end;
  }
  return writes;
}

/** `extractRedirectWrites`, target paths only (quotes removed). */
export function extractRedirectTargets(command: string): string[] {
  return extractRedirectWrites(command).map((w) => w.target);
}

// ---------------------------------------------------------------------------------------------
// isRecognizedReadOnly
// ---------------------------------------------------------------------------------------------

export function isRecognizedReadOnly(command: string): boolean {
  // Fix round 1, Finding A: WS-07 §3's read-only bullet ends with the SAME fallback clause as the
  // write-capable-flags one -- "unparseable commands, commands over the parser limit... fall back
  // to permission handling". Without this gate, an unterminated quote (or an over-limit input)
  // makes `stripLeadingAssignments`/`leadingWord` fall back to a naive whitespace split (their own
  // defensive "malformed fragment" behavior), which can extract a recognized-looking leading word
  // from text this function can't actually confidently analyze -- e.g.
  // `cat 'foo && rm -rf /` (unterminated quote) previously returned true. Must run before any
  // wrapper-stripping is attempted.
  if (!scanIfParseable(command)) return false;

  // Judgment call: this function's signature (per the brief) has no `direction` parameter, so
  // wrapper-stripping needs one internal choice. "allow" (the narrow/safe-only stripping) is used
  // because read-only recognition is itself an allow-shaped decision (WS-07 §6.1: pre-approve
  // without prompting) -- a command dressed up behind a suspicious `$(...)` assignment should NOT
  // be recognized as safely read-only just because denyAsk-style stripping would see through it.
  const stripped = stripWrappers(command, "allow");

  // WS-07 §3: redirects are a separately-checked file write; a recognized-read-only command with
  // one isn't actually read-only in effect (advisor-confirmed fix over an earlier draft).
  if (extractRedirectTargets(stripped).length > 0) return false;

  const { word: first, afterWord } = leadingWord(stripped);
  if (first === undefined) return false;

  // The flags are checked on the arguments AFTER quote removal too: `find . '-exec' …` and
  // `rg "--pre" …` pass exactly those flags to the program.
  const dequotedArgs = shellWords(afterWord).map((w) => w.word).join(" ");
  const hasFlag = (pattern: RegExp): boolean => pattern.test(afterWord) || pattern.test(dequotedArgs);

  if (first === "git") {
    const { word: sub } = leadingWord(afterWord);
    return sub !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(sub) && !hasFlag(GIT_WRITE_CAPABLE_FLAGS);
  }

  if (!READ_ONLY_COMMANDS.has(first)) return false;
  const flagPattern = WRITE_CAPABLE_FLAGS[first];
  if (flagPattern && hasFlag(flagPattern)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Glob/prefix pattern compiler (WS-07 §3's general `*` / trailing `:*` rule)
// ---------------------------------------------------------------------------------------------

// Exported (WS-21 fix round 9): claude's own `Tu(t){return t.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}`
// (dump-confirmed, byte offset 11028957 of the pinned 2.1.250 dump) is the IDENTICAL regex --
// `commands/resolver.ts`'s own port of claude's `zE` (the full `$ARGUMENTS`/named-arg substituter)
// reuses this one implementation rather than duplicating it, since both are literally the same
// function serving the same "safely embed a literal name inside a dynamically-built RegExp" need.
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExpSource(pattern: string): string {
  return pattern.split("*").map(escapeRegExpLiteral).join(".*");
}

// WS-07 §3: "`*` matches any text including spaces"; "`:*` is the trailing-wildcard spelling:
// `Bash(ls:*)` === `Bash(ls *)`". A trailing " *" (real space + star) or ":*" sugar means "this
// prefix, optionally followed by more" -- which must ALSO match the bare prefix with nothing
// following at all (`Bash(ls *)` matches bare `ls`, not just `ls <something>`). A `*` anywhere
// else is a plain wildcard with no such "optional separator" allowance.
function compilePattern(pattern: string, opts?: { caseInsensitive?: boolean }): RegExp {
  const flags = "s" + (opts?.caseInsensitive ? "i" : "");
  let s = pattern;
  if (s.endsWith(":*")) s = s.slice(0, -2) + " *";
  if (s.endsWith(" *")) {
    const base = s.slice(0, -2);
    return new RegExp(`^${globToRegExpSource(base)}(?: .*)?$`, flags);
  }
  return new RegExp(`^${globToRegExpSource(s)}$`, flags);
}

// ---------------------------------------------------------------------------------------------
// parseRule
// ---------------------------------------------------------------------------------------------

function parseScalar(token: string): string | boolean {
  if (token === "true") return true;
  if (token === "false") return false;
  return token;
}

/** The one built-in whose rules are bare-name only -- see `parseRule`'s own branch for why a scoped one is `invalid`. */
const WEB_SEARCH_RULE_TOOL = "WebSearch";

// ---------------------------------------------------------------------------------------------
// WebFetch: the hostname a `domain:` rule is matched against
// ---------------------------------------------------------------------------------------------
//
// A real WebFetch call is `{url, prompt}`. It carries NO `domain` field, so the rule's content has to
// be compared against something DERIVED from `url` -- the reference runtime derives it the same way
// (`domain:${new URL(url).hostname}`). Everything in the permission layer that needs the call's
// target (the `domain:` matcher below, and the evaluator's preapproved-host and private-address
// checks) goes through these two helpers, so there is exactly one parse and one normalisation.

/** The call's `url` as a parsed `URL`, or `undefined` when it is absent, not a string, or unparseable. NEVER throws. */
export function webFetchUrlOf(input: Record<string, unknown>): URL | undefined {
  const raw = input["url"];
  if (typeof raw !== "string") return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** One trailing dot (the DNS root) names the same host, so it must never distinguish a rule from a call. */
function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * A rule's hostname, brought to the SAME canonical form the URL parser gives the call's: lowercase,
 * punycoded (`münchen.de` -> `xn--mnchen-3ya.de`), IPv4 shorthand expanded, one trailing dot
 * dropped. A glob is only lowercased -- it is not a hostname and the URL parser would reject it.
 *
 * Canonicalised ONLY when the text is nothing but a host: `domain:example.com/docs` or
 * `domain:example.com:8080` would otherwise be quietly rewritten to `example.com`, turning a rule
 * that names something this grammar cannot express into a working rule for the whole host. Such a
 * source is left as written, where it matches no hostname at all.
 */
function normalizeRuleHostname(source: string): string {
  const lowered = stripTrailingDot(source.trim().toLowerCase());
  if (lowered === "" || lowered.includes("*")) return lowered;
  // A port is "more than a host" too, and the URL parser would DROP a scheme-default one silently
  // (`example.com:80` round-trips to `example.com`), so it is caught here rather than by the
  // round-trip check below. An IPv6 literal's colons are inside its brackets and are part of the host.
  if (lowered.replace(/^\[[^\]]*\]/, "").includes(":")) return lowered;
  try {
    const parsed = new URL(`http://${lowered}/`);
    if (parsed.href === `http://${parsed.hostname}/`) return stripTrailingDot(parsed.hostname);
  } catch {
    // not a parseable host -- left as written
  }
  return lowered;
}

/**
 * The hostname a `WebFetch(domain:...)` rule is compared against: `new URL(url).hostname`, lowercase
 * (the URL parser already lowercases and punycodes it), minus one trailing dot.
 *
 * `undefined` -- which matches NO domain rule, on either direction -- for an absent/unparseable `url`
 * and for a URL with an EMPTY host (`file:///etc/passwd`, `data:`): `domain:*` compiles to a pattern
 * that matches the empty string, so without this an allow rule written for "any website" would
 * pre-approve a URL that names no website at all.
 *
 * The trailing dot is stripped on BOTH sides (here and at parse) because `https://example.com./` is
 * the same host as `https://example.com/` and the URL parser keeps the dot: an exact compare would
 * let that spelling walk past a deny rule.
 */
export function webFetchHostnameOf(input: Record<string, unknown>): string | undefined {
  const url = webFetchUrlOf(input);
  if (url === undefined) return undefined;
  const hostname = stripTrailingDot(url.hostname.toLowerCase());
  return hostname === "" ? undefined : hostname;
}

/**
 * True when `rule` is a `WebFetch(domain:<host>)` rule that names `hostname` EXACTLY -- no `*`
 * anywhere in it. This is what the evaluator means by "a rule naming that host": a glob
 * (`domain:*`, `domain:*.corp`) matches a host without ever having named it, so it can allow a fetch
 * but can never stand in for the user's consent to one specific address.
 */
export function isExactWebFetchDomainRule(rule: ParsedRule, hostname: string): boolean {
  if (rule.toolName !== "WebFetch" || rule.specifier?.kind !== "webFetchDomain") return false;
  return !rule.specifier.source.includes("*") && rule.specifier.source === hostname;
}

/** The one tool whose specifier is a skill identity + argument prefix (WS-07 §3). */
const SKILL_RULE_TOOL = "Skill";

const FIELD_VALUE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/s;

// Fix round 8 (a rule-content parity item found by the integration run on both real binaries):
// claude's `Tool(content)` extraction and unescape, ported exactly from the pinned 2.1.250 dump.
// This SUPERSEDES the plain greedy regex this module used to use (`/^([^\s(]+)\((.*)\)$/s`), which
// found the specifier boundary correctly for an UNESCAPED literal paren (a real directory named
// "Project (old)" already worked) but never unescaped the captured content at all -- so a rule
// authored (or, cross-leg, PERSISTED BY CLAUDE ITSELF) with claude's own escaped spelling required
// a literal backslash where claude requires two, and misread an escaped `\)` mid-content as
// ordinary text rather than the literal `)` it denotes.
//
// The exact grammar (dump-confirmed, byte offset ~11910950 of the pinned 2.1.250 dump):
//   function l(e,r){for(let t=0;t<e.length;t++)if(e[t]===r){let n=0,s=t-1;while(s>=0&&e[s]==="\\")n++,s--;if(n%2===0)return t}return-1}
//   function u(e,r){for(let t=e.length-1;t>=0;t--)if(e[t]===r){let n=0,s=t-1;while(s>=0&&e[s]==="\\")n++,s--;if(n%2===0)return t}return-1}
//   function a(e){return e.replaceAll("\\(","(").replaceAll("\\)",")").replaceAll("\\\\","\\")}
//   function jr(e){
//     let r=l(e,"(");
//     if(r===-1)return{toolName:vd(e)};
//     let t=u(e,")");
//     if(t===-1||t<=r)return{toolName:vd(e)};
//     if(t!==e.length-1)return{toolName:vd(e)};
//     let n=e.substring(0,r),s=e.substring(r+1,t);
//     if(!n)return{toolName:vd(e)};
//     if(s===""||s==="*")return{toolName:vd(n)};
//     let o=a(s);
//     return{toolName:vd(n),ruleContent:o}
//   }
// `l`/`u` are an ESCAPE-AWARE first/last-index-of: an occurrence of `r` at position `t` counts only
// when it is preceded by an EVEN run of backslashes (an odd run means IT is the one being escaped).
// `jr` requires the last unescaped ")" to be the string's literal final character (a "stray text
// after the close" shape falls back to the whole string as a bare tool name, same posture this
// module already had); `a` then runs, ONCE, as three SEQUENTIAL passes in this exact order -- `\(`
// -> `(`, then `\)` -> `)`, then `\\` -> `\` -- before any specifier-family parsing ever sees the
// content. The write side (`Fr`/`c`, same dump region) is the exact inverse, applied in the
// opposite order: `c(e)` escapes `\` -> `\\` first, then `(` -> `\(`, then `)` -> `\)` -- so a rule
// claude itself persists for a path with a literal backslash or literal parens is written
// pre-escaped this way, and this module must read it back identically or silently fail to match a
// rule the other leg wrote, in a shared home this whole workstream exists to make behave as one.
//
// `vd` (claude's tool-name-alias table, e.g. `KillShell`->`TaskStop`) is Winter's OWN separate
// concern and out of scope here -- Winter's toolName is used as authored, unaliased.
//
// ONE DELIBERATE NARROWING, disclosed: `jr` places no shape restriction on the toolName half at all
// (an embedded space is accepted verbatim, e.g. "Read foo(bar)" parses with toolName "Read foo").
// This module keeps its own pre-existing, narrower guard -- a toolName containing whitespace falls
// back to the bare-tool-name treatment, exactly as the superseded regex already gave it (that
// regex's own `[^\s(]+` never matched a space either) -- because every downstream toolName
// comparison in this codebase assumes an exact, whitespace-free name, and no fixture past or present
// needs a whitespace-bearing one to parse as anything else.
function isEscapedAt(s: string, t: number): boolean {
  let backslashes = 0;
  let i = t - 1;
  while (i >= 0 && s[i] === "\\") {
    backslashes++;
    i--;
  }
  return backslashes % 2 !== 0;
}

/** claude's `l` -- the first UNESCAPED occurrence of `ch` in `s`, or -1. */
function firstUnescaped(s: string, ch: string): number {
  for (let t = 0; t < s.length; t++) if (s[t] === ch && !isEscapedAt(s, t)) return t;
  return -1;
}

/** claude's `u` -- the LAST UNESCAPED occurrence of `ch` in `s`, or -1. */
function lastUnescaped(s: string, ch: string): number {
  for (let t = s.length - 1; t >= 0; t--) if (s[t] === ch && !isEscapedAt(s, t)) return t;
  return -1;
}

/** claude's `a` -- the Tool(content) parse-side unescape, run once, in this exact sequential order. */
function unescapeRuleContent(raw: string): string {
  return raw.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\");
}

export function parseRule(raw: string): ParsedRule {
  const trimmed = raw.trim();
  const bareFallback = (): ParsedRule => ({ toolName: trimmed, isBareEquivalent: true });

  const openIdx = firstUnescaped(trimmed, "(");
  if (openIdx === -1) return bareFallback();
  const toolName = trimmed.slice(0, openIdx);
  if (toolName === "" || /\s/.test(toolName)) return bareFallback();
  const closeIdx = lastUnescaped(trimmed, ")");
  // Also refuses stray trailing text after the real close (`closeIdx !== trimmed.length - 1`) --
  // an unusual input no fixture exercises; treating the whole string as a literal bare tool name is
  // a safe, inert failure mode since it won't equal any real toolName.
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== trimmed.length - 1) return bareFallback();

  const rawContent = trimmed.slice(openIdx + 1, closeIdx);
  // `jr` itself treats an EMPTY parenthetical (`s===""`) exactly like `s==="*"` -- both collapse to
  // a bare rule with no specifier at all.
  //
  // Fix round 9 (full parity, superseding round 8's disclosed non-port): round 8 deliberately kept
  // this shortcut scoped to `*` alone, to avoid silently overriding Winter's own pre-existing
  // `WebSearch()`-is-`invalid` ruling. The controller's round-9 ruling reverses that: FULL parity --
  // fold every `Tool()` to bare, `WebSearch()` and `mcp__s__x()` included, because under WS-21 both
  // legs read the SAME `settings.json`, so a deny `Bash()`/`Read()` that blocks the whole tool on
  // claude and does NOTHING on Winter (round 8's own gap, since an unmatched `content:""` pattern
  // specifier never matches anything) is a fail-open divergence in a shared home, which outranks the
  // narrower WebSearch design goal. This one shortcut check already runs BEFORE the `mcp__` branch
  // below, so folding `""` in here also covers `mcp__s__x()` for free, with no separate edit there.
  if (rawContent === "" || rawContent === "*") {
    return { toolName, specifier: { kind: "wildcardAll" }, isBareEquivalent: true };
  }
  const content = unescapeRuleContent(rawContent);

  if (toolName.startsWith("mcp__")) {
    // WS-07 §3: "parenthetical parameter rules in settings are rejected" for MCP tools -- the
    // server/tool glob lives entirely in the tool-name string; see the `invalid` type comment
    // above for why this parses successfully rather than throwing.
    return {
      toolName,
      specifier: {
        kind: "invalid",
        reason: "MCP tools reject parenthetical specifiers (WS-07 §3); use a mcp__server__tool name or glob directly",
      },
      isBareEquivalent: false,
    };
  }

  // NOTE: the `rawContent === "*"` shortcut above already returns before `content` is ever computed,
  // and `unescapeRuleContent` cannot itself PRODUCE a bare "*" from something that wasn't already
  // exactly "*" (it only ever touches `\(`, `\)`, `\\`) -- so a second `content === "*"` check here
  // would be unreachable dead code, not a second real case. Removed rather than kept as a no-op.

  if (toolName === "WebFetch") {
    const wf = /^domain:(.*)$/is.exec(content);
    if (wf) {
      return { toolName, specifier: { kind: "webFetchDomain", source: normalizeRuleHostname(wf[1]!) }, isBareEquivalent: false };
    }
    // No other WebFetch specifier grammar is documented; fall back to the generic pattern family
    // for forward compatibility rather than throwing (matches nothing useful today -- see
    // matchesRule's "pattern" case, which fails closed for tools with no known primary field).
    return { toolName, specifier: { kind: "pattern", source: content }, isBareEquivalent: false };
  }

  if (toolName === WEB_SEARCH_RULE_TOOL) {
    // `WebSearch` HAS NO SPECIFIER GRAMMAR. The reference runtime's own permission check for it is a
    // plain passthrough whose only suggested rule is the bare tool name -- there is no content form a
    // scoped rule could be matched against. Left to the generic dispatch below, `WebSearch(query:x)`
    // would parse as a `param` rule and really match a deny/ask for that one literal query string: a
    // Winter-only behaviour that a user could mistake for a working filter, and that a one-word
    // rephrase of the query walks straight past. And `WebSearch(anything else)` would parse as a
    // `pattern` rule that silently never matches -- a deny that denies nothing.
    //
    // Both are closed the same way the MCP parenthetical is: `invalid`, which `ruleset.ts`'s
    // `validateNewRule` REJECTS at load (loud, naming the rule) and which `matchesRule` treats as
    // never-matching on either direction if one ever slips past that gate. `WebSearch(*)` never
    // reaches here -- the `*` check above already made it bare-equivalent.
    return {
      toolName,
      specifier: { kind: "invalid", reason: "WebSearch has no specifier grammar -- use the bare tool name `WebSearch`" },
      isBareEquivalent: false,
    };
  }

  if (toolName === "Bash") {
    // Bash's OWN primary grammar is the command-glob string, which can legitimately contain
    // colons (e.g. a URL with a port) -- only a field in BASH_PARAM_FIELDS is treated as a param
    // rule; everything else (including the ":*" prefix-sugar) is the pattern family.
    const bashParam = FIELD_VALUE.exec(content);
    if (bashParam && BASH_PARAM_FIELDS.has(bashParam[1]!)) {
      return {
        toolName,
        specifier: { kind: "param", field: bashParam[1]!, value: parseScalar(bashParam[2]!) },
        isBareEquivalent: false,
      };
    }
    return { toolName, specifier: { kind: "pattern", source: content }, isBareEquivalent: false };
  }

  // Phase 5 Task 8 (rider 18, WS-07 §3 "skill name and argument prefix"): a `Skill(...)` rule's
  // specifier is a skill identity plus an optional argument pattern -- ONE class, always, exactly as
  // Bash's and the file tools' are.
  //
  // WITHOUT THIS EARLY RETURN THE SAME RULE SHAPE PARSED THREE DIFFERENT WAYS depending on the
  // skill's NAME, because the generic `FIELD_VALUE` dispatch below splits on `[A-Za-z_][A-Za-z0-9_]*:`:
  //   `Skill(review:*)`         -> `param`   (and an allow-direction param rule never matches)
  //   `Skill(my-skill:*)`       -> `pattern` (the hyphen fails the field regex)
  //   `Skill(.winter:review)`   -> `pattern` (the leading dot fails it)
  // So a user's rule worked or silently did not according to whether their skill's name contained a
  // hyphen -- the failure mode P5-H's companion clause names ("a hyphen in the skill name must never
  // change the rule's class"). `source` is the RAW inner text; `skills/permission-rules.ts` owns
  // splitting it into name + argument prefix, because only it knows the real identity set (a
  // qualified name contains a colon and no left-to-right parse can tell it from an argument
  // separator without knowing the names).
  if (toolName === SKILL_RULE_TOOL) {
    return { toolName, specifier: { kind: "pattern", source: content }, isBareEquivalent: false };
  }

  if (FILE_RULE_TOOLS.has(toolName)) {
    // Ruling P2-G: a file-rule tool's specifier is a file pattern, full stop -- never attempt the
    // generic field:value param parse below. A colon here is part of the path (a drive letter, or
    // any other legitimate path character), never a param-rule separator. `content` is passed
    // through untouched; Task 4/5's evaluator reads it back off `specifier.source` for
    // matchFileRule, never through this module's own matchesRule (which has no file-glob logic).
    return { toolName, specifier: { kind: "pattern", source: content }, isBareEquivalent: false };
  }

  // Generic params dispatch (WS-07 §3: "top-level scalar rules such as Agent(model:opus)... one
  // field per rule"). Not scoped out here to Bash's allowlist trick since other tools don't share
  // Bash's "primary grammar can itself contain colons" problem. File-rule tools (Read/Edit) never
  // reach this branch -- see the FILE_RULE_TOOLS check immediately above.
  const generic = FIELD_VALUE.exec(content);
  if (generic) {
    return {
      toolName,
      specifier: { kind: "param", field: generic[1]!, value: parseScalar(generic[2]!) },
      isBareEquivalent: false,
    };
  }

  // Bare literal / unrecognized content on some other tool (e.g. a hypothetical `Agent(Explore)`
  // definition-selector -- WS-07 §3 calls this "a different specifier family" from param rules but
  // does not pin what call-input field it matches against for any tool, and no downstream task
  // brief (4/5/6/7/12) needs that resolved here; that's WS-06 tool-catalog territory). Modeled as
  // the generic pattern family; matchesRule's "pattern" case matches against `input.command`,
  // which a non-Bash tool won't have, so this fails closed (never matches) rather than guessing at
  // an unpinned field name.
  return { toolName, specifier: { kind: "pattern", source: content }, isBareEquivalent: false };
}

// ---------------------------------------------------------------------------------------------
// matchesRule
// ---------------------------------------------------------------------------------------------

function isAnchoredMcpAllowGlob(name: string): boolean {
  const starIdx = name.indexOf("*");
  const prefix = starIdx === -1 ? name : name.slice(0, starIdx);
  const rest = prefix.slice("mcp__".length);
  // A complete "mcp__<server>__" boundary must be literal (present) before any wildcard --
  // `mcp__*` (rest="") fails; `mcp__github__get_*` and `mcp__github__*` (rest contains "__") pass.
  return rest.includes("__");
}

function toolNameMatches(ruleToolName: string, callToolName: string, direction: "allow" | "denyAsk"): boolean {
  if (!ruleToolName.includes("*")) return ruleToolName === callToolName;
  if (ruleToolName.startsWith("mcp__") && direction === "allow" && !isAnchoredMcpAllowGlob(ruleToolName)) {
    // WS-07 §3: "allow globs require literal server prefix... mcp__* allow REJECTED". Match-time
    // (direction-conditional) invalidity, not a parse-time error -- see the Specifier comment.
    return false;
  }
  return compilePattern(ruleToolName).test(callToolName);
}

export function matchesRule(
  rule: ParsedRule,
  call: { toolName: string; input: Record<string, unknown> },
  opts: { direction: "allow" | "denyAsk" },
): boolean {
  if (!toolNameMatches(rule.toolName, call.toolName, opts.direction)) return false;
  if (rule.specifier === undefined) return true;

  switch (rule.specifier.kind) {
    case "wildcardAll":
      return true;
    case "invalid":
      return false;
    case "param": {
      // Judgment call (advisor-confirmed): WS-07 §3 says these rules "are available for deny/ask
      // decisions" -- read as a scope-restricting grant (this spec marks allow/deny asymmetries
      // deliberately elsewhere), not incidental framing. An allow-direction param rule never
      // matches; it cannot be used to pre-approve.
      if (opts.direction !== "denyAsk") return false;
      const actual = call.input[rule.specifier.field];
      if (actual === undefined) return false; // "omitted parameters do not match"
      return actual === rule.specifier.value; // "literal, unnormalized scalar input"
    }
    case "webFetchDomain": {
      // Judgment call (advisor-confirmed): WS-07 §3 itself names "the domain:* form" -- a literal-
      // equality compare would make that shape match nothing. Domain is WebFetch's own "native"
      // content-field grammar (not a generic param rule), so it is glob-capable and usable on
      // BOTH directions, unlike the generic "param" kind above.
      //
      // MATCHED AGAINST THE HOSTNAME DERIVED FROM `input.url`, and from nothing else. This used to
      // read `call.input["domain"]`, a field no real `{url, prompt}` call carries -- so every
      // `WebFetch(domain:...)` rule, deny and ask included, was dead in production and passed its
      // tests only because they hand-built `{domain}`. `domain` is deliberately NOT kept as a
      // fallback: `{url: "https://evil.example", domain: "docs.python.org"}` would then satisfy an
      // allow rule for a host the call never touches.
      //
      // EXACT HOST, NO IMPLICIT SUBDOMAINS. `domain:example.com` does not match `docs.example.com`
      // (the reference runtime compares the whole hostname too); covering subdomains is opt-in, by
      // writing the glob -- `domain:*.example.com` -- which in turn does not match the apex.
      //
      // Not `compilePattern`: that adds Bash's trailing `:*` / ` *` prefix sugar, which has no
      // meaning for a hostname. `*` is the only metacharacter; everything else is literal, so an
      // IPv6 rule (`domain:[::1]`) compares as written.
      const hostname = webFetchHostnameOf(call.input);
      if (hostname === undefined) return false;
      return new RegExp(`^${globToRegExpSource(rule.specifier.source)}$`, "s").test(hostname);
    }
    case "pattern": {
      const raw = call.input["command"];
      const cmd = typeof raw === "string" ? raw : "";
      const stripped = stripWrappers(cmd, opts.direction);
      return compilePattern(rule.specifier.source).test(stripped);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// WS-21 fix round 10, item A: `sue` -- the settings-LOAD rule validator
// ---------------------------------------------------------------------------------------------
//
// Claude's own settings loader (`io`, dump-confirmed alongside `sue`, byte offset ~12279285 of the
// pinned 2.1.250 dump) filters `permissions.{allow,deny,ask}` at LOAD TIME: each raw rule string is
// checked with `sue(raw, direction)`, and an invalid one is DROPPED (never becomes an active rule at
// all) with a warning, `io`'s own two-part text: `Invalid permission rule "<raw>" was skipped:
// <error>[. <suggestion>]`. `sue` returns a `.warning` field too, for a handful of VALID-but-worth-
// flagging shapes (a Bash wildcard sitting before the subcommand; a Write/NotebookEdit/MultiEdit/Glob
// rule that file-permission checks never actually consult) -- `io` never reads `.warning` at all,
// only `.valid`, so those two cases have NO observable effect on which rules survive settings load
// and are deliberately NOT ported here.
//
// SCOPE, per the controller's own ruling: this validator applies ONLY at settings-file load
// (`production-wiring.ts`'s `buildSettingsRuleSeed`, the one Winter call site that reads
// `permissions.{allow,deny,ask}` from a raw settings object, mirroring `io` being the one claude
// call site that does). A rule arriving through any OTHER door -- `Options.allow/deny/
// disallowedTools`, a `canUseTool` "always allow", a plugin's own `permissions` block -- is
// untouched by this function and keeps going through `parseRule`'s own `jr`-ported grammar exactly
// as before, `Tool()` folding to bare per round 9's own ruling. `sue` itself calls `jr` internally
// (see `sueExtractToolAndContent` below, a deliberately SEPARATE extraction from `parseRule`'s own:
// `jr` has no "toolName contains whitespace" guard the way Winter's own `parseRule` does, and `sue`
// needs `jr`'s exact, unnarrowed behaviour to validate the same way claude does).
//
// `sue`'s full source, verbatim (renamed identifiers in this comment only, never in behaviour):
//   function sue(e,t){
//     if(!e||e.trim()==="")return{valid:!1,error:"Permission rule cannot be empty"};
//     let o=_e(e,"("),s=_e(e,")");
//     if(o!==s)return{valid:!1,error:"Mismatched parentheses",suggestion:"..."};
//     if(On(e)){
//       let c=e.substring(0,e.indexOf("("));
//       if(!c)return{valid:!1,error:"Empty parentheses with no tool name",suggestion:"..."};
//       return{valid:!1,error:"Empty parentheses",suggestion:`Either specify a pattern or use just "${c}" without parentheses`}
//     }
//     let r=jr(e),p=Xs(r.toolName);
//     if(p){
//       if(r.ruleContent!==void 0||_e(e,"(")>0)return{valid:!1,error:"MCP rules do not support patterns in parentheses",suggestion:"..."};
//       if(t==="allow"){let c=zDe(r.toolName);if(c)return c}
//       return{valid:!0}
//     }
//     if(!r.toolName||r.toolName.length===0)return{valid:!1,error:"Tool name cannot be empty"};
//     if(t==="allow"){let c=zDe(r.toolName);if(c)return c}
//     if(!r.toolName.includes("_")&&r.toolName[0]!==r.toolName[0]?.toUpperCase())
//       return{valid:!1,error:"Tool names must start with uppercase",suggestion:`Use "${bf(String(r.toolName))}"`};
//     let g=nt(r.toolName);
//     if(g&&r.ruleContent!==void 0){let c=g(r.ruleContent);if(!c.valid)return c}
//     if(tt(r.toolName)&&r.ruleContent!==void 0){
//       let c=r.ruleContent;
//       if(c.includes(":*")&&!c.endsWith(":*"))return{valid:!1,error:"The :* pattern must be at the end",suggestion:"..."};
//       if(c===":*")return{valid:!1,error:"Prefix cannot be empty before :*",suggestion:"..."};
//       if(t==="allow"){let E=Rn(c);if(E!==void 0)return{valid:!0,warning:"..."}}
//     }
//     if(et(r.toolName)&&r.ruleContent!==void 0){
//       if(r.ruleContent.includes(":*"))return{valid:!1,error:'The ":*" syntax is only for Bash prefix rules',suggestion:"..."}
//     }
//     if(r.ruleContent!==void 0){
//       let c=r.toolName==="Write"||r.toolName==="NotebookEdit"||r.toolName==="MultiEdit"?"Edit":r.toolName==="Glob"?"Read":void 0;
//       if(c!==void 0&&!r.ruleContent.includes(":*"))return{valid:!0,warning:"..."}
//     }
//     return{valid:!0}
//   }
// `be`/`_e` are the SAME escape-aware helpers this module already ported in round 8 (`isEscapedAt`/
// a count variant); `jr` is this module's own `parseRule` extraction, reused here in the SEPARATE
// unnarrowed form described above; `Xs` splits an MCP tool name (`mcp__server__tool`); `zDe` is the
// allow-direction wildcard-scope check; `nt`/`tt`/`et` look up `jte`'s own three tables (dump-
// confirmed at the SAME byte region as `sue`):
//   var jte={
//     filePatternTools:["Read","Write","Edit","Glob","NotebookRead","NotebookEdit","Cd"],
//     bashPrefixTools:["Bash"],
//     customValidation:{
//       WebSearch:(e)=>{ if(e.includes("*")||e.includes("?")) return {valid:!1,error:"WebSearch does not support wildcards",suggestion:"..."}; return{valid:!0} },
//       WebFetch:(e)=>{ if(e.includes("://")||e.startsWith("http")) return {valid:!1,error:"WebFetch permissions use domain format, not URLs",suggestion:"..."};
//                        if(!e.startsWith("domain:")) return {valid:!1,error:'WebFetch permissions must use "domain:" prefix',suggestion:"..."}; return{valid:!0} }
//     }
//   }
// CONTENT-VERIFIED DIVERGENCE, disclosed: `jte.filePatternTools` is NOT this module's own
// `FILE_RULE_TOOLS` constant (used for actual rule-matching DISPATCH). Claude's validator list
// includes "NotebookRead" and "Cd" -- neither a Winter-registered tool -- and EXCLUDES "Grep",
// which Winter's own `FILE_RULE_TOOLS` DOES include (added later, I1 fix wave). Ported here as
// claude's own list, verbatim, for THIS validator alone: a settings-file `Grep(foo:*)` rule is
// therefore NOT rejected by the ":* on file tools" check below, matching claude exactly, even
// though Winter's own matcher (grammar.ts's FILE_RULE_TOOLS) treats Grep as a file-rule tool for
// everything else.
export interface PermissionRuleValidation {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

const SUE_FILE_PATTERN_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit", "Cd"]);
const SUE_BASH_PREFIX_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

function sueCustomValidator(toolName: string): ((content: string) => PermissionRuleValidation) | undefined {
  if (toolName === "WebSearch") {
    return (content) =>
      content.includes("*") || content.includes("?")
        ? { valid: false, error: "WebSearch does not support wildcards", suggestion: "Use exact search terms without * or ?" }
        : { valid: true };
  }
  if (toolName === "WebFetch") {
    return (content) => {
      if (content.includes("://") || content.startsWith("http")) {
        return { valid: false, error: "WebFetch permissions use domain format, not URLs", suggestion: 'Use "domain:hostname" format' };
      }
      if (!content.startsWith("domain:")) {
        return { valid: false, error: 'WebFetch permissions must use "domain:" prefix', suggestion: 'Use "domain:hostname" format' };
      }
      return { valid: true };
    };
  }
  return undefined;
}

function sueCountUnescaped(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch && !isEscapedAt(s, i)) count++;
  return count;
}

function sueHasUnescapedEmptyParens(s: string): boolean {
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] === "(" && s[i + 1] === ")" && !isEscapedAt(s, i)) return true;
  }
  return false;
}

function sueParseMcpName(toolName: string): { serverName: string; toolName?: string } | null {
  const parts = toolName.split("__");
  const first = parts[0];
  const serverName = parts[1];
  if (first !== "mcp" || !serverName) return null;
  const rest = parts.slice(2);
  return { serverName, ...(rest.length > 0 ? { toolName: rest.join("__") } : {}) };
}

function sueAllowWildcardScopeError(toolName: string): PermissionRuleValidation | null {
  if (!toolName.includes("*")) return null;
  const mcp = sueParseMcpName(toolName);
  if (mcp !== null && !mcp.serverName.includes("*")) return null;
  return {
    valid: false,
    error: `Wildcard tool name "${toolName}" is not supported in allow rules`,
    suggestion:
      "An allow pattern must name the scope it widens -- globs are permitted only in the tool position after a literal mcp__<server>__ prefix. Deny and ask rules accept wildcards anywhere",
  };
}

/** `jr`'s own extraction, unnarrowed -- see this section's header for why it is not `parseRule`. */
function sueExtractToolAndContent(raw: string): { toolName: string; ruleContent?: string } {
  const trimmed = raw.trim();
  const openIdx = firstUnescaped(trimmed, "(");
  if (openIdx === -1) return { toolName: trimmed };
  const toolName = trimmed.slice(0, openIdx);
  if (toolName === "") return { toolName: trimmed };
  const closeIdx = lastUnescaped(trimmed, ")");
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== trimmed.length - 1) return { toolName: trimmed };
  const rawContent = trimmed.slice(openIdx + 1, closeIdx);
  if (rawContent === "" || rawContent === "*") return { toolName };
  return { toolName, ruleContent: unescapeRuleContent(rawContent) };
}

export function validatePermissionRuleString(raw: string, direction: "allow" | "deny" | "ask"): PermissionRuleValidation {
  if (!raw || raw.trim() === "") return { valid: false, error: "Permission rule cannot be empty" };

  const openCount = sueCountUnescaped(raw, "(");
  const closeCount = sueCountUnescaped(raw, ")");
  if (openCount !== closeCount) {
    return { valid: false, error: "Mismatched parentheses", suggestion: "Ensure all opening parentheses have matching closing parentheses" };
  }

  if (sueHasUnescapedEmptyParens(raw)) {
    const parenIdx = raw.indexOf("(");
    const prefix = parenIdx === -1 ? "" : raw.substring(0, parenIdx);
    if (!prefix) return { valid: false, error: "Empty parentheses with no tool name", suggestion: "Specify a tool name before the parentheses" };
    return { valid: false, error: "Empty parentheses", suggestion: `Either specify a pattern or use just "${prefix}" without parentheses` };
  }

  const { toolName, ruleContent } = sueExtractToolAndContent(raw);
  const mcp = sueParseMcpName(toolName);
  if (mcp !== null) {
    if (ruleContent !== undefined || sueCountUnescaped(raw, "(") > 0) {
      return {
        valid: false,
        error: "MCP rules do not support patterns in parentheses",
        suggestion: `Use "${toolName}" without parentheses, or use "mcp__${mcp.serverName}__*" for all tools`,
      };
    }
    if (direction === "allow") {
      const wildcardError = sueAllowWildcardScopeError(toolName);
      if (wildcardError !== null) return wildcardError;
    }
    return { valid: true };
  }

  if (!toolName || toolName.length === 0) return { valid: false, error: "Tool name cannot be empty" };

  if (direction === "allow") {
    const wildcardError = sueAllowWildcardScopeError(toolName);
    if (wildcardError !== null) return wildcardError;
  }

  if (!toolName.includes("_") && toolName[0] !== toolName[0]?.toUpperCase()) {
    return { valid: false, error: "Tool names must start with uppercase", suggestion: `Use "${toolName.charAt(0).toUpperCase()}${toolName.slice(1)}"` };
  }

  const customValidator = sueCustomValidator(toolName);
  if (customValidator !== undefined && ruleContent !== undefined) {
    const result = customValidator(ruleContent);
    if (!result.valid) return result;
  }

  if (SUE_BASH_PREFIX_TOOLS.has(toolName) && ruleContent !== undefined) {
    if (ruleContent.includes(":*") && !ruleContent.endsWith(":*")) {
      return { valid: false, error: "The :* pattern must be at the end", suggestion: "Move :* to the end for prefix matching, or use * for wildcard matching" };
    }
    if (ruleContent === ":*") {
      return { valid: false, error: "Prefix cannot be empty before :*", suggestion: "Specify a command prefix before :*" };
    }
    // The allow-direction "wildcard sits before the subcommand" WARNING (`Rn`) is deliberately not
    // ported -- `io` never reads `.warning`, so it has no effect on which rules survive load.
  }

  if (SUE_FILE_PATTERN_TOOLS.has(toolName) && ruleContent !== undefined) {
    if (ruleContent.includes(":*")) {
      return { valid: false, error: 'The ":*" syntax is only for Bash prefix rules', suggestion: 'Use glob patterns like "*" or "**" for file matching' };
    }
  }

  // The trailing "Write/NotebookEdit/MultiEdit/Glob aren't checked, use Edit/Read instead" WARNING
  // is also not ported, for the identical reason: warning-only, invisible to `io`.
  return { valid: true };
}
