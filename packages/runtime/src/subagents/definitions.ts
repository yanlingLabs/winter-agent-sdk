// WS-10 §2 / RULING R4-7: AgentDefinition sourcing -- programmatic (Options.agents, already
// wire-plumbed to RuntimeConfig.agents by T2) + filesystem (`<projectDir>/agents/*.md`,
// `~/.winter/agents/*.md`) MUST coexist.
//
// Precedence among sources is a documented JUDGMENT CALL -- WS-10 §2 requires coexistence but does
// not pin an order for a NAME COLLISION across sources: programmatic > project-local
// (a project `agents/`, trust-gated) > user-level (the winter home's `agents/`) -- most-specific/most-explicit
// wins, matching this whole spec family's general posture elsewhere (WS-10 §3.1's own model chain is
// "most specific invocation-time value wins"; engine.ts's own buildChildInheritance prefers a
// definition's own restriction over the session's ambient one).
//
// Plugin agents: WS-10 §2's own "plugin agents" clause was a P5 seam at P4 -- Phase 5 Task 2 lands
// the PARAMETER (the carry R4-7 named), at the BOTTOM of the precedence chain. Lane S owns the
// producer: nothing under packages/runtime/src reads a Winter plugin manifest yet, so `pluginAgents`
// arrives pre-parsed from whoever loaded the plugin bundle, exactly the way `programmatic` arrives
// pre-parsed from the wire.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { WINTER_BRAND, type BrandProfile, type RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";

export type AgentDefinitionSource = "programmatic" | "project" | "user" | "plugin";

export interface SourcedAgentDefinition extends RuntimeAgentDefinition {
  readonly _source: AgentDefinitionSource;
  /** Which plugin contributed this definition. Present iff `_source === "plugin"`. */
  readonly _plugin?: string;
}

/**
 * One plugin-contributed definition: a plain `RuntimeAgentDefinition` plus the CONTRIBUTING PLUGIN's
 * name, which the loader lifts off into `_plugin` rather than leaving it on the definition (a
 * `RuntimeAgentDefinition` is a wire shape; `plugin` is not one of its fields, and a stray extra key
 * riding along into a child's config is the kind of thing that reads as a typo forever).
 */
export type PluginAgentDefinition = RuntimeAgentDefinition & { plugin: string };

// --- Filesystem loading: a minimal, deliberately small frontmatter parser -------------------------
//
// No YAML dependency exists anywhere in this workspace (verified: no package.json in this monorepo
// declares one) -- adding one is a NEW DEPENDENCY (R4-10: "New dependency = NEEDS_CONTEXT"), so this
// parses ONLY the flat `key: value` shape a hand-authored agent file actually needs (WS-10 §2's own
// field table: description/tools/disallowedTools/model/skills/initialPrompt/maxTurns/background/
// memory/effort/permissionMode -- every one of them either a bare scalar or a comma-separated list,
// never nested YAML). A frontmatter line this minimal parser doesn't recognize is SKIPPED, never
// guessed at -- a disclosed MVP scope limit, not a silent mis-parse.
export interface FrontmatterResult {
  attrs: Record<string, string>;
  body: string;
}

const FRONTMATTER_DELIM = /^---\s*$/;

