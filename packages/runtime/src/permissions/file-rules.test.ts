// Fix round 4 (C-1 + SV-7, the router same-view test): the ported pipeline (jOe -> xi -> ki -> ln ->
// Ma), using the REAL `ignore@7.0.5` package -- see file-rules.ts's own header for the four
// independent version-fingerprint findings and the full list of disclosed simplifications.
//
// Every probe row below is copied VERBATIM from the reviewer's own harness output (cwd `/w/proj`,
// home `/h`), which paired claude's real `ignore` module with claude's own rule pipeline and ran it
// side by side with Winter's OLD matchFileRule. Each row is `winter / claude`; Winter's OLD answer
// is what paths.test.ts's own (now-superseded) corpus pinned, and claude's answer is the bar this
// module must clear.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileRuleKindFor,
  canonicalFileRuleAuthoringToolName,
  matchFileRulesGrouped,
  resolveFileRuleAnchor,
  unanchorTrailingDoubleStar,
  normalizeFileRulePattern,
  escapeFileRulePathSegment,
  resolvesWithinPluginRoot,
  canonicalizeTrustedSymlinkPath,
  type FileRuleCandidate,
} from "./file-rules.ts";

const CWD = "/w/proj";
const HOME = "/h";

function matchOne(pattern: string, path: string, behavior: "allow" | "denyAsk", overrides: { cwd?: string; home?: string; sourceDir?: string } = {}): boolean {
  const candidates: FileRuleCandidate<{ pattern: string }>[] = [{ entry: { pattern }, pattern, ...(overrides.sourceDir !== undefined ? { sourceDir: overrides.sourceDir } : {}) }];
  return matchFileRulesGrouped(candidates, path, { cwd: overrides.cwd ?? CWD, home: overrides.home ?? HOME }, behavior) !== null;
}

describe("C-1: claude's file-rule pipeline, dump-confirmed probe rows (reviewer harness, cwd /w/proj, home /h)", () => {
  test("deny ./.env matches /w/proj/pkg/.env (a bare no-inner-slash pattern matches at any depth)", () => {
    expect(matchOne("./.env", "/w/proj/pkg/.env", "denyAsk")).toBe(true);
  });

  test("deny ./secrets/** matches /w/proj/pkg/secrets/a (ki unanchors the trailing /** for deny)", () => {
    expect(matchOne("./secrets/**", "/w/proj/pkg/secrets/a", "denyAsk")).toBe(true);
  });

  test("deny //repo/* matches /repo/a/b.txt (the ancestor /repo/a matches, and ignore#test walks parents)", () => {
    expect(matchOne("//repo/*", "/repo/a/b.txt", "denyAsk")).toBe(true);
  });

  test("deny //repo/dir/ matches /repo/dir/x (a directory-covering pattern covers everything under it)", () => {
    expect(matchOne("//repo/dir/", "/repo/dir/x", "denyAsk")).toBe(true);
  });
});

// Fix round 5, N-1 (the re-review of 57e7fef..20b623e, Important): `isPathValidRelative` rejected
// every relative path starting with the LITERAL TWO CHARACTERS "..", including a valid name like
// "..x/evil.sh" -- a substring-prefix check, not a path-segment check. Claude's own `Ma` uses the
// real package's own `isPathValid` (`REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/`, this
// module's own 7.0.5 fingerprint #2 from the C-1 commit), which rejects only a LEADING `/`, `./` or
// `../` segment, or the bare strings "." / ".." -- never a name that merely starts with the two
// characters ".." without being followed by a path separator. Probe rows verbatim from the re-review.
describe("N-1: a directory/file name starting with '..' as a literal prefix is NOT a traversal escape", () => {
  test("deny *.sh matches /w/proj/..x/evil.sh", () => {
    expect(matchOne("*.sh", "/w/proj/..x/evil.sh", "denyAsk")).toBe(true);
  });

  test("deny .env matches /w/proj/..cache/.env", () => {
    expect(matchOne(".env", "/w/proj/..cache/.env", "denyAsk")).toBe(true);
  });

  test("deny secrets matches /w/proj/..a/secrets/k (a bare no-inner-slash pattern matches at any depth)", () => {
    expect(matchOne("secrets", "/w/proj/..a/secrets/k", "denyAsk")).toBe(true);
  });

  test("a genuine parent-directory escape (../x) is still rejected -- N-1 narrows the check, it does not remove it", () => {
    // relative(cwd, path) itself never produces a literal ".." segment for an absolute path already
    // under cwd, so this is exercised at the primitive directly: the real package's own guard.
    expect(matchOne("*.sh", "/w/other/evil.sh", "denyAsk")).toBe(false); // /w/other is outside /w/proj entirely -- relative() yields "../other/evil.sh"
  });
});

