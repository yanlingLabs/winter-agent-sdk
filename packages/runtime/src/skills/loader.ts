// Phase 5 Lane S (WS-11 §2.1): filesystem DISCOVERY for the skill tiers. Metadata only -- this file
// never reads a skill BODY into a returned value (`SKILL.md` is read to parse its frontmatter and
// the parsed body is dropped on the floor), which is the operational meaning of "bodies load lazily
// on invocation": store.ts's `load()` re-reads the file at invocation time.
//
// DEFENSIVE THROUGHOUT, Norma parity: a missing root, an unreadable directory, a malformed
// SKILL.md, a `SKILL.md` that is itself a directory -- every one is SKIPPED, never thrown. A single
// broken skill in a checked-in `.winter/skills/` must not be able to fail a session's startup.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSkillFile } from "./frontmatter.ts";

/** WS-11 §2.1's tier table, and `SkillListing["source"]` (context/seam.ts, R5-17) verbatim. */
export type SkillTier = "project" | "user" | "plugin" | "builtin" | "self";

export interface DiscoveredSkill {
  /** The INVOCABLE name. Plugin skills arrive here already qualified `<plugin>:<skill>` (store.ts). */
  name: string;
  description: string;
  source: SkillTier;
  /** Absolute path of the SKILL.md this was discovered from. */
  path: string;
  /** Winter extension (WS-11 §2.5). */
  author?: string;
  /** Present iff `source === "plugin"` -- the contributing plugin's name. */
  plugin?: string;
}

/** The reserved subdirectory of the user root that holds agent-authored skills (Norma parity). */
export const SELF_SUBDIR = "self";

const USER_ROOT_EXCLUDE: ReadonlySet<string> = new Set([SELF_SUBDIR]);

/**
 * The nearest ancestor of `from` (inclusive) that holds a `.git` entry, or `undefined` when there is
 * none. `.git` may be a DIRECTORY or a FILE (a worktree/submodule gitlink is a file), so existence
 * is what is checked, never `isDirectory()` -- a session run inside a git worktree must find the
 * same boundary a session in the main checkout does.
 */
export function findRepoRoot(from: string): string | undefined {
  let dir = from;
  for (;;) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {
      /* not here */
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * WS-11 §2.1 / report §60: "project lookup walks `.winter/skills/` at cwd and parent directories up
 * to the repository root". NEAREST FIRST -- the returned order IS the precedence order, so a
 * `.winter/skills/review` beside the code shadows one at the repo root.
 *
 * With no repository root above `cwd` the walk covers `cwd` ALONE. Climbing to the filesystem root
 * in that case would let `/tmp/.winter/skills` (or a home-directory one) silently join a session
 * started in a scratch directory -- the boundary exists to stop exactly that.
 */
export function projectSkillRoots(cwd: string): string[] {
  const repoRoot = findRepoRoot(cwd);
  const roots: string[] = [];
  let dir = cwd;
  for (;;) {
    roots.push(join(dir, ".winter", "skills"));
    if (repoRoot === undefined || dir === repoRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/**
 * Scan `<root>/<dir>/SKILL.md` for every immediate SUBDIRECTORY of `root`. `exclude` skips reserved
 * subdirectory names (the user root's `self/`, scanned separately as its own tier).
 *
 * A directory whose name fails the slug jail is still scanned: the jail governs the skill NAME, and
 * `parseSkillFile`'s `name:` field may legitimately differ from the directory's. Store-level
 * validation applies the jail to the resolved name (store.ts), which is the name anything can
 * actually reach.
 */
export function scanSkillRoot(root: string, source: SkillTier, exclude?: ReadonlySet<string>): DiscoveredSkill[] {
  let dirs: string[];
  try {
    // SORTED, not readdir order: `readdirSync` returns directory order, which differs between
    // filesystems and changes as entries are created and removed. The listing's budget drops from
    // the tail (listing.ts), so an unstable within-root order would make WHICH skills the model can
    // see depend on the order they happened to be written to disk.
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: DiscoveredSkill[] = [];
  for (const dir of dirs) {
    if (exclude?.has(dir)) continue;
    const path = join(root, dir, "SKILL.md");
    const parsed = readSkillMetadata(path, dir);
    if (parsed) out.push({ name: parsed.name, description: parsed.description, source, path, ...(parsed.author !== undefined ? { author: parsed.author } : {}) });
  }
  return out;
}

/** Scan the user root, skipping its reserved `self/` subdirectory. */
export function scanUserSkillRoot(root: string): DiscoveredSkill[] {
  return scanSkillRoot(root, "user", USER_ROOT_EXCLUDE);
}

/**
 * Read one SKILL.md's METADATA. Returns the parse (body included -- callers drop it) or `undefined`
 * for anything unusable. Shared by `scanSkillRoot` above and by store.ts's `load()`, so the
 * frontmatter contract is applied exactly once.
 */
export function readSkillMetadata(path: string, fallbackName: string): ReturnType<typeof parseSkillFile> {
  try {
    if (!statSync(path).isFile()) return null;
    return parseSkillFile(readFileSync(path, "utf8"), fallbackName);
  } catch {
    return null;
  }
}
