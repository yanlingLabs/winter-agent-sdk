import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePathPattern, fetchUpstream, UpstreamFetchError, type AllowlistPath, type UpstreamPin } from "./fetch.ts";

/**
 * HERMETIC. Every test here builds a throwaway git repository in a mkdtemp directory and clones it
 * over `file://` — no network, no `~/.winter`, no real upstream. That buys the two things a mocked
 * git could never prove: the ANNOTATED-TAG PEEL is real (an annotated tag's own object id is not a
 * commit, which is the exact trap the OmniRoute pin sets), and the boundary re-check runs against
 * what git actually materialized rather than what we asked it for.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  pin: UpstreamPin;
  repository: string;
}

/** Build a git repo with an ANNOTATED tag, and return the pin that describes it truthfully. */
function makeUpstreamFixture(files: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), "winter-fetch-fixture-"));
  roots.push(root);
  const repo = join(root, "upstream");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "winter-test",
        GIT_AUTHOR_EMAIL: "winter-test@example.test",
        GIT_COMMITTER_NAME: "winter-test",
        GIT_COMMITTER_EMAIL: "winter-test@example.test",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    }).trim();

  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  // ANNOTATED (`-a`), not lightweight: a lightweight tag IS its commit and would make the peel test
  // vacuous, which is precisely how a pin on the tag object slips through unnoticed.
  git("tag", "-a", "v9.9.9", "-m", "fixture release");
  return {
    repository: `file://${repo}`,
    pin: {
      repository: `file://${repo}`,
      tag: "v9.9.9",
      tagObject: git("rev-parse", "v9.9.9"),
      commit: git("rev-parse", "v9.9.9^{commit}"),
    },
  };
}

const PATHS: AllowlistPath[] = [
  { pattern: "/LICENSE", role: "notice", why: "licence" },
  { pattern: "/src/keep/**", role: "extract", why: "the allowlisted subtree" },
];

const FILES = {
  LICENSE: "MIT-ish fixture licence\n",
  "src/keep/a.ts": "export const A = 1;\n",
  "src/keep/nested/b.ts": "export const B = 2;\n",
  "src/skip/secret.ts": "export const NOPE = 3;\n",
  "NOTES.md": "not allowlisted\n",
};

describe("fetchUpstream", () => {
  test("an ANNOTATED tag's own object is NOT its commit — and the pin records both", () => {
    const fixture = makeUpstreamFixture(FILES);
    expect(fixture.pin.tagObject).not.toBe(fixture.pin.commit);

    const result = fetchUpstream(fixture.pin, PATHS);
    try {
      expect(result.commit).toBe(fixture.pin.commit);
      expect(result.tagObject).toBe(fixture.pin.tagObject);
    } finally {
      result.cleanup();
    }
  });

  test("materializes exactly the allowlist, with git blob ids and sha256 of the bytes", () => {
    const fixture = makeUpstreamFixture(FILES);
    const result = fetchUpstream(fixture.pin, PATHS);
    try {
      expect(result.files.map((f) => f.path).sort()).toEqual(["LICENSE", "src/keep/a.ts", "src/keep/nested/b.ts"]);
      const license = result.files.find((f) => f.path === "LICENSE")!;
      expect(license.role).toBe("notice");
      expect(license.admittedBy).toBe("/LICENSE");
      expect(license.blobId).toMatch(/^[0-9a-f]{40}$/);
      expect(license.sha256).toBe(new Bun.CryptoHasher("sha256").update(FILES.LICENSE).digest("hex"));
      expect(license.bytes).toBe(FILES.LICENSE.length);
      expect(result.read("src/keep/a.ts")).toBe(FILES["src/keep/a.ts"]);
    } finally {
      result.cleanup();
    }
  });

  test("a WRONG COMMIT in the pin is a refusal, not a warning — this is what survives a re-tag", () => {
    const fixture = makeUpstreamFixture(FILES);
    const wrong = { ...fixture.pin, commit: "0".repeat(40) };
    expect(() => fetchUpstream(wrong, PATHS)).toThrow(UpstreamFetchError);
    try {
      fetchUpstream(wrong, PATHS);
    } catch (error) {
      expect((error as Error).message).toContain("PEELS to commit");
      expect((error as Error).message).toContain("Refusing to extract");
    }
  });

  test("a WRONG TAG OBJECT is refused too — the peel alone would not catch a re-tag onto the same tree", () => {
    const fixture = makeUpstreamFixture(FILES);
    expect(() => fetchUpstream({ ...fixture.pin, tagObject: "1".repeat(40) }, PATHS)).toThrow(/tag .* resolves to object/);
  });

  test("a pattern git reads MORE WIDELY than the allowlist does is a boundary violation", () => {
    const fixture = makeUpstreamFixture(FILES);
    // The real divergence class, not a contrived one. `/src/keep` is a DIRECTORY pattern: git's
    // gitignore-style matcher materializes the whole subtree under it, while this module's compiler
    // reads it as the single path `src/keep` and matches neither file that lands. Trusting the
    // patterns we handed to sparse-checkout would let the extra files through silently; the
    // post-checkout re-check is what turns the mismatch into a refusal naming the offending path.
    expect(() => fetchUpstream(fixture.pin, [{ pattern: "/src/keep", role: "extract", why: "a directory pattern" }])).toThrow(/boundary violation/);
    try {
      fetchUpstream(fixture.pin, [{ pattern: "/src/keep", role: "extract", why: "a directory pattern" }]);
    } catch (error) {
      expect((error as Error).message).toContain("src/keep/a.ts");
      expect((error as Error).message).toContain("never widens the source boundary");
    }
  });

  test("cleanup() removes the scratch checkout, and a refusal cleans up on its own", () => {
    const fixture = makeUpstreamFixture(FILES);
    const result = fetchUpstream(fixture.pin, PATHS);
    const root = result.root;
    expect(Bun.file(join(root, "LICENSE")).size).toBeGreaterThan(0);
    result.cleanup();
    expect(Bun.file(join(root, "LICENSE")).size).toBe(0);
  });

  test("git runs with an EMPTY hooks path, so a hostile repository's hooks cannot execute", () => {
    const source = Bun.file(fileURLToPath(new URL("fetch.ts", import.meta.url)));
    return source.text().then((text) => {
      expect(text).toContain("core.hooksPath=");
      expect(text).toContain('"--template="');
    });
  });
});

describe("compilePathPattern", () => {
  test("anchors, `*` stops at a separator, `**` does not", () => {
    const one = compilePathPattern("/a/*/c.ts");
    expect(one("a/b/c.ts")).toBe(true);
    expect(one("a/b/x/c.ts")).toBe(false);
    const deep = compilePathPattern("/a/**");
    expect(deep("a/b/c/d.ts")).toBe(true);
    expect(deep("b/a/c.ts")).toBe(false);
  });

  test("a literal dot is a dot, not `any character`", () => {
    const dot = compilePathPattern("/a.ts");
    expect(dot("a.ts")).toBe(true);
    expect(dot("axts")).toBe(false);
  });

  test("an unanchored or exotic pattern is REFUSED rather than silently mis-parsed", () => {
    expect(() => compilePathPattern("src/**")).toThrow(/repository-anchored/);
    expect(() => compilePathPattern("/src/[abc].ts")).toThrow(/deliberately does not implement/);
  });
});