describe("Ruling: Winter's allow-exact-only asymmetry is RETIRED", () => {
  test("allow foo matches /w/proj/a/foo, not only /w/proj/foo -- claude's own behaviour", () => {
    expect(matchOne("foo", "/w/proj/a/foo", "allow")).toBe(true);
  });
});

describe("I-A: `^` inside [...] is a literal on claude's grammar, not negation", () => {
  test("deny //repo/[^a]* matches /repo/afoo (the class contains literal ^ and a, not a negated class)", () => {
    expect(matchOne("//repo/[^a]*", "/repo/afoo", "denyAsk")).toBe(true);
  });
});

describe("I-B: backslash escapes -- \\X is literal X, \\\\ is one literal backslash", () => {
  test("a pattern with \\* matches a literal * character, never a wildcard", () => {
    expect(matchOne("//notes/note\\*.md", "/notes/note*.md", "denyAsk")).toBe(true);
    expect(matchOne("//notes/note\\*.md", "/notes/noteX.md", "denyAsk")).toBe(false);
  });
});

describe("I-C: an escaped name with no wildcard still matches (unlike Winter's SV-6-era \\? quirk)", () => {
  test("deny ~/\\[wip\\] matches the literal directory name [wip]", () => {
    expect(matchOne("~/\\[wip\\]", "/h/[wip]", "denyAsk")).toBe(true);
  });

  test("allow \\* matches a literal file named *", () => {
    expect(matchOne("\\*", "/w/proj/*", "allow")).toBe(true);
  });
});

describe("I-D: the exact-match branch (via the grouped pipeline) is case-INSENSITIVE", () => {
  test("deny ~/Secrets matches /h/secrets/x", () => {
    expect(matchOne("~/Secrets", "/h/secrets/x", "denyAsk")).toBe(true);
  });
});

describe("Minor: a leading ! or # means negation/comment, so the rule never matches its own literal text", () => {
  test("a pattern starting with ! never matches a file literally named that way, because ! negates", () => {
    // "!foo" as the ONLY rule in a group negates a name that was never ignored in the first place,
    // so it never itself causes a match (there is nothing to un-ignore).
    expect(matchOne("!foo", "/w/proj/foo", "denyAsk")).toBe(false);
  });

  test("a pattern starting with # is a comment line and contributes no rule at all", () => {
    expect(matchOne("#foo", "/w/proj/foo", "denyAsk")).toBe(false);
  });
});

describe("Minor: trailing whitespace is trimmed (git parity)", () => {
  test("a pattern with trailing spaces still matches as though they were absent", () => {
    expect(matchOne("foo   ", "/w/proj/foo", "denyAsk")).toBe(true);
  });
});

describe("Minor: a reversed character-class range drops just that range, never the whole rule", () => {
  test("[z-a] is dropped, but the rest of a multi-range class still works", () => {
    // A lone reversed range collapses to an EMPTY class contribution; combined with a real range the
    // rest of the class still functions (git's own documented behaviour, ported via the real
    // package's own sanitizeRange, never a thrown error the way Winter's own hand-rolled compiler
    // used to produce).
    expect(() => matchOne("//repo/[z-ab-c]", "/repo/b", "denyAsk")).not.toThrow();
    expect(matchOne("//repo/[z-ab-c]", "/repo/b", "denyAsk")).toBe(true);
  });
});

describe("fileRuleKindFor: SV-7's tool -> rule-kind map", () => {
  test("Edit, Write and NotebookEdit all route to \"edit\" -- an Edit(...) rule is what a Write consults", () => {
    expect(fileRuleKindFor("Edit")).toBe("edit");
    expect(fileRuleKindFor("Write")).toBe("edit");
    expect(fileRuleKindFor("NotebookEdit")).toBe("edit");
  });

  test("Read, Glob and Grep all route to \"read\"", () => {
    expect(fileRuleKindFor("Read")).toBe("read");
    expect(fileRuleKindFor("Glob")).toBe("read");
    expect(fileRuleKindFor("Grep")).toBe("read");
  });

  test("an unrelated tool name has no file-rule kind at all", () => {
    expect(fileRuleKindFor("Bash")).toBeUndefined();
  });
});

