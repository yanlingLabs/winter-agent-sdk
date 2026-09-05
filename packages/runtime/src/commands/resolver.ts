// Phase 5 Lane S (WS-11 §2.4, RULING R5-14): the FILESYSTEM `CommandResolver` -- `.winter/commands/
// <name>.md` and `.winter/skills/<name>/SKILL.md` both create `/name`.
//
// THREE THINGS THE SPINE ALREADY DECIDED, restated so this file is not read as re-deciding them
// (commands/seam.ts):
//   1. The ENGINE recognises its own built-ins FIRST. Only an unclaimed `/name` reaches here, so a
//      `.winter/commands/compact.md` in an untrusted clone can never shadow `/compact`. This file
//      never produces the `builtin` arm.
//   2. `$ARGUMENTS` substitution is THIS resolver's job. `expand.text` is the FULLY expanded prompt;
//      the engine substitutes nothing, so a half-implementation cannot be papered over downstream.
//   3. A prompt not starting with `/` never reaches a resolver -- resolution is not a general
//      prompt-rewriting hook.
//
// OVERLAP (`/review` as both a skill and a command file): THE SKILL WINS, and the resolution's
// `source` says which file answered. DISCLOSED CONFLICT, raised in the task-5 report: the task-5
// brief's own checklist line reads "skill wins? -- T1 (i) decides; else commands win", and item (i)
// turned out to be uncaptured (there is no `Skill` tool schema and no attachment entry in the pinned
// declaration at all), so the tie-break fell to the controller, whose dispatch says SKILL WINS.
// Recorded here because the two documents disagree in writing.
//
// WHY THE SKILL IS THE BETTER LOSER-OF-THE-TWO ANYWAY: a skill is the surface the MODEL also sees
// (it is in the listing and invocable through the Skill tool), so `/review` and `Skill("review")`
// delivering different text would be a genuine split brain. A command file has no second entry
// point, so it has nothing to disagree with.
//
// DISCLOSED ASYMMETRY BETWEEN THE SKILL'S OWN TWO DOORS (fix round 1, Minor 3): `$ARGUMENTS` IS
// substituted here, on the `/name args` door, and is NOT substituted by the `Skill` tool
// (tools/impl/skill.ts), which hands the body over verbatim and reports `args` on the
// `invoked_skills` attachment instead. So one skill body can produce two texts. This is DELIBERATE
// for now, not an oversight: R5-14 pins substitution for `/name args` and nothing else, and item (i)
// found there is no `Skill` tool schema in the pinned declaration at all, so what `args` MEANS on the
// tool door is uncaptured -- substituting there would be Winter inventing a semantic the pin has not
// been observed to have, on the door a MODEL drives. The `/name` door is a human typing arguments
// into a template; the tool door is a model that already has the arguments in its own context.
// CAPTURE-PENDING: if a differential capture shows the pinned Skill tool substituting, this becomes a
// one-line change in tools/impl/skill.ts and the two doors converge.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { isUserInvocable, type SkillOverrides } from "../skills/listing.ts";
import { projectSkillRoots } from "../skills/loader.ts";
import type { SkillIndex } from "../skills/store.ts";
import { looksLikeCommand, type CommandResolution, type CommandResolver } from "./seam.ts";

/**
 * Where a `/name` came from. `"builtin"` is the ENGINE's own (commands/seam.ts), never this
 * resolver's; `"skill"` covers every skill tier, since the skill index has already ranked those.
 */
export type SlashCommandOrigin = "builtin" | "project" | "user" | "plugin" | "skill";

export interface SlashCommandInfo {
  name: string;
  description?: string;
  /** `SlashCommand.argumentHint` (`sdk.d.ts:7932-7949`). */
  argumentHint?: string;
  source: SlashCommandOrigin;
}

/** One plugin's commands, pre-resolved by plugins/loader.ts. `name` is the BARE name; qualification happens here. */
export interface PluginCommandContribution {
  plugin: string;
  commands: Array<{ name: string; path: string; description?: string; argumentHint?: string }>;
}

export interface FilesystemCommandResolverOptions {
  cwd: string;
  /** The RESOLVED `~/.winter` root (`WINTER_HOME` when set) -- see `SkillIndexOptions.winterHome` for why this is not called `home`. */
  winterHome: string;
  settingSources?: SettingSource[] | undefined;
  /** The session's skill index. Skills create `/name` too (WS-11 §2.4) and WIN an overlap. */
  skills?: SkillIndex | undefined;
  plugins?: readonly PluginCommandContribution[] | undefined;
  skillOverrides?: SkillOverrides | undefined;
}

interface CommandFile {
  name: string;
  path: string;
  source: SlashCommandOrigin;
  description?: string;
  argumentHint?: string;
}

