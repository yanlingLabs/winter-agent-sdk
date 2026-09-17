// SDK 0.0.16 Lane C (P16-5): the session's `# Environment` section, in claude 0.3.250's shape.
//
// Replaces 0.0.15's `## Current session` block. claude splits what that block carried three ways,
// and so does Winter now:
//   - cwd / git-repo flag / platform / shell / OS version / the model -> this `# Environment`
//     section, in the DYNAMIC half of the system prompt (claude's `env_info_simple`, `mHn`);
//   - the date -> the userContext `currentDate` entry (context/assembler.ts), so the system prompt
//     stays byte-stable across midnight and a `date_change` attachment announces the new day;
//   - the memory directory -> the `# auto memory` section (context/memory.ts).
// The git summary it used to carry is the systemContext `gitStatus` snapshot now
// (context/git-status.ts), appended to the system prompt last.
//
// SHAPE, from the pinned binary: a `# Environment` heading, the fixed lead-in line (with its
// trailing space), then ` - `-bulleted facts; an array fact (the additional working directories)
// nests one level deeper. The PRODUCT lines at the end are Winter's own wording (claude's describe
// its own CLI and model family).
//
// `excludeDynamicSections` splits the section the way claude does: the model/product half is
// session-independent enough to stay in the cacheable STATIC half (`fHn`), and the machine half
// moves into the index-0 userContext under the key `Environment` (`gHn`, with its heading stripped by
// `jEe`).

export const ENVIRONMENT_HEADING = "# Environment";
export const ENVIRONMENT_LEAD_IN = "You have been invoked in the following environment: ";

/** Winter's product line (claude's equivalent lines describe its own CLI). */
export const WINTER_PRODUCT_LINE = "Winter runs this session as an agent runtime on behalf of a host application; the host decides how your output is shown to the user.";

export interface EnvironmentInput {
  cwd: string;
  isGitRepo: boolean;
  platform: string;
  /** The raw `$SHELL` value; reduced to `zsh` / `bash` the way claude reduces it. */
  shell: string;
  /** `<os type> <os release>`, e.g. `Darwin 25.6.0`. */
  osVersion: string;
  additionalDirectories?: readonly string[];
  /** The model id this session generates with. Absent: no model line. */
  model?: string;
  /** The model's display name, when the catalog knows one. */
  modelDisplayName?: string;
  /** The model's knowledge cutoff, when known. Winter's catalog carries none today, so the line is normally absent. */
  knowledgeCutoff?: string;
}

/** claude's `GEe`: the shell as `zsh`, `bash`, the raw value, or `unknown`. */
export function shellName(raw: string): string {
  const shell = raw.trim().length > 0 ? raw : "unknown";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  return shell;
}

/** claude's `Sf`, exactly: ` - <fact>`, and each member of a nested array as `  - <item>`. */
function bullets(items: ReadonlyArray<string | readonly string[]>): string[] {
  return items.flatMap((item) => (typeof item === "string" ? [` - ${item}`] : item.map((sub) => `  - ${sub}`)));
}

function modelLines(input: Pick<EnvironmentInput, "model" | "modelDisplayName" | "knowledgeCutoff">): string[] {
  const lines: string[] = [];
  if (input.model !== undefined && input.model.length > 0) {
    lines.push(
      input.modelDisplayName !== undefined && input.modelDisplayName.length > 0
        ? `You are powered by the model named ${input.modelDisplayName}. The exact model ID is ${input.model}.`
        : `You are powered by the model ${input.model}.`,
    );
  }
  if (input.knowledgeCutoff !== undefined && input.knowledgeCutoff.length > 0) lines.push(`Assistant knowledge cutoff is ${input.knowledgeCutoff}.`);
  return lines;
}

function machineFacts(input: EnvironmentInput): Array<string | readonly string[]> {
  const dirs = input.additionalDirectories ?? [];
  return [
    `Primary working directory: ${input.cwd}`,
    `Is a git repository: ${input.isGitRepo}`,
    ...(dirs.length > 0 ? ["Additional working directories:", dirs] : []),
    `Platform: ${input.platform}`,
    `Shell: ${shellName(input.shell)}`,
    `OS Version: ${input.osVersion}`,
  ];
}

/** The whole section for the system prompt's dynamic half (claude's `mHn`). */
export function renderEnvironmentSection(input: EnvironmentInput): string {
  return [ENVIRONMENT_HEADING, ENVIRONMENT_LEAD_IN, ...bullets([...machineFacts(input), ...modelLines(input), WINTER_PRODUCT_LINE])].join("\n");
}

/** `excludeDynamicSections`, static half (claude's `fHn`): the model and product lines only. */
export function renderStaticEnvironmentSection(input: Pick<EnvironmentInput, "model" | "modelDisplayName" | "knowledgeCutoff">): string {
  return [ENVIRONMENT_HEADING, ...bullets([...modelLines(input), WINTER_PRODUCT_LINE])].join("\n");
}

/**
 * `excludeDynamicSections`, userContext half (claude's `gHn` through `jEe`): the machine facts under
 * the lead-in, WITHOUT the heading -- the heading's text becomes the userContext key `Environment`.
 */
export function renderEnvironmentContextValue(input: EnvironmentInput): string {
  return [ENVIRONMENT_LEAD_IN, ...bullets(machineFacts(input))].join("\n");
}
