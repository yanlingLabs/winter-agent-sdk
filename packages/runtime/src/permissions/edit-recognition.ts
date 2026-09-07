// Task 7 (WS-07 §6.2): input-aware recognition of "this call is an edit-shaped filesystem
// operation, touching exactly these paths" -- the primitive `acceptEdits`' auto-approval arm
// (evaluator.ts) consumes to decide whether a call is even ELIGIBLE for path-bounded auto-approval,
// and that `SpecialChecks.isProtectedWrite` (evaluator.ts's seam) reuses to find every candidate
// write-path a Bash call might touch, regardless of whether that call ends up "blessed" for
// acceptEdits at all.
//
// ARCHITECTURE:
//   - `Edit`/`Write`/`NotebookEdit` tool calls are direct: one call, one path field (`fileRulePathField`
//     below -- `file_path` for Edit/Write, `notebook_path` for NotebookEdit, RULING P3-E), one
//     recognized path.
//   - A `Bash` call is decomposed via T3's `splitCompound` (never treating raw, unsplit compound
//     text as one command -- the exact "lens item 1" trap T6's own tests pin) and EVERY subcommand
//     is independently classified. A subcommand is "blessed" (part of WS-07 §6.2's exact seven-verb
//     list: mkdir/touch/rm/rmdir/mv/cp/sed) only if it has NO redirect target of its own -- a
//     redirect is a separate file write WS-07 §3 says a command's own authorization never covers
//     (T3's `extractRedirectTargets` module comment), so it must not silently ride along inside
//     acceptEdits' blessed set either, even attached to an otherwise-recognized command.
//   - `kind: "bashFsOp"` -- every subcommand blessed, no redirects anywhere: the ONLY shape
//     evaluator.ts's acceptEdits arm may auto-approve (subject to its own path-bounding/protected/
//     critical checks). `kind: "edit"` -- the direct Edit/Write case, same treatment.
//   - `kind: "other"` -- SOME write-shaped path was found (a redirect target, or a blessed
//     subcommand mixed with an unblessed/redirecting one) but the call as a whole is NOT eligible
//     for acceptEdits auto-approval. Returned (not `null`) specifically so `isProtectedWrite`'s
//     path extraction (evaluator.ts) can see `echo x > .git/config`'s redirect target even though
//     `echo` is nowhere near the blessed seven -- "redirect targets count as write paths for the
//     SpecialChecks seam... but do not widen §6.2's auto-approve set" (this task's own instruction).
//   - `null` -- nothing write-shaped recognized at all (a plain read-only or unrelated command, or
//     an unparseable/empty command) -- WS-07 §6.2: "ambiguous/unparseable ... fall back to a
//     prompt," which for THIS primitive means "the caller gets no paths and no opinion," not "assume
//     the worst." Distinguishing "no opinion" (null) from "found writes but not blessed" (kind:
//     "other") is exactly what lets one function serve both evaluator.ts consumers correctly.
//
// Trap avoided (T6 review note, "vacuous match" class): `splitCompound("")` returns `[]`, not
// `null` -- an empty/all-separator command must never vacuously satisfy an `.every(...)` over zero
// parts. This module never does that: an empty `parts` array is treated as "nothing to recognize"
// (`null`), the same fallback a genuinely unparseable command gets.
//
// Tokenizer note: argument extraction below needs a quote-aware word split (so `mv "a b" c` sees
// two operands, not three). grammar.ts's own quote/paren-depth scanner (`scanShellLike`) is
// private, and per this phase's established precedent (evaluator.ts's `matchesRuleForCall` comment:
// "this task's edit authorization does not extend to ruleset.ts") this task's edit authorization
// does not extend to grammar.ts either -- so this module carries its own small, independent,
// deliberately simpler tokenizer (no paren-depth tracking; this module never needs to find compound
// operators, only whitespace-delimited operands within an ALREADY-split-and-stripped subcommand).
import { join } from "node:path";
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { splitCompound, stripWrappers, extractRedirectTargets } from "./grammar.ts";

export type RecognizedEditKind = "edit" | "bashFsOp" | "other";

export interface RecognizedEditOperation {
  kind: RecognizedEditKind;
  paths: string[];
}

// WS-07 §6.2, verbatim seven-verb list. Exported so protected.ts/tests can reference the exact set
// without re-deriving it, mirroring grammar.ts's own READ_ONLY_COMMANDS precedent.
export const RECOGNIZED_BASH_FS_OPS: ReadonlySet<string> = new Set(["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"]);

