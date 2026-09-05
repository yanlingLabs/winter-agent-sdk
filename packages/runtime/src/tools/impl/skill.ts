// Phase 5 Lane S (WS-11 §2.3, WS-06 §3.5 "Skill"): the REAL Skill executor, replacing the stub
// `descriptors/skill.ts` registers.
//
// "Invocation inserts the resolved skill instructions into the main conversation -- it is not
// one-tool-per-skill" (WS-11 §2.3). Operationally that means the tool RESULT *is* the skill body:
// there is no pointer, no summary, and no second round-trip. That is also why the body is loaded
// here and not at index time -- see skills/store.ts's lazy-body contract.
//
// THIN, by the same convention every other impl file follows: resolution, gating and the attachment
// payload all live under `skills/`, unit-tested with no registry involvement. This file is the
// ctx-adapter plus the refusal messages.
import "../descriptors/skill.ts"; // self-sufficiency: the stub must be registered before replaceExecutor runs.
import { replaceExecutor, type ToolExecutor, type ToolExecutionContext, type ToolResultPayload } from "../registry.ts";
import { invokedSkillsAttachment, type InvokedSkillEntry } from "../../skills/attachment.ts";
import { isModelVisible, isUserInvocable } from "../../skills/listing.ts";
import { isLegalSkillIdentity, isSkillEnabled, SKILL_TOOL_NAME } from "../../skills/option.ts";
import { getSkillSessionRuntime } from "../../skills/runtime.ts";

export { SKILL_TOOL_NAME };

interface SkillToolInput {
  skill: string;
  args?: string;
}

/**
 * `{ skill: string; args?: string }` -- WS-11 §2.3, sourced from report §40.32. Task 1 confirmed
 * there is NO `SkillInput` schema anywhere in the pinned declaration (derived-shapes item (i)), so
 * these field names rest on the runtime capture the spec already cites, and this validation adds no
 * independent confirmation of them.
 */
function parseInput(input: unknown): SkillToolInput | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return 'expected an object of the form { "skill": string, "args"?: string }';
  const skill = (input as { skill?: unknown }).skill;
  if (typeof skill !== "string" || skill.length === 0) return '"skill" is required and must be a non-empty string';
  const args = (input as { args?: unknown }).args;
  if (args !== undefined && typeof args !== "string") return '"args", when present, must be a string';
  return { skill, ...(args !== undefined ? { args } : {}) };
}

function error(message: string): ToolResultPayload {
  return { output: `Error: ${message}`, isError: true };
}

export const skillExecutor: ToolExecutor = {
  async execute(input: unknown, ctx: ToolExecutionContext): Promise<ToolResultPayload> {
    // `agentId ?? sessionId` -- a child carries its parent's sessionId, so keying by session alone
    // would resolve a child's invocation against the PARENT's skills option (tool-search.ts's own
    // fix wave found exactly this, for exactly this reason).
    const runtime = getSkillSessionRuntime(ctx.agentId ?? ctx.sessionId);
    if (!runtime) {
      return error(
        `${SKILL_TOOL_NAME} has no skill runtime registered for this session (WS-11 §2) -- the host must call registerSkillSessionRuntime(sessionId, ...) once per run (skills/runtime.ts). This is a wiring gap, not a model input error.`,
      );
    }

    const parsed = parseInput(input);
    if (typeof parsed === "string") return error(parsed);
    const { skill, args } = parsed;

    // The name comes from the MODEL, and `SkillIndex.load` joins it into a path. Checked BEFORE any
    // lookup, on the same "jail first, fs second" discipline the loader follows.
    if (!isLegalSkillIdentity(skill)) return error(`${JSON.stringify(skill)} is not a valid skill name`);

    const meta = runtime.index.get(skill);
    if (!meta) {
      const known = runtime.index.names();
      return error(`unknown skill ${JSON.stringify(skill)}. Available: ${known.length > 0 ? known.join(", ") : "(none)"}`);
    }

    if (!isSkillEnabled(runtime.skills, skill, runtime.index)) {
      return error(`the skill ${JSON.stringify(meta.name)} exists but is not in this session's "skills" option, so it cannot be invoked (WS-11 §2.2)`);
    }

    // `off` closes every door; `user-invocable-only` closes the MODEL's specifically -- the state
    // exists precisely so a skill can stay reachable by a human `/name` while never being something
    // the model chooses on its own, and this executor only ever runs for a model-issued tool call.
    if (!isUserInvocable(runtime.skillOverrides, meta)) {
      return error(`the skill ${JSON.stringify(meta.name)} is disabled by skillOverrides ("off")`);
    }
    if (!isModelVisible(runtime.skillOverrides, meta)) {
      return error(`the skill ${JSON.stringify(meta.name)} is marked "user-invocable-only" by skillOverrides and cannot be invoked by the model`);
    }

    const loaded = runtime.index.load(skill);
    if (!loaded) {
      return error(`the skill ${JSON.stringify(meta.name)} could not be read from ${meta.path} -- it may have been moved, deleted or made unparseable since this session started`);
    }

    const entry: InvokedSkillEntry = {
      name: loaded.name,
      source: loaded.source,
      path: loaded.path,
      ...(meta.plugin !== undefined ? { plugin: meta.plugin } : {}),
      ...(args !== undefined ? { args } : {}),
      bodyBytes: Buffer.byteLength(loaded.body, "utf8"),
    };
    try {
      runtime.onInvoked?.(invokedSkillsAttachment([entry]));
    } catch {
      // The attachment is a RECORD of the invocation, never a precondition for it: a host sink that
      // throws must not turn a successful skill load into a failed tool call.
    }

    return { output: loaded.body };
  },
};

replaceExecutor(SKILL_TOOL_NAME, skillExecutor);
