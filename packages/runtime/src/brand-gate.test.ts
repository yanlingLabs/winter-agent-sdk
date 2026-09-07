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
//   * CLAUDE-MIRRORING literals are never matched at all (WS-01 §5, D16/D19): `claude-<uid>`,
//     `claude-resume-<uuid>`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`, `preset: "claude_code"`,
//     the `AgentInput.model` aliases, `.claude-plugin`, `com.anthropic.claude-code`. They are the
//     official runtime's own names; rebranding them would be a lie, not a personalisation.
//   * HARNESS/TEST env names are never matched: `WINTER_TEST_*`, `WINTER_LIVE_*`,
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
  { name: "home/project dot-dir (brand.homeDirName / brand.projectDirName)", re: /["'`]\.winter["'`/]/ },
  { name: "instructions file (brand.instructionsFile)", re: /["'`]WINTER\.md["'`]/ },
  { name: "preset name (brand.presetName)", re: /["'`]winter_code["'`]/ },
  { name: "MCP tool name (mcpToolName(brand, ...))", re: /mcp__winter__/ },
  { name: "keychain service (brand.keychainService)", re: /com\.winter\./ },
  { name: "shared temp root (brand.tempRootName)", re: /\/private\/tmp\/winter-/ },
  { name: "codex originator (brand.codexOriginator)", re: /originator:\s*["']winter["']/ },
  { name: "product token in an identity string (userAgent(brand, ...))", re: /["'`]winter-agent-sdk\// },
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

// ================================================================================================
// The scanner rule 9 needs: brace depth, with strings/comments/templates/regexes discounted.
// ================================================================================================

export interface ScanMask {
  /** Brace depth at each index; `0` is module top level. */
  depths: Int32Array;
  /** Whether each index is REAL CODE — not inside a string, template, comment or regex literal. */
  inCode: Uint8Array;
}

/**
 * The two facts rule 9 needs at every character index: brace depth, and whether this is real code.
 *
 * BOTH are load-bearing, and the second was found missing by this file's own plant tests: depth
 * alone flags a module-header COMMENT that merely mentions `process.env.WINTER_HOME` while
 * explaining why not to write one — a gate whose first output is a false positive against its own
 * documentation teaches everyone to add allowlist entries instead of reading it. Rule 9 is about a
 * READ, so a match must be code.
 *
 * A single pass with an explicit state machine rather than a parser: this file must not add a
 * TypeScript dependency to run a lint rule. The one genuinely ambiguous token in JavaScript's
 * grammar is `/` (division vs. the start of a regex literal), resolved by the standard
 * previous-significant-character heuristic — and a misread there can only ever move a match from
 * "top level" to "nested" or back, never invent or delete a match. Since BASELINE_ALLOWLIST is
 * generated by THIS function, a false POSITIVE is absorbed into the baseline; a false NEGATIVE is
 * the real hazard, which is what the plant tests at the bottom of this file exist to rule out.
 */
export function computeScanMask(src: string): ScanMask {
  const depths = new Int32Array(src.length);
  const inCode = new Uint8Array(src.length);
  type State = "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "regex";
  let state: State = "code";
  let depth = 0;
  // Brace depth at each still-open `${`, so its matching `}` returns to the template rather than
  // being counted as closing a block.
  const templateExprDepths: number[] = [];
  let prevSignificant = "";
  const regexCanFollow = (prev: string): boolean => prev === "" || "(,=:[!&|?{};+-*%~^<>\n".includes(prev);

  for (let i = 0; i < src.length; i++) {
    depths[i] = depth;
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
        else if (c === "{") depth++;
        else if (c === "}") {
          const open = templateExprDepths[templateExprDepths.length - 1];
          if (open !== undefined && depth === open) {
            templateExprDepths.pop();
            state = "tmpl";
          } else depth--;
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
          // NO depth++: a template EXPRESSION sits at the same nesting level as the template that
          // contains it. `export const s = `${process.env.WINTER_HOME}/x`` is a module-load read and
          // must read as depth 0; the same expression inside a function body reads as depth 1
          // because the function's own brace already counted.
          templateExprDepths.push(depth);
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
    if (state === "code" && c.trim() !== "") prevSignificant = c;
  }
  return { depths, inCode };
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
  const { depths, inCode } = computeScanMask(src);
  TOP_LEVEL_ENV_RE.lastIndex = 0;
  for (let m = TOP_LEVEL_ENV_RE.exec(src); m !== null; m = TOP_LEVEL_ENV_RE.exec(src)) {
    if (depths[m.index] !== 0 || inCode[m.index] !== 1) continue;
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
 * fails the first test; sweeping a file WITHOUT deleting its entry fails the second.
 */
const BASELINE_ALLOWLIST: readonly string[] = [
  // --- packages/provider-runtime (Lane A: identity.ts's body, the codex originator, the keychain service) 
  "packages/provider-runtime/src/adapters/openai/codex-config.ts",
  "packages/provider-runtime/src/adapters/openai/xai-oauth.ts",
  "packages/provider-runtime/src/continuity/handoff.ts",
  "packages/provider-runtime/src/identity.ts",
  // --- packages/runtime (Lane A unless another lane's ownership row names the file) -------------
  "packages/runtime/src/commands/resolver.ts",
  "packages/runtime/src/commands/seam.ts",
  "packages/runtime/src/context/memory.ts",
  "packages/runtime/src/context/minimal-prompt.ts",
  "packages/runtime/src/context/output-styles.ts",
  "packages/runtime/src/context/plan-mode.ts",
  "packages/runtime/src/context/seam.ts",
  "packages/runtime/src/context/winter-code-preset.ts",
  "packages/runtime/src/context/winter-md.ts",
  "packages/runtime/src/engine.ts",
  "packages/runtime/src/hooks/registry.ts",
  "packages/runtime/src/main.ts",
  "packages/runtime/src/mcp/lifecycle.ts",
  "packages/runtime/src/mcp/winter-server.ts",
  "packages/runtime/src/permissions/edit-recognition.ts",
  "packages/runtime/src/permissions/evaluator.ts",
  "packages/runtime/src/permissions/protected.ts",
  "packages/runtime/src/permissions/ruleset.ts",
  "packages/runtime/src/plugins/bundle.ts",
  "packages/runtime/src/plugins/loader.ts",
  "packages/runtime/src/production-wiring.ts",
  "packages/runtime/src/provider/credential-api.ts",
  "packages/runtime/src/provider/keychain-store.ts",
  "packages/runtime/src/sandbox/profile.ts",
  "packages/runtime/src/settings/loaders/mcp-config.ts",
  "packages/runtime/src/skills/frontmatter.ts",
  "packages/runtime/src/skills/loader.ts",
  "packages/runtime/src/skills/option.ts",
  "packages/runtime/src/skills/permission-rules.ts",
  "packages/runtime/src/skills/store.ts",
  "packages/runtime/src/subagents/definitions.ts",
  "packages/runtime/src/subagents/policy.ts",
  "packages/runtime/src/subagents/workspace.ts",
  "packages/runtime/src/testing.ts",
  "packages/runtime/src/tools/descriptors/advisor.ts",
  "packages/runtime/src/tools/descriptors/cron-create.ts",
  "packages/runtime/src/tools/descriptors/enter-worktree.ts",
  "packages/runtime/src/tools/descriptors/winter-list-agents.ts",
  "packages/runtime/src/tools/descriptors/winter-send-message.ts",
  "packages/runtime/src/tools/descriptors/workflow.ts",
  "packages/runtime/src/tools/impl/advisor.ts",
  "packages/runtime/src/tools/impl/agent.ts",
  "packages/runtime/src/tools/impl/cron.ts",
  "packages/runtime/src/tools/impl/enter-worktree.ts",
  "packages/runtime/src/tools/impl/list-agents.ts",
  "packages/runtime/src/tools/impl/send-message.ts",
  "packages/runtime/src/tools/registry.ts",
  "packages/runtime/src/toolsearch/aliases.ts",
  "packages/runtime/src/workflows/bridge.ts",
  "packages/runtime/src/workflows/host-registry.ts",
  "packages/runtime/src/workflows/meta.ts",
  "packages/runtime/src/workflows/runtime.ts",
  "packages/runtime/src/workflows/script-api.ts",
  "packages/runtime/src/workflows/store.ts",
  "packages/runtime/src/workflows/subprocess-entry.ts",
  // --- scripts (Lane A) -------------------------------------------------------------------------
  "scripts/differential.ts",
  "scripts/verify-provider-live.ts",
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
    console.log(`[brand-gate] scanned ${scanned.length} non-test files; ${new Set(offences.map((o) => o.file)).size} still carry a literal (${summary}); ${offences.length} occurrences`);
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

  test("the eight raw rules each fire on their own literal and not on a near miss", () => {
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
    // Near misses: an English sentence, a differently-suffixed file, another product's originator,
    // and the bare package name with no version separator.
    expect(rules("// winter is a season and .winterish is not a directory\n")).toEqual([]);
    expect(rules('const f = "WINTER.mdx";\n')).toEqual([]);
    expect(rules('const c = { originator: "acme" };\n')).toEqual([]);
    expect(rules('const name = "winter-agent-sdk";\n')).toEqual([]);
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
