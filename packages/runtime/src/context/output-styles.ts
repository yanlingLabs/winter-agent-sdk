// Phase 5 Lane C (task 6) -- output styles (WS-11 §6.5). A PRODUCT EXTENSION carried over from
// Norma, not a pinned surface: `<projectDir>/output-styles/<name>.md` plus built-ins, selected by name
// through `Settings.outputStyle` / `RuntimeConfig.outputStyle`.
//
// THE INVARIANT THAT GOVERNS THE WHOLE MODULE: with no style set, the assembled prompt is
// BYTE-IDENTICAL to the unstyled prompt (Norma's shipped invariant, kept). That is why `default`
// exists as a reserved built-in with an EMPTY body rather than as a null object -- "no style" and
// "the default style" have to be the same assembly, or a host that writes `outputStyle: "default"`
// into settings quietly gets a different prompt from one that omits the key. The assembler-side
// half of the invariant is a snapshot test; this side is the empty body.
//
// A STYLE IS RESOLVED BY NAME, NOT BY THE ENGINE. `context/seam.ts` deliberately carries
// `outputStyle` as a NAME (its own divergence note says so): the engine has no business reading
// files out of a project directory, and discovery is this lane's deliverable.
//
// RULING P5-A APPLIES TWICE HERE, AND THE SECOND TIME IS THE INTERESTING ONE:
//
//   1. SOURCE GATE. Project files load only when `project ∈ settingSources`, user files only when
//      `user ∈ settingSources` -- the same gate WINTER.md, skills and commands sit behind. Built-ins
//      are code, not a filesystem tier, so `settingSources: []` still resolves them.
//
//   2. A PROJECT-TIER STYLE MAY ADD TO THE PROMPT BUT NOT DELETE IT. `keep-coding-instructions:
//      false` REPLACES the authored prompt. Reached from a checked-in project-tier output style
//      in a repository the user merely opened, that is a prompt takeover from untrusted content --
//      a strictly larger power than WINTER.md has (WINTER.md cannot reach `system` at all), and
//      closer to the "permission participant" class R4-7 keeps trust-gated than to the instruction
//      class P5-A only source-gates. So a project-tier replacement is DOWNGRADED to an append
//      unless the host has declared the workspace trusted (`RuntimeConfig.trustedWorkspace`, the
//      only source of a true value per P5-A). The style still applies; it just cannot delete
//      Winter's own text. A USER-tier style replaces with no trust check -- the winter home is the
//      user's own file and gating it would gate the user against themselves.
//
//      DISCLOSED as a Lane C decision, raised for the controller in the task-6 report: neither
//      WS-11 §6.5 nor P5-A speaks to the replace power specifically, and the alternative readings
//      (trust-gate project styles entirely, or honour the replacement) are both defensible.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type BrandProfile, type SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { capBytes, neutralizeReminderTags } from "./injection.ts";
import { parseFrontmatter } from "../subagents/definitions.ts";

export const DEFAULT_OUTPUT_STYLE_NAME = "default";

/** Per-style body ceiling. A style rides every request, so it needs a bound like every other injected file. */
export const OUTPUT_STYLE_MAX_BYTES = 32 * 1024;

export interface ResolvedOutputStyle {
  /** Always the filename stem (or the built-in's name) -- never the frontmatter, so `list` and `resolve` cannot disagree. */
  name: string;
  description: string;
  /** Injection-safe and capped for file styles; a trusted constant for built-ins. */
  body: string;
  /** `true` (the default) appends the body after the authored prompt; `false` replaces the authored prompt. */
  keepBasePrompt: boolean;
  source: "project" | "user" | "builtin" | "plugin";
  /** True when the file asked to REPLACE the prompt and the project-tier trust rule downgraded it to an append. */
  replacementDowngraded: boolean;
}

// The bodies below ASSUME the authored prompt is still present (they augment it), which is why all
// three ship with `keepBasePrompt: true`. They are Winter's own wording of Norma's shipped three.
const PROACTIVE_BODY = [
  "Operate proactively. When the user's intent is clear, take the action instead of asking whether to take it, and carry on through the obvious follow-up steps without pausing for confirmation on reversible work.",
  "Still stop for the genuinely irreversible and the genuinely ambiguous — this changes how eagerly you act, not what counts as safe.",
].join(" ");

const EXPLANATORY_BODY = [
  "Explain as you work. When a choice is not obvious, say briefly why you made it: what the alternative was, what the tradeoff is, or what a dense piece of code or a command actually does.",
  "Keep it short and inline. The goal is that the user finishes understanding not just what changed but why it changed.",
].join(" ");

const LEARNING_BODY = [
  "Work collaboratively with the user learning. Do the bulk of the work yourself, but deliberately leave a few small, well-chosen pieces for them to write, each marked with a `TODO(human):` comment saying exactly what that piece should do.",
  "Choose gaps that teach the central idea rather than busywork, and list the markers you left when you finish so they are easy to find.",
].join(" ");

