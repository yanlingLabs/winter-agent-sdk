// Phase 5 Lane C (task 6) -- WINTER.md discovery (WS-11 §6.4, Ruling R5-9, Ruling P5-A).
//
// WINTER.md is INJECTED CONTEXT, never system text. The distinction is the whole point of §6.4:
// system text is the cacheable, session-stable prefix, while a project's instructions are file
// content that changes with the repository and must sit where the conversation can see it, be
// compacted like conversation, and be re-attached rather than baked in. So everything here
// produces `AssembledPrompt.userContextBlocks` entries and nothing here can reach `system` --
// which is also why the seam's own doc names WINTER.md and the memory index as what "always
// injected as user-context" means operationally.
//
// TWO GIT ROOTS, AND THEY ARE NOT THE SAME ROOT. memory-key.ts scopes memory by
// `--git-common-dir`, deliberately, so linked worktrees SHARE one memory directory. The
// instruction walk must NOT use that root: for a linked worktree the common root is the MAIN
// checkout, which is not an ancestor of the worktree at all -- a walk bounded by it would never
// terminate at the worktree and would climb to the filesystem root, reading whatever WINTER.md
// happened to sit above it. The instruction boundary is `--show-toplevel`: the checkout the cwd
// actually lives in. Both behaviours are fixtured against one real `git worktree add`.
//
// THE SOURCE GATE IS P5-A's, NOT A TRUST GATE. Project skills, commands and WINTER.md are gated on
// `project ∈ settingSources` -- they are instructions, not permission participants (project AGENT
// definitions stay trust-gated, R4-7, because a definition carries tool grants). `settingSources`
// omitted means all three tiers, which is the pinned CLI default; `[]` is the hermetic-host mode
// and reads nothing from the filesystem.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SettingSource } from "@yanlinglabs/winter-agent-sdk";
import { readCapped, systemReminder } from "./injection.ts";

export const WINTER_MD_BASENAME = "WINTER.md";

/**
 * Per-file byte ceiling. WINTER-DEFINED (the specs cap the memory index, not this): a block
 * re-attached to every turn needs a ceiling or one large checked-in file costs the session its
 * window on every request. 32 KB is Norma's shipped instructions cap, carried over.
 */
export const WINTER_MD_MAX_BYTES = 32 * 1024;

export interface WinterMdBlock {
  /** Absolute path of the file this block came from. */
  path: string;
  scope: "user" | "project";
  /** The finished, wrapped, injection-safe block -- ready to be a `userContextBlocks` entry. */
  text: string;
}

// Memoised `resolved cwd -> worktree toplevel (or null)`. Same reasoning as memory-key.ts's cache:
// `assemble()` runs once per envelope and a session's checkout does not move underneath it.
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
}

/**
 * The WINTER.md blocks for a session, in the PINNED ORDER: the user-level file first, then every
 * project file from the repository root down to the cwd.
 *
 * User-first is deliberate. The user's own `~/.winter/WINTER.md` is standing preference; a
 * project's file is specific to the work in front of the model. Reading the specific thing last
 * matches the outermost-first rule the project walk already follows, so one rule covers the whole
 * ordering rather than two that could drift.
 */
export function discoverWinterMd(input: WinterMdInput): WinterMdBlock[] {
  const sources = input.settingSources ?? (["user", "project", "local"] as const);
  const blocks: WinterMdBlock[] = [];

  if (sources.includes("user")) {
    const path = join(input.home, WINTER_MD_BASENAME);
    const body = readCapped(path, WINTER_MD_MAX_BYTES);
    if (body !== null) {
      blocks.push({ path, scope: "user", text: systemReminder(`User instructions, auto-loaded from ${path}. These are standing preferences, not something the user typed this turn.`, body) });
    }
  }

  // `local` is deliberately NOT a second WINTER.md tier: WS-01 §2.4 gives the project exactly one
  // instructions file, and `settings.local.json` is the local tier's whole surface.
  if (sources.includes("project")) {
    for (const dir of instructionDirectories(input.cwd)) {
      const path = join(dir, WINTER_MD_BASENAME);
      const body = readCapped(path, WINTER_MD_MAX_BYTES);
      if (body !== null) {
        blocks.push({ path, scope: "project", text: systemReminder(`Project instructions, auto-loaded from ${path}. These are checked in with the repository, not something the user typed this turn.`, body) });
      }
    }
  }

  return blocks;
}
