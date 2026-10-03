// Exact-text edge cases for four parts of the rendered Seatbelt profile:
//   - the ancestor-rename fence (`(deny file-write-unlink file-write-create ...)`),
//   - the write-root create/unlink re-permit (`(allow file-write-unlink file-write-create ...)`),
//   - the default write protections (shell/git/editor config entries anchored at cwd),
//   - the keep-in-place block for read-denied paths inside write roots (`(deny file-write-unlink ...)`).
//
// Every path lives under `/cr`, which does not exist, so canonicalisation walks up to `/` and leaves
// the text unchanged apart from normalisation (`//`, `.`, `..` and a trailing `/` collapse). Each
// assertion compares a whole block, not a substring, because clause ORDER and DE-DUPLICATION are part
// of the output.
import { describe, expect, test } from "bun:test";
import { buildSeatbeltProfile, type SeatbeltProfileInput } from "./profile.ts";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { recursiveGlobToSbplRegexSource } from "../permissions/file-rules.ts";

const OPS = "file-write* file-write-unlink file-write-create";
const FENCE = "(deny file-write-unlink file-write-create";
const REPERMIT = "(allow file-write-unlink file-write-create";
const KEEP = "(deny file-write-unlink";

function profile(input: Partial<SeatbeltProfileInput> & { cwd: string }): string {
  return buildSeatbeltProfile({ allowNetwork: false, ...input });
}

/** Every block whose first line is exactly `header`, with its two-space-indented continuation lines. */
function blocks(p: string, header: string): string[] {
  const lines = p.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== header) continue;
    const body: string[] = [header];
    for (let j = i + 1; j < lines.length && lines[j]!.startsWith("  "); j++) body.push(lines[j]!);
    out.push(body.join("\n"));
  }
  return out;
}

const block = (header: string, clauses: string[]): string => [header, ...clauses.map((c) => `  ${c}`)].join("\n") + ")";

/** The lines strictly between the first line equal to `from` and the next line equal to `to`. */
function between(p: string, from: string, to: string): string[] {
  const lines = p.split("\n");
  const start = lines.indexOf(from);
  const end = lines.indexOf(to, start + 1);
  return lines.slice(start + 1, end);
}

const DEFAULT_FENCE_CW_CLAUSES = [
  '(subpath "/cr/w/.gitconfig")',
  '(literal "/cr/w")',
  '(literal "/cr")',
  '(subpath "/cr/w/.gitmodules")',
  '(subpath "/cr/w/.bashrc")',
  '(subpath "/cr/w/.bash_profile")',
  '(subpath "/cr/w/.zshrc")',
  '(subpath "/cr/w/.zprofile")',
  '(subpath "/cr/w/.profile")',
  '(subpath "/cr/w/.ripgreprc")',
  '(subpath "/cr/w/.mcp.json")',
  '(subpath "/cr/w/.winter/mcp.json")',
  '(literal "/cr/w/.winter")',
  '(subpath "/cr/w/.vscode")',
  '(subpath "/cr/w/.idea")',
  '(subpath "/cr/w/.claude/commands")',
  '(literal "/cr/w/.claude")',
  '(subpath "/cr/w/.claude/agents")',
  '(subpath "/cr/w/.winter/commands")',
  '(subpath "/cr/w/.winter/agents")',
  '(subpath "/cr/w/.winter/skills")',
  '(subpath "/cr/w/.winter/rules")',
  '(subpath "/cr/w/.winter/output-styles")',
  '(subpath "/cr/w/.git/hooks")',
  '(literal "/cr/w/.git")',
  '(subpath "/cr/w/.git/config")',
];
const DEFAULT_FENCE_CW = block(FENCE, DEFAULT_FENCE_CW_CLAUSES);