export function parseFrontmatter(raw: string): FrontmatterResult {
  const lines = raw.split(/\r\n|\n/);
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0] ?? "")) {
    return { attrs: {}, body: raw };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end === -1) return { attrs: {}, body: raw }; // unterminated frontmatter -- treat the whole file as body, never throw
  const attrs: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2] ?? "";
    attrs[key] = value.trim().replace(/^["']|["']$/g, "");
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  return { attrs, body };
}

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  // Accepts a bracketed `[a, b]` inline-YAML-ish form or a bare comma list -- both reduce to the
  // same split, matching this parser's own "flat scalars/lists only" scope.
  const stripped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  const items = stripped
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function isMemoryValue(v: string | undefined): v is "user" | "project" | "local" {
  return v === "user" || v === "project" || v === "local";
}

function toEffortValue(raw: string): NonNullable<RuntimeAgentDefinition["effort"]> {
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed as NonNullable<RuntimeAgentDefinition["effort"]>;
}

// Builds a RuntimeAgentDefinition from one `.md` file's frontmatter + body (`prompt` = the body,
// WS-10 §2's own "prompt: system prompt of the child" -- frontmatter never carries `prompt` itself,
// since the body IS the prompt, matching Claude Code's own subagent-file convention this project's
// own CLAUDE.md names as the tracked shape).
export function parseAgentDefinitionFile(raw: string, fileNameForDescriptionFallback: string): RuntimeAgentDefinition | undefined {
  const { attrs, body } = parseFrontmatter(raw);
  if (body.trim().length === 0) return undefined; // no prompt at all -- not a usable definition
  const description = attrs["description"] ?? fileNameForDescriptionFallback;
  const tools = splitList(attrs["tools"]);
  const disallowedTools = splitList(attrs["disallowedTools"]);
  const skills = splitList(attrs["skills"]);
  const maxTurnsRaw = attrs["maxTurns"];
  const maxTurns = maxTurnsRaw !== undefined && Number.isFinite(Number(maxTurnsRaw)) ? Number(maxTurnsRaw) : undefined;
  const memory = attrs["memory"];
  return {
    description,
    prompt: body,
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    ...(attrs["model"] !== undefined ? { model: attrs["model"] } : {}),
    ...(attrs["initialPrompt"] !== undefined ? { initialPrompt: attrs["initialPrompt"] } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(attrs["background"] !== undefined ? { background: attrs["background"] === "true" } : {}),
    ...(isMemoryValue(memory) ? { memory } : {}),
    ...(attrs["effort"] !== undefined ? { effort: toEffortValue(attrs["effort"]) } : {}),
    ...(attrs["permissionMode"] !== undefined ? { permissionMode: attrs["permissionMode"] } : {}),
    ...(skills !== undefined ? { skills } : {}),
  };
}

function agentNameFromFile(filePath: string): string {
  return basename(filePath).replace(/\.md$/i, "");
}

function loadAgentDirectory(dir: string): Record<string, RuntimeAgentDefinition> {
  const out: Record<string, RuntimeAgentDefinition> = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory doesn't exist -- zero agents from this source, never an error
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      const raw = readFileSync(full, "utf8");
      const name = agentNameFromFile(full);
      const def = parseAgentDefinitionFile(raw, name);
      if (def !== undefined) out[name] = def;
    } catch {
      continue; // an unreadable/malformed individual file is skipped, never aborts the whole scan
    }
  }
  return out;
}

export interface LoadAgentDefinitionsOptions {
  // T2's own wire-plumbed RuntimeConfig.agents. NOT reachable from inside a tool executor today --
  // ToolExecutionContext (registry.ts, frozen) carries no `agents` field, so tools/impl/agent.ts's
  // own call site always passes `undefined` here until that seam gains one (flagged NEEDS_CONTEXT in
  // this lane's report). Exposed as a real parameter regardless, so this function's own merge logic
  // is fully correct and independently testable right now, and activates with zero code change once
  // the seam exists.
  programmatic?: Record<string, RuntimeAgentDefinition>;
  cwd: string;
  /**
   * The OS HOME directory. `<home>/<brand.homeDirName>/agents` is the user tier when `winterHome`
   * below is absent -- which is the pre-fix behaviour, kept for every caller that does not thread a
   * resolved root.
   */
  home: string;
  /** P7a (D19): the session's brand -- the home and project dot-dir names. Omitted = `WINTER_BRAND`. */
  brand?: Pick<BrandProfile, "homeDirName" | "projectDirName">;
  /**
   * Phase 5 fix wave, KNOWN-6: the RESOLVED winter root (`<PREFIX>HOME` when set). When given it
   * IS the user tier's address (`<winterHome>/agents`), matching where the skills index, the command
   * resolver and `resolveSettings` all look. Never both: this is an address, not a second directory.
   */
  winterHome?: string;
  // RULING R4-7: a project `agents/*.md` loads ONLY when true. The user tier always loads
  // regardless (WS-10 §2's own user-tier agents directory carries no trust qualifier, unlike the
  // project-local path).
  trustedWorkspace: boolean;
  /**
   * Phase 5 Task 2 (the P4 carry behind R4-7): definitions contributed by loaded plugins, keyed by
   * `subagent_type`, each carrying its contributing plugin's name.
   *
   * DELIBERATELY NOT TRUST-GATED, unlike the project directory above. Workspace trust answers "may
   * this REPOSITORY configure the session"; a plugin is loaded because the HOST listed it
   * (`Options.plugins`) or the user installed it under `~/.winter/plugins` -- a decision already
   * made outside the repository, and the same decision that lets a plugin contribute hooks and MCP
   * servers. Gating it on workspace trust would make plugin behaviour depend on which directory the
   * session happens to be in, which is neither the pin's model nor Winter's.
   */
  pluginAgents?: Record<string, PluginAgentDefinition>;
}

