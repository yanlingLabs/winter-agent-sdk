// Phase 5 Lane W (task 4), WS-11 §1.3: where a workflow's SOURCE comes from, and where a run's
// script GOES.
//
// THE RETIREMENT DELTA (WS-11 §1.3, stated as a retirement rather than a difference): Norma's `name`
// meant "save this script to `~/.norma/workflows/<name>.js` when the run completes." CC's `name`
// means the opposite -- "resolve an EXISTING script by this name." Norma's save-on-completion is
// retired outright; nothing in this file writes to a `workflows/` name store, and the only write it
// performs is the per-invocation persistence below, which is keyed by runId and is not a name store
// at all.
//
// USER-LEVEL STORE (SV-5, fix round 3, M-3's last bullet -- WS-11 §11 OQ2 CLOSED): the pinned
// binary's own workflow-discovery module (claude CLI 2.1.250 / agent-sdk 0.3.250) reads a THIRD tier
// through its storage backend at `{namespace:"userConfigDir", dir:"workflows"}`, tagged
// `source:"userSettings"` and merged with the project tier before plugin/builtin. For the Winter leg
// this is `<winterHome>/workflows` -- the SAME root `skills/store.ts`'s own user tier already reads
// (`join(opts.winterHome, "skills")`), i.e. the RUN folder per SV-1/SV-2's rule, not
// `WINTER_STORE_HOME` -- never the OS home directory Norma's old `<normaHome>/workflows` convention
// named (WS-01 still forbids inventing a name; this one is dump-confirmed, not invented). Gated by
// `settingSources` ("user" ∈ settingSources), NOT by `trustedWorkspace` -- claude's own `yo`
// ("userSettings") check carries no trust condition, matching skills' "source gating, not trust
// gating" rule (skills/store.ts's own header) rather than the project tier's R4-7 trust gate.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type BrandProfile, type SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { parseWorkflowMeta, type WorkflowMetaPhase } from "./meta.ts";

/**
 * The path-traversal guard, applied BEFORE any filesystem call ever sees the name -- `name` arrives
 * from a tool-call argument, i.e. from the model, and is about to be joined into a path. Same
 * alphabet and same rationale as Norma's original: no dots and no slashes, so a bare "." or ".."
 * stem is refused outright rather than relying on the `.js` suffix to accidentally neuter it into
 * "..js".
 */
const WORKFLOW_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** The project workflows directory for a brand -- `<brand.projectDirName>/workflows`. */
export function projectWorkflowsDir(brand?: Pick<BrandProfile, "projectDirName">): string {
  return join((brand ?? WINTER_BRAND).projectDirName, "workflows");
}

/** Winter's own value, for every caller that has not threaded a brand. */
export const PROJECT_WORKFLOWS_DIR = projectWorkflowsDir();

export type ResolvedWorkflowSource =
  | { ok: true; source: string; path: string | undefined; source_kind: "project" | "user" | "builtin" | "plugin" }
  | { ok: false; error: string };

/** A minimal projection of `plugins/bundle.ts`'s `PluginBundle` -- only the fields workflow resolution needs. */
export interface PluginWorkflowSource {
  name: string;
  workflowsPath?: string;
  /**
   * Fix round 4 (minors, M-3's last bullet): the manifest's own `workflows` override -- see
   * `PluginBundle.workflowsPaths`'s own comment for why this is mutually exclusive with
   * `workflowsPath` above rather than additive to it. `pluginWorkflowSourcePaths` below is where the
   * two are combined into the single list every scan actually walks.
   */
  workflowsPaths?: readonly string[];
}

/** Every directory/file this plugin's workflows may live in, default dir first (SourcedRuleEntry-style: harmless to list both, since a real `PluginBundle` never sets both at once -- `bundle.ts`'s own comment). */
function pluginWorkflowSourcePaths(plugin: PluginWorkflowSource): string[] {
  return [...(plugin.workflowsPath !== undefined ? [plugin.workflowsPath] : []), ...(plugin.workflowsPaths ?? [])];
}

