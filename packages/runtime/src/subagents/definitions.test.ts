import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  parseAgentDefinitionFile,
  loadAgentDefinitions,
  validateAgentDefinition,
  findAgentByType,
  formatAgentNotFound,
  formatAgentAmbiguous,
  type AgentDefinitionRejection,
  type SourcedAgentDefinition,
} from "./definitions.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Every `loadAgentDefinitions` call below that cares about an EXACT set/size passes `builtinAgents:
// {}` -- otherwise the default-on `general-purpose`/`Explore`/`Plan`/`claude` built-ins (R-S1) would
// leak into every `.size`/`.has(...)` assertion this file predates. Tests that specifically exercise
// the builtin tier opt back in explicitly.
const NO_BUILTINS = { builtinAgents: {} };

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

describe("parseAgentDefinitionFile (spawn-surface parity: name+description required, research §A1)", () => {
  test("a full field set round-trips into {ok, name, definition}", () => {
    const raw = [
      "---",
      "name: reviewer",
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
      "isolation: worktree",
      "color: purple",
      "---",
      "You are a careful code reviewer.",
    ].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "/agents/reviewer.md");
    expect(parsed).toEqual({
      ok: true,
      name: "reviewer",
      definition: {
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
        isolation: "worktree",
        color: "purple",
      },
    });
  });

  test("effort accepts the numeric form (0.3.251/0.3.252 declaration detail)", () => {
    const raw = ["---", "name: x", "description: d", "effort: 42", "---", "body text"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.effort).toBe(42);
  });

  test("a missing name is REJECTED, not filename-fallback keyed (deliberate break from the pre-parity contract)", () => {
    const raw = "---\ndescription: no name here\n---\nbody";
    const parsed = parseAgentDefinitionFile(raw, "/agents/my-agent.md");
    expect(parsed).toEqual({ ok: false, filePath: "/agents/my-agent.md", reason: 'missing required frontmatter field "name"' });
  });

  test("a name starting with '-' is rejected", () => {
    const parsed = parseAgentDefinitionFile("---\nname: -bad\ndescription: d\n---\nbody", "f.md");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('invalid agent name "-bad"');
  });

  test("a name containing ':' is rejected", () => {
    const parsed = parseAgentDefinitionFile("---\nname: ns:agent\ndescription: d\n---\nbody", "f.md");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('invalid agent name "ns:agent"');
  });

  test("a missing description is REJECTED -- no filename fallback of any kind", () => {
    const raw = "---\nname: my-agent\n---\nbody";
    const parsed = parseAgentDefinitionFile(raw, "/agents/my-agent.md");
    expect(parsed).toEqual({ ok: false, filePath: "/agents/my-agent.md", reason: 'missing required frontmatter field "description"' });
  });

  test("an empty body (no prompt at all) is REJECTED before name/description are even checked", () => {
    const raw = ["---", "name: x", "description: nothing to run", "---", "   "].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok).toBe(false);
  });

  test("an invalid memory value is dropped rather than mis-typed through", () => {
    const raw = ["---", "name: x", "description: d", "memory: bogus", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.memory).toBeUndefined();
  });

  test("an unrecognised isolation value is dropped, never mis-typed through", () => {
    const raw = ["---", "name: x", "description: d", "isolation: docker", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.isolation).toBeUndefined();
  });
});

