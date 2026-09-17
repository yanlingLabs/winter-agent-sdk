// Phase 5 Task 3 (spine): the SYSTEM-PROMPT ASSEMBLY seam -- Lane C (task 6) implements it, the
// engine consumes it, and nothing else in the runtime may grow a second producer of a system prompt.
//
// WHY A SEAM AND NOT A FUNCTION. Lane C builds the whole context surface (minimal prompt, the
// the authored product preset, dynamic sections, instructions-file discovery, memory index, output styles,
// plan-mode body) in an isolated worktree that may not touch `engine.ts` (R5-12). This file is the
// contract both sides compile against: the engine calls `assemble()` once per user envelope and puts
// the result on the LIVE provider request; Lane C decides everything about what that result contains.
//
// RULING R5-16 -- THE ENGINE'S FALLBACK IS AN EMPTY PROMPT, NOT A MINIMAL ONE. When no assembler is
// registered the engine sends an EMPTY system prompt. No authored fallback text lives in the engine,
// deliberately: R5-9's "authored minimal prompt" is Lane C's, and a second copy in the engine would
// be a second producer of exactly the kind the P5 spine exists to prevent (nothing fails to compile
// when two producers disagree about prompt text -- the divergence only ever shows up in a live
// request). T8 wires Lane C's assembler in production and asserts on the live request.
//
// GROUND TRUTH IS THE LIVE REQUEST (Global Constraints). Assert on what the provider was handed
// (`recordedProviderSystems()`, or a recording double), never on what an assembler intended to
// produce -- an assembler that returns the right string and an engine that drops it look identical
// from the assembler's own tests.
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import type { ContextEntry } from "./request-layout.ts";

// RULING R5-17 (pre-flight scan T5<->T6): Lane S produces this listing, Lane C consumes it (SDK 0.0.16:
// as the engine's persisted `skill_listing` attachment, context/attachments.ts), and neither lane may define it -- it lives here, in the spine,
// so the two sides cannot drift. `source` distinguishes where a skill was discovered, which is what
// makes the listing gate-able (project-sourced skills are settings-SOURCE-gated per P5-A, not
// trust-gated) and orderable.
//
// "self" is the agent's own bundled skills (WS-11 §2.1's built-in family that ships with the agent
// definition rather than with Winter); "builtin" is Winter's own. The pinned surface budgets and
// truncates this listing rather than merely enumerating it (`skillListingMaxDescChars`,
// `skillListingBudgetFraction` -- derived-shapes-p5 item (i)); enforcing those caps is Lane S's, and
// this type is deliberately the POST-truncation shape so the assembler never has to re-derive them.
export type SkillListing = Array<{ name: string; description: string; source: "project" | "user" | "plugin" | "builtin" | "self" }>;

/**
 * The configured output style's NAME -- `RuntimeConfig.outputStyle` / `Settings.outputStyle`, e.g.
 * `"default"`.
 *
 * DIVERGENCE FROM THE BRIEF'S SPELLING, disclosed: the task-3 brief writes `outputStyle?: OutputStyle`
 * without defining `OutputStyle`, and the obvious richer reading (a resolved `{name, body}` object)
 * would put style RESOLUTION in the engine. It belongs to Lane C -- project-tier output styles
 * discovery plus Winter's built-ins is that lane's own deliverable (task-6 brief), and the engine has
 * no business reading those files. So the seam carries the name and Lane C resolves the body, and the
 * brief's type name is kept so a lane brief citing it still lands somewhere.
 */
export type OutputStyle = string;

/**
 * Everything the assembler is allowed to depend on. Deliberately a PLAIN DATA snapshot: no
 * filesystem handles, no live getters, nothing session-mutable. Two consequences the lanes rely on --
 * an assembler is trivially testable from a literal, and the engine can compute this once per
 * envelope and reuse it for every provider call in that turn without re-reading the world mid-turn.
 *
 * `env`/`platform`/`osVersion`/`shell`/`model` feed the `# Environment` section; `date` feeds the
 * userContext `currentDate` entry (SDK 0.0.16). Whether the environment and auto-memory sections land
 * in `system` or move into the index-0 userContext is `excludeDynamicSections`' job, which lives inside
 * `config.systemPrompt`'s preset arm, not here.
 */
