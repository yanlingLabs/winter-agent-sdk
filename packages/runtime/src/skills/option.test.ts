// Phase 5 Lane S slice 3 (WS-11 §2.2): the `skills` option -- validated BEFORE any spawn, and the
// permission entries the engine adds on the caller's behalf.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillIndex, PROJECT_PLUGIN_NAME } from "./store.ts";
import { validateSkillsOption, autoSkillPermissionEntries, isSkillEnabled, isLegalSkillIdentity, SKILL_TOOL_NAME } from "./option.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function indexWith(names: string[]): SkillIndex {
  const repo = mkTemp("winter-opt-repo-");
  const winterHome = mkTemp("winter-opt-home-");
  for (const name of names) {
    const dir = join(repo, ".winter", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} does things\n---\n\nbody of ${name}`, "utf8");
  }
  return SkillIndex.build({ cwd: repo, winterHome });
}

describe("validateSkillsOption (report §60: names validated before the runtime spawns)", () => {
  test('"all" is accepted and resolves to every indexed skill', () => {
    const result = validateSkillsOption("all", indexWith(["alpha", "beta"]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.skills).toEqual(["alpha", "beta"]);
  });

  test("a list of known names is accepted and preserved in the caller's order", () => {
    const result = validateSkillsOption(["beta", "alpha"], indexWith(["alpha", "beta"]));
    expect(result.ok && result.skills).toEqual(["beta", "alpha"]);
  });

  test("an UNKNOWN name is a typed failure naming every unknown, not a throw", () => {
    const result = validateSkillsOption(["alpha", "nope", "also-nope"], indexWith(["alpha"]));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.unknown).toEqual(["nope", "also-nope"]);
    expect(!result.ok && result.message).toContain("nope");
  });

  test("an alias resolves: `.winter:<name>` names the same skill as its bare form", () => {
    const result = validateSkillsOption([`${PROJECT_PLUGIN_NAME}:alpha`], indexWith(["alpha"]));
    expect(result.ok).toBe(true);
  });

  test("an empty list is VALID and means no skill is invocable -- distinct from omitting the option", () => {
    const result = validateSkillsOption([], indexWith(["alpha"]));
    expect(result.ok).toBe(true);
    expect(result.ok && result.skills).toEqual([]);
    expect(isSkillEnabled([], "alpha", indexWith(["alpha"]))).toBe(false);
    expect(isSkillEnabled(undefined, "alpha", indexWith(["alpha"]))).toBe(true);
  });

  test("a name that is not even a legal slug fails validation rather than reaching the filesystem", () => {
    const result = validateSkillsOption(["../escape"], indexWith(["alpha"]));
    expect(result.ok).toBe(false);
  });
});

describe("validateSkillsOption: the `tools`-must-include-Skill rule (WS-11 §2.2)", () => {
  test("a restricting `tools` list that omits Skill makes skills uninvocable, and the validation SAYS SO", () => {
    const result = validateSkillsOption(["alpha"], indexWith(["alpha"]), { tools: ["Read", "Bash"] });
    expect(result.ok).toBe(true); // the names are fine -- the restriction is a warning, not a name error
    expect(result.warnings.join(" ")).toContain(SKILL_TOOL_NAME);
    expect(result.warnings.join(" ")).toContain("uninvocable");
  });

  test("the same list WITH Skill produces no warning", () => {
    expect(validateSkillsOption(["alpha"], indexWith(["alpha"]), { tools: ["Read", SKILL_TOOL_NAME] }).warnings).toEqual([]);
  });

  test("no `tools` restriction at all produces no warning -- omission is not a restriction", () => {
    expect(validateSkillsOption(["alpha"], indexWith(["alpha"])).warnings).toEqual([]);
    expect(validateSkillsOption(["alpha"], indexWith(["alpha"]), { tools: [] }).warnings).toEqual([]);
  });

  test("`disallowedTools` naming Skill is the OTHER way to make skills uninvocable, and warns too", () => {
    expect(validateSkillsOption(["alpha"], indexWith(["alpha"]), { disallowedTools: [SKILL_TOOL_NAME] }).warnings.join(" ")).toContain("uninvocable");
  });

  test("with `skills` unset there is nothing to warn about, whatever `tools` says", () => {
    expect(validateSkillsOption(undefined, indexWith(["alpha"]), { tools: ["Read"] }).warnings).toEqual([]);
  });
});

describe("isLegalSkillIdentity: the executor's jail agrees with the index's", () => {
  test("every plugin name the INDEX admits is one the executor will also accept", () => {
    const repo = mkTemp("winter-jail-repo-");
    const winterHome = mkTemp("winter-jail-home-");
    // `.acme` is admissible under PLUGIN_NAME_PATTERN (the leading dot exists for `.winter`), so the
    // index qualifies `.acme:ship`. A stricter check in the executor would advertise a skill it then
    // refuses -- the two jails must be the same jail.
    const index = SkillIndex.build({ cwd: repo, winterHome, plugins: [{ plugin: ".acme", skills: [{ name: "ship", description: "d", path: "/p/SKILL.md" }] }] });
    for (const name of index.names()) expect(isLegalSkillIdentity(name)).toBe(true);
    expect(index.names()).toEqual([".acme:ship"]);
  });

  test("a traversing or malformed identity is still refused", () => {
    for (const bad of ["../escape", "a/b", "plug/in:ship", "acme:../ship", "ACME:ship"]) {
      expect(isLegalSkillIdentity(bad)).toBe(false);
    }
  });
});

describe("autoSkillPermissionEntries (WS-11 §2.2: the SDK adds these, callers do not)", () => {
  test('"all" produces the bare tool rule -- every skill, any arguments', () => {
    expect(autoSkillPermissionEntries("all")).toEqual([SKILL_TOOL_NAME]);
  });

  test("a list produces one name-scoped rule per skill, in order", () => {
    expect(autoSkillPermissionEntries(["alpha", "beta"])).toEqual(["Skill(alpha)", "Skill(beta)"]);
  });

  test("an empty list and an omitted option both produce NO entries", () => {
    expect(autoSkillPermissionEntries([])).toEqual([]);
    expect(autoSkillPermissionEntries(undefined)).toEqual([]);
  });

  test("duplicate names collapse -- the engine must not add the same allow twice", () => {
    expect(autoSkillPermissionEntries(["alpha", "alpha"])).toEqual(["Skill(alpha)"]);
  });
});
