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
import { join } from "node:path";
import { WINTER_BRAND, type AgentInfo, type BrandProfile, type RuntimeAgentDefinition } from "@yanlinglabs/winter-agent-sdk";
import { resolveBuiltinAgents, resolveBuiltinAgentGates, type BuiltinAgentGates } from "./builtin-agents.ts";

export type AgentDefinitionSource = "programmatic" | "project" | "user" | "plugin" | "builtin";

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

// Spawn-surface parity (research §A1's own field table, scope item 2): claude REQUIRES frontmatter
// `name` (rejecting a leading `-` or any `:`) and `description` on a filesystem agent file -- neither
// falls back to the file's own basename any more. This is a deliberate BREAK from the pre-parity
// contract (which keyed every filesystem agent by its basename and let `description` fall back to
// it): a `.md` file with no `name:` line is now a REJECTED file, not a silently-basename-keyed one,
// exactly matching claude's own posture. `filePath` is carried through for diagnostics only (the
// rejection reason names it); it is no longer a naming fallback.
export type ParsedAgentDefinitionResult = { ok: true; name: string; definition: RuntimeAgentDefinition } | { ok: false; filePath: string; reason: string };

/** A name may not start with `-` (collides with a flag-like spelling) or contain `:` (a Winter/claude reserved separator elsewhere in tool-identity grammar) -- research §A1, verbatim rule. */
function isValidAgentName(name: string): boolean {
  return name.length > 0 && !name.startsWith("-") && !name.includes(":");
}

// Builds a RuntimeAgentDefinition (plus its own NAME, now frontmatter-sourced) from one `.md` file's
// frontmatter + body (`prompt` = the body, WS-10 §2's own "prompt: system prompt of the child" --
// frontmatter never carries `prompt` itself, since the body IS the prompt, matching this project's
// own tracked subagent-file convention).
export function parseAgentDefinitionFile(raw: string, filePath: string): ParsedAgentDefinitionResult {
  const { attrs, body } = parseFrontmatter(raw);
  if (body.trim().length === 0) return { ok: false, filePath, reason: "no prompt body (the file's content after any frontmatter block is empty)" };

  const name = attrs["name"];
  if (name === undefined || name.trim().length === 0) return { ok: false, filePath, reason: 'missing required frontmatter field "name"' };
  if (!isValidAgentName(name)) return { ok: false, filePath, reason: `invalid agent name "${name}" -- must not start with "-" or contain ":"` };

  const description = attrs["description"];
  if (description === undefined || description.trim().length === 0) return { ok: false, filePath, reason: 'missing required frontmatter field "description"' };

  const tools = splitList(attrs["tools"]);
  const disallowedTools = splitList(attrs["disallowedTools"]);
  const skills = splitList(attrs["skills"]);
  const maxTurnsRaw = attrs["maxTurns"];
  const maxTurns = maxTurnsRaw !== undefined && Number.isFinite(Number(maxTurnsRaw)) ? Number(maxTurnsRaw) : undefined;
  const memory = attrs["memory"];
  const isolation = attrs["isolation"];
  const definition: RuntimeAgentDefinition = {
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
    // Scope item 2: "accept isolation (worktree|remote) and color". An unrecognised isolation value
    // is dropped rather than mis-typed through (the same posture `isMemoryValue` already applies to
    // `memory` above) -- a typo in a hand-authored file must not silently become an unsupported
    // literal the spawn path chokes on later.
    ...(isolation === "worktree" || isolation === "remote" ? { isolation } : {}),
    ...(attrs["color"] !== undefined ? { color: attrs["color"] } : {}),
  };
  return { ok: true, name, definition };
}

/**
 * A rejected filesystem agent file, surfaced to whichever caller wants visibility (research §A1 /
 * scope item 2: "follow claude and log/record the rejection clearly"). `loadAgentDefinitions`'s own
 * RETURN TYPE stays a plain `Map` (its one production caller, `tools/impl/agent.ts`, calls `.get()`
 * on it directly and is out of this lane's file boundary) -- so rejections ride an OPTIONAL callback
 * instead of a second return value. Silent-skip (no callback given) is the pre-existing behavior for
 * every other kind of per-file failure this loader already tolerates (an unreadable file, a
 * non-`.md` entry), so a caller that does not ask for rejections sees no behavior change beyond the
 * stricter validation itself.
 */
export interface AgentDefinitionRejection {
  source: Exclude<AgentDefinitionSource, "programmatic" | "builtin">;
  filePath: string;
  reason: string;
}

