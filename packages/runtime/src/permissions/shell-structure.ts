// Shell STRUCTURE for the permission floors: every simple command a Bash string will run.
//
// grammar.ts's `splitCompound` splits a command at its TOP level only, which is what rule matching
// was built on -- and it left four places a command can hide, each of which the write-target, critical-
// removal and read-only checks then never saw:
//
//   - a subshell or brace group:            `(cp x .git/hooks/pre-commit)`, `{ rm -rf ~; }`
//   - a command or process substitution:    `ls $(rm -rf ~)`, `` echo `touch f` ``, `cat <(…)`
//   - a compound-statement keyword head:    `if true; then rm -rf ~; fi`, `for …; do …; done`
//   - a function definition's body:         `f() { rm -rf ~; }; f`, `function f { … }`
//   - an UNQUOTED here-document body, whose `$(…)` runs:  `cat <<EOF` / `$(touch f)` / `EOF`
//
// `flattenSubcommands` returns every one of them as its own subcommand, ALONGSIDE the enclosing text
// (which keeps its own top-level redirections, e.g. `(cmd) > f`). Here-document BODIES are removed
// first (claude extracts them before it joins continuations or parses, for the reason in
// `extractHeredocs`), so body lines are never mistaken for commands, and `#` comments are dropped.
//
// Unparseable input -- an unterminated quote, unbalanced parentheses, `case` patterns, nesting past
// MAX_NESTING -- returns `null`. Every caller treats that as "cannot be analysed": a security check
// fails CLOSED on it, a grant never fires on it.
import { joinLineContinuations, leadingWord, splitCompound } from "./grammar.ts";

const MAX_NESTING = 32;

/** A substitution body that is only `cat` of a QUOTED-delimiter here-document (its body already removed). */
const LITERAL_CAT_HEREDOC = /^\s*cat[ \t]*<<-?[ \t]*(?:'[A-Za-z_]\w*'|"[A-Za-z_]\w*"|\\[A-Za-z_]\w*)\s*$/;

/** Words a compound statement opens with; the command they introduce is what runs. */
const RESERVED_HEADS: ReadonlySet<string> = new Set(["!", "{", "}", "(", ")", "then", "else", "do", "if", "elif", "while", "until"]);

export interface HeredocExtraction {
  /** The command with every here-document body (and its delimiter line) and every comment removed. */
  text: string;
  /** Bodies of UNQUOTED here-documents: bash expands `$(…)` and backticks inside them. */
  liveBodies: string[];
}

type ScanContext =
  // `arith`: inside `((…))`/`$((…))`, where `<<` is a SHIFT and `#` is not a comment.
  | { kind: "cmd"; closer: ")" | "`" | null; arith: boolean }
  | { kind: "param" } // `${…}`: a word, not a command -- no here-document, no comment
  | { kind: "bracket" } // `$[…]`: legacy arithmetic, like `arith`
  | { kind: "dq" }
  | { kind: "sq" }
  | { kind: "ansi" }; // `$'…'`: single-quoted, but `\'` does not end it