// ---------------------------------------------------------------------------------------------
// A small, independent, quote-aware whitespace tokenizer (see module header for why this doesn't
// reuse grammar.ts's private scanner). Handles single/double quotes and backslash escapes; does
// NOT track paren depth or backtick/command-substitution spans -- this function only ever receives
// an already-`stripWrappers`-normalized SUBCOMMAND (never raw compound text), so it never needs to.
// ---------------------------------------------------------------------------------------------

// Exported for protected.ts's isCriticalRemoval, which needs the identical whitespace/quote-aware
// word split (and the identical `--`-honoring flag skip) for its OWN rm/rmdir argument extraction.
// Both this module and protected.ts are T7-owned (WS-07 §6.2 and §6.7/§6.8 respectively); sharing
// this one small helper between them -- rather than a third module neither brief asked for, or a
// second hand-copy -- keeps the "no per-call-site repetition" principle inside T7's own scope too,
// not just across the rider-2 boundary.
export function tokenizeWords(s: string): string[] {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < s.length) {
        cur += s[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        words.push(cur);
        cur = "";
        inWord = false;
      }
      i++;
      continue;
    }
    cur += ch;
    inWord = true;
    i++;
  }
  if (inWord) words.push(cur);
  return words;
}

export function isFlagToken(token: string): boolean {
  return token.startsWith("-");
}

// This module's tokenizer is deliberately whitespace/quote-aware only (see module header) -- it
// has no concept of shell redirect operators. `extractRedirectTargets` (grammar.ts) is the
// authoritative, correctly-scoped redirect recognizer and is always consulted separately at this
// module's one call site (recognizeEditOperation's loop); this truncation exists ONLY so a
// SPACED redirect operator (`touch a.txt > log.txt`) doesn't also leak into THIS function's own
// naive operand tokenization as a bogus "-less" operand (the literal ">" token, plus whatever
// follows it, would otherwise look just like an ordinary operand to `nonFlagOperands`/
// `sedOperandPaths`). Known, accepted limitation: a redirect operator GLUED to its target with no
// separating space (`touch a.txt >log.txt`) is not recognized as an operator by this narrow check
// and is not truncated -- the consequence is at most one extra, garbled candidate path alongside
// the correctly-extracted redirect target (from extractRedirectTargets), which can only make a
// downstream bounds/protected check MORE conservative, never less (WS-07 §13: "stricter, never
// looser"); never a security hole, and the subcommand is ALREADY demoted out of the blessed set by
// `extractRedirectTargets` finding a real target regardless of whether this truncation catches the
// glued form.
const REDIRECT_OPERATOR_TOKEN = /^(?:&>>?|\d*>>?|\d*>&\d*|<)$/;
function truncateAtFirstRedirectOperator(tokens: string[]): string[] {
  const idx = tokens.findIndex((t) => REDIRECT_OPERATOR_TOKEN.test(t));
  return idx === -1 ? tokens : tokens.slice(0, idx);
}

// Generic operand extraction for mkdir/touch/rm/rmdir/mv/cp: skip flag tokens, honoring a `--`
// terminator (WS-07 doesn't discuss `--` directly, but WITHOUT honoring it, a real operand that
// happens to start with `-` -- an unusual but legal filename -- would be silently dropped from the
// recognized path set, which is a fail-OPEN for acceptEdits' own bounds check: fewer recognized
// paths means fewer bounds checks, not more caution). Bounds-checks ALL surviving operands (mv/cp's
// source AND destination alike) -- the brief's own recognition contract has no "which operand is
// the real target" concept, and treating only the last operand as load-bearing would let `mv
// /etc/passwd ./local-copy` slip through just because the DESTINATION is in-bounds.
export function nonFlagOperands(tokens: string[]): string[] {
  const out: string[] = [];
  let sawDoubleDash = false;
  for (const tok of tokens) {
    if (!sawDoubleDash && tok === "--") {
      sawDoubleDash = true;
      continue;
    }
    if (!sawDoubleDash && isFlagToken(tok)) continue;
    out.push(tok);
  }
  return out;
}

