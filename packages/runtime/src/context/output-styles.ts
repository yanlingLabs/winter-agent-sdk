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
//   2. A PROJECT-TIER STYLE MAY ADD TO THE PROMPT BUT NOT DELETE FROM IT. `keep-coding-instructions:
//      false` drops the base prompt's coding-instructions section (assembler.ts's
//      `dropCodingInstructionsSection`, fix round 4/I-F -- see that note below). Reached from a
//      checked-in project-tier output style in a repository the user merely opened, dropping any of
//      Winter's own authored text is a takeover from untrusted content -- a strictly larger power
//      than WINTER.md has (WINTER.md cannot reach `system` at all), and closer to the "permission
//      participant" class R4-7 keeps trust-gated than to the instruction class P5-A only
//      source-gates. So a project-tier drop is DOWNGRADED to a pure append unless the host has
//      declared the workspace trusted (`RuntimeConfig.trustedWorkspace`, the only source of a true
//      value per P5-A). The style still applies; it just cannot delete Winter's own text. A
//      USER-tier style drops with no trust check -- the winter home is the user's own file and
//      gating it would gate the user against themselves.
//
//      DISCLOSED as a Lane C decision, raised for the controller in the task-6 report: neither
//      WS-11 §6.5 nor P5-A speaks to the drop power specifically, and the alternative readings
//      (trust-gate project styles entirely, or honour the drop) are both defensible.
//
// FIX ROUND 3 (M-4), A DISCLOSED BEHAVIOUR CHANGE: `keep-coding-instructions` ABSENT now means
// DROP, not keep -- the pinned binary's own consumer (`M===null||M.keepCodingInstructions===!0`,
// dump-confirmed) keeps the coding-instructions section only when NO style is selected at all OR the
// style's own key is strictly `true`; every other value, including absent, means "drop". This is the
// inverse of this module's own pre-fix-round-3 default (`true` unless explicitly `false`). Ported
// exactly per the coordinator's instruction, and it widens bullet 2's downgrade above in the SAME
// direction it already existed: an untrusted project-tier style that simply never mentions the key
// now ALSO downgrades to an append (with the `replacementDowngraded` warning), not only one that
// explicitly wrote `false` -- worth naming here because it changes how often that warning fires, not
// just what triggers it.
//
// FIX ROUND 4 (I-F), CORRECTING M-4's OWN EFFECT: M-4 (above) ported claude's CONDITION for when a
// style "wins" but not what winning DOES. `review-L1a-fix3-findings.md`'s I-F, dump-confirmed at
// `tHn()` (~276873): claude drops ONLY the coding-instructions section of its base prompt and keeps
// the rest of it as static text; the style's own body goes into a DYNAMIC section, never into the
// static half in its place. `keepCodingInstructions` (renamed from the pre-fix-round-4
// `keepBasePrompt`, which had become actively misleading -- it no longer controls whether the WHOLE
// base prompt survives) is claude's own field name (dump-confirmed at the same site) and this
// module's resolution logic for it is UNCHANGED by I-F; only `assembler.ts`'s interpretation of a
// `false` value changed, from "swap the whole authored region for the style" to "cut the one section
// out of it". See `assembler.ts`'s own fix-round-4 note for the mechanics and `winter-code-preset.ts`
// for why "Task execution" alone is the cut section and "Careful actions" (safety floor: credentials
// are radioactive, ask before the irreversible, name the exact destructive target) is not.
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
  /**
   * `true` (the default) keeps the base prompt's coding-instructions section; `false` drops it. The
   * style's body always lands in a dynamic section, in either case (fix round 4/I-F) -- this field
   * never decides whether the body is added, only whether the ONE base section is cut.
   */
  keepCodingInstructions: boolean;
  source: "project" | "user" | "builtin" | "plugin";
  /** True when the file asked to DROP the coding-instructions section and the project-tier trust rule downgraded it to keeping it. */
  replacementDowngraded: boolean;
}

// The bodies below ASSUME the authored prompt is still present (they augment it), which is why all
// three ship with `keepCodingInstructions: true`. They are Winter's own wording of Norma's shipped three.
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
  { name: "default", description: "Winter's standard behaviour.", body: "", keepCodingInstructions: true, source: "builtin", replacementDowngraded: false },
  { name: "proactive", description: "Act immediately and autonomously; ask less.", body: PROACTIVE_BODY, keepCodingInstructions: true, source: "builtin", replacementDowngraded: false },
  { name: "explanatory", description: "Explain reasoning and tradeoffs while working.", body: EXPLANATORY_BODY, keepCodingInstructions: true, source: "builtin", replacementDowngraded: false },
  { name: "learning", description: "Leave labelled TODO(human) gaps for you to complete.", body: LEARNING_BODY, keepCodingInstructions: true, source: "builtin", replacementDowngraded: false },
] as const;

export const BUILTIN_OUTPUT_STYLE_NAMES: readonly string[] = BUILTIN_OUTPUT_STYLES.map((s) => s.name);