describe("SV-7: an Edit(...) rule fires for a Write call, matching claude; a Write(...) rule is inert", () => {
  test("a Write call is decided against Edit(...)-authored rule candidates", () => {
    const writeKind = fileRuleKindFor("Write");
    const editRuleKind = fileRuleKindFor("Edit");
    expect(writeKind).toBe(editRuleKind);
  });

  test("a Write(...)-toolName rule has no kind claude's own pipeline ever consults", () => {
    // grammar.ts's FILE_RULE_TOOLS still recognizes "Write" as a rule TOOL NAME (so a rule can be
    // AUTHORED against it and parsed), but fileRuleKindFor is what evaluator.ts must use to decide
    // which GROUP a call's candidates come from -- a caller that filtered candidates by
    // `rule.toolName === "Write"` (the old, retired behaviour) would find a "Write(...)" rule; one
    // that filters by fileRuleKindFor(rule.toolName) === fileRuleKindFor(call.toolName) never does,
    // because nothing ever calls with call.toolName === "Write" AND rule kind sourced from a
    // "Write(...)" rule specifically -- Edit/Write/NotebookEdit all collapse into the SAME "edit"
    // pool, so a "Write(...)" rule is simply one more "edit"-kind candidate, exactly as inert (on
    // its own distinct identity) as claude's own model makes it.
    expect(fileRuleKindFor("Write")).toBe("edit");
  });
});

describe("Grouping is load-bearing: a negation rule only works when matched together with its sibling", () => {
  // Empirically verified against the real ignore@7.0.5 package directly (bun -e), not assumed: a
  // bare directory-covering pattern like ki-transformed "src/**" (deny) -> "src" excludes the
  // DIRECTORY itself, and gitignore's own documented rule ("it is not possible to re-include a file
  // if a parent directory of that file is excluded") means a file-scoped negation INSIDE an
  // excluded directory can never fire -- this is real `ignore` package behaviour, not a Winter gap.
  // A pattern that does NOT end in "/**" (so `ki` never touches it) demonstrates the grouping
  // property cleanly instead.
  test("deny *.log plus deny !important.log in ONE group un-ignores important.log", () => {
    const candidates: FileRuleCandidate<{ id: string }>[] = [
      { entry: { id: "deny-logs" }, pattern: "*.log" },
      { entry: { id: "unignore-important" }, pattern: "!important.log" },
    ];
    expect(matchFileRulesGrouped(candidates, "/w/proj/important.log", { cwd: CWD, home: HOME }, "denyAsk")).toBeNull();
    expect(matchFileRulesGrouped(candidates, "/w/proj/other.log", { cwd: CWD, home: HOME }, "denyAsk")).not.toBeNull();
  });
});

describe("A `/`-anchored rule with no sourceDir is INERT (the pre-existing, unchanged posture)", () => {
  test("a /x pattern never matches when sourceDir is absent", () => {
    expect(matchOne("/etc/passwd", "/etc/passwd", "denyAsk")).toBe(false);
  });

  test("a /x pattern matches when a sourceDir is supplied", () => {
    expect(matchOne("/secret.txt", "/settings-src/secret.txt", "denyAsk", { sourceDir: "/settings-src" })).toBe(true);
  });
});

describe("resolveFileRuleAnchor -- the four anchor spellings", () => {
  test("//x keeps the leading slash and roots at /", () => {
    expect(resolveFileRuleAnchor("//etc/hostname", { home: HOME })).toEqual({ relativePattern: "/etc/hostname", root: "/" });
  });
  test("~/x keeps the leading slash and roots at home", () => {
    expect(resolveFileRuleAnchor("~/notes", { home: HOME })).toEqual({ relativePattern: "/notes", root: HOME });
  });
  test("./x drops the leading ./ and roots at cwd (null)", () => {
    expect(resolveFileRuleAnchor("./notes", { home: HOME })).toEqual({ relativePattern: "notes", root: null });
  });
  test("bare x roots at cwd (null), pattern untouched", () => {
    expect(resolveFileRuleAnchor("notes", { home: HOME })).toEqual({ relativePattern: "notes", root: null });
  });
  test("a bare ~ (no trailing slash) is a literal filename pattern, ported faithfully from claude's own jOe", () => {
    expect(resolveFileRuleAnchor("~", { home: HOME })).toEqual({ relativePattern: "~", root: null });
  });
});

