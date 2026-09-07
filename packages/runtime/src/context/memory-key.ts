// Phase 5 Lane C (task 6) -- WHERE a session's auto-memory lives (WS-11 §3, WS-05 §11, WS-01 §2.2).
//
// `~/.winter/projects/<memory-key>/memory/MEMORY.md` plus topic files. The key derives from the git
// COMMON ROOT, not the cwd and not the worktree toplevel, so every linked worktree of a repository
// shares one memory directory -- the property WS-11 §3 names outright and the one this module
// exists for.
//
// NOTHING IS RE-DERIVED HERE. `compatibilityKeys(cwd).memoryProjectKey` (packages/sdk/src/paths/
// keys.ts) already answers exactly this question: it canonicalises the cwd, asks git for
// `--git-common-dir`, and runs the pinned project-key sanitiser over the result, falling back to
// the cwd key when the cwd is not in a repository or git is unavailable. A second implementation
// here would be a second answer to a question the store already has one for, and the two would
// drift the first time the sanitiser changed. This module adds only the two things that helper
// does not do: the P1-N directory-name override, and memoisation.
//
// DISCLOSED WIDENING OF P1-N. `resolveProjectDirName`'s own doc says the project-dir-name override
// overrides "ONLY the persistent transcript-project directory name". The task-6 brief directs the
// memory key through the same helper, which makes the override relocate memory too. That is
// coherent -- both are the `<projectKey>` segment of `<home>/projects/<projectKey>/...`, so a
// relocated project keeps its transcript and its memory together rather than splitting them -- but
// it IS wider than the helper's own comment claims, and is called out in the task-6 report.
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { compatibilityKeys } from "@yanlinglabs/winter-agent-sdk";
import { resolveProjectDirName } from "../paths/project-dir-name.ts";

/**
 * Norma's `_global`/`_assistant` product buckets (a no-project bucket and the shared dream bucket).
 * WS-11 §3 and WS-05 §11 both pin them as PRODUCT EXTENSIONS that are never silently injected into
 * a Code session. Winter's assembler has no code path that can produce either: the pinned
 * project-key sanitiser maps every non-alphanumeric character to `-`, so a key can never begin with
 * `_`. This constant exists so that fact is assertable rather than merely true.
 */
export const RESERVED_MEMORY_KEYS: readonly string[] = ["_global", "_assistant"] as const;

// Memoised `cwd -> memoryProjectKey` (pre-override). `compatibilityKeys` spawns git synchronously,
// and `assemble()` runs once per user envelope -- a spawn per turn for an answer that cannot change
// over a session's life is pure waste. Keyed by the RESOLVED cwd so `.` and an absolute spelling of
// the same directory share an entry. Unbounded is fine: a process sees a small, roughly fixed set
// of distinct cwds (Norma's memory-dir module reached the same conclusion for the same reason).
//
// DISCLOSED STALENESS (whole-branch n1), the same disclosure winter-md.ts's `rootCache` carries: no
// entry is ever invalidated, so a long-lived host in which one path is deleted and re-cloned with a
// different git layout keeps the first key for the life of the process. Accepted for the same
// reasons -- no watchers inside the SDK, and a per-envelope git spawn is the cost this cache exists
// to avoid.
const keyCache = new Map<string, string>();

/**
 * TEST-ONLY. A suite that builds throwaway repositories at reused paths, or that wants to prove the
 * cache is not the thing making an assertion pass, must be able to clear it. Production never calls
 * this.
 */
export function _clearMemoryKeyCacheForTests(): void {
  keyCache.clear();
}

/** `~` / `~/x` expansion for a settings-supplied directory (a settings file may legitimately hold either). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The `<memory-key>` segment for `cwd`: the git-common-root-derived key, then the P1-N env
 * override. `env` is injectable so tests never read the real process environment.
 */
export function memoryProjectKeyFor(cwd: string, env?: Record<string, string | undefined>): string {
  const cacheKey = resolve(cwd);
  let derived = keyCache.get(cacheKey);
  if (derived === undefined) {
    derived = compatibilityKeys(cacheKey).memoryProjectKey;
    keyCache.set(cacheKey, derived);
  }
  return resolveProjectDirName(derived, env);
}

export interface MemoryDirInput {
  cwd: string;
  /** The `~/.winter` root (WINTER_HOME-aware; the caller resolves it). */
  home: string;
  env?: Record<string, string | undefined>;
  /**
   * `Settings.autoMemoryDirectory` (or a host-supplied `SystemPromptInput.memoryDir`) -- REPLACES
   * the computed path entirely, with no further per-project nesting beneath it, mirroring the
   * pinned relocatable-directory setting. Whitespace-only counts as ABSENT: a settings.json holding
   * `"autoMemoryDirectory": ""` must not resolve memory to the home directory itself.
   *
   * The pinned key is ignored when it comes from PROJECT settings (its own declaration says so, for
   * security) -- that filter is `OVERLAY_NEVER_KEYS` in the settings layer, upstream of here. This
   * module consumes whatever survived it and re-litigates nothing.
   */
  override?: string;
}

/** The absolute auto-memory directory for a session. Pure path computation -- creates nothing. */
export function memoryDirFor(input: MemoryDirInput): string {
  const override = input.override?.trim();
  if (override !== undefined && override.length > 0) {
    const expanded = expandTilde(override);
    return isAbsolute(expanded) ? expanded : resolve(input.cwd, expanded);
  }
  return join(input.home, "projects", memoryProjectKeyFor(input.cwd, input.env), "memory");
}