// `sed`'s first non-flag operand is the SCRIPT (e.g. "s/x/y/"), never a path -- WS-07 §6.2's own
// fixture is `sed -i`, i.e. the in-place idiom, script included. Best-effort handling of the
// GNU-vs-BSD `-i` divergence: GNU sed's `-i`/`-i.bak` takes an attached, optional suffix on the
// SAME token (or none); BSD/macOS sed REQUIRES a separate suffix argument, conventionally an empty
// string (`sed -i '' '...'`) for "no backup." A bare `-i` immediately followed by an empty-string
// token is treated as consuming that token too (documented limitation: this cannot distinguish that
// shape from a genuinely empty GNU sed SCRIPT argument -- an unusual invocation, so misreading it as
// BSD's suffix-arg is the safer of two guesses per WS-07 §13's "stricter, never looser" license: the
// consequence of guessing wrong here is one fewer/extra candidate path, not a false auto-approval).
function sedOperandPaths(rest: string[]): string[] | null {
  const tokens = truncateAtFirstRedirectOperator(rest);
  const filtered: string[] = [];
  let sawDoubleDash = false;
  let sawI = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!sawDoubleDash && tok === "--") {
      sawDoubleDash = true;
      continue;
    }
    if (!sawDoubleDash && isFlagToken(tok)) {
      if (tok === "-i" || tok.startsWith("-i")) sawI = true; // bare `-i` or GNU's attached-suffix `-i.bak`
      if (tok === "-i" && tokens[i + 1] === "") i++; // BSD `-i ''` suffix-arg idiom
      continue;
    }
    filtered.push(tok);
  }
  // WS-07 §6.2 lists `sed` as one of the acceptEdits-blessed verbs specifically for its IN-PLACE
  // idiom -- a bare `sed` (no `-i`) reads and prints, mutating nothing; recognizing it here would
  // misclassify a read-shaped invocation as a write.
  if (!sawI) return null;
  const paths = filtered.slice(1); // drop the script -- see header
  return paths.length > 0 ? paths : null;
}

// Classifies ONE already-stripped subcommand string. Returns `null` when the leading word isn't
// one of the blessed seven verbs (including when there's no leading word at all -- an empty string).
function recognizeBashFsOpPaths(stripped: string): string[] | null {
  const tokens = tokenizeWords(stripped);
  if (tokens.length === 0) return null;
  const [cmd, ...rest] = tokens;
  if (cmd === undefined || !RECOGNIZED_BASH_FS_OPS.has(cmd)) return null;
  if (cmd === "sed") return sedOperandPaths(rest);
  const operands = nonFlagOperands(truncateAtFirstRedirectOperator(rest));
  return operands.length > 0 ? operands : null;
}

// ---------------------------------------------------------------------------------------------
// recognizeEditOperation
// ---------------------------------------------------------------------------------------------

// Task 8 (P3 close-out, RULING P3-E): the single source of truth for "which input field holds a
// WS-06 §3.1 file-rule tool's target path" (Read/Edit/Write: `file_path`; NotebookEdit:
// `notebook_path`) -- exported so evaluator.ts's `extractCandidateWritePaths` and
// `matchesRuleForCall` (both of which need this for Read too, hence the parameter isn't scoped to
// only the three write-tools this module cares about) consume the IDENTICAL mapping rather than
// each hand-rolling their own, which is exactly the class of drift that left `notebook_path`
// invisible to the whole permissions package before this ruling (Lane B's own report: "zero grep
// hits"). Lives here, not in evaluator.ts, because evaluator.ts already imports FROM this module
// (recognizeEditOperation below) -- the reverse import would be circular.
// I1 (fix wave, P3 close-out): grows a THIRD return, "path" -- Glob/Grep's own pinned field name
// (WS-06 §3.1) -- now that FILE_RULE_TOOLS (grammar.ts) includes them too. Unlike Read/Edit/Write/
// NotebookEdit's `file_path`/`notebook_path` (always required on those tools), Glob/Grep's `path` is
// OPTIONAL on the call itself (absent == "scan from cwd") -- callers reading `call.input[
// fileRulePathField(call.toolName)]` for Glob/Grep must still apply that same "absent == cwd"
// default themselves (this function only names the FIELD, never a fallback value, mirroring its own
// pre-existing contract for the other four tools).
export function fileRulePathField(toolName: string): "file_path" | "notebook_path" | "path" {
  if (toolName === "NotebookEdit") return "notebook_path";
  if (toolName === "Glob" || toolName === "Grep") return "path";
  return "file_path";
}