/**
 * Shared by `resolveWorkflowByName` and `listWorkflowsForListing` -- resolution and listing read the
 * SAME tiers under the SAME gates, so they can never disagree about what exists.
 */
export interface WorkflowDiscoveryOptions {
  cwd: string;
  /**
   * TRUST-GATED, deliberately, and this is a disclosed judgment call (see the lane report).
   *
   * A project `workflows/*.js` file is EXECUTABLE CODE a project supplies and the model runs -- the
   * same category as a project `agents/*.md`, which RULING R4-7 keeps trust-gated, and not the
   * category of skills/commands/instructions, which P5-T1 capture (b) makes merely SOURCE-gated. Norma
   * trust-gated its own project workflow directory for the same reason. The consequence is real and
   * worth stating: in an untrusted workspace `name` resolves nothing, so a freshly-cloned repo's
   * workflows do not run until the workspace is trusted. `script`/`scriptPath` are unaffected.
   *
   * A PLUGIN workflow (below) is DELIBERATELY NOT gated on this bit, for the identical reason every
   * other plugin-contributed resource in this codebase (skills, agents, commands, output styles,
   * MCP servers) is not: a plugin is loaded because the HOST or the USER already decided to, outside
   * the repository, so gating it on workspace trust would make plugin behaviour depend on which
   * directory the session happens to be in. The USER tier (below) is not gated on this bit either,
   * for the same reason skills' user tier is not (skills/store.ts's header).
   */
  trustedWorkspace: boolean;
  /** P7a (D19): the session's brand -- the project dot-dir workflows live under. Omitted = `WINTER_BRAND`. */
  brand?: Pick<BrandProfile, "projectDirName">;
  /**
   * WS-21 §6.3 item 1 (fix round 2): the session's ENABLED plugins that ship a `workflows/`
   * directory. Omitted (every pre-fix-round-2 caller) means a `<plugin>:<name>` name simply falls
   * through to "unknown workflow", exactly as it did before this field existed.
   */
  pluginWorkflows?: readonly PluginWorkflowSource[];
  /**
   * SV-5 fix round 3: the RESOLVED winter root (`SkillIndexOptions.winterHome`'s identical
   * convention and identical naming rationale) -- `<winterHome>/workflows` is the user tier.
   * Omitted means no user tier is read (every pre-fix-round-3 caller), not an error.
   */
  winterHome?: string | undefined;
  /**
   * Fix round 3 (I-4): source gating, mirroring `skills/store.ts`'s `sourcesAllow` exactly.
   * Omitted = all tiers allowed (claude's own `settingSources` default). A caller that wants the
   * project workflows directory (`projectWorkflowsDir`) un-read when the run's `settingSources`
   * excludes `"project"` -- e.g. a `settingSources:["user"]` run that is ALSO
   * `trustedWorkspace:true` -- must pass it; nothing derives it from `trustedWorkspace`, which is a
   * different, narrower gate (R4-7) than this one.
   */
  settingSources?: readonly SettingSource[] | undefined;
}

export interface ResolveWorkflowByNameOptions extends WorkflowDiscoveryOptions {
  /** Injectable for the test that proves built-ins are consulted first; production passes nothing. */
  builtins?: Record<string, string>;
}

/**
 * WS-11 §1.3's built-in registry. EMPTY, and empty on purpose: WS-01 forbids inventing names, and no
 * built-in workflow has been captured from the pinned runtime. The lookup exists so adding one later
 * is a data change rather than a control-flow change.
 */
const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = Object.freeze({});

export function listBuiltinWorkflows(): string[] {
  return Object.keys(BUILTIN_WORKFLOWS);
}

/**
 * Fix round 3 (M-3): the pinned binary's own oversize skip -- `var xh=524288` in the same chunk as
 * the plugin workflow loader (dump-confirmed by content search; `"Plugin workflow ${o}: not a
 * regular file or exceeds ${xh} bytes — skipping"` / `"Workflow ${l} exceeds ${xh} bytes —
 * skipping"`). A file over this size is treated exactly like an unreadable one: silently skipped,
 * never a hard error for the whole directory scan.
 */
