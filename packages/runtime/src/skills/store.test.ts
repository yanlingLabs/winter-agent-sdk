// Phase 5 Lane S slice 1: the skill INDEX -- frontmatter, the slug jail, byte caps, the five tiers,
// the parent-walk, source gating, and the lazy-body contract.
//
// TEST HYGIENE (this whole lane): every fixture builds its own mkdtemp tree and passes `home`
// EXPLICITLY. Nothing here reads `process.env`, `~/.winter`, `~/.norma` or `~/.claude`, and no real
// username appears in any path -- `mkdtempSync(join(tmpdir(), ...))` names every root.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFile, skillNameError, pluginNameError, capBytes, DEFAULT_SKILL_BODY_BYTES, SKILL_TRUNCATION_MARKER } from "./frontmatter.ts";
import { projectSkillRoots, scanSkillRoot, findRepoRoot } from "./loader.ts";
import { SkillIndex, PROJECT_PLUGIN_NAME } from "./store.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, front: Record<string, string>, body: string): string {
  const skillDir = join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  const fm = Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, `---\n${fm}\n---\n\n${body}`, "utf8");
  return path;
}

describe("frontmatter (ported from Norma skills.ts, WS-11 §2.5)", () => {
  test("name + description are read from the leading fence and the body follows it", () => {
    const parsed = parseSkillFile("---\nname: review\ndescription: reviews code\n---\n\nDo the review.", "fallback");
    expect(parsed).toEqual({ name: "review", description: "reviews code", body: "Do the review." });
  });

  test("a missing `name` falls back to the DIRECTORY name; a missing `description` invalidates the whole file", () => {
    expect(parseSkillFile("---\ndescription: d\n---\nbody", "from-dir")?.name).toBe("from-dir");
    expect(parseSkillFile("---\nname: n\n---\nbody", "from-dir")).toBeNull();
  });

  test("no leading fence, and an unterminated fence, are both `null` -- never a nameless index entry", () => {
    expect(parseSkillFile("no frontmatter at all", "d")).toBeNull();
    expect(parseSkillFile("---\nname: n\ndescription: d\nnever closed", "d")).toBeNull();
  });

  test("quoted scalars have their quotes stripped, and a `---` deeper in the file is BODY, not frontmatter", () => {
    const parsed = parseSkillFile('---\nname: "quoted"\ndescription: \'also quoted\'\n---\n\nintro\n---\nname: spoof\ndescription: spoof\n---\n', "d");
    expect(parsed?.name).toBe("quoted");
    expect(parsed?.description).toBe("also quoted");
    expect(parsed?.body).toContain("name: spoof");
  });

  test("`author` is read as a flagged Winter extension and is absent when unstamped", () => {
    expect(parseSkillFile("---\nname: n\ndescription: d\nauthor: winter\n---\nb", "d")?.author).toBe("winter");
    expect(parseSkillFile("---\nname: n\ndescription: d\n---\nb", "d")).not.toHaveProperty("author");
  });

  test("the slug jail rejects traversal, nesting, uppercase, underscores, over-length and empty", () => {
    expect(skillNameError("ok-name-9")).toBeNull();
    for (const bad of ["../x", "a/b", "A_B", "a_b", "", ".hidden", "a".repeat(65), "has space"]) {
      expect(skillNameError(bad)).not.toBeNull();
    }
  });

  test("the plugin-name jail additionally admits the canonical leading-dot project plugin name", () => {
    expect(pluginNameError(".winter")).toBeNull();
    expect(pluginNameError("my-plugin")).toBeNull();
    expect(pluginNameError("../evil")).not.toBeNull();
  });

  test("capBytes cuts on a BYTE boundary and marks the cut", () => {
    expect(capBytes("abc", 10)).toBe("abc");
    expect(capBytes("abcdef", 3)).toBe("abc" + SKILL_TRUNCATION_MARKER);
  });
});

