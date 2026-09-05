// Phase 5 Lane C (task 6) -- the DYNAMIC block (WS-11 §6.3, Ruling R5-9).
//
// The machine- and session-specific facts a model cannot know any other way: where it is running,
// on what, in which shell, on what date, what the repository looks like right now, and where its
// memory lives. R5-9 names that list; §6.3 makes its POSITION configurable, because the whole
// point of separating it is caching -- the authored prompt above it is identical for every session
// on every host, so a host that moves this block out of `system` (via `excludeDynamicSections`)
// gets a system prefix that caches across sessions and machines.
//
// This module only RENDERS. Where the result lands -- `system`, or the first user-context block --
// is the assembler's decision, and is the one thing §6.3 actually configures.
//
// EVERY FIELD IS OMITTED WHEN ABSENT, never rendered as an empty or placeholder value. The engine
// populates only some of these today (`gitSummary` and `memoryDir` have no producer until T8), and
// a block that said "Git: undefined" would be actively worse than one that said nothing: the model
// cannot tell a missing input from a genuine empty repository state.

/**
 * Deliberately NOT `## Environment`: the preset carries a section by that name (its posture toward
 * the machine), and two identical headings in one prompt make it ambiguous which one an
 * instruction belongs to. This block is the live readings; the preset section is the standing
 * attitude toward them.
 */
export const DYNAMIC_SECTIONS_HEADING = "## Current session";

export interface DynamicSectionsInput {
  cwd: string;
  platform: string;
  osVersion: string;
  shell: string;
  date: string;
  gitSummary?: string;
  /** Absent when auto-memory is disabled -- which is how "disabled" reads in this block. */
  memoryDir?: string;
}

/** Blank and whitespace-only are ABSENT, matching the `isUnset` convention the paths layer uses for env values. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function renderDynamicSections(input: DynamicSectionsInput): string {
  const lines: string[] = [DYNAMIC_SECTIONS_HEADING];

  const cwd = present(input.cwd);
  if (cwd !== undefined) lines.push(`- Working directory: ${cwd}`);

  const platform = present(input.platform);
  const osVersion = present(input.osVersion);
  if (platform !== undefined) lines.push(osVersion === undefined ? `- Platform: ${platform}` : `- Platform: ${platform} (release ${osVersion})`);
  else if (osVersion !== undefined) lines.push(`- OS release: ${osVersion}`);

  const shell = present(input.shell);
  if (shell !== undefined) lines.push(`- Shell: ${shell}`);

  const date = present(input.date);
  if (date !== undefined) lines.push(`- Today's date: ${date}`);

  const memoryDir = present(input.memoryDir);
  if (memoryDir !== undefined) lines.push(`- Auto-memory directory: ${memoryDir}`);

  // Last, and indented if multi-line: a git summary is the only field with no bounded shape, and an
  // un-indented second line would read as a sibling bullet of the list rather than as continuation.
  const gitSummary = present(input.gitSummary);
  if (gitSummary !== undefined) {
    const [first, ...rest] = gitSummary.split("\n");
    lines.push(`- Repository: ${first}`);
    for (const line of rest) lines.push(`  ${line}`);
  }

  return lines.join("\n");
}