// Merge precedence, highest first: programmatic > project (.winter/agents, trust-gated) >
// user (~/.winter/agents) > plugin (R4-7's own order, extended at the bottom by Phase 5 Task 2 --
// a plugin ships a DEFAULT any of the three more-specific sources may override, and a plugin agent
// silently shadowed by a user's own file of the same name is the intended outcome, not a conflict).
// A name collision at a LOWER-precedence source is silently shadowed (never an error) -- see this
// file's own header for why.
export function loadAgentDefinitions(opts: LoadAgentDefinitionsOptions): Map<string, SourcedAgentDefinition> {
  const out = new Map<string, SourcedAgentDefinition>();
  for (const [name, def] of Object.entries(opts.pluginAgents ?? {})) {
    const { plugin, ...definition } = def;
    out.set(name, { ...definition, _source: "plugin", _plugin: plugin });
  }
  // Phase 5 fix wave, KNOWN-6 / I1: the user tier is addressed by the RESOLVED winter root when the
  // caller supplies one, and only falls back to `<home>/.winter/agents` when it does not.
  //
  // THE BUG THIS CLOSES, in Lane S's own words: a session run with `WINTER_HOME=/somewhere/else`
  // loaded its skills and commands from that root (Lane S addressed them by the resolved root) and
  // its user AGENT definitions from `~/.winter/agents` -- two halves of one user configuration in
  // two places, silently. `SkillIndexOptions.winterHome`'s header records exactly this hazard: the
  // two conventions in this codebase are not interchangeable, and a field named `home` gets handed
  // whichever one its caller happened to be reading.
  const user = loadAgentDirectory(opts.winterHome !== undefined ? join(opts.winterHome, "agents") : join(opts.home, (opts.brand ?? WINTER_BRAND).homeDirName, "agents"));
  for (const [name, def] of Object.entries(user)) out.set(name, { ...def, _source: "user" });
  if (opts.trustedWorkspace) {
    const project = loadAgentDirectory(join(opts.cwd, (opts.brand ?? WINTER_BRAND).projectDirName, "agents"));
    for (const [name, def] of Object.entries(project)) out.set(name, { ...def, _source: "project" });
  }
  for (const [name, def] of Object.entries(opts.programmatic ?? {})) out.set(name, { ...def, _source: "programmatic" });
  return out;
}

// WS-10 §2: "tools must include Skill if skills is used" -- VALIDATION ONLY (skills = a P5 seam,
// this codebase has no skills runtime at all yet). Returns warnings; never throws and never mutates
// the definition -- a caller decides what to do with one (tools/impl/agent.ts surfaces it inline in
// the spawned child's own result/notice text).
export function validateAgentDefinition(def: RuntimeAgentDefinition): string[] {
  const warnings: string[] = [];
  if (def.skills !== undefined && def.skills.length > 0) {
    if (def.tools === undefined || !def.tools.includes("Skill")) {
      warnings.push('AgentDefinition declares "skills" but its own "tools" list does not include "Skill" (WS-10 §2)');
    }
  }
  return warnings;
}