/**
 * Review r2 finding 2 (whole-branch): `onReject` had NO production caller -- every rejected file
 * (a hand-authored `agents/*.md` with no `name:`/`description:`, or one with a `name:` that fails
 * `isValidAgentName`) still vanished from the session with nothing telling the operator it existed,
 * let alone why. This is the ONE reporter every production caller shares: ONE stderr line per
 * rejected file, DEDUPED by `filePath` for the lifetime of the closure it returns -- production
 * threads a single instance through a whole session/child (`engine.ts`'s own
 * `reportAgentDefinitionRejection`, shared by `sessionAgentDefinitions` and the Agent tool
 * executor's own call, both of which call `loadAgentDefinitions` on nearly every turn), so an
 * undeduped write would spam one line per rejected file per turn for the rest of the session.
 *
 * `write` is injectable (defaults to `process.stderr.write`, bound so `this` stays correct) so a
 * test can assert against a captured sink rather than scraping the real stream. STDERR ONLY, never
 * stdout -- stdout is the SDK's own frame stream (WS-04 §2/§6), and this is diagnostic, not a wire
 * frame. Never throws: a closed/broken stderr must not take agent-definition loading down with it.
 */
export function createAgentDefinitionRejectionReporter(write: (line: string) => void = (line) => process.stderr.write(line)): (rejection: AgentDefinitionRejection) => void {
  const warnedPaths = new Set<string>();
  return (rejection: AgentDefinitionRejection): void => {
    if (warnedPaths.has(rejection.filePath)) return;
    warnedPaths.add(rejection.filePath);
    try {
      write(`winter: agent definition rejected -- ${rejection.filePath} (${rejection.reason}); fix: add "name:" and "description:" frontmatter.\n`);
    } catch {
      /* a closed/broken stderr must never take agent-definition loading down with it */
    }
  };
}

function loadAgentDirectory(dir: string, source: "user" | "project", onReject?: (rejection: AgentDefinitionRejection) => void): Record<string, RuntimeAgentDefinition> {
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
      const parsed = parseAgentDefinitionFile(raw, full);
      if (parsed.ok) {
        out[parsed.name] = parsed.definition;
      } else {
        onReject?.({ source, filePath: parsed.filePath, reason: parsed.reason });
      }
    } catch {
      continue; // an unreadable individual file is skipped, never aborts the whole scan
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
  /**
   * P7a (D19): the session's brand -- the home and project dot-dir names, PLUS (spawn-surface
   * parity) `envPrefix`/`productName`, which `resolveBuiltinAgents` below needs for the kill-switch
   * env names and the built-in prompts' own product-noun interpolation. Omitted = `WINTER_BRAND`.
   */
  brand?: Pick<BrandProfile, "homeDirName" | "projectDirName" | "envPrefix" | "productName">;
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
  /**
   * Spawn-surface parity (R-S1): env for the built-in kill switches (`builtin-agents.ts`'s own
   * `resolveBuiltinAgentGates`), read fresh per call -- never cached, matching every other per-session
   * env read in this lane (`limits.ts`'s own precedent). Omitted = `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * TEST/OVERRIDE SEAM: the resolved built-in set to merge in, bypassing `resolveBuiltinAgents`
   * entirely. Omitted (every production call site) computes it from `env`/`brand` as normal -- this
   * exists so a test can inject a fixed set without threading env vars, and so a future caller with
   * its own gating policy can substitute one.
   */
  builtinAgents?: Record<string, RuntimeAgentDefinition>;
  /**
   * Spawn-surface parity (R-S5): the session's RESOLVED fork gate (`RuntimeConfig.forkSubagent`,
   * which wins over the env var in either direction). Absent = the env fallback alone decides, as
   * `resolveBuiltinAgentGates` always did.
   */
  forkSubagentEnabled?: boolean;
  /**
   * Scope item 2: a rejected filesystem agent file (missing/invalid `name`, missing `description`) is
   * "logged/recorded clearly" through this optional callback rather than a return-value change --
   * see `AgentDefinitionRejection`'s own header for why the return type cannot change here.
   */
  onReject?: (rejection: AgentDefinitionRejection) => void;
}

