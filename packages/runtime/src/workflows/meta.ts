// Phase 5 Lane W (task 4), WS-11 §1.2: the `meta` block parser.
//
// Every workflow script begins with `export const meta = {...}` and that object MUST be a PURE
// LITERAL -- no variables, calls, spreads or templates. The pinned declaration says so in its own
// doc text (derived-shapes-p5 item (g): `sdk-tools.d.ts:2760`), and WS-11 §1.2 makes a violation a
// VALIDATION ERROR rather than a runtime one.
//
// WHY A PARSER AND NOT AN EVALUATOR -- the security argument, carried verbatim from Norma's
// `workflows/store.ts`: this function runs in the DAEMON process, unsandboxed, on a script the model
// just wrote and on every project `workflows/*.js` a name resolution touches. The whole reason the
// script BODY runs in a seatbelted subprocess is that its contents are untrusted; running even the
// meta block through `eval`/`new Function`/`import()` here would hand that untrusted text the
// daemon's own capabilities, before any human has reviewed it. Norma answered this with a regex that
// could only extract `description`; a real grammar is what makes "pure literal" ENFORCEABLE rather
// than merely hoped-for -- a regex cannot tell `name: "x"` from `name: f()`.
//
// This is deliberately NOT `JSON.parse`. A JS object literal is a strict superset of JSON: unquoted
// keys, single quotes and trailing commas are all legal and all appear in real authored scripts.
// Feeding the slice to JSON.parse would reject valid workflows and would still not reject a call
// expression with a useful message.
//
// DISCLOSED STRICTNESS: template literals are rejected OUTRIGHT, interpolated or not. WS-11 §1.2's
// own wording bans "template interpolation" specifically, which would leave a bare `` `plain` ``
// legal; the task brief enumerates "templates" among the rejected forms and is this lane's
// requirements document, so the stricter reading ships. The delta is one authoring inconvenience
// (write a quoted string), never a behaviour a correct script depends on.

/** A declared phase (WS-11 §1.2). `title` is matched against `phase()` calls EXACTLY. */
export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
  /** Any further literal keys the author wrote. Preserved, never interpreted -- this parser validates the SHAPE it is specified to validate and does not silently drop what it does not know. */
  [key: string]: unknown;
}

export type ParsedWorkflowMeta = { ok: true; meta: WorkflowMeta } | { ok: false; error: string };

// --- The literal grammar -------------------------------------------------------------------------

type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

class LiteralParseError extends Error {}

class LiteralParser {
  private i: number;
  constructor(
    private readonly src: string,
    start: number,
  ) {
    this.i = start;
  }

  /** The index just past the value this parser consumed -- so a caller can assert nothing trails it. */
  get position(): number {
    return this.i;
  }

