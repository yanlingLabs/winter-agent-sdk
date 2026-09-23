// Shell STRUCTURE for the permission floors: every simple command a Bash string will run.
//
// grammar.ts's `splitCompound` splits a command at its TOP level only, which is what rule matching
// was built on -- and it left four places a command can hide, each of which the write-target, critical-
// removal and read-only checks then never saw:
//
//   - a subshell or brace group:            `(cp x .git/hooks/pre-commit)`, `{ rm -rf ~; }`
//   - a command or process substitution:    `ls $(rm -rf ~)`, `` echo `touch f` ``, `cat <(…)`
//   - a compound-statement keyword head:    `if true; then rm -rf ~; fi`, `for …; do …; done`
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

type ScanContext = { kind: "cmd"; closer: ")" | "`" | null } | { kind: "dq" } | { kind: "sq" };

/**
 * Removes here-document bodies (and comments) from `command`, returning the remaining text and the
 * bodies bash will still expand. Bodies are removed BEFORE line continuations are joined: a QUOTED
 * here-document's body is literal (`\<newline>` is not a continuation there), and joining first could
 * shift its delimiter so that a later line -- `> /etc/passwd` -- was swallowed into the body and never
 * seen (claude's `extractOutputRedirections` documents that exact attack).
 */
export function extractHeredocs(command: string): HeredocExtraction | null {
  const stack: ScanContext[] = [{ kind: "cmd", closer: null }];
  const pending: Array<{ delim: string; quoted: boolean; stripTabs: boolean }> = [];
  const liveBodies: string[] = [];
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    const top = stack[stack.length - 1]!;
    if (top.kind === "sq") {
      out += ch;
      if (ch === "'") stack.pop();
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (top.kind === "dq") {
      out += ch;
      if (ch === '"') stack.pop();
      else if (ch === "$" && command[i + 1] === "(") {
        stack.push({ kind: "cmd", closer: ")" });
        out += "(";
        i++;
      } else if (ch === "`") stack.push({ kind: "cmd", closer: "`" });
      i++;
      continue;
    }
    // A command context.
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== "\n") i++; // a comment runs to the end of its line
      continue;
    }
    if (ch === "`" && top.closer === "`") {
      stack.pop();
      out += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      stack.push({ kind: ch === "'" ? "sq" : "dq" });
      out += ch;
      i++;
      continue;
    }
    if (ch === "`" || ch === "(") {
      stack.push({ kind: "cmd", closer: ch === "`" ? "`" : ")" });
      out += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      if (top.closer === ")") stack.pop();
      out += ch; // an unmatched `)` is left for splitCompound to refuse
      i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
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
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, liveBodies };
}

/** Index of the `)` closing the `(` at `open`, skipping quoted text and nested substitutions; -1 if none. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
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
    if (ch === "'" || ch === '"' || ch === "`") {
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
      const close = text.indexOf("'", i + 1);
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

function stripReservedHeads(part: string): string {
  let s = part.trim();
  for (;;) {
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
  let quote: "'" | '"' | null = null;
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
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if ((ch === "<" || ch === ">") && command[i + 1] === "(") return true;
  }
  return false;
}
