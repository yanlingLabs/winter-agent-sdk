// The edge cases of the permission rule grammar, the file-rule pipeline and the path-safety checks,
// each stated as observable behaviour. These are the specification the implementations are written
// against; `rule-corpus.differential.test.ts` separately proves that no decision changed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSuspiciousPath } from "./evaluator.ts";
import {
  ancestorDirectoriesOf,
  canonicalizeTrustedSymlinkPath,
  escapeFileRulePathSegment,
  globToSbplRegexSource,
  isPathWithinRoot,
  isSuspiciousRealpathResolution,
  matchFileRulesGrouped,
  normalizeFileRulePattern,
  recursiveGlobToSbplRegexSource,
  resolveFileRuleAnchor,
  resolvesWithinPluginRoot,
  unanchorTrailingDoubleStar,
} from "./file-rules.ts";
import { escapeRegExpLiteral, parseRule, validatePermissionRuleString } from "./grammar.ts";
import { resolveSymlinkTargetChain, resolveTargetPath } from "./paths.ts";

// ---------------------------------------------------------------------------------------------
// `Tool(content)` parsing
// ---------------------------------------------------------------------------------------------

describe("parseRule: finding the parenthesised content", () => {
  test("a parenthesis counts only when an EVEN run of backslashes (none included) precedes it", () => {
    // `Bash(a\\)`: the two backslashes escape each other, so the `)` closes the content.
    expect(parseRule("Bash(a\\\\)")).toEqual({ toolName: "Bash", specifier: { kind: "pattern", source: "a\\" }, isBareEquivalent: false });
    // `Bash(a\)`: one backslash escapes the `)`, so nothing closes the content and the whole text is a bare name.
    expect(parseRule("Bash(a\\)")).toEqual({ toolName: "Bash(a\\)", isBareEquivalent: true });
  });

  test("the content opens at the first unescaped `(` and must close at the very last character", () => {
    expect(parseRule("Bash(echo (a))")).toEqual({ toolName: "Bash", specifier: { kind: "pattern", source: "echo (a)" }, isBareEquivalent: false });
    expect(parseRule("Bash(ls) x")).toEqual({ toolName: "Bash(ls) x", isBareEquivalent: true });
  });

  test("an empty tool name, or one containing whitespace, makes the whole text a bare name", () => {
    expect(parseRule("(foo)")).toEqual({ toolName: "(foo)", isBareEquivalent: true });
    expect(parseRule("Read foo(bar)")).toEqual({ toolName: "Read foo(bar)", isBareEquivalent: true });
  });

  test("the rule text is trimmed at both ends first", () => {
    expect(parseRule("  Bash(ls)\n")).toEqual({ toolName: "Bash", specifier: { kind: "pattern", source: "ls" }, isBareEquivalent: false });
  });

  test("`Tool()` and `Tool(*)` are the bare tool, for every tool (MCP and WebSearch included)", () => {
    for (const raw of ["Bash()", "Bash(*)", "Read()", "WebSearch()", "WebSearch(*)", "mcp__s__x()", "mcp__s__x(*)"]) {
      expect(parseRule(raw)).toEqual({ toolName: raw.slice(0, raw.indexOf("(")), specifier: { kind: "wildcardAll" }, isBareEquivalent: true });
    }
  });
});