const WORKFLOW_SCRIPT_MAX_BYTES = 524288;

function sourcesAllow(settingSources: readonly SettingSource[] | undefined, tier: SettingSource): boolean {
  return settingSources === undefined || settingSources.includes(tier);
}

/** Built-ins first, then a plugin (WS-21 §6.3 item 1), the trusted project directory, or the user directory. Never throws. */
export function resolveWorkflowByName(name: string, opts: ResolveWorkflowByNameOptions): ResolvedWorkflowSource {
  // WS-21 §6.3 item 1, CORRECTED in the batch-2 fix round: a `<plugin>:<name>` qualified name -- the
  // SAME grammar every other plugin-namespaced identity in this codebase uses (skills, commands,
  // output styles), and CONFIRMED as claude's own real convention via the pinned binary's own
  // disassembled workflow-discovery module (claude CLI 2.1.250 / agent-sdk 0.3.250; NOT
  // claude-code-reference, which has no "workflows" concept at all): a plugin workflow's `v()`
  // loader builds `` `${pluginName}:${r.meta.name}` `` after a lightweight, non-executing meta parse
  // (`Kp(e, {validateBody: false})` -- Winter's own `parseWorkflowMeta`'s identical job), and the
  // resolver (`aUe(name, ...)`) does a flat `.find(d => d.name === name)` against that baked-in
  // string. Checked BEFORE `WORKFLOW_NAME_RE` (which has no `:` in its own alphabet, so a qualified
  // name would otherwise be refused outright as "invalid").
  const qualified = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(name);
  if (qualified !== null) {
    const [, pluginName, metaName] = qualified;
    const plugin = opts.pluginWorkflows?.find((p) => p.name === pluginName);
    const pluginWorkflowPaths = plugin !== undefined ? pluginWorkflowSourcePaths(plugin) : [];
    if (pluginWorkflowPaths.length === 0) {
      return { ok: false, error: `unknown workflow "${name}": no plugin named "${pluginName}" is enabled with a workflows/ directory` };
    }
    const found = discoverWorkflowsAt(pluginWorkflowPaths).get(metaName!);
    if (found === undefined) {
      return { ok: false, error: `unknown workflow "${name}": no workflow with meta.name "${metaName}" in plugin "${pluginName}"'s workflows/ directory` };
    }
    return { ok: true, source: found.source, path: found.path, source_kind: "plugin" };
  }

  if (!WORKFLOW_NAME_RE.test(name)) {
    return { ok: false, error: `invalid workflow name ${JSON.stringify(name)}: expected [A-Za-z0-9_-]+ (no dots, no path separators)` };
  }
  const builtin = (opts.builtins ?? BUILTIN_WORKFLOWS)[name];
  if (typeof builtin === "string") return { ok: true, source: builtin, path: undefined, source_kind: "builtin" };

  // SV-5 (batch-2, second round -- the router same-view test): CORRECTED from a direct `<name>.js`
  // join to the SAME directory-scan-by-meta.name resolution the plugin branch above uses. Measured
  // on the pinned binary's own project-tier workflow discovery (a filesystem walk feeding the exact
  // same `name: p.meta.name` shape the plugin loader's `v()` produces): identity is ALWAYS the
  // script's own declared `meta.name`, never its filename, for every tier, not only plugins.
  const workflowsDir = projectWorkflowsDir(opts.brand);
  const projectEligible = opts.trustedWorkspace && sourcesAllow(opts.settingSources, "project");
  if (projectEligible) {
    const found = discoverWorkflowsInDir(join(opts.cwd, workflowsDir)).get(name);
    if (found !== undefined) return { ok: true, source: found.source, path: found.path, source_kind: "project" };
  }
  // Fix round 3 (M-3's last bullet): the user tier, source-gated like skills' own user tier, never
  // trust-gated (this file's header). Bare-name PRECEDENCE matches claude's own `b()`/`k()` merge: a
  // project workflow overrides a user one of the same `meta.name` -- checked here BEFORE the user
  // tier, so on a collision the project copy above already returned and this is never reached.
  const userEligible = sourcesAllow(opts.settingSources, "user") && opts.winterHome !== undefined;
  if (userEligible) {
    const found = discoverWorkflowsInDir(join(opts.winterHome!, "workflows")).get(name);
    if (found !== undefined) return { ok: true, source: found.source, path: found.path, source_kind: "user" };
  }
  if (!opts.trustedWorkspace && sourcesAllow(opts.settingSources, "project")) {
    return {
      ok: false,
      error: `workflow "${name}" was not resolved: ${workflowsDir}/ is only read in a TRUSTED workspace (a project workflow is executable code, like a project agent definition -- R4-7). Pass the script inline with \`script\`, or trust the workspace.`,
    };
  }
  return {
    ok: false,
    error: `unknown workflow "${name}": no workflow with meta.name "${name}" in ${workflowsDir}/${userEligible ? ` or ${opts.winterHome}/workflows/` : ""}, and no built-in by that name`,
  };
}

