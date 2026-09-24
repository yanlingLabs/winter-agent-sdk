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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileRuleKindFor,
  canonicalFileRuleAuthoringToolName,
  matchFileRulesGrouped,
  resolveFileRuleAnchor,
  resolveFileRuleAbsolutePath,
  resolveFileRuleAbsoluteGlobText,
  isGlobShapedFileRulePattern,
  globToSbplRegexSource,
  recursiveGlobToSbplRegexSource,
  splitDenyPathsByGlobShape,
  ancestorDirectoriesOf,
  globDenyEntriesOf,
  unanchorTrailingDoubleStar,
  normalizeFileRulePattern,
  escapeFileRulePathSegment,
  resolvesWithinPluginRoot,
  canonicalizeTrustedSymlinkPath,
  FileRuleCompileError,
  type FileRuleCandidate,
} from "./file-rules.ts";
import { parseRule } from "./grammar.ts";

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

// Fix round 10, item C: a Read/Edit rule's own pattern, resolved to ONE absolute path for the
// sandbox's own `subpath` rule -- see resolveFileRuleAbsolutePath's own header for the full
// rationale (the glob-shaped-entries posture is dump-confirmed against claude's own `Jm`).
describe("resolveFileRuleAbsolutePath -- fix round 10, item C: a rule pattern resolved to ONE path for the sandbox's own subpath rule", () => {
  const opts = { cwd: CWD, home: HOME };

  test("a //-anchored pattern with a trailing /** strips the double-star -- subpath already means 'and everything under it'", () => {
    expect(resolveFileRuleAbsolutePath("//repo/secrets/**", opts)).toBe("/repo/secrets");
  });

  test("a //-anchored pattern with no trailing /** resolves the same way", () => {
    expect(resolveFileRuleAbsolutePath("//repo/secrets", opts)).toBe("/repo/secrets");
  });

  test("a ~/-anchored pattern resolves under home", () => {
    expect(resolveFileRuleAbsolutePath("~/secrets/**", opts)).toBe(`${HOME}/secrets`);
  });

  test("a bare (unanchored) pattern resolves under cwd", () => {
    expect(resolveFileRuleAbsolutePath("secrets/**", opts)).toBe(`${CWD}/secrets`);
    expect(resolveFileRuleAbsolutePath("secrets", opts)).toBe(`${CWD}/secrets`);
  });

  test("a single-slash-anchored pattern is INERT (no sourceDir given) -- undefined, matching resolveFileRuleAnchor's own pre-existing posture", () => {
    expect(resolveFileRuleAbsolutePath("/repo/secrets", opts)).toBeUndefined();
  });

  test("a genuinely glob-shaped pattern (a mid-path *, ?, or a character class) is undefined -- cannot become one exact path", () => {
    expect(resolveFileRuleAbsolutePath("src/*.ts", opts)).toBeUndefined();
    expect(resolveFileRuleAbsolutePath("a?b", opts)).toBeUndefined();
    expect(resolveFileRuleAbsolutePath("[wip]", opts)).toBeUndefined();
  });

  test("a root-anchored bare double-star (//**) resolves to the filesystem root itself", () => {
    expect(resolveFileRuleAbsolutePath("//**", opts)).toBe("/");
  });
});

