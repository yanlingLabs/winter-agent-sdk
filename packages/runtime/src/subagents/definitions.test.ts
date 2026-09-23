import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentDefinitionRejectionReporter,
  parseFrontmatter,
  parseAgentDefinitionFile,
  loadAgentDefinitions,
  validateAgentDefinition,
  findAgentByType,
  formatAgentNotFound,
  formatAgentAmbiguous,
  toAgentInfoList,
  allowedAgentTypesFromTools,
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

  test("an unterminated frontmatter block (no closing --- anywhere) is treated as a whole-file body, never thrown", () => {
    const raw = ["---", "description: oops, no closer", "the rest of the file"].join("\n");
    const result = parseFrontmatter(raw);
    expect(result.attrs).toEqual({});
    expect(result.body).toBe(raw);
  });

  // WS-21 §6.3 item 2 (fix-round-2): parseFrontmatter now matches claude's own pinned split
  // (FRONTMATTER_REGEX + Bun.YAML.parse + the quoteProblematicValues retry, ported verbatim from
  // claude-code-reference @ 6f6f12b's src/utils/frontmatterParser.ts) instead of a hand-rolled
  // line-by-line key:value scanner. The hand-rolled parser's old "a line it doesn't recognize is
  // skipped" leniency is GONE: a malformed frontmatter BLOCK (invalid YAML throughout) now loses the
  // whole block, matching what claude's own two-attempt parse/retry does with the same input --
  // never a partial, guessed-at result.
  test("a malformed frontmatter block (invalid YAML) loses the whole block -- no per-line leniency", () => {
    const raw = ["---", "description: ok", "not a valid key line at all !!", "model: opus", "---", "body"].join("\n");
    expect(parseFrontmatter(raw).attrs).toEqual({});
  });

  test("the closing fence need not be on its own line -- claude's regex is lazy, not line-based", () => {
    const result = parseFrontmatter("---\nname: x\n---body");
    expect(result.attrs).toEqual({ name: "x" });
    expect(result.body).toBe("body");
  });

  test("a YAML block scalar (|) is a real multi-line value, not the literal pipe character", () => {
    const raw = "---\ndescription: |\n  multi\n  line\n---\nbody";
    expect(parseFrontmatter(raw).attrs["description"]).toBe("multi\nline\n");
  });

  test("a trailing # comment on a scalar line is stripped by real YAML, not kept as text", () => {
    const raw = "---\nname: foo # comment\n---\nbody";
    expect(parseFrontmatter(raw).attrs["name"]).toBe("foo");
  });

  test("a YAML-typed value stays typed (number/boolean), never coerced to a string", () => {
    expect(parseFrontmatter("---\nname: 123\n---\nbody").attrs["name"]).toBe(123);
    expect(parseFrontmatter("---\ndescription: true\n---\nbody").attrs["description"]).toBe(true);
  });

  test("an empty scalar (`model:` with nothing after) is YAML null, not an empty string", () => {
    const raw = "---\nname: x\ndescription: d\nmodel:\n---\nbody";
    expect(parseFrontmatter(raw).attrs["model"]).toBeNull();
  });

  test("a bare colon-space mid-value (invalid on the first YAML pass) survives via the quoting retry, claude parity", () => {
    const raw = "---\nname: x\ndescription: Use when: foo\n---\nbody";
    expect(parseFrontmatter(raw).attrs["description"]).toBe("Use when: foo");
  });

  test("an inline YAML list parses as a real array", () => {
    const raw = "---\nname: x\ndescription: d\ntools: [Read, Grep]\n---\nbody";
    expect(parseFrontmatter(raw).attrs["tools"]).toEqual(["Read", "Grep"]);
  });

  // WS-21 §6.3 item 2 (fix-round-2): a BOM survives whatever the read gave `parseFrontmatter` --
  // nothing in this function strips one, single or double, matching claude's own reference (which
  // has no BOM-strip step in its agent-loading path either: `^---` anchors to the TRUE string start,
  // so ANY leading BOM defeats the fence, exactly as any other leading character would). Measured
  // empirically through `readFileSync(path, "utf8")` before writing this test: neither Bun nor Node
  // strips a BOM on a plain utf8 read, so single- and double-BOM behave identically here -- there is
  // no leniency to add, and none to remove.
  test("a leading BOM (single or double) defeats the frontmatter fence -- no frontmatter is found, matching claude", () => {
    const singleBom = "﻿---\nname: x\n---\nbody";
    const doubleBom = "﻿﻿---\nname: x\n---\nbody";
    expect(parseFrontmatter(singleBom)).toEqual({ attrs: {}, body: singleBom });
    expect(parseFrontmatter(doubleBom)).toEqual({ attrs: {}, body: doubleBom });
  });
});