// --- Shared directory-scan-by-meta.name primitive (SV-5, batch-2 + fix round 3) --------------------
//
// A DIRECTORY SCAN, not a direct `<name>.js` join: identity is the SCRIPT's own declared `meta.name`
// (parsed via `parseWorkflowMeta`, never executed), not its filename -- the only way to find "the
// file whose declared identity is this name" is to check every candidate, mirroring
// `parsePluginStyleFile`'s identical shape for output styles. A file whose meta fails to parse, is
// not a regular file, or exceeds `WORKFLOW_SCRIPT_MAX_BYTES` is silently skipped (the pinned
// binary's own "has invalid meta ... skipping" / "exceeds ... bytes ... skipping"), never a hard
// error for the whole directory. Shared by resolution above and `listWorkflowsForListing` below, so
// they can never disagree about which file answers to which name.
//
// M-3: matched CASE-SENSITIVELY (`.endsWith(".js")`, not lower-cased -- claude's own `h()`/`D()`
// check `l.name.endsWith(".js")`/`r.name.endsWith(".js")` with no case-folding). On a duplicate
// `meta.name` within one directory, the LATER file in sorted order overrides the earlier one
// (claude's own `k`/`S`: `"Workflow ... would override ... but does not parse — keeping the ...
// copy"`), returned as a `Map` so a later `.set()` for the same key replaces the value -- a
// SIMPLIFICATION of claude's own rule, disclosed in the lane report: claude additionally gates the
// override on a full-script-validity check (`bLn`) before letting the later file win, keeping the
// earlier one when the later fails; Winter's meta parser deliberately never executes or fully
// validates a script BODY (security rationale, meta.ts's own header), so there is no equivalent
// validity oracle to gate on here -- the later file always wins.
interface DiscoveredWorkflowFile {
  name: string;
  description: string;
  path: string;
  source: string;
  /** Fix round 4 (I-E): carried through from the ALREADY-parsed meta so a listing consumer never re-parses the script to build a synthetic skill prompt. */
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

/**
 * ONE candidate file, parsed. Shared by `discoverWorkflowsInDir` (a directory scan) and
 * `discoverWorkflowsAt` (fix round 4, minors: a manifest `workflows` override entry may itself be a
 * bare FILE rather than a directory -- `PluginBundle.workflowsPaths`'s own citation) so the two never
 * drift on the size cap, the parse step or which fields survive.
 */
function discoverWorkflowFile(path: string): DiscoveredWorkflowFile | undefined {
  let source: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > WORKFLOW_SCRIPT_MAX_BYTES) return undefined;
    source = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseWorkflowMeta(source);
  if (!parsed.ok) return undefined;
  return {
    name: parsed.meta.name,
    description: parsed.meta.description,
    path,
    source,
    ...(parsed.meta.whenToUse !== undefined ? { whenToUse: parsed.meta.whenToUse } : {}),
    ...(parsed.meta.phases !== undefined ? { phases: parsed.meta.phases } : {}),
  };
}