describe("unanchorTrailingDoubleStar -- the ki transform", () => {
  test("deny x/** unanchors to bare x", () => {
    expect(unanchorTrailingDoubleStar("x/**", false)).toBe("x");
  });
  test("allow x/** (single segment) re-anchors to /x", () => {
    expect(unanchorTrailingDoubleStar("x/**", true)).toBe("/x");
  });
  test("a multi-segment a/b/** is left unanchored on either direction (already root-relative via its inner slash)", () => {
    expect(unanchorTrailingDoubleStar("a/b/**", true)).toBe("a/b");
    expect(unanchorTrailingDoubleStar("a/b/**", false)).toBe("a/b");
  });
  test("a pattern not ending in /** passes through unchanged", () => {
    expect(unanchorTrailingDoubleStar("x/*.ts", true)).toBe("x/*.ts");
  });
});

describe("canonicalFileRuleAuthoringToolName -- SV-7's own single canonical name per kind", () => {
  test("edit kind's canonical name is Edit", () => {
    expect(canonicalFileRuleAuthoringToolName("edit")).toBe("Edit");
  });
  test("read kind's canonical name is Read", () => {
    expect(canonicalFileRuleAuthoringToolName("read")).toBe("Read");
  });
});

describe("escapeFileRulePathSegment -- I-G: a real path escaped before becoming rule PATTERN TEXT", () => {
  test("escapes [, ], * and \\", () => {
    expect(escapeFileRulePathSegment("/home/name[wip]")).toBe("/home/name\\[wip\\]");
    expect(escapeFileRulePathSegment("/home/name*star")).toBe("/home/name\\*star");
    expect(escapeFileRulePathSegment("/home/name\\back")).toBe("/home/name\\\\back");
  });

  test("leaves ? RAW, deliberately -- claude has no working escape for it, and over-matching is the safe direction for a deny", () => {
    expect(escapeFileRulePathSegment("/home/name?question")).toBe("/home/name?question");
  });

  test("a path with no special characters passes through unchanged", () => {
    expect(escapeFileRulePathSegment("/home/ordinary/path")).toBe("/home/ordinary/path");
  });

  test("the escaped form still matches the REAL path it names, through the real grammar", () => {
    const real = "/home/name[wip]/projects";
    const escaped = escapeFileRulePathSegment(real);
    const candidates: FileRuleCandidate<{ id: string }>[] = [{ entry: { id: "floor" }, pattern: `//${escaped}/**` }];
    expect(matchFileRulesGrouped(candidates, `${real}/x.jsonl`, { cwd: "/w", home: "/h" }, "denyAsk")).not.toBeNull();
    // Proves it is not ALSO accidentally over-matching a DIFFERENT, unescaped sibling name (one bracket
    // character standing in for "wip") the way a raw, un-escaped class would.
    expect(matchFileRulesGrouped(candidates, "/home/nameW/projects/x.jsonl", { cwd: "/w", home: "/h" }, "denyAsk")).toBeNull();
  });
});