describe("ancestor-rename fence", () => {
  test("plain paths are canonicalised; glob prefixes are used as given; clauses keep first-occurrence order and are de-duplicated", () => {
    const p = profile({
      cwd: "/cr/w",
      denyWritePaths: ["/cr/a/b/", "/cr/a//c", "/cr/x/../a/d"],
      denyWriteGlobFixedPrefixes: ["/cr/a//g", "/", "/cr/a/b"],
    });
    // The user-configured fence comes first; the default protections' own fence second.
    expect(blocks(p, FENCE)).toEqual([
      block(FENCE, [
        '(subpath "/cr/a/b")',
        '(literal "/cr/a")',
        '(literal "/cr")',
        '(subpath "/cr/a/c")',
        '(subpath "/cr/a/d")',
        '(literal "/cr/a//g")',
        '(literal "/cr/a/")',
        '(literal "/")',
        '(literal "/cr/a/b")',
      ]),
      DEFAULT_FENCE_CW,
    ]);
  });

  test("a denied path that is an ancestor of another keeps both its subpath clause and a separate literal clause", () => {
    const p = profile({ cwd: "/cr/w", denyWritePaths: ["/cr/a", "/cr/a/b"] });
    expect(blocks(p, FENCE)[0]).toBe(block(FENCE, ['(subpath "/cr/a")', '(literal "/cr")', '(subpath "/cr/a/b")', '(literal "/cr/a")']));
  });

  test("quotes and backslashes are escaped in both clause kinds", () => {
    const p = profile({ cwd: "/cr/w", denyWritePaths: ['/cr/q"t/f', "/cr/b\\s/f"] });
    expect(blocks(p, FENCE)[0]).toBe(
      block(FENCE, ['(subpath "/cr/q\\"t/f")', '(literal "/cr/q\\"t")', '(literal "/cr")', '(subpath "/cr/b\\\\s/f")', '(literal "/cr/b\\\\s")']),
    );
  });

  test("the read side gets its own fence, between the read-deny lines and the re-permit", () => {
    const p = profile({ cwd: "/cr/w", denyReadPaths: ["/cr/r/s"], denyReadGlobFixedPrefixes: ["/cr/g/h"] });
    expect(between(p, "(allow file-read*)", REPERMIT)).toEqual([
      '(deny file-read* (subpath "/cr/r/s"))',
      "",
      FENCE,
      '  (subpath "/cr/r/s")',
      '  (literal "/cr/r")',
      '  (literal "/cr")',
      '  (literal "/cr/g/h")',
      '  (literal "/cr/g"))',
    ]);
    // Only one other fence: the default protections'. Nothing from the read side leaks into it.
    expect(blocks(p, FENCE)).toHaveLength(2);
    expect(blocks(p, FENCE)[1]).toBe(DEFAULT_FENCE_CW);
  });

  test("a glob prefix alone (no plain path) still produces a fence", () => {
    const p = profile({ cwd: "/cr/w", denyWriteGlobFixedPrefixes: ["/cr/a"] });
    expect(blocks(p, FENCE)[0]).toBe(block(FENCE, ['(literal "/cr/a")', '(literal "/cr")']));
  });

  test("nothing denied: the fence slots are empty lines, both sides", () => {
    const p = profile({ cwd: "/cr/w" });
    expect(between(p, "(allow file-read*)", REPERMIT)).toEqual(["", "", ""]);
    expect(p).toContain(`(allow file-write*\n  (subpath "/cr/w"))\n\n\n\n(deny ${OPS} (subpath "/cr/w/.gitconfig"))`);
    // Empty arrays behave exactly like absent ones.
    expect(profile({ cwd: "/cr/w", denyWritePaths: [], denyReadPaths: [], denyWriteGlobFixedPrefixes: [], denyReadGlobFixedPrefixes: [] })).toBe(p);
  });
});