// Fix round 11 (claude's Li/Rt, dump byte 15365905/15282610, pinned 2.1.250): the sibling of
// resolveFileRuleAbsolutePath that does NOT drop a glob-shaped pattern -- see that function's own
// header for the full rationale (a glob-shaped DENY becomes an SBPL regex clause instead of being
// silently unenforced by the sandbox layer; ALLOW keeps resolveFileRuleAbsolutePath's own
// drop-glob-shaped posture, unchanged).
describe("resolveFileRuleAbsoluteGlobText -- fix round 11: the DENY-side sibling that keeps glob characters intact", () => {
  const opts = { cwd: CWD, home: HOME };

  test("a genuinely glob-shaped pattern resolves to the absolute text WITH glob characters intact (not undefined, unlike resolveFileRuleAbsolutePath)", () => {
    expect(resolveFileRuleAbsoluteGlobText("src/*.ts", opts)).toBe(`${CWD}/src/*.ts`);
    expect(resolveFileRuleAbsoluteGlobText("//repo/**/.env", opts)).toBe("/repo/**/.env");
  });

  test("a //-anchored pattern with a REDUNDANT trailing /** still strips it, same as resolveFileRuleAbsolutePath -- subpath's own recursive semantics already cover it, so what remains may no longer be glob-shaped at all", () => {
    expect(resolveFileRuleAbsoluteGlobText("//repo/secrets/**", opts)).toBe("/repo/secrets");
  });

  test("a non-glob pattern resolves identically to resolveFileRuleAbsolutePath", () => {
    expect(resolveFileRuleAbsoluteGlobText("~/secrets", opts)).toBe(`${HOME}/secrets`);
  });

  test("a single-slash-anchored pattern is still INERT (no sourceDir given) -- undefined, the one case with no absolute form at all", () => {
    expect(resolveFileRuleAbsoluteGlobText("/repo/secrets/*.ts", opts)).toBeUndefined();
  });
});

describe("isGlobShapedFileRulePattern -- claude's own Rt (dump byte 15282610), confirmed byte-equivalent to this module's own RULE_PATH_GLOB_CHARS", () => {
  test("a plain path is not glob-shaped", () => {
    expect(isGlobShapedFileRulePattern("/repo/secrets")).toBe(false);
  });
  test("*, ?, [, ] each make a path glob-shaped", () => {
    expect(isGlobShapedFileRulePattern("/repo/*.env")).toBe(true);
    expect(isGlobShapedFileRulePattern("/repo/a?b")).toBe(true);
    expect(isGlobShapedFileRulePattern("/repo/[wip]")).toBe(true);
  });
});

