// The recorded-corpus harness for the permission rule grammar, the file-rule pipeline and the
// path-safety predicates.
//
// It exists to prove that a rewrite of those modules changes NO decision. The corpus was recorded
// once, from the implementation as it stood before the rewrite, into
// `__fixtures__/rule-corpus.json`; `rule-corpus.differential.test.ts` recomputes every output from
// the current implementation and requires each one to be identical.
//
// Everything here is parameterised over the module namespaces (`CorpusModules`) rather than
// importing them, so the same input generators and the same output computation can be pointed at
// any two implementations side by side. Nothing in this file decides anything itself.
//
// Three kinds of input:
//   - CURATED inputs: the full output of each is recorded, so a mismatch shows the old and the new
//     value.
//   - HARVESTED inputs (every string literal of the permission and hook test files at recording
//     time, stored in the fixture because those files keep changing) and RANDOM inputs from a seeded
//     generator: one short digest per input is recorded.
//   - EXHAUSTIVE enumerations over a small alphabet: one digest per section is recorded.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------------------------
// The surface under test
// ---------------------------------------------------------------------------------------------

type Direction = "allow" | "denyAsk";

export interface CorpusModules {
  grammar: {
    parseRule(raw: string): unknown;
    matchesRule(rule: never, call: { toolName: string; input: Record<string, unknown> }, opts: { direction: Direction }): boolean;
    validatePermissionRuleString(raw: string, direction: "allow" | "deny" | "ask"): unknown;
    escapeRegExpLiteral(s: string): string;
  };
  fileRules: {
    resolveFileRuleAnchor(pattern: string, opts: { home: string; sourceDir?: string | undefined }): { relativePattern: string; root: unknown };
    resolveFileRuleAbsolutePath(pattern: string, opts: { cwd: string; home: string; sourceDir?: string }): string | undefined;
    resolveFileRuleAbsoluteGlobText(pattern: string, opts: { cwd: string; home: string; sourceDir?: string }): string | undefined;
    isGlobShapedFileRulePattern(text: string): boolean;
    normalizeFileRulePattern(p: string): string;
    unanchorTrailingDoubleStar(p: string, isAllow: boolean): string;
    matchFileRulesGrouped(candidates: readonly { entry: number; pattern: string; sourceDir?: string | undefined }[], path: string, opts: { cwd: string; home: string }, behavior: Direction): number | null;
    globToSbplRegexSource(glob: string): string;
    recursiveGlobToSbplRegexSource(glob: string): string;
    splitDenyPathsByGlobShape(paths: readonly string[]): unknown;
    globDenyEntriesOf(paths: readonly string[]): unknown;
    ancestorDirectoriesOf(path: string): string[];
    escapeFileRulePathSegment(path: string): string;
    isPathWithinRoot(child: string, root: string, opts?: { caseFold?: boolean }): boolean;
    canonicalizeTrustedSymlinkPath(path: string): string;
    resolvesWithinPluginRoot(candidate: string, root: string): boolean;
    isSuspiciousRealpathResolution(original: string, resolved: string): boolean;
  };
  paths: {
    resolveTargetPath(path: string, cwd: string): string;
    resolveSymlinkTargetChain(path: string): string | undefined;
    matchFileRule(pattern: string, opts: { path: string; cwd: string; home: string; direction: Direction; sourceDir?: string }): boolean;
  };
  evaluator: {
    isSuspiciousPath(path: string): boolean;
  };
}

// ---------------------------------------------------------------------------------------------
// Canonical serialisation and digests
// ---------------------------------------------------------------------------------------------

/**
 * A stable text form of any output: object keys sorted, a PRESENT `undefined` property kept (as
 * `{"$u":1}`) so "absent" and "present but undefined" stay distinct, symbols named, thrown errors
 * recorded by name and message.
 */
export function canon(value: unknown): string {
  return JSON.stringify(toPlain(value));
}

function toPlain(value: unknown): unknown {
  if (value === undefined) return { $u: 1 };
  if (typeof value === "symbol") return { $sym: value.description ?? "" };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toPlain);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = toPlain((value as Record<string, unknown>)[key]);
  return out;
}

function attempt(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (err) {
    const e = err as { name?: unknown; message?: unknown };
    return { $throw: String(e.name), message: String(e.message) };
  }
}

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex digits. Not cryptographic: a change detector. */
export function digest(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** A running digest over many records, so an exhaustive section never has to be held in memory. */
class RunningDigest {
  private parts: string[] = [];
  private count = 0;
  add(text: string): void {
    this.parts.push(digest(text));
    this.count++;
    if (this.parts.length >= 4096) this.parts = [digest(this.parts.join(""))];
  }
  done(): { count: number; digest: string } {
    return { count: this.count, digest: digest(this.parts.join("")) };
  }
}

// ---------------------------------------------------------------------------------------------
// Deterministic inputs
// ---------------------------------------------------------------------------------------------

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function joinTokens(rand: () => number, tokens: readonly string[], min: number, max: number): string {
  const n = min + Math.floor(rand() * (max - min + 1));
  let s = "";
  for (let i = 0; i < n; i++) s += pick(rand, tokens);
  return s;
}

/** Every string of length 0..maxLen over `alphabet`, each once, in a fixed order. */
function* enumerate(alphabet: readonly string[], maxLen: number): Generator<string> {
  yield "";
  let layer: string[] = [""];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const prefix of layer) {
      for (const ch of alphabet) {
        const s = prefix + ch;
        next.push(s);
        yield s;
      }
    }
    layer = next;
  }
}

