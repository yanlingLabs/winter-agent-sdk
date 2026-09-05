// Phase 5 Lane S slice 5 (WS-11 §2.4, R5-14): the FILESYSTEM half of slash-command resolution.
//
// The spine owns the ordering above this file: the engine claims its own built-ins FIRST, and only
// an unclaimed `/name` ever reaches a resolver (commands/seam.ts). Nothing here produces the
// `builtin` arm.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillIndex } from "../skills/store.ts";
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

function writeSkill(root: string, name: string, description: string, body: string): void {
  const dir = join(root, ".winter", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`, "utf8");
}

describe("FilesystemCommandResolver: `.winter/commands/<name>.md` creates `/name`", () => {
  test("a project command expands to its body with a provenance source", async () => {
    const repo = mkTemp("winter-cmd-repo-");
    const path = writeCommand(repo, "review", "Please review the code.");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-cmd-home-") });
    expect(await resolver.resolve("/review", repo)).toEqual({ kind: "expand", text: "Please review the code.", source: path });
  });

  test("a prompt that is not a command, and an unknown `/name`, both resolve to `none`", async () => {
    const repo = mkTemp("winter-cmd-none-");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-cmd-none-home-") });
    expect(await resolver.resolve("just a prompt", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("/nothing-here", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("//not-a-command", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("/", repo)).toEqual({ kind: "none" });
  });

  test("this resolver NEVER produces the `builtin` arm -- a commands/compact.md is just a command", async () => {
    const repo = mkTemp("winter-cmd-compact-");
    writeCommand(repo, "compact", "not the real compact");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-cmd-compact-home-") });
    const result = await resolver.resolve("/compact", repo);
    expect(result.kind).toBe("expand");
  });

  test("frontmatter is stripped from the expanded text and feeds the listing instead", async () => {
    const repo = mkTemp("winter-cmd-fm-");
    writeCommand(repo, "deploy", "---\ndescription: ships it\nargument-hint: <env>\n---\n\nDeploy to $ARGUMENTS.");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-cmd-fm-home-") });
    const result = await resolver.resolve("/deploy staging", repo);
    expect(result).toEqual({ kind: "expand", text: "Deploy to staging.", source: join(repo, ".winter", "commands", "deploy.md") });
    expect(resolver.list().find((c) => c.name === "deploy")).toEqual({ name: "deploy", description: "ships it", argumentHint: "<env>", source: "project" });
  });
});

describe("FilesystemCommandResolver: `$ARGUMENTS` (the resolver's own job, R5-14)", () => {
  test("every occurrence is substituted, and `expand.text` is FULLY expanded", async () => {
    const repo = mkTemp("winter-args-");
    writeCommand(repo, "echo", "one $ARGUMENTS two $ARGUMENTS");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-args-home-") });
    const result = await resolver.resolve("/echo hello world", repo);
    expect(result).toMatchObject({ kind: "expand", text: "one hello world two hello world" });
  });

  test("no arguments substitutes the EMPTY string -- the model never sees the literal `$ARGUMENTS`", async () => {
    const repo = mkTemp("winter-args2-");
    writeCommand(repo, "bare", "before[$ARGUMENTS]after");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-args2-home-") });
    expect(await resolver.resolve("/bare", repo)).toMatchObject({ text: "before[]after" });
  });

  test("arguments are taken verbatim after the first whitespace run, inner spacing preserved", async () => {
    const repo = mkTemp("winter-args3-");
    writeCommand(repo, "x", "<$ARGUMENTS>");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home: mkTemp("winter-args3-home-") });
    expect(await resolver.resolve("/x  a  b  ", repo)).toMatchObject({ text: "<a  b>" });
  });
});

describe("FilesystemCommandResolver: tiers, the parent-walk and source gating", () => {
  test("a NEARER project command shadows one further up, and the user tier is the fallback", async () => {
    const repo = mkTemp("winter-cmd-tiers-");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    const home = mkTemp("winter-cmd-tiers-home-");
    writeCommand(repo, "shared", "root command");
    writeCommand(sub, "shared", "near command");
    writeCommand(join(home, ".winter", ".."), "useronly", "user command"); // -> <home>/.winter/commands/useronly.md
    const resolver = FilesystemCommandResolver.build({ cwd: sub, home });
    expect(await resolver.resolve("/shared", sub)).toMatchObject({ text: "near command" });
    expect(await resolver.resolve("/useronly", sub)).toMatchObject({ text: "user command" });
  });

  test("project commands are SOURCE-gated and user commands are gated on `user`", async () => {
    const repo = mkTemp("winter-cmd-gate-");
    const home = mkTemp("winter-cmd-gate-home-");
    writeCommand(repo, "proj", "p");
    writeCommand(join(home, ".winter", ".."), "usr", "u");
    expect(await FilesystemCommandResolver.build({ cwd: repo, home, settingSources: ["user"] }).resolve("/proj", repo)).toEqual({ kind: "none" });
    expect(await FilesystemCommandResolver.build({ cwd: repo, home, settingSources: ["project"] }).resolve("/usr", repo)).toEqual({ kind: "none" });
    expect(await FilesystemCommandResolver.build({ cwd: repo, home, settingSources: [] }).resolve("/proj", repo)).toEqual({ kind: "none" });
  });

  test("a plugin command answers to its qualified `/plugin:name`", async () => {
    const repo = mkTemp("winter-cmd-plugin-");
    const pluginRoot = mkTemp("winter-cmd-plugindir-");
    const path = join(pluginRoot, "commands", "ship.md");
    mkdirSync(join(pluginRoot, "commands"), { recursive: true });
    writeFileSync(path, "Ship $ARGUMENTS", "utf8");
    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      home: mkTemp("winter-cmd-plugin-home-"),
      plugins: [{ plugin: "acme", commands: [{ name: "ship", path }] }],
    });
    expect(await resolver.resolve("/acme:ship now", repo)).toMatchObject({ kind: "expand", text: "Ship now" });
    expect(await resolver.resolve("/ship", repo)).toEqual({ kind: "none" });
  });
});

describe("FilesystemCommandResolver: skills also create `/name` (WS-11 §2.4)", () => {
  test("a skill with no command file of the same name is invocable as `/name`", async () => {
    const repo = mkTemp("winter-cmdskill-");
    const home = mkTemp("winter-cmdskill-home-");
    writeSkill(repo, "audit", "audits things", "AUDIT BODY for $ARGUMENTS");
    const index = SkillIndex.build({ cwd: repo, home });
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home, skills: index });
    expect(await resolver.resolve("/audit everything", repo)).toMatchObject({ kind: "expand", text: "AUDIT BODY for everything" });
  });

  test("OVERLAP: a SKILL wins over a command file of the same name, and the source says which", async () => {
    const repo = mkTemp("winter-overlap-");
    const home = mkTemp("winter-overlap-home-");
    writeSkill(repo, "review", "d", "SKILL WINS");
    writeCommand(repo, "review", "COMMAND LOSES");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home, skills: SkillIndex.build({ cwd: repo, home }) });
    const result = await resolver.resolve("/review", repo);
    expect(result).toMatchObject({ kind: "expand", text: "SKILL WINS" });
    expect(result.kind === "expand" && result.source).toContain("SKILL.md");
  });

  test('a skill marked "off" by skillOverrides is not reachable as `/name`, but "user-invocable-only" IS', async () => {
    const repo = mkTemp("winter-overr-");
    const home = mkTemp("winter-overr-home-");
    writeSkill(repo, "hidden", "d", "HIDDEN BODY");
    writeSkill(repo, "manual", "d", "MANUAL BODY");
    const resolver = FilesystemCommandResolver.build({
      cwd: repo,
      home,
      skills: SkillIndex.build({ cwd: repo, home }),
      skillOverrides: { hidden: "off", manual: "user-invocable-only" },
    });
    expect(await resolver.resolve("/hidden", repo)).toEqual({ kind: "none" });
    expect(await resolver.resolve("/manual", repo)).toMatchObject({ text: "MANUAL BODY" });
  });
});

describe("the slash-command listing (`system/init.slash_commands`)", () => {
  test("the engine's built-ins are listed and `/compact` is the only one R5-14 ships", () => {
    expect(BUILTIN_SLASH_COMMANDS.map((c) => c.name)).toEqual(["compact"]);
  });

  test("built-ins come first, then commands, then skills -- names only, deduplicated", () => {
    const repo = mkTemp("winter-listing-");
    const home = mkTemp("winter-listing-home-");
    writeCommand(repo, "review", "c");
    writeSkill(repo, "review", "d", "s");
    writeSkill(repo, "audit", "d", "s");
    const resolver = FilesystemCommandResolver.build({ cwd: repo, home, skills: SkillIndex.build({ cwd: repo, home }) });
    expect(slashCommandNames(resolver)).toEqual(["compact", "review", "audit"]);
    expect(buildSlashCommandListing(resolver).find((c) => c.name === "audit")).toEqual({ name: "audit", description: "d", source: "skill" });
  });

  test("with no resolver at all the listing is exactly the built-ins", () => {
    expect(slashCommandNames()).toEqual(["compact"]);
  });
});
