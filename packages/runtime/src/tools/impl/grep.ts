// WS-06 §3.1 "Grep" -- the real executor (Phase 3, Lane A / Task 4). Registers over the stub
// descriptors/grep.ts already put in the registry.
//
// *** T8 SCHEMA-SWEEP NOTE (flag in task-4-report.md) ***
// The INPUT flag surface is pinned verbatim and implemented in full. The RESULT shape ("structured
// result: mode, files, content/counts, applied limit/offset") is prose-only; this file's own
// `GrepResult`/`GrepContentRow` types (below) are the chosen minimal-honest JSON shape, always
// returned as `ToolResultPayload.output` (JSON.stringify'd -- there is no ambiguity with a "plain
// text" result the way Read has, since Grep's result was never going to be plain text). Judgment
// calls made here, none pinned anywhere in scope:
//   - `output_mode` DEFAULT: "files_with_matches" (this task's own recollection of Claude Code's
//     real Grep tool default; WS-06 pins the enum, not the default).
//   - `line` (the JSON row's line-number field) is present ONLY when `-n` is truthy -- otherwise
//     omitted entirely, giving `-n` an observable effect on the STRUCTURED shape too (not just on
//     an imagined "-n:42:text" textual prefix that a JSON result has no use for).
//   - `-C`/`context` are equivalent context-radius inputs; when both `-B`/`-A` (directional) AND
//     `-C`/`context` (radius) are given, `-B`/`-A` win for their own direction. When both `-C` and
//     `context` are given, `-C` wins (arbitrary tie-break, documented here).
//   - `head_limit` counts ROWS OF THE ACTIVE MODE, INCLUDING context rows in content mode (not just
//     match rows) -- the literal reading of "counts rows," matching a plain line-based head/tail.
//   - `-o` in content mode: one row per match (text = matched substring) instead of one row per
//     matching line (text = full line). Ignored in files_with_matches/count (spec: "context/line-
//     number options only matter for content" -- read as covering `-o` too, since it has no
//     meaning without per-row text).
//   - `count` mode counts DISTINCT MATCHING LINES per file (ripgrep's own `--count` default), not
//     total match occurrences (`--count-matches`) -- there is no separate flag for the latter in
//     this pinned schema.
//   - `multiline` scans the WHOLE FILE as one string (flags "gs", `s`=dotAll so `.` crosses
//     newlines) and reports one row per match, `line` = the match's STARTING line. Context (-B/-A/
//     -C/context) is NOT composed with `multiline` in this implementation (accepted without error,
//     silently inert) -- a deliberate scope cut, not an oversight; composing whole-file regex
//     matches with per-line context windows is a real feature with real edge cases (overlapping
//     multi-line matches, context rows that are themselves inside another match's span) that this
//     lane chose not to gold-plate. Flagged for T8/whichever task next touches Grep.
//   - File/row ORDER: alphabetical by absolute path (files_with_matches/count), then by ascending
//     line index within a file (content) -- ripgrep's own real traversal order is filesystem/OS-
//     dependent and therefore untestable; alphabetical is deterministic and pinned by tests here.
//   - `type` names an intentionally SMALL, hand-rolled extension map (not ripgrep's real ~700-type
//     registry) -- an unrecognized `type` errors, naming the supported set.
//   - Per-file size cap AND wall-clock scan deadline are BOTH internal-only (the schema is pinned
//     law, no new input field): a pattern length cap (1000 chars); a disclosed per-file byte cap
//     (`GREP_MAX_FILE_BYTES`, mirrors read.ts's own `IMAGE_MAX_BYTES` pattern -- a named, documented
//     threshold, not a silent one) that SKIPS an oversized file outright, checked via `statSync`
//     BEFORE any read -- fix-round-1 finding: the original version read+`.toString("utf8")`'d every
//     candidate file unconditionally, so an oversized file's failure mode was whatever exception
//     that produced, silently swallowed by the per-file `catch { continue; }` and never reflected
//     anywhere in the result (a scan that silently dropped a huge candidate file read as "complete"
//     to the caller). Skips are now counted in `skippedOversized` and force `truncated: true` --
//     the result is honestly incomplete, not silently wrong. A wall-clock scan deadline (5s) that
//     halts scanning further FILES BETWEEN iterations of the main per-candidate-file loop, also
//     forcing `truncated: true`.
//     NEITHER mechanism is a general ReDoS defense, despite the earlier header wording here (also a
//     fix-round-1 correction) -- the deadline bounds neither `discoverCandidateFiles` itself (the
//     initial file-listing walk, unbounded) nor a single pathological regex evaluation against one
//     already-read file's content: a catastrophic-backtracking `pattern` run via `.test()`/
//     `.matchAll()` inside `scanFileLineByLine`/`scanFileMultiline` can still hang past the
//     deadline, since the deadline is only checked BETWEEN whole files, never inside one. The
//     pattern-length cap is the only actual ReDoS-adjacent mitigation, and it is a weak one (bounds
//     pattern size, not worst-case engine behavior on a given input).
//   - Binary files (a NUL byte in the first 8000 bytes) are silently skipped, matching common
//     grep/ripgrep default behavior -- including when directly named via `path` (a directly-named
//     file bypasses gitignore/hidden-file rules, per spec, but binary detection is a content
//     property, not an "ignore rule," so it still applies).
//
// Ignore-rule scope (gitignore): hand-rolled, NOT a shell-out to `git` (fixtures are mkdtemp
// non-repos; macOS's own /usr/bin/git is a Command-Line-Tools install shim on a clean machine).
// Subset implemented: comments/blank lines, `!` negation, a leading `/` anchor, a trailing `/`
// (directory-only, treated as "everything under this directory"), `*`/`?`/`**` wildcards, nested
// per-directory .gitignore files with a deeper file's rules evaluated AFTER (and so able to
// override) a shallower one, last-matching-rule-wins. The search root is treated AS the repository
// root for this purpose -- this never walks upward past it (both a deliberate test-isolation
// property and advisor-reviewed: walking up risks escaping an mkdtemp fixture tree into real host
// directories). No global/`~/.gitignore` support. `.git/` itself is excluded from traversal for
// free by the SAME hidden-file default (`dot: false`) that makes Grep "ripgrep-style" in the first
// place -- verified empirically (Bun.Glob's default scan already skips any dot-prefixed path
// component) rather than added as a second, redundant hardcoded check.
import "../descriptors/index.ts";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { replaceExecutor, type ToolExecutionContext, type ToolExecutor, type ToolResultPayload } from "../registry.ts";
import { emptyPathSet, type ExtractedPaths } from "../paths-seam.ts";

