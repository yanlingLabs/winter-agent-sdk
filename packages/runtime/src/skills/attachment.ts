// Phase 5 Lane S (RULING R5-14, derived-shapes-p5 item (i)): the `invoked_skills` attachment.
//
// WINTER-DEFINED, AND DISCLOSED AS SUCH. Task 1 verified exhaustively that neither `invoked_skills`
// nor `skill_listing` occurs in ANY of the six pinned `.d.ts` files, and item (e) establishes why
// that is expected rather than surprising: the transcript entry union is CLI-internal by design, so
// attachment entry NAMES are simply not on the SDK API surface. The name and every field below are
// therefore Winter's, on exactly the footing R5-11 puts `file-history-*` on.
//
// NO DIALECT ENTRY EXISTS FOR THIS (NEEDS_CONTEXT, raised in the task-5 report). `store/dialect.ts`
// is spine and frozen to this lane; T3's own report says so and instructs this lane to raise the
// request rather than work around the frozen file. So this module produces the PAYLOAD and the
// session runtime hands it to a host-supplied sink (`SkillSessionRuntime.onInvoked`); nothing here
// writes a transcript. When the spine lands an entry, the payload is already the shape to persist.
import type { SkillTier } from "./loader.ts";

/** The entry name. One constant, so a future dialect entry and this producer cannot disagree. */
export const INVOKED_SKILLS_ATTACHMENT_TYPE = "invoked_skills";

export interface InvokedSkillEntry {
  /** The skill's PRIMARY identity, not the alias the model happened to type. */
  name: string;
  source: SkillTier;
  /** Absolute path of the SKILL.md whose body entered the conversation. */
  path: string;
  /** The contributing plugin, present iff `source === "plugin"`. */
  plugin?: string;
  /** The invocation's `args`, omitted entirely when none were given. */
  args?: string;
  /** Size of the body AS DELIVERED -- post byte-cap, so it reflects what the model actually received. */
  bodyBytes: number;
}

export interface InvokedSkillsAttachment {
  type: typeof INVOKED_SKILLS_ATTACHMENT_TYPE;
  skills: InvokedSkillEntry[];
}

/**
 * An attachment carries an ARRAY even for a single invocation: a turn may invoke several skills, and
 * a consumer that folds attachments should never have to distinguish "one" from "several".
 */
export function invokedSkillsAttachment(skills: InvokedSkillEntry[]): InvokedSkillsAttachment {
  return { type: INVOKED_SKILLS_ATTACHMENT_TYPE, skills };
}
