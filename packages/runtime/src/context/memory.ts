// Phase 5 Lane C (task 6) -- what the model is TOLD about auto-memory, and the index it is handed
// (WS-11 §3, WS-05 §11).
//
// WHERE THIS SITS RELATIVE TO THE PRESET. WS-11 §3 says index discipline is "part of the authored
// prompt guidance (§6.2)", and the authored product preset does carry an auto-memory section -- but
// that section is deliberately PATH-FREE and posture-only, because the preset is the cacheable
// half of the prompt and a machine-specific path in it defeats that. The concrete half lives here:
// the directory, the caps as actual numbers, and the write/index protocol. Neither restates the
// other. The minimal prompt carries none of it (R5-9 caps it at tool-calling guidance), which is
// the other reason this block cannot be preset-only: a default session has auto-memory too.
//
// SDK 0.0.16 Lane C (P16-5): WHERE EACH HALF GOES NOW, as in claude 0.3.250. The GUIDANCE (with the
// directory) is the system prompt's `# auto memory` section, in the dynamic half; the INDEX is one
// entry of the index-0 userContext's `claudeMd` value, labelled as auto-memory
// (context/assembler.ts). Both are built once per session context: an edit to MEMORY.md is seen after
// the next compaction or in a new session, which is claude's behaviour too.
import { join } from "node:path";
import { WINTER_BRAND, type Settings } from "@yanlinglabs/winter-agent-sdk";
import { readCappedLinesAndBytes } from "./injection.ts";

export const MEMORY_INDEX_BASENAME = "MEMORY.md";

/**
 * The compatibility-profile load cap, pinned by WS-05 §11 and WS-11 §3: the first 200 lines OR
 * 25 KB of `MEMORY.md`, whichever hits first. Binary KB (25 * 1024), matching Norma's shipped
 * numbers this is ported from. Version-drift tested; behaviour, not a format guarantee.
 */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;

/**
 * `Settings.autoMemoryEnabled`. UNSET MEANS ENABLED -- the key is an opt-OUT (WS-11 §3:
 * "hosted/hermetic deployments MAY disable automatic memory"), so the absence of a settings file
 * cannot be read as "no memory". Only a literal `false` disables; a JSON settings file can hold
 * anything, and a truthy-but-not-boolean value must not fall through to disabled by accident.
 */
export function autoMemoryEnabled(settings: Settings | undefined): boolean {
  return settings?.autoMemoryEnabled !== false;
}

/** The capped index for a memory directory, or `null` when there is nothing to inject. */
export function loadMemoryIndex(memoryDir: string): string | null {
  return readCappedLinesAndBytes(join(memoryDir, MEMORY_INDEX_BASENAME), MEMORY_INDEX_MAX_LINES, MEMORY_INDEX_MAX_BYTES);
}

/**
 * Winter's own index-discipline guidance. Authored here, in Winter's voice, from WS-11 §3's own
 * rules: one memory directory per project, no dedicated tools, MEMORY.md is an index and topic
 * files hold the detail, and the index is capped so it must stay terse.
 *
 * The caps are stated as NUMBERS rather than as "keep it short". A model that does not know the
 * index is truncated at 200 lines has no reason to treat an index line as expensive, and the
 * failure mode -- an index that grows past the cap and silently loses its oldest entries -- is
 * invisible from inside the session.
 */
function memoryGuidance(memoryDir: string, instructionsFile: string): string {
  const indexPath = join(memoryDir, MEMORY_INDEX_BASENAME);
  return [
    `Auto-memory for this project lives at ${memoryDir}. The directory is created on demand and there are no memory tools: read and write it with the ordinary file tools, exactly like any other directory.`,
    `${indexPath} is the INDEX, and only its first ${MEMORY_INDEX_MAX_LINES} lines / ${Math.round(MEMORY_INDEX_MAX_BYTES / 1024)} KB are loaded into a session's context, when the session starts. Keep every index entry to one line; the substance belongs in the topic file it points at, which you can read on demand when it turns out to matter.`,
    `To record something worth having in a LATER session -- a standing preference, a correction you were given, a durable constraint of this project -- write it to its own \`<slug>.md\` in that directory and add a one-line pointer to the index: \`- [<slug>](<slug>.md) — <one-line summary>\`.`,
    "Revise a fact by rewriting its file and its index line, never by adding a near-duplicate under a new name; remove both once it stops being true. An index full of stale near-duplicates is worse than an empty one, because it costs the same and misleads.",
    `Do not record what the repository already records. Code, configuration, documentation and ${instructionsFile} are durable on their own; memory is for what is true about this project or this user and lives nowhere in the tree.`,
  ].join("\n\n");
}

/** claude's section heading for the auto-memory guidance. */
export const AUTO_MEMORY_HEADING = "# auto memory";

/**
 * The system prompt's `# auto memory` section: the heading, a blank line, Winter's own guidance
 * (which names the directory). Injected even with no `MEMORY.md` on disk -- a fresh project has
 * nothing to recall but every reason to know it CAN save something.
 */
export function renderAutoMemorySection(memoryDir: string, instructionsFile: string = WINTER_BRAND.instructionsFile): string {
  // P7a fix wave (item 5, M-1): the instructions file is named IN PROSE SENT TO THE MODEL, so the
  // session's own brand supplies it.
  return `${AUTO_MEMORY_HEADING}\n\n${memoryGuidance(memoryDir, instructionsFile)}`;
}

/** `excludeDynamicSections`: the same guidance as the userContext value under the key `auto memory` (claude's `jEe` strips the heading). */
export function renderAutoMemoryContextValue(memoryDir: string, instructionsFile: string = WINTER_BRAND.instructionsFile): string {
  return memoryGuidance(memoryDir, instructionsFile);
}
