// Phase 5 Lane C (task 6) -- instructions-file discovery (WS-11 §6.4, Ruling R5-9, Ruling P5-A).
//
// P7a (D19): the basename is `brand.instructionsFile` -- Claude's `CLAUDE.md` convention with the
// session's own token. Winter's default is the value in `WINTER_BRAND`; a reuser's is theirs, and
// this module never spells either.
//
// The instructions file is INJECTED CONTEXT, never system text. The distinction is the whole point of §6.4:
// system text is the cacheable, session-stable prefix, while a project's instructions are file
// content that changes with the repository. SDK 0.0.16 (P16-5): everything here feeds ONE value --
// claude's `claudeMd` userContext entry (`renderInstructionsContext`), sent as the index-0 message of
// every request and nothing here can reach `system`.
//
// DELIBERATE BEHAVIOUR CHANGE (0.0.16). The files used to be RE-READ ON EVERY TURN and re-attached
// to that turn's user message. The engine now builds the userContext once per session context and
// rebuilds it only after a compaction (or an explicit `reloadSessionContext`), exactly as claude
// does: an edit to an instructions file is seen after the next compaction or in a new session.
//
// THE LOCAL TIER IS NEW IN 0.0.16. Each directory of the walk also contributes its private
// `<name>.local.md` (claude's `CLAUDE.local.md`), gated on the `local` setting source. This widens
// WS-01 §2.4's "one project instructions file" reading, at the 0.0.16 brief's direction.
//
// TWO GIT ROOTS, AND THEY ARE NOT THE SAME ROOT. memory-key.ts scopes memory by
// `--git-common-dir`, deliberately, so linked worktrees SHARE one memory directory. The
// instruction walk must NOT use that root: for a linked worktree the common root is the MAIN
// checkout, which is not an ancestor of the worktree at all -- a walk bounded by it would never
// terminate at the worktree and would climb to the filesystem root, reading whatever instructions file
// happened to sit above it. The instruction boundary is `--show-toplevel`: the checkout the cwd
// actually lives in. Both behaviours are fixtured against one real `git worktree add`.
//
// THE SOURCE GATE IS P5-A's, NOT A TRUST GATE. Project skills, commands and the instructions file are gated on
// `project ∈ settingSources` -- they are instructions, not permission participants (project AGENT
// definitions stay trust-gated, R4-7, because a definition carries tool grants). `settingSources`
// omitted means all three tiers, which is the pinned CLI default; `[]` is the hermetic-host mode
// and reads nothing from the filesystem.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { WINTER_BRAND, type BrandProfile, type SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { expandImports } from "./imports.ts";
import { neutralizeReminderTags, readWhole } from "./injection.ts";

/**
 * Winter's OWN instructions basename, derived from the default profile rather than spelled.
 *
 * Kept as a named export because it is what every caller that has not threaded a brand still means.
 * A session's actual basename is `input.brand.instructionsFile` inside `discoverWinterMd` below.
 */
export const WINTER_MD_BASENAME = WINTER_BRAND.instructionsFile;

/**
 * WS-21 §6.3 item 10 (F7): there is NO per-file byte ceiling here any more. Winter used to cap an
 * instructions file at 32 KB (Norma's shipped cap); claude does not truncate `CLAUDE.md`, and the
 * whole point of this workstream is that the two runtimes read the identical file the identical way.
 * Removed rather than widened, so nothing downstream can quietly reintroduce a cap by reading this
 * constant.
 */

export interface WinterMdBlock {
  /** Absolute path of the file this block came from. */
  path: string;
  /** `local` is the per-directory `<name>.local.md` (claude's `CLAUDE.local.md`), gated on the `local` source. */
  scope: "user" | "project" | "local";
  /**
   * SDK 0.0.16: the file's CONTENT (capped, a literal `<system-reminder>` tag neutralised) --
   * unwrapped, since it now renders as one entry of the index-0 userContext's `claudeMd` value
   * (`renderInstructionsContext`) rather than as its own reminder block.
   */
  text: string;
}

/** `<name>.md` -> `<name>.local.md`: claude's `CLAUDE.local.md` convention with the session's own basename. */
export function localInstructionsBasename(instructionsFile: string): string {
  return instructionsFile.toLowerCase().endsWith(".md") ? `${instructionsFile.slice(0, -3)}.local.md` : `${instructionsFile}.local`;
}