describe("write-root create/unlink re-permit", () => {
  test("one subpath clause per canonical write root, de-duplicated -- unlike the write-allow block, which repeats a root", () => {
    const p = profile({ cwd: "/cr/w", writableRoots: ["/cr/w", "/cr/x/", "/cr//y", "/cr/x"] });
    expect(blocks(p, REPERMIT)).toEqual([block(REPERMIT, ['(subpath "/cr/w")', '(subpath "/cr/x")', '(subpath "/cr/y")'])]);
    expect(blocks(p, "(allow file-write*")).toEqual([
      block("(allow file-write*", ['(subpath "/cr/w")', '(subpath "/cr/w")', '(subpath "/cr/x")', '(subpath "/cr/y")', '(subpath "/cr/x")']),
    ]);
  });

  test("always present (cwd is always a root), right after the read-side fence and before the run-dir read deny", () => {
    const p = profile({ cwd: "/cr/w", home: "/cr/h" });
    expect(between(p, "(allow file-read*)", '(deny file-read* (subpath "/cr/h/.winter/run"))')).toEqual(["", "", "", REPERMIT, '  (subpath "/cr/w"))']);
  });

  test("escapes quotes and backslashes", () => {
    const p = profile({ cwd: '/cr/q"t', writableRoots: ["/cr/b\\s"] });
    expect(blocks(p, REPERMIT)[0]).toBe(block(REPERMIT, ['(subpath "/cr/q\\"t")', '(subpath "/cr/b\\\\s")']));
  });

  test("absent, empty and repeated writableRoots", () => {
    expect(blocks(profile({ cwd: "/cr/w" }), REPERMIT)[0]).toBe(block(REPERMIT, ['(subpath "/cr/w")']));
    expect(blocks(profile({ cwd: "/cr/w", writableRoots: [] }), REPERMIT)[0]).toBe(block(REPERMIT, ['(subpath "/cr/w")']));
    expect(blocks(profile({ cwd: "/cr/w/", writableRoots: ["/cr/w/."] }), REPERMIT)[0]).toBe(block(REPERMIT, ['(subpath "/cr/w")']));
  });
});

