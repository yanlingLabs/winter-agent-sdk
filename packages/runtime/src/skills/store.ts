// Phase 5 Lane S (WS-11 §2.1/§2.5): the SKILL INDEX -- a name+description metadata index built at
// startup, with bodies loaded lazily on invocation.
//
// "LAZILY" IS A HARD CONTRACT, NOT AN OPTIMISATION (report §59): a skill body must never be
// bulk-injected into every model call, so this index deliberately does not RETAIN bodies at all --
// `load(name)` re-reads the file at invocation time. The fixture that pins it edits a SKILL.md after
// the index is built and asserts `load()` returns the NEW text; an implementation that cached bodies
// would pass every other test in the file and fail that one.
//
// SOURCE GATING, not trust gating (WS-11 Phase-5 amendment (b)): project skills load iff
// `project ∈ settingSources`; user skills iff `user ∈ settingSources`. Project AGENT definitions stay
// trust-gated (R4-7, subagents/definitions.ts) -- the two gates are deliberately different and must
// not be conflated. `settingSources: undefined` means all three tiers (settings/types.ts's own
// SETTING_SOURCES doc); `[]` disables filesystem discovery entirely, which is the hermetic-host mode
// WS-01 §2.4 names.
//
// Plugin and builtin tiers are NOT source-gated: a plugin is loaded because the HOST listed it in
// `Options.plugins`, a decision made outside the repository (the same reasoning
// subagents/definitions.ts records for `pluginAgents`), and builtins ship with the runtime.
import { join } from "node:path";
import type { SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { DEFAULT_SKILL_BODY_BYTES, capBytes, skillNameError, pluginNameError } from "./frontmatter.ts";
import { SELF_SUBDIR, projectSkillRoots, readSkillMetadata, scanSkillRoot, scanUserSkillRoot, type DiscoveredSkill, type SkillTier } from "./loader.ts";
import { isStrictPluginOnly, type StrictPluginOnlyCustomization } from "../settings/loaders/strict-plugin-only.ts";

/**
 * WS-01 §2.4 / WS-11 §4: `.winter` IS the canonical plugin name for the project dot-directory. The
 * official branch loads `<project>/.winter` as a local plugin, so ITS skills are `.winter:<skill>`;
 * Winter-native discovery reads the same tree directly as the `project` tier.
 *
 * DISCLOSED JUDGMENT CALL (report): a project skill is therefore given TWO names -- its bare name
 * (its primary identity, what the listing shows and what `/name` uses) and `.winter:<name>` as an
 * ALIAS. Both resolve through `get()`/`load()` and both are matched by a permission rule
 * (permission-rules.ts), which is what WS-11 §4's "permission rules match identically across
 * branches" requires operationally. The alternative readings each break something: bare-only makes
 * a `Skill(.winter:review)` rule written against the official branch inert here, and
 * qualified-only makes `/review` and `Skill("review")` stop working for every project skill.
 */
export const PROJECT_PLUGIN_NAME = ".winter";

export interface SkillMeta {
  name: string;
  description: string;
  source: SkillTier;
  path: string;
  author?: string;
  plugin?: string;
  /** Every OTHER name this skill answers to (see PROJECT_PLUGIN_NAME). Never includes `name`. */
  aliases?: string[];
}

/** One plugin's contribution, pre-parsed by plugins/loader.ts -- this file never reads a plugin manifest. */
export interface PluginSkillContribution {
  plugin: string;
  skills: Array<{ name: string; description: string; path: string; author?: string }>;
}

export interface SkillIndexOptions {
  cwd: string;
  /** The `~/.winter` root. ALWAYS explicit -- this module never reads `process.env` (tests would race). */
  home: string;
  /** Omitted = all three tiers; `[]` = filesystem discovery disabled. */
  settingSources?: SettingSource[] | undefined;
  plugins?: readonly PluginSkillContribution[] | undefined;
  /**
   * The BUILTIN registry seam. Winter ships no bundled skills at P5 -- this is deliberately an empty
   * default rather than a directory scan, so the tier EXISTS (listing, precedence, the
   * `disableBundledSkills` gate) without inventing content. Disclosed in the report.
   */
  builtinSkills?: readonly DiscoveredSkill[] | undefined;
  /** `Settings.disableBundledSkills` (`sdk.d.ts:5657`). Removes the builtin tier and nothing else. */
  disableBundledSkills?: boolean | undefined;
  /**
   * `Settings.strictPluginOnlyCustomization` (`sdk.d.ts:5988`). When it covers `"skills"`, ONLY
   * plugin-contributed skills load -- project, user, self and builtin are all excluded. Distinct
   * from source gating: `settingSources` says which settings FILES load, this says which
   * customization SOURCES may customize at all.
   */
  strictPluginOnlyCustomization?: StrictPluginOnlyCustomization | undefined;
  bodyBytes?: number | undefined;
}

function sourcesAllow(settingSources: SettingSource[] | undefined, tier: SettingSource): boolean {
  return settingSources === undefined || settingSources.includes(tier);
}

/**
 * Discovery order IS precedence order (first occurrence of a name wins), matching Norma's
 * `SkillStore.discover`: project (nearest .winter first) > user > self > plugin > builtin. A builtin
 * is therefore shadowable by any other tier, which is the point of shipping one.
 */
function discover(opts: SkillIndexOptions): DiscoveredSkill[] {
  const all: DiscoveredSkill[] = [];
  const pluginOnly = isStrictPluginOnly(opts.strictPluginOnlyCustomization, "skills");
  if (!pluginOnly && sourcesAllow(opts.settingSources, "project")) {
    for (const root of projectSkillRoots(opts.cwd)) all.push(...scanSkillRoot(root, "project"));
  }
  if (!pluginOnly && sourcesAllow(opts.settingSources, "user")) {
    const userRoot = join(opts.home, ".winter", "skills");
    all.push(...scanUserSkillRoot(userRoot));
    all.push(...scanSkillRoot(join(userRoot, SELF_SUBDIR), "self"));
  }
  for (const contribution of opts.plugins ?? []) {
    if (pluginNameError(contribution.plugin) !== null) continue; // a plugin name that could traverse never becomes a qualified skill name
    for (const skill of contribution.skills) {
      all.push({
        name: `${contribution.plugin}:${skill.name}`,
        description: skill.description,
        source: "plugin",
        path: skill.path,
        plugin: contribution.plugin,
        ...(skill.author !== undefined ? { author: skill.author } : {}),
      });
    }
  }
  if (!pluginOnly && opts.disableBundledSkills !== true) all.push(...(opts.builtinSkills ?? []));
  return all;
}

/**
 * The startup index. Immutable once built: a session's skill surface is resolved at start, never
 * re-scanned mid-turn (the pinned branch reloads on an explicit control request, never on a watcher
 * -- derived-shapes-p5 item (b); Winter's own "no watchers inside the SDK" rule agrees).
 */
export class SkillIndex {
  private readonly entries: SkillMeta[];
  private readonly byName: Map<string, SkillMeta>;
  private readonly bodyBytes: number;

  private constructor(entries: SkillMeta[], byName: Map<string, SkillMeta>, bodyBytes: number) {
    this.entries = entries;
    this.byName = byName;
    this.bodyBytes = bodyBytes;
  }

  static build(opts: SkillIndexOptions): SkillIndex {
    const entries: SkillMeta[] = [];
    const byName = new Map<string, SkillMeta>();
    for (const found of discover(opts)) {
      const bare = found.source === "plugin" ? found.name.slice(found.name.indexOf(":") + 1) : found.name;
      // The jail is applied to the RESOLVED skill name -- the one anything can actually reach --
      // rather than to the directory it came from (loader.ts's own header records why).
      if (skillNameError(bare) !== null) continue;
      if (byName.has(found.name)) continue; // first occurrence wins
      const aliases = found.source === "project" ? [`${PROJECT_PLUGIN_NAME}:${found.name}`] : [];
      const meta: SkillMeta = {
        name: found.name,
        description: found.description,
        source: found.source,
        path: found.path,
        ...(found.author !== undefined ? { author: found.author } : {}),
        ...(found.plugin !== undefined ? { plugin: found.plugin } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
      };
      entries.push(meta);
      byName.set(meta.name, meta);
      // An alias never DISPLACES a real name: if `.winter:review` is already a plugin skill's own
      // primary name, the project skill keeps its bare identity and simply has no alias slot.
      for (const alias of aliases) if (!byName.has(alias)) byName.set(alias, meta);
    }
    return new SkillIndex(entries, byName, opts.bodyBytes ?? DEFAULT_SKILL_BODY_BYTES);
  }

  /** Every skill, in precedence order, by PRIMARY name. Aliases are not separate entries. */
  list(): SkillMeta[] {
    return this.entries.slice();
  }

  /** Primary names only, in precedence order -- the `system/init.skills` producer's input. */
  names(): string[] {
    return this.entries.map((s) => s.name);
  }

  /** Resolve a name OR an alias to its metadata. */
  get(name: string): SkillMeta | undefined {
    return this.byName.get(name);
  }

  /** Every name a skill answers to (primary first) -- what a permission rule is matched against. */
  identities(name: string): string[] {
    const meta = this.byName.get(name);
    if (!meta) return [];
    return [meta.name, ...(meta.aliases ?? [])];
  }

  /**
   * Read a skill's body FROM DISK, byte-capped. `null` for an unknown name and for a skill whose
   * file has since been deleted, moved or made unparseable -- an invocation must degrade to a typed
   * tool error, never crash the turn.
   */
  load(name: string): { name: string; body: string; source: SkillTier; path: string } | null {
    const meta = this.byName.get(name);
    if (!meta) return null;
    const parsed = readSkillMetadata(meta.path, meta.name);
    if (!parsed) return null;
    return { name: meta.name, body: capBytes(parsed.body, this.bodyBytes), source: meta.source, path: meta.path };
  }
}