/** Is the `'` at `i` the opening of an ANSI-C `$'…'` quote (its `$` unescaped)? */
function opensAnsiQuote(s: string, i: number): boolean {
  if (s[i - 1] !== "$") return false;
  let backslashes = 0;
  for (let j = i - 2; j >= 0 && s[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 0;
}

/**
 * Removes here-document bodies (and comments) from `command`, returning the remaining text and the
 * bodies bash will still expand. Bodies are removed BEFORE line continuations are joined: a QUOTED
 * here-document's body is literal (`\<newline>` is not a continuation there), and joining first could
 * shift its delimiter so that a later line -- `> /etc/passwd` -- was swallowed into the body and never
 * seen (claude's `extractOutputRedirections` documents that exact attack).
 *
 * This is the one scanner that DROPS text, so it follows bash's contexts closely enough never to drop
 * a command bash runs: `<<` is a here-document only in a command context (not inside `((…))`,
 * `$((…))`, `$[…]` or `${…}`, where it is a shift or a literal), and `#` is a comment only at the start
 * of a word in a command context -- ending at a backtick body's closing backtick, as bash's does.
 */
export function extractHeredocs(command: string): HeredocExtraction | null {
  const stack: ScanContext[] = [{ kind: "cmd", closer: null, arith: false }];
  const pending: Array<{ delim: string; quoted: boolean; stripTabs: boolean }> = [];
  const liveBodies: string[] = [];
  let out = "";
  let i = 0;
  // Does the next character START a word? An escaped or quoted character never ends a word, so
  // `echo x\ #; rm -rf ~` is NOT a comment: the `rm` runs.
  let wordStart = true;
  const push = (ctx: ScanContext, text: string): void => {
    stack.push(ctx);
    out += text;
    i += text.length;
  };
  /** `$(`, `${`, `$[`, `$'`, a backtick or a quote opening at `i`, in any context that expands; false if none. */
  const openExpansion = (inArith: boolean): boolean => {
    const ch = command[i]!;
    const next = command[i + 1];
    if (ch === "$" && next === "(") {
      out += "$";
      i++;
      push({ kind: "cmd", closer: ")", arith: inArith || command[i + 1] === "(" }, "(");
      wordStart = true;
      return true;
    }
    if (ch === "$" && next === "{") {
      push({ kind: "param" }, "${");
      return true;
    }
    if (ch === "$" && next === "[") {
      push({ kind: "bracket" }, "$[");
      return true;
    }
    if (ch === "`") {
      push({ kind: "cmd", closer: "`", arith: false }, "`");
      wordStart = true;
      return true;
    }
    if (ch === "'") {
      push({ kind: opensAnsiQuote(command, i) ? "ansi" : "sq" }, "'");
      return true;
    }
    if (ch === '"') {
      push({ kind: "dq" }, '"');
      return true;
    }
    return false;
  };
  while (i < command.length) {
    const ch = command[i]!;
    const top = stack[stack.length - 1]!;
    if (top.kind === "sq" || top.kind === "ansi") {
      if (top.kind === "ansi" && ch === "\\" && i + 1 < command.length) {
        out += ch + command[i + 1];
        i += 2;
        continue;
      }
      out += ch;
      i++;
      if (ch === "'") {
        stack.pop();
        wordStart = false;
      }
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += ch + command[i + 1];
      i += 2;
      wordStart = false;
      continue;
    }
    if (top.kind === "dq") {
      if (ch === '"') {
        stack.pop();
        out += ch;
        i++;
        wordStart = false;
        continue;
      }
      if (ch !== "'" && openExpansion(false)) continue; // a `'` inside double quotes is literal
      out += ch;
      i++;
      continue;
    }
    if (top.kind === "param" || top.kind === "bracket") {
      if (ch === (top.kind === "param" ? "}" : "]")) {
        stack.pop();
        out += ch;
        i++;
        wordStart = false;
        continue;
      }
      if (top.kind === "bracket" && ch === "[") {
        push({ kind: "bracket" }, "[");
        continue;
      }
      if (openExpansion(top.kind === "bracket")) continue;
      out += ch;
      i++;
      continue;
    }
    // A command context.
    if (ch === "#" && wordStart && !top.arith) {
      // A comment runs to the end of its line -- or, inside a backtick body, to its closing backtick.
      while (i < command.length && command[i] !== "\n" && !(top.closer === "`" && command[i] === "`")) i++;
      continue;
    }
    if (ch === "`" && top.closer === "`") {
      stack.pop();
      out += ch;
      i++;
      wordStart = true;
      continue;
    }
    if (openExpansion(top.arith)) {
      if (ch === "'" || ch === '"') wordStart = false;
      continue;
    }
    if (ch === "(") {
      push({ kind: "cmd", closer: ")", arith: top.arith || command[i + 1] === "(" }, "(");
      wordStart = true;
      continue;
    }
    if (ch === ")") {
      if (top.closer === ")") stack.pop();
      out += ch; // an unmatched `)` is left for splitCompound to refuse
      i++;
      wordStart = true;
      continue;
    }
    if (!top.arith && ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === "-") {
        stripTabs = true;
        j++;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      let delim = "";
      let quoted = false;
      while (j < command.length && !/[\s;&|<>()]/.test(command[j]!)) {
        const c = command[j]!;
        if (c === "'" || c === '"') {
          const close = command.indexOf(c, j + 1);
          if (close === -1) return null;
          quoted = true;
          delim += command.slice(j + 1, close);
          j = close + 1;
          continue;
        }
        if (c === "\\") {
          quoted = true;
          if (j + 1 < command.length) delim += command[j + 1];
          j += 2;
          continue;
        }
        delim += c;
        j++;
      }
      if (delim.length === 0) return null; // `<<` with no delimiter: a syntax error, never guessed at
      pending.push({ delim, quoted, stripTabs });
      out += command.slice(i, j);
      i = j;
      wordStart = false;
      continue;
    }
    if (ch === "\n" && pending.length > 0) {
      out += ch;
      i++;
      for (const doc of pending) {
        const body: string[] = [];
        while (i < command.length) {
          const nl = command.indexOf("\n", i);
          const line = nl === -1 ? command.slice(i) : command.slice(i, nl);
          i = nl === -1 ? command.length : nl + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delim) break;
          body.push(line);
        }
        if (!doc.quoted) liveBodies.push(body.join("\n"));
      }
      pending.length = 0;
      wordStart = true;
      continue;
    }
    out += ch;
    i++;
    wordStart = /[\s;&|<>]/.test(ch);
  }
  return { text: out, liveBodies };
}

/** Index of the `)` closing the `(` at `open`, skipping quoted text and nested substitutions; -1 if none. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | "$'" | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === "$'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "$" && s[i + 1] === "(") {
        const close = matchingParen(s, i + 1);
        if (close === -1) return -1;
        i = close;
      }
      continue;
    }
    if (quote === "`") {
      if (ch === "`") quote = null;
      continue;
    }
    if (ch === "'") {
      quote = opensAnsiQuote(s, i) ? "$'" : "'";
      continue;
    }
    if (ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the backtick closing the one at `open`; -1 if none. */
function closingBacktick(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
  }
  return -1;
}