// Merge precedence, highest first: programmatic > project (.winter/agents, trust-gated) >
// user (~/.winter/agents) > plugin (R4-7's own order, extended at the bottom by Phase 5 Task 2 --
// a plugin ships a DEFAULT any of the three more-specific sources may override, and a plugin agent
// silently shadowed by a user's own file of the same name is the intended outcome, not a conflict) >
// builtin (spawn-surface parity R-S1: "built-ins as the LOWEST precedence tier (below plugin); same-
// name user/project/plugin/programmatic agents override them" -- a checked-in file or a host's own
// `Options.agents` entry named `Explore` replaces Winter's own, never fights it).
// A name collision at a LOWER-precedence source is silently shadowed (never an error) -- see this
// file's own header for why.
export function loadAgentDefinitions(opts: LoadAgentDefinitionsOptions): Map<string, SourcedAgentDefinition> {
  const out = new Map<string, SourcedAgentDefinition>();
  const brand = opts.brand ?? WINTER_BRAND;
  const builtins =
    opts.builtinAgents ??
    resolveBuiltinAgents({
      brand,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.forkSubagentEnabled !== undefined ? { gates: { ...resolveBuiltinAgentGates(opts.env ?? process.env, brand), forkSubagentEnabled: opts.forkSubagentEnabled } } : {}),
    });
  for (const [name, def] of Object.entries(builtins)) out.set(name, { ...def, _source: "builtin" });
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
  const user = loadAgentDirectory(opts.winterHome !== undefined ? join(opts.winterHome, "agents") : join(opts.home, brand.homeDirName, "agents"), "user", opts.onReject);
  for (const [name, def] of Object.entries(user)) out.set(name, { ...def, _source: "user" });
  if (opts.trustedWorkspace) {
    const project = loadAgentDirectory(join(opts.cwd, brand.projectDirName, "agents"), "project", opts.onReject);
    for (const [name, def] of Object.entries(project)) out.set(name, { ...def, _source: "project" });
  }
  for (const [name, def] of Object.entries(opts.programmatic ?? {})) out.set(name, { ...def, _source: "programmatic" });
  return out;
}

// --- Spawn-surface parity (research §A4): subagent_type lookup, normalized -------------------------
//
// claude matches a requested `subagent_type` after NORMALIZING both sides: NFKC-fold, lowercase,
// strip whitespace/`-`/`_` -- "explore" -> "Explore", "general purpose" -> "general-purpose", but
// "general"/"explorer" do NOT match (they normalize to a DIFFERENT string, not a prefix or a substring
// of one). An EXACT match (before normalization) always wins outright and can never be "ambiguous" --
// normalization only matters once no exact key exists.
function normalizeAgentTypeName(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/[\s\-_]/g, "");
}

export type FindAgentResult =
  | { kind: "found"; name: string; definition: SourcedAgentDefinition }
  | { kind: "not-found" }
  | { kind: "ambiguous"; matches: string[] };

/**
 * `findAgentByType`: the ONE place a requested `subagent_type` string becomes either a resolved
 * definition or a typed miss -- lane L2b's `tools/impl/agent.ts` is expected to call this in place of
 * its current bare `definitions.get(subagentType)` (research gap 5 / claude §A4).
 */
export function findAgentByType(defs: ReadonlyMap<string, SourcedAgentDefinition>, requested: string): FindAgentResult {
  const exact = defs.get(requested);
  if (exact !== undefined) return { kind: "found", name: requested, definition: exact };

  const target = normalizeAgentTypeName(requested);
  const matches = [...defs.keys()].filter((key) => normalizeAgentTypeName(key) === target);
  if (matches.length === 0) return { kind: "not-found" };
  if (matches.length === 1) return { kind: "found", name: matches[0]!, definition: defs.get(matches[0]!)! };
  return { kind: "ambiguous", matches: matches.sort() };
}

/**
 * Research §A4, first error form: `Agent type '<t>' not found. Available agents: <a, b, c>` ("none"
 * when the session has zero agents at all).
 */
export function formatAgentNotFound(requested: string, available: readonly string[]): string {
  const list = available.length > 0 ? [...available].sort().join(", ") : "none";
  return `Agent type '${requested}' not found. Available agents: ${list}`;
}

/**
 * Research §A4, second error form -- the research file TRUNCATES claude's own string with an
 * ellipsis ("is ambiguous — matches … Use the exact name: …"), so the two blanks below are
 * WINTER-AUTHORED completions of that shape, not a verbatim transcription (disclosed: see this
 * lane's own report).
 */
export function formatAgentAmbiguous(requested: string, matches: readonly string[]): string {
  const sorted = [...matches].sort();
  return `Agent type '${requested}' is ambiguous — matches ${sorted.join(", ")}. Use the exact name: ${sorted.join(" or ")}.`;
}

