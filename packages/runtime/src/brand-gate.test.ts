// P7a spine, Step 4 (D19): THE BRAND SWEEP GATE.
//
// WS-03's Phase 7a amendment ends with one sentence: "A sweep gate (a test) keeps every raw brand
// literal out of non-test source except the brand module." This is that test.
//
// WHY A GATE AND NOT A CODE REVIEW. `Options.brand` is worth exactly as much as the number of
// places that actually READ it. A profile threaded through nine call sites while a tenth keeps
// `join(homedir(), ".winter")` does not fail anything, does not look wrong in a diff, and produces
// a reuser whose sessions write half their state into somebody else's product's directory. The only
// way to know the sweep is complete is to make an incomplete sweep fail.
//
// THE EXCEPTIONS ARE DISCLOSED, NOT INFERRED:
//   * `packages/sdk/src/brand.ts` — the one module allowed to spell Winter's own names.
//   * `BASELINE_ALLOWLIST` below — the files that ALREADY carried a literal when this gate landed.
//     Each lane deleted its own entries as it swept them, and the fix wave took the last one. IT IS
//     NOW EMPTY, and a test asserts that (P7a close-out, part A): the exceptions are `brand.ts` and
//     nothing else. A listed file was a debt with a name, never a permission — so the list going to
//     zero is the phase's own acceptance, not a tidy-up.
//   * CATALOG PROVENANCE VOCABULARY needs no exemption, and the reasoning is recorded here so the
//     next reader does not re-litigate it (P7a fix wave, item 8). `provider-catalog/src/validate.ts`
//     spells `winter-default` (an `EvidenceSource`), `winter-curated` (a `SlotBasis`) and `winter`
//     (an `upstream.project`). Those are closed schema enum VALUES that the generated catalog, the
//     overlay JSON and the PROVENANCE census all carry verbatim, and a rebrand MUST NOT change them
//     — a host's brand does not rename the catalog's provenance tiers, exactly as the
//     Claude-mirroring literals below are the official runtime's own names. NO RULE MATCHES THEM
//     (the rules are anchored on product surfaces: dot-dirs, the instructions file, the preset, the
//     MCP prefix, the keychain service, the temp root, the originator, the product token), so
//     nothing has to be exempted for them. That file's baseline entry was earned by a DIFFERENT
//     literal — `WINTER_IDENTITY_VALUE_PREFIX = "winter-agent-sdk"`, rule 9a — which the fix wave
//     deleted rather than exempted, because the product token is exactly what this gate exists for.
//   * CLAUDE-MIRRORING literals are never matched at all (WS-01 §5, D16/D19): `claude-<uid>`,
//     `claude-resume-<uuid>`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `preset: "claude_code"`,
//     the `AgentInput.model` aliases, `.claude-plugin`, `com.anthropic.claude-code`. They are the
//     official runtime's own names; rebranding them would be a lie, not a personalisation.
//   * HARNESS/TEST env names are never matched: `WINTER_TEST_*` (today `WINTER_TEST_PACK_SMOKE`,
//     the P7a fix-wave opt-in that runs the ~62s pack+install legs outside CI), `WINTER_LIVE_*`,
//     `WINTER_COMPILED_BIN`, `WINTER_CANARY_SECRET`, `WINTER_SDK_CAN_USE_TOOL_SHADOWED`,
//     `WINTER_CREDENTIAL_MISSING`, `WINTER_RUNTIME_KIND`. They are this repository's own
//     scaffolding, not a product surface, and rule 9's suffix list is closed for exactly that
//     reason (see PRODUCT_ENV_SUFFIXES).
//
// HOW TO SEE WHAT THIS GATE SEES (rules 1-8 are a plain grep; run it from the repo root):
//
//   grep -REn "[\"'\`]\.winter[\"'\`/]|[\"'\`]WINTER\.md[\"'\`]|[\"'\`]winter_code[\"'\`]|mcp__winter__|com\.winter\.|/private/tmp/winter-|originator:[[:space:]]*[\"']winter[\"']|[\"'\`]winter-agent-sdk/" \
//     packages/sdk/src packages/runtime/src packages/provider-runtime/src packages/provider-catalog/src scripts \
//     --include="*.ts" | grep -v "\.test\.ts:" | grep -v "\.test-support\.ts:"
//
// Rule 9 (a MODULE-LOAD read of a product env name) is not greppable — "at top level" means brace
// depth zero with strings, comments, template literals and regex literals discounted — so this file
// carries its own scanner for it (`computeScanMask`), plant-tested below. Rules 2b and 10b need the
// same scanner for a different fact — "inside a STRING LITERAL, never a comment" — which is the shape
// every survivor of the whole-branch review had. A missed file fails the first test with its path
// and the rule it tripped.
//
// A RAW OCCURRENCE INCLUDES COMMENTS, deliberately. A comment saying `.winter/settings.json` is a
// statement about a path that is no longer necessarily `.winter/...`, and it is exactly the kind of
// stale prose that teaches the next reader the wrong invariant. Rewording one is cheap; a gate that
// silently permitted them would have to parse TypeScript to know the difference.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// packages/runtime/src -> the repository root.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** The four source trees plus the scripts directory — WS-03's amendment names exactly these. */
const SCAN_ROOTS = ["packages/sdk/src", "packages/runtime/src", "packages/provider-runtime/src", "packages/provider-catalog/src", "scripts"] as const;

/**
 * The ONE file allowed to carry Winter's own names as literals. Everything else derives them.
 */
const BRAND_MODULE = "packages/sdk/src/brand.ts";

/**
 * Rules 1-8: a raw occurrence anywhere in the file, comments included (see the header).
 *
 * Each is named, so a failure says WHICH brand surface leaked rather than dumping a regex at the
 * reader. The quote/backtick anchors on the first three are what keep `.winterfoo`, an English
 * sentence containing the word winter, or a WINTER.mdx filename out of the net.
 */