// --- Input (WS-06 §3.1, verbatim) -------------------------------------------------------------------

type OutputMode = "content" | "files_with_matches" | "count";

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: OutputMode;
  before?: number; // "-B"
  after?: number; // "-A"
  contextDash?: number; // "-C"
  context?: number;
  showLineNumbers?: boolean; // "-n"
  caseInsensitive?: boolean; // "-i"
  onlyMatch?: boolean; // "-o"
  type?: string;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

const OUTPUT_MODES: readonly OutputMode[] = ["content", "files_with_matches", "count"];
const MAX_PATTERN_LENGTH = 1000;

function parseInput(raw: unknown): GrepInput {
  if (typeof raw !== "object" || raw === null) throw new Error("input must be an object");
  const o = raw as Record<string, unknown>;
  const pattern = o["pattern"];
  if (typeof pattern !== "string" || pattern.length === 0) throw new Error("pattern must be a non-empty string");
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit`);

  const path = o["path"];
  if (path !== undefined && typeof path !== "string") throw new Error("path must be a string");
  const glob = o["glob"];
  if (glob !== undefined && typeof glob !== "string") throw new Error("glob must be a string");
  const outputMode = o["output_mode"];
  if (outputMode !== undefined && (typeof outputMode !== "string" || !OUTPUT_MODES.includes(outputMode as OutputMode))) {
    throw new Error(`output_mode must be one of ${OUTPUT_MODES.join(", ")}`);
  }
  const before = o["-B"];
  const after = o["-A"];
  const contextDash = o["-C"];
  const context = o["context"];
  const showLineNumbers = o["-n"];
  const caseInsensitive = o["-i"];
  const onlyMatch = o["-o"];
  const type = o["type"];
  const headLimit = o["head_limit"];
  const offset = o["offset"];
  const multiline = o["multiline"];
  for (const [key, value] of [
    ["-B", before],
    ["-A", after],
    ["-C", contextDash],
    ["context", context],
    ["head_limit", headLimit],
    ["offset", offset],
  ] as const) {
    if (value !== undefined && typeof value !== "number") throw new Error(`${key} must be a number`);
  }
  for (const [key, value] of [
    ["-n", showLineNumbers],
    ["-i", caseInsensitive],
    ["-o", onlyMatch],
    ["multiline", multiline],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  }
  if (type !== undefined && typeof type !== "string") throw new Error("type must be a string");

  return {
    pattern,
    ...(path !== undefined ? { path } : {}),
    ...(glob !== undefined ? { glob } : {}),
    ...(outputMode !== undefined ? { output_mode: outputMode as OutputMode } : {}),
    ...(before !== undefined ? { before: before as number } : {}),
    ...(after !== undefined ? { after: after as number } : {}),
    ...(contextDash !== undefined ? { contextDash: contextDash as number } : {}),
    ...(context !== undefined ? { context: context as number } : {}),
    ...(showLineNumbers !== undefined ? { showLineNumbers: showLineNumbers as boolean } : {}),
    ...(caseInsensitive !== undefined ? { caseInsensitive: caseInsensitive as boolean } : {}),
    ...(onlyMatch !== undefined ? { onlyMatch: onlyMatch as boolean } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(headLimit !== undefined ? { head_limit: headLimit as number } : {}),
    ...(offset !== undefined ? { offset: offset as number } : {}),
    ...(multiline !== undefined ? { multiline: multiline as boolean } : {}),
  };
}

// --- Result shape (see T8 SCHEMA-SWEEP NOTE above) --------------------------------------------------

export interface GrepContentRow {
  file: string;
  line?: number;
  text: string;
  match?: true;
}
export interface GrepResult {
  mode: OutputMode;
  files?: string[];
  content?: GrepContentRow[];
  counts?: Record<string, number>;
  truncated: boolean;
  limit: number;
  offset: number;
  // Fix round 1: how many candidate files were skipped outright for exceeding GREP_MAX_FILE_BYTES.
  // Always present (0 when none were skipped) -- same "always-present, not conditionally omitted"
  // treatment as `truncated`/`limit`/`offset`, so a caller never has to guess whether an absent
  // field means "zero" or "never computed."
  skippedOversized: number;
}

// --- type filter (small, hand-rolled -- see T8 note) -------------------------------------------------

const TYPE_EXTENSIONS: Record<string, readonly string[]> = {
  js: [".js", ".mjs", ".cjs", ".jsx"],
  ts: [".ts", ".mts", ".cts", ".tsx"],
  py: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
  cs: [".cs"],
  rb: [".rb"],
  php: [".php"],
  swift: [".swift"],
  kotlin: [".kt", ".kts"],
  scala: [".scala"],
  sh: [".sh", ".bash", ".zsh"],
  md: [".md", ".markdown"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass", ".less"],
  sql: [".sql"],
  txt: [".txt"],
};

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  const slashIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep));
  if (i <= slashIdx) return "";
  return path.slice(i).toLowerCase();
}

// --- gitignore (hand-rolled minimal subset -- see file header) --------------------------------------

interface IgnoreRule {
  negate: boolean;
  glob: InstanceType<typeof Bun.Glob>;
}

function compileGitignoreLine(trimmedLine: string, ownerRelDir: string): IgnoreRule | undefined {
  let line = trimmedLine;
  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  if (line.length === 0) return undefined;

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return undefined;

  const hasLeadingSlash = line.startsWith("/");
  if (hasLeadingSlash) line = line.slice(1);
  if (line.length === 0) return undefined;
  const hasInternalSlash = line.includes("/");

  let pattern: string;
  if (!hasLeadingSlash && !hasInternalSlash) {
    pattern = ownerRelDir.length > 0 ? `${ownerRelDir}/**/${line}` : `**/${line}`;
  } else {
    pattern = ownerRelDir.length > 0 ? `${ownerRelDir}/${line}` : line;
  }
  if (dirOnly) pattern = `${pattern}/**`;

  return { negate, glob: new Bun.Glob(pattern) };
}

async function loadGitignoreRules(searchRoot: string): Promise<IgnoreRule[]> {
  const discovery = new Bun.Glob("**/.gitignore");
  const found: { relDir: string; depth: number; content: string }[] = [];
  try {
    for await (const rel of discovery.scan({ cwd: searchRoot, dot: true, onlyFiles: true, followSymlinks: false })) {
      const relPosix = rel.split(sep).join("/");
      const dir = dirname(relPosix);
      const relDir = dir === "." ? "" : dir;
      try {
        const content = readFileSync(resolve(searchRoot, rel), "utf8");
        found.push({ relDir, depth: relDir.length === 0 ? 0 : relDir.split("/").length, content });
      } catch {
        // Unreadable .gitignore -- skip it, never abort the whole search over one bad file.
      }
    }
  } catch {
    // Discovery scan itself failed (e.g. searchRoot vanished) -- proceed with no ignore rules.
  }
  found.sort((a, b) => a.depth - b.depth);

  const rules: IgnoreRule[] = [];
  for (const { relDir, content } of found) {
    for (const rawLine of content.split("\n")) {
      const trimmed = rawLine.replace(/\r$/, "").trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const rule = compileGitignoreLine(trimmed, relDir);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

function isIgnored(relPathPosix: string, rules: readonly IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.glob.match(relPathPosix)) ignored = !rule.negate;
  }
  return ignored;
}

// --- file discovery --------------------------------------------------------------------------------

async function discoverCandidateFiles(searchRoot: string, globPattern: string): Promise<string[]> {
  const rules = await loadGitignoreRules(searchRoot);
  const glob = new Bun.Glob(globPattern);
  const out: string[] = [];
  for await (const p of glob.scan({ cwd: searchRoot, onlyFiles: true, dot: false, followSymlinks: false })) {
    // Same absolute-yield quirk as Glob's own scan() (see glob.ts's header): join only a RELATIVE
    // match onto searchRoot. Either way, the gitignore matcher needs a path relative to searchRoot
    // (every compiled rule is anchored that way) -- computed via `relative()` from the final
    // absolute path rather than reused from `p` directly, so an absolute-pattern `glob` (unusual
    // for this field, but not rejected) still ignore-matches correctly instead of being tested
    // against its own full absolute string.
    const abs = isAbsolute(p) ? resolve(p) : resolve(searchRoot, p);
    const relPosix = relative(searchRoot, abs).split(sep).join("/");
    if (isIgnored(relPosix, rules)) continue;
    out.push(abs);
  }
  return out;
}

function looksBinary(buf: Buffer): boolean {
  const sniffLen = Math.min(buf.length, 8000);
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// --- per-file scanning -------------------------------------------------------------------------------

interface ScanOptions {
  pattern: string;
  caseInsensitive: boolean;
  before: number;
  after: number;
  showLineNumbers: boolean;
  onlyMatch: boolean;
  multiline: boolean;
}
interface PerFileResult {
  matchedCount: number; // non-multiline: distinct matching LINES; multiline: distinct MATCHES
  contentRows: GrepContentRow[];
}

function scanFileLineByLine(file: string, text: string, opts: ScanOptions): PerFileResult {
  const lines = text.split("\n");
  const testRe = new RegExp(opts.pattern, opts.caseInsensitive ? "i" : "");
  const matchedIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (testRe.test(lines[i] ?? "")) matchedIdx.push(i);
  }
  if (matchedIdx.length === 0) return { matchedCount: 0, contentRows: [] };

  const rowKind = new Map<number, boolean>(); // lineIndex -> isMatch
  for (const i of matchedIdx) rowKind.set(i, true);
  for (const i of matchedIdx) {
    for (let c = i - opts.before; c <= i + opts.after; c++) {
      if (c < 0 || c >= lines.length || rowKind.has(c)) continue;
      rowKind.set(c, false);
    }
  }

  const orderedIdx = [...rowKind.keys()].sort((a, b) => a - b);
  const globalRe = new RegExp(opts.pattern, "g" + (opts.caseInsensitive ? "i" : ""));
  const contentRows: GrepContentRow[] = [];
  for (const idx of orderedIdx) {
    const isMatch = rowKind.get(idx) === true;
    const lineText = lines[idx] ?? "";
    if (isMatch && opts.onlyMatch) {
      globalRe.lastIndex = 0;
      const found = [...lineText.matchAll(globalRe)];
      const matches = found.length > 0 ? found.map((m) => m[0]) : [lineText];
      for (const matchedText of matches) {
        contentRows.push({ file, text: matchedText, match: true, ...(opts.showLineNumbers ? { line: idx + 1 } : {}) });
      }
    } else {
      contentRows.push({ file, text: lineText, ...(isMatch ? { match: true as const } : {}), ...(opts.showLineNumbers ? { line: idx + 1 } : {}) });
    }
  }
  return { matchedCount: matchedIdx.length, contentRows };
}

function scanFileMultiline(file: string, text: string, opts: ScanOptions): PerFileResult {
  const re = new RegExp(opts.pattern, "gs" + (opts.caseInsensitive ? "i" : ""));
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return { matchedCount: 0, contentRows: [] };

  const lineStartOffsets: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStartOffsets.push(i + 1);
  const lineOf = (charIdx: number): number => {
    let lo = 0;
    let hi = lineStartOffsets.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStartOffsets[mid]! <= charIdx) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  };

  const lines = text.split("\n");
  const contentRows: GrepContentRow[] = [];
  for (const m of matches) {
    const startIdx = m.index ?? 0;
    const lastCharIdx = m[0].length > 0 ? startIdx + m[0].length - 1 : startIdx;
    const startLine = lineOf(startIdx);
    const endLine = lineOf(lastCharIdx);
    const displayText = opts.onlyMatch ? m[0] : lines.slice(startLine, endLine + 1).join("\n");
    contentRows.push({ file, text: displayText, match: true, ...(opts.showLineNumbers ? { line: startLine + 1 } : {}) });
  }
  return { matchedCount: matches.length, contentRows };
}

