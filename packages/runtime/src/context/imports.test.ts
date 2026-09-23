// WS-21 §6.3 item 4 (F17): `@import` expansion, claude's tier rule.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandImports } from "./imports.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

describe("expandImports: a relative import", () => {
  test("@./other.md resolves relative to the CONTAINING file's directory and is inlined", () => {
    const dir = mkTemp("imports-rel-");
    write(dir, "other.md", "OTHER CONTENT");
    const filePath = join(dir, "main.md");
    const result = expandImports({ content: "before @./other.md after", filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe("before OTHER CONTENT after");
    expect(result.dropped).toEqual([]);
  });

  test("a bare @path (no ./ prefix) is relative too, identically to @./path", () => {
    const dir = mkTemp("imports-bare-");
    write(dir, "other.md", "BARE CONTENT");
    const filePath = join(dir, "main.md");
    const result = expandImports({ content: "see @other.md now", filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe("see BARE CONTENT now");
  });
});

describe("expandImports: depth cap", () => {
  test("nesting stops at maxDepth; the deepest token stays literal", () => {
    const dir = mkTemp("imports-depth-");
    write(dir, "c.md", "LEAF @./d.md");
    write(dir, "d.md", "NEVER REACHED");
    write(dir, "b.md", "B -> @./c.md");
    const filePath = join(dir, "a.md");
    // depth 1 = a.md's own content; depth 2 = b.md's content; maxDepth 2 means b.md's OWN
    // @./c.md token is at depth 2 already (>= maxDepth), so it is left literal and c.md/d.md are
    // never read at all.
    const result = expandImports({ content: "A -> @./b.md", filePath, tier: "user", projectRoot: null, maxDepth: 2 });
    expect(result.content).toBe("A -> B -> @./c.md");
  });

  test("a higher maxDepth reaches further", () => {
    const dir = mkTemp("imports-depth2-");
    write(dir, "c.md", "LEAF");
    write(dir, "b.md", "B -> @./c.md");
    const filePath = join(dir, "a.md");
    const result = expandImports({ content: "A -> @./b.md", filePath, tier: "user", projectRoot: null, maxDepth: 3 });
    expect(result.content).toBe("A -> B -> LEAF");
  });
});

describe("expandImports: code spans and code blocks are skipped", () => {
  test("an @path inside a fenced code block is never expanded", () => {
    const dir = mkTemp("imports-fence-");
    write(dir, "other.md", "SHOULD NOT APPEAR");
    const filePath = join(dir, "main.md");
    const content = "before\n```\nsee @./other.md here\n```\nafter";
    const result = expandImports({ content, filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe(content);
    expect(result.content).not.toContain("SHOULD NOT APPEAR");
  });

  test("an @path inside an inline code span is never expanded, even when whitespace precedes it INSIDE the span", () => {
    const dir = mkTemp("imports-span-");
    write(dir, "other.md", "SHOULD NOT APPEAR");
    const filePath = join(dir, "main.md");
    // Whitespace surrounds the token on BOTH sides, all of it still inside the backticks: the
    // token itself parses as a clean, resolvable "./other.md" with nothing trailing to corrupt it
    // (a token directly abutting the closing backtick would absorb it into the path and fail to
    // resolve for an unrelated reason -- a file that happens not to exist -- which would pass this
    // assertion even with span-stripping disabled and so not actually prove anything).
    const content = "run ` @./other.md ` literally";
    const result = expandImports({ content, filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe(content);
  });

  test("an @path OUTSIDE the fence, in the same file, still expands", () => {
    const dir = mkTemp("imports-mixed-");
    write(dir, "other.md", "REAL CONTENT");
    const filePath = join(dir, "main.md");
    const content = "```\n@./ignored.md\n```\nsee @./other.md now";
    const result = expandImports({ content, filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe("```\n@./ignored.md\n```\nsee REAL CONTENT now");
  });
});

describe("expandImports: project/local tier scope (F17)", () => {
  test("a project file dropping @~/.aws/credentials", () => {
    const repo = mkTemp("imports-proj-repo-");
    const filePath = join(repo, ".winter", "WINTER.md");
    mkdirSync(join(repo, ".winter"), { recursive: true });
    const result = expandImports({ content: "leaked @~/.aws/credentials here", filePath, tier: "project", projectRoot: repo });
    expect(result.content).toBe("leaked @~/.aws/credentials here"); // literal text stays -- never expanded
    expect(result.dropped).toEqual([join(homedir(), ".aws", "credentials")]);
  });

  test("a project file's import INSIDE the project root still expands", () => {
    const repo = mkTemp("imports-proj-inside-");
    write(repo, "shared.md", "SHARED CONTENT");
    const filePath = join(repo, ".winter", "WINTER.md");
    const result = expandImports({ content: "see @../shared.md", filePath, tier: "project", projectRoot: repo });
    expect(result.content).toBe("see SHARED CONTENT");
    expect(result.dropped).toEqual([]);
  });

  test("a local file is scoped identically to a project file", () => {
    const repo = mkTemp("imports-local-repo-");
    const filePath = join(repo, "WINTER.local.md");
    const result = expandImports({ content: "leaked @~/.ssh/id_rsa here", filePath, tier: "local", projectRoot: repo });
    expect(result.content).toBe("leaked @~/.ssh/id_rsa here");
    expect(result.dropped).toEqual([join(homedir(), ".ssh", "id_rsa")]);
  });

  test("a project file with no projectRoot drops every import", () => {
    const filePath = "/repo/.winter/WINTER.md";
    const result = expandImports({ content: "see @./x.md", filePath, tier: "project", projectRoot: null });
    expect(result.content).toBe("see @./x.md");
    expect(result.dropped).toEqual(["/repo/.winter/x.md"]);
  });
});

describe("expandImports: a user file follows an external import (unrestricted)", () => {
  test("a user-tier file expands an import OUTSIDE both its own directory and any project root", () => {
    const home = mkTemp("imports-user-home-");
    const external = mkTemp("imports-user-external-");
    write(external, "shared.md", "EXTERNAL CONTENT");
    const filePath = join(home, "WINTER.md");
    // projectRoot is set to something ENTIRELY unrelated to `external` -- a user rule still follows it.
    const unrelatedRoot = mkTemp("imports-user-unrelated-root-");
    const result = expandImports({
      content: `see @${join(external, "shared.md")}`,
      filePath,
      tier: "user",
      projectRoot: unrelatedRoot,
    });
    expect(result.content).toBe("see EXTERNAL CONTENT");
    expect(result.dropped).toEqual([]);
  });
});

describe("expandImports: an unresolved token is kept", () => {
  test("a missing file's @path stays as literal text, and is not reported as dropped", () => {
    const dir = mkTemp("imports-missing-");
    const filePath = join(dir, "main.md");
    const result = expandImports({ content: "see @./nowhere.md now", filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe("see @./nowhere.md now");
    expect(result.dropped).toEqual([]);
  });

  test("a shape that is not a valid import token (starts with punctuation) is left untouched", () => {
    const dir = mkTemp("imports-invalid-");
    const filePath = join(dir, "main.md");
    const result = expandImports({ content: "an email like foo@#bar is not an import", filePath, tier: "user", projectRoot: null });
    expect(result.content).toBe("an email like foo@#bar is not an import");
  });
});