  private fail(message: string): never {
    throw new LiteralParseError(message);
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) return;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i++;
        continue;
      }
      // Comments are trivia, not values -- a commented meta block is still a pure literal.
      if (c === "/" && this.src[this.i + 1] === "/") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "/" && this.src[this.i + 1] === "*") {
        const end = this.src.indexOf("*/", this.i + 2);
        if (end === -1) this.fail("unterminated block comment inside the meta object");
        this.i = end + 2;
        continue;
      }
      return;
    }
  }

  parseValue(): Literal {
    this.skipTrivia();
    const c = this.src[this.i];
    if (c === undefined) this.fail("the meta object ends unexpectedly -- it is not a balanced object literal");
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === '"' || c === "'") return this.parseString(c);
    if (c === "`") {
      this.fail("template literals are not allowed in the meta block -- it must be a pure literal (WS-11 §1.2); write a quoted string instead");
    }
    if (c === "." && this.src.startsWith("...", this.i)) {
      this.fail("spreads are not allowed in the meta block -- it must be a pure literal (WS-11 §1.2)");
    }
    if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();
    if (this.src.startsWith("true", this.i) && !isIdentChar(this.src[this.i + 4])) {
      this.i += 4;
      return true;
    }
    if (this.src.startsWith("false", this.i) && !isIdentChar(this.src[this.i + 5])) {
      this.i += 5;
      return false;
    }
    if (this.src.startsWith("null", this.i) && !isIdentChar(this.src[this.i + 4])) {
      this.i += 4;
      return null;
    }
    if (isIdentStart(c)) {
      // The single most important rejection: `name: n` and `name: f("x")` both land here. The message
      // names the offending token so an author can fix it without guessing.
      const word = this.readIdentifier();
      this.skipTrivia();
      const next = this.src[this.i];
      if (next === "(") {
        this.fail(`\`${word}(...)\` is a call expression -- the meta block must be a pure literal (WS-11 §1.2); inline the value instead`);
      }
      this.fail(`\`${word}\` is an identifier reference -- the meta block must be a pure literal (WS-11 §1.2); inline the value instead`);
    }
    this.fail(`unexpected \`${c}\` in the meta block -- it must be a pure literal (WS-11 §1.2)`);
  }

  private parseObject(): { [key: string]: Literal } {
    this.i++; // consume '{'
    const out: { [key: string]: Literal } = {};
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.i];
      if (c === undefined) this.fail("unbalanced meta object -- no closing `}`");
      if (c === "}") {
        this.i++;
        return out;
      }
      if (this.src.startsWith("...", this.i)) {
        this.fail("spreads are not allowed in the meta block -- it must be a pure literal (WS-11 §1.2)");
      }
      const key = c === '"' || c === "'" ? this.parseString(c) : isIdentStart(c) ? this.readIdentifier() : this.fail(`unexpected \`${c}\` where a meta key was expected -- the meta block must be a pure literal (WS-11 §1.2)`);
      this.skipTrivia();
      if (this.src[this.i] === "(") {
        this.fail(`\`${key}(...)\` is a method -- the meta block must be a pure literal (WS-11 §1.2)`);
      }
      if (this.src[this.i] !== ":") this.fail(`expected \`:\` after the meta key \`${key}\``);
      this.i++;
      out[key] = this.parseValue();
      this.skipTrivia();
      const sep = this.src[this.i];
      if (sep === ",") {
        this.i++;
        continue;
      }
      if (sep === "}") {
        this.i++;
        return out;
      }
      // An operator (`1 + 1`), a second value, anything at all: not a literal.
      if (sep === undefined) this.fail("unbalanced meta object -- no closing `}`");
      this.fail(`unexpected \`${sep}\` after the value of \`${key}\` -- the meta block must be a pure literal (WS-11 §1.2)`);
    }
  }

  private parseArray(): Literal[] {
    this.i++; // consume '['
    const out: Literal[] = [];
    for (;;) {
      this.skipTrivia();
      const c = this.src[this.i];
      if (c === undefined) this.fail("unbalanced meta array -- no closing `]`");
      if (c === "]") {
        this.i++;
        return out;
      }
      out.push(this.parseValue());
      this.skipTrivia();
      const sep = this.src[this.i];
      if (sep === ",") {
        this.i++;
        continue;
      }
      if (sep === "]") {
        this.i++;
        return out;
      }
      if (sep === undefined) this.fail("unbalanced meta array -- no closing `]`");
      this.fail(`unexpected \`${sep}\` inside a meta array -- the meta block must be a pure literal (WS-11 §1.2)`);
    }
  }

  /** Decodes escape sequences by SUBSTITUTION -- a plain character replacement, never evaluation. */
  private parseString(quote: string): string {
    this.i++; // consume the opening quote
    let out = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined || c === "\n") this.fail("unterminated string literal in the meta block");
      if (c === "\\") {
        const esc = this.src[this.i + 1];
        if (esc === undefined) this.fail("unterminated escape sequence in the meta block");
        out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc === "0" ? "\0" : esc;
        this.i += 2;
        continue;
      }
      if (c === quote) {
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
  }

  private parseNumber(): number {
    const start = this.i;
    if (this.src[this.i] === "-") this.i++;
    while (isDigit(this.src[this.i])) this.i++;
    if (this.src[this.i] === ".") {
      this.i++;
      while (isDigit(this.src[this.i])) this.i++;
    }
    if (this.src[this.i] === "e" || this.src[this.i] === "E") {
      this.i++;
      if (this.src[this.i] === "+" || this.src[this.i] === "-") this.i++;
      while (isDigit(this.src[this.i])) this.i++;
    }
    const text = this.src.slice(start, this.i);
    const value = Number(text);
    if (!Number.isFinite(value)) this.fail(`\`${text}\` is not a numeric literal`);
    return value;
  }

  private readIdentifier(): string {
    const start = this.i;
    while (isIdentChar(this.src[this.i])) this.i++;
    return this.src.slice(start, this.i);
  }
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127);
}
function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && (isIdentStart(c) || isDigit(c));
}