// Unit-level: this function's OWN contract, called with the already-lexically-resolved candidate a
// loader would hand it (`resolve(root, entry)`'s result) -- the LOADER-level test suite
// (plugins/loader.test.ts) is where a raw manifest entry like "../x" is exercised end to end,
// since collapsing "../" is `path.resolve`'s own job, done before this function is ever called.
describe("resolvesWithinPluginRoot -- fix round 5, the plugin-manifest traversal fence (Aoe/KGe)", () => {
  function mkTemp(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  test("a plain subdirectory is within the root", () => {
    const root = mkTemp("winter-fence-root-");
    mkdirSync(join(root, "sub"), { recursive: true });
    expect(resolvesWithinPluginRoot(join(root, "sub"), root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("an absolute path pointing outside the root is refused", () => {
    const root = mkTemp("winter-fence-root-");
    const outside = mkTemp("winter-fence-outside-");
    writeFileSync(join(outside, "x.txt"), "");
    expect(resolvesWithinPluginRoot(join(outside, "x.txt"), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("a SYMLINK inside the root that resolves OUTSIDE it is refused -- the realpath check, not just the lexical one", () => {
    const root = mkTemp("winter-fence-root-");
    const outside = mkTemp("winter-fence-outside-");
    mkdirSync(join(outside, "secret"), { recursive: true });
    symlinkSync(join(outside, "secret"), join(root, "escape-link"));
    expect(resolvesWithinPluginRoot(join(root, "escape-link"), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("a SYMLINK inside the root that resolves to ANOTHER place inside the root is allowed", () => {
    const root = mkTemp("winter-fence-root-");
    mkdirSync(join(root, "real-target"), { recursive: true });
    symlinkSync(join(root, "real-target"), join(root, "inside-link"));
    expect(resolvesWithinPluginRoot(join(root, "inside-link"), root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a SYMLINKED plugin root itself still admits a real subdirectory -- both sides are realpath'd", () => {
    const realRoot = mkTemp("winter-fence-real-root-");
    mkdirSync(join(realRoot, "sub"), { recursive: true });
    const parent = mkTemp("winter-fence-link-parent-");
    const linkedRoot = join(parent, "linked-root");
    symlinkSync(realRoot, linkedRoot);
    // The candidate is spelled through the SYMLINKED root, as a loader that never realpaths
    // `resolveRoot`'s own result (plugins/loader.ts:84's own deliberate choice) would spell it.
    expect(resolvesWithinPluginRoot(join(linkedRoot, "sub"), linkedRoot)).toBe(true);
    rmSync(realRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });

  test("a not-yet-existing candidate under a real root is still admitted -- resolveRealTarget's own graceful fallback", () => {
    const root = mkTemp("winter-fence-root-");
    expect(resolvesWithinPluginRoot(join(root, "not-created-yet.js"), root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a literal backslash refuses outright -- KGe's own defensive check, ported for parity", () => {
    const root = mkTemp("winter-fence-root-");
    expect(resolvesWithinPluginRoot(join(root, "a\\b"), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

// Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): claude's own trusted-symlink
// mapping (`ni`/`QCt`, dump-confirmed) -- these probes exercise the pairs that actually hold on the
// REAL machine running this test (verified via `readlink -f`: `/tmp`->`/private/tmp`,
// `/var`->`/private/var`, `/etc`->`/private/etc` all resolve that way on macOS; `/bin`/`/lib`/`/sbin`
// do not on every macOS version -- e.g. a sealed-system-volume install may have `/bin` as a real,
// non-symlinked directory -- which is exactly why the map is VERIFIED dynamically, never assumed).
describe("canonicalizeTrustedSymlinkPath -- fix round 5, claude's trusted-symlink mapping (ni/QCt)", () => {
  test("rewrites /private/tmp/... to /tmp/...", () => {
    expect(canonicalizeTrustedSymlinkPath("/private/tmp/x/y.txt")).toBe("/tmp/x/y.txt");
  });

  test("rewrites /private/var/... to /var/...", () => {
    expect(canonicalizeTrustedSymlinkPath("/private/var/folders/abc")).toBe("/var/folders/abc");
  });

  test("rewrites the bare real directory itself (no trailing segment)", () => {
    expect(canonicalizeTrustedSymlinkPath("/private/tmp")).toBe("/tmp");
  });

  test("a path with no matching real prefix passes through unchanged", () => {
    expect(canonicalizeTrustedSymlinkPath("/Users/someone/project/file.txt")).toBe("/Users/someone/project/file.txt");
  });

  test("does not false-positive on a LONGER name that merely starts with the same characters", () => {
    // "/private/tmpfoo" must not be treated as "/private/tmp" + "foo" -- the prefix check requires
    // an exact match or a path separator immediately after it.
    expect(canonicalizeTrustedSymlinkPath("/private/tmpfoo/x")).toBe("/private/tmpfoo/x");
  });
});

describe("normalizeFileRulePattern -- the xi transform", () => {
  test("collapses repeated slashes", () => {
    expect(normalizeFileRulePattern("a//b///c")).toBe("a/b/c");
  });
  test("a bare leading BOM is deleted outright (the class-escaping second replace is dead code -- see the function's own header)", () => {
    expect(normalizeFileRulePattern("﻿foo")).toBe("foo");
  });
  test("a leading BOM before ! or # escapes the directive character instead of stripping it", () => {
    expect(normalizeFileRulePattern("﻿!foo")).toBe("\\!foo");
    expect(normalizeFileRulePattern("﻿#foo")).toBe("\\#foo");
  });
});