// Memoised `resolved cwd -> worktree toplevel (or null)`. Same reasoning as memory-key.ts's cache:
// `assemble()` runs once per envelope and a session's checkout does not move underneath it.
//
// DISCLOSED STALENESS (whole-branch n1), because the seam's own case is "one process, many
// sessions": the entry is never invalidated, so a long-lived host in which the SAME directory is
// deleted and re-cloned with a different `.git` layout (a worktree becoming a plain checkout, say)
// keeps the first answer for the life of the process. Accepted rather than fixed: the alternatives
// are a watcher (which WS-11 forbids inside the SDK) or a per-envelope `git` spawn, and the failure
// needs a path to be re-cloned differently UNDER a running host. A host that does that can restart,
// and a test that needs it calls the clear hook below.
const rootCache = new Map<string, string | null>();

/** TEST-ONLY: throwaway repositories at reused paths need this cleared. Production never calls it. */
export function _clearProjectRootCacheForTests(): void {
  rootCache.clear();
}

/**
 * `resolve` + best-effort `realpath`, the same chain the store's own key derivation uses.
 *
 * REQUIRED, not tidiness: git reports `--show-toplevel` as a REAL path, while `resolve(cwd)` keeps
 * whatever spelling the caller had. On macOS every `mkdtemp` path is `/var/...`, a symlink to
 * `/private/var/...`, so the two spellings compare unequal and the walk below never recognises its
 * own boundary. The parent-walk fixture caught this: it collected only the leaf file.
 */