/**
 * A command file's optional frontmatter. Separate from `skills/frontmatter.ts` (whose contract is
 * "no description means not a skill") and from `subagents/definitions.ts`'s `parseFrontmatter`
 * (whose key regex excludes the hyphen `argument-hint` needs). A command file with NO frontmatter is
 * entirely valid -- the whole file is the prompt.
 */
function parseCommandFile(raw: string): { body: string; description?: string; argumentHint?: string } {
  if (!raw.startsWith("---")) return { body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { body: raw };
  const attrs: Record<string, string> = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    attrs[m[1]!.toLowerCase()] = v;
  }
  const afterFence = raw.slice(end + 4);
  const eol = afterFence.indexOf("\n");
  const body = (eol === -1 ? "" : afterFence.slice(eol + 1)).replace(/^\r?\n/, "");
  return {
    body,
    ...(attrs["description"] !== undefined ? { description: attrs["description"] } : {}),
    ...(attrs["argument-hint"] !== undefined ? { argumentHint: attrs["argument-hint"] } : {}),
  };
}

/**
 * Scan one `commands/` directory. FLAT ONLY -- a nested `commands/<dir>/<name>.md` is NOT discovered.
 * DISCLOSED SCOPE LIMIT (report): the pinned branch namespaces nested command files as
 * `<dir>:<name>`, which is the SAME spelling this resolver already uses for plugin qualification, so
 * a guessed implementation could silently shadow a plugin's command. An absent feature is
 * recoverable; a colliding namespace is not.
 */
function scanCommandDir(dir: string, source: SlashCommandOrigin): CommandFile[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: CommandFile[] = [];
  for (const file of names) {
    const path = join(dir, file);
    const meta = readCommandMeta(path);
    if (!meta) continue;
    out.push({
      name: basename(file, ".md"),
      path,
      source,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.argumentHint !== undefined ? { argumentHint: meta.argumentHint } : {}),
    });
  }
  return out;
}

function readCommandMeta(path: string): { description?: string; argumentHint?: string } | undefined {
  const raw = readCommandBody(path);
  if (raw === undefined) return undefined;
  const parsed = parseCommandFile(raw);
  return { ...(parsed.description !== undefined ? { description: parsed.description } : {}), ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}) };
}

function readCommandBody(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function sourcesAllow(settingSources: SettingSource[] | undefined, tier: SettingSource): boolean {
  return settingSources === undefined || settingSources.includes(tier);
}

/**
 * Split `/name rest` into its parts. `looksLikeCommand` (the spine's) decides whether a prompt is a
 * candidate at all; this only splits one that is.
 *
 * ARGUMENTS ARE TAKEN VERBATIM after the first whitespace run and trimmed at the ends only -- inner
 * spacing is preserved, because a command body may legitimately paste `$ARGUMENTS` into something
 * whitespace-sensitive.
 */
function splitCommand(prompt: string): { name: string; args: string } {
  const trimmed = prompt.trimEnd();
  const firstSpace = trimmed.search(/\s/);
  const name = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).slice(1);
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();
  return { name, args };
}

/** R5-14's substitution, in one place. Every occurrence; no arguments substitutes the empty string. */
export function substituteArguments(body: string, args: string): string {
  return body.split("$ARGUMENTS").join(args);
}

/**
 * One entry of the resolver's single ordered enumeration -- the shared source of truth `list()` and
 * `resolve()` are both views of (fix round 1, Medium 1).
 *
 * `kind: "blocked"` is a name a skill CLAIMS but nobody may answer: an `off` skill. It is neither
 * listed nor resolvable, and it stops a same-named command file from claiming the name behind it.
 */
type EnumeratedCommand =
  | { kind: "skill"; name: string; description: string }
  | { kind: "file"; name: string; file: CommandFile }
  | { kind: "blocked"; name: string };

export class FilesystemCommandResolver implements CommandResolver {
  private readonly opts: FilesystemCommandResolverOptions;
  /**
   * The enumeration, memoized per `cwd`. `resolve()` receives a cwd (the spine's own signature) and a
   * session's cwd genuinely moves -- EnterWorktree relocates the session root -- so a set fixed at
   * construction would go stale for COMMAND FILES. SKILLS deliberately do NOT follow the cwd: they
   * come from the index built once at startup, which is the same set the model sees in its listing
   * and through the Skill tool. `/review` and `Skill("review")` resolving to different files would be
   * the split brain the overlap rule exists to prevent.
   */
  private readonly byCwd = new Map<string, Map<string, EnumeratedCommand>>();

  private constructor(opts: FilesystemCommandResolverOptions) {
    this.opts = opts;
  }

  static build(opts: FilesystemCommandResolverOptions): FilesystemCommandResolver {
    return new FilesystemCommandResolver(opts);
  }

