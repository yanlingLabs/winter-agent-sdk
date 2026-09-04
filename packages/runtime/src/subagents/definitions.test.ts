import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, parseAgentDefinitionFile, loadAgentDefinitions, validateAgentDefinition } from "./definitions.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  test("no frontmatter delimiter -> the whole file is body, no attrs", () => {
    expect(parseFrontmatter("just a prompt, no frontmatter")).toEqual({ attrs: {}, body: "just a prompt, no frontmatter" });
  });

  test("a well-formed frontmatter block is parsed into flat key/value attrs", () => {
    const raw = ["---", "description: a helper", "model: sonnet", "---", "You are a helper."].join("\n");
    expect(parseFrontmatter(raw)).toEqual({ attrs: { description: "a helper", model: "sonnet" }, body: "You are a helper." });
  });

  test("quoted scalar values have their quotes stripped", () => {
    const raw = ["---", 'description: "a quoted helper"', "---", "body"].join("\n");
    expect(parseFrontmatter(raw).attrs["description"]).toBe("a quoted helper");
  });

  test("an unterminated frontmatter block (no closing ---) is treated as a whole-file body, never thrown", () => {
    const raw = ["---", "description: oops, no closer", "the rest of the file"].join("\n");
    const result = parseFrontmatter(raw);
    expect(result.attrs).toEqual({});
    expect(result.body).toBe(raw);
  });

  test("a line the minimal parser doesn't recognize is skipped, never guessed at", () => {
    const raw = ["---", "description: ok", "not a valid key line at all !!", "model: opus", "---", "body"].join("\n");
    expect(parseFrontmatter(raw).attrs).toEqual({ description: "ok", model: "opus" });
  });
});

describe("parseAgentDefinitionFile (WS-10 §2 field table)", () => {
  test("a full field set round-trips into the RuntimeAgentDefinition shape", () => {
    const raw = [
      "---",
      "description: reviews code",
      "tools: Read, Grep, Skill",
      "disallowedTools: Bash",
      "model: opus",
      "initialPrompt: start here",
      "maxTurns: 10",
      "background: true",
      "memory: project",
      "effort: high",
      "permissionMode: plan",
      "skills: linting, testing",
      "---",
      "You are a careful code reviewer.",
    ].join("\n");
    const def = parseAgentDefinitionFile(raw, "reviewer");
    expect(def).toEqual({
      description: "reviews code",
      prompt: "You are a careful code reviewer.",
      tools: ["Read", "Grep", "Skill"],
      disallowedTools: ["Bash"],
      model: "opus",
      initialPrompt: "start here",
      maxTurns: 10,
      background: true,
      memory: "project",
      effort: "high",
      permissionMode: "plan",
      skills: ["linting", "testing"],
    });
  });

  test("effort accepts the numeric form (0.3.251/0.3.252 declaration detail)", () => {
    const raw = ["---", "effort: 42", "---", "body text"].join("\n");
    expect(parseAgentDefinitionFile(raw, "x")?.effort).toBe(42);
  });

  test("description falls back to the filename when frontmatter omits it", () => {
    const raw = "no frontmatter at all, just a prompt body";
    expect(parseAgentDefinitionFile(raw, "my-agent")?.description).toBe("my-agent");
    expect(parseAgentDefinitionFile(raw, "my-agent")?.prompt).toBe(raw);
  });

  test("an empty body (no prompt at all) is not a usable definition", () => {
    const raw = ["---", "description: nothing to run", "---", "   "].join("\n");
    expect(parseAgentDefinitionFile(raw, "x")).toBeUndefined();
  });

  test("an invalid memory value is dropped rather than mis-typed through", () => {
    const raw = ["---", "memory: bogus", "---", "body"].join("\n");
    expect(parseAgentDefinitionFile(raw, "x")?.memory).toBeUndefined();
  });
});

describe("loadAgentDefinitions (RULING R4-7 trust gate + merge precedence)", () => {
  test("user-level (~/.winter/agents) loads unconditionally, even when the workspace is untrusted", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "helper.md"), "---\ndescription: a user helper\n---\nHelp out.");
    const cwd = mkTemp("winter-defs-cwd-");
    const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false });
    expect(defs.get("helper")?._source).toBe("user");
    expect(defs.get("helper")?.prompt).toBe("Help out.");
  });

  test("project-level (.winter/agents) is INVISIBLE when the workspace is untrusted", () => {
    const home = mkTemp("winter-defs-home-");
    const cwd = mkTemp("winter-defs-cwd-");
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "agents", "proj.md"), "---\ndescription: a project agent\n---\nDo project things.");
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: false }).has("proj")).toBe(false);
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: true }).has("proj")).toBe(true);
  });

  test("precedence: programmatic > project (trusted) > user, on a real name collision", () => {
    const home = mkTemp("winter-defs-home-");
    const cwd = mkTemp("winter-defs-cwd-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "shared.md"), "---\ndescription: from user\n---\nUser body.");
    writeFileSync(join(cwd, ".winter", "agents", "shared.md"), "---\ndescription: from project\n---\nProject body.");

    const projectWins = loadAgentDefinitions({ cwd, home, trustedWorkspace: true });
    expect(projectWins.get("shared")?._source).toBe("project");

    const programmaticWins = loadAgentDefinitions({
      cwd,
      home,
      trustedWorkspace: true,
      programmatic: { shared: { description: "from options", prompt: "Programmatic body." } },
    });
    expect(programmaticWins.get("shared")?._source).toBe("programmatic");
    expect(programmaticWins.get("shared")?.prompt).toBe("Programmatic body.");
  });

  test("a nonexistent directory on any source contributes zero definitions, never an error", () => {
    const home = join(mkTemp("winter-defs-home-"), "does-not-exist");
    const cwd = join(mkTemp("winter-defs-cwd-"), "does-not-exist-either");
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: true }).size).toBe(0);
  });

  test("a non-.md file in the agents directory is ignored", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "notes.txt"), "not an agent file");
    const cwd = mkTemp("winter-defs-cwd-");
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: false }).size).toBe(0);
  });
});

describe("validateAgentDefinition (WS-10 §2 Skill-tool requirement, validation only)", () => {
  test("skills set without Skill in tools produces a warning", () => {
    const warnings = validateAgentDefinition({ description: "d", prompt: "p", skills: ["a"], tools: ["Read"] });
    expect(warnings.length).toBe(1);
  });

  test("skills set WITH Skill in tools is clean", () => {
    expect(validateAgentDefinition({ description: "d", prompt: "p", skills: ["a"], tools: ["Read", "Skill"] })).toEqual([]);
  });

  test("no skills at all is clean regardless of tools", () => {
    expect(validateAgentDefinition({ description: "d", prompt: "p" })).toEqual([]);
  });

  test("skills set with tools entirely omitted (implicit 'all tools') still warns -- Skill must be explicit", () => {
    expect(validateAgentDefinition({ description: "d", prompt: "p", skills: ["a"] }).length).toBe(1);
  });
});