const BOM = "\uFEFF";

/** Unicode whitespace the `\s` class covers, beyond the ASCII space. */
const UNICODE_SPACES = ["\t", "\n", "\r", "\v", "\f", "\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u3000", BOM];

const RULE_TOOL_PREFIXES = ["", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", "Skill", "Agent", "mcp__s__t", "mcp__s", "mcp__*", "bash", "read", "Cd", "NotebookRead", "Mcp_x", "a b", "*", "Bash*", "Task_x"];

const RULE_TOKENS = ["(", ")", "\\(", "\\)", "\\", "\\\\", "*", ":*", ":", " ", "a", "ls", "git", "domain:", "example.com", "http://", "?", "_", "-", "/", "~/", "//", "./", "..", "x:y", "true", "\u00e9", "\u{1F600}", "mcp__", "__", "Bash", "Read", "(*)", "()", "\t"];

export function randomRuleStrings(count: number, seed = 1): string[] {
  const rand = seededRandom(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const shape = rand();
    if (shape < 0.6) {
      out.push(pick(rand, RULE_TOOL_PREFIXES) + "(" + joinTokens(rand, RULE_TOKENS, 0, 6) + ")");
    } else if (shape < 0.75) {
      out.push(pick(rand, [" ", "", "\t"]) + pick(rand, RULE_TOOL_PREFIXES) + joinTokens(rand, RULE_TOKENS, 0, 5) + pick(rand, [" ", "", "\n"]));
    } else {
      out.push(joinTokens(rand, RULE_TOKENS, 0, 8));
    }
  }
  return out;
}

const PATTERN_TOKENS = ["/", "//", "~/", "./", "../", "*", "**", "**/", "/**", "?", "[", "]", "[a-z]", "[!a]", "[^a]", "[z-a]", "!", "#", "\\", "\\*", "\\?", "\\[", "\\]", "\\ ", ".", "..", "...", " ", "a", "b", "A", "src", ".env", "build", BOM, "x", "-", "~", "{a,b}", "(", ")", "\u00e9", "keep.txt", "sp "];

export function randomFilePatterns(count: number, seed = 2): string[] {
  const rand = seededRandom(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const lead = pick(rand, ["", "", "/", "//", "~/", "./", BOM, "!", "#"]);
    out.push(lead + joinTokens(rand, PATTERN_TOKENS, 1, 6));
  }
  return out;
}

const PATH_TOKENS = ["/", "/", "/", "a", "b", "A", ".", "..", "...", "....", " ", "  ", "~", "~0", "~1", "~12", "~9x", "\\", "?", "??", ":", "CON", "con", "NUL", "COM1", "COM0", "COM9", "LPT0", "LPT1", "LPT9", "AUX", "PRN", ".CON", ".nul", "tmp", "var", "private", "etc", "usr", "bin", "lib", "sbin", "x.", "x..", "x ", "x\t", "\u00a0", "\u3000", "[wip]", "*", "\u00e9", ".bashrc", "\\\\?\\", "//?/", "//./", "\\\\.\\"];

export function randomPaths(count: number, seed = 3): string[] {
  const rand = seededRandom(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const lead = pick(rand, ["/", "/", "", "/private/", "/tmp/", "/var/", "/private/tmp", "/private/var/", "\\", "//"]);
    out.push(lead + joinTokens(rand, PATH_TOKENS, 0, 7));
  }
  return out;
}

export const CURATED_RULE_STRINGS: readonly string[] = [
  "",
  " ",
  "Bash",
  "Bash()",
  "Bash(*)",
  "Bash( )",
  "Bash(ls)",
  "Bash(ls:*)",
  "Bash(ls *)",
  "Bash(:*)",
  "Bash(a:*b)",
  "Bash(a:*b:*)",
  "Bash(:*:*)",
  "Bash(a:*:*)",
  "Bash(:*a:*)",
  "Read(a:*b:*)",
  "Bash(git status:*)",
  "Bash(run_in_background:true)",
  "Bash(timeout:5)",
  "Bash(ls\\(x\\))",
  "Bash(echo \\\\)",
  "Bash(echo \\\\\\))",
  "Bash(echo (a))",
  "Bash(a\\)",
  "Bash(a)b",
  "Bash(a))",
  "Bash((a)",
  "Bash\\(a)",
  "Bash(\\(*\\))",
  "Read(//etc/passwd)",
  "Read(~/.ssh/**)",
  "Read(/src/**)",
  "Read(./.env)",
  "Read(.env)",
  "Read(src/**)",
  "Read(!src/keep.txt)",
  "Read(#x)",
  "Read(Project (old)/x)",
  "Read(Project \\(old\\)/x)",
  "Read(C:\\\\x)",
  "Read(foo:*)",
  "Grep(foo:*)",
  "Glob(foo:*)",
  "Write(src/**)",
  "NotebookEdit(x)",
  "Cd(x:*)",
  "Edit(sp\\ )",
  "WebFetch(domain:example.com)",
  "WebFetch(domain:*.example.com)",
  "WebFetch(domain:EXAMPLE.com.)",
  "WebFetch(domain:münchen.de)",
  "WebFetch(domain:example.com:8080)",
  "WebFetch(domain:example.com/docs)",
  "WebFetch(domain:[::1])",
  "WebFetch(https://example.com)",
  "WebFetch(http)",
  "WebFetch(example.com)",
  "WebFetch(DOMAIN:example.com)",
  "WebSearch",
  "WebSearch()",
  "WebSearch(*)",
  "WebSearch(query:x)",
  "WebSearch(a?b)",
  "WebSearch(cats)",
  "Skill(review:*)",
  "Skill(my-skill:*)",
  "Skill(.winter:review)",
  "Agent(model:opus)",
  "Agent(Explore)",
  "mcp__s__t",
  "mcp__s__t()",
  "mcp__s__t(x)",
  "mcp__s__*",
  "mcp__*",
  "mcp__*__t",
  "mcp__s*__t",
  "mcp__s",
  "mcp__",
  "mcp_s__t",
  "*",
  "Bash*",
  "B*h",
  "*(ls)",
  "bash(ls)",
  "read",
  "Task_x",
  "_x(y)",
  "(foo)",
  "()",
  "(",
  ")",
  "Read foo(bar)",
  " Bash(ls) ",
  "\tRead(x)\n",
  "Bash(ls) x",
  "Bash(\u00e9)",
  "\u00c9dit(x)",
  "Bash(a\\\\(b)",
];

export const CURATED_FILE_PATTERNS: readonly string[] = [
  "",
  "/",
  "//",
  "~",
  "~/",
  "./",
  ".",
  "..",
  "*",
  "**",
  "/**",
  "//**",
  "a",
  "a/",
  "a/**",
  "/a/**",
  "//a/**",
  "~/a/**",
  "./a/**",
  "a/b/**",
  "src/**",
  "src/*.ts",
  "**/*.ts",
  ".env",
  "./.env",
  "/.env",
  "//etc/passwd",
  "~/.ssh/**",
  "~/.ssh",
  "build",
  "build/",
  "!src/keep.txt",
  "#x",
  "\\!x",
  "\\#x",
  BOM + "a",
  BOM + "!a",
  BOM + "#a",
  BOM,
  BOM + BOM + "a",
  "a" + BOM,
  "a//b",
  "a///b/**",
  "  ",
  " /**",
  "[wip] app/**",
  "\\[wip\\] app/**",
  "[[]wip] app/**",
  "[z-a]",
  "[z-a]/x",
  "[abc",
  "[abc/x",
  "a?b",
  "a\\?b",
  "a\\*b",
  "sp ",
  "sp\\ ",
  "sp\\ \\ ",
  "a b/c",
  "..x/evil.sh",
  "../x",
  "x/../y",
  "{a,b}",
  "(x)",
  "\u00e9",
  "A",
  "SRC/**",
  "a/**/b",
  "a/**/**/b",
  "**/a",
  "!**/a",
  "!",
  "#",
  "__GLOBSTAR__",
  "a/__GLOBSTAR_SLASH__b/*",
  "**__GLOBSTAR__",
  "x/**/__GLOBSTAR_SLASH__",
  "a[b[c/*",
  "a]b[c",
  "***/x",
  "****/x",
  "*****/x",
  "***",
  "a\\*b/*",
  "a/**b/c",
  "a/b**/c",
];

export const CURATED_PATHS: readonly string[] = [
  "/w/proj/a",
  "/w/proj/A",
  "/w/proj/a/b/c/d",
  "/w/proj/src/a.ts",
  "/w/proj/src/sub/b.ts",
  "/w/proj/SRC/A.TS",
  "/w/proj/.env",
  "/w/proj/pkg/.env",
  "/w/proj/build",
  "/w/proj/build/out.js",
  "/w/proj/x/build/y",
  "/w/proj/keep.txt",
  "/w/proj/src/keep.txt",
  "/w/proj/[wip] app/f",
  "/w/proj/sp ",
  "/w/proj/sp",
  "/w/proj/sp  ",
  "/w/proj/a b/c",
  "/w/proj/..x/evil.sh",
  "/w/proj/~",
  "/w/proj/!x",
  "/w/proj/#x",
  "/w/proj/" + BOM + "a",
  "/w/proj/a?b",
  "/w/proj/a*b",
  "/w/proj/a\\b",
  "/w/proj/x.ts",
  "/w/proj/a.",
  "/w/proj/a/b",
  "/w/proj/a/x/b",
  "/w/proj/.git/config",
  "/w/proj/node_modules/x/y.js",
  "/w/proj/(x)",
  "/w/proj/\u00e9",
  "/w/proj/{a,b}",
  "/w/proj",
  "/w",
  "/w/other/a",
  "/h/.ssh/id",
  "/h/.ssh",
  "/h/a",
  "/h/a/b",
  "/etc/passwd",
  "/s/a",
  "/s/a/b",
  "/s/.env",
  "/",
  "/a",
  "/a/b",
  "/private/tmp/x",
  "/tmp/x",
  "/private/var/folders/x",
  "/var/folders/x",
  "/private/etc/hosts",
  "/etc/hosts",
  "/usr/bin/env",
  "/bin/env",
];

const BOUNDARY_ROOTS = ["/w/proj", "/W/PROJ", "/w/proj/", "/", "/w", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/w/pro", "/w/proj/a", "/w/[wip] app", "/private/etc", "/etc", "/Tmp", "/private/tmp/"];

const CALLS: readonly { toolName: string; input: Record<string, unknown> }[] = [
  { toolName: "Bash", input: { command: "ls" } },
  { toolName: "Bash", input: { command: "ls -la" } },
  { toolName: "Bash", input: { command: "ls(x)" } },
  { toolName: "Bash", input: { command: "git status" } },
  { toolName: "Bash", input: { command: "rm -rf /" } },
  { toolName: "Bash", input: { command: "a" } },
  { toolName: "Bash", input: { command: "a b" } },
  { toolName: "Bash", input: { command: "echo \\" } },
  { toolName: "Bash", input: { command: "echo (a)" } },
  { toolName: "Bash", input: { command: "" } },
  { toolName: "Bash", input: { command: "x:y" } },
  { toolName: "Bash", input: { command: "ls && rm x" } },
  { toolName: "Bash", input: { command: "ls", run_in_background: true } },
  { toolName: "Bash", input: { command: "\u00e9" } },
  { toolName: "Read", input: { file_path: "/w/proj/a" } },
  { toolName: "Edit", input: { file_path: "/w/proj/a" } },
  { toolName: "WebFetch", input: { url: "https://example.com/x", prompt: "p" } },
  { toolName: "WebFetch", input: { url: "https://docs.example.com/x", prompt: "p" } },
  { toolName: "WebFetch", input: { url: "https://xn--mnchen-3ya.de/", prompt: "p" } },
  { toolName: "WebFetch", input: { url: "http://[::1]:8080/", prompt: "p" } },
  { toolName: "WebFetch", input: { url: "file:///etc/passwd", prompt: "p" } },
  { toolName: "WebSearch", input: { query: "x" } },
  { toolName: "Agent", input: { model: "opus" } },
  { toolName: "Skill", input: { skill: "review" } },
  { toolName: "mcp__s__t", input: {} },
  { toolName: "mcp__s__x", input: {} },
  { toolName: "mcp__other__t", input: {} },
  { toolName: "a b", input: {} },
  { toolName: "Task_x", input: { command: "ls" } },
  { toolName: "*", input: { command: "ls" } },
];

const EXHAUSTIVE_CALLS = [0, 2, 7, 16, 21, 24].map((i) => CALLS[i]!);

// ---------------------------------------------------------------------------------------------
// Per-input outputs
// ---------------------------------------------------------------------------------------------

const RULE_DIRECTIONS = ["allow", "deny", "ask"] as const;
const MATCH_DIRECTIONS: readonly Direction[] = ["allow", "denyAsk"];
const FILE_CTX = { cwd: "/w/proj", home: "/h" };

function matchBits(m: CorpusModules, parsed: unknown, calls: readonly { toolName: string; input: Record<string, unknown> }[]): string {
  let bits = "";
  for (const call of calls) {
    for (const direction of MATCH_DIRECTIONS) {
      const r = attempt(() => m.grammar.matchesRule(parsed as never, call, { direction }));
      bits += r === true ? "1" : r === false ? "0" : "E";
    }
  }
  return bits;
}

/** Everything the rule grammar answers about one rule string. */
export function ruleStringOutput(m: CorpusModules, raw: string, calls: "all" | "few" | "none" = "all"): unknown {
  const parsed = attempt(() => m.grammar.parseRule(raw));
  const out: Record<string, unknown> = { parse: parsed };
  for (const d of RULE_DIRECTIONS) out[`validate_${d}`] = attempt(() => m.grammar.validatePermissionRuleString(raw, d));
  if (calls !== "none") out["match"] = matchBits(m, parsed, calls === "all" ? CALLS : EXHAUSTIVE_CALLS);
  return out;
}

function anchorOf(m: CorpusModules, pattern: string, sourceDir?: string): unknown {
  return attempt(() => m.fileRules.resolveFileRuleAnchor(pattern, sourceDir === undefined ? { home: "/h" } : { home: "/h", sourceDir }));
}

/** The pure pattern transforms for one file-rule pattern (no matching). */
export function patternTransformOutput(m: CorpusModules, pattern: string): unknown {
  return {
    anchor: anchorOf(m, pattern),
    anchorSourced: anchorOf(m, pattern, "/s"),
    normalized: attempt(() => m.fileRules.normalizeFileRulePattern(pattern)),
    unanchorAllow: attempt(() => m.fileRules.unanchorTrailingDoubleStar(pattern, true)),
    unanchorDeny: attempt(() => m.fileRules.unanchorTrailingDoubleStar(pattern, false)),
    pipelineAllow: attempt(() => m.fileRules.unanchorTrailingDoubleStar(m.fileRules.normalizeFileRulePattern(pattern), true)),
    pipelineDeny: attempt(() => m.fileRules.unanchorTrailingDoubleStar(m.fileRules.normalizeFileRulePattern(pattern), false)),
    globShaped: attempt(() => m.fileRules.isGlobShapedFileRulePattern(pattern)),
    escaped: attempt(() => m.fileRules.escapeFileRulePathSegment(pattern)),
  };
}

/** Everything the file-rule layer answers about one pattern, including its decision on every path. */
export function filePatternOutput(m: CorpusModules, pattern: string, paths: readonly string[] = CURATED_PATHS): unknown {
  const decisions: Record<string, string> = {};
  for (const sourceDir of [undefined, "/s"]) {
    for (const direction of MATCH_DIRECTIONS) {
      let bits = "";
      for (const path of paths) {
        const r = attempt(() => m.fileRules.matchFileRulesGrouped([{ entry: 7, pattern, sourceDir }], path, FILE_CTX, direction));
        bits += r === 7 ? "1" : r === null ? "0" : "E";
      }
      decisions[`${direction}${sourceDir === undefined ? "" : "_sourced"}`] = bits;
    }
  }
  let legacy = "";
  for (const direction of MATCH_DIRECTIONS) {
    for (const path of paths) {
      const r = attempt(() => m.paths.matchFileRule(pattern, { path, ...FILE_CTX, direction }));
      legacy += r === true ? "1" : r === false ? "0" : "E";
    }
  }
  return {
    ...(patternTransformOutput(m, pattern) as Record<string, unknown>),
    absPath: attempt(() => m.fileRules.resolveFileRuleAbsolutePath(pattern, FILE_CTX)),
    absPathSourced: attempt(() => m.fileRules.resolveFileRuleAbsolutePath(pattern, { ...FILE_CTX, sourceDir: "/s" })),
    absGlob: attempt(() => m.fileRules.resolveFileRuleAbsoluteGlobText(pattern, FILE_CTX)),
    absGlobSourced: attempt(() => m.fileRules.resolveFileRuleAbsoluteGlobText(pattern, { ...FILE_CTX, sourceDir: "/s" })),
    decisions,
    legacyMatchFileRule: legacy,
  };
}

/** A group of candidates matched together: which entry wins for each path, or the throw. */
export function groupOutput(m: CorpusModules, group: readonly { pattern: string; sourceDir?: string }[], paths: readonly string[] = CURATED_PATHS): unknown {
  const candidates = group.map((g, i) => ({ entry: i, pattern: g.pattern, sourceDir: g.sourceDir }));
  const out: Record<string, unknown[]> = {};
  for (const direction of MATCH_DIRECTIONS) {
    out[direction] = paths.map((path) => attempt(() => m.fileRules.matchFileRulesGrouped(candidates, path, FILE_CTX, direction)));
  }
  return out;
}

/** An absolute deny-path glob's sandbox renderings. Callers use roots that do not exist, so canonicalisation is the identity. */
export function sandboxGlobOutput(m: CorpusModules, absolute: string): unknown {
  return {
    regex: attempt(() => m.fileRules.globToSbplRegexSource(absolute)),
    recursive: attempt(() => m.fileRules.recursiveGlobToSbplRegexSource(absolute)),
    split: attempt(() => m.fileRules.splitDenyPathsByGlobShape([absolute])),
    entries: attempt(() => m.fileRules.globDenyEntriesOf([absolute])),
  };
}

/** The path predicates for one path. */
export function pathOutput(m: CorpusModules, path: string): unknown {
  const within: Record<string, string> = {};
  for (const [label, opts] of [["default", undefined], ["fold", { caseFold: true }], ["exact", { caseFold: false }]] as const) {
    let bits = "";
    for (const root of BOUNDARY_ROOTS) {
      const r = attempt(() => m.fileRules.isPathWithinRoot(path, root, opts));
      bits += r === true ? "1" : r === false ? "0" : "E";
    }
    within[label] = bits;
  }
  return {
    suspicious: attempt(() => m.evaluator.isSuspiciousPath(path)),
    ancestors: attempt(() => m.fileRules.ancestorDirectoriesOf(path)),
    trustedAlias: attempt(() => m.fileRules.canonicalizeTrustedSymlinkPath(path)),
    resolvedTarget: attempt(() => m.paths.resolveTargetPath(path, "/w/proj")),
    escaped: attempt(() => m.fileRules.escapeFileRulePathSegment(path)),
    escapedRegExp: attempt(() => m.grammar.escapeRegExpLiteral(path)),
    within,
  };
}

// ---------------------------------------------------------------------------------------------
// The filesystem fixture (symlink chains, the plugin-root fence, prefix canonicalisation)
// ---------------------------------------------------------------------------------------------

export interface FsFixture {
  root: string;
  dispose(): void;
}

/** Builds the same tree every time under a fresh temporary directory; `root` is already realpath'd. */
export function buildFsFixture(): FsFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rule-corpus-")));
  const at = (p: string): string => join(root, p);
  for (const d of ["dir", "dir/sub", "plugin", "plugin/agents", "outside", "case/Dir", "deep/a/b/c"]) mkdirSync(at(d), { recursive: true });
  for (const f of ["dir/file", "dir/sub/leaf", "plugin/agents/a.md", "outside/x", "deep/a/b/c/f"]) writeFileSync(at(f), "x");
  const links: [string, string][] = [
    ["link-to-dir", "dir"],
    ["link-to-file", "dir/file"],
    ["abs-to-dir", at("dir")],
    ["dangling", "missing/leaf"],
    ["dangling-rel", "../nowhere/x"],
    ["chain1", "chain2"],
    ["chain2", "chain3"],
    ["chain3", "dir/file"],
    ["dchain1", "dchain2"],
    ["dchain2", "dchain3"],
    ["dchain3", "missing-end"],
    ["loop-a", "loop-b"],
    ["loop-b", "loop-a"],
    ["up", ".."],
    ["to-root", "/"],
    ["to-dir-missing-child", "dir/not-yet/deeper"],
    ["dir/inner-link", "../dir/file"],
    ["dir/sub/up2", "../../outside"],
    ["plugin/link-out", "../outside"],
    ["plugin/sym-in", "agents"],
    ["plugin/dangling-out", "../outside/missing"],
    ["plugin/abs-out", at("outside")],
    ["deep/a/b/c/rel", "../../../../dir"],
    ["dir-link-dangling-chain", "dchain1/child"],
  ];
  for (const [link, target] of links) symlinkSync(target, at(link));
  // A dangling chain longer than any hop limit, and a shorter one that ends on a real file.
  for (let i = 0; i < 45; i++) symlinkSync(i === 44 ? "long-missing" : `long${i + 1}`, at(`long${i}`));
  for (let i = 0; i < 20; i++) symlinkSync(i === 19 ? "dir/file" : `short${i + 1}`, at(`short${i}`));
  // Dangling chains of exactly 39 and 40 links, either side of the chain resolver's step limit: the
  // 39-link chain still reports its missing end, the 40-link one gives up.
  for (const length of [39, 40]) {
    for (let i = 0; i < length; i++) symlinkSync(i === length - 1 ? `d${length}-missing` : `d${length}-${i + 1}`, at(`d${length}-${i}`));
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const FS_CHAIN_QUERIES = [
  "",
  "dir",
  "dir/file",
  "dir/missing",
  "dir/missing/deeper",
  "link-to-dir",
  "link-to-dir/file",
  "link-to-dir/new",
  "link-to-dir/new/deeper",
  "link-to-file",
  "abs-to-dir/sub/leaf",
  "dangling",
  "dangling/child",
  "dangling-rel",
  "chain1",
  "chain1/x",
  "dchain1",
  "dchain1/x",
  "loop-a",
  "loop-a/x",
  "up",
  "up/x",
  "to-root",
  "to-root/etc",
  "to-dir-missing-child",
  "dir/inner-link",
  "dir/sub/up2",
  "dir/sub/up2/x",
  "dir/sub/up2/new",
  "plugin/link-out",
  "plugin/dangling-out",
  "deep/a/b/c/rel",
  "deep/a/b/c/rel/file",
  "dir-link-dangling-chain",
  "long0",
  "long5",
  "long40",
  "long43",
  "long44",
  "short0",
  "short10",
  "d39-0",
  "d39-0/child",
  "d39-1",
  "d40-0",
  "d40-0/child",
  "nothing-here",
  "nothing-here/at/all",
  "case/dir",
  "case/Dir",
  "./dir",
  "dir/../outside",
];

const PLUGIN_ROOTS = ["plugin", "plugin/", "PLUGIN", "plugin/agents", "missing-plugin", "link-to-dir"];

const PLUGIN_CANDIDATES = [
  "plugin",
  "plugin/agents",
  "plugin/agents/a.md",
  "plugin/../outside",
  "plugin/link-out",
  "plugin/link-out/x",
  "plugin/sym-in",
  "plugin/sym-in/a.md",
  "plugin/dangling-out",
  "plugin/abs-out",
  "plugin/missing/x",
  "plugin/..x/agents",
  "plugin/a\\b",
  "plugin/AGENTS",
  "outside",
  "loop-a",
  "plugin/../plugin/agents",
  "PLUGIN/agents",
  "dir/file",
];

const FS_GLOBS = [
  "link-to-dir/*.ts",
  "link-to-dir/**",
  "dir/**",
  "dir/sub/*",
  "up/x/*",
  "to-root/*",
  "to-root/etc/*",
  "dangling/*",
  "dangling-rel/a/*",
  "chain1/*",
  "dir/sub/up2/*",
  "deep/a/b/c/rel/*",
  "plugin/link-out/**",
  "[[]wip]/x/*",
  "dir/[s]ub/*",
  "dir/sub/leaf",
  "link-to-dir",
  "*",
  "*/x",
  "d?r/x",
  "dir/sub/[!a]*",
];

/** Replaces the fixture root, and then its parent directory, with fixed names in every string of `value`. */
function withPlaceholder(value: unknown, root: string): unknown {
  let text = canon(value);
  for (const [location, name] of [[root, "<ROOT>"], [dirname(root), "<TMP>"]] as const) {
    const escaped = location.replace(/[.^$+{}()|\\[\]*?]/g, "\\$&");
    text = text.split(JSON.stringify(escaped).slice(1, -1)).join(name).split(JSON.stringify(location).slice(1, -1)).join(name);
  }
  return JSON.parse(text);
}

/** The filesystem-dependent answers, with the fixture's own location replaced by `<ROOT>`. */
export function fsOutputs(m: CorpusModules, fixture: FsFixture): Record<string, unknown> {
  const { root } = fixture;
  const at = (p: string): string => (p === "" ? root : `${root}/${p}`);
  const out: Record<string, unknown> = {};
  for (const q of FS_CHAIN_QUERIES) out[`chain:${q}`] = withPlaceholder(attempt(() => m.paths.resolveSymlinkTargetChain(at(q))), root);
  for (const pluginRoot of PLUGIN_ROOTS) {
    for (const c of PLUGIN_CANDIDATES) out[`plugin:${pluginRoot}:${c}`] = attempt(() => m.fileRules.resolvesWithinPluginRoot(at(c), at(pluginRoot)));
  }
  for (const g of FS_GLOBS) out[`glob:${g}`] = withPlaceholder(sandboxGlobOutput(m, at(g)), root);
  for (const q of FS_CHAIN_QUERIES) {
    out[`suspicious-resolution:${q}`] = withPlaceholder(
      attempt(() => {
        const resolved = m.paths.resolveSymlinkTargetChain(at(q));
        return resolved === undefined ? undefined : m.fileRules.isSuspiciousRealpathResolution(at(q), resolved);
      }),
      root,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Random groups and the exhaustive sections
// ---------------------------------------------------------------------------------------------

export function randomGroups(count: number, patterns: readonly string[], seed = 4): { pattern: string; sourceDir?: string }[][] {
  const rand = seededRandom(seed);
  const out: { pattern: string; sourceDir?: string }[][] = [];
  for (let i = 0; i < count; i++) {
    const n = 2 + Math.floor(rand() * 3);
    const group: { pattern: string; sourceDir?: string }[] = [];
    for (let j = 0; j < n; j++) group.push(rand() < 0.3 ? { pattern: pick(rand, patterns), sourceDir: "/s" } : { pattern: pick(rand, patterns) });
    out.push(group);
  }
  return out;
}

export function randomResolutionPairs(count: number, seed = 5): [string, string][] {
  const rand = seededRandom(seed);
  const pool = ["/", "/a", "/a/b", "/a/b/c", "/tmp", "/tmp/", "/tmp/x", "/tmp/x/y", "/private/tmp/x", "/private/tmp/x/y", "/private/tmp", "/var/x", "/private/var/x", "/var/x/y", "/private/var/x/y", "/private/var", "/private", "/x", "/x/y", "/w/proj", "/w/proj/a", "/w/other", "/w", "/w/proj/../a", "/w//proj", "/w/proj/", "/w/proj/./a", "a", "a/b", ".", "", "/tmp/../etc", "/varx/y", "/tmpx/y", "/private/tmpx/y"];
  const out: [string, string][] = [];
  for (const a of pool) for (const b of pool) out.push([a, b]);
  for (let i = 0; i < count; i++) {
    const a = pick(rand, pool) + pick(rand, ["", "/z", "/z/q", "/", "/.."]);
    const b = pick(rand, pool) + pick(rand, ["", "/z", "/z/q", "/", "/.."]);
    out.push([a, b]);
  }
  return out;
}

export interface ExhaustiveSection {
  count: number;
  digest: string;
}

/** Every rule string over a small alphabet after each tool prefix: parse, validate (3 ways), a few matches. */
export function exhaustiveRuleSection(m: CorpusModules, maxLen = 5): ExhaustiveSection {
  const alphabet = ["\\", "(", ")", "a", "*", ":", " "];
  const run = new RunningDigest();
  for (const prefix of ["", "Bash", "Read", "WebFetch", "WebSearch", "mcp__s__t", "bash", "Skill", "Grep"]) {
    for (const tail of enumerate(alphabet, maxLen)) {
      const raw = prefix + tail;
      run.add(raw + "\u0000" + canon(ruleStringOutput(m, raw, prefix === "" || prefix === "Bash" ? "few" : "none")));
    }
  }
  // The same tails as CONTENT: `Tool(<tail>)`, longer, so content-level checks (`:*` placement,
  // escapes inside the parens, empty and `*` content) are enumerated too.
  for (const prefix of ["Bash(", "Read(", "WebFetch(", "WebSearch(", "mcp__s__t(", "Cd("]) {
    for (const tail of enumerate(alphabet, maxLen + 1)) {
      const raw = prefix + tail + ")";
      run.add(raw + "\u0000" + canon(ruleStringOutput(m, raw, "none")));
    }
  }
  return run.done();
}

/** Every pattern over a small alphabet: anchor, BOM/directive normalisation and the trailing-globstar rewrite. */
export function exhaustivePatternSection(m: CorpusModules, maxLen = 6): ExhaustiveSection {
  const alphabet = ["/", "*", "!", "#", BOM, ".", " ", "a", "~"];
  const run = new RunningDigest();
  for (const p of enumerate(alphabet, maxLen)) run.add(p + "\u0000" + canon(patternTransformOutput(m, p)));
  return run.done();
}

/** Every path over a small alphabet: the suspicious-path predicate and the path-to-pattern escaper. */
export function exhaustivePathSection(m: CorpusModules, maxLen = 5): ExhaustiveSection {
  const alphabet = ["/", "\\", ".", "~", "0", "1", " ", "?", "N", "C", "O", ":", "\u00a0"];
  const run = new RunningDigest();
  for (const p of enumerate(alphabet, maxLen)) {
    run.add(p + "\u0000" + canon([attempt(() => m.evaluator.isSuspiciousPath(p)), attempt(() => m.fileRules.escapeFileRulePathSegment(p)), attempt(() => m.grammar.escapeRegExpLiteral(p))]));
  }
  for (const space of UNICODE_SPACES) {
    for (const p of ["a" + space, "a" + space + space, space, "a" + space + "b", "/x" + space + "/y", "x." + space]) {
      run.add(p + "\u0000" + canon([attempt(() => m.evaluator.isSuspiciousPath(p)), attempt(() => m.fileRules.escapeFileRulePathSegment(p))]));
    }
  }
  return run.done();
}

/** Every pair of a small path set through the boundary and resolution-guard predicates. */
export function exhaustiveBoundarySection(m: CorpusModules): ExhaustiveSection {
  const pool = [...new Set([...BOUNDARY_ROOTS, ...CURATED_PATHS.slice(0, 60), "/W/Proj/a", "/w/proj/../proj/a", "/w/proj/./a", "w/proj", "", ".", "..", "/w/proj/..", "/w/proj/..a", "/private/tmp", "/tmp/", "/private/var/folders", "/private/var/", "/var/"])];
  const run = new RunningDigest();
  for (const a of pool) {
    for (const b of pool) {
      run.add(a + "\u0000" + b + "\u0000" + canon([
        attempt(() => m.fileRules.isPathWithinRoot(a, b)),
        attempt(() => m.fileRules.isPathWithinRoot(a, b, { caseFold: false })),
        attempt(() => m.fileRules.isSuspiciousRealpathResolution(a, b)),
      ]));
    }
  }
  return run.done();
}

// ---------------------------------------------------------------------------------------------
// The whole corpus
// ---------------------------------------------------------------------------------------------

export const RANDOM_COUNTS = { rules: 6000, patterns: 2500, groups: 1200, paths: 4000, globs: 2500, resolutionPairs: 6000 } as const;

export interface CorpusInputs {
  /** String literals of the permission test files at recording time. */
  harvested: string[];
}

export interface RecordedCorpus {
  inputs: CorpusInputs;
  /** Full outputs for the curated inputs, keyed `<section>:<input>`. */
  full: Record<string, unknown>;
  /** One digest per random input, keyed by section, in generation order. */
  random: Record<string, string[]>;
  exhaustive: Record<string, ExhaustiveSection>;
  fs: Record<string, unknown>;
}

const SANDBOX_ROOT = "/nonexistent-rule-corpus-root";

export function computeCorpus(m: CorpusModules, inputs: CorpusInputs): RecordedCorpus {
  const full: Record<string, unknown> = {};
  for (const r of CURATED_RULE_STRINGS) full[`rule:${r}`] = ruleStringOutput(m, r);
  for (const p of CURATED_FILE_PATTERNS) full[`pattern:${p}`] = filePatternOutput(m, p);
  for (const p of CURATED_PATHS) full[`path:${p}`] = pathOutput(m, p);
  for (const p of CURATED_FILE_PATTERNS) full[`sandbox:${p}`] = sandboxGlobOutput(m, `${SANDBOX_ROOT}/${p}`);

  const random: Record<string, string[]> = {};
  random["harvestedRules"] = inputs.harvested.map((r) => digest(canon(ruleStringOutput(m, r))));
  random["harvestedPatterns"] = inputs.harvested.map((p) => digest(canon(patternTransformOutput(m, p))));
  random["harvestedPaths"] = inputs.harvested.map((p) => digest(canon(pathOutput(m, p))));
  random["harvestedSandbox"] = inputs.harvested.map((p) => digest(canon(sandboxGlobOutput(m, `${SANDBOX_ROOT}/${p}`))));
  random["rules"] = randomRuleStrings(RANDOM_COUNTS.rules).map((r) => digest(canon(ruleStringOutput(m, r))));
  const randomPatterns = randomFilePatterns(RANDOM_COUNTS.patterns);
  random["patterns"] = randomPatterns.map((p) => digest(canon(filePatternOutput(m, p))));
  random["groups"] = randomGroups(RANDOM_COUNTS.groups, [...CURATED_FILE_PATTERNS, ...randomPatterns.slice(0, 400)]).map((g) => digest(canon(groupOutput(m, g))));
  random["paths"] = randomPaths(RANDOM_COUNTS.paths).map((p) => digest(canon(pathOutput(m, p))));
  random["globs"] = randomFilePatterns(RANDOM_COUNTS.globs, 6).map((p) => digest(canon(sandboxGlobOutput(m, `${SANDBOX_ROOT}/${p}`))));
  random["resolutionPairs"] = randomResolutionPairs(RANDOM_COUNTS.resolutionPairs).map(([a, b]) => digest(canon(attempt(() => m.fileRules.isSuspiciousRealpathResolution(a, b)))));

  const exhaustive: Record<string, ExhaustiveSection> = {
    rules: exhaustiveRuleSection(m),
    patterns: exhaustivePatternSection(m),
    paths: exhaustivePathSection(m),
    boundary: exhaustiveBoundarySection(m),
  };

  const fixture = buildFsFixture();
  try {
    return { inputs, full, random, exhaustive, fs: fsOutputs(m, fixture) };
  } finally {
    fixture.dispose();
  }
}

/** The number of individual outputs a corpus compares, for reporting. */
export function corpusSize(c: RecordedCorpus): { full: number; random: number; exhaustive: number; fs: number } {
  return {
    full: Object.keys(c.full).length,
    random: Object.values(c.random).reduce((n, list) => n + list.length, 0),
    exhaustive: Object.values(c.exhaustive).reduce((n, s) => n + s.count, 0),
    fs: Object.keys(c.fs).length,
  };
}