describe("parseRule: unescaping the content", () => {
  test("`\\(` becomes `(`, `\\)` becomes `)` and `\\\\` becomes `\\`", () => {
    expect(parseRule("Bash(ls\\(x\\))")).toMatchObject({ specifier: { source: "ls(x)" } });
    expect(parseRule("Bash(a\\\\\\\\b)")).toMatchObject({ specifier: { source: "a\\\\b" } });
    expect(parseRule("Read(Project \\(old\\)/x)")).toMatchObject({ specifier: { source: "Project (old)/x" } });
  });

  test("an escaped backslash followed by an escaped paren keeps one backslash and the paren", () => {
    // Content `\\\(x` (three backslashes, a paren): reads as an escaped backslash, then an escaped paren.
    expect(parseRule("Bash(\\\\\\(x)")).toMatchObject({ specifier: { source: "\\(x" } });
  });

  test("any other backslash is kept as written", () => {
    expect(parseRule("Read(sp\\ )")).toMatchObject({ specifier: { source: "sp\\ " } });
    expect(parseRule("Bash(a\\*b)")).toMatchObject({ specifier: { source: "a\\*b" } });
  });

  test("a parenthesised MCP rule parses as an invalid specifier, never a working one", () => {
    expect(parseRule("mcp__s__t(x)")).toMatchObject({ toolName: "mcp__s__t", specifier: { kind: "invalid" }, isBareEquivalent: false });
  });
});

// ---------------------------------------------------------------------------------------------
// The settings-load validator
// ---------------------------------------------------------------------------------------------