// WS-21 §6.3 item 2 (fix-round-2): a differential harness against claude's own reference parser,
// ported into this test file rather than trusted from memory -- `claudeReference` below is
// FRONTMATTER_REGEX + Bun.YAML.parse + quoteProblematicValues, verbatim from
// claude-code-reference @ 6f6f12b's src/utils/frontmatterParser.ts (the pin this repo's other
// pinned-reference citations use, e.g. context/imports.ts's own header). For every shape, Winter's
// `parseFrontmatter` must find the SAME keys claude would -- the coordinator's own stated bar.
function claudeReference(raw: string): { attrs: Record<string, unknown>; body: string } {
  const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)---\s*\n?/;
  const YAML_SPECIAL_CHARS = /[{}[\]*&#!|>%@`]|: /;
  const quoteProblematicValues = (text: string): string =>
    text
      .split("\n")
      .map((line) => {
        const m = /^([a-zA-Z_-]+):\s+(.+)$/.exec(line);
        if (!m) return line;
        const key = m[1]!;
        const value = m[2]!;
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return line;
        if (YAML_SPECIAL_CHARS.test(value)) return `${key}: "${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        return line;
      })
      .join("\n");
  const match = FRONTMATTER_REGEX.exec(raw);
  if (!match) return { attrs: {}, body: raw };
  const frontmatterText = match[1] ?? "";
  const body = raw.slice(match[0].length);
  let attrs: Record<string, unknown> = {};
  try {
    const parsed = Bun.YAML.parse(frontmatterText) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) attrs = parsed as Record<string, unknown>;
  } catch {
    try {
      const parsed = Bun.YAML.parse(quoteProblematicValues(frontmatterText)) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) attrs = parsed as Record<string, unknown>;
    } catch {
      /* both attempts failed -- attrs stays {}, matching the reference's own silent degrade */
    }
  }
  return { attrs, body };
}

describe("parseFrontmatter vs. claude's own reference parser (differential, WS-21 §6.3 item 2)", () => {
  const shapes: { label: string; raw: string }[] = [
    { label: "plain", raw: ["---", "name: x", "description: d", "---", "body"].join("\n") },
    { label: "CRLF", raw: "---\r\nname: x\r\ndescription: d\r\n---\r\nbody" },
    { label: "no frontmatter", raw: "just a prompt" },
    { label: "unterminated (no closing --- anywhere)", raw: "---\nname: x\nthe rest" },
    { label: "closing not on its own line", raw: "---\nname: x\n---body" },
    { label: "block scalar", raw: "---\ndescription: |\n  multi\n  line\n---\nbody" },
    { label: "trailing comment", raw: "---\nname: foo # comment\n---\nbody" },
    { label: "typed number", raw: "---\nname: 123\n---\nbody" },
    { label: "typed boolean", raw: "---\ndescription: true\n---\nbody" },
    { label: "empty scalar", raw: "---\nname: x\nmodel:\n---\nbody" },
    { label: "mid-value colon", raw: "---\nname: x\ndescription: Use when: foo\n---\nbody" },
    { label: "inline list", raw: "---\nname: x\ntools: [Read, Grep]\n---\nbody" },
    { label: "malformed block", raw: "---\nname: x\nnot valid !!\n---\nbody" },
  ];
  for (const { label, raw } of shapes) {
    test(`${label}: same keys as claude`, () => {
      const winter = parseFrontmatter(raw);
      const claude = claudeReference(raw);
      expect(Object.keys(winter.attrs).sort()).toEqual(Object.keys(claude.attrs).sort());
      expect(winter.attrs).toEqual(claude.attrs);
      expect(winter.body).toBe(claude.body);
    });
  }

  test("single and double BOM: same keys as claude (both empty -- neither strips a BOM)", () => {
    for (const raw of ["﻿---\nname: x\n---\nbody", "﻿﻿---\nname: x\n---\nbody"]) {
      const winter = parseFrontmatter(raw);
      const claude = claudeReference(raw);
      expect(Object.keys(winter.attrs)).toEqual(Object.keys(claude.attrs));
      expect(winter.body).toBe(claude.body);
    }
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

  // WS-21 §6.3 item 2 (fix-round-2): claude parity for TYPE, not just presence -- `name`/`description`
  // must be YAML STRINGS. A YAML-typed `name: 123` (a real number, not a quoted "123") is claude's
  // own rejection shape (`typeof agentType !== 'string'`), and Winter's frontmatter no longer forces
  // every scalar through a string coercion the way the old hand-rolled line parser did.
  test("a non-string name (real YAML number, unquoted) is rejected, not stringified", () => {
    const raw = ["---", "name: 123", "description: d", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('missing required frontmatter field "name"');
  });

  test("a non-string description (real YAML boolean, unquoted) is rejected, not stringified", () => {
    const raw = ["---", "name: x", "description: true", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.reason).toContain('missing required frontmatter field "description"');
  });

  test("an empty scalar field (model: with nothing after) is YAML null, so the field is simply absent -- never an empty string", () => {
    const raw = ["---", "name: x", "description: d", "model:", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.model).toBeUndefined();
  });

  test("a background value survives as a real YAML boolean (unquoted true), not only its quoted string form", () => {
    const raw = ["---", "name: x", "description: d", "background: true", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.background).toBe(true);
  });

  test("an inline YAML list (tools: [Read, Grep]) parses identically to the comma-string form", () => {
    const raw = ["---", "name: x", "description: d", "tools: [Read, Grep]", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.tools).toEqual(["Read", "Grep"]);
  });

  test("a description containing a bare mid-value colon (Use when: foo) survives via the quoting retry", () => {
    const raw = ["---", "name: x", "description: Use when: foo", "---", "body"].join("\n");
    const parsed = parseAgentDefinitionFile(raw, "x.md");
    expect(parsed.ok && parsed.definition.description).toBe("Use when: foo");
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

// Review r2 finding 2 (whole-branch): `onReject` used to have no production caller at all -- this is
// the reporter every production call site now shares.
describe("createAgentDefinitionRejectionReporter (review r2 finding 2)", () => {
  function capturingWriter(): { write: (line: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { write: (line) => lines.push(line), lines };
  }

  test("writes one line naming the file and the reason, with the fix suggestion", () => {
    const { write, lines } = capturingWriter();
    const report = createAgentDefinitionRejectionReporter(write);
    report({ source: "user", filePath: "/home/.winter/agents/broken.md", reason: 'missing required frontmatter field "name"' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/home/.winter/agents/broken.md");
    expect(lines[0]).toContain('missing required frontmatter field "name"');
    expect(lines[0]).toContain('add "name:" and "description:" frontmatter');
  });

  test("a repeated rejection of the SAME file path is reported only ONCE", () => {
    const { write, lines } = capturingWriter();
    const report = createAgentDefinitionRejectionReporter(write);
    const rejection: AgentDefinitionRejection = { source: "project", filePath: "/proj/.winter/agents/x.md", reason: 'missing required frontmatter field "description"' };
    report(rejection);
    report(rejection);
    report(rejection);
    expect(lines).toHaveLength(1);
  });

  test("DIFFERENT file paths each get their own line", () => {
    const { write, lines } = capturingWriter();
    const report = createAgentDefinitionRejectionReporter(write);
    report({ source: "user", filePath: "/a.md", reason: "r1" });
    report({ source: "user", filePath: "/b.md", reason: "r2" });
    expect(lines).toHaveLength(2);
  });

  test("a throwing writer never propagates -- a closed stderr must not crash agent-definition loading", () => {
    const report = createAgentDefinitionRejectionReporter(() => {
      throw new Error("EPIPE");
    });
    expect(() => report({ source: "plugin", filePath: "/p.md", reason: "r" })).not.toThrow();
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

describe("toAgentInfoList (Query.supportedAgents()'s own shape, research §A3)", () => {
  function defsOf(entries: Record<string, { description: string; model?: string }>): Map<string, SourcedAgentDefinition> {
    const m = new Map<string, SourcedAgentDefinition>();
    for (const [name, e] of Object.entries(entries)) m.set(name, { description: e.description, prompt: "p", ...(e.model !== undefined ? { model: e.model } : {}), _source: "builtin" });
    return m;
  }

  test("maps name/description/model, sorted by name", () => {
    const list = toAgentInfoList(defsOf({ Explore: { description: "d1", model: "opus" }, claude: { description: "d2" } }));
    expect(list).toEqual([
      { name: "claude", description: "d2" },
      { name: "Explore", description: "d1", model: "opus" },
    ]);
  });

  test('model: "inherit" is OMITTED, never passed through as the literal string', () => {
    const list = toAgentInfoList(defsOf({ Explore: { description: "d", model: "inherit" } }));
    expect(list[0]).toEqual({ name: "Explore", description: "d" });
    expect(list[0]).not.toHaveProperty("model");
  });

  test("an empty map yields an empty array", () => {
    expect(toAgentInfoList(new Map())).toEqual([]);
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

describe("allowedAgentTypesFromTools (SDK 0.0.16 Lane P, R3b §4)", () => {
  test("undefined tools -> unrestricted", () => {
    expect(allowedAgentTypesFromTools(undefined)).toBeUndefined();
  });

  test("no Agent(...) entry at all -> unrestricted, whether wildcard or an explicit ordinary list", () => {
    expect(allowedAgentTypesFromTools(["*"])).toBeUndefined();
    expect(allowedAgentTypesFromTools(["Bash", "Read"])).toBeUndefined();
  });

  test('tools: ["*", "Agent(Explore, Plan)"] restricts to [Explore, Plan] -- every other tool entry is untouched by this function', () => {
    expect(allowedAgentTypesFromTools(["*", "Agent(Explore, Plan)"])).toEqual(["Explore", "Plan"]);
  });

  test("a single-name Agent(a) entry restricts to just that one name", () => {
    expect(allowedAgentTypesFromTools(["Bash", "Agent(general-purpose)"])).toEqual(["general-purpose"]);
  });

  test("whitespace around each comma-separated name is trimmed", () => {
    expect(allowedAgentTypesFromTools(["Agent( Explore ,  Plan )"])).toEqual(["Explore", "Plan"]);
  });

  test("several Agent(...) entries union their names", () => {
    expect(allowedAgentTypesFromTools(["Agent(Explore)", "Agent(Plan)"])).toEqual(["Explore", "Plan"]);
  });

  test("fork is an ordinary name like any other", () => {
    expect(allowedAgentTypesFromTools(["*", "Agent(fork)"])).toEqual(["fork"]);
  });
});
