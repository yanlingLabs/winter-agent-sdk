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
const WRITE_CAPABLE_FLAGS: Readonly<Record<string, RegExp>> = {
  find: /(^|\s)-delete(\s|$)/,
};

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
  let quote: '"' | "'" | "`" | null = null;
  let ok = true;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (quote === "'") {
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
      quote = ch;
      continue;
    }
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
// splitCompound
// ---------------------------------------------------------------------------------------------

export function splitCompound(command: string): string[] | null {
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

export function stripWrappers(cmd: string, direction: "allow" | "denyAsk"): string {
  // P2 fix-wave item 2: ONE scan for this whole call, threaded through every helper below via a
  // plain integer offset into this SAME, unchanging `cmd` string -- never a re-scan of a
  // progressively-sliced substring (see leadingWordAt/stripLeadingAssignmentsAt's own headers for
  // the O(n^2) shape this closes).
  const info = scanShellLike(cmd);
  let pos = 0;
  for (;;) {
    pos = stripLeadingAssignmentsAt(cmd, info, pos, direction);
    const { word, end: afterWordEnd } = leadingWordAt(cmd, info, pos);
    if (word === undefined) return cmd.slice(pos);

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

function stripQuotes(word: string): string {
  if (word.length >= 2) {
    const first = word[0];
    const last = word[word.length - 1];
    if ((first === '"' || first === "'") && first === last) return word.slice(1, -1);
  }
  return word;
}

export function extractRedirectTargets(command: string): string[] {
  const info = scanShellLike(command);
  const { topLevel, ok } = info;
  if (!ok) return [];

  const targets: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (!topLevel[i]) {
      i++;
      continue;
    }
    if (command.slice(i, i + 2) === "<<") {
      // here-doc operator -- WS-07 §3: excluded from redirect-target extraction. The body itself
      // is not specially skipped (see the module-header limitations note).
      i += 2;
      continue;
    }
    const ch = command[i]!;
    let opLen = 0;
    if (ch === ">") {
      if (command[i + 1] === ">") opLen = 2; // >>
      else if (command[i + 1] === "&") {
        i += 2; // >&N dup, not a file write
        continue;
      } else opLen = 1; // >
    } else if (ch === "&" && command[i + 1] === ">") {
      opLen = 2; // &>
    } else if (/[0-9]/.test(ch) && command[i + 1] === ">") {
      if (command[i + 2] === "&") {
        i += 3; // N>&M dup (e.g. 2>&1), not a file write
        continue;
      }
      opLen = command[i + 2] === ">" ? 3 : 2; // N>> or N>
    } else {
      i++;
      continue;
    }

    // P2 fix-wave item 2: leadingWordAt reads directly off the ONE scan (`info`) computed at this
    // function's own top, at the absolute index right past this operator -- never a fresh
    // scanShellLike over a freshly-sliced tail substring (the pre-fix O(n^2) shape: many redirect
    // operators, each re-scanning the remaining command from scratch).
    const lw = leadingWordAt(command, info, i + opLen);
    if (lw.word !== undefined) {
      targets.push(stripQuotes(lw.word));
      i = lw.end;
    } else {
      i += opLen;
    }
  }
  return targets;
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

  if (first === "git") {
    const { word: sub } = leadingWord(afterWord);
    return sub !== undefined && GIT_READ_ONLY_SUBCOMMANDS.has(sub);
  }

  if (!READ_ONLY_COMMANDS.has(first)) return false;
  const flagPattern = WRITE_CAPABLE_FLAGS[first];
  if (flagPattern && flagPattern.test(afterWord)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Glob/prefix pattern compiler (WS-07 §3's general `*` / trailing `:*` rule)
// ---------------------------------------------------------------------------------------------

function escapeRegExpLiteral(s: string): string {
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

/** The one tool whose specifier is a skill identity + argument prefix (WS-07 §3). */
const SKILL_RULE_TOOL = "Skill";

const RULE_SHAPE = /^([^\s(]+)\((.*)\)$/s;
const FIELD_VALUE = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/s;

export function parseRule(raw: string): ParsedRule {
  const trimmed = raw.trim();
  const m = RULE_SHAPE.exec(trimmed);
  if (!m) {
    // Bare tool name (also the lenient fallback for anything not matching Tool(content) shape,
    // e.g. stray trailing text after a closing paren -- an unusual input no fixture exercises;
    // treating the whole string as a literal bare tool name is a safe, inert failure mode since it
    // won't equal any real toolName).
    return { toolName: trimmed, isBareEquivalent: true };
  }
  const toolName = m[1]!;
  const content = m[2]!;

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

  if (content === "*") {
    return { toolName, specifier: { kind: "wildcardAll" }, isBareEquivalent: true };
  }

  if (toolName === "WebFetch") {
    const wf = /^domain:(.*)$/is.exec(content);
    if (wf) {
      return { toolName, specifier: { kind: "webFetchDomain", source: wf[1]!.toLowerCase() }, isBareEquivalent: false };
    }
    // No other WebFetch specifier grammar is documented; fall back to the generic pattern family
    // for forward compatibility rather than throwing (matches nothing useful today -- see
    // matchesRule's "pattern" case, which fails closed for tools with no known primary field).
    return { toolName, specifier: { kind: "pattern", source: content }, isBareEquivalent: false };
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
      const actual = call.input["domain"];
      if (typeof actual !== "string") return false;
      return compilePattern(rule.specifier.source, { caseInsensitive: true }).test(actual);
    }
    case "pattern": {
      const raw = call.input["command"];
      const cmd = typeof raw === "string" ? raw : "";
      const stripped = stripWrappers(cmd, opts.direction);
      return compilePattern(rule.specifier.source).test(stripped);
    }
  }
}
