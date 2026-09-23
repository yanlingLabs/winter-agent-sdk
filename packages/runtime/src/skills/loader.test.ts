// WS-21 §6.3 item 1 (F6, F7): the skill loader must follow symlinked skill directories, exactly as
// claude does (`entry.isDirectory() || entry.isSymbolicLink()`). A dangling link is skipped silently,
// the same way a subdirectory with no SKILL.md is skipped silently today.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkillRoot } from "./loader.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scanSkillRoot: symlinked entries (WS-21 §6.3 item 1)", () => {
  test("a symlinked skill directory loads like a real one (claude: isDirectory() || isSymbolicLink())", () => {
    const root = mkTemp("skills-");
    const real = mkTemp("real-");
    mkdirSync(join(real, "linked-skill"));
    writeFileSync(join(real, "linked-skill", "SKILL.md"), "---\ndescription: d\n---\nbody");
    symlinkSync(join(real, "linked-skill"), join(root, "linked-skill"));
    expect(scanSkillRoot(root, "user").skills.map((s) => s.name)).toEqual(["linked-skill"]);
  });

  test("a dangling skill symlink is skipped without an error", () => {
    const root = mkTemp("skills-");
    symlinkSync(join(root, "nowhere"), join(root, "ghost"));
    expect(scanSkillRoot(root, "user")).toEqual({ skills: [], errors: [] });
  });

  test("a symlink to a FILE (not a directory) is not admitted as a skill entry", () => {
    const root = mkTemp("skills-");
    const real = mkTemp("real-");
    writeFileSync(join(real, "not-a-dir"), "hello");
    symlinkSync(join(real, "not-a-dir"), join(root, "not-a-dir"));
    expect(scanSkillRoot(root, "user")).toEqual({ skills: [], errors: [] });
  });
});

describe("scanSkillRoot: skill identity is the directory name (WS-21 §6.3 item 9)", () => {
  test("dir `alpha` with a declared `name: beta` is discovered as `alpha`, not `beta`", () => {
    const root = mkTemp("skills-");
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "alpha", "SKILL.md"), "---\nname: beta\ndescription: d\n---\nbody");
    const found = scanSkillRoot(root, "user").skills;
    expect(found.map((s) => s.name)).toEqual(["alpha"]);
  });

  test("a skill with no description is kept, with description === \"\"", () => {
    const root = mkTemp("skills-");
    mkdirSync(join(root, "gamma"));
    writeFileSync(join(root, "gamma", "SKILL.md"), "---\nname: gamma\n---\nbody");
    const result = scanSkillRoot(root, "user");
    expect(result.errors).toEqual([]);
    expect(result.skills).toEqual([{ name: "gamma", description: "", source: "user", path: join(root, "gamma", "SKILL.md") }]);
  });
});