// I2 (fix wave, P3 close-out): Monitor's command half shares Bash's own sandbox mechanism, and its
// own descriptor says so explicitly ("Command half uses the Bash permission family",
// `permissionClass: "execute"`) -- but every Bash-keyed input-aware check in the permission layer
// (this function included) was keyed on the literal tool name "Bash" alone, so a shell command
// arriving as Monitor's own `command` field was invisible to all of them (no critical-removal
// breaker, no protected-write, no read-deny-blocks-edit, no plan-write withholding -- WS-07 §6.8's
// safety MUST bypassed via a sibling tool). Lives here (not evaluator.ts, which ALSO needs it for
// `isCriticalRemoval`/`isPlanWriteShaped`) because this module's own `recognizeEditOperation` needs
// it internally too, and evaluator.ts already imports FROM this module -- the reverse import would
// be circular. Deliberately does NOT cover `isBashCallReadOnly` (evaluator.ts) -- Monitor is a
// long-running background process, never a read-only pre-approval candidate, even when its command
// text looks read-only; that function does not consult this helper.
export function shellCommandOf(call: { toolName: string; input: Record<string, unknown> }): string | undefined {
  if (call.toolName !== "Bash" && call.toolName !== "Monitor") return undefined;
  const raw = call.input["command"];
  return typeof raw === "string" ? raw : undefined;
}

export function recognizeEditOperation(
  call: { toolName: string; input: Record<string, unknown> },
  opts?: { sessionRoot?: string; brand?: Pick<BrandProfile, "projectDirName"> },
): RecognizedEditOperation | null {
  if (call.toolName === "Edit" || call.toolName === "Write" || call.toolName === "NotebookEdit") {
    const path = call.input[fileRulePathField(call.toolName)];
    return typeof path === "string" ? { kind: "edit", paths: [path] } : null;
  }
  // RULING P3-K (fix wave, P3 close-out): CronCreate(durable: true) is write-shaped -- its target is
  // a FIXED, non-model-controllable path (`<sessionRoot>/<projectDir>/scheduled_tasks.json`, cron.ts's
  // own `durableFilePath`), so it is recognized as a single-path "edit"-kind write for acceptEdits/
  // protected/plan-write purposes, on par with Edit/Write. Requires `opts.sessionRoot` (the
  // evaluator's own EvaluationContext.sessionRoot, threaded in by every evaluator.ts call site) --
  // without it (a caller with no session-root concept), CronCreate is not recognized as a write at
  // all, never guessed against the wrong root. Non-durable CronCreate (or `durable` omitted/false)
  // never touches the filesystem at all -- not recognized here, full stop (RULING P3-K's own
  // "silent-allow" cell, evaluator.ts's `evaluateModeStage`).
  if (call.toolName === "CronCreate") {
    if (call.input["durable"] !== true || opts?.sessionRoot === undefined) return null;
    return { kind: "edit", paths: [join(opts.sessionRoot, (opts.brand ?? WINTER_BRAND).projectDirName, "scheduled_tasks.json")] };
  }

  const command = shellCommandOf(call);
  if (command === undefined) return null;
  const parts = splitCompound(command);
  // Coordinator note (T6 review, "vacuous match" class): splitCompound("") returns `[]`, not
  // `null` -- an empty/all-separator/missing command must never vacuously recognize as an fs-op
  // over zero parts. Treated identically to the unparseable (`null`) case: no opinion.
  if (parts === null || parts.length === 0) return null;

  const allPaths: string[] = [];
  let allBlessed = true;
  for (const part of parts) {
    // "denyAsk" wrapper-stripping (WS-07 §3: "Deny/ask matching is more conservative and looks
    // through ANY leading assignment") -- deliberate here even though acceptEdits is a GRANT path:
    // recognition decides whether a write is even a CANDIDATE for auto-approval at all, and a
    // command hidden behind an assignment `stripWrappers("allow", ...)` would refuse to see through
    // (e.g. a dangerous-by-name or `$(...)`-valued assignment) must not be given the BENEFIT of
    // narrow "safe" stripping just because this is the acceptEdits arm -- seeing further through the
    // wrapper only ever ADDS a subcommand to bounds-check, it never grants anything by itself.
    const stripped = stripWrappers(part, "denyAsk");
    const redirects = extractRedirectTargets(stripped);
    const fsOpPaths = recognizeBashFsOpPaths(stripped);
    if (fsOpPaths !== null && redirects.length === 0) {
      allPaths.push(...fsOpPaths);
    } else {
      // Any subcommand that ISN'T a blessed fs-op verb, OR that IS but also carries its own
      // redirect, demotes the WHOLE call out of "bashFsOp" -- redirects "do not widen §6.2's
      // auto-approve set" even when riding along on an otherwise-recognized command.
      allBlessed = false;
      if (fsOpPaths !== null) allPaths.push(...fsOpPaths);
      allPaths.push(...redirects);
    }
  }
  if (allPaths.length === 0) return null; // nothing write-shaped found at all -- no opinion
  return { kind: allBlessed ? "bashFsOp" : "other", paths: allPaths };
}