// ---------------------------------------------------------------------------------------------------
// SDK 0.0.16 Lane P (R3b §4): `allowedAgentTypes`, parsed off a RUNNING agent's own raw `tools` list.
// ---------------------------------------------------------------------------------------------------
//
// claude: "`allowedAgentTypes` comes from the RUNNING agent's definition `tools` list:
// `tools: ["*", "Agent(Explore, Plan)"]` -> allowed = [Explore, Plan] with all other tools kept;
// explicit lists with `Agent(a,b)` likewise." An `Agent(...)` entry is a SCOPING annotation on the
// Agent tool's own capability, not a separate tool-pool member -- it sits alongside `"*"`/ordinary
// tool names in the SAME list, and every other entry is untouched by this function.
//
// PULLED FROM THE RAW LIST, before pool resolution ever sees it: `subagents/child-engine.ts`'s own
// `effectiveTools` (the tool-pool allowlist a child's model actually sees) resolves against
// REGISTERED CANONICAL TOOL NAMES only -- `"Agent(Explore, Plan)"` is not one, so it is silently
// absent from that resolved set either way, and by the time a caller has only `effectiveTools` to
// look at, the parenthetical's own data is already gone. This function reads the SAME source data
// one step earlier, which is the only place the restriction survives.
//
// DISCLOSED GAP: an explicit list with ONLY `Agent(a,b)` and no bare `Agent`/`"*"` (no other entry
// that keeps the Agent tool itself in the resolved pool) restricts spawnable TYPES correctly via
// this function, but the Agent tool itself would not be advertised at all -- `effectiveTools`'
// resolution (engine.ts's `buildChildInheritance`, a different lane's file this task does not own)
// treats `Agent(a,b)` as an unrecognized, non-matching string, not as "Agent, scoped." Every example
// in the research file pairs it with `"*"` (`tools: ["*", "Agent(Explore, Plan)"]`), which keeps the
// Agent tool in the pool via the wildcard and is the case this function's own tests exercise.
const AGENT_TYPES_TOOL_ENTRY_RE = /^Agent\((.*)\)$/s;

/**
 * Parses every `Agent(a, b)`-shaped entry out of `tools` into the restricted set of spawnable
 * `subagent_type` names. `undefined` (unrestricted -- every type this session can otherwise resolve
 * stays available) when `tools` itself is absent, or carries no such entry at all (including a bare
 * `["*"]` or an explicit list of ordinary tool names with no `Agent(...)` entry). Whitespace around
 * each name is trimmed; several `Agent(...)` entries (an unusual but not forbidden shape) union
 * their names rather than only the last one winning.
 */
export function allowedAgentTypesFromTools(tools: readonly string[] | undefined): string[] | undefined {
  if (tools === undefined) return undefined;
  const names = new Set<string>();
  let found = false;
  for (const entry of tools) {
    const m = AGENT_TYPES_TOOL_ENTRY_RE.exec(entry.trim());
    if (!m) continue;
    found = true;
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim();
      if (name.length > 0) names.add(name);
    }
  }
  return found ? [...names] : undefined;
}

/**
 * The pinned `AgentInfo[]` shape (`Query.supportedAgents()`, research §A3: "Same list feeds
 * `system/init.agents?: string[]` and `Query.supportedAgents(): AgentInfo[]`") -- lane L2b's own
 * `list_agents` control handler is expected to build its response with this, so the two lists this
 * one merged map feeds (the bare-name `init.agents`/`findAgentByType` and the richer `AgentInfo[]`)
 * can never disagree about WHICH agents exist.
 *
 * `model: "inherit"` is OMITTED, never passed through literally: the pin's own field doc reads
 * "Model alias this agent uses. If omitted, inherits the parent's model" -- `"inherit"` is Winter's
 * internal sentinel for exactly that (`engine.ts`'s own `resolveChildModel`: `defModel !== "inherit"`
 * is the guard), and a caller reading `AgentInfo.model` verbatim would otherwise see the literal
 * string `"inherit"` where the pin's own contract says absence means the same thing.
 */
export function toAgentInfoList(defs: ReadonlyMap<string, SourcedAgentDefinition>): AgentInfo[] {
  return [...defs.entries()]
    .map(([name, def]) => ({
      name,
      description: def.description,
      ...(def.model !== undefined && def.model !== "inherit" ? { model: def.model } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// WS-10 §2: "tools must include Skill if skills is used" -- VALIDATION ONLY (skills = a P5 seam,
// this codebase has no skills runtime at all yet). Returns warnings; never throws and never mutates
// the definition -- a caller decides what to do with one (tools/impl/agent.ts surfaces it inline in
// the spawned child's own result/notice text).
export function validateAgentDefinition(def: RuntimeAgentDefinition): string[] {
  const warnings: string[] = [];
  if (def.skills !== undefined && def.skills.length > 0) {
    // `["*"]` (the built-ins' wildcard) includes Skill like every other tool.
    if (def.tools === undefined || (!def.tools.includes("Skill") && !def.tools.includes("*"))) {
      warnings.push('AgentDefinition declares "skills" but its own "tools" list does not include "Skill" (WS-10 §2)');
    }
  }
  return warnings;
}