describe("validatePermissionRuleString", () => {
  const WILDCARD_SUGGESTION =
    "An allow pattern must name the scope it widens \u2014 globs are permitted only in the tool position after a literal mcp__<server>__ prefix. Deny and ask rules accept wildcards anywhere";

  test("empty and whitespace-only rules are refused", () => {
    expect(validatePermissionRuleString("", "deny")).toEqual({ valid: false, error: "Permission rule cannot be empty" });
    expect(validatePermissionRuleString("  ", "allow")).toEqual({ valid: false, error: "Permission rule cannot be empty" });
  });

  test("unescaped parentheses must balance; escaped ones are not counted", () => {
    expect(validatePermissionRuleString("Bash(a(b)", "deny")).toEqual({
      valid: false,
      error: "Mismatched parentheses",
      suggestion: "Ensure all opening parentheses have matching closing parentheses",
    });
    expect(validatePermissionRuleString("Read(\\()", "deny")).toEqual({ valid: true });
  });

  test("an unescaped `()` is refused, naming the tool when there is one", () => {
    expect(validatePermissionRuleString("Bash()", "deny")).toEqual({
      valid: false,
      error: "Empty parentheses",
      suggestion: 'Either specify a pattern or use just "Bash" without parentheses',
    });
    expect(validatePermissionRuleString("()", "deny")).toEqual({
      valid: false,
      error: "Empty parentheses with no tool name",
      suggestion: "Specify a tool name before the parentheses",
    });
  });

  test("MCP names take no parenthesised content", () => {
    expect(validatePermissionRuleString("mcp__s__t(x)", "deny")).toEqual({
      valid: false,
      error: "MCP rules do not support patterns in parentheses",
      suggestion: 'Use "mcp__s__t" without parentheses, or use "mcp__s__*" for all tools',
    });
    expect(validatePermissionRuleString("mcp__s__t", "allow")).toEqual({ valid: true });
  });

  test("allow rules refuse a wildcard tool name unless it follows a literal `mcp__<server>__`", () => {
    for (const raw of ["Bash*", "*", "mcp__*", "mcp__s*__t", "mcp__*__t"]) {
      expect(validatePermissionRuleString(raw, "allow")).toEqual({ valid: false, error: `Wildcard tool name "${raw}" is not supported in allow rules`, suggestion: WILDCARD_SUGGESTION });
      expect(validatePermissionRuleString(raw, "deny")).toEqual({ valid: true });
      expect(validatePermissionRuleString(raw, "ask")).toEqual({ valid: true });
    }
    expect(validatePermissionRuleString("mcp__s__*", "allow")).toEqual({ valid: true });
  });

  test("a tool name must start upper-case unless it contains an underscore", () => {
    expect(validatePermissionRuleString("bash(ls)", "deny")).toEqual({ valid: false, error: "Tool names must start with uppercase", suggestion: 'Use "Bash"' });
    expect(validatePermissionRuleString("_x(y)", "deny")).toEqual({ valid: true });
    // A tool name with no letter case at all (the whole text, when nothing opens the content) passes.
    expect(validatePermissionRuleString("(foo)", "deny")).toEqual({ valid: true });
  });

  test("WebSearch and WebFetch have their own content checks", () => {
    expect(validatePermissionRuleString("WebSearch(a*)", "deny")).toEqual({ valid: false, error: "WebSearch does not support wildcards", suggestion: "Use exact search terms without * or ?" });
    expect(validatePermissionRuleString("WebSearch(a?)", "deny")).toMatchObject({ valid: false, error: "WebSearch does not support wildcards" });
    expect(validatePermissionRuleString("WebFetch(https://x)", "deny")).toEqual({ valid: false, error: "WebFetch permissions use domain format, not URLs", suggestion: 'Use "domain:hostname" format' });
    expect(validatePermissionRuleString("WebFetch(httpbin)", "deny")).toMatchObject({ valid: false, error: "WebFetch permissions use domain format, not URLs" });
    expect(validatePermissionRuleString("WebFetch(x)", "deny")).toEqual({ valid: false, error: 'WebFetch permissions must use "domain:" prefix', suggestion: 'Use "domain:hostname" format' });
    expect(validatePermissionRuleString("WebFetch(domain:x)", "allow")).toEqual({ valid: true });
  });

  test("Bash's `:*` must end the content and follow a prefix", () => {
    expect(validatePermissionRuleString("Bash(a:*b)", "deny")).toEqual({ valid: false, error: "The :* pattern must be at the end", suggestion: "Move :* to the end for prefix matching, or use * for wildcard matching" });
    expect(validatePermissionRuleString("Bash(:*)", "deny")).toEqual({ valid: false, error: "Prefix cannot be empty before :*", suggestion: "Specify a command prefix before :*" });
    expect(validatePermissionRuleString("Bash(ls:*)", "allow")).toEqual({ valid: true });
  });

  test("an earlier `:*` is accepted when the content also ENDS with `:*`", () => {
    for (const raw of ["Bash(a:*b:*)", "Bash(:*:*)", "Bash(:*a:*)"]) expect(validatePermissionRuleString(raw, "deny")).toEqual({ valid: true });
  });

  test("`:*` is refused on the file-pattern tools of the load-time list -- which has Cd and NotebookRead and not Grep", () => {
    const refusal = { valid: false, error: 'The ":*" syntax is only for Bash prefix rules', suggestion: 'Use glob patterns like "*" or "**" for file matching' };
    for (const tool of ["Read", "Write", "Edit", "Glob", "NotebookRead", "NotebookEdit", "Cd"]) expect(validatePermissionRuleString(`${tool}(x:*)`, "deny")).toEqual(refusal);
    expect(validatePermissionRuleString("Grep(foo:*)", "deny")).toEqual({ valid: true });
  });

  test("the validator reads the content without the parser's whitespace guard", () => {
    // `Read foo(x:*)`: the validator takes `Read foo` as the tool name, which is no file tool, so `:*` passes.
    expect(validatePermissionRuleString("Read foo(x:*)", "deny")).toEqual({ valid: true });
  });
});

// ---------------------------------------------------------------------------------------------
// File-rule patterns
// ---------------------------------------------------------------------------------------------

