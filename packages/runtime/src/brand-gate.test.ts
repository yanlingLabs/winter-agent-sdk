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
//     Each lane deletes its own entries as it sweeps them; P7a's close-out asserts the list is
//     empty. A listed file is a debt with a name, not a permission.
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
// carries its own scanner for it (`computeScanMask`), plant-tested below. To REGENERATE the
// baseline after a sweep: delete the entries you fixed and run this file; a stale entry fails the
// second test by name, and a missed file fails the first with its path and the rule it tripped.
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
  return { functionDepths, inCode };
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
  const { functionDepths, inCode } = computeScanMask(src);
  TOP_LEVEL_ENV_RE.lastIndex = 0;
  for (let m = TOP_LEVEL_ENV_RE.exec(src); m !== null; m = TOP_LEVEL_ENV_RE.exec(src)) {
    if (functionDepths[m.index] !== 0 || inCode[m.index] !== 1) continue;
    const line = src.slice(0, m.index).split("\n").length;
    found.push({ file: relPath, rule: "MODULE-LOAD read of a product env name (rule 9)", line, text: m[0] });
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
    expect(rules('const f = "WINTER.md";\n')).toHaveLength(1);
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
    expect(rules('const v = env["WINTER_HOME"];\n')).toHaveLength(1);
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