describe("loadAgentDefinitions (RULING R4-7 trust gate + merge precedence, builtins excluded via NO_BUILTINS)", () => {
  test("user-level (~/.winter/agents) loads unconditionally, even when the workspace is untrusted", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "helper.md"), "---\nname: helper\ndescription: a user helper\n---\nHelp out.");
    const cwd = mkTemp("winter-defs-cwd-");
    const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, ...NO_BUILTINS });
    expect(defs.get("helper")?._source).toBe("user");
    expect(defs.get("helper")?.prompt).toBe("Help out.");
  });

  test("a file's frontmatter `name` is the map key, independent of its filename", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "totally-different-filename.md"), "---\nname: real-name\ndescription: d\n---\nBody.");
    const cwd = mkTemp("winter-defs-cwd-");
    const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, ...NO_BUILTINS });
    expect(defs.has("real-name")).toBe(true);
    expect(defs.has("totally-different-filename")).toBe(false);
  });

  test("a file with no frontmatter `name` is skipped and reported through onReject, never crashes the scan", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "nameless.md"), "---\ndescription: no name\n---\nBody.");
    writeFileSync(join(home, ".winter", "agents", "good.md"), "---\nname: good\ndescription: d\n---\nBody.");
    const cwd = mkTemp("winter-defs-cwd-");
    const rejections: AgentDefinitionRejection[] = [];
    const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, onReject: (r) => rejections.push(r), ...NO_BUILTINS });
    expect(defs.size).toBe(1);
    expect(defs.has("good")).toBe(true);
    expect(rejections).toEqual([{ source: "user", filePath: join(home, ".winter", "agents", "nameless.md"), reason: 'missing required frontmatter field "name"' }]);
  });

  test("project-level (.winter/agents) is INVISIBLE when the workspace is untrusted", () => {
    const home = mkTemp("winter-defs-home-");
    const cwd = mkTemp("winter-defs-cwd-");
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "agents", "proj.md"), "---\nname: proj\ndescription: a project agent\n---\nDo project things.");
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: false, ...NO_BUILTINS }).has("proj")).toBe(false);
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: true, ...NO_BUILTINS }).has("proj")).toBe(true);
  });

  test("precedence: programmatic > project (trusted) > user, on a real name collision", () => {
    const home = mkTemp("winter-defs-home-");
    const cwd = mkTemp("winter-defs-cwd-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    mkdirSync(join(cwd, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "shared.md"), "---\nname: shared\ndescription: from user\n---\nUser body.");
    writeFileSync(join(cwd, ".winter", "agents", "shared.md"), "---\nname: shared\ndescription: from project\n---\nProject body.");

    const projectWins = loadAgentDefinitions({ cwd, home, trustedWorkspace: true, ...NO_BUILTINS });
    expect(projectWins.get("shared")?._source).toBe("project");

    const programmaticWins = loadAgentDefinitions({
      cwd,
      home,
      trustedWorkspace: true,
      programmatic: { shared: { description: "from options", prompt: "Programmatic body." } },
      ...NO_BUILTINS,
    });
    expect(programmaticWins.get("shared")?._source).toBe("programmatic");
    expect(programmaticWins.get("shared")?.prompt).toBe("Programmatic body.");
  });

  test("a nonexistent directory on any source contributes zero definitions, never an error", () => {
    const home = join(mkTemp("winter-defs-home-"), "does-not-exist");
    const cwd = join(mkTemp("winter-defs-cwd-"), "does-not-exist-either");
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: true, ...NO_BUILTINS }).size).toBe(0);
  });

  test("a non-.md file in the agents directory is ignored", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "notes.txt"), "not an agent file");
    const cwd = mkTemp("winter-defs-cwd-");
    expect(loadAgentDefinitions({ cwd, home, trustedWorkspace: false, ...NO_BUILTINS }).size).toBe(0);
  });

  test("builtins are the LOWEST precedence tier (R-S1): a same-named user file overrides Winter's own Explore", () => {
    const home = mkTemp("winter-defs-home-");
    mkdirSync(join(home, ".winter", "agents"), { recursive: true });
    writeFileSync(join(home, ".winter", "agents", "explore.md"), "---\nname: Explore\ndescription: my own explorer\n---\nCustom body.");
    const cwd = mkTemp("winter-defs-cwd-");
    const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, env: {} });
    expect(defs.get("Explore")?._source).toBe("user");
    expect(defs.get("Explore")?.prompt).toBe("Custom body.");
  });

  test("with no override, the built-in tier supplies general-purpose/Explore/Plan/claude by default", () => {
    const home = join(mkTemp("winter-defs-home-"), "does-not-exist");
    const cwd = join(mkTemp("winter-defs-cwd-"), "does-not-exist-either");
    const defs = loadAgentDefinitions({ cwd, home, trustedWorkspace: false, env: {} });
    expect([...defs.keys()].sort()).toEqual(["Explore", "Plan", "claude", "general-purpose"]);
    expect(defs.get("Explore")?._source).toBe("builtin");
  });

  test("a plugin agent overrides a built-in of the same name, and is itself overridden by a user file", () => {
    const home = join(mkTemp("winter-defs-home-"), "does-not-exist");
    const cwd = join(mkTemp("winter-defs-cwd-"), "does-not-exist-either");
    const pluginOnly = loadAgentDefinitions({
      cwd,
      home,
      trustedWorkspace: false,
      env: {},
      pluginAgents: { "general-purpose": { description: "plugin's own", prompt: "p", plugin: "acme" } },
    });
    expect(pluginOnly.get("general-purpose")?._source).toBe("plugin");
  });
});

describe("findAgentByType (research §A4 normalization)", () => {
  function defsOf(names: string[]): Map<string, SourcedAgentDefinition> {
    const m = new Map<string, SourcedAgentDefinition>();
    for (const n of names) m.set(n, { description: "d", prompt: "p", _source: "builtin" });
    return m;
  }

  test("an exact match always wins outright", () => {
    const result = findAgentByType(defsOf(["Explore", "general-purpose"]), "Explore");
    expect(result).toEqual({ kind: "found", name: "Explore", definition: { description: "d", prompt: "p", _source: "builtin" } });
  });

  test("'explore' (lowercase) normalizes onto 'Explore'", () => {
    expect(findAgentByType(defsOf(["Explore"]), "explore").kind).toBe("found");
  });

  test("'general purpose' (space) and 'general-purpose' both normalize onto the same key", () => {
    expect(findAgentByType(defsOf(["general-purpose"]), "general purpose").kind).toBe("found");
    expect(findAgentByType(defsOf(["general-purpose"]), "general_purpose").kind).toBe("found");
  });

  test("'general' and 'explorer' do NOT match -- they normalize to a different string entirely", () => {
    expect(findAgentByType(defsOf(["general-purpose"]), "general").kind).toBe("not-found");
    expect(findAgentByType(defsOf(["Explore"]), "explorer").kind).toBe("not-found");
  });

  test("an empty definitions map is a clean not-found, never a throw", () => {
    expect(findAgentByType(new Map(), "anything").kind).toBe("not-found");
  });

  test("two keys normalizing to the same target are reported ambiguous, sorted", () => {
    const result = findAgentByType(defsOf(["my_agent", "my-agent"]), "myagent");
    expect(result).toEqual({ kind: "ambiguous", matches: ["my-agent", "my_agent"] });
  });
});

describe("formatAgentNotFound / formatAgentAmbiguous (research §A4 wording)", () => {
  test("lists available agents, sorted, comma-joined", () => {
    expect(formatAgentNotFound("explorer", ["Plan", "Explore", "claude"])).toBe("Agent type 'explorer' not found. Available agents: Explore, Plan, claude");
  });

  test("says 'none' when the session has zero agents", () => {
    expect(formatAgentNotFound("anything", [])).toBe("Agent type 'anything' not found. Available agents: none");
  });

  test("ambiguous wording names both matches and the exact-name instruction", () => {
    expect(formatAgentAmbiguous("myagent", ["my_agent", "my-agent"])).toBe("Agent type 'myagent' is ambiguous — matches my-agent, my_agent. Use the exact name: my-agent or my_agent.");
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