describe("resolveFileRuleAnchor: the four anchor spellings", () => {
  test("`//x` is filesystem-root-anchored and keeps its leading slash", () => {
    expect(resolveFileRuleAnchor("//etc/passwd", { home: "/h" })).toEqual({ relativePattern: "/etc/passwd", root: "/" });
  });
  test("`~/x` is home-anchored and keeps its leading slash", () => {
    expect(resolveFileRuleAnchor("~/.ssh/**", { home: "/h" })).toEqual({ relativePattern: "/.ssh/**", root: "/h" });
  });
  test("`/x` resolves against the settings source directory, kept whole; without one it can match nothing", () => {
    expect(resolveFileRuleAnchor("/src/**", { home: "/h", sourceDir: "/s" })).toEqual({ relativePattern: "/src/**", root: "/s" });
    const inert = resolveFileRuleAnchor("/src/**", { home: "/h" });
    expect(inert.relativePattern).toBe("/src/**");
    expect(typeof inert.root).toBe("symbol");
    expect(matchFileRulesGrouped([{ entry: 1, pattern: "/src/**" }], "/w/src/a", { cwd: "/w", home: "/h" }, "denyAsk")).toBeNull();
  });
  test("`./x` drops the `./` and is cwd-relative WITHOUT a leading slash, so it can match at any depth", () => {
    expect(resolveFileRuleAnchor("./.env", { home: "/h" })).toEqual({ relativePattern: ".env", root: null });
    expect(matchFileRulesGrouped([{ entry: 1, pattern: "./.env" }], "/w/pkg/.env", { cwd: "/w", home: "/h" }, "denyAsk")).toBe(1);
  });
  test("anything else, a bare `~` included, is cwd-relative as written", () => {
    expect(resolveFileRuleAnchor("~", { home: "/h" })).toEqual({ relativePattern: "~", root: null });
    expect(resolveFileRuleAnchor("src/**", { home: "/h" })).toEqual({ relativePattern: "src/**", root: null });
  });
});

describe("normalizeFileRulePattern", () => {
  test("collapses runs of slashes", () => {
    expect(normalizeFileRulePattern("a//b///c")).toBe("a/b/c");
  });
  test("a leading byte-order mark is dropped, or turned into an escape when a `!` or `#` follows it", () => {
    expect(normalizeFileRulePattern("\uFEFFa")).toBe("a");
    expect(normalizeFileRulePattern("\uFEFF!a")).toBe("\\!a");
    expect(normalizeFileRulePattern("\uFEFF#a")).toBe("\\#a");
    expect(normalizeFileRulePattern("a\uFEFF")).toBe("a\uFEFF");
  });
  test("a SECOND leading byte-order mark, left at the front once the first is gone, becomes the class `[\uFEFF]`", () => {
    expect(normalizeFileRulePattern("\uFEFF\uFEFFa")).toBe("[\uFEFF]a");
    expect(normalizeFileRulePattern("\uFEFF\uFEFF!a")).toBe("[\uFEFF]!a");
    expect(normalizeFileRulePattern("\uFEFF!\uFEFFa")).toBe("\\!\uFEFFa");
  });
  test("whitespace-only text, optionally followed by `/**`, is returned untouched (a lone BOM included)", () => {
    expect(normalizeFileRulePattern("  ")).toBe("  ");
    expect(normalizeFileRulePattern(" /**")).toBe(" /**");
    expect(normalizeFileRulePattern("/**")).toBe("/**");
    expect(normalizeFileRulePattern("\uFEFF")).toBe("\uFEFF");
    expect(normalizeFileRulePattern("")).toBe("");
  });
});

describe("unanchorTrailingDoubleStar", () => {
  test("deny/ask: a trailing `/**` is dropped and the rest left unanchored", () => {
    expect(unanchorTrailingDoubleStar("x/**", false)).toBe("x");
    expect(unanchorTrailingDoubleStar("a/b/**", false)).toBe("a/b");
  });
  test("allow: a single remaining segment is re-anchored with a leading `/`", () => {
    expect(unanchorTrailingDoubleStar("x/**", true)).toBe("/x");
    expect(unanchorTrailingDoubleStar("a/b/**", true)).toBe("a/b");
    expect(unanchorTrailingDoubleStar("!x/**", true)).toBe("!x");
    expect(unanchorTrailingDoubleStar("#x/**", true)).toBe("#x");
  });
  test("nothing but slashes before `/**` gives `/**`; no trailing `/**` means no change", () => {
    expect(unanchorTrailingDoubleStar("/**", true)).toBe("/**");
    expect(unanchorTrailingDoubleStar("//**", false)).toBe("/**");
    expect(unanchorTrailingDoubleStar("**", false)).toBe("**");
    expect(unanchorTrailingDoubleStar("x/**/y", false)).toBe("x/**/y");
  });
});