// --- The public surface --------------------------------------------------------------------------

// `export const|let|var meta =` -- matched with the assignment, so a mere mention of the word
// `meta` elsewhere in the script cannot be mistaken for the declaration. Norma's original matched a
// bare `meta = {`; requiring the declaration keyword is strictly narrower and matches WS-11 §1.2's
// own literal spelling ("Every script begins with `export const meta = {...}`").
const META_DECL_RE = /(?:^|[\s;}])export\s+(?:const|let|var)\s+meta\s*=\s*(?=\{)/m;

/**
 * Parses and validates a script's `meta` block.
 *
 * Never throws and never evaluates: every failure -- absent block, non-literal value, missing
 * required key, malformed `phases` -- comes back as `{ ok: false, error }`. The Workflow tool turns
 * that into a `WorkflowOutput` carrying `error` (derived-shapes-p5 item (g): a script that fails the
 * syntax check still RETURNS a WorkflowOutput, it does not throw).
 */
export function parseWorkflowMeta(source: string): ParsedWorkflowMeta {
  const match = META_DECL_RE.exec(source);
  if (match === null) {
    return { ok: false, error: "the script has no `export const meta = { ... }` block -- every workflow must declare one (WS-11 §1.2)" };
  }
  const braceStart = match.index + match[0].length;
  let literal: Literal;
  try {
    literal = new LiteralParser(source, braceStart).parseValue();
  } catch (err) {
    if (err instanceof LiteralParseError) return { ok: false, error: err.message };
    throw err;
  }
  if (typeof literal !== "object" || literal === null || Array.isArray(literal)) {
    return { ok: false, error: "the meta block must be an object literal (WS-11 §1.2)" };
  }
  const record = literal as Record<string, unknown>;
  if (typeof record["name"] !== "string" || record["name"] === "") {
    return { ok: false, error: "the meta block must declare `name` as a non-empty string literal (WS-11 §1.2)" };
  }
  if (typeof record["description"] !== "string" || record["description"] === "") {
    return { ok: false, error: "the meta block must declare `description` as a non-empty string literal -- it is what the permission dialog shows (WS-11 §1.2)" };
  }
  if (record["whenToUse"] !== undefined && typeof record["whenToUse"] !== "string") {
    return { ok: false, error: "meta.whenToUse must be a string literal when present (WS-11 §1.2)" };
  }
  const phasesError = validatePhases(record["phases"]);
  if (phasesError !== undefined) return { ok: false, error: phasesError };
  return { ok: true, meta: record as WorkflowMeta };
}

function validatePhases(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return "meta.phases must be an array of `{ title, detail?, model? }` objects (WS-11 §1.2)";
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return "meta.phases must be an array of `{ title, detail?, model? }` objects (WS-11 §1.2)";
    }
    const phase = entry as Record<string, unknown>;
    if (typeof phase["title"] !== "string" || phase["title"] === "") {
      return "every entry in meta.phases needs a non-empty string `title` -- titles are matched against `phase()` calls exactly (WS-11 §1.2)";
    }
    for (const key of ["detail", "model"] as const) {
      if (phase[key] !== undefined && typeof phase[key] !== "string") {
        return `meta.phases[].${key} must be a string literal when present (WS-11 §1.2)`;
      }
    }
  }
  return undefined;
}

/** The resolution of one `phase(title)` call against the declared phases. */
export interface PhaseGroup extends WorkflowMetaPhase {
  /** true when `title` matched a declared `meta.phases` entry EXACTLY. */
  declared: boolean;
}

/**
 * WS-11 §1.2's own rule, at the one point it actually applies -- when a `phase()` call arrives over
 * the bridge, not at parse time: "phase titles match `phase()` calls exactly; an unmatched `phase()`
 * call gets its own progress group."
 *
 * A near-miss is deliberately NOT fuzzy-matched to a declared phase: a script that mistypes a phase
 * title gets a visible extra group, which is a diagnosable outcome, rather than silently landing in
 * the wrong one.
 */
export function matchPhaseGroup(declared: readonly WorkflowMetaPhase[] | undefined, title: string): PhaseGroup {
  const hit = declared?.find((p) => p.title === title);
  if (hit === undefined) return { title, declared: false };
  return {
    title: hit.title,
    ...(hit.detail !== undefined ? { detail: hit.detail } : {}),
    ...(hit.model !== undefined ? { model: hit.model } : {}),
    declared: true,
  };
}
