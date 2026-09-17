// Contract §8 (2026-09-17 addendum): the per-tool ACTIVITY TEXT an agent's `task_progress.description`
// carries -- the pin's own `getActivityDescription`, re-derived rule by rule from the contract table
// (never copied). The child engine computes it from each recorded `tool_use` block's input
// (child-engine.ts's `observe()`), and `tools/impl/agent.ts` falls back to the task description when
// this returns `undefined`.
//
// Tool names are Winter's CANONICAL names, which are claude's own names for every row of the table
// (`Bash`, `PowerShell`, `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `WebFetch`,
// `WebSearch`, `Agent`, `Monitor` -- see tools/descriptors/*.ts). A child engine is built with no
// `toolAliases` (child-engine.ts's own fidelity notes), so the names on its `tool_use` blocks are the
// canonical ones and no rename table is needed.
import { isAbsolute, relative, resolve, sep } from "node:path";

const TRUNC_LIMIT = 50;

/** `trunc(s)`: collapse whitespace runs (newlines included) to one space, trim, and keep the first 50 chars + `…` when longer. */
export function truncActivity(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > TRUNC_LIMIT ? `${collapsed.slice(0, TRUNC_LIMIT)}…` : collapsed;
}

/** `path(p)`: relative to the session cwd when inside it (no leading `..`), else `~/…` under the home dir, else absolute. */
export function displayActivityPath(p: string, cwd: string, home: string | undefined): string {
  const absolute = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, absolute);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  if (home !== undefined && home.length > 0 && absolute.startsWith(home.endsWith(sep) ? home : home + sep)) {
    return `~${sep}${absolute.slice((home.endsWith(sep) ? home : home + sep).length)}`;
  }
  return absolute;
}

// A Winter task output file: `<session-temp>/tasks/<task-id>.output` (tools/background-tasks.ts's
// own layout) -- Read of one names the TASK, not the path.
const TASK_OUTPUT_FILE = /[\\/]tasks[\\/]([^\\/]+)\.output$/;

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

export interface ActivityContext {
  cwd: string;
  home?: string;
}

/**
 * The activity text for one recorded tool call, or `undefined` when the tool has none (any tool not in
 * the contract's table). A missing field takes the table's own fallback text.
 */
export function toolActivityDescription(toolName: string, rawInput: unknown, ctx: ActivityContext): string | undefined {
  const input = typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
  const path = (key: string): string | undefined => {
    const v = str(input, key);
    return v === undefined ? undefined : displayActivityPath(v, ctx.cwd, ctx.home);
  };
  switch (toolName) {
    case "Bash":
    case "PowerShell": {
      const description = str(input, "description");
      const command = str(input, "command");
      if (description === undefined && command === undefined) return "Running command";
      return `Running ${description ?? truncActivity(command!)}`;
    }
    case "Read": {
      const filePath = str(input, "file_path");
      if (filePath === undefined) return "Reading file";
      const task = TASK_OUTPUT_FILE.exec(filePath);
      return `Reading ${task !== null ? task[1] : displayActivityPath(filePath, ctx.cwd, ctx.home)}`;
    }
    case "Write": {
      const p = path("file_path");
      return p === undefined ? "Writing file" : `Writing ${p}`;
    }
    case "Edit": {
      const p = path("file_path");
      return p === undefined ? "Editing file" : `Editing ${p}`;
    }
    case "NotebookEdit": {
      const p = path("notebook_path");
      return p === undefined ? "Editing notebook" : `Editing notebook ${p}`;
    }
    case "Glob": {
      const pattern = str(input, "pattern");
      return pattern === undefined ? "Finding files" : `Finding ${truncActivity(pattern)}`;
    }
    case "Grep": {
      const pattern = str(input, "pattern");
      return pattern === undefined ? "Searching" : `Searching for ${truncActivity(pattern)}`;
    }
    case "WebFetch": {
      const url = str(input, "url");
      return url === undefined ? "Fetching web page" : `Fetching ${truncActivity(url)}`;
    }
    case "WebSearch": {
      const query = str(input, "query");
      return query === undefined ? "Searching the web" : `Searching for ${truncActivity(query)}`;
    }
    case "Agent": {
      const description = str(input, "description");
      return description === undefined ? "Running task" : description.replace(/\s+/g, " ").trim();
    }
    case "Monitor": {
      const description = str(input, "description");
      return description === undefined ? "Monitoring" : `Monitoring: ${description}`;
    }
    default:
      return undefined;
  }
}