describe("matchFileRulesGrouped", () => {
  const ctx = { cwd: "/w", home: "/h" };
  test("rules sharing a root are matched together, so a `!` rule re-includes what an earlier rule excluded", () => {
    const group = [
      { entry: "all", pattern: "src/*" },
      { entry: "keep", pattern: "!src/keep.txt" },
    ];
    expect(matchFileRulesGrouped(group, "/w/src/a.ts", ctx, "denyAsk")).toBe("all");
    expect(matchFileRulesGrouped(group, "/w/src/keep.txt", ctx, "denyAsk")).toBeNull();
  });
  test("... but not below an excluded DIRECTORY: deny `src/**` becomes `src`, and a file under an excluded directory cannot be re-included", () => {
    const group = [
      { entry: "all", pattern: "src/**" },
      { entry: "keep", pattern: "!src/keep.txt" },
    ];
    expect(matchFileRulesGrouped(group, "/w/src/keep.txt", ctx, "denyAsk")).toBe("all");
  });
  test("a name that merely starts with `..` is inside the root; a path outside the root is never matched", () => {
    expect(matchFileRulesGrouped([{ entry: 1, pattern: "*.sh" }], "/w/..x/evil.sh", ctx, "denyAsk")).toBe(1);
    expect(matchFileRulesGrouped([{ entry: 1, pattern: "*.sh" }], "/elsewhere/evil.sh", ctx, "denyAsk")).toBeNull();
  });
  test("matching ignores case", () => {
    expect(matchFileRulesGrouped([{ entry: 1, pattern: "SRC/*.TS" }], "/w/src/a.ts", ctx, "denyAsk")).toBe(1);
  });
});

describe("escapeFileRulePathSegment", () => {
  test("escapes `[`, `]`, `*` and `\\`, leaves `?` as a wildcard, and escapes a trailing whitespace run one character at a time", () => {
    expect(escapeFileRulePathSegment("/a[b]*c\\d?e f \t")).toBe("/a\\[b\\]\\*c\\\\d?e f\\ \\\t");
  });
  test("whitespace inside the path is not escaped", () => {
    expect(escapeFileRulePathSegment("/a b/c")).toBe("/a b/c");
  });
});

describe("sandbox regex rendering of an absolute glob", () => {
  test("`**/` is any run of whole segments, `**` anything, `*` and `?` stay inside one segment, a class stays a class", () => {
    expect(globToSbplRegexSource("/nx/a.b/**/c?[x]*/d**/e")).toBe("^/nx/a\\.b/(.*/)?c[^/][x][^/]*/d(.*/)?e$");
    expect(globToSbplRegexSource("/nx/a/**")).toBe("^/nx/a/.*$");
  });
  test("regex metacharacters are escaped, and an unclosed trailing `[` is escaped too", () => {
    expect(globToSbplRegexSource("/nx/(a)+{b}|^$/*/[ab")).toBe("^/nx/\\(a\\)\\+\\{b\\}\\|\\^\\$/[^/]*/\\[ab$");
  });
  test("the recursive form also matches everything below the match", () => {
    expect(recursiveGlobToSbplRegexSource("/nx/a/*.ts")).toBe("^/nx/a/[^/]*\\.ts(/.*)?$");
  });
});