// --- dispatch ------------------------------------------------------------------------------------

const SCAN_DEADLINE_MS = 5000;
// Fix round 1: disclosed per-file cap, mirrors read.ts's own IMAGE_MAX_BYTES pattern -- an invented,
// documented threshold (no pinned value exists anywhere in scope), chosen to keep a single
// candidate file's full materialization (readFileSync + .split("\n") + a line array) bounded rather
// than either OOM-prone on a pathologically large file or silently swallowed by the per-file catch.
const GREP_MAX_FILE_BYTES = 5 * 1024 * 1024;

function resolveContext(input: GrepInput): { before: number; after: number } {
  const radius = input.contextDash ?? input.context;
  return { before: input.before ?? radius ?? 0, after: input.after ?? radius ?? 0 };
}

async function execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
  let input: GrepInput;
  try {
    input = parseInput(rawInput);
  } catch (e) {
    return { output: `Error: ${(e as Error).message}`, isError: true };
  }

  try {
    new RegExp(input.pattern);
  } catch (e) {
    return { output: `Error: invalid pattern: ${(e as Error).message}`, isError: true };
  }

  let allowedExts: readonly string[] | undefined;
  if (input.type !== undefined) {
    const exts = TYPE_EXTENSIONS[input.type];
    if (!exts) {
      return { output: `Error: unrecognized type "${input.type}" -- supported: ${Object.keys(TYPE_EXTENSIONS).sort().join(", ")}`, isError: true };
    }
    allowedExts = exts;
  }

  const scanRoot = input.path !== undefined ? resolve(ctx.cwd, input.path) : ctx.cwd;
  let candidateFiles: string[];
  try {
    const st = statSync(scanRoot);
    if (st.isFile()) {
      // Directly-named file: bypasses gitignore + hidden-file rules (spec carve-out). `input.glob`
      // is a NO-OP here -- fix-round-1 finding, pinned by a test below: there is only one candidate
      // and nothing for a filter pattern to scope across, so `glob` is never consulted on this
      // branch (only the directory branch, just below, passes it to discoverCandidateFiles). A
      // `glob` that would have excluded this exact file, had it been reached via directory
      // traversal, has no effect when the file is named directly.
      candidateFiles = [scanRoot];
    } else if (st.isDirectory()) {
      candidateFiles = await discoverCandidateFiles(scanRoot, input.glob ?? "**/*");
    } else {
      return { output: `Error: path is neither a file nor a directory: ${input.path ?? scanRoot}`, isError: true };
    }
  } catch {
    return { output: `Error: path not found: ${input.path ?? scanRoot}`, isError: true };
  }
  if (allowedExts) candidateFiles = candidateFiles.filter((f) => allowedExts!.includes(extOf(f)));
  candidateFiles.sort((a, b) => a.localeCompare(b));

  const mode: OutputMode = input.output_mode ?? "files_with_matches";
  const { before, after } = resolveContext(input);
  const scanOpts: ScanOptions = {
    pattern: input.pattern,
    caseInsensitive: input.caseInsensitive === true,
    before,
    after,
    showLineNumbers: input.showLineNumbers === true,
    onlyMatch: input.onlyMatch === true,
    multiline: input.multiline === true,
  };

  const matchingFiles: string[] = [];
  const counts: Record<string, number> = {};
  const allContentRows: GrepContentRow[] = [];
  const deadline = Date.now() + SCAN_DEADLINE_MS;
  let scanTruncatedByDeadline = false;
  let skippedOversized = 0;

  for (const file of candidateFiles) {
    if (Date.now() > deadline) {
      scanTruncatedByDeadline = true;
      break;
    }
    // Fix round 1: size-checked via stat BEFORE any read -- an oversized file is skipped outright,
    // never materialized into memory at all (previously: read unconditionally, then
    // `buf.toString("utf8")` on a huge buffer, whose failure the blanket catch below swallowed
    // silently with no trace in the result).
    let fileSize: number;
    try {
      fileSize = statSync(file).size;
    } catch {
      continue; // vanished mid-scan -- skip, never abort the whole call
    }
    if (fileSize > GREP_MAX_FILE_BYTES) {
      skippedOversized++;
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      continue; // vanished mid-scan / unreadable -- skip, never abort the whole call
    }
    if (looksBinary(buf)) continue;

    let result: PerFileResult;
    try {
      const text = buf.toString("utf8");
      result = scanOpts.multiline ? scanFileMultiline(file, text, scanOpts) : scanFileLineByLine(file, text, scanOpts);
    } catch {
      continue;
    }
    if (result.matchedCount === 0) continue;

    matchingFiles.push(file);
    counts[file] = result.matchedCount;
    if (mode === "content") allContentRows.push(...result.contentRows);
  }

  const headLimitInput = input.head_limit ?? 250;
  const offsetInput = input.offset ?? 0;
  const take = headLimitInput === 0 ? Infinity : headLimitInput;

  // Fix round 1: a file skipped for being oversized means this scan's OWN view of "what matches"
  // is incomplete regardless of how many rows happen to fit under head_limit -- `truncated` must
  // reflect that, not just the head_limit/offset arithmetic on what WAS scanned.
  function paginate<T>(rows: T[]): { shown: T[]; truncated: boolean } {
    const afterOffset = rows.slice(offsetInput);
    const shown = take === Infinity ? afterOffset : afterOffset.slice(0, take);
    return { shown, truncated: scanTruncatedByDeadline || skippedOversized > 0 || shown.length < afterOffset.length };
  }

  let result: GrepResult;
  if (mode === "files_with_matches") {
    const { shown, truncated } = paginate(matchingFiles);
    result = { mode, files: shown, truncated, limit: headLimitInput, offset: offsetInput, skippedOversized };
  } else if (mode === "count") {
    const { shown, truncated } = paginate(matchingFiles);
    const shownCounts: Record<string, number> = {};
    for (const f of shown) shownCounts[f] = counts[f]!;
    result = { mode, counts: shownCounts, truncated, limit: headLimitInput, offset: offsetInput, skippedOversized };
  } else {
    const { shown, truncated } = paginate(allContentRows);
    result = { mode, content: shown, truncated, limit: headLimitInput, offset: offsetInput, skippedOversized };
  }

  return { output: JSON.stringify(result) };
}

const grepExecutor: ToolExecutor = { execute };

// RULING P3-F (fix round 1): returns the RAW input-derived string, UNRESOLVED -- no process.cwd()
// baked in here anymore. This seam's signature (registry.ts's `RegisteredTool.extractPaths`,
// `(input) => {reads,writes}`) carries no ctx/cwd parameter; the eventual CONSUMER resolves each
// candidate against its own session ctx.cwd (the seam-level contract itself lands at T8). Absent
// `path` -> emptyPathSet() -- there is no raw string to derive when the caller never supplied one;
// synthesizing a "." or a resolved default would be exactly the kind of baked-in assumption this
// ruling retires.
function extractGrepPaths(input: unknown): ExtractedPaths {
  const path = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["path"] : undefined;
  if (typeof path !== "string" || path.length === 0) return emptyPathSet();
  return { reads: [path], writes: [] };
}

replaceExecutor("Grep", grepExecutor, extractGrepPaths);