/**
 * The four built-ins. `default` is RESERVED: an empty body that is never injected, so selecting it
 * is byte-identical to selecting nothing.
 */
export const BUILTIN_OUTPUT_STYLES: readonly ResolvedOutputStyle[] = [
  { name: "default", description: "Winter's standard behaviour.", body: "", keepBasePrompt: true, source: "builtin", replacementDowngraded: false },
  { name: "proactive", description: "Act immediately and autonomously; ask less.", body: PROACTIVE_BODY, keepBasePrompt: true, source: "builtin", replacementDowngraded: false },
  { name: "explanatory", description: "Explain reasoning and tradeoffs while working.", body: EXPLANATORY_BODY, keepBasePrompt: true, source: "builtin", replacementDowngraded: false },
  { name: "learning", description: "Leave labelled TODO(human) gaps for you to complete.", body: LEARNING_BODY, keepBasePrompt: true, source: "builtin", replacementDowngraded: false },
] as const;

export const BUILTIN_OUTPUT_STYLE_NAMES: readonly string[] = BUILTIN_OUTPUT_STYLES.map((s) => s.name);

/**
 * A bare slug. Checked BEFORE any path is built, because the name flows from a settings file --
 * including a project's checked-in project-tier `settings.json` -- straight into a `join`. Dots are
 * excluded too, so a bare `.` or `..` stem is rejected outright rather than relying on the `.md`
 * suffix to accidentally defuse it.
 */
const STYLE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Parse `<name>.md`: a `---` frontmatter fence, then the body. Identity is ALWAYS `fallbackName`
 * (the filename stem); a `name:` key is parsed and ignored so a file cannot claim to be a style it
 * is not. `null` for anything that is not a well-formed style file.
 */
function parseStyleFile(path: string, fallbackName: string, source: "project" | "user"): ResolvedOutputStyle | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return null;

  let description = "";
  let keepBasePrompt = true;
  for (const rawLine of raw.slice(3, end).split(/\r?\n/)) {
    // A CRLF file's LAST frontmatter line keeps its own `\r`: `end` lands on the `\n` of the
    // closing fence's `\r\n`, so nothing is left for the split to consume. Strip it, or the
    // key/value regex below (whose `(.*)$` cannot cross a bare `\r`) silently fails on that line.
    const line = rawLine.replace(/\r$/, "");
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m === null) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "description") description = value;
    // The frontmatter key keeps Norma's shipped spelling so a style file ports across unchanged.
    else if (key === "keep-coding-instructions") keepBasePrompt = value !== "false";
  }

  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  return { name: fallbackName, description, body: capBytes(neutralizeReminderTags(body), OUTPUT_STYLE_MAX_BYTES).text, keepBasePrompt, source, replacementDowngraded: false };
}

// WS-21 §6.3 item 1 (fix round 2, corrected in the batch-2 fix round): a plugin-contributed output
// style, named as claude names one -- `<pluginName>:<baseName>`, where `baseName` is the file's own
// frontmatter `name:` WHEN PRESENT, else the filename stem. This is the ONE place in this file that
// lets frontmatter `name:` win: `parseStyleFile` above deliberately never does (a project/user
// style's identity is always the filename stem, `name:` parsed and ignored, per its own header)
// because a checked-in style must not be able to claim an identity a caller has not validated. A
// plugin style cannot pull that trick against a NEIGHBOUR project/user style -- its identity is
// always qualified with the installed plugin's own name, a namespace only the plugin's installer
// controls -- so the parity fix does not reopen that hole.
//
// USES THE SHARED `parseFrontmatter` (subagents/definitions.ts, the SAME `Bun.YAML.parse`-backed
// parser matching claude's own pinned frontmatter module), not a third hand-rolled scanner: this
// file used to carry its own `---`-line-scanning logic for plugin styles, duplicating
// `parseStyleFile`'s ALREADY-simpler hand-rolled version above (itself untouched -- claude parity
// was never asked for project/user styles, whose identity rule is deliberately the opposite one).
function parsePluginStyleFile(path: string, pluginName: string, fallbackBaseName: string): ResolvedOutputStyle | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { attrs, body: parsedBody } = parseFrontmatter(raw);
  // No frontmatter fence at all (or one with zero keys -- functionally identical for every field
  // below, all of which are optional) is not a style, matching `parseStyleFile`'s own "no fence ->
  // not a style" gate one function up.
  if (Object.keys(attrs).length === 0) return null;

  const declaredNameRaw = attrs["name"];
  const declaredName = typeof declaredNameRaw === "string" && declaredNameRaw.length > 0 ? declaredNameRaw : undefined;
  const baseName = declaredName ?? fallbackBaseName;
  if (!STYLE_NAME.test(baseName)) return null; // a declared name still cannot escape the same slug jail every OTHER identity in this file is held to

  const descriptionRaw = attrs["description"];
  // claude falls back to an excerpt of the markdown body; Winter has no such extractor anywhere yet
  // (disclosed rather than silently guessed), so an absent description falls back to a plain,
  // honest label instead of inventing markdown-excerpt logic this fix round did not ask for.
  const description = typeof descriptionRaw === "string" && descriptionRaw.length > 0 ? descriptionRaw : `Output style from the ${pluginName} plugin`;

  // The frontmatter key keeps Norma's shipped spelling (matching `parseStyleFile` above); a real
  // YAML boolean OR its quoted string form both mean "false" -- everything else, including absent, keeps the base prompt.
  const keepRaw = attrs["keep-coding-instructions"];
  const keepBasePrompt = !(keepRaw === false || keepRaw === "false");

  return {
    name: `${pluginName}:${baseName}`,
    description,
    body: capBytes(neutralizeReminderTags(parsedBody.trim()), OUTPUT_STYLE_MAX_BYTES).text,
    keepBasePrompt,
    source: "plugin",
    replacementDowngraded: false,
  };
}