function discoverWorkflowsInDir(dir: string): Map<string, DiscoveredWorkflowFile> {
  const out = new Map<string, DiscoveredWorkflowFile>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".js")) continue;
    const found = discoverWorkflowFile(join(dir, entry));
    if (found === undefined) continue;
    out.set(found.name, found);
  }
  return out;
}

/**
 * Fix round 4 (minors, M-3's last bullet): scans every one of a plugin's workflow SOURCES -- the
 * default directory, a manifest override's directories, a manifest override's bare files, all
 * flattened by `pluginWorkflowSourcePaths` into one ordered list (`PluginBundle.workflowsPaths`'s own
 * comment is why the two never coexist in practice, but nothing here assumes that). A later source
 * in the list overrides an earlier one on a `meta.name` collision, matching `discoverWorkflowsInDir`'s
 * own within-directory precedent (later file wins) extended across sources.
 */
function discoverWorkflowsAt(paths: readonly string[]): Map<string, DiscoveredWorkflowFile> {
  const out = new Map<string, DiscoveredWorkflowFile>();
  for (const path of paths) {
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; // vanished between bundle-build and this scan -- silently skipped, like every other unreadable entry in this file
    }
    if (isDir) {
      for (const [name, found] of discoverWorkflowsInDir(path)) out.set(name, found);
    } else {
      const found = discoverWorkflowFile(path);
      if (found !== undefined) out.set(found.name, found);
    }
  }
  return out;
}