describe("project tier: the parent-walk (WS-11 §2.1, report §60)", () => {
  test("findRepoRoot stops at the directory holding .git; roots are nearest-first from cwd up to it", () => {
    const repo = mkTemp("winter-skills-repo-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const deep = join(repo, "packages", "app", "src");
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(repo);
    expect(projectSkillRoots(deep)).toEqual([join(deep, ".winter", "skills"), join(repo, "packages", "app", ".winter", "skills"), join(repo, "packages", ".winter", "skills"), join(repo, ".winter", "skills")]);
  });

  test("with NO repository root above it, the walk covers cwd alone -- it never climbs to the filesystem root", () => {
    const loose = mkTemp("winter-skills-loose-");
    const deep = join(loose, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBeUndefined();
    expect(projectSkillRoots(deep)).toEqual([join(deep, ".winter", "skills")]);
  });

  test("a NEARER .winter/skills shadows a repo-root one of the same name", () => {
    const repo = mkTemp("winter-skills-shadow-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    writeSkill(join(repo, ".winter", "skills"), "shared", { name: "shared", description: "root one" }, "root body");
    writeSkill(join(sub, ".winter", "skills"), "shared", { name: "shared", description: "near one" }, "near body");
    const index = SkillIndex.build({ cwd: sub, winterHome: mkTemp("winter-home-") });
    expect(index.get("shared")?.description).toBe("near one");
    expect(index.load("shared")?.body).toBe("near body");
  });
});

describe("scanSkillRoot", () => {
  test("skips a malformed skill, a missing root and a non-directory entry -- never throws", () => {
    const root = mkTemp("winter-scan-");
    writeSkill(root, "good", { name: "good", description: "d" }, "b");
    mkdirSync(join(root, "bad"), { recursive: true });
    writeFileSync(join(root, "bad", "SKILL.md"), "no frontmatter", "utf8");
    writeFileSync(join(root, "loose.md"), "---\nname: x\ndescription: y\n---\n", "utf8");
    expect(scanSkillRoot(root, "project").map((s) => s.name)).toEqual(["good"]);
    expect(scanSkillRoot(join(root, "nope"), "project")).toEqual([]);
  });
});

describe("SkillIndex: tiers, precedence and source gating (WS-11 §2.1, P5 amendment)", () => {
  function tree() {
    const repo = mkTemp("winter-tiers-repo-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const winterHome = join(mkTemp("winter-tiers-home-"), ".winter");
    writeSkill(join(repo, ".winter", "skills"), "alpha", { name: "alpha", description: "project alpha" }, "project body");
    writeSkill(join(winterHome, "skills"), "alpha", { name: "alpha", description: "user alpha" }, "user body");
    writeSkill(join(winterHome, "skills"), "beta", { name: "beta", description: "user beta" }, "user beta body");
    writeSkill(join(winterHome, "skills", "self"), "gamma", { name: "gamma", description: "self gamma", author: "winter" }, "self body");
    return { repo, winterHome };
  }

  test("precedence is project > user > self > plugin > builtin, first occurrence of a name wins", () => {
    const { repo, winterHome } = tree();
    const index = SkillIndex.build({
      cwd: repo,
      winterHome,
      plugins: [{ plugin: "acme", skills: [{ name: "beta", description: "plugin beta", path: "/p/acme/skills/beta/SKILL.md" }] }],
      builtinSkills: [{ name: "delta", description: "builtin delta", source: "builtin", path: "/b/delta/SKILL.md" }],
    });
    expect(index.get("alpha")?.source).toBe("project");
    expect(index.get("beta")?.source).toBe("user");
    expect(index.get("gamma")?.source).toBe("self");
    expect(index.get("gamma")?.author).toBe("winter");
    expect(index.get("acme:beta")?.source).toBe("plugin");
    expect(index.get("delta")?.source).toBe("builtin");
  });

  test("the user tier is addressed by the RESOLVED winter root, so a WINTER_HOME not named `.winter` works", () => {
    // The regression this pins: an option field taking the OS home and appending `.winter` itself
    // CANNOT honour WINTER_HOME, whose value may be any directory under any name. A fixture whose
    // root happens to be called `.winter` cannot see the difference, so this one deliberately is not.
    const repo = mkTemp("winter-envhome-repo-");
    const winterHome = join(mkTemp("winter-envhome-"), "custom-winter-root");
    writeSkill(join(winterHome, "skills"), "fromenv", { name: "fromenv", description: "d" }, "ENV BODY");
    const index = SkillIndex.build({ cwd: repo, winterHome });
    expect(index.get("fromenv")?.source).toBe("user");
    expect(index.load("fromenv")?.body).toBe("ENV BODY");
  });

  test("the `self` tier lives under the user root and is therefore gated on the `user` source too", () => {
    // DISCLOSED divergence from Norma, whose `self` tier always loads: `~/.winter/skills/self` is a
    // subdirectory of the user root, so a session that has not enabled the `user` source has not
    // enabled the directory `self` lives in either. Gating them together is the only reading under
    // which `settingSources: []` means what WS-01 §2.4 says it means -- no filesystem discovery.
    const { repo, winterHome } = tree();
    expect(SkillIndex.build({ cwd: repo, winterHome }).get("gamma")?.source).toBe("self");
    expect(SkillIndex.build({ cwd: repo, winterHome, settingSources: ["project"] }).get("gamma")).toBeUndefined();
  });

  test("the user tier's reserved `self/` subdirectory is never listed as a user skill", () => {
    const { repo, winterHome } = tree();
    const index = SkillIndex.build({ cwd: repo, winterHome });
    expect(index.list().map((s) => s.name)).not.toContain("self");
  });

  test("PROJECT skills are SOURCE-gated: absent from `settingSources`, they do not load at all", () => {
    const { repo, winterHome } = tree();
    const gated = SkillIndex.build({ cwd: repo, winterHome, settingSources: ["user"] });
    expect(gated.get("alpha")?.source).toBe("user");
    const off = SkillIndex.build({ cwd: repo, winterHome, settingSources: [] });
    expect(off.list()).toEqual([]);
  });

  test("USER skills are source-gated on `user`, and `settingSources: undefined` means all three tiers", () => {
    const { repo, winterHome } = tree();
    expect(SkillIndex.build({ cwd: repo, winterHome, settingSources: ["project"] }).get("beta")).toBeUndefined();
    expect(SkillIndex.build({ cwd: repo, winterHome }).get("beta")?.source).toBe("user");
  });

  test("plugin and builtin tiers are NOT source-gated -- a host-listed plugin survives `settingSources: []`", () => {
    const { repo, winterHome } = tree();
    const index = SkillIndex.build({
      cwd: repo,
      winterHome,
      settingSources: [],
      plugins: [{ plugin: "acme", skills: [{ name: "beta", description: "plugin beta", path: "/p/acme/skills/beta/SKILL.md" }] }],
      builtinSkills: [{ name: "delta", description: "builtin delta", source: "builtin", path: "/b/delta/SKILL.md" }],
    });
    expect(index.names().sort()).toEqual(["acme:beta", "delta"]);
  });

  test("`disableBundledSkills` removes the builtin tier and nothing else", () => {
    const { repo, winterHome } = tree();
    const index = SkillIndex.build({ cwd: repo, winterHome, disableBundledSkills: true, builtinSkills: [{ name: "delta", description: "d", source: "builtin", path: "/b" }] });
    expect(index.get("delta")).toBeUndefined();
    expect(index.get("alpha")?.source).toBe("project");
  });

  test("`strictPluginOnlyCustomization` covering skills leaves ONLY the plugin tier", () => {
    const { repo, winterHome } = tree();
    const plugins = [{ plugin: "acme", skills: [{ name: "beta", description: "plugin beta", path: "/p/acme/skills/beta/SKILL.md" }] }];
    const builtinSkills = [{ name: "delta", description: "builtin delta", source: "builtin" as const, path: "/b" }];
    for (const value of [true, ["skills"]] as const) {
      const index = SkillIndex.build({ cwd: repo, winterHome, plugins, builtinSkills, strictPluginOnlyCustomization: value });
      expect(index.names()).toEqual(["acme:beta"]);
    }
  });

  test("`strictPluginOnlyCustomization` naming OTHER areas, or a malformed value, restricts nothing", () => {
    const { repo, winterHome } = tree();
    for (const value of [false, [], ["agents", "hooks"], "yes" as unknown as boolean] as const) {
      expect(SkillIndex.build({ cwd: repo, winterHome, strictPluginOnlyCustomization: value }).get("alpha")?.source).toBe("project");
    }
  });

  test("the builtin registry is an EMPTY seam by default -- Winter ships no bundled skills yet", () => {
    const { repo, winterHome } = tree();
    expect(SkillIndex.build({ cwd: repo, winterHome }).list().filter((s) => s.source === "builtin")).toEqual([]);
  });
});

// --- Fix round 1, Minor 2: the two index jails, each previously invisible to the suite ----------
describe("SkillIndex: the name jails (security-shaped, fixtured so a revert is loud)", () => {
  test("a FRONTMATTER-declared `name:` that escapes the slug jail keeps the skill out of the index", () => {
    // The directory name is legal; the DECLARED name is not. `parseSkillFile` prefers the declared
    // one, so without the jail on the RESOLVED name the index advertises a name
    // `isLegalSkillIdentity` then refuses -- the advertise-then-refuse split the executor's own jail
    // exists to prevent. `option.test.ts` sweeps plugin-qualified names only; this is the other route.
    const repo = mkTemp("winter-jail-fm-repo-");
    const winterHome = mkTemp("winter-jail-fm-home-");
    for (const [dir, declared] of [
      ["escape", "../../escape"],
      ["upper", "UPPER"],
      ["spaced", "has space"],
      ["nested", "a/b"],
      ["dotted", ".hidden"],
    ]) {
      writeSkill(join(repo, ".winter", "skills"), dir!, { name: declared!, description: "d" }, "BODY");
    }
    writeSkill(join(repo, ".winter", "skills"), "fine", { name: "fine", description: "d" }, "BODY");
    expect(SkillIndex.build({ cwd: repo, winterHome }).names()).toEqual(["fine"]);
  });

  test("a PLUGIN name that could traverse never becomes a qualified skill name", () => {
    const repo = mkTemp("winter-jail-plug-repo-");
    const winterHome = mkTemp("winter-jail-plug-home-");
    const index = SkillIndex.build({
      cwd: repo,
      winterHome,
      plugins: [
        { plugin: "../evil", skills: [{ name: "ship", description: "d", path: "/p/SKILL.md" }] },
        { plugin: "a/b", skills: [{ name: "ship", description: "d", path: "/p/SKILL.md" }] },
        { plugin: "UP", skills: [{ name: "ship", description: "d", path: "/p/SKILL.md" }] },
        { plugin: "ok-plugin", skills: [{ name: "ship", description: "d", path: "/p/SKILL.md" }] },
      ],
    });
    expect(index.names()).toEqual(["ok-plugin:ship"]);
  });
});

describe("SkillIndex: `.winter:<skill>` qualification (WS-11 §4)", () => {
  test("a project skill answers to BOTH its bare name and `.winter:<name>`, and lists under the bare one", () => {
    const repo = mkTemp("winter-qual-repo-");
    const winterHome = mkTemp("winter-qual-home-");
    writeSkill(join(repo, ".winter", "skills"), "review", { name: "review", description: "d" }, "the body");
    const index = SkillIndex.build({ cwd: repo, winterHome });
    expect(index.get("review")?.name).toBe("review");
    expect(index.get(`${PROJECT_PLUGIN_NAME}:review`)?.name).toBe("review");
    expect(index.load(`${PROJECT_PLUGIN_NAME}:review`)?.body).toBe("the body");
    expect(index.list().map((s) => s.name)).toEqual(["review"]);
  });

  test("the SAME `.winter` tree reached as a loaded PLUGIN qualifies identically -- one name, not two entries", () => {
    const repo = mkTemp("winter-qual2-repo-");
    const winterHome = mkTemp("winter-qual2-home-");
    const path = writeSkill(join(repo, ".winter", "skills"), "review", { name: "review", description: "d" }, "the body");
    const index = SkillIndex.build({ cwd: repo, winterHome, plugins: [{ plugin: PROJECT_PLUGIN_NAME, skills: [{ name: "review", description: "d", path }] }] });
    expect(index.list().filter((s) => s.name.endsWith("review"))).toHaveLength(1);
    expect(index.get(`${PROJECT_PLUGIN_NAME}:review`)?.source).toBe("project");
  });
});

describe("SkillIndex: the lazy-body contract (WS-11 §2.1 -- bodies are never bulk-loaded)", () => {
  test("the index carries name+description only; `load()` reads the CURRENT file, so a post-index edit is visible", () => {
    const repo = mkTemp("winter-lazy-repo-");
    const winterHome = mkTemp("winter-lazy-home-");
    const path = writeSkill(join(repo, ".winter", "skills"), "lazy", { name: "lazy", description: "d" }, "ORIGINAL");
    const index = SkillIndex.build({ cwd: repo, winterHome });
    expect(JSON.stringify(index.list())).not.toContain("ORIGINAL");
    writeFileSync(path, "---\nname: lazy\ndescription: d\n---\n\nREPLACED", "utf8");
    expect(index.load("lazy")?.body).toBe("REPLACED");
  });

  test("`load()` byte-caps the body and reports a miss as null", () => {
    const repo = mkTemp("winter-cap-repo-");
    const winterHome = mkTemp("winter-cap-home-");
    writeSkill(join(repo, ".winter", "skills"), "big", { name: "big", description: "d" }, "x".repeat(DEFAULT_SKILL_BODY_BYTES + 500));
    const index = SkillIndex.build({ cwd: repo, winterHome, bodyBytes: 64 });
    const loaded = index.load("big");
    expect(loaded?.body.endsWith(SKILL_TRUNCATION_MARKER)).toBe(true);
    expect(loaded?.body.length).toBe(64 + SKILL_TRUNCATION_MARKER.length);
    expect(index.load("no-such-skill")).toBeNull();
  });

  test("a skill deleted from disk after indexing loads as null rather than throwing", () => {
    const repo = mkTemp("winter-gone-repo-");
    const winterHome = mkTemp("winter-gone-home-");
    writeSkill(join(repo, ".winter", "skills"), "gone", { name: "gone", description: "d" }, "b");
    const index = SkillIndex.build({ cwd: repo, winterHome });
    rmSync(join(repo, ".winter", "skills", "gone"), { recursive: true, force: true });
    expect(index.load("gone")).toBeNull();
  });
});