/** A minimal projection of `plugins/bundle.ts`'s `PluginBundle` -- only the two fields output-style resolution needs, so this file never depends on the plugin loader's own shape. */
export interface PluginOutputStyleSource {
  name: string;
  outputStylesPath?: string;
}

export interface OutputStyleLookup {
  cwd: string;
  /** The resolved winter home (`~/<brand.homeDirName>` by default). */
  home: string;
  /** P7a (D19): the session's brand -- the project dot-dir the project tier is read from. Omitted = `WINTER_BRAND`. */
  brand?: Pick<BrandProfile, "projectDirName">;
  /** Omitted means all three tiers (the pinned default). */
  settingSources?: readonly SettingSource[];
  /** RULING P5-A's host-declared trust bit. Only `true` lets a PROJECT-tier style replace the prompt. */
  trustedWorkspace?: boolean;
  /**
   * WS-21 §6.3 item 1 (fix round 2): the session's ENABLED plugins, projected to just the two
   * fields a `<plugin>:<style>` lookup needs. Omitted (every pre-fix-round-2 caller) means no
   * plugin ever resolves -- a qualified name simply falls through to `null`, matching what happened
   * before this field existed.
   */
  pluginOutputStyles?: readonly PluginOutputStyleSource[];
}

/**
 * Resolve a style by name: a `<plugin>:<style>` qualified name resolves against that plugin's own
 * `output-styles/` directory (WS-21 §6.3 item 1) regardless of `settingSources` -- a plugin is
 * DELIBERATELY NOT source-gated anywhere else in this codebase either (subagents/definitions.ts's
 * own header states the identical reasoning: a plugin is loaded because the HOST or the USER
 * decided to, a decision already made outside the repository, so gating it on workspace trust would
 * make plugin behaviour depend on which directory the session happens to be in). Otherwise: project
 * (source-gated) > user (source-gated) > built-in. Never throws; `null` means the name resolves to
 * nothing, which the assembler treats as "no style".
 */
export function resolveOutputStyle(name: string, lookup: OutputStyleLookup): ResolvedOutputStyle | null {
  const qualified = /^([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(name);
  if (qualified !== null) {
    const [, pluginName, styleName] = qualified;
    const plugin = lookup.pluginOutputStyles?.find((p) => p.name === pluginName);
    if (plugin?.outputStylesPath === undefined) return null;
    // A DIRECTORY SCAN, not a direct `<styleName>.md` join: a plugin style's identity may come from
    // its OWN frontmatter `name:` rather than its filename (parsePluginStyleFile's own header), so
    // the only way to find "the file whose resolved identity is this qualified name" is to check
    // every candidate -- mirroring claude's own "load every style, then match by name" shape without
    // needing a separate list-all API this codebase's "resolve by exact name" design does not have.
    let entries: string[];
    try {
      entries = readdirSync(plugin.outputStylesPath);
    } catch {
      return null;
    }
    for (const entry of entries.sort()) {
      if (!entry.toLowerCase().endsWith(".md")) continue;
      const fallbackBase = entry.slice(0, -3);
      const found = parsePluginStyleFile(join(plugin.outputStylesPath, entry), pluginName!, fallbackBase);
      if (found !== null && found.name === name) return found;
    }
    return null;
  }

  if (!STYLE_NAME.test(name)) return null;
  const sources = lookup.settingSources ?? (["user", "project", "local"] as const);

  if (sources.includes("project")) {
    const found = parseStyleFile(join(lookup.cwd, (lookup.brand ?? WINTER_BRAND).projectDirName, "output-styles", `${name}.md`), name, "project");
    if (found !== null) {
      if (!found.keepBasePrompt && lookup.trustedWorkspace !== true) {
        return { ...found, keepBasePrompt: true, replacementDowngraded: true };
      }
      return found;
    }
  }

  if (sources.includes("user")) {
    const found = parseStyleFile(join(lookup.home, "output-styles", `${name}.md`), name, "user");
    if (found !== null) return found;
  }

  return BUILTIN_OUTPUT_STYLES.find((s) => s.name === name) ?? null;
}