export interface WorkflowListingEntry {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
  /** The script's real filesystem path -- carried through so a caller building a `SkillMeta`-shaped synthetic entry (production-wiring.ts) never has to invent one. */
  path: string;
  /** Fix round 4 (I-E): carried through for a synthetic skill/command prompt's own structure -- claude's own `m()` includes both alongside name/description. */
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

/**
 * SV-5 (batch-2, second round, extended in fix round 3) -- the router same-view test: the pinned
 * binary lists EVERY discovered workflow (user + project + plugin; built-in excluded, the pinned
 * binary's own `d()`/`Ru()` gate that separately and Winter ships none -- see `BUILTIN_WORKFLOWS`)
 * in the init `skills`/`slash_commands` fields and the model-facing Skill listing, named
 * `<plugin>:<meta.name>` for a plugin workflow or bare `<meta.name>` for a user/project one --
 * `getWorkflowCommands` in the pinned binary's own workflow-discovery module maps its FULL discovery
 * result through a `{type:"prompt", name: o.name, description: o.description, ...}` projection,
 * `o.name` already being the qualified/bare identity discovery assigned. `production-wiring.ts` is
 * the one caller, folding this into all three listing surfaces.
 *
 * ORDER matches claude's own final merge in `j()`/`QX()`: plugin entries first (builtins would lead,
 * but Winter has none to list), then user+project merged and name-sorted -- a project entry
 * overriding a user entry of the same name the same way resolution above does, so listing and
 * resolution can never disagree about which tier's copy is "the" workflow of that name.
 */
export function listWorkflowsForListing(opts: WorkflowDiscoveryOptions): WorkflowListingEntry[] {
  const out: WorkflowListingEntry[] = [];
  const toEntry = (w: DiscoveredWorkflowFile, source: WorkflowListingEntry["source"], name: string): WorkflowListingEntry => ({
    name,
    description: w.description,
    source,
    path: w.path,
    ...(w.whenToUse !== undefined ? { whenToUse: w.whenToUse } : {}),
    ...(w.phases !== undefined ? { phases: w.phases } : {}),
  });
  for (const plugin of opts.pluginWorkflows ?? []) {
    const paths = pluginWorkflowSourcePaths(plugin);
    if (paths.length === 0) continue;
    for (const w of [...discoverWorkflowsAt(paths).values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(toEntry(w, "plugin", `${plugin.name}:${w.name}`));
    }
  }
  const merged = new Map<string, WorkflowListingEntry>();
  if (sourcesAllow(opts.settingSources, "user") && opts.winterHome !== undefined) {
    for (const w of discoverWorkflowsInDir(join(opts.winterHome, "workflows")).values()) {
      merged.set(w.name, toEntry(w, "user", w.name));
    }
  }
  if (opts.trustedWorkspace && sourcesAllow(opts.settingSources, "project")) {
    for (const w of discoverWorkflowsInDir(join(opts.cwd, projectWorkflowsDir(opts.brand))).values()) {
      merged.set(w.name, toEntry(w, "project", w.name));
    }
  }
  for (const w of [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))) out.push(w);
  return out;
}

/**
 * Fix round 4 (I-E, the router same-view test): claude's own `m()` (dump-confirmed) turns every
 * discovered workflow into a `{type:"prompt", kind:"workflow", ...}` command whose PROMPT runs the
 * named workflow and carries the description, `whenToUse` and phases, ending with an instruction to
 * invoke the Workflow tool by name. `SkillMeta` has no dedicated "workflow" shape, so this builds the
 * BODY TEXT `SkillIndex`'s own synthetic-entry seam (`SkillIndexOptions.syntheticSkills`) stores for
 * `Skill("<name>")` to return -- the WS-11 §2.3 contract ("invocation inserts the resolved skill
 * instructions into the main conversation") applied to a workflow instead of a SKILL.md body.
 *
 * THE PROMPT TEXT IS WINTER-AUTHORED, per the user's own ruling that prompts stay Winter's own
 * wording while INTERFACE strings (a field name, a listing label, an error message) may ship
 * verbatim from the pinned binary -- this is prompt content the model reads and acts on, not an
 * interface string, so it is worded fresh here rather than reproduced from the dump. The
 * STRUCTURE claude's own `m()` carries (name, description, `whenToUse`, phases, then the invoke
 * instruction) is preserved; the wording is not claude's.
 *
 * Fix round 5 (promoted minor, the re-review of 57e7fef..20b623e): `/plugin:name some args` must
 * carry `some args` into the invoke line as `Workflow({ name, args })`, matching claude. This
 * body is a SINGLE static string shared by BOTH the `Skill` tool door and the `/name args`
 * slash-command door -- and only the LATTER substitutes `$ARGUMENTS`/`$ARGUMENTS_JSON`
 * (`commands/resolver.ts`'s own "DISCLOSED ASYMMETRY" header: the Skill tool hands a body over
 * verbatim, never substituting). Baking an args token into the ONE unconditional invoke line would
 * leave it literal, unsubstituted, in what the model sees through the Skill-tool door, which is
 * worse than dropping args entirely. So the args-carrying line is a SECOND, explicitly CONDITIONAL
 * sentence: it still contains the literal token (nothing else can make the slash-command door's
 * substitution reach it), but is worded so a model reading it unsubstituted (the Skill-tool door, or
 * a bare `/name` with nothing after it, where the tokens substitute to `""`/`'""'`) recognises it
 * does not apply and falls back to the first, unconditional line instead.
 *
 * Fix round 6 (a promoted minor, the re-review against the pinned 2.1.250 dump): the args value must
 * be ESCAPED the way claude's own `S(e)` does, matching `createWorkflowCommand`'s
 * `getPromptForCommand` (dump-confirmed: `a=e?\`{ name: ${i}, args: ${S(e)} }\`:...\`, i=S(o.name)`
 * -- inferred to be JSON-string-quoting from the call-site shape: applied to a plain, always-defined
 * string, used with no additional quotes around it). Using the RAW `$ARGUMENTS` token inside
 * hand-written quotes (round 5's own shape) would let a literal `"` or `\` in the typed args break
 * out of the quoted literal. `$ARGUMENTS_JSON` (`commands/resolver.ts`'s new second token) substitutes
 * with `JSON.stringify(args)` instead -- already quoted and escaped -- so this line writes NO quotes
 * of its own around it.
 */
export function buildWorkflowSkillPrompt(entry: WorkflowListingEntry): string {
  const lines: string[] = [`This skill runs the "${entry.name}" workflow.`, "", entry.description];
  if (entry.whenToUse !== undefined && entry.whenToUse.length > 0) {
    lines.push("", `When to use it: ${entry.whenToUse}`);
  }
  if (entry.phases !== undefined && entry.phases.length > 0) {
    lines.push("", "Phases:");
    entry.phases.forEach((phase, index) => {
      lines.push(`${index + 1}. ${phase.title}${phase.detail !== undefined && phase.detail.length > 0 ? ` — ${phase.detail}` : ""}`);
    });
  }
  lines.push("", `To run it, call the Workflow tool with this exact name: Workflow({ name: ${JSON.stringify(entry.name)} })`);
  lines.push(
    `If this was invoked as a slash command with text after the name, pass that text through as args instead: Workflow({ name: ${JSON.stringify(entry.name)}, args: $ARGUMENTS_JSON })`,
  );
  return lines.join("\n");
}

// --- Persistence (WS-11 §1.3 + capture (3)) -------------------------------------------------------
//
// "Every invocation automatically persists its script under the session's durable area and returns
// the path in the tool result; iteration is `Edit` on that file + re-invoke with `{ scriptPath }`."
//
// THE PATH IS NOT NEGOTIABLE. Capture (3) walked all three temp roots of the pinned runtime and found
// the file at exactly one place, and RULING P5-B carved a model-writable hole in the P4-M write floor
// with the SAME six fixed positions. Persisting one segment off does not merely mismatch the pin --
// it lands outside the carve-out, where the baseline deny rules make the file unwritable, and the
// documented edit-then-rerun loop silently stops working.

export interface SessionScriptLocation {
  /** The resolved winter root in production (`resolveWinterHome()`), whose `projects/` child this addresses. */
  winterHome: string;
  projectKey: string;
  /** The session UUID -- the `<session-uuid>` segment of capture (3)'s path. */
  sessionId: string;
}

function sessionDir(loc: SessionScriptLocation): string {
  return join(loc.winterHome, "projects", loc.projectKey, loc.sessionId);
}

/** Winter-owned tree, 0700 throughout (WS-05 §9), same rule as every other directory this codebase creates. */
function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * A meta name is model-supplied and becomes a FILENAME. The name has already passed the meta
 * parser, which does not constrain its characters at all -- so it is sanitized here rather than
 * trusted. Anything outside the slug alphabet collapses to `-`, which cannot climb a directory.
 */
function sanitizeFileStem(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "workflow" : cleaned.slice(0, 80);
}

export interface PersistWorkflowScriptInput extends SessionScriptLocation {
  /** `meta.name` (capture (3): `<meta.name>-<runId>.js`). */
  name: string;
  runId: string;
  source: string;
}

/** Writes the script and returns its absolute path. Overwrites for the same run, so one run keeps one path. */
export function persistWorkflowScript(input: PersistWorkflowScriptInput): string {
  const dir = join(sessionDir(input), "workflows", "scripts");
  ensureDir(dir);
  const path = join(dir, `${sanitizeFileStem(input.name)}-${input.runId}.js`);
  writeFileSync(path, input.source, { mode: 0o600 });
  return path;
}

/** Capture (3)'s sibling: `<session>/subagents/workflows/<runId>` -- what `WorkflowOutput.transcriptDir` reports. */
export function workflowTranscriptDir(input: SessionScriptLocation & { runId: string }): string {
  return join(sessionDir(input), "subagents", "workflows", input.runId);
}

/**
 * The JOURNAL root -- under the SESSION TEMP directory, not the durable projects area.
 *
 * Deliberate, and disclosed. `resumeFromRunId` is SAME-SESSION-ONLY by contract (WS-11 §1.5,
 * `sdk-tools.d.ts:2786`), so a journal has no job to do once the session ends; capture (3) pinned the
 * durable location of the SCRIPT and says nothing about a journal; and WS-01 forbids inventing a new
 * durable directory name. Session temp is the D18 layout's own answer for per-session working state.
 */
export function workflowRunsDir(sessionTempDir: string): string {
  return join(sessionTempDir, "workflows", "runs");
}