export interface SystemPromptInput {
  config: RuntimeConfig;
  cwd: string;
  env: Record<string, string | undefined>;
  platform: string;
  osVersion: string;
  shell: string;
  /** The session's LOCAL calendar date, `YYYY-MM-DD` (claude's `currentDate`). */
  date: string;
  /** SDK 0.0.16: the model id this session generates with, for the `# Environment` model line. */
  model?: string;
  /** SDK 0.0.16: the model's display name, when the host's catalog knows one. */
  modelDisplayName?: string;
  memoryDir?: string;
  outputStyle?: OutputStyle;
  planMode: boolean;
  hostPlanBody?: string;
  /**
   * DISCLOSED WINTER FIELD, not in the brief's list: the child persona a subagent runs with
   * (`AgentDefinition.prompt` composed over any inherited base -- subagents/child-engine.ts computes
   * it). R5-3 retires P4-J's first-turn concatenation of that text into the message history and
   * routes it "through `system`" instead; this is the field it travels on.
   *
   * An assembler that ignores it silently drops a child's persona, so Lane C MUST compose it. The
   * engine's own no-assembler fallback uses it VERBATIM as the whole system prompt, which is
   * consistent with R5-16: the engine still authors no text of its own, it only forwards the
   * caller's.
   */
  agentPrompt?: string;
  /**
   * Spawn-surface parity (research §A1's `Explore`/`Plan` field table: "`omitClaudeMd: true`;
   * context also drops gitStatus", mirrored on `RuntimeAgentDefinition.omitProjectContext`). When
   * true, the index-0 userContext carries NO `claudeMd` entry at all (claude's `omitClaudeMd` drops the
   * whole value -- the auto-memory index is one of its entries, so it goes too) and the systemContext
   * `gitStatus` is not produced (`systemContextPlacement: "none"`). Everything else -- the date, the
   * environment and auto-memory sections, the listings -- is unaffected.
   */
  omitProjectContext?: boolean;
}

/**
 * What the assembler produces.
 *
 * `system` goes on `ProviderRequest.system` (with the systemContext appended by the engine).
 *
 * SDK 0.0.16 (P16-5): NOTHING IS ATTACHED TO THE TURN'S USER MESSAGE ANY MORE. The instructions
 * files and the memory index are the index-0 userContext (`SystemPromptAssembler.userContext`,
 * memoized per session by the engine); the listings are persisted attachments
 * (context/attachments.ts). `userContextBlocks` is gone.
 *
 * `presetVersion` is the version stamp of whichever authored prompt produced `system`, for
 * conformance/diagnostics -- absent exactly when WINTER AUTHORED NOTHING (the caller-supplied
 * `string` and `string[]` arms), stamped for `undefined` (`winter_minimal@<n>`) and the preset arm.
 */
export interface AssembledPrompt {
  system: string;
  /**
   * SDK 0.0.16: `system` before it was joined -- the static (cacheable) half, the dynamic half, and
   * whether the region has a dynamic boundary at all. The engine turns these into claude's cache
   * blocks (`buildSystemBlocks`). Absent (a test double) = `system` is one uncached-scope block and the
   * request carries no `systemBlocks`.
   */
  systemParts?: { staticParts: string[]; dynamicParts: string[]; hasBoundary: boolean };
  /**
   * SDK 0.0.16: where the engine puts the systemContext `gitStatus` snapshot -- `system` (the last
   * system part, the default layout), `userContext` (the FIRST index-0 entry, under
   * `excludeDynamicSections`), or `none` (a caller-supplied prompt, an `omitProjectContext` agent,
   * the kill switch, `includeGitInstructions: false`). Absent = `none`.
   */
  systemContextPlacement?: "system" | "userContext" | "none";
  presetVersion?: string;
  /**
   * Phase 5 Task 8 (rider 22, RULING P5-G): TRUE when a PROJECT-tier output style asked to replace
   * Winter's authored prompt (`keep-coding-instructions: false`) and the assembler downgraded it to
   * an append because the host has not declared workspace trust. ABSENT (never `false`) otherwise.
   */
  replacementDowngraded?: boolean;
}

export interface SystemPromptAssembler {
  assemble(input: SystemPromptInput): AssembledPrompt;
  /**
   * SDK 0.0.16 (P16-5): the session's userContext entries, in claude's key order -- `claudeMd`, then
   * `currentDate` (then, under `excludeDynamicSections`, `Environment` and `auto memory`). The ENGINE
   * memoizes the result per session and clears it on compaction, so this reads the filesystem once
   * per session context rather than once per turn. Absent = no index-0 message.
   */
  userContext?(input: SystemPromptInput): ContextEntry[];
}

/**
 * The spine's own test double. NOT a minimal prompt and never a stand-in for one (R5-16): it echoes
 * its inputs in a mechanically checkable shape so an engine test can prove the assembled result
 * reached the LIVE request, and so a lane can develop against a producer that exists.
 *
 * Every part is optional-in, deterministic, and free of authored prose.
 */
export function fakeSystemPromptAssembler(opts?: {
  system?: string;
  /** SDK 0.0.16: the userContext entries the fake answers (absent = none, so no index-0 message). */
  userContext?: ContextEntry[];
  presetVersion?: string;
  /** Records every input the engine handed over, in call order -- the "was it called per turn, with what?" assertion. */
  calls?: SystemPromptInput[];
}): SystemPromptAssembler {
  return {
    assemble(input: SystemPromptInput): AssembledPrompt {
      opts?.calls?.push(input);
      const system = opts?.system ?? `[fake-assembler] cwd=${input.cwd} platform=${input.platform} planMode=${input.planMode}${input.agentPrompt !== undefined ? ` agentPrompt=${input.agentPrompt}` : ""}`;
      return {
        system,
        ...(opts?.presetVersion !== undefined ? { presetVersion: opts.presetVersion } : {}),
      };
    },
    ...(opts?.userContext !== undefined ? { userContext: () => [...opts.userContext!] } : {}),
  };
}
