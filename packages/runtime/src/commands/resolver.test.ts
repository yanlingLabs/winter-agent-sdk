// Phase 5 Lane S slice 5 (WS-11 §2.4, R5-14): the FILESYSTEM half of slash-command resolution.
//
// The spine owns the ordering above this file: the engine claims its own built-ins FIRST, and only
// an unclaimed `/name` ever reaches a resolver (commands/seam.ts). Nothing here produces the
// `builtin` arm.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillIndex, PROJECT_PLUGIN_NAME } from "../skills/store.ts";
import { FilesystemCommandResolver } from "./resolver.ts";
import { BUILTIN_SLASH_COMMANDS, buildSlashCommandListing, slashCommandNames } from "./builtins-listing.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeCommand(root: string, name: string, body: string): string {
  const dir = join(root, ".winter", "commands");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

/** The USER tier: `<winterHome>/commands/<name>.md` -- WINTER_HOME points AT the .winter root. */
function writeUserCommand(winterHome: string, name: string, body: string): string {
  const dir = join(winterHome, "commands");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

function writeSkill(root: string, name: string, description: string, body: string): void {
  const dir = join(root, ".winter", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`, "utf8");
}

describe("FilesystemCommandResolver: `.winter/commands/<name>.md` creates `/name`", () => {
  test("a project command expands to its body with a provenance source", async () => {
    const repo = mkTemp("winter-cmd-repo-");
    const path = writeCommand(repo, "review", "Please review the code.");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-cmd-home-") });
    expect(await resolver.resolve("/review", repo)).toEqual({ kind: "expand", text: "Please review the code.", source: path });
  });

  test("a prompt that is not a command, and an unknown `/name`, both resolve to `none`", async () => {
    const repo = mkTemp("winter-cmd-none-");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-cmd-none-home-") });
    expect(await resolver.resolve("just a prompt", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("/nothing-here", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("//not-a-command", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("/", repo)).toEqual({ kind: "none" });
  });

  test("this resolver NEVER produces the `builtin` arm -- a commands/compact.md is just a command", async () => {
    const repo = mkTemp("winter-cmd-compact-");
    writeCommand(repo, "compact", "not the real compact");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-cmd-compact-home-") });
    const result = await resolver.resolve("/compact", repo);
    expect(result.kind).toBe("expand");
  });

  test("frontmatter is stripped from the expanded text and feeds the listing instead", async () => {
    const repo = mkTemp("winter-cmd-fm-");
    writeCommand(repo, "deploy", "---\ndescription: ships it\nargument-hint: <env>\n---\n\nDeploy to $ARGUMENTS.");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-cmd-fm-home-") });
    const result = await resolver.resolve("/deploy staging", repo);
    expect(result).toEqual({ kind: "expand", text: "Deploy to staging.", source: join(repo, ".winter", "commands", "deploy.md") });
    expect(resolver.list().find((c) => c.name === "deploy")).toEqual({ name: "deploy", description: "ships it", argumentHint: "<env>", source: "project" });
  });
});

describe("FilesystemCommandResolver: `$ARGUMENTS` (the resolver's own job, R5-14)", () => {
  test("every occurrence is substituted, and `expand.text` is FULLY expanded", async () => {
    const repo = mkTemp("winter-args-");
    writeCommand(repo, "echo", "one $ARGUMENTS two $ARGUMENTS");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-args-home-") });
    const result = await resolver.resolve("/echo hello world", repo);
    expect(result).toMatchObject({ kind: "expand", text: "one hello world two hello world" });
  });

  test("no arguments substitutes the EMPTY string -- the model never sees the literal `$ARGUMENTS`", async () => {
    const repo = mkTemp("winter-args2-");
    writeCommand(repo, "bare", "before[$ARGUMENTS]after");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-args2-home-") });
    expect(await resolver.resolve("/bare", repo)).toMatchObject({ text: "before[]after" });
  });

  test("arguments are taken verbatim after the first whitespace run, inner spacing preserved", async () => {
    const repo = mkTemp("winter-args3-");
    writeCommand(repo, "x", "<$ARGUMENTS>");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-args3-home-") });
    expect(await resolver.resolve("/x  a  b  ", repo)).toMatchObject({ text: "<a  b>" });
  });
});

describe("FilesystemCommandResolver: tiers, the parent-walk and source gating", () => {
  test("a NEARER project command shadows one further up, and the user tier is the fallback", async () => {
    const repo = mkTemp("winter-cmd-tiers-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    const winterHome = mkTemp("winter-cmd-tiers-home-");
    writeCommand(repo, "shared", "root command");
    writeCommand(sub, "shared", "near command");
    writeUserCommand(winterHome, "useronly", "user command");
    const resolver = FilesystemCommandResolver.build({ cwd: sub, winterHome });
    expect(await resolver.resolve("/shared", sub)).toMatchObject({ text: "near command" });
    expect(await resolver.resolve("/useronly", sub)).toMatchObject({ text: "user command" });
  });

  test("project commands are SOURCE-gated and user commands are gated on `user`", async () => {
    const repo = mkTemp("winter-cmd-gate-");
    const winterHome = mkTemp("winter-cmd-gate-home-");
    writeCommand(repo, "proj", "p");
    writeUserCommand(winterHome, "usr", "u");
    expect(await FilesystemCommandResolver.build({ cwd: repo, winterHome, settingSources: ["user"] }).resolve("/proj", repo)).toEqual({ kind: "none" });
    expect(await FilesystemCommandResolver.build({ cwd: repo, winterHome, settingSources: ["project"] }).resolve("/usr", repo)).toEqual({ kind: "none" });
    expect(await FilesystemCommandResolver.build({ cwd: repo, winterHome, settingSources: [] }).resolve("/proj", repo)).toEqual({ kind: "none" });
  });

  test("a plugin command answers to its qualified `/plugin:name`", async () => {
    const repo = mkTemp("winter-cmd-plugin-");
    const pluginRoot = mkTemp("winter-cmd-plugindir-");
    const path = join(pluginRoot, "commands", "ship.md");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    writeFileSync(path, "Ship $ARGUMENTS", "utf8");
    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      winterHome: mkTemp("winter-cmd-plugin-home-"),
      plugins: [{ plugin: "acme", commands: [{ name: "ship", path }] }],
    });
    expect(await resolver.resolve("/acme:ship now", repo)).toMatchObject({ kind: "expand", text: "Ship now" });
    expect(await resolver.resolve("/ship", repo)).toEqual({ kind: "none" });
  });
});

describe("FilesystemCommandResolver: skills also create `/name` (WS-11 §2.4)", () => {
  test("a skill with no command file of the same name is invocable as `/name`", async () => {
    const repo = mkTemp("winter-cmdskill-");
    const winterHome = mkTemp("winter-cmdskill-home-");
    writeSkill(repo, "audit", "audits things", "AUDIT BODY for $ARGUMENTS");
    const index = SkillIndex.build({ cwd: repo, winterHome });
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: index });
    expect(await resolver.resolve("/audit everything", repo)).toMatchObject({ kind: "expand", text: "AUDIT BODY for everything" });
  });

  test("OVERLAP: a SKILL wins over a command file of the same name, and the source says which", async () => {
    const repo = mkTemp("winter-overlap-");
    const winterHome = mkTemp("winter-overlap-home-");
    writeSkill(repo, "review", "d", "SKILL WINS");
    writeCommand(repo, "review", "COMMAND LOSES");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: SkillIndex.build({ cwd: repo, winterHome }) });
    const result = await resolver.resolve("/review", repo);
    expect(result).toMatchObject({ kind: "expand", text: "SKILL WINS" });
    expect(result.kind === "expand" && result.source).toContain("SKILL.md");
  });

  test('a skill marked "off" by skillOverrides is not reachable as `/name`, but "user-invocable-only" IS', async () => {
    const repo = mkTemp("winter-overr-");
    const winterHome = mkTemp("winter-overr-home-");
    writeSkill(repo, "hidden", "d", "HIDDEN BODY");
    writeSkill(repo, "manual", "d", "MANUAL BODY");
    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      winterHome,
      skills: SkillIndex.build({ cwd: repo, winterHome }),
      skillOverrides: { hidden: "off", manual: "user-invocable-only" },
    });
    expect(await resolver.resolve("/hidden", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("/manual", repo)).toMatchObject({ text: "MANUAL BODY" });
  });
});

// --- Fix round 1, Medium 1 --------------------------------------------------------------------
//
// `list()` and `resolve()` must be two views of ONE ordered enumeration. Before the fix they walked
// opposite orders, so the listing reported the LOSING producer's metadata for a shadowed name and
// could advertise a name nothing answered.
describe("the listing and resolve() are two views of ONE enumeration (fix round 1, Medium 1)", () => {
  function overlapped() {
    const repo = mkTemp("winter-enum-repo-");
    const winterHome = mkTemp("winter-enum-home-");
    writeSkill(repo, "review", "SKILL DESCRIPTION", "SKILL BODY");
    writeCommand(repo, "review", "---\ndescription: COMMAND DESCRIPTION\nargument-hint: <cmdhint>\n---\n\nCOMMAND BODY");
    return { repo, winterHome };
  }

  test("for a SHADOWED name the listing reports the producer that actually answers -- not the loser", async () => {
    const { repo, winterHome } = overlapped();
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: SkillIndex.build({ cwd: repo, winterHome }) });
    expect(await resolver.resolve("/review", repo)).toMatchObject({ text: "SKILL BODY" });
    const listed = buildSlashCommandListing(resolver).find((c) => c.name === "review");
    expect(listed).toEqual({ name: "review", description: "SKILL DESCRIPTION", source: "skill" });
    expect(listed).not.toHaveProperty("argumentHint"); // the COMMAND file's hint must not leak onto the skill's entry
  });

  test('an "off" skill removes the name from the LISTING as well as from resolve()', async () => {
    const { repo, winterHome } = overlapped();
    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      winterHome,
      skills: SkillIndex.build({ cwd: repo, winterHome }),
      skillOverrides: { review: "off" },
    });
    expect(await resolver.resolve("/review", repo)).toEqual({ kind: "none" });
    expect(slashCommandNames(resolver)).not.toContain("review");
    expect(resolver.list()).toEqual([]);
  });

  test("every listed name resolves, and every resolvable name is listed -- the invariant, swept", async () => {
    const repo = mkTemp("winter-sweep-repo-");
    const winterHome = mkTemp("winter-sweep-home-");
    writeSkill(repo, "shadowed", "d", "S1");
    writeCommand(repo, "shadowed", "C1");
    writeSkill(repo, "hidden", "d", "S2");
    writeCommand(repo, "hidden", "C2");
    writeSkill(repo, "skillonly", "d", "S3");
    writeCommand(repo, "cmdonly", "C4");
    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      winterHome,
      skills: SkillIndex.build({ cwd: repo, winterHome }),
      skillOverrides: { hidden: "off" },
    });
    const listed = resolver.list().map((c) => c.name).sort();
    expect(listed).toEqual(["cmdonly", "shadowed", "skillonly"]);
    for (const name of listed) expect((await resolver.resolve(`/${name}`, repo)).kind).toBe("expand");
    expect(await resolver.resolve("/hidden", repo)).toEqual({ kind: "none" });
  });

  test("a `user-invocable-only` skill IS listed by this resolver -- that is the door it keeps", () => {
    const repo = mkTemp("winter-uio-repo-");
    const winterHome = mkTemp("winter-uio-home-");
    writeSkill(repo, "manual", "d", "B");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: SkillIndex.build({ cwd: repo, winterHome }), skillOverrides: { manual: "user-invocable-only" } });
    expect(resolver.list().map((c) => c.name)).toEqual(["manual"]);
  });

  test("a skill that VANISHED after indexing resolves to `none` -- it never hands the name to a command file", async () => {
    const { repo, winterHome } = overlapped();
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: SkillIndex.build({ cwd: repo, winterHome }) });
    rmSync(join(repo, ".winter", "skills", "review"), { recursive: true, force: true });
    // DELIBERATE (fix round 1, Minor 4): the enumeration decides who owns a name, and ownership must
    // not change because a file disappeared mid-session -- that is the listing/resolve divergence
    // this round fixed, displaced in time.
    expect(await resolver.resolve("/review", repo)).toEqual({ kind: "none" });
  });
});

// --- Fix round 2, Medium A ----------------------------------------------------------------------
//
// `enumerate()` seeds from `skills.list()`, which returns PRIMARY names only. The pre-fix `resolve()`
// reached aliases through `index.get()`, so `/.winter:review` worked; the enumeration lost it, and a
// plugin NAMED `.winter` could then answer the qualified name with a command file -- the P5-H
// inversion, re-opened in the alias dimension.
describe("the enumeration carries ALIASES as resolvable-but-unlisted (fix round 2, Medium A)", () => {
  function aliased(opts?: { overrides?: Record<string, string>; dotWinterPlugin?: boolean }) {
    const repo = mkTemp("winter-alias-repo-");
    const winterHome = mkTemp("winter-alias-home-");
    writeSkill(repo, "review", "SKILL DESCRIPTION", "SKILL BODY");
    const pluginRoot = mkTemp("winter-alias-plugin-");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    writeFileSync(join(pluginRoot, "commands", "review.md"), "PLUGIN COMMAND BODY", "utf8");
    return FilesystemCommandResolver.build({
      cwd: repo,
      winterHome,
      skills: SkillIndex.build({ cwd: repo, winterHome }),
      ...(opts?.overrides !== undefined ? { skillOverrides: opts.overrides } : {}),
      ...(opts?.dotWinterPlugin ? { plugins: [{ plugin: ".winter", commands: [{ name: "review", path: join(pluginRoot, "commands", "review.md") }] }] } : {}),
    });
  }

  test("`/.winter:<name>` resolves to the skill body, exactly as the bare name does", async () => {
    const resolver = aliased();
    const bare = await resolver.resolve("/review", "/anywhere");
    const qualified = await resolver.resolve(`/${PROJECT_PLUGIN_NAME}:review`, "/anywhere");
    expect(bare).toMatchObject({ kind: "expand", text: "SKILL BODY" });
    expect(qualified).toMatchObject({ kind: "expand", text: "SKILL BODY" });
    expect(qualified).toEqual(bare); // same source path too -- one owner, one answer
  });

  test("a plugin NAMED `.winter` cannot take the qualified name from the skill that owns it", async () => {
    const resolver = aliased({ dotWinterPlugin: true });
    expect(await resolver.resolve(`/${PROJECT_PLUGIN_NAME}:review`, "/anywhere")).toMatchObject({ text: "SKILL BODY" });
  });

  test("an alias is NEVER advertised -- `slash_commands` carries the primary name only", () => {
    const resolver = aliased({ dotWinterPlugin: true });
    expect(resolver.list().map((c) => c.name)).toEqual(["review"]);
    expect(slashCommandNames(resolver)).toEqual(["compact", "review"]);
  });

  test("an `off` skill blocks its ALIAS too -- and a `.winter` plugin command may not answer behind it", async () => {
    const resolver = aliased({ overrides: { review: "off" }, dotWinterPlugin: true });
    expect(await resolver.resolve("/review", "/anywhere")).toEqual({ kind: "none" });
    expect(await resolver.resolve(`/${PROJECT_PLUGIN_NAME}:review`, "/anywhere")).toEqual({ kind: "none" });
    expect(resolver.list()).toEqual([]);
  });

  test("SWEEP: every resolvable name is either LISTED, or an unlisted alias of a listed name", async () => {
    const repo = mkTemp("winter-alias-sweep-repo-");
    const winterHome = mkTemp("winter-alias-sweep-home-");
    writeSkill(repo, "shadowed", "d", "S1");
    writeCommand(repo, "shadowed", "C1");
    writeSkill(repo, "hidden", "d", "S2");
    writeSkill(repo, "skillonly", "d", "S3");
    writeCommand(repo, "cmdonly", "C4");
    const index = SkillIndex.build({ cwd: repo, winterHome });
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: index, skillOverrides: { hidden: "off" } });
    const listed = resolver.list().map((c) => c.name);
    expect(listed.sort()).toEqual(["cmdonly", "shadowed", "skillonly"]);

    // Every alias of a LISTED skill resolves, and none of them is itself listed.
    for (const name of ["shadowed", "skillonly"]) {
      for (const alias of index.identities(name).slice(1)) {
        expect(listed).not.toContain(alias);
        expect((await resolver.resolve(`/${alias}`, repo)).kind).toBe("expand");
      }
    }
    // A disabled skill's aliases resolve to nothing, same as its primary name.
    for (const alias of index.identities("hidden")) {
      expect(await resolver.resolve(`/${alias}`, repo)).toEqual({ kind: "none" });
    }
  });
});

// --- Fix round 2, Minor B -------------------------------------------------------------------------
describe("the listing/resolve invariant is PER CWD (fix round 2, Minor B)", () => {
  test("the invariant holds when the SAME cwd feeds both, and the listing follows the cwd it is given", async () => {
    const repo = mkTemp("winter-cwd-repo-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const other = join(repo, "other");
    mkdirSync(other, { recursive: true });
    const winterHome = mkTemp("winter-cwd-home-");
    writeCommand(repo, "atroot", "ROOT");
    writeCommand(other, "atother", "OTHER");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome });

    // The construction cwd sees only the root command; `other` additionally sees its own.
    expect(slashCommandNames(resolver)).toEqual(["compact", "atroot"]);
    expect(slashCommandNames(resolver, other).sort()).toEqual(["atother", "atroot", "compact"]);

    // The invariant: pass the SAME cwd to both and every listed name resolves there.
    for (const cwd of [repo, other]) {
      for (const name of resolver.list(cwd).map((c) => c.name)) {
        expect((await resolver.resolve(`/${name}`, cwd)).kind).toBe("expand");
      }
    }
    // And the failure it guards against: a name listed at one cwd need not resolve at another.
    expect(await resolver.resolve("/atother", repo)).toEqual({ kind: "none" });
  });
});

describe("the slash-command listing (`system/init.slash_commands`)", () => {
  test("the engine's built-ins are listed and `/compact` is the only one R5-14 ships", () => {
    expect(BUILTIN_SLASH_COMMANDS.map((c) => c.name)).toEqual(["compact"]);
  });

  test("built-ins come first, then SKILLS, then command files -- names only, deduplicated", () => {
    const repo = mkTemp("winter-listing-");
    const winterHome = mkTemp("winter-listing-home-");
    writeCommand(repo, "review", "c");
    writeSkill(repo, "review", "d", "s");
    writeSkill(repo, "audit", "d", "s");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome, skills: SkillIndex.build({ cwd: repo, winterHome }) });
    expect(slashCommandNames(resolver)).toEqual(["compact", "audit", "review"]);
    expect(buildSlashCommandListing(resolver).find((c) => c.name === "audit")).toEqual({ name: "audit", description: "d", source: "skill" });
  });

  test("with no resolver at all the listing is exactly the built-ins", () => {
    expect(slashCommandNames()).toEqual(["compact"]);
  });
});

// -------------------------------------------------------------------------------------------
// Phase 5 fix wave, whole-branch Minor m2: a command file's stem is a NAMESPACE, not just a label.
// -------------------------------------------------------------------------------------------
describe("m2: a command file may not claim a qualified `<plugin>:<name>` identity", () => {
  test("a checked-in `.winter/commands/acme:ship.md` does NOT shadow the host-installed plugin `acme`", async () => {
    const repo = mkTemp("winter-cmd-m2-repo-");
    const pluginRoot = mkTemp("winter-cmd-m2-plugin-");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    const pluginPath = join(pluginRoot, "commands", "ship.md");
    writeFileSync(pluginPath, "SHIP FROM THE PLUGIN", "utf8");
    // The repository's file, whose stem spells the plugin's qualified name.
    writeCommand(repo, "acme:ship", "SHIP FROM THE REPOSITORY");

    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      winterHome: mkTemp("winter-cmd-m2-home-"),
      plugins: [{ plugin: "acme", commands: [{ name: "ship", path: pluginPath }] }],
    });
    // Enumeration is skills -> project/user FILES -> plugin, first-wins. Before the jail, the
    // repository's file reached the map first and the operator's own installed plugin never got
    // its own name: `/acme:ship` ran text from a cloned repository.
    expect(await resolver.resolve("/acme:ship", repo)).toMatchObject({ kind: "expand", text: "SHIP FROM THE PLUGIN", source: pluginPath });
    // `acme:ship` IS still advertised -- by the plugin, which owns the name. The jail drops the
    // repository's claim on it, it does not remove the command. Exactly one entry, and it is the
    // plugin's: an assertion that the name is absent would have been wrong about the fix.
    expect(resolver.list().filter((c) => c.name === "acme:ship")).toHaveLength(1);
    // Nor does the dropped file reappear under its bare stem.
    expect(await resolver.resolve("/ship", repo)).toEqual({ kind: "none" });
  });

  test("the colon jail is the ONLY restriction -- an ordinary stem is untouched whatever its case", async () => {
    const repo = mkTemp("winter-cmd-m2-ok-");
    writeCommand(repo, "Fix_Bug", "FIX IT");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, winterHome: mkTemp("winter-cmd-m2-ok-home-") });
    expect(await resolver.resolve("/Fix_Bug", repo)).toMatchObject({ kind: "expand", text: "FIX IT" });
  });
});
