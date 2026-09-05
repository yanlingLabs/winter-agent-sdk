// Phase 5 Lane S (WS-11 §2.1): filesystem DISCOVERY for the skill tiers. Metadata only -- this file
// never reads a skill BODY into a returned value (`SKILL.md` is read to parse its frontmatter and
// the parsed body is dropped on the floor), which is the operational meaning of "bodies load lazily
// on invocation": store.ts's `load()` re-reads the file at invocation time.
//
// DEFENSIVE THROUGHOUT, Norma parity: a missing root, an unreadable directory, a malformed
// SKILL.md, a `SKILL.md` that is itself a directory -- every one is SKIPPED, never thrown. A single
// broken skill in a checked-in `.winter/skills/` must not be able to fail a session's startup.
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSkillFile, type ParsedSkillFile } from "./frontmatter.ts";

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

/** One SKILL.md that could not become an index entry -- surfaced, never silently dropped (A-11). */
export interface SkillScanError {
  /** The immediate subdirectory of the scanned root -- what an author would go and look at. */
  directory: string;
  /** Absolute path of the SKILL.md. */
  path: string;
  source: SkillTier;
  reason: string;
}

export interface SkillScanResult {
  skills: DiscoveredSkill[];
  errors: SkillScanError[];
}

/** The reserved subdirectory of the user root that holds agent-authored skills (Norma parity). */
export const SELF_SUBDIR = "self";

/**
 * THE INDEX-TIME READ BOUND (fix wave, A-11 / T5 review Nit 5).
 *
 * `SkillIndex.build()` used to `readFileSync` every SKILL.md in full and drop the parsed body --
 * "lazy" meant NOT RETAINED, not NOT READ. That read is unconditional and pre-session: it covers
 * every `<cwd>/.winter/skills/**` up to the repository root, content that arrives with a `git clone`,
 * before any trust decision and before the model runs. With no cap at all the bound was "the total
 * bytes of every skill file in the tree" -- a 64 MB SKILL.md cost 64 MB of heap during startup, and
 * a startup failure is not something a session can route around.
 *
 * Frontmatter lives at the HEAD of the file, so a bounded prefix is everything the index needs.
 * `load()` keeps the full read (bodies are what it exists to fetch), which is the split that makes
 * this safe: the cap bounds DISCOVERY, never invocation.
 */
export const SKILL_METADATA_PREFIX_BYTES = 65_536;

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
export function scanSkillRoot(root: string, source: SkillTier, exclude?: ReadonlySet<string>): SkillScanResult {
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
    return { skills: [], errors: [] }; // a root that does not exist is not an error -- most sessions have none
  }
  const skills: DiscoveredSkill[] = [];
  const errors: SkillScanError[] = [];
  for (const dir of dirs) {
    if (exclude?.has(dir)) continue;
    const path = join(root, dir, "SKILL.md");
    // BOUNDED at index time (A-11). The unbounded read is `SkillIndex.load()`'s, at invocation.
    const read = readSkillMetadata(path, dir, { maxBytes: SKILL_METADATA_PREFIX_BYTES });
    if (read.ok) {
      skills.push({ name: read.skill.name, description: read.skill.description, source, path, ...(read.skill.author !== undefined ? { author: read.skill.author } : {}) });
    } else if (read.reason !== ABSENT_SKILL_FILE) {
      // A directory with no SKILL.md at all is not a broken skill -- it is not a skill. Everything
      // else (unparseable, unreadable, frontmatter past the bound) is reported: a skill that
      // vanishes from the listing with no explanation anywhere is the failure mode A-11 names.
      errors.push({ directory: dir, path, source, reason: read.reason });
    }
  }
  return { skills, errors };
}

/** Scan the user root, skipping its reserved `self/` subdirectory. */
export function scanUserSkillRoot(root: string): SkillScanResult {
  return scanSkillRoot(root, "user", USER_ROOT_EXCLUDE);
}

/** The one reason `scanSkillRoot` does NOT report: a subdirectory that simply holds no SKILL.md. */
export const ABSENT_SKILL_FILE = "no SKILL.md";

export type SkillMetadataRead = { ok: true; skill: ParsedSkillFile } | { ok: false; reason: string };

/**
 * Read one SKILL.md's METADATA. Shared by `scanSkillRoot` above and by store.ts's `load()`, so the
 * frontmatter contract is applied exactly once.
 *
 * `opts.maxBytes` reads only that many bytes from the head of the file (A-11): the frontmatter is at
 * the top, so the index never pays for a body it is about to drop. WITHOUT it the whole file is
 * read, which is what `load()` wants and needs.
 *
 * A RESULT, not `null`, because the two failures are not the same fact: "this is not a skill" and
 * "this skill could not be read" both used to disappear identically, which is precisely the silent
 * vanish A-11 is about. A prefix read that finds an unclosed fence says so, naming the bound, rather
 * than reporting the file as unparseable -- it may be perfectly valid and merely enormous.
 */
export function readSkillMetadata(path: string, fallbackName: string, opts: { maxBytes?: number } = {}): SkillMetadataRead {
  let raw: string;
  let truncated = false;
  try {
    if (!statSync(path).isFile()) return { ok: false, reason: ABSENT_SKILL_FILE };
    if (opts.maxBytes === undefined) {
      raw = readFileSync(path, "utf8");
    } else {
      const read = readPrefix(path, opts.maxBytes);
      raw = read.text;
      truncated = read.truncated;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT is "not a skill"; anything else (EACCES on a chmod 000 file, EISDIR, an I/O error) is a
    // skill the author meant to have and cannot use.
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { ok: false, reason: ABSENT_SKILL_FILE };
    return { ok: false, reason: `SKILL.md could not be read: ${message}` };
  }
  const parsed = parseSkillFile(raw, fallbackName);
  if (parsed !== null) return { ok: true, skill: parsed };
  if (truncated) {
    return { ok: false, reason: `its frontmatter is not closed within the first ${opts.maxBytes} bytes of the file, which is the index-time read bound (SKILL_METADATA_PREFIX_BYTES)` };
  }
  return { ok: false, reason: "no usable frontmatter: a SKILL.md needs a `---` fence at the very top of the file with at least a `description:` inside it" };
}

/** Reads at most `maxBytes` from the head of `path`. `truncated` means the file is longer than that. */
function readPrefix(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.subarray(0, read).toString("utf8"), truncated: read >= maxBytes };
  } finally {
    closeSync(fd);
  }
}
