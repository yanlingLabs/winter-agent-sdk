// Phase 5 Lane C (task 6) -- output styles (WS-11 §6.5). A PRODUCT EXTENSION carried over from
// Norma, not a pinned surface: `.winter/output-styles/<name>.md` plus built-ins, selected by name
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
//      false` REPLACES the authored prompt. Reached from a checked-in `.winter/output-styles/*.md`
//      in a repository the user merely opened, that is a prompt takeover from untrusted content --
//      a strictly larger power than WINTER.md has (WINTER.md cannot reach `system` at all), and
//      closer to the "permission participant" class R4-7 keeps trust-gated than to the instruction
//      class P5-A only source-gates. So a project-tier replacement is DOWNGRADED to an append
//      unless the host has declared the workspace trusted (`RuntimeConfig.trustedWorkspace`, the
//      only source of a true value per P5-A). The style still applies; it just cannot delete
//      Winter's own text. A USER-tier style replaces with no trust check -- `~/.winter` is the
//      user's own file and gating it would gate the user against themselves.
//
//      DISCLOSED as a Lane C decision, raised for the controller in the task-6 report: neither
//      WS-11 §6.5 nor P5-A speaks to the replace power specifically, and the alternative readings
//      (trust-gate project styles entirely, or honour the replacement) are both defensible.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { capBytes, neutralizeReminderTags } from "./injection.ts";

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
  source: "project" | "user" | "builtin";
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
 * including a project's checked-in `.winter/settings.json` -- straight into a `join`. Dots are
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

export interface OutputStyleLookup {
  cwd: string;
  /** The `~/.winter` root. */
  home: string;
  /** Omitted means all three tiers (the pinned default). */
  settingSources?: readonly SettingSource[];
  /** RULING P5-A's host-declared trust bit. Only `true` lets a PROJECT-tier style replace the prompt. */
  trustedWorkspace?: boolean;
}

/**
 * Resolve a style by name: project (source-gated) > user (source-gated) > built-in. Never throws;
 * `null` means the name resolves to nothing, which the assembler treats as "no style".
 */
export function resolveOutputStyle(name: string, lookup: OutputStyleLookup): ResolvedOutputStyle | null {
  if (!STYLE_NAME.test(name)) return null;
  const sources = lookup.settingSources ?? (["user", "project", "local"] as const);

  if (sources.includes("project")) {
    const found = parseStyleFile(join(lookup.cwd, ".winter", "output-styles", `${name}.md`), name, "project");
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