describe("isSuspiciousRealpathResolution: when a resolved glob prefix is not trusted", () => {
  test("an unchanged path, the /tmp and /var aliases, and a deeper descendant are trusted", () => {
    expect(isSuspiciousRealpathResolution("/a/b", "/a/b")).toBe(false);
    expect(isSuspiciousRealpathResolution("/tmp/x", "/private/tmp/x")).toBe(false);
    expect(isSuspiciousRealpathResolution("/var/x", "/private/var/x")).toBe(false);
    expect(isSuspiciousRealpathResolution("/a/b", "/a/b/c")).toBe(false);
    expect(isSuspiciousRealpathResolution("/tmp/x", "/private/tmp/x/y")).toBe(false);
  });
  test("a resolution to the root, to a top-level directory, to an ancestor or to a sibling is not", () => {
    expect(isSuspiciousRealpathResolution("/a/b", "/")).toBe(true);
    expect(isSuspiciousRealpathResolution("/a/b", "/etc")).toBe(true);
    expect(isSuspiciousRealpathResolution("/a/b/c", "/a/b")).toBe(true);
    expect(isSuspiciousRealpathResolution("/a/b", "/a/c")).toBe(true);
    expect(isSuspiciousRealpathResolution("/tmp/x/y", "/private/tmp/x")).toBe(true);
  });
});

