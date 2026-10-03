// Phase 5 Lane S (WS-11 §2.4, RULING R5-14): the FILESYSTEM `CommandResolver` -- a project
// `commands/<name>.md` and a project `skills/<name>/SKILL.md` both create `/name`.
//
// THREE THINGS THE SPINE ALREADY DECIDED, restated so this file is not read as re-deciding them
// (commands/seam.ts):
//   1. The ENGINE recognises its own built-ins FIRST. Only an unclaimed `/name` reaches here, so a
//      a checked-in `commands/compact.md` in an untrusted clone can never shadow `/compact`. This file
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
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { BrandProfile, SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { escapeRegExpLiteral, shellWords } from "../permissions/grammar.ts";
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
  /** The RESOLVED winter root (`<PREFIX>HOME` when set) -- see `SkillIndexOptions.winterHome` for why this is not called `home`. */
  winterHome: string;
  /** P7a (D19): the session's brand -- the project dot-dir the project tier walks. Omitted = `WINTER_BRAND`. */
  brand?: Pick<BrandProfile, "projectDirName"> | undefined;
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
 * Admit a `readdirSync` entry as a command file, WS-21 §6.3 item 1 (F6, F7): claude follows a
 * symlinked command `.md` the same way it follows a symlinked skill directory. A dangling link, or
 * a link to a non-file, is excluded silently.
 */
function isFileEntry(dir: string, e: Dirent): boolean {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, e.name)).isFile();
  } catch {
    return false;
  }
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
      .filter((e) => e.name.endsWith(".md") && isFileEntry(dir, e))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: CommandFile[] = [];
  for (const file of names) {
    const stem = basename(file, ".md");
    // WHOLE-BRANCH MINOR m2: a command file's stem is a NAMESPACE, not just a label. Plugin commands
    // are `<plugin>:<name>`, and enumeration is skills -> project/user FILES -> plugin with
    // first-wins -- so a checked-in project `commands/acme:ship.md` reached the map before the
    // operator's own installed `acme` plugin and took its qualified name. `/acme:ship` then ran text
    // from a cloned repository under the identity of software the user chose to install. P5-H's
    // shadowing inversion, arriving through the plugin dimension.
    //
    // DELIBERATELY NARROWER THAN THE REVIEW'S SUGGESTED FIX, which was to jail stems to the skill
    // slug alphabet (`isLegalSkillIdentity`). That alphabet is `/^[a-z0-9][a-z0-9-]{0,63}$/` --
    // lowercase, digits and hyphens only -- so adopting it would also silently stop loading every
    // `Fix_Bug.md`, `Deploy.md` or `run_tests.md` that works today. Those names claim nothing and
    // endanger nothing; the colon is the entire vulnerability, because the colon is the only
    // character that carries namespace meaning. A jail should cost exactly what the threat costs.
    // (Path traversal needs no rule here: every `path` is built from `readdirSync` output, never
    // from a declared name.) The second m2 fixture pins the non-regression.
    if (stem.includes(":")) continue;
    const path = join(dir, file);
    const meta = readCommandMeta(path);
    if (!meta) continue;
    out.push({
      name: stem,
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

/** Expand `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, `$<namedArg>` and `\$` escapes in a `/name args` body (args are appended when nothing matched). `namedArgs` is not yet wired from frontmatter (WS-21 follow-up). */
export function substituteArguments(body: string, args: string, namedArgs: readonly string[] = []): string {
  const text = cleanNoncharacters(body);
  const wholeArgs = cleanNoncharacters(args);
  const words = shellWords(args).map((w) => cleanNoncharacters(w.word));

  // Declared names keep their original position (an empty name is dropped but still occupies its
  // slot); longest names are matched first so a name never loses its text to a shorter prefix of it.
  // `Array.prototype.sort` is stable, so equal lengths keep declaration order.
  const named = namedArgs
    .map((name, position) => ({ name, position }))
    .filter((n) => n.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);

  // Recognition runs one kind at a time, in priority order. Each match claims its characters, and a
  // later kind may only match wholly unclaimed text. Replacements are collected and applied at the
  // end, so inserted values are never scanned.
  const claimed = new Uint8Array(text.length);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let substitutions = 0;

  const isFree = (start: number, end: number): boolean => {
    for (let k = start; k < end; k++) if (claimed[k]) return false;
    return true;
  };
  const claim = (start: number, end: number, value: string): void => {
    claimed.fill(1, start, end);
    replacements.push({ start, end, value });
  };
  // "Followed by" looks at the cleaned body itself; the end of the body is neither a word char nor `[`.
  const endsCleanly = (at: number): boolean => at >= text.length || (text[at] !== "[" && !isWordChar(text.charCodeAt(at)));

  // 1. Escapes: `\$` (not preceded by another backslash) before a digit, `ARGUMENTS`, or a declared
  //    name that ends cleanly. The pair becomes a literal `$`.
  for (let i = text.indexOf("\\$"); i !== -1; i = text.indexOf("\\$", i + 1)) {
    if (i > 0 && text[i - 1] === "\\") continue;
    const after = i + 2;
    const escapes =
      isDigit(text.charCodeAt(after)) ||
      text.startsWith("ARGUMENTS", after) ||
      named.some((n) => text.startsWith(n.name, after) && endsCleanly(after + n.name.length));
    if (escapes) {
      claim(i, after, "$");
      i = after - 1; // the next search starts at `after`
    }
  }

  // 2. Named tokens, longest name first.
  for (const { name, position } of named) {
    const needle = "$" + name;
    for (let i = text.indexOf(needle); i !== -1; ) {
      const end = i + needle.length;
      if (isFree(i, end) && endsCleanly(end)) {
        claim(i, end, words[position] ?? "");
        substitutions++;
        i = text.indexOf(needle, end);
      } else {
        i = text.indexOf(needle, i + 1);
      }
    }
  }

  // 3. Indexed tokens `$ARGUMENTS[<digits>]`. Out of range stays literal but is still claimed.
  const INDEXED_PREFIX = "$ARGUMENTS[";
  for (let i = text.indexOf(INDEXED_PREFIX); i !== -1; ) {
    let j = i + INDEXED_PREFIX.length;
    while (isDigit(text.charCodeAt(j))) j++;
    const digitsStart = i + INDEXED_PREFIX.length;
    if (j > digitsStart && text[j] === "]" && isFree(i, j + 1)) {
      const index = Number(text.slice(digitsStart, j));
      const word = index < words.length ? words[index] : undefined;
      if (word !== undefined) {
        claim(i, j + 1, word);
        substitutions++;
      } else {
        claim(i, j + 1, text.slice(i, j + 1));
      }
      i = text.indexOf(INDEXED_PREFIX, j + 1);
    } else {
      i = text.indexOf(INDEXED_PREFIX, i + 1);
    }
  }

  // 4. Positional tokens: `$` plus the maximal digit run, which must not be followed by a word char.
  for (let i = text.indexOf("$"); i !== -1; ) {
    let j = i + 1;
    while (isDigit(text.charCodeAt(j))) j++;
    if (j > i + 1 && !isWordChar(text.charCodeAt(j)) && isFree(i, j)) {
      const index = Number(text.slice(i + 1, j));
      const word = index < words.length ? words[index] : undefined;
      if (word !== undefined) {
        claim(i, j, word);
        substitutions++;
      }
      // Out of range: left as written and unclaimed (no later kind can start with a digit run).
      i = text.indexOf("$", j);
    } else {
      i = text.indexOf("$", i + 1);
    }
  }

  // 5. Plain `$ARGUMENTS`, with no boundary check: the whole args.
  const PLAIN = "$ARGUMENTS";
  for (let i = text.indexOf(PLAIN); i !== -1; ) {
    const end = i + PLAIN.length;
    if (isFree(i, end)) {
      claim(i, end, wholeArgs);
      substitutions++;
      i = text.indexOf(PLAIN, end);
    } else {
      i = text.indexOf(PLAIN, i + 1);
    }
  }

  replacements.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const r of replacements) {
    out += text.slice(cursor, r.start) + r.value;
    cursor = r.end;
  }
  out += text.slice(cursor);

  if (substitutions === 0 && args.length > 0) out += "\nARGUMENTS: " + wholeArgs;
  return out;
}

/** Replace the two noncharacters U+FFFE and U+FFFF with U+FFFD. */
function cleanNoncharacters(s: string): string {
  return s.replace(/[￾￿]/g, "�");
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** ASCII word character: letters, digits and underscore. `NaN` (past the end) is not one. */
function isWordChar(code: number): boolean {
  return isDigit(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/**
 * The workflow-invoke-line substitution ONLY (fix round 7). `workflows/store.ts`'s
 * `buildWorkflowSkillPrompt` writes a static body whose invoke line carries the args as
 * `args: $ARGUMENTS_JSON`, and that value must arrive as a JSON string literal (quotes and
 * backslashes escaped) -- the same quoting claude uses for a workflow command's `args`. This function
 * is DELIBERATELY SEPARATE from `substituteArguments` (never merged into it again): only a synthetic,
 * workflow-backed skill body should ever have `$ARGUMENTS_JSON` recognised as a token at all; every
 * other command/skill body gets the ordinary substitution, where `$ARGUMENTS_JSON` is just
 * `$ARGUMENTS` followed by the literal text `_JSON`.
 *
 * A single left-to-right scan, not two `.split().join()` passes: `JSON.stringify(args)` can itself
 * contain the literal substring `$ARGUMENTS` (e.g. `args = "please pass $ARGUMENTS through"` stringifies
 * to `"please pass $ARGUMENTS through"`), and a later, separate `$ARGUMENTS` pass over that already-
 * substituted text would incorrectly re-substitute what the JSON pass just inserted. Scanning once,
 * left to right, and advancing past whatever was just written never re-visits inserted text.
 */
export function substituteWorkflowArguments(body: string, args: string): string {
  const JSON_TOKEN = "$ARGUMENTS_JSON";
  const PLAIN_TOKEN = "$ARGUMENTS";
  let out = "";
  let i = 0;
  while (i < body.length) {
    if (body.startsWith(JSON_TOKEN, i)) {
      out += JSON.stringify(args);
      i += JSON_TOKEN.length;
    } else if (body.startsWith(PLAIN_TOKEN, i)) {
      out += args;
      i += PLAIN_TOKEN.length;
    } else {
      out += body[i];
      i++;
    }
  }
  return out;
}

/**
 * One entry of the resolver's single ordered enumeration -- the shared source of truth `list()` and
 * `resolve()` are both views of (fix round 1, Medium 1).
 *
 * `kind: "skill"` carries BOTH the name this entry is reached by and the skill's PRIMARY name, so an
 * alias entry loads the same body its primary does. `listed` is false for an alias: an alias is
 * RESOLVABLE BUT NEVER ADVERTISED (fix round 2, Medium A).
 *
 * `kind: "blocked"` is a name a skill CLAIMS but nobody may answer: an `off` skill, and every alias
 * of one. It is neither listed nor resolvable, and it stops a same-named command file from claiming
 * the name behind it.
 */
type EnumeratedCommand =
  | { kind: "skill"; name: string; primary: string; description: string; listed: boolean }
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
      for (const skillRoot of projectSkillRoots(cwd, this.opts.brand)) {
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
      const invocable = isUserInvocable(this.opts.skillOverrides, skill);
      // EVERY IDENTITY, not just the primary name (fix round 2, Medium A). `skills.list()` returns
      // primary names only; the `.winter:<skill>` aliases live in the index's own name map, which the
      // pre-enumeration `resolve()` reached through `get()`. Seeding only primaries silently dropped
      // `/<projectDir>:review` -- and worse, left the qualified name UNCLAIMED, so a plugin named after the project dot-dir
      // contributing a command `review` answered it with a command file: the P5-H inversion this
      // resolver exists to prevent, re-opened in the alias dimension. An alias claims its name here
      // for exactly the same reason a primary does.
      const identities = [skill.name, ...(skill.aliases ?? [])];
      for (let i = 0; i < identities.length; i++) {
        const identity = identities[i]!;
        if (map.has(identity)) continue;
        // `off` CLAIMS the name without answering it -- primary AND aliases: `off` means off, and
        // letting a same-named command file answer instead would silently substitute a different
        // producer's text for a skill the user deliberately disabled. `user-invocable-only` is the
        // opposite -- it removes a skill from the MODEL's door and this is exactly the door it keeps
        // (listing.ts).
        map.set(
          identity,
          invocable
            ? { kind: "skill", name: identity, primary: skill.name, description: skill.description, listed: i === 0 }
            : { kind: "blocked", name: identity },
        );
      }
    }
    for (const file of this.scanCommandFiles(cwd)) {
      if (map.has(file.name)) continue;
      map.set(file.name, { kind: "file", name: file.name, file });
    }
    this.byCwd.set(cwd, map);
    return map;
  }

  /**
   * Every `/name` this resolver ADVERTISES, in enumeration order. Feeds `system/init.slash_commands`.
   *
   * PER CWD (fix round 2, Minor B): command files are discovered by a parent-walk from the cwd, so
   * the answer differs between cwds and `cwd` defaults to the CONSTRUCTION cwd, not the live one.
   * A caller must feed the SAME cwd to `list()` and `resolve()` for the "everything listed resolves"
   * invariant to hold -- `slashCommandNames(resolver, cwd)` exists for exactly that.
   *
   * ALIASES ARE NOT LISTED (Medium A): `/.winter:review` resolves, but `slash_commands` carries
   * `review` alone. Advertising both would double every project skill in the init frame and imply two
   * commands where there is one.
   */
  list(cwd?: string): SlashCommandInfo[] {
    const out: SlashCommandInfo[] = [];
    for (const entry of this.enumerate(cwd ?? this.opts.cwd).values()) {
      if (entry.kind === "blocked") continue;
      if (entry.kind === "skill") {
        if (!entry.listed) continue; // an alias resolves but is never advertised
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
      // By the PRIMARY name. DEFENSIVE, and honestly labelled: `SkillIndex.load()` is itself
      // alias-aware, so `load(entry.name)` returns the same thing today -- a revert probe confirms no
      // fixture discriminates the two. `primary` is kept because it makes this entry self-describing
      // (an alias entry says which skill owns it without a second lookup) and because it stops this
      // door from depending on the index's name map staying alias-resolving.
      const loaded = this.opts.skills?.load(entry.primary);
      // A skill whose file VANISHED since indexing answers `none` -- it does NOT hand the name to a
      // command file behind it (fix round 1, Minor 4). The enumeration decides who owns a name, and
      // ownership must not change because a file disappeared mid-session: that is exactly the
      // listing/resolve divergence this round closed, displaced in time. `none` means "no command
      // answered", the same thing an unknown `/name` means, and the prompt is used verbatim.
      if (!loaded) return { kind: "none" };
      // Fix round 7: ONLY a synthetic (workflow-backed) skill body recognises `$ARGUMENTS_JSON`. An
      // ordinary, on-disk skill gets the ordinary substitution, `$ARGUMENTS_JSON` included as
      // literal text if that is what its body happens to contain.
      const substitute = loaded.isSynthetic ? substituteWorkflowArguments : substituteArguments;
      return { kind: "expand", text: substitute(loaded.body, args), source: loaded.path };
    }

    const raw = readCommandBody(entry.file.path);
    if (raw === undefined) return { kind: "none" }; // deleted since discovery -- never a throw
    return { kind: "expand", text: substituteArguments(parseCommandFile(raw).body, args), source: entry.file.path };
  }
}