// Fix round 11: claude's own Po (dump byte 15287939, pinned 2.1.250, ground-truth byte-slice-
// verified via grep -bo + byte-slice extraction -- the coordinator's own "~272946" does not land
// there, the same pattern as every prior round's citation). Real RegExp behavior asserted, not just
// the source string, so a subtly-wrong conversion cannot hide behind a passing string-equality check.
describe("globToSbplRegexSource / recursiveGlobToSbplRegexSource -- claude's own Po/td", () => {
  test("a single * matches any run of non-separator characters, never crossing a /", () => {
    const re = new RegExp(globToSbplRegexSource("/repo/*.ts"));
    expect(re.test("/repo/foo.ts")).toBe(true);
    expect(re.test("/repo/sub/foo.ts")).toBe(false);
  });

  test("a mid-path ** matches zero or more whole path segments, including none", () => {
    const re = new RegExp(globToSbplRegexSource("/repo/**/.env"));
    expect(re.test("/repo/.env")).toBe(true);
    expect(re.test("/repo/a/b/.env")).toBe(true);
    expect(re.test("/repo/a/b/notenv")).toBe(false);
  });

  test("a trailing ** matches anything under the prefix but NOT the bare prefix itself (subpath's own 'and itself' semantics is what recursiveGlobToSbplRegexSource adds back)", () => {
    const re = new RegExp(globToSbplRegexSource("/repo/sub/**"));
    expect(re.test("/repo/sub/x")).toBe(true);
    expect(re.test("/repo/sub")).toBe(false);
  });

  test("? matches exactly one non-separator character", () => {
    const re = new RegExp(globToSbplRegexSource("/repo/a?c"));
    expect(re.test("/repo/abc")).toBe(true);
    expect(re.test("/repo/ac")).toBe(false);
    expect(re.test("/repo/a/c")).toBe(false);
  });

  test("a literal regex metacharacter in the path (a dot) is escaped, not treated as regex syntax", () => {
    const re = new RegExp(globToSbplRegexSource("/repo/v1.2/*.ts"));
    expect(re.test("/repo/v1.2/x.ts")).toBe(true);
    expect(re.test("/repoXv1X2/x.ts")).toBe(false); // would match if the dots were NOT escaped
  });

  test("a [...] character class is left as real regex syntax, untouched", () => {
    const re = new RegExp(globToSbplRegexSource("/repo/[ab].ts"));
    expect(re.test("/repo/a.ts")).toBe(true);
    expect(re.test("/repo/b.ts")).toBe(true);
    expect(re.test("/repo/c.ts")).toBe(false);
  });

  test("recursiveGlobToSbplRegexSource additionally matches anything nested under the pattern's own match point", () => {
    const re = new RegExp(recursiveGlobToSbplRegexSource("/repo/**/.env"));
    expect(re.test("/repo/.env")).toBe(true);
    expect(re.test("/repo/.env/nested")).toBe(true);
    expect(re.test("/repo/.envfile")).toBe(false); // not a path-separator boundary
  });

  // Fix round 11's own addition, disclosure CORRECTED round 12: the fixed (non-glob) prefix is
  // canonicalized (resolveRealTarget) before conversion, GUARDED by claude's own `ko` (`isSuspicious
  // RealpathResolution`, this module) -- claude's OWN `Cv` does exactly this too (round 11's own
  // disclosure that `Cv` "does not perform real symlink resolution" was wrong, per the controller's
  // own re-review; see `isSuspiciousRealpathResolution`'s own header for the corrected dump citation).
  // The well-known macOS `/tmp` <-> `/private/tmp` alias is `ko`'s own explicitly-safe case -- real,
  // not a synthetic symlink, so this specific test is darwin-only (guarded below); the SIBLING-symlink
  // rejection case right after it uses a synthetic symlink and runs on any host/CI.
  test.skipIf(process.platform !== "darwin")("the fixed prefix IS canonicalized through the well-known macOS /tmp <-> /private/tmp alias (ko's own explicitly-safe case)", () => {
    const dir = mkdtempSync(join("/tmp", "winter-glob-prefix-canon-"));
    try {
      const source = globToSbplRegexSource(join(dir, "*.ts"));
      const privateDir = "/private" + dir;
      expect(new RegExp(source).test(join(privateDir, "x.ts"))).toBe(true);
      expect(source).toContain(privateDir);
      expect(source).not.toContain(`^${dir}/`); // the as-typed /tmp/... form must NOT be what the regex anchors on
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Fix round 12: a symlink pointing OUTSIDE its own subtree (here, a plain SIBLING under the same
  // parent -- neither "no change" nor the tmp/var alias nor a proper descendant of the original) is
  // exactly the shape `ko`/`isSuspiciousRealpathResolution` REJECTS -- the canonicalization is
  // skipped and the AS-TYPED (symlinked) text is what the regex anchors on. This is a real behavior
  // change from round 11's own (unguarded) fixture, which asserted the opposite -- ko's own point is
  // precisely that an ARBITRARY symlink target must not be silently trusted as "the canonical form."
  test("a symlink pointing to a SIBLING path (not a descendant, not the tmp/var alias) is NOT canonicalized -- ko rejects it, the as-typed text is used", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-glob-prefix-canon-")));
    try {
      const real = join(dir, "real");
      const link = join(dir, "link");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      const source = globToSbplRegexSource(join(link, "*.ts"));
      expect(new RegExp(source).test(join(link, "x.ts"))).toBe(true);
      expect(new RegExp(source).test(join(real, "x.ts"))).toBe(false);
      expect(source).toContain(link);
      expect(source).not.toContain(real);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("splitDenyPathsByGlobShape -- fix round 11: the one shared split point tools/impl/{bash,monitor}.ts both call", () => {
  test("a non-glob path stays in `paths`, unconverted", () => {
    expect(splitDenyPathsByGlobShape(["/repo/secrets"])).toEqual({ paths: ["/repo/secrets"], regexes: [], globFixedPrefixes: [] });
  });

  test("a glob-shaped path moves to `regexes`, converted via the RECURSIVE form", () => {
    const result = splitDenyPathsByGlobShape(["/repo/**/.env"]);
    expect(result.paths).toEqual([]);
    expect(result.regexes).toEqual([recursiveGlobToSbplRegexSource("/repo/**/.env")]);
  });

  test("a mix of both is split correctly, preserving each list's own relative order", () => {
    const result = splitDenyPathsByGlobShape(["/a/plain", "/b/*.glob", "/c/also-plain"]);
    expect(result.paths).toEqual(["/a/plain", "/c/also-plain"]);
    expect(result.regexes).toEqual([recursiveGlobToSbplRegexSource("/b/*.glob")]);
  });

  test("an empty list produces three empty lists", () => {
    expect(splitDenyPathsByGlobShape([])).toEqual({ paths: [], regexes: [], globFixedPrefixes: [] });
  });

  // Fix round 12: `globFixedPrefixes` -- feeds the ancestor-rename-bypass port (SeatbeltProfileInput's
  // own denyWrite/denyReadGlobFixedPrefixes, sandbox/profile.ts).
  test("a glob-shaped path also contributes its own fixed-prefix directory to globFixedPrefixes", () => {
    const result = splitDenyPathsByGlobShape(["/repo/sub/*.secret"]);
    expect(result.globFixedPrefixes).toEqual(["/repo/sub"]);
  });

  test("a glob-shaped path whose fixed prefix resolves to the filesystem root contributes NOTHING to globFixedPrefixes -- matching claude's own Ch (`if(p===\"/\")continue`)", () => {
    const result = splitDenyPathsByGlobShape(["/*.secret"]);
    expect(result.globFixedPrefixes).toEqual([]);
  });

  test("a non-glob path contributes nothing to globFixedPrefixes", () => {
    const result = splitDenyPathsByGlobShape(["/repo/secrets"]);
    expect(result.globFixedPrefixes).toEqual([]);
  });
});

// Fix round 12 ("Important" item, claude's own `ed`, dump byte 15367994): every ancestor directory of
// a path, walking up until `/` or a fixed point -- feeds the ancestor-rename-bypass port.
describe("ancestorDirectoriesOf -- claude's own ed", () => {
  test("a nested path yields every ancestor up to but not including the root", () => {
    expect(ancestorDirectoriesOf("/a/b/c/d")).toEqual(["/a/b/c", "/a/b", "/a"]);
  });

  test("a top-level path (one segment under root) yields no ancestors -- its own dirname is /", () => {
    expect(ancestorDirectoriesOf("/a")).toEqual([]);
  });

  test("does not include the path itself", () => {
    expect(ancestorDirectoriesOf("/a/b")).not.toContain("/a/b");
  });

  test("does not include the root itself", () => {
    expect(ancestorDirectoriesOf("/a/b/c")).not.toContain("/");
  });
});

// Fix round 13 ("Important" item 1, claude's own `fR`): the PAIRED form `buildReadDenyKeepInPlaceBlock`
// (sandbox/profile.ts) needs -- see `GlobDenyEntry`'s own header for why `splitDenyPathsByGlobShape`'s
// own two flat arrays cannot answer this.
describe("globDenyEntriesOf -- fix round 13, the paired regex+fixedPrefix form fR needs", () => {
  test("a non-glob path contributes nothing", () => {
    expect(globDenyEntriesOf(["/repo/secrets"])).toEqual([]);
  });

  test("a glob-shaped path is paired: its OWN recursive regex WITH its OWN fixed-prefix directory", () => {
    const result = globDenyEntriesOf(["/repo/sub/*.secret"]);
    expect(result).toEqual([{ regex: recursiveGlobToSbplRegexSource("/repo/sub/*.secret"), fixedPrefix: "/repo/sub" }]);
  });

  test("a glob-shaped path whose fixed prefix resolves to the filesystem root gets the literal string \"/\" -- NEVER dropped, unlike splitDenyPathsByGlobShape's own globFixedPrefixes", () => {
    const result = globDenyEntriesOf(["/*.secret"]);
    expect(result).toEqual([{ regex: recursiveGlobToSbplRegexSource("/*.secret"), fixedPrefix: "/" }]);
  });

  test("a mix of plain and glob-shaped paths only pairs the glob-shaped ones, preserving order", () => {
    const result = globDenyEntriesOf(["/a/plain", "/b/*.glob", "/c/also-plain", "/d/**/.env"]);
    expect(result).toEqual([
      { regex: recursiveGlobToSbplRegexSource("/b/*.glob"), fixedPrefix: "/b" },
      { regex: recursiveGlobToSbplRegexSource("/d/**/.env"), fixedPrefix: "/d" },
    ]);
  });

  test("an empty list produces an empty list", () => {
    expect(globDenyEntriesOf([])).toEqual([]);
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

  // Fix round 9 (a divergence the router measured): the real `ignore` package trims an UNESCAPED
  // trailing whitespace run off a pattern line, exactly like real gitignore -- confirmed empirically
  // (`ignoreFactory().add("repo/sp ").test("repo/sp ")` is `false`; the same call with the trailing
  // space escaped, `"repo/sp\\ "`, is `true`). Claude's own path-to-pattern escaper, `I_t`
  // (dump-confirmed, same region as `c`/`jr`), protects against exactly this:
  //   `t.replace(/\s+$/, (n) => Array.from(n, (s) => `\${s}`).join(""))`
  // -- every character of a trailing whitespace RUN individually escaped. Before this fix,
  // `escapeFileRulePathSegment` escaped none of it, so a Winter-BUILT deny rule for a real path
  // ending in a space (or any trailing whitespace) silently failed to protect that exact file: the
  // compiled pattern named the file WITHOUT its trailing space, so a write to the real,
  // trailing-space-bearing file went through, unsandboxed by that rule. A rule typed directly into
  // settings.json with the space ALREADY escaped by hand was never affected -- round 8's
  // `unescapeRuleContent` doesn't touch `\ ` (it only recognises `\(`, `\)`, `\\`), so it reaches the
  // `ignore` layer unchanged and already matches correctly; this gap was specific to the PATH ->
  // PATTERN direction (`escapeFileRulePathSegment`), not the read-back direction.
  test("escapes a trailing space -- claude's own I_t escapes every character of a trailing whitespace run", () => {
    expect(escapeFileRulePathSegment("/home/sp ")).toBe("/home/sp\\ ");
  });

  test("escapes MULTIPLE trailing whitespace characters individually, each with its own backslash", () => {
    expect(escapeFileRulePathSegment("/home/sp  ")).toBe("/home/sp\\ \\ ");
  });

  test("a trailing tab is escaped too -- I_t's regex is \\s+$, not space-specific", () => {
    expect(escapeFileRulePathSegment("/home/sp\t")).toBe("/home/sp\\\t");
  });

  test("INTERIOR whitespace (not trailing) is left alone -- only a TRAILING run is special, matching gitignore's own line-trimming rule", () => {
    expect(escapeFileRulePathSegment("/home/has space/file")).toBe("/home/has space/file");
  });

  test("end to end: a deny rule built from a real path ending in a space blocks a write to that exact file, through the real ignore pipeline", () => {
    const real = "/repo/sp ";
    const escaped = escapeFileRulePathSegment(real);
    const candidates: FileRuleCandidate<{ id: string }>[] = [{ entry: { id: "floor" }, pattern: `//${escaped}` }];
    expect(matchFileRulesGrouped(candidates, real, { cwd: "/w", home: "/h" }, "denyAsk")).not.toBeNull();
  });

  test("control: a rule authored directly with claude's OWN escaped spelling (\\ before the trailing space) already matched correctly before this fix -- the gap was only in escapeFileRulePathSegment, never in the ignore layer itself", () => {
    const rule = parseRule("Read(//repo/sp\\ )");
    expect(rule.specifier).toEqual({ kind: "pattern", source: "//repo/sp\\ " });
    const specifier = rule.specifier;
    const candidates: FileRuleCandidate<{ id: string }>[] = [{ entry: { id: "floor" }, pattern: specifier?.kind === "pattern" ? specifier.source : "" }];
    expect(matchFileRulesGrouped(candidates, "/repo/sp ", { cwd: "/w", home: "/h" }, "denyAsk")).not.toBeNull();
  });
});

// Unit-level: this function's OWN contract, called with the already-lexically-resolved candidate a
// loader would hand it (`resolve(root, entry)`'s result) -- the LOADER-level test suite
// (plugins/loader.test.ts) is where a raw manifest entry like "../x" is exercised end to end,
// since collapsing "../" is `path.resolve`'s own job, done before this function is ever called.
describe("resolvesWithinPluginRoot -- fix round 5/6, the plugin-manifest traversal fence (KGe realpath step + claude's own nV comparison)", () => {
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

  // Fix round 6, R5-1 (the re-review against the pinned 2.1.250 dump): claude's own nV compares
  // case-SENSITIVELY -- round 5's own delegation to isPathWithinRoot's default caseFold:true was
  // wrong. Neither side needs to exist on disk: resolveRealTarget's own fallback (walk up to the
  // nearest EXISTING ancestor, "/" here, and rejoin the literal, case-PRESERVED tail) means this
  // exercises the comparison directly, without needing a genuinely case-sensitive volume (this dev
  // machine's default APFS format is case-insensitive, so a REAL directory pair differing only by
  // case cannot be constructed via mkdirSync at all: the filesystem would resolve either spelling to
  // the SAME one real directory).
  test("R5-1: a candidate differing from the root only in CASE is refused, not admitted", () => {
    const root = "/winter-round6-r5-1-does-not-exist/plugins/foo";
    const candidate = "/winter-round6-r5-1-does-not-exist/plugins/FOO/agents";
    expect(resolvesWithinPluginRoot(candidate, root)).toBe(false);
  });

  test("R5-1 control: the SAME case still admits normally", () => {
    const root = "/winter-round6-r5-1-does-not-exist/plugins/foo";
    const candidate = "/winter-round6-r5-1-does-not-exist/plugins/foo/agents";
    expect(resolvesWithinPluginRoot(candidate, root)).toBe(true);
  });

  // Fix round 6 (a promoted minor, the re-review against the pinned 2.1.250 dump): claude's own nV
  // uses a NAIVE startsWith("..") check (dump-confirmed, reading nV's full body), not the
  // segment-aware one isPathWithinRoot/sm has -- so a component name that merely STARTS WITH the two
  // characters ".." is refused too, not only a genuine "../" escape. A real behaviour CHANGE from
  // round 5 (which delegated to isPathWithinRoot's segment-aware check and would have admitted this).
  test("minor: a name starting with '..' (e.g. '..x/agents') is REFUSED, matching claude's own nV exactly", () => {
    const root = mkTemp("winter-fence-root-");
    mkdirSync(join(root, "..x", "agents"), { recursive: true });
    expect(resolvesWithinPluginRoot(join(root, "..x", "agents"), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("control: an ordinary subdirectory name not starting with '..' is still admitted", () => {
    const root = mkTemp("winter-fence-root-");
    mkdirSync(join(root, "agents"), { recursive: true });
    expect(resolvesWithinPluginRoot(join(root, "agents"), root)).toBe(true);
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

// Fix round 8 (a rule-content parity item found by the integration run on both real binaries): end
// to end through the REAL pipeline -- a rule STRING (grammar.ts's parseRule) feeding the real
// `ignore`-package matcher this module builds (see grammar.ts's own header for the ported
// Tool(content) grammar, jr/l/u/a, this composes with).
function matchAuthoredRule(ruleString: string, path: string, behavior: "allow" | "denyAsk", overrides: { cwd?: string; home?: string } = {}): boolean {
  const rule = parseRule(ruleString);
  if (rule.specifier?.kind !== "pattern") throw new Error(`expected a pattern specifier, got ${JSON.stringify(rule.specifier)}`);
  return matchOne(rule.specifier.source, path, behavior, overrides);
}

describe("end to end -- fix round 8: a rule string parses through grammar.ts and matches through the real ignore pipeline exactly as claude's own would", () => {
  test("an UNESCAPED literal paren pair (a real directory named 'Project (old)') matches -- unchanged from before this fix", () => {
    expect(matchAuthoredRule("Read(//repo/Project (old)/**)", "/repo/Project (old)/secret.txt", "denyAsk")).toBe(true);
  });

  test("the SAME rule authored with claude's OWN escaped spelling (\\( and \\)) matches the identical real path", () => {
    expect(matchAuthoredRule("Read(//repo/Project \\(old\\)/**)", "/repo/Project (old)/secret.txt", "denyAsk")).toBe(true);
  });

  test("the escaped-paren rule does NOT match a different, merely similarly-shaped directory", () => {
    expect(matchAuthoredRule("Read(//repo/Project \\(old\\)/**)", "/repo/Project (new)/secret.txt", "denyAsk")).toBe(false);
  });

  test("a literal backslash in the real path matches ONLY claude's own two-layer escape spelling, not the pre-fix single layer", () => {
    // Two INDEPENDENT escape layers stack for a literal backslash: (1) this round's OWN fix --
    // grammar.ts's Tool(content) unescape (`a`) halves an authored run of backslashes ONCE before
    // any specifier-family parsing ever sees it; (2) the real `ignore` package's OWN, separate,
    // already-verified (round 4, 1476 cases, 0 diffs) escape grammar, which ALSO requires a doubled
    // backslash in the PATTERN TEXT it receives to match one literal backslash in a real path.
    // A real path with ONE literal backslash therefore needs FOUR backslash characters in the
    // AUTHORED rule string -- exactly the "double escape" the controller's own finding named,
    // composed from the two layers, not from either alone. Verified directly against the real
    // `ignore` package before writing this fixture (not asserted from documentation alone).
    const path = "/repo/C:\\secrets/key.txt"; // one real backslash
    expect(matchAuthoredRule("Read(//repo/C:\\\\\\\\secrets/**)", path, "denyAsk")).toBe(true); // 4 authored backslashes
    expect(matchAuthoredRule("Read(//repo/C:\\\\secrets/**)", path, "denyAsk")).toBe(false); // 2 authored (the pre-fix single-layer spelling) -- does NOT match
  });
});

// Fix round 9, item 2 (an uncompilable rule), REVISED by round 10's own item-3 ruling: a malformed
// pattern -- one whose escapes/brackets the real `ignore` package's OWN regex construction cannot
// compile, e.g. an unterminated `[...]` character class FOLLOWED by another path segment
// (`foo[bar/baz` -- confirmed empirically: a single-segment `foo[bar` alone does NOT throw, but the
// package's own multi-segment matching path does, at TEST time, not ADD time) -- must never crash
// the WHOLE RUN.
//
// Round 9 tried to resolve the failure inside `matchFileRulesGrouped` itself, direction-aware
// (denyAsk -> the broken group's own entry, allow -> null). Round 10's controller ruling is that
// this is not what claude does: claude's own `Ma` has no per-group catch at all -- only the
// per-TOOL-CALL one far above it, `d8t`'s hardcoded fallback (reached when a tool declares no
// custom `permissionCheckFailureDecision`; Read/Edit do not) -- `{behavior:"deny", message:"The
// <name> permission check failed and its fail-closed posture could not be determined. The call is
// denied.", decisionReason:{type:"other", reason:"permission check crashed; tool declares a
// fail-closed posture"}}`. So `matchFileRulesGrouped` now THROWS a typed `FileRuleCompileError`
// instead of resolving anything itself -- deny/ask/allow all abort the SAME way, exactly like
// claude's own `Ma`. `evaluator.test.ts` is where the one catch site (`evaluate()`) and its
// fail-closed-deny outcome are pinned; THIS file only proves the throw itself, scoped per ANCHOR
// ROOT group's own `.test()` call, matching claude's own `ln`/`Ma` structure: ONE `ignore()`
// instance is memoized per anchor root, built from every candidate that shares it. A query whose
// path falls OUTSIDE a broken root entirely (filtered by `isPathValidRelative` before `.test()` is
// ever reached) never triggers the throw at all -- but a "//"-anchored broken rule's own root is
// "/", which every absolute path is trivially "under", so its blast radius is every query, not a
// narrow one; a `~/`- or cwd-rooted broken rule's blast radius is only queries under THAT root.
describe("matchFileRulesGrouped -- fix round 10, item 3: an uncompilable rule THROWS (a typed FileRuleCompileError), for evaluate() to catch once", () => {
  test("a malformed pattern throws a FileRuleCompileError, on denyAsk", () => {
    const candidates: FileRuleCandidate<{ id: string }>[] = [{ entry: { id: "bad" }, pattern: "//repo/foo[bar/baz" }];
    expect(() => matchFileRulesGrouped(candidates, "/repo/foo[bar/baz/x", { cwd: CWD, home: HOME }, "denyAsk")).toThrow(FileRuleCompileError);
  });

  test("a malformed pattern ALSO throws on the allow direction -- claude's own Ma has no direction-aware recovery either", () => {
    const candidates: FileRuleCandidate<{ id: string }>[] = [{ entry: { id: "bad" }, pattern: "//repo/foo[bar/baz" }];
    expect(() => matchFileRulesGrouped(candidates, "/repo/foo[bar/baz/x", { cwd: CWD, home: HOME }, "allow")).toThrow(FileRuleCompileError);
  });

  test("a broken rule under one anchor root does not disturb a WORKING rule under a genuinely different root -- the query under the working root neither throws nor matches spuriously", () => {
    // "~/..." anchors to opts.home; a BARE (unanchored) pattern's root is opts.cwd -- HOME and CWD
    // are unrelated absolute paths here (see CWD/HOME above), so a query path under one is never
    // `isPathValidRelative` for the other's root -- unlike a "//"-anchored pattern (root "/"), which
    // every absolute path is trivially "under". This is the correctly-isolating pair.
    const candidates: FileRuleCandidate<{ id: string }>[] = [
      { entry: { id: "bad" }, pattern: "~/broken[bracket/baz" },
      { entry: { id: "good" }, pattern: "secret/**" },
    ];
    // A query under the broken root (HOME) throws for its own path...
    expect(() => matchFileRulesGrouped(candidates, `${HOME}/broken[bracket/baz/x`, { cwd: CWD, home: HOME }, "denyAsk")).toThrow(FileRuleCompileError);
    // ...while a query under the unrelated, well-formed root (CWD) matches normally, no throw at
    // all: HOME's own group is filtered out by `isPathValidRelative` before its broken `.test()` is
    // ever reached, so it never gets a chance to affect this completely separate root's own group.
    expect(matchFileRulesGrouped(candidates, `${CWD}/secret/key`, { cwd: CWD, home: HOME }, "denyAsk")).toEqual({ id: "good" });
  });

  test("a '//'-anchored broken rule's blast radius is every path (root '/' contains every absolute path) -- disclosed, not a bug: claude's own one-ignore()-per-root architecture has the identical property, since a throw during that root's own combined regex compilation aborts the WHOLE check for any query that root's group is even consulted for", () => {
    const candidates: FileRuleCandidate<{ id: string }>[] = [{ entry: { id: "bad" }, pattern: "//repo/foo[bar/baz" }];
    expect(() => matchFileRulesGrouped(candidates, `${CWD}/completely/unrelated/path`, { cwd: CWD, home: HOME }, "denyAsk")).toThrow(FileRuleCompileError);
  });
});