/** Index of the `'` closing a single (or, `ansi`, ANSI-C) quote opened at `open`; -1 if none. */
function closingSingleQuote(s: string, open: number, ansi: boolean): number {
  for (let i = open + 1; i < s.length; i++) {
    if (ansi && s[i] === "\\") i++;
    else if (s[i] === "'") return i;
  }
  return -1;
}

/**
 * The bodies of every command-running construct directly inside `text`: `$(…)`, backticks, `(…)`
 * subshells, and `<(…)` / `>(…)` process substitutions (bash, so `=(…)` is an array, not zsh's
 * process substitution). `doubleQuoted` scans text bash treats
 * like the inside of double quotes (an unquoted here-document body), where only `$(…)` and backticks
 * run. Null when a construct is not closed.
 */
export function substitutionBodies(text: string, doubleQuoted = false): string[] | null {
  const bodies: string[] = [];
  let inDouble = doubleQuoted;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (!inDouble && ch === "'") {
      const close = closingSingleQuote(text, i, opensAnsiQuote(text, i));
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (ch === '"' && !doubleQuoted) {
      inDouble = !inDouble;
      i++;
      continue;
    }
    if (ch === "`") {
      const close = closingBacktick(text, i);
      if (close === -1) return null;
      bodies.push(text.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    const substitution = ch === "$" && text[i + 1] === "(";
    const processSubstitution = !inDouble && (ch === "<" || ch === ">") && text[i + 1] === "(";
    if (substitution || processSubstitution || (!inDouble && ch === "(")) {
      const open = ch === "(" ? i : i + 1;
      const close = matchingParen(text, open);
      if (close === -1) return null;
      // `name=(a b)` is a bash ARRAY assignment, not a subshell: its words run nothing.
      if (!(ch === "(" && text[i - 1] === "=")) bodies.push(text.slice(open + 1, close));
      i = close + 1;
      continue;
    }
    i++;
  }
  return inDouble && !doubleQuoted ? null : bodies;
}

/** A function definition's head: `name()`, `function name()` or `function name` -- its BODY is what runs. */
const FUNCTION_DEFINITION_HEAD = /^(?:function\s+[^\s(){}|&;<>]+\s*(?:\(\s*\)\s*)?|[^\s(){}|&;<>]+\s*\(\s*\)\s*)/;

function stripReservedHeads(part: string): string {
  let s = part.trim();
  for (;;) {
    const definition = FUNCTION_DEFINITION_HEAD.exec(s);
    if (definition !== null) {
      s = s.slice(definition[0].length).trim();
      continue;
    }
    const { word, afterWord } = leadingWord(s);
    if (word === undefined || !RESERVED_HEADS.has(word)) return s;
    s = afterWord.trim();
  }
}

/**
 * Every simple command `command` runs -- its top-level subcommands and, recursively, the bodies of
 * its subshells, brace groups, command/process substitutions and unquoted here-documents -- each with
 * any compound-statement keyword head removed. Null when `command` cannot be analysed.
 */
export function flattenSubcommands(command: string): string[] | null {
  const out: string[] = [];
  const visitBodies = (bodies: string[] | null, depth: number): boolean => bodies !== null && bodies.every((body) => visit(body, depth + 1));
  const visit = (text: string, depth: number): boolean => {
    if (depth > MAX_NESTING) return false;
    const extracted = extractHeredocs(text);
    if (extracted === null) return false;
    // `$(cat <<'EOF' … EOF)` only produces its (literal, quoted-delimiter) body as TEXT -- the
    // commit-message idiom. Nothing in it runs, so it adds no subcommand (claude's isSafeHeredoc).
    if (depth > 0 && extracted.liveBodies.length === 0 && LITERAL_CAT_HEREDOC.test(extracted.text)) return true;
    for (const body of extracted.liveBodies) {
      if (!visitBodies(substitutionBodies(joinLineContinuations(body), true), depth)) return false;
    }
    const parts = splitCompound(extracted.text);
    if (parts === null) return false;
    for (const part of parts) {
      if (!visitBodies(substitutionBodies(part), depth)) return false;
      const head = stripReservedHeads(part);
      if (head.length > 0) out.push(head);
    }
    return true;
  };
  return visit(command, 0) ? out : null;
}

/** True when `command` contains a process substitution (`<(…)` or `>(…)`) outside quotes. */
export function hasProcessSubstitution(command: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === "$'" || quote === '"') {
      if (ch === (quote === '"' ? '"' : "'")) quote = null;
      continue;
    }
    if (ch === "'") {
      quote = opensAnsiQuote(command, i) ? "$'" : "'";
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") return true;
  }
  return false;
}

/**
 * A command the scanners could NOT parse, split naively -- at every separator and substitution
 * opener, quotes ignored. Over-approximate by design: only for checks that must see a command
 * anyway (a deny rule, the critical-removal breaker), where an extra piece can only add a match.
 */
export function naiveCommandPieces(command: string): string[] {
  return command
    .split(/[;&|\n()`]|\$\(/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}