  private scanCommandFiles(cwd: string): CommandFile[] {
    const found: CommandFile[] = [];
    if (sourcesAllow(this.opts.settingSources, "project")) {
      // Same parent-walk as the skills project tier, so `/name` and a skill of the same name are
      // discovered over the identical directory set (skills/loader.ts owns the walk).
      for (const skillRoot of projectSkillRoots(cwd)) {
        found.push(...scanCommandDir(join(skillRoot, "..", "commands"), "project"));
      }
    }
    if (sourcesAllow(this.opts.settingSources, "user")) {
      found.push(...scanCommandDir(join(this.opts.winterHome, "commands"), "user"));
    }
    for (const contribution of this.opts.plugins ?? []) {
      for (const command of contribution.commands) {
        found.push({
          name: `${contribution.plugin}:${command.name}`,
          path: command.path,
          source: "plugin",
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
        });
      }
    }
    return found;
  }

  /**
   * THE single ordered enumeration. Insertion order IS precedence: skills first (the overlap rule),
   * then command files (project nearest-first > user > plugin), first occurrence of a name winning.
   *
   * WHY ONE FUNCTION AND NOT TWO LOOPS. `list()` and `resolve()` used to walk opposite orders. For a
   * name held by both a skill and a command file, `resolve()` returned the skill's body while the
   * listing reported the command FILE's description, argument hint and source -- and an `off` skill
   * put a name into `system/init.slash_commands` that `resolve()` answered `none` to, advertising a
   * command nothing could run. Two orders over one namespace cannot be kept in agreement by care;
   * they have to be one enumeration.
   */
  private enumerate(cwd: string): Map<string, EnumeratedCommand> {
    const cached = this.byCwd.get(cwd);
    if (cached) return cached;
    const map = new Map<string, EnumeratedCommand>();
    for (const skill of this.opts.skills?.list() ?? []) {
      if (map.has(skill.name)) continue;
      // `off` CLAIMS the name without answering it: `off` means off, and letting a same-named command
      // file answer instead would silently substitute a different producer's text for a skill the
      // user deliberately disabled. `user-invocable-only` is the opposite -- it removes a skill from
      // the MODEL's door and this is exactly the door it keeps (listing.ts).
      map.set(skill.name, isUserInvocable(this.opts.skillOverrides, skill) ? { kind: "skill", name: skill.name, description: skill.description } : { kind: "blocked", name: skill.name });
    }
    for (const file of this.scanCommandFiles(cwd)) {
      if (map.has(file.name)) continue;
      map.set(file.name, { kind: "file", name: file.name, file });
    }
    this.byCwd.set(cwd, map);
    return map;
  }

  /** Every `/name` this resolver answers to, in enumeration order. Feeds `system/init.slash_commands`. */
  list(cwd?: string): SlashCommandInfo[] {
    const out: SlashCommandInfo[] = [];
    for (const entry of this.enumerate(cwd ?? this.opts.cwd).values()) {
      if (entry.kind === "blocked") continue;
      if (entry.kind === "skill") {
        out.push({ name: entry.name, description: entry.description, source: "skill" });
        continue;
      }
      const { file } = entry;
      out.push({
        name: file.name,
        ...(file.description !== undefined ? { description: file.description } : {}),
        ...(file.argumentHint !== undefined ? { argumentHint: file.argumentHint } : {}),
        source: file.source,
      });
    }
    return out;
  }

  async resolve(prompt: string, cwd: string): Promise<CommandResolution> {
    if (!looksLikeCommand(prompt)) return { kind: "none" };
    const { name, args } = splitCommand(prompt);
    if (name.length === 0) return { kind: "none" };

    const entry = this.enumerate(cwd).get(name);
    if (entry === undefined || entry.kind === "blocked") return { kind: "none" };

    if (entry.kind === "skill") {
      const loaded = this.opts.skills?.load(name);
      // A skill whose file VANISHED since indexing answers `none` -- it does NOT hand the name to a
      // command file behind it (fix round 1, Minor 4). The enumeration decides who owns a name, and
      // ownership must not change because a file disappeared mid-session: that is exactly the
      // listing/resolve divergence this round closed, displaced in time. `none` means "no command
      // answered", the same thing an unknown `/name` means, and the prompt is used verbatim.
      if (!loaded) return { kind: "none" };
      return { kind: "expand", text: substituteArguments(loaded.body, args), source: loaded.path };
    }

    const raw = readCommandBody(entry.file.path);
    if (raw === undefined) return { kind: "none" }; // deleted since discovery -- never a throw
    return { kind: "expand", text: substituteArguments(parseCommandFile(raw).body, args), source: entry.file.path };
  }
}