/**
 * A bare slug. Checked BEFORE any path is built, because the name flows from a settings file --
 * including a project's checked-in project-tier `settings.json` -- straight into a `join`. Dots are
 * excluded too, so a bare `.` or `..` stem is rejected outright rather than relying on the `.md`
 * suffix to accidentally defuse it.
 */
const STYLE_NAME = /^[A-Za-z0-9_-]+$/;

// Fix round 3 (M-4): the pinned binary's own `s4` -- a real boolean passes through unchanged; a
// string/number is lower-cased and checked against TWO explicit vocabularies (its own `De`/`To`,
// dump-confirmed at adjacent offsets): `["1","true","yes","on"]` -> true, `["0","false","no","off"]`
// -> false; anything else (including `undefined`/`null`/an object/array) is UNRESOLVED, never
// coerced to a default here -- the caller decides what "unresolved" means (see `keepCodingInstructions`'s
// own callers below, where it means `false`, not `true`).
function claudeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/**
 * Fix round 3 (I-3): the pinned binary's own `jJ` -- when a style declares no `description:`, claude
 * excerpts the BODY instead of inventing a fixed label: the first non-blank line, a leading markdown
 * heading marker (`#`/`##`/...) stripped if present, capped at 100 chars with a `...` suffix. `def`
 * is what an entirely blank body falls back to (dump-confirmed: `jJ(e,t="Custom item")`).
 */
function bodyExcerpt(body: string, def: string): string {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const heading = /^#+\s+(.+)$/.exec(line);
    const text = heading?.[1] ?? line;
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  }
  return def;
}

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
  // Fix round 3 (M-4): pinned `s4`'s own vocabulary, defaulting to FALSE when unresolved (absent,
  // or a string outside the two recognized sets) -- dump-confirmed at the consumer site
  // (`M===null||M.keepCodingInstructions===!0`): a style is expected to REPLACE unless it explicitly
  // asks to be layered on top, the inverse of this module's pre-fix-round-3 default. See this
  // module's header for the disclosed behaviour-change note.
  let keepCodingInstructions = false;
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
    else if (key === "keep-coding-instructions") keepCodingInstructions = claudeBoolean(value) === true;
  }

  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  return { name: fallbackName, description, body: capBytes(neutralizeReminderTags(body), OUTPUT_STYLE_MAX_BYTES).text, keepCodingInstructions, source, replacementDowngraded: false };
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
  // Fix round 3 (I-3): claude's own `RXe` NEVER rejects on frontmatter shape -- an empty
  // (`---\n---\nbody`) or unparseable (a loose colon a CRLF file's retry still can't fix) frontmatter
  // block still produces a style, identity falling back to the filename stem exactly as if the
  // block had been empty on purpose. The pre-fix-round-3 `Object.keys(attrs).length === 0` reject
  // here silently dropped exactly that case.

  // Fix round 3 (I-3): `(p.name!=null?String(p.name):void 0)||basename` -- a NON-STRING declared
  // name (a YAML number/boolean) is coerced, not discarded, matching claude's own `String(p.name)`
  // rather than requiring it already be a string.
  const declaredNameRaw = attrs["name"];
  const declaredName = declaredNameRaw !== null && declaredNameRaw !== undefined ? String(declaredNameRaw) : undefined;
  const baseName = declaredName !== undefined && declaredName.length > 0 ? declaredName : fallbackBaseName;
  if (!STYLE_NAME.test(baseName)) return null; // a declared name still cannot escape the same slug jail every OTHER identity in this file is held to

  // Fix round 3 (I-3): claude's own `CN(p.description,R)??jJ(g,\`Output style from ${t} plugin\`)`
  // -- a valid (non-empty, trimmed) string description wins; otherwise an EXCERPT of the body
  // (`bodyExcerpt`, claude's own `jJ`) stands in, falling back to the fixed label only when the body
  // itself has no non-blank line either. Ported now that I-3 asks for parity here explicitly --
  // this module's earlier note that "Winter has no such extractor" is what this closes.
  const descriptionRaw = attrs["description"];
  const validatedDescription = typeof descriptionRaw === "string" && descriptionRaw.trim().length > 0 ? descriptionRaw.trim() : undefined;
  const description = validatedDescription ?? bodyExcerpt(parsedBody, `Output style from the ${pluginName} plugin`);

  // Fix round 3 (M-4): pinned `s4`'s own vocabulary via `claudeBoolean`, and the SAME default flip
  // as `parseStyleFile` above -- unresolved (absent, or an unrecognized string) means FALSE, not
  // TRUE. See this module's header for the disclosed behaviour-change note.
  const keepCodingInstructions = claudeBoolean(attrs["keep-coding-instructions"]) === true;

  return {
    name: `${pluginName}:${baseName}`,
    description,
    body: capBytes(neutralizeReminderTags(parsedBody.trim()), OUTPUT_STYLE_MAX_BYTES).text,
    keepCodingInstructions,
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
  /** RULING P5-A's host-declared trust bit. Only `true` lets a PROJECT-tier style drop the coding-instructions section. */
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
      if (!found.keepCodingInstructions && lookup.trustedWorkspace !== true) {
        return { ...found, keepCodingInstructions: true, replacementDowngraded: true };
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
