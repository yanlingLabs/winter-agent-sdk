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

// RULING R5-17 (pre-flight scan T5<->T6): Lane S produces this listing, Lane C consumes it through
// `SystemPromptInput.skillListing`, and neither lane may define it -- it lives here, in the spine,
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
 * `env`/`platform`/`osVersion`/`shell`/`date`/`gitSummary` are the "dynamic section" inputs (R5-9);
 * whether they land in `system` or move into the first user-context block is `excludeDynamicSections`'
 * job, which lives inside `config.systemPrompt`'s preset arm, not here.
 */
export interface SystemPromptInput {
  config: RuntimeConfig;
  cwd: string;
  env: Record<string, string | undefined>;
  platform: string;
  osVersion: string;
  shell: string;
  date: string;
  gitSummary?: string;
  memoryDir?: string;
  skillListing?: SkillListing;
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
}

/**
 * What the assembler produces.
 *
 * `system` goes on `ProviderRequest.system` verbatim.
 *
 * `userContextBlocks` are prepended to THIS TURN'S user message on the live request only -- never
 * pushed into the engine's own message history and never persisted (Ruling P1-B keeps the engine
 * storage-agnostic, and a block that entered history would be re-sent, re-summarized and
 * re-persisted on every later turn). They are re-attached every turn, which is what "always injected
 * as user-context, never system text" (R5-9) means operationally for WINTER.md and the memory index.
 *
 * `presetVersion` is the version stamp of whichever authored prompt produced `system`, for
 * conformance/diagnostics.
 *
 * RIDER 14 (seam-doc correction). This used to read "Absent when no preset was involved", and Lane C
 * ships something stricter than that wording allows: the MINIMAL arm is stamped too
 * (`winter_minimal@1`), even though R5-9 calls it an "authored minimal prompt" rather than a preset.
 * RATIFIED, and the reason is the field's own stated purpose -- leaving the DEFAULT arm unstamped
 * would make the most common session in existence the one you cannot identify from the assembled
 * result. P5-G's companion clause says the same ("the minimal default prompt is versioned too,
 * `winter_minimal@<n>`").
 *
 * The rule the field actually follows, stated so a future reader does not have to infer it from two
 * implementations: **absent exactly when WINTER AUTHORED NOTHING**. The caller-supplied `string` and
 * `string[]` arms are correctly unstamped; `undefined` and the preset arm are stamped.
 */
export interface AssembledPrompt {
  system: string;
  userContextBlocks: string[];
  presetVersion?: string;
  /**
   * Phase 5 Task 8 (rider 22, RULING P5-G): TRUE when a PROJECT-tier output style asked to replace
   * Winter's authored prompt (`keep-coding-instructions: false`) and the assembler downgraded it to
   * an append because the host has not declared workspace trust.
   *
   * P5-G says the downgrade "is observable". Before this field it was observable only on
   * `resolveOutputStyle`'s own return value -- a function no host calls and no wire frame carries --
   * so the ruling held inside `context/output-styles.ts` and nowhere a caller could see it. A
   * checked-in style silently doing less than it says is exactly the kind of thing an operator needs
   * told; ABSENT (never `false`) when nothing was downgraded, so a session with no project style is
   * byte-identical to one from before this field existed.
   */
  replacementDowngraded?: boolean;
}

export interface SystemPromptAssembler {
  assemble(input: SystemPromptInput): AssembledPrompt;
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
  userContextBlocks?: string[];
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
        userContextBlocks: opts?.userContextBlocks ?? [],
        ...(opts?.presetVersion !== undefined ? { presetVersion: opts.presetVersion } : {}),
      };
    },
  };
}