describe("default write protections", () => {
  const ENTRIES = (proj: string, gitConfig: boolean) => [
    [".gitconfig", false],
    [".gitmodules", false],
    [".bashrc", false],
    [".bash_profile", false],
    [".zshrc", false],
    [".zprofile", false],
    [".profile", false],
    [".ripgreprc", false],
    [".mcp.json", false],
    [`${proj}/mcp.json`, false],
    [".vscode", true],
    [".idea", true],
    [".claude/commands", true],
    [".claude/agents", true],
    [`${proj}/commands`, true],
    [`${proj}/agents`, true],
    [`${proj}/skills`, true],
    [`${proj}/rules`, true],
    [`${proj}/output-styles`, true],
    [".git/hooks", true],
    ...(gitConfig ? [[".git/config", false] as const] : []),
  ] as const;

  /** The rendered lines, in order: every plain deny, then every regex deny, then the fence. */
  function expectedLines(cwd: string, proj: string, gitConfig: boolean, fence: string): string[] {
    const entries = ENTRIES(proj, gitConfig);
    return [
      ...entries.map(([e]) => `(deny ${OPS} (subpath "${cwd}/${e}"))`),
      ...entries.map(([e, dir]) => `(deny ${OPS} (regex #"${recursiveGlobToSbplRegexSource(`${cwd}/**/${e}${dir ? "/**" : ""}`)}"))`),
      ...fence.split("\n"),
    ];
  }

  /** From the first default plain deny through the end of the default protections' fence. */
  function defaultBlockLines(p: string): string[] {
    const lines = p.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`(deny ${OPS} (subpath "`) && l.endsWith('/.gitconfig"))'));
    const fenceAt = lines.indexOf(FENCE, start);
    let end = fenceAt + 1;
    while (lines[end]?.startsWith("  ")) end++;
    return lines.slice(start, end);
  }

  test("default brand: every entry in its fixed order, plain then regex then fence", () => {
    const p = profile({ cwd: "/cr/w" });
    expect(defaultBlockLines(p)).toEqual(expectedLines("/cr/w", ".winter", true, DEFAULT_FENCE_CW));
    // Stating the default brand explicitly changes nothing.
    expect(profile({ cwd: "/cr/w", brand: WINTER_BRAND })).toBe(p);
  });

  test("the project entries use the brand's projectDirName, never its homeDirName", () => {
    const p = profile({ cwd: "/cr/w", brand: { homeDirName: ".acme", projectDirName: ".acme-proj" } });
    const lines = defaultBlockLines(p);
    expect(lines.slice(0, 42)).toEqual(expectedLines("/cr/w", ".acme-proj", true, "").slice(0, 42));
    expect(lines.join("\n")).not.toContain("/.acme/");
    expect(blocks(p, FENCE)[0]).toContain('  (literal "/cr/w/.acme-proj")');
  });

  test("allowGitConfigWrites drops .git/config from all three parts and nothing else", () => {
    const p = profile({ cwd: "/cr/w", allowGitConfigWrites: true });
    const expectedFence = block(FENCE, DEFAULT_FENCE_CW_CLAUSES.filter((c) => c !== '(subpath "/cr/w/.git/config")'));
    expect(defaultBlockLines(p)).toEqual(expectedLines("/cr/w", ".winter", false, expectedFence));
    // false and absent are the same.
    expect(profile({ cwd: "/cr/w", allowGitConfigWrites: false })).toBe(profile({ cwd: "/cr/w" }));
  });

  test("cwd `/`: the fence names no `/` literal", () => {
    const p = profile({ cwd: "/" });
    const fence = blocks(p, FENCE)[0]!;
    expect(fence).toBe(
      block(FENCE, [
        '(subpath "/.gitconfig")',
        '(subpath "/.gitmodules")',
        '(subpath "/.bashrc")',
        '(subpath "/.bash_profile")',
        '(subpath "/.zshrc")',
        '(subpath "/.zprofile")',
        '(subpath "/.profile")',
        '(subpath "/.ripgreprc")',
        '(subpath "/.mcp.json")',
        '(subpath "/.winter/mcp.json")',
        '(literal "/.winter")',
        '(subpath "/.vscode")',
        '(subpath "/.idea")',
        '(subpath "/.claude/commands")',
        '(literal "/.claude")',
        '(subpath "/.claude/agents")',
        '(subpath "/.winter/commands")',
        '(subpath "/.winter/agents")',
        '(subpath "/.winter/skills")',
        '(subpath "/.winter/rules")',
        '(subpath "/.winter/output-styles")',
        '(subpath "/.git/hooks")',
        '(literal "/.git")',
        '(subpath "/.git/config")',
      ]),
    );
    expect(p).toContain(`(deny ${OPS} (regex #"^/(.*/)?\\.gitconfig(/.*)?$"))`);
  });

  test("a non-normalised cwd is normalised in every part", () => {
    const p = profile({ cwd: "/cr/w/../v/" });
    expect(p).toContain(`(deny ${OPS} (subpath "/cr/v/.gitconfig"))`);
    expect(p).toContain(`(deny ${OPS} (regex #"^/cr/v/(.*/)?\\.gitconfig(/.*)?$"))`);
    expect(blocks(p, FENCE)[0]!.split("\n").slice(0, 4)).toEqual([FENCE, '  (subpath "/cr/v/.gitconfig")', '  (literal "/cr/v")', '  (literal "/cr")']);
  });

  test("a quote and a backslash in cwd: subpath clauses escape both; regex clauses escape only the quote", () => {
    const p = profile({ cwd: '/cr/q"t\\b' });
    expect(p).toContain(`(deny ${OPS} (subpath "/cr/q\\"t\\\\b/.gitconfig"))`);
    expect(p).toContain(`(deny ${OPS} (regex #"^/cr/q\\"t\\\\b/(.*/)?\\.gitconfig(/.*)?$"))`);
    expect(blocks(p, FENCE)[0]!.split("\n").slice(0, 4)).toEqual([FENCE, '  (subpath "/cr/q\\"t\\\\b/.gitconfig")', '  (literal "/cr/q\\"t\\\\b")', '  (literal "/cr")']);
  });

  test("anchored on cwd alone: extra write roots and configured denies change nothing in the block", () => {
    const base = defaultBlockLines(profile({ cwd: "/cr/w" }));
    expect(defaultBlockLines(profile({ cwd: "/cr/w", writableRoots: ["/cr/x"], denyReadPaths: ["/cr/w/.env"], denyWritePaths: ["/cr/z"] }))).toEqual(base);
  });
});