describe("ancestorDirectoriesOf", () => {
  test("every parent up to (not including) the root, nearest first", () => {
    expect(ancestorDirectoriesOf("/a/b/c")).toEqual(["/a/b", "/a"]);
    expect(ancestorDirectoriesOf("/a")).toEqual([]);
    expect(ancestorDirectoriesOf("a/b/c")).toEqual(["a/b", "a"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Path checks
// ---------------------------------------------------------------------------------------------

describe("isPathWithinRoot: a plain path-prefix test", () => {
  test("glob characters in either path are literal", () => {
    expect(isPathWithinRoot("/w/[wip] app/x", "/w/[wip] app")).toBe(true);
  });
  test("folds case by default and not when asked", () => {
    expect(isPathWithinRoot("/W/Proj/a", "/w/proj")).toBe(true);
    expect(isPathWithinRoot("/W/Proj/a", "/w/proj", { caseFold: false })).toBe(false);
  });
  test("treats /private/var/... and /private/tmp as their short spellings, on either side", () => {
    expect(isPathWithinRoot("/private/var/folders/x", "/var/folders")).toBe(true);
    expect(isPathWithinRoot("/tmp/x", "/private/tmp")).toBe(true);
    expect(isPathWithinRoot("/private/etc/x", "/etc")).toBe(false);
  });
  test("`..` must be a whole segment to leave the root", () => {
    expect(isPathWithinRoot("/w/proj/..x", "/w/proj")).toBe(true);
    expect(isPathWithinRoot("/w/proj/../x", "/w/proj")).toBe(false);
  });
});

describe("canonicalizeTrustedSymlinkPath", () => {
  test("rewrites a real system prefix to its short symlink spelling", () => {
    expect(canonicalizeTrustedSymlinkPath("/private/tmp/x")).toBe("/tmp/x");
    expect(canonicalizeTrustedSymlinkPath("/private/tmp")).toBe("/tmp");
    expect(canonicalizeTrustedSymlinkPath("/private/tmpx")).toBe("/private/tmpx");
    expect(canonicalizeTrustedSymlinkPath("/w/x")).toBe("/w/x");
  });
});

describe("resolveTargetPath", () => {
  test("trims both ends before resolving", () => {
    expect(resolveTargetPath("  /r/sp  ", "/w")).toBe("/r/sp");
    expect(resolveTargetPath(" a/b/ ", "/w")).toBe("/w/a/b");
  });
});

describe("isSuspiciousPath", () => {
  test("a path component ending in dots or whitespace", () => {
    expect(isSuspiciousPath("/w/.bashrc.")).toBe(true);
    expect(isSuspiciousPath("/w/.bashrc ")).toBe(true);
    expect(isSuspiciousPath("/w/x \t/y")).toBe(true);
    expect(isSuspiciousPath("/w/./x/../y")).toBe(false);
  });
  test("a reserved device name used as the final extension, in any case -- but not a bare device name", () => {
    expect(isSuspiciousPath("/w/notes.CON")).toBe(true);
    expect(isSuspiciousPath("/w/x.com1")).toBe(true);
    expect(isSuspiciousPath("/w/x.COM0")).toBe(false);
    expect(isSuspiciousPath("/w/CON")).toBe(false);
  });
  test("three or more dots as a whole component, either separator", () => {
    expect(isSuspiciousPath("/w/.../x")).toBe(true);
    expect(isSuspiciousPath("a\\....")).toBe(true);
    expect(isSuspiciousPath("/w/...x/y")).toBe(false);
  });
  test("a short-filename tilde followed by a digit, anywhere", () => {
    expect(isSuspiciousPath("/w/PROGRA~1/x")).toBe(true);
    expect(isSuspiciousPath("/w/a~0")).toBe(true);
    expect(isSuspiciousPath("/w/~x")).toBe(false);
  });
  test("device-namespace and long-path prefixes, with either separator", () => {
    for (const p of ["\\\\?\\C:\\x", "\\\\.\\x", "//?/x", "//./x", "/??/x", "\\??/x", "/??\\x", "\\??\\x"]) expect(isSuspiciousPath(p)).toBe(true);
    expect(isSuspiciousPath("/?/x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Filesystem: symlink chains and the plugin-root fence
// ---------------------------------------------------------------------------------------------

describe("symlink chains and the plugin-root fence", () => {
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "rule-edge-")));
    mkdirSync(join(root, "plugin/agents"), { recursive: true });
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside/x"), "x");
    symlinkSync("missing/leaf", join(root, "dangling"));
    symlinkSync("loop-b", join(root, "loop-a"));
    symlinkSync("loop-a", join(root, "loop-b"));
    symlinkSync("../outside", join(root, "plugin/link-out"));
    for (let i = 0; i < 39; i++) symlinkSync(i === 38 ? "end" : `chainA${i + 1}`, join(root, `chainA${i}`));
    for (let i = 0; i < 40; i++) symlinkSync(i === 39 ? "end" : `chainB${i + 1}`, join(root, `chainB${i}`));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("a dangling symlink resolves to its stored target, even with a path below it", () => {
    expect(resolveSymlinkTargetChain(join(root, "dangling"))).toBe(join(root, "missing/leaf"));
    expect(resolveSymlinkTargetChain(join(root, "dangling/child"))).toBe(join(root, "missing/leaf/child"));
  });
  test("a symlink loop gives up", () => {
    expect(resolveSymlinkTargetChain(join(root, "loop-a"))).toBeUndefined();
  });
  test("at most 40 resolution steps: a dangling chain of 39 links is followed to its end, one of 40 gives up", () => {
    expect(resolveSymlinkTargetChain(join(root, "chainA0"))).toBe(join(root, "end"));
    expect(resolveSymlinkTargetChain(join(root, "chainB0"))).toBeUndefined();
  });
  test("the plugin-root fence: case-sensitive, refuses any relative path starting `..` or containing a backslash, follows symlinks", () => {
    const plugin = join(root, "plugin");
    expect(resolvesWithinPluginRoot(join(plugin, "agents"), plugin)).toBe(true);
    expect(resolvesWithinPluginRoot(join(plugin, "missing/x"), plugin)).toBe(true);
    expect(resolvesWithinPluginRoot(join(plugin, "..x/agents"), plugin)).toBe(false);
    expect(resolvesWithinPluginRoot(join(plugin, "a\\b"), plugin)).toBe(false);
    expect(resolvesWithinPluginRoot(join(plugin, "link-out/x"), plugin)).toBe(false);
    expect(resolvesWithinPluginRoot(join(root, "PLUGIN-NOT-THERE/agents"), plugin)).toBe(false);
  });
});

describe("escapeRegExpLiteral", () => {
  test("escapes every regular-expression metacharacter and nothing else", () => {
    expect(escapeRegExpLiteral(".*+?^${}()|[]\\/-a")).toBe("\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\/-a");
  });
});