function canonical(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The root of the checkout `cwd` lives in -- `git rev-parse --show-toplevel`, which for a LINKED
 * WORKTREE is that worktree's own directory (not the main checkout, and not the common dir).
 * `null` when `cwd` is not inside a repository, or git is unavailable: with no repository there is
 * no defensible upper bound for a parent-walk, so the caller reads the cwd alone rather than
 * climbing toward `/`.
 */
export function projectInstructionRoot(cwd: string): string | null {
  const key = canonical(cwd);
  const cached = rootCache.get(key);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  try {
    const out = execFileSync("git", ["-C", key, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length > 0) root = canonical(out);
  } catch {
    root = null;
  }
  rootCache.set(key, root);
  return root;
}

/**
 * Every directory from the instruction root down to `cwd`, OUTERMOST FIRST. Outermost-first is the
 * injection order too: the closest file is read last, so where two files speak to the same point
 * the nearer one is the most recent thing the model read.
 */
function instructionDirectories(cwd: string): string[] {
  const here = canonical(cwd);
  const root = projectInstructionRoot(here);
  if (root === null) return [here];
  const chain: string[] = [];
  let cursor = here;
  for (;;) {
    chain.push(cursor);
    if (cursor === root) break;
    const parent = dirname(cursor);
    // Defensive: a cwd that is not actually under its reported root (a symlinked path git resolved
    // differently) would otherwise climb to "/". Stop rather than escape the boundary.
    if (parent === cursor) return [here];
    cursor = parent;
  }
  return chain.reverse();
}

export interface WinterMdInput {
  cwd: string;
  /** The `~/.winter` root. */
  home: string;
  /** Omitted means the pinned default: all three tiers. `[]` reads nothing. */
  settingSources?: readonly SettingSource[];
  /** P7a (D19): the session's brand. Omitted = `WINTER_BRAND`, i.e. today's `WINTER_MD_BASENAME`. */
  brand?: Pick<BrandProfile, "instructionsFile">;
  /**
   * WS-21 §6.3 item 2: UNCONDITIONAL rules (`context/rules.ts`'s `loadRules(...).unconditional`),
   * rendered as additional blocks AFTER every instructions file -- rules are standing context of
   * the identical kind an instructions file is, just organised one file per rule instead of a
   * single instructions basename. A CONDITIONAL rule never belongs here: it rides the on-touch attachment
   * (`conditionalRuleAttachmentProducer`) instead, appearing only once a matching file is touched.
   */
  rules?: readonly { path: string; tier: "user" | "project"; content: string }[];
}

/**
 * The instructions blocks for a session, in the PINNED ORDER: the user-level file first, then every
 * project file from the repository root down to the cwd, then every unconditional rule.
 *
 * User-first is deliberate. The user's own file under the winter home is standing preference; a
 * project's file is specific to the work in front of the model. Reading the specific thing last
 * matches the outermost-first rule the project walk already follows, so one rule covers the whole
 * ordering rather than two that could drift. Rules come last because they are the most granular
 * tier -- narrower in scope than either instructions file, the same reason a project file already
 * reads after the user's.
 */
export function discoverWinterMd(input: WinterMdInput): WinterMdBlock[] {
  const sources = input.settingSources ?? (["user", "project", "local"] as const);
  const basename = (input.brand ?? WINTER_BRAND).instructionsFile;
  const localBasename = localInstructionsBasename(basename);
  const blocks: WinterMdBlock[] = [];

  // WS-21 §6.3 item 4: LAZY, so the hermetic `settingSources: []` mode (and a user-only session)
  // never shells out to git at all -- `projectInstructionRoot` is a real subprocess spawn, and a
  // USER-tier file's `@import` never consults it (expandImports ignores `projectRoot` for that
  // tier), so there is nothing to compute until a project/local file is actually about to be read.
  let projectRootCache: string | null | undefined;
  const projectRootFor = (scope: WinterMdBlock["scope"]): string | null => (scope === "user" ? null : (projectRootCache ??= projectInstructionRoot(input.cwd)));

  const read = (path: string, scope: WinterMdBlock["scope"]): void => {
    const body = readWhole(path);
    if (body === null) return;
    // WS-21 §6.3 item 4 (F17): expand this file's OWN `@import` tokens before it becomes a block --
    // claude does this at load time too, and every downstream reader (renderInstructionsContext,
    // the assembler) only ever sees the already-expanded text.
    const { content } = expandImports({ content: body, filePath: path, tier: scope, projectRoot: projectRootFor(scope) });
    blocks.push({ path, scope, text: neutralizeReminderTags(content) });
  };

  if (sources.includes("user")) read(join(input.home, basename), "user");

  // SDK 0.0.16: each directory of the walk contributes its checked-in file (the `project` source)
  // and then its private `<name>.local.md` (the `local` source) -- claude's per-directory order,
  // `CLAUDE.md` before `CLAUDE.local.md`.
  const includeProject = sources.includes("project");
  const includeLocal = sources.includes("local");
  if (includeProject || includeLocal) {
    for (const dir of instructionDirectories(input.cwd)) {
      if (includeProject) read(join(dir, basename), "project");
      if (includeLocal) read(join(dir, localBasename), "local");
    }
  }

  for (const rule of input.rules ?? []) {
    const text = rule.content.trim();
    if (text.length === 0) continue;
    const { content } = expandImports({ content: text, filePath: rule.path, tier: rule.tier, projectRoot: projectRootFor(rule.tier) });
    blocks.push({ path: rule.path, scope: rule.tier, text: neutralizeReminderTags(content) });
  }

  return blocks;
}

// --- the claudeMd value (SDK 0.0.16, P16-5) ----------------------------------------------------------
//
// claude 0.3.250's `THt`, ported: the fixed header, then one `Contents of <path><label>:` entry per
// file (content trimmed), joined by blank lines. The header and the labels are claude's own strings
// (the brief's ruling); the paths are Winter's own files.

export const INSTRUCTIONS_CONTEXT_HEADER =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export type InstructionsContextKind = WinterMdBlock["scope"] | "auto-memory";

const INSTRUCTIONS_CONTEXT_LABELS: Record<InstructionsContextKind, string> = {
  project: " (project instructions, checked into the codebase)",
  local: " (user's private project instructions, not checked in)",
  "auto-memory": " (user's auto-memory, persists across conversations)",
  user: " (user's private global instructions for all projects)",
};

export interface InstructionsContextFile {
  path: string;
  kind: InstructionsContextKind;
  content: string;
}

/** The `claudeMd` userContext value, or `undefined` when no file has content (the key is then omitted). */
export function renderInstructionsContext(files: readonly InstructionsContextFile[]): string | undefined {
  const entries = files.filter((f) => f.content.length > 0).map((f) => `Contents of ${f.path}${INSTRUCTIONS_CONTEXT_LABELS[f.kind]}:\n\n${f.content.trim()}`);
  if (entries.length === 0) return undefined;
  return `${INSTRUCTIONS_CONTEXT_HEADER}\n\n${entries.join("\n\n")}`;
}