describe("keep read-denied paths in place", () => {
  test("the combined case: equality skipped, ancestors filtered, nested roots carved out, glob carve-outs by regex, unrelated globs skipped", () => {
    const p = profile({
      cwd: "/cr/w",
      writableRoots: ["/cr/w", "/cr/w/p/d/build", "/cr/w/p/d/b2"],
      denyReadPaths: ["/cr/w", "/cr/w/p/d", "/cr/w/p/d/e", "/cr/other"],
      denyReadGlobEntries: [
        { regex: "^/cr/w/p/(.*/)?d(/.*)?$", fixedPrefix: "/cr/w/p" },
        { regex: "^/(.*/)?k(/.*)?$", fixedPrefix: "/" },
        // Never compiled: its prefix relates to no write root.
        { regex: "(", fixedPrefix: "/nope" },
      ],
    });
    expect(blocks(p, KEEP)).toEqual([
      block(KEEP, [
        '(require-all (subpath "/cr/w/p/d") (require-not (subpath "/cr/w/p/d/build")) (require-not (subpath "/cr/w/p/d/b2")))',
        '(literal "/cr/w/p")',
        '(subpath "/cr/w/p/d/e")',
        '(literal "/cr/w/p/d")',
        '(require-all (regex #"^/cr/w/p/(.*/)?d(/.*)?$") (require-not (subpath "/cr/w/p/d/build")) (require-not (subpath "/cr/w/p/d/b2")))',
        '(regex #"^/(.*/)?k(/.*)?$")',
      ]),
    ]);
    // Placed right after the default protections, right before the /dev allowance.
    const lines = p.split("\n");
    expect(lines[lines.indexOf(KEEP) - 1]).toBe('  (subpath "/cr/w/.git/config"))');
    expect(lines[lines.indexOf(KEEP) + 7]).toStartWith("(allow file-write-data");
  });

  test("a glob entry that relates to a write root is compiled as a JavaScript RegExp: an invalid one throws", () => {
    expect(() => profile({ cwd: "/cr/w", denyReadGlobEntries: [{ regex: "(", fixedPrefix: "/cr/w/p" }] })).toThrow(SyntaxError);
  });

  test("a read-denied path EQUAL to a write root, or outside every root, produces no block; the slot is an empty line", () => {
    const p = profile({ cwd: "/cr/w", writableRoots: ["/cr/x"], denyReadPaths: ["/cr/w", "/cr/x/", "/cr/elsewhere/f"] });
    expect(blocks(p, KEEP)).toEqual([]);
    const lines = p.split("\n");
    const dev = lines.findIndex((l) => l.startsWith("(allow file-write-data"));
    expect(lines[dev - 1]).toBe("");
    expect(lines[dev - 2]).toBe('  (subpath "/cr/w/.git/config"))');
  });

  test("write root `/`: every other path is properly inside it, `/` itself never is", () => {
    const p = profile({ cwd: "/", denyReadPaths: ["/cr/a/.env", "/"] });
    expect(blocks(p, KEEP)).toEqual([block(KEEP, ['(subpath "/cr/a/.env")', '(literal "/cr/a")', '(literal "/cr")'])]);
  });

  test("a nested root listed twice is carved out twice, in write-root order", () => {
    const p = profile({ cwd: "/cr/w", writableRoots: ["/cr/w/d/b2", "/cr/w/d/b", "/cr/w/d/b2"], denyReadPaths: ["/cr/w/d"] });
    expect(blocks(p, KEEP)).toEqual([
      block(KEEP, ['(require-all (subpath "/cr/w/d") (require-not (subpath "/cr/w/d/b2")) (require-not (subpath "/cr/w/d/b")) (require-not (subpath "/cr/w/d/b2")))']),
    ]);
  });

  test("a sibling root that merely shares a name prefix is not inside the denied path", () => {
    const p = profile({ cwd: "/cr/w", writableRoots: ["/cr/w/dd"], denyReadPaths: ["/cr/w/d"] });
    expect(blocks(p, KEEP)).toEqual([block(KEEP, ['(subpath "/cr/w/d")'])]);
  });

  test("plain read-denied paths are canonicalised", () => {
    const p = profile({ cwd: "/cr/w", denyReadPaths: ["/cr/w/p//.env/", "/cr/w/x/../q/./f"] });
    expect(blocks(p, KEEP)).toEqual([block(KEEP, ['(subpath "/cr/w/p/.env")', '(literal "/cr/w/p")', '(subpath "/cr/w/q/f")', '(literal "/cr/w/q")'])]);
  });

  test("glob entries relate to a root by equality, by the prefix being inside the root, or by the root being inside the prefix", () => {
    const equal = profile({ cwd: "/cr/w", denyReadGlobEntries: [{ regex: "^/cr/w/(.*/)?\\.env(/.*)?$", fixedPrefix: "/cr/w" }] });
    expect(blocks(equal, KEEP)).toEqual([block(KEEP, ['(regex #"^/cr/w/(.*/)?\\.env(/.*)?$")'])]);
    const inside = profile({ cwd: "/cr/w", denyReadGlobEntries: [{ regex: "^/cr/w/a/b/(.*/)?\\.env(/.*)?$", fixedPrefix: "/cr/w/a/b" }] });
    expect(blocks(inside, KEEP)).toEqual([block(KEEP, ['(regex #"^/cr/w/a/b/(.*/)?\\.env(/.*)?$")', '(literal "/cr/w/a/b")', '(literal "/cr/w/a")'])]);
    const containing = profile({ cwd: "/cr/w/a", denyReadGlobEntries: [{ regex: "^/cr/(.*/)?\\.env(/.*)?$", fixedPrefix: "/cr" }] });
    expect(blocks(containing, KEEP)).toEqual([block(KEEP, ['(regex #"^/cr/(.*/)?\\.env(/.*)?$")'])]);
    const unrelated = profile({ cwd: "/cr/w", denyReadGlobEntries: [{ regex: "^/cr/ww/(.*/)?\\.env(/.*)?$", fixedPrefix: "/cr/ww" }] });
    expect(blocks(unrelated, KEEP)).toEqual([]);
  });

  test("glob carve-outs are the write roots the regex matches, whether or not they sit under the prefix", () => {
    const p = profile({
      cwd: "/cr/w",
      writableRoots: ["/cr/w/q/build", "/cr/w/p/keep", "/cr/w/p/build"],
      denyReadGlobEntries: [{ regex: "^/cr/w/(.*/)?build(/.*)?$", fixedPrefix: "/cr/w/p" }],
    });
    expect(blocks(p, KEEP)).toEqual([
      block(KEEP, ['(require-all (regex #"^/cr/w/(.*/)?build(/.*)?$") (require-not (subpath "/cr/w/q/build")) (require-not (subpath "/cr/w/p/build")))', '(literal "/cr/w/p")']),
    ]);
  });

  test("a glob prefix is used as given (not canonicalised) and `/` contributes no literal", () => {
    const raw = profile({ cwd: "/cr/w", denyReadGlobEntries: [{ regex: "^/cr/w/p/(.*/)?x(/.*)?$", fixedPrefix: "/cr/w/p/" }] });
    expect(blocks(raw, KEEP)).toEqual([block(KEEP, ['(regex #"^/cr/w/p/(.*/)?x(/.*)?$")', '(literal "/cr/w/p/")'])]);
    const root = profile({ cwd: "/", denyReadGlobEntries: [{ regex: "^/(.*/)?x(/.*)?$", fixedPrefix: "/" }] });
    expect(blocks(root, KEEP)).toEqual([block(KEEP, ['(regex #"^/(.*/)?x(/.*)?$")'])]);
  });

  test("a regex is embedded with only its double quotes escaped; plain paths escape quotes and backslashes", () => {
    const p = profile({
      cwd: "/cr/w",
      denyReadPaths: ['/cr/w/q"t\\b/f'],
      denyReadGlobEntries: [{ regex: '^/cr/w/"x\\.y(/.*)?$', fixedPrefix: "/cr/w" }],
    });
    expect(blocks(p, KEEP)).toEqual([
      block(KEEP, ['(subpath "/cr/w/q\\"t\\\\b/f")', '(literal "/cr/w/q\\"t\\\\b")', '(regex #"^/cr/w/\\"x\\.y(/.*)?$")']),
    ]);
  });

  test("clauses are de-duplicated across plain paths and glob entries, first occurrence wins", () => {
    const p = profile({
      cwd: "/cr/w",
      denyReadPaths: ["/cr/w/a/b", "/cr/w/a/b", "/cr/w/a/c"],
      denyReadGlobEntries: [
        { regex: "^/cr/w/a/(.*/)?z(/.*)?$", fixedPrefix: "/cr/w/a" },
        { regex: "^/cr/w/a/(.*/)?z(/.*)?$", fixedPrefix: "/cr/w/a/b" },
      ],
    });
    expect(blocks(p, KEEP)).toEqual([
      block(KEEP, ['(subpath "/cr/w/a/b")', '(literal "/cr/w/a")', '(subpath "/cr/w/a/c")', '(regex #"^/cr/w/a/(.*/)?z(/.*)?$")', '(literal "/cr/w/a/b")']),
    ]);
  });
});
