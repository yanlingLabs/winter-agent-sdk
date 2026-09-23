// WS-21 §6.3 item 2 (F17): a `rules/` loader for the user tier and the (trusted) project tier, with
// claude's `paths:` conditional-attachment semantics.
//
// TWO KINDS OF RULE. A rule file with no `paths:` (or an empty one) is UNCONDITIONAL -- content that
// belongs beside the instructions file, always present (winter-md.ts renders it after the
// instructions files, per the plan brief). A rule file WITH `paths:` is CONDITIONAL -- claude
// withholds it until a file matching one of its globs is touched by Read, Edit or Write, then
// announces it exactly once. Winter had no on-touch attachment mechanism before this file: the
// conditional-rule producer below is a NEW entry in the attachment framework
// (context/attachments.ts), not a reuse of an existing one.
//
// PATHS SEMANTICS (F17, pinned): for a USER rule, `paths:` globs resolve relative to the ORIGINAL
// cwd (the session's cwd at spawn, never a later EnterWorktree relocation -- ruleMatches takes it as
// an explicit parameter for exactly that reason). For a PROJECT rule, they resolve relative to the
// PARENT of the project dot-dir (brand.projectDirName) the rule file was discovered under -- which
// directory that is depends on WHERE ALONG THE ROOT-TO-CWD WALK the file lives, so it is fixed at
// LOAD time (`LoadedRule.projectBase`) rather than recomputed at match time. A relative glob
// starting with `..` never matches, for either tier.
//
// FRONTMATTER. No YAML dependency exists anywhere in this workspace (subagents/definitions.ts's own
// header states this and is the parser reused here): `paths:` is a flat scalar, either a bracketed
// `[a/**, b/**]` list or a bare comma list, exactly `parseFrontmatter`'s existing sibling parsers
// accept for `tools:`/`skills:`. A rule file with no frontmatter at all is entirely valid -- the
// whole file is its content, unconditionally.
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import type { AttachmentProducer, ProviderMessage } from "../engine.ts";
import { matchFileRule } from "../permissions/paths.ts";
import { parseFrontmatter } from "../subagents/definitions.ts";
import { attachmentsIn, registerAttachmentRenderer, type AttachmentPayload } from "./attachments.ts";

export type RuleSettingSource = "user" | "project" | "local";

export interface LoadedRule {
  /** Absolute path of the rule `.md` file. */
  path: string;
  tier: "user" | "project";
  /** The rule's body, frontmatter stripped, trimmed. */
  content: string;
  /** Present (and non-empty) iff this is a CONDITIONAL rule. Raw glob strings, as authored. */
  paths?: string[];
  /**
   * PROJECT tier only: the parent of the project dot-dir (brand.projectDirName) this rule file was
   * discovered under, fixed at load time (F17's "relative to the parent of the project dot-dir").
   * Absent for a user-tier rule, which resolves against whatever `originalCwd` `ruleMatches` is
   * called with instead.
   */
  projectBase?: string;
}

export interface LoadRulesInput {
  /** The winter home (`<PREFIX>HOME`, i.e. the shared runtime home under WS-21). */
  home: string;
  cwd: string;
  /** The repository root, or `null` outside one. Project rules load only when this is set. */
  projectRoot: string | null;
  /** Omitted means every tier loads (loadRules has no separate "all tiers" default of its own --
   *  every caller threads the session's resolved settingSources explicitly). */
  sources: readonly RuleSettingSource[];
  brand: Pick<BrandProfile, "projectDirName">;
}

/** Splits a frontmatter scalar into a glob list. Mirrors subagents/definitions.ts's private `splitList` (not exported, so duplicated here at the same small scope). */
function splitPathsList(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const stripped = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  const items = stripped
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Admits a directory/file entry, following a symlink to see what it really is (F6: claude follows symlinked rule files). */
function isDirEntry(root: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(root, e.name)).isDirectory();
  } catch {
    return false;
  }
}
function isFileEntry(root: string, e: Dirent): boolean {
  if (e.isFile()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(root, e.name)).isFile();
  } catch {
    return false;
  }
}