const RAW_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  // WIDENED at review r1 (Important-4): the trailing class gained `-`, so `.winter-plugin` and
  // `.winter-dev` are caught. Without it `WINTER_PLUGIN_MANIFEST_DIR = ".winter-plugin"` — a real
  // literal, in a file Lane A is told to sweep — was invisible, and `pluginManifestDir` had no rule
  // covering it at all.
  { name: "home/project/plugin dot-dir (brand.homeDirName / projectDirName / pluginManifestDir)", re: /["'`]\.winter[-"'`/]/ },
  { name: "instructions file (brand.instructionsFile)", re: /["'`]WINTER\.md["'`]/ },
  { name: "preset name (brand.presetName)", re: /["'`]winter_code["'`]/ },
  { name: "MCP tool name (mcpToolName(brand, ...))", re: /mcp__winter__/ },
  { name: "keychain service (brand.keychainService)", re: /com\.winter\./ },
  { name: "shared temp root, spelled as a path (brand.tempRootName)", re: /\/private\/tmp\/winter-/ },
  { name: "codex originator (brand.codexOriginator)", re: /originator:\s*["']winter["']/ },
  { name: "product token in an identity string (userAgent(brand, ...))", re: /["'`]winter-agent-sdk\// },
  // ADDED at review r1 (Important-4). The two rules above only see these tokens in ONE spelling
  // each, and the repository uses the other one in production code:
  //   * `join(base, `winter-${uid}`)` builds the shared temp root without ever writing
  //     `/private/tmp/`, so `tempRootName` was invisible at its only real construction site;
  //   * `WINTER_IDENTITY_VALUE_PREFIX = "winter-agent-sdk"` and `DEFAULT_PRODUCT = "winter-agent-sdk"`
  //     are the product token with no trailing slash, so `packageName` was invisible where it is
  //     actually decided (identity.ts's own constant), leaving those files allowlisted for a COMMENT
  //     while the code literal beside it went unguarded.
  { name: "temp-root or product token, interpolated or slashless (brand.tempRootName / brand.packageName)", re: /["'`]winter-\$\{|["'`]winter-agent-sdk["'`]/ },
  // ADDED at review r1 (Important-4): a PRODUCT env name spelled literally, as a property or a
  // string key, on ANY receiver — `(env ?? process.env).WINTER_TMPDIR`, `env["WINTER_HOME"]`.
  //
  // SEPARATE FROM RULE 9, and matched ANYWHERE rather than at module-load position only, because the
  // two rules answer different questions. Rule 9 is about TIMING (a read evaluated at import can
  // never be corrected for a reuser). This one is about the NAME: a product env name is
  // brand-derived and must come from `envName(brand, ...)` wherever it is read. `paths/temp.ts:71`
  // and `paths/project-dir-name.ts:28` read theirs INSIDE a function, so a top-level-only rule can
  // never see them — and those are exactly the files Lane A is told to sweep.
  { name: "product env name spelled literally (envName(brand, ...))", re: null as unknown as RegExp },
];

/**
 * Rule 9's closed suffix list: WS-01 §2.5's PRODUCT-facing environment variables, and nothing else.
 *
 * A product env name is brand-derived, so reading one at MODULE LOAD is the specific bug this rule
 * exists for: the brand arrives with `--config-json`, long after import time, so a module-level
 * `process.env.WINTER_HOME` bakes in Winter's prefix for a reuser and can never be corrected. The
 * same read inside a function is fine (and is what `resolveWinterHome` does).
 *
 * Harness variables are ABSENT from this list on purpose — they are never brand-derived, so a
 * module-level read of one is not a bug.
 */
const PRODUCT_ENV_SUFFIXES = [
  "HOME",
  "TMPDIR",
  "PROJECT_DIR_NAME",
  "SUBAGENT_MODEL",
  "MAX_SUBAGENT_SPAWN_DEPTH",
  "MAX_CONCURRENT_SUBAGENTS",
  "DISABLE_BACKGROUND_TASKS",
  "MAX_RETRIES",
  "RETRY_WATCHDOG",
  "ASYNC_AGENT_STALL_TIMEOUT_MS",
  "ENABLE_STREAM_WATCHDOG",
  "STREAM_IDLE_TIMEOUT_MS",
  "SKIP_PROMPT_HISTORY",
  "ENABLE_TELEMETRY",
  "ENHANCED_TELEMETRY_BETA",
  "PROFILE",
] as const;
const TOP_LEVEL_ENV_RE = new RegExp(`process\\.env\\.WINTER_(?:${PRODUCT_ENV_SUFFIXES.join("|")})\\b`, "g");

/**
 * Rule 10's pattern (review r1, Important-4): a product env name spelled as a PROPERTY or a STRING
 * KEY on any receiver. Filled into `RAW_RULES`'s placeholder below, since the suffix list has to be
 * declared before either pattern can be built.
 */
const LITERAL_ENV_NAME_RE = new RegExp(`(?:\\.|\\[\\s*["'\`])WINTER_(?:${PRODUCT_ENV_SUFFIXES.join("|")})\\b`);

/**
 * P7a fix wave (item 5, M-1): rules 2b and 10b -- a brand-owned name spelled INSIDE A STRING LITERAL.
 *
 * The eight raw rules are anchored on a QUOTE (`"WINTER.md"`, `".winter/"`), which is what keeps an
 * English sentence out of the net -- and is exactly why every survivor the whole-branch review found
 * was invisible: the token sat in the MIDDLE of a sentence that is itself a string. Three of them
 * were model-facing prose (the memory guidance, the classifier prompt) and one was a host-facing
 * remedy (`Use WINTER_HOME=/tmp ...`).
 *
 * So these two are matched only where `inString` is set: a COMMENT naming `WINTER.md` is prose about
 * the mechanism (this file's own header is full of it, as is every module that explains the
 * rebrand), while the same token inside a string is text that LEAVES THE PROCESS and must be derived.
 */
const IN_STRING_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "rule 2b: the instructions file named inside a STRING (brand.instructionsFile)", re: new RegExp("\\bWINTER\\.md\\b", "g") },
  { name: "rule 10b: a product env name spelled bare inside a STRING (envName(brand, ...))", re: new RegExp(`\\bWINTER_(?:${PRODUCT_ENV_SUFFIXES.join("|")})\\b`, "g") },
];
(RAW_RULES as Array<{ name: string; re: RegExp }>)[RAW_RULES.length - 1]!.re = LITERAL_ENV_NAME_RE;

// ================================================================================================
// The scanner rule 9 needs: brace depth, with strings/comments/templates/regexes discounted.
// ================================================================================================

export interface ScanMask {
  /**
   * How many enclosing FUNCTION BODIES each index sits inside; `0` means module-load position.
   *
   * NOT brace depth (review r1, Important-3). A `{` that opens an object literal, a block, a class
   * body or a `${...}` is not a scope, and counting it as one made the single most idiomatic
   * module-load config read invisible:
   *
   *     export const DEFAULTS = { home: process.env.WINTER_HOME };   // depth 1, function depth 0
   *
   * That line runs at import time and bakes a brand-derived env name into the module — exactly and
   * only the bug rule 9 exists for — and the old depth-0 test discarded it.
   */
  functionDepths: Int32Array;
  /** Whether each index is REAL CODE — not inside a string, template, comment or regex literal. */
  inCode: Uint8Array;
  /**
   * Whether each index is inside a STRING LITERAL (single, double or template) — never a comment.
   *
   * P7a fix wave (item 5, M-1). `inCode` alone cannot express "a literal, but not a comment", and
   * that distinction is the whole of rules 2b and 10b: a COMMENT naming `WINTER.md` is prose about
   * the mechanism (this file's own header is full of it), while the same token inside a string is
   * text that leaves the process — sent to the model, or handed to the host in an error — where a
   * brand-derived name must be derived.
   *
   * A `${...}` template EXPRESSION is NOT in-string: it is code, and its own literals get their own
   * spans, so the mask never reports the interpolation itself as text.
   */
  inString: Uint8Array;
}

/**
 * The two facts rule 9 needs at every character index: enclosing-function depth, and whether this is
 * real code.
 *
 * BOTH are load-bearing, and both were found missing by this file's own plant tests. Without
 * `inCode`, the gate flags a module-header COMMENT that merely mentions `process.env.WINTER_HOME`
 * while explaining why not to write one — a gate whose first output is a false positive against its
 * own documentation teaches everyone to add allowlist entries instead of reading it. Without
 * function-scope tracking, a top-level object literal hides a real module-load read.
 *
 * A single pass with an explicit state machine rather than a parser: this file must not add a
 * TypeScript dependency to run a lint rule. Two constructs are genuinely ambiguous in JavaScript's
 * grammar and both are resolved by the standard previous-significant-token heuristic:
 *
 *   `/`  division vs. the start of a regex literal.
 *   `{`  a FUNCTION BODY vs. an object literal / block / class body. `=> {` is a function; `) {` is
 *        a function iff the token before the matching `(` is an identifier that is not one of the
 *        control keywords (`if`, `for`, `while`, `switch`, `catch`, `with`) — which covers function
 *        declarations, function expressions, methods, getters, setters and `async` forms alike.
 *        Everything else is not a scope.
 *
 * Both misreads fail in the SAFE direction: they can move a match from "module-load" to "nested" or
 * back, never invent or delete one, and since BASELINE_ALLOWLIST is generated by THIS function a
 * false POSITIVE is absorbed into the baseline. A false NEGATIVE is the real hazard, which is what
 * the plant tests at the bottom of this file exist to rule out.
 */
export function computeScanMask(src: string): ScanMask {
  const functionDepths = new Int32Array(src.length);
  const inCode = new Uint8Array(src.length);
  const inString = new Uint8Array(src.length);
  type State = "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "regex";
  /** What each open `{` was: a function body (a scope), anything else, or a template expression. */
  type BraceKind = "fn" | "other" | "tmpl";
  let state: State = "code";
  let functionDepth = 0;
  const braceStack: BraceKind[] = [];
  /** Index of the last significant CODE character strictly before each index (-1 if none). */
  const prevSigAt = new Int32Array(src.length).fill(-1);
  /** For each `)` index, the index of its matching `(` — needed to classify a `) {`. */
  const matchingOpenParen = new Map<number, number>();
  const parenStack: number[] = [];
  let prevSigIdx = -1;
  let prevSignificant = "";
  const regexCanFollow = (prev: string): boolean => prev === "" || "(,=:[!&|?{};+-*%~^<>\n".includes(prev);

  /** The identifier ending at `idx` (inclusive), or "" if that character is not an identifier char. */
  const wordEndingAt = (idx: number): string => {
    if (idx < 0) return "";
    let end = idx;
    if (!/[A-Za-z0-9_$]/.test(src[end] as string)) return "";
    let begin = end;
    while (begin > 0 && /[A-Za-z0-9_$]/.test(src[begin - 1] as string)) begin--;
    return src.slice(begin, end + 1);
  };

  /** Control-flow keywords whose `(...)` is followed by a BLOCK, not a function body. */
  const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);

  const classifyBrace = (): BraceKind => {
    // `=> {`
    if (prevSignificant === ">" && prevSigIdx > 0 && src[prevSigIdx - 1] === "=") return "fn";
    // `) {` — a function body iff the token before the matching `(` is a non-control identifier.
    if (prevSignificant === ")") {
      const open = matchingOpenParen.get(prevSigIdx);
      if (open === undefined) return "other";
      const word = wordEndingAt(prevSigAt[open] ?? -1);
      if (word === "" || CONTROL_KEYWORDS.has(word)) return "other";
      return "fn";
    }
    // Everything else: an object literal (`= {`, `( {`, `, {`, `: {`, `[ {`), a bare/labelled block,
    // a class or namespace body, `try {`, `do {`, `else {`, `catch {`. None of them is a scope a
    // module-load read can hide behind.
    return "other";
  };

  for (let i = 0; i < src.length; i++) {
    functionDepths[i] = functionDepth;
    prevSigAt[i] = prevSigIdx;
    // Recorded BEFORE this character is interpreted, so the opening quote/slash of a literal is
    // itself already "not code" only from the next index on -- which is what we want: the match
    // this mask gates starts at `process`, never at a delimiter.
    inCode[i] = state === "code" ? 1 : 0;
    inString[i] = state === "sq" || state === "dq" || state === "tmpl" ? 1 : 0;
    const c = src[i] as string;
    const n = i + 1 < src.length ? (src[i + 1] as string) : "";
    switch (state) {
      case "code":
        if (c === "/" && n === "/") {
          state = "line";
          i++;
        } else if (c === "/" && n === "*") {
          state = "block";
          i++;
        } else if (c === "'") state = "sq";
        else if (c === '"') state = "dq";
        else if (c === "`") state = "tmpl";
        else if (c === "/" && regexCanFollow(prevSignificant)) state = "regex";
        else if (c === "(") parenStack.push(i);
        else if (c === ")") {
          const open = parenStack.pop();
          if (open !== undefined) matchingOpenParen.set(i, open);
        } else if (c === "{") {
          const kind = classifyBrace();
          braceStack.push(kind);
          if (kind === "fn") functionDepth++;
        } else if (c === "}") {
          const kind = braceStack.pop();
          if (kind === "tmpl") state = "tmpl";
          else if (kind === "fn") functionDepth--;
        }
        break;
      case "line":
        if (c === "\n") state = "code";
        break;
      case "block":
        if (c === "*" && n === "/") {
          state = "code";
          i++;
        }
        break;
      case "sq":
        if (c === "\\") i++;
        else if (c === "'") state = "code";
        break;
      case "dq":
        if (c === "\\") i++;
        else if (c === '"') state = "code";
        break;
      case "tmpl":
        if (c === "\\") i++;
        else if (c === "`") state = "code";
        else if (c === "$" && n === "{") {
          // A template EXPRESSION is not a scope: it belongs to whatever function (or none) encloses
          // the template itself. `export const s = `${process.env.WINTER_HOME}/x`` is a module-load
          // read; the same expression inside a function body is not.
          braceStack.push("tmpl");
          state = "code";
          i++;
        }
        break;
      case "regex":
        if (c === "\\") i++;
        else if (c === "\n") state = "code"; // an unterminated "regex" was a division after all
        else if (c === "/") state = "code";
        break;
    }
    if (state === "code" && c.trim() !== "") {
      prevSignificant = c;
      prevSigIdx = i;
    }
  }
  return { functionDepths, inCode, inString };
}

// ================================================================================================
// The sweep.
// ================================================================================================

/** A file is "test source" — and therefore out of scope — by its own filename, never by content. */
function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test-support.ts");
}

function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !isTestFile(entry.name)) out.push(relative(REPO_ROOT, full));
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out.sort();
}

export interface BrandOffence {
  file: string;
  rule: string;
  line: number;
  text: string;
}

export function scanFileForBrandLiterals(relPath: string, src: string): BrandOffence[] {
  const found: BrandOffence[] = [];
  const lines = src.split("\n");
  for (const rule of RAW_RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (rule.re.test(line)) found.push({ file: relPath, rule: rule.name, line: i + 1, text: line.trim().slice(0, 160) });
    }
  }
  const { functionDepths, inCode, inString } = computeScanMask(src);
  TOP_LEVEL_ENV_RE.lastIndex = 0;
  for (let m = TOP_LEVEL_ENV_RE.exec(src); m !== null; m = TOP_LEVEL_ENV_RE.exec(src)) {
    if (functionDepths[m.index] !== 0 || inCode[m.index] !== 1) continue;
    const line = src.slice(0, m.index).split("\n").length;
    found.push({ file: relPath, rule: "MODULE-LOAD read of a product env name (rule 9)", line, text: m[0] });
  }
  // Rules 2b/10b: in a STRING LITERAL only (never a comment) -- see IN_STRING_RULES' own note.
  for (const rule of IN_STRING_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(src); m !== null; m = rule.re.exec(src)) {
      if (inString[m.index] !== 1) continue;
      const line = src.slice(0, m.index).split("\n").length;
      found.push({ file: relPath, rule: rule.name, line, text: m[0] });
    }
  }
  return found;
}

function sweep(): BrandOffence[] {
  const out: BrandOffence[] = [];
  for (const file of collectSourceFiles()) {
    if (file === BRAND_MODULE) continue;
    out.push(...scanFileForBrandLiterals(file, readFileSync(join(REPO_ROOT, file), "utf8")));
  }
  return out;
}

/**
 * THE BASELINE — every non-test file that already carried a brand literal when this gate landed.
 *
 * Generated from the tree at the spine's Step 4 (the sdk half was swept first, which is why no
 * `packages/sdk/**` file appears here: the spine owns that half and nobody else would have deleted
 * its entries). ONE ENTRY PER LINE, sorted, grouped by package — four lanes delete from this list
 * in parallel and a one-per-line sorted list is the shape that merges without conflicts.
 *
 * Deleting an entry is how a lane declares a file swept. Deleting one WITHOUT sweeping the file
 * fails the first test; sweeping a file WITHOUT deleting its entry fails the second. The spine has
 * already deleted three of its own (the advisor descriptor, its executor, and the standing Winter
 * server) in Step 5's commit — which is what the mechanism looks like working.
 *
 * `// comment-only` MARKS AN ENTRY WHOSE OFFENCES ARE ALL IN COMMENTS at the time this list was
 * generated (review r1, Important-4). Two things follow, and both matter to a lane sweeping one:
 *   * Rewording the prose is the WHOLE fix — there is no code literal behind it to derive.
 *   * The marker is a snapshot, not a guarantee. RE-RUN THE GATE before deleting the entry: if the
 *     file still offends, the reword missed something (or a rule now sees a literal that was
 *     invisible when the marker was written, which is exactly what happened to `identity.ts` and
 *     `xai-oauth.ts` when r1 added the slashless product-token rule — both were marked comment-only
 *     under the eight original rules while carrying a real `"winter-agent-sdk"` constant).
 */
const BASELINE_ALLOWLIST: readonly string[] = [
  // --- packages/provider-catalog (Lane D owns validate.ts's rules) ------------------------------
  // --- packages/provider-runtime (Lane A: identity.ts's body, the codex originator, the keychain service)
  // --- packages/runtime (Lane A unless another lane's ownership row names the file) -------------
  // --- scripts (Lane A) -------------------------------------------------------------------------
];

describe("P7a (D19): the brand sweep gate", () => {
  const offences = sweep();
  const allowed = new Set(BASELINE_ALLOWLIST);

  test("no NEW file carries a raw Winter-owned literal", () => {
    const unexpected = offences.filter((o) => !allowed.has(o.file));
    // The message is the whole value of this test: a bare count would send the reader back to grep.
    const detail = unexpected.map((o) => `  ${o.file}:${o.line}  [${o.rule}]\n      ${o.text}`).join("\n");
    expect(unexpected.length === 0 ? "" : `raw brand literals outside brand.ts and the baseline:\n${detail}`).toBe("");
  });

  test("the baseline has no STALE entries — a swept file must be deleted from the list", () => {
    // This is what makes "each lane deletes its files" enforceable rather than aspirational, and it
    // is also what makes P7a's close-out assertion (the list is empty) reachable at all.
    const offending = new Set(offences.map((o) => o.file));
    const stale = BASELINE_ALLOWLIST.filter((f) => !offending.has(f));
    expect(stale).toEqual([]);
  });

  // --- P7a fix wave (item 8): the CLOSE-OUT --------------------------------------------------------
  test("BASELINE_ALLOWLIST is EMPTY -- every lane's debt is discharged", () => {
    // WS-03's amendment ends here: the gate landed with a named debt per file, four lanes deleted
    // their own entries, and the last one (`provider-catalog/src/validate.ts`) went with the fix
    // wave's item 7. From now on there is no such thing as a file that may carry a brand literal:
    // the ONLY exceptions are `brand.ts` and the by-VALUE vocabulary table, both of which are
    // reasoned about rather than inherited.
    expect(BASELINE_ALLOWLIST).toEqual([]);
  });

  test("the baseline is sorted, unique, and every entry names a real scanned file", () => {
    expect([...BASELINE_ALLOWLIST]).toEqual([...new Set(BASELINE_ALLOWLIST)].sort());
    const scanned = new Set(collectSourceFiles());
    expect(BASELINE_ALLOWLIST.filter((f) => !scanned.has(f))).toEqual([]);
  });

  test("the sweep is not vacuous: it scans every root and reports the debt per package", () => {
    const scanned = collectSourceFiles();
    for (const root of SCAN_ROOTS) expect([root, scanned.some((f) => f.startsWith(`${root}/`))]).toEqual([root, true]);
    const perPackage = new Map<string, number>();
    for (const file of new Set(offences.map((o) => o.file))) {
      const pkg = file.startsWith("packages/") ? file.split("/").slice(0, 2).join("/") : "scripts";
      perPackage.set(pkg, (perPackage.get(pkg) ?? 0) + 1);
    }
    const summary = [...perPackage.entries()].sort().map(([pkg, n]) => `${pkg}=${n}`).join(" ");
    // COMMENT-ONLY count, recomputed live rather than read off the `// comment-only` markers in the
    // data: the markers are a snapshot for a human reading the list, this is the current truth. The
    // two disagreeing is the signal a lane needs — a marked entry that is no longer comment-only
    // means a rule started seeing a code literal that was invisible when the marker was written.
    const byFile = new Map<string, number[]>();
    for (const o of offences) byFile.set(o.file, [...(byFile.get(o.file) ?? []), o.line]);
    let commentOnly = 0;
    for (const [file, lines] of byFile) {
      const src = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      if (lines.every((n) => (src[n - 1] ?? "").trimStart().startsWith("//") || (src[n - 1] ?? "").trimStart().startsWith("*") || (src[n - 1] ?? "").trimStart().startsWith("/*"))) commentOnly++;
    }
    console.log(
      `[brand-gate] scanned ${scanned.length} non-test files; ${byFile.size} still carry a literal (${summary}); ` +
        `${offences.length} occurrences; ${commentOnly} of the ${byFile.size} offend ONLY in comments`,
    );
    // packages/sdk is the spine's own half and is swept: it must contribute NOTHING but brand.ts.
    expect(perPackage.get("packages/sdk") ?? 0).toBe(0);
  });
});

// ================================================================================================
// Plant tests for rule 9's scanner.
//
// The gate's other eight rules are plain regexes over lines and are self-evidently right or wrong.
// Rule 9 depends on `computeBraceDepths` being correct, and a scanner that quietly reported
// "everything is nested" would make the rule inert while every gate stayed green — the exact shape
// of a gate that looks like it works. So the scanner is exercised against synthetic sources whose
// answers are known, including each construct that could plausibly break it.
// ================================================================================================
describe("P7a: rule 9's top-level scanner (plants)", () => {
  const flagged = (src: string): boolean => scanFileForBrandLiterals("synthetic.ts", src).some((o) => o.rule.includes("rule 9"));

  test("FLAGS a module-load read", () => {
    expect(flagged('const home = process.env.WINTER_HOME ?? "";\n')).toBe(true);
  });

  test("does NOT flag the same read inside a function body", () => {
    expect(flagged("function f() {\n  return process.env.WINTER_HOME;\n}\n")).toBe(false);
    expect(flagged("const f = () => {\n  return process.env.WINTER_TMPDIR;\n};\n")).toBe(false);
    expect(flagged("export const o = {\n  f() {\n    return process.env.WINTER_PROFILE;\n  },\n};\n")).toBe(false);
    expect(flagged("async function f() {\n  return process.env.WINTER_HOME;\n}\n")).toBe(false);
    expect(flagged("class A {\n  get home() {\n    return process.env.WINTER_HOME;\n  }\n}\n")).toBe(false);
    expect(flagged("export const f = async (a, b) => {\n  return process.env.WINTER_HOME;\n};\n")).toBe(false);
    // A read nested two objects deep INSIDE a function is still inside the function.
    expect(flagged("function f() {\n  return { a: { b: process.env.WINTER_HOME } };\n}\n")).toBe(false);
  });

  // --- review r1, Important-3: a `{` is not a scope --------------------------------------------
  //
  // The gate originally keyed rule 9 on BRACE depth, so the single most idiomatic module-load config
  // read -- an object literal of defaults -- sat at depth 1 and was silently discarded. A lane
  // writing exactly this line during the sweep would have got a green gate.
  test("FLAGS a module-load read inside a TOP-LEVEL OBJECT LITERAL (the r1 plant)", () => {
    expect(flagged("export const DEFAULTS = { home: process.env.WINTER_HOME };\n")).toBe(true);
    expect(flagged("export const DEFAULTS = {\n  home: process.env.WINTER_HOME,\n  tmp: process.env.WINTER_TMPDIR,\n};\n")).toBe(true);
    // Nested one deeper, still module-load.
    expect(flagged("export const C = { paths: { home: process.env.WINTER_HOME } };\n")).toBe(true);
  });

  test("FLAGS a module-load read in a TOP-LEVEL TEMPLATE EXPRESSION (the r1 plant's second form)", () => {
    expect(flagged("export const s = `${process.env.WINTER_TMPDIR}`;\n")).toBe(true);
    expect(flagged("export const s = `${process.env.WINTER_HOME}/projects`;\n")).toBe(true);
  });

  test("FLAGS other non-scope module-load positions: arrays, calls, class fields, module-level blocks", () => {
    // None of these braces/brackets is a function scope, and every one of these lines RUNS at import.
    expect(flagged("export const A = [process.env.WINTER_HOME];\n")).toBe(true);
    expect(flagged("export const v = String(process.env.WINTER_HOME);\n")).toBe(true);
    expect(flagged("class A {\n  home = process.env.WINTER_HOME;\n}\n")).toBe(true);
    expect(flagged("if (x) {\n  console.log(process.env.WINTER_HOME);\n}\n")).toBe(true);
    expect(flagged("try {\n  read(process.env.WINTER_HOME);\n} catch {}\n")).toBe(true);
  });

  test("the control-flow keywords are NOT read as function bodies (a `) {` is only sometimes a scope)", () => {
    // If `if (...) {` were classified as a function body, every module-level conditional would hide
    // a real module-load read -- the same false negative in a different disguise.
    for (const kw of ["if (x)", "while (x)", "for (const k of y)", "switch (x)", "with (x)"]) {
      expect([kw, flagged(`${kw} {\n  use(process.env.WINTER_HOME);\n}\n`)]).toEqual([kw, true]);
    }
    // ...while a real call-shaped function head IS one.
    expect(flagged("function make(x) {\n  return process.env.WINTER_HOME;\n}\n")).toBe(false);
    expect(flagged("const o = {\n  make(x) {\n    return process.env.WINTER_HOME;\n  },\n};\n")).toBe(false);
  });

  test("does NOT flag one inside a string, a template literal, a comment or a regex", () => {
    expect(flagged('const s = "process.env.WINTER_HOME";\n')).toBe(false);
    expect(flagged("const s = `read process.env.WINTER_HOME lazily`;\n")).toBe(false);
    expect(flagged("// never process.env.WINTER_HOME at module load\n")).toBe(false);
    expect(flagged("/* process.env.WINTER_HOME */\n")).toBe(false);
    expect(flagged("const re = /process\\.env\\.WINTER_HOME/;\n")).toBe(false);
  });

  test("a template EXPRESSION is still inside the function that contains it", () => {
    expect(flagged("function f() {\n  return `${process.env.WINTER_HOME}/x`;\n}\n")).toBe(false);
  });

  test("a nested template expression at module level IS a module-load read", () => {
    expect(flagged("export const s = `${process.env.WINTER_HOME}/projects`;\n")).toBe(true);
  });

  test("braces inside strings, comments and regex character classes do not shift the depth", () => {
    // Each of these would, if miscounted, leave the scanner permanently "inside a block" and make
    // every later module-load read invisible — the false NEGATIVE this whole block guards against.
    expect(flagged('const a = "{";\nconst b = process.env.WINTER_HOME;\n')).toBe(true);
    expect(flagged("// {\nconst b = process.env.WINTER_HOME;\n")).toBe(true);
    expect(flagged("/* { { { */\nconst b = process.env.WINTER_HOME;\n")).toBe(true);
    expect(flagged("const re = /[{}]/;\nconst b = process.env.WINTER_HOME;\n")).toBe(true);
    expect(flagged("const s = `a { b`;\nconst c = process.env.WINTER_HOME;\n")).toBe(true);
    expect(flagged("const q = 1 / 2;\nconst b = process.env.WINTER_HOME;\n")).toBe(true);
  });

  test("HARNESS env names are never rule-9 matches, at any depth", () => {
    expect(flagged("const t = process.env.WINTER_TEST_PROVIDER;\n")).toBe(false);
    expect(flagged("const t = process.env.WINTER_COMPILED_BIN;\n")).toBe(false);
    expect(flagged("const t = process.env.WINTER_LIVE_GATE;\n")).toBe(false);
    expect(flagged("const t = process.env.WINTER_RUNTIME_KIND;\n")).toBe(false);
  });

  test("every raw rule fires on its own literal and not on a near miss", () => {
    const rules = (src: string): string[] => scanFileForBrandLiterals("synthetic.ts", src).map((o) => o.rule);
    expect(rules('const d = ".winter";\n')).toHaveLength(1);
    expect(rules('const d = join(cwd, ".winter", "settings.json");\n')).toHaveLength(1);
    // TWO rules, since the fix wave: the quote-anchored rule 2 and the in-string rule 2b both see a
    // bare `"WINTER.md"`. That overlap is deliberate -- 2b exists for the token in the MIDDLE of a
    // sentence, which rule 2's quote anchor cannot reach -- and a plant that expected one would be
    // asserting the widening never happened.
    expect(rules('const f = "WINTER.md";\n')).toEqual([
      "instructions file (brand.instructionsFile)",
      "rule 2b: the instructions file named inside a STRING (brand.instructionsFile)",
    ]);
    expect(rules('const p = "winter_code";\n')).toHaveLength(1);
    expect(rules("const t = `mcp__winter__advisor`;\n")).toHaveLength(1);
    expect(rules('const k = "com.winter.core.dev";\n')).toHaveLength(1);
    expect(rules('const r = "/private/tmp/winter-501";\n')).toHaveLength(1);
    expect(rules('const c = { originator: "winter" };\n')).toHaveLength(1);
    expect(rules('const ua = "winter-agent-sdk/1.2.3";\n')).toHaveLength(1);

    // --- review r1, Important-4: the three additions, each on the spelling the repo ACTUALLY uses.
    // Every one of these was measured live in non-test source and was invisible to the gate.
    expect(rules('const dir = ".winter-plugin";\n')).toHaveLength(1); // plugins/manifest.ts:19
    expect(rules('const dev = ".winter-dev";\n')).toHaveLength(1);
    expect(rules("const root = join(base, `winter-${uid}`);\n")).toHaveLength(1); // paths/temp.ts:103
    expect(rules('const prefix = "winter-agent-sdk";\n')).toHaveLength(1); // validate.ts:92, identity.ts:74
    expect(rules("const v = (env ?? process.env).WINTER_TMPDIR;\n")).toHaveLength(1); // paths/temp.ts:71
    // Rule 10 (the property/key form) AND rule 10b (bare, in a string) both fire here -- the key IS
    // a string literal. The overlap is the same deliberate one as rule 2/2b above.
    expect(rules('const v = env["WINTER_HOME"];\n')).toEqual([
      "product env name spelled literally (envName(brand, ...))",
      "rule 10b: a product env name spelled bare inside a STRING (envName(brand, ...))",
    ]);
    expect(rules("const v = e.WINTER_PROJECT_DIR_NAME;\n")).toHaveLength(1); // paths/project-dir-name.ts:28

    // Near misses: an English sentence, a differently-suffixed file, another product's originator,
    // a token that merely STARTS with the brand, and a HARNESS env name on any receiver.
    expect(rules("// winter is a season and .winterish is not a directory\n")).toEqual([]);
    expect(rules('const f = "WINTER.mdx";\n')).toEqual([]);
    expect(rules('const c = { originator: "acme" };\n')).toEqual([]);
    expect(rules('const p = "winterish-agent-sdk";\n')).toEqual([]);
    expect(rules("const v = env.WINTER_TEST_PROVIDER;\n")).toEqual([]);
    expect(rules('const v = env["WINTER_COMPILED_BIN"];\n')).toEqual([]);
    expect(rules("const v = env.WINTER_HOMEBREW;\n")).toEqual([]); // the \b anchor, not a prefix match

    // --- P7a fix wave (item 5, M-1): rules 2b and 10b, each on the shape that survived every other
    // rule -- the token in the MIDDLE of a sentence, inside a string, with no quote beside it.
    expect(rules('const g = "Code, configuration and WINTER.md are durable on their own.";\n')).toEqual([
      "rule 2b: the instructions file named inside a STRING (brand.instructionsFile)",
    ]);
    expect(rules('throw new Error("Use WINTER_HOME=/tmp for ephemeral local writes.");\n')).toEqual([
      "rule 10b: a product env name spelled bare inside a STRING (envName(brand, ...))",
    ]);
    expect(rules("const s = `The project's loaded WINTER.md guidance:`;\n")).toEqual([
      "rule 2b: the instructions file named inside a STRING (brand.instructionsFile)",
    ]);

    // ...and the OTHER HALF of the ruling: a COMMENT saying the same thing is prose about the
    // mechanism, not text that leaves the process. Every module explaining the rebrand is full of it
    // (this file's own header included), and a rule that flagged comments would make the widening
    // unusable rather than useful.
    expect(rules("// WINTER.md is the instructions file; WINTER_HOME resolves the home.\n")).toEqual([]);
    expect(rules("/* The remedy names WINTER_HOME; see envName(brand, \"HOME\"). */\n")).toEqual([]);
    // A `${...}` expression is CODE, so an interpolated derivation inside a branded sentence is clean.
    expect(rules("const s = `Code and ${brand.instructionsFile} are durable.`;\n")).toEqual([]);
    // A harness variable is never a product surface, in a string or anywhere else.
    expect(rules('const s = "set WINTER_TEST_PACK_SMOKE=1 to run the pack legs";\n')).toEqual([]);
  });

  test("CLAUDE-MIRRORING literals are never matched — they are not ours to rebrand", () => {
    const src = [
      'const cfg = "CLAUDE_CONFIG_DIR";',
      'const tmp = "CLAUDE_CODE_TMPDIR";',
      'const preset = { preset: "claude_code" };',
      'const dir = ".claude-plugin";',
      'const seg = `claude-${uid}`;',
      'const stage = `claude-resume-${uuid}`;',
      'const id = "com.anthropic.claude-code";',
      'const aliases = ["sonnet", "opus", "haiku", "fable"];',
      "",
    ].join("\n");
    expect(scanFileForBrandLiterals("synthetic.ts", src)).toEqual([]);
  });
});


// ==================================================================================================
// P7a fix wave (item 12; whole-branch review §9 rec. 3): THE BRAND-LESS CALL-SITE GATE.
// ==================================================================================================
//
// THE SHAPE THE WHOLE-BRANCH REVIEW NAMED, made permanent. Every survivor it found was invisible to
// the literal gate above, and all four were the same thing: a value DERIVED FROM `WINTER_BRAND` AT
// MODULE LOAD, or a brand-taking function CALLED WITHOUT ITS BRAND.
//
//   * `sessions.ts` called `resolveWinterHome()` with no brand -- nine session functions addressing
//     Winter's store for every reuser (I-1);
//   * `WINTER_SERVER_NAME` was `WINTER_BRAND.mcpServerName` at module load, so two MCP doors read a
//     different name from the registry's per-session reservation (I-2);
//   * `checkpoint/sink.ts` defaulted to `resolveWinterHome(opts.env)` (M-5).
//
// None of them spells a literal, so rules 1-10 cannot see any of them, and the acme end-to-end test
// proves exactly ONE path. So this gate sweeps by CALL SITE instead of by token: every non-test,
// non-comment use of `resolveWinterHome(` with fewer than two arguments, of `envName(WINTER_BRAND`,
// and of `WINTER_BRAND.` outside `brand.ts` is enumerated against an ALLOWLIST that carries a
// one-line rationale per site. A new brand-less call site then fails BY NAME, the way a raw literal
// does -- and adding one deliberately costs a sentence saying why it is a default rather than a gap.
//
// WHAT IS LEGITIMATE, and every allowlisted entry is one of these two:
//   (a) a DEFAULT PARAMETER or a module-level DEFAULT CONSTANT that a branded caller overrides
//       (`limits.ts`'s `varName = envName(WINTER_BRAND, ...)`, overridden by `brand ?? WINTER_BRAND`
//       at its own call site; `WINTER_MD_BASENAME`; `DEFAULT_KEYCHAIN_SERVICE`);
//   (b) the `from` SIDE of a rename or a comparison AGAINST the default -- code whose whole job is
//       to know what Winter's own value is (`RESERVED_MCP_SERVER_NAMES`' seed, `query.ts`'s
//       "differs from the default, so emit the deprecated key" test, `WINTER_CODE_PRESET_VERSION`'s
//       attribution).
//
// COMMENTS ARE NOT MATCHED. Every one of these modules explains its own derivation in prose, and a
// gate that counted those would be unusable. `computeScanMask`'s `inCode` is the filter.

interface CallSiteRule {
  name: string;
  re: RegExp;
  /** Extra check on the match: `false` drops it (used for the arity test on `resolveWinterHome`). */
  keep?: (src: string, index: number, match: string) => boolean;
}

/**
 * True when the call starting at `openParenAt` has FEWER THAN TWO top-level arguments.
 *
 * `resolveWinterHome(env, brand)` is threaded and fine; `resolveWinterHome()` and
 * `resolveWinterHome(env)` are the defect. Counting top-level commas needs the mask, because a comma
 * inside a string, a comment, a nested call, an object literal or a generic is not an argument
 * separator -- and a naive count would let `resolveWinterHome(getEnv(a, b))` pass as two arguments.
 */
function callHasBrandArgument(src: string, openParenAt: number, inCode: Uint8Array): boolean {
  let depth = 0;
  let topLevelCommas = 0;
  let sawAnything = false;
  for (let i = openParenAt; i < src.length; i++) {
    if (inCode[i] !== 1) continue;
    const c = src[i] as string;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      if (c === ",") topLevelCommas++;
      else if (c.trim() !== "") sawAnything = true;
    }
  }
  void sawAnything;
  return topLevelCommas >= 1;
}

const CALL_SITE_RULES: readonly CallSiteRule[] = [
  {
    name: "resolveWinterHome() called with no brand argument",
    // Not preceded by an identifier char or a dot, so `opts.resolveWinterHome()` (a caller-supplied
    // thunk that resolved its own brand elsewhere) is a different symbol and is not swept.
    re: /(?<![\w.$])resolveWinterHome\(/g,
    keep: (src, index) => !callHasBrandArgument(src, index + "resolveWinterHome".length, computeScanMask(src).inCode),
  },
  { name: "envName(WINTER_BRAND, ...) -- an env name derived from the DEFAULT profile", re: /envName\(\s*WINTER_BRAND\b/g },
  { name: "WINTER_BRAND.<field> read outside brand.ts", re: /(?<![\w.$])WINTER_BRAND\./g },
];

export interface CallSiteUse {
  file: string;
  line: number;
  rule: string;
}

export function scanFileForBrandlessCallSites(relPath: string, src: string): CallSiteUse[] {
  const { inCode } = computeScanMask(src);
  const out: CallSiteUse[] = [];
  for (const rule of CALL_SITE_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(src); m !== null; m = rule.re.exec(src)) {
      if (inCode[m.index] !== 1) continue; // a comment explaining the derivation is not a use
      if (rule.keep !== undefined && !rule.keep(src, m.index, m[0])) continue;
      out.push({ file: relPath, line: src.slice(0, m.index).split("\n").length, rule: rule.name });
    }
  }
  return out;
}

/**
 * Every legitimate brand-less site in the tree, `file:line` with a one-line rationale.
 *
 * SEEDED FROM THE TREE AFTER I-1 AND M-5, so every entry is a site a human has judged. The LINE is
 * part of the key deliberately: a file that grows a SECOND brand-less use fails even though the file
 * is already listed, which is exactly the case a file-level entry would hide.
 */
const BRANDLESS_CALL_SITE_ALLOWLIST: Readonly<Record<string, string>> = {
  // --- (a) defaults a branded caller overrides -----------------------------------------------------
  "packages/sdk/src/sessions.ts:57": "the unbranded default: a caller that supplied NO brand gets Winter's home, which is what I-1 made explicit rather than implicit",
  "packages/sdk/src/options.ts:59": "DEFAULT_PLANS_DIRECTORY -- the default a session's `brand.projectDirName` replaces",
  "packages/sdk/src/options.ts:76": "DEFAULT_KEYCHAIN_SERVICE -- the default a host's own `brand.keychainService` replaces",
  "packages/sdk/src/query.ts:510": "the FALLBACK side of `options.brand?.envPrefix ?? WINTER_BRAND.envPrefix` (M-1's fix)",
  "packages/sdk/src/query.ts:669": "a COMPARISON against the default, deciding whether to emit the deprecated top-level key",
  "packages/runtime/src/subagents/limits.ts:38": "a DEFAULT PARAMETER; the call site passes `brand ?? WINTER_BRAND` (review §5.1 names this correct)",
  "packages/runtime/src/subagents/limits.ts:49": "a DEFAULT PARAMETER; same call site, same override",
  "packages/runtime/src/subagents/watchdog.ts:12": "a DEFAULT PARAMETER; the call site passes the session brand",
  "packages/runtime/src/context/memory.ts:77": "renderMemoryBlock's `instructionsFile` DEFAULT; the assembler passes `brand.instructionsFile` (M-1's fix)",
  "packages/runtime/src/context/winter-md.ts:40": "WINTER_MD_BASENAME -- Winter's own value; a session's comes from `brand.instructionsFile`",
  "packages/runtime/src/plugins/manifest.ts:23": "WINTER_PLUGIN_MANIFEST_DIR -- Winter's own value; `pluginManifestDirs(brand)` derives a session's",
  "packages/runtime/src/provider/classifier/prompt.ts:265": "the `instructionsFile` option's DEFAULT; session-provider.ts passes the session brand's (M-1's fix)",
  "packages/runtime/src/permissions/protected.ts:85": "the SEED of the protected set; `isProtectedWrite` adds the session brand's own file per call",
  "packages/runtime/src/skills/store.ts:43": "PROJECT_PLUGIN_NAME -- Winter's own value; a session's is `SkillIndexOptions.brand.projectDirName`",
  "packages/provider-runtime/src/identity.ts:64": "DEFAULT_IDENTITY -- what the process presents as until a branded session installs its own frame",
  "packages/provider-runtime/src/continuity/handoff.ts:46": "INSTRUCTION_FILE_BASENAMES -- a recognition list beside CLAUDE.md/AGENTS.md, not a path this code writes",
  "packages/provider-runtime/src/adapters/openai/codex-config.ts:57": "the codex profile's DEFAULT originator; the wire reads `activeWinterIdentity().codexOriginator`",
  "packages/provider-runtime/src/adapters/openai/codex-config.ts:62": "CODEX_ORIGINATOR -- the same default, exported for the fixtures that assert it",
  "packages/provider-runtime/src/adapters/openai/xai-oauth.ts:63": "DOCUMENTATION ONLY (that row's own comment): nothing reads it; all three wire sites read `activeWinterIdentity().product`",
  // --- (b) the `from` side of a rename, or a comparison against the default ------------------------
  "packages/runtime/src/tools/registry.ts:701": "RESERVED_MCP_SERVER_NAMES' module-load SEED -- the `from` side; `rebrandStandingServerTools` adds the session's own name",
  "packages/runtime/src/mcp/winter-server.ts:38": "WINTER_SERVER_NAME -- the DEFAULT for both MCP doors' `reservedServerName` (I-2's fix), and the rename's `from` side",
  "packages/runtime/src/context/winter-code-preset.ts:48": "WINTER_CODE_PRESET_VERSION -- an ATTRIBUTION of who authored the preset, not a name a reuser renames",
  // --- scripts: this repository's own harness ------------------------------------------------------
  "scripts/verify-provider-live.ts:767": "the live gate is Winter's own harness and runs under no brand but Winter's",
};

describe("P7a fix wave (item 12): every brand-less call site is named and justified", () => {
  const uses = (() => {
    const out: CallSiteUse[] = [];
    for (const file of collectSourceFiles()) {
      if (file === BRAND_MODULE) continue; // the one module allowed to BE the default
      out.push(...scanFileForBrandlessCallSites(file, readFileSync(join(REPO_ROOT, file), "utf8")));
    }
    return out;
  })();

  test("no UNJUSTIFIED brand-less call site exists", () => {
    const unexpected = uses.filter((u) => BRANDLESS_CALL_SITE_ALLOWLIST[`${u.file}:${u.line}`] === undefined);
    const detail = unexpected.map((u) => `  ${u.file}:${u.line}  [${u.rule}]`).join("\n");
    expect(
      unexpected.length === 0
        ? ""
        : `brand-less call sites with no rationale (add one line to BRANDLESS_CALL_SITE_ALLOWLIST saying why this is a DEFAULT and not a missing argument, or thread the brand):\n${detail}`,
    ).toBe("");
  });

  test("the allowlist has no STALE entries -- a threaded call site must be deleted from it", () => {
    // The other direction, and it is what keeps the list a record of judgements rather than a
    // graveyard: threading a brand and leaving the entry behind would make the next reader believe
    // a default is still there.
    const present = new Set(uses.map((u) => `${u.file}:${u.line}`));
    expect(Object.keys(BRANDLESS_CALL_SITE_ALLOWLIST).filter((k) => !present.has(k))).toEqual([]);
  });

  test("every rationale is a real sentence, and the sweep is not vacuous", () => {
    for (const [site, why] of Object.entries(BRANDLESS_CALL_SITE_ALLOWLIST)) {
      expect([site, why.length > 25]).toEqual([site, true]);
    }
    // A scanner that matched nothing would pass both tests above forever.
    expect(uses.length).toBeGreaterThan(15);
    expect(new Set(uses.map((u) => u.rule)).size).toBe(CALL_SITE_RULES.length);
  });

  test("the scanner's arity test and comment filter both work (plants)", () => {
    const scan = (src: string): string[] => scanFileForBrandlessCallSites("synthetic.ts", src).map((u) => u.rule);
    // A BRANDED call is not a use.
    expect(scan("const h = resolveWinterHome(env, brand);\n")).toEqual([]);
    // (The DEFINITION `export function resolveWinterHome(env?, brand?)` is two-parameter, so it is
    // not a use either -- which is why `paths/home.ts` needs no allowlist entry at all.)
    expect(scan("const h = resolveWinterHome(input.env, config.brand ?? WINTER_BRAND);\n")).toEqual([]);
    expect(scan("export function resolveWinterHome(env?: E, brand?: B): string {\n  return x;\n}\n")).toEqual([]);
    // A brand-LESS one is, in both spellings.
    expect(scan("const h = resolveWinterHome();\n")).toEqual(["resolveWinterHome() called with no brand argument"]);
    expect(scan("const h = resolveWinterHome(opts.env);\n")).toEqual(["resolveWinterHome() called with no brand argument"]);
    // A nested call's own comma is not an argument separator.
    expect(scan("const h = resolveWinterHome(pick(a, b));\n")).toEqual(["resolveWinterHome() called with no brand argument"]);
    // A method of the same name on an options object is a different symbol.
    expect(scan("const h = opts.resolveWinterHome();\n")).toEqual([]);
    // Comments explaining the derivation are never uses -- every one of these modules has them.
    expect(scan("// resolveWinterHome() and WINTER_BRAND.homeDirName are what this replaces\n")).toEqual([]);
    expect(scan("/* defaults to envName(WINTER_BRAND, \"HOME\") */\n")).toEqual([]);
    // ...and a string mentioning them is not a use either.
    expect(scan('const s = "resolveWinterHome() reads WINTER_BRAND.homeDirName";\n')).toEqual([]);
    // The two brand-derived reads, each on its own.
    // `envName(WINTER_BRAND, ...)` has no `.` after the identifier, so ONLY the env-name rule fires --
    // the two are genuinely different shapes, not one shape counted twice.
    expect(scan('const v = envName(WINTER_BRAND, "HOME");\n')).toEqual(["envName(WINTER_BRAND, ...) -- an env name derived from the DEFAULT profile"]);
    expect(scan("const n = WINTER_BRAND.mcpServerName;\n")).toEqual(["WINTER_BRAND.<field> read outside brand.ts"]);
    // A DIFFERENT profile object is not the default profile.
    expect(scan("const n = ACME_BRAND.mcpServerName;\n")).toEqual([]);
  });
});