/** Every `.md` file under `root`, recursively (`rules/**\/*.md`), sorted for a stable order. Symlinked dirs and files are followed; a dangling link is skipped silently, like every other loader in this lane. */
function walkMdFiles(root: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(root, e.name);
    if (isDirEntry(root, e)) out.push(...walkMdFiles(full));
    else if (isFileEntry(root, e) && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function readRuleFile(path: string, tier: "user" | "project", projectBase?: string): LoadedRule | null {
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { attrs, body } = parseFrontmatter(raw);
  const content = body.trim();
  if (content.length === 0) return null; // nothing to inject -- not an error, the same "empty file" contract every reader here shares
  const paths = splitPathsList(attrs["paths"]);
  return {
    path,
    tier,
    content,
    ...(paths !== undefined ? { paths } : {}),
    ...(tier === "project" && projectBase !== undefined ? { projectBase } : {}),
  };
}

/**
 * Every directory from `root` DOWN TO `cwd`, outermost first -- the same order winter-md.ts's own
 * (unexported) `instructionDirectories` walks, but built from an ALREADY-RESOLVED `root` rather than
 * shelling out to git itself: `loadRules`'s caller supplies `projectRoot` (typically the daemon's
 * own `repoRootFor`), so this file has no git dependency of its own.
 */
function projectDirsRootToCwd(root: string, cwd: string): string[] {
  const here = resolve(cwd);
  const top = resolve(root);
  const chain: string[] = [];
  let cursor = here;
  for (;;) {
    chain.push(cursor);
    if (cursor === top) break;
    const parent = cursor.slice(0, cursor.lastIndexOf("/")) || "/";
    if (parent === cursor) return [here]; // cwd is not actually under root -- do not climb to "/"
    cursor = parent;
  }
  return chain.reverse();
}

/**
 * Load every rule visible to this session, split into UNCONDITIONAL (always present) and
 * CONDITIONAL (announced on-touch, `conditionalRuleAttachmentProducer` below).
 */
export function loadRules(input: LoadRulesInput): { unconditional: LoadedRule[]; conditional: LoadedRule[] } {
  const rules: LoadedRule[] = [];

  if (input.sources.includes("user")) {
    for (const file of walkMdFiles(join(input.home, "rules"))) {
      const rule = readRuleFile(file, "user");
      if (rule !== null) rules.push(rule);
    }
  }

  if (input.sources.includes("project") && input.projectRoot !== null) {
    for (const dir of projectDirsRootToCwd(input.projectRoot, input.cwd)) {
      const rulesRoot = join(dir, input.brand.projectDirName, "rules");
      for (const file of walkMdFiles(rulesRoot)) {
        const rule = readRuleFile(file, "project", dir);
        if (rule !== null) rules.push(rule);
      }
    }
  }

  // `local` is in RuleSettingSource for signature symmetry with every other loader's `sources`
  // parameter, but F17 defines no local-tier rules/ folder of its own -- it is accepted and yields
  // nothing beyond what "project" already contributed.

  const unconditional = rules.filter((r) => r.paths === undefined || r.paths.length === 0);
  const conditional = rules.filter((r) => r.paths !== undefined && r.paths.length > 0);
  return { unconditional, conditional };
}

/**
 * Whether `filePath` matches one of `rule`'s `paths:` globs. `false` for an unconditional rule
 * (nothing to match). `originalCwd` is the USER-tier base; a PROJECT-tier rule ignores it and uses
 * its own fixed `projectBase` instead (see `LoadedRule.projectBase`'s header).
 */
export function ruleMatches(rule: LoadedRule, filePath: string, originalCwd: string): boolean {
  if (rule.paths === undefined || rule.paths.length === 0) return false;
  const base = rule.tier === "user" ? originalCwd : rule.projectBase;
  if (base === undefined) return false;
  for (const pattern of rule.paths) {
    if (pattern.startsWith("..")) continue; // F17: a relative path starting with ".." never matches
    if (matchFileRule(pattern, { path: filePath, cwd: base, home: base, sourceDir: base, direction: "allow" })) return true;
  }
  return false;
}

// --- the on-touch attachment (WS-21 §6.3 item 2: no existing on-touch path to reuse) --------------

export interface ConditionalRuleAttachment extends AttachmentPayload {
  type: "conditional_rule";
  /** `LoadedRule.path` -- the dedupe key the "announced" fold reads back. */
  path: string;
  content: string;
}

registerAttachmentRenderer("conditional_rule", (a) => (typeof a["content"] === "string" && a["content"].length > 0 ? a["content"] : undefined));

/** Every conditional rule already announced in this history, keyed by `LoadedRule.path` -- the identical persisted-fold shape `dateChangeAnnounced`/`skillListingResumeSeed` already use. */
export function announcedRulePaths(messages: readonly ProviderMessage[]): Set<string> {
  const seen = new Set<string>();
  for (const a of attachmentsIn(messages)) {
    if (a.type === "conditional_rule" && typeof a["path"] === "string") seen.add(a["path"] as string);
  }
  return seen;
}

const TOUCH_TOOLS = new Set(["Read", "Edit", "Write"]);

/** Every `file_path` any assistant turn in `messages` has issued a Read/Edit/Write tool_use for, in order (duplicates included -- callers only ever check membership). */
function touchedFilePaths(messages: readonly ProviderMessage[]): string[] {
  const paths: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type !== "tool_use" || !TOUCH_TOOLS.has(block.name)) continue;
      const input = block.input as Record<string, unknown> | null | undefined;
      const filePath = input?.["file_path"];
      if (typeof filePath === "string") paths.push(filePath);
    }
  }
  return paths;
}

/**
 * The conditional-rule attachment producer: scans the engine's own history for every Read/Edit/Write
 * `file_path` an assistant turn has issued, and for each conditional rule not yet announced
 * (`announcedRulePaths`), emits it the first time one of those paths matches. Once emitted, the
 * PERSISTED attachment is what stops a second emission -- the fold reads it back exactly like every
 * other attachment type does, so this producer itself carries no state across calls.
 */
export function conditionalRuleAttachmentProducer(rules: readonly LoadedRule[], opts: { originalCwd: string }): AttachmentProducer {
  const conditional = rules.filter((r) => r.paths !== undefined && r.paths.length > 0);
  return ({ messages }) => {
    if (conditional.length === 0) return [];
    const already = announcedRulePaths(messages);
    const pending = conditional.filter((r) => !already.has(r.path));
    if (pending.length === 0) return [];
    const touched = touchedFilePaths(messages);
    if (touched.length === 0) return [];
    const produced: ConditionalRuleAttachment[] = [];
    for (const rule of pending) {
      if (touched.some((filePath) => ruleMatches(rule, filePath, opts.originalCwd))) {
        produced.push({ type: "conditional_rule", path: rule.path, content: rule.content });
      }
    }
    return produced;
  };
}
