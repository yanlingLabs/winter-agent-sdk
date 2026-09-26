// WS-23: the MODEL-FACING half of a hook's output -- `additionalContext` (PreToolUse, PostToolUse,
// PostToolUseFailure, UserPromptSubmit, SessionStart, SubagentStart) and a Stop/SubagentStop hook's
// feedback -- as persisted ATTACHMENTS (context/attachments.ts), never as system-prompt text.
//
// WHY AN ATTACHMENT. The engine used to drop every one of these except PreCompact's (inv-hooks-mcp
// A2: the daemon's diagnostics-after-edit hook has been returning text nobody delivered). The
// attachment machinery already does the three things delivery needs, so this adds a TYPE, not a
// mechanism:
//  1. POSITION: an attachment is appended to the history right after what triggered it, and the
//     request builder (context/request-layout.ts) folds a text-only attachment INTO the preceding
//     `tool_result` (claude's `IMe`) or merges it with the user message. So tool-event context lands
//     inside/after that call's result and prompt context lands with the prompt -- the conversation
//     TAIL, where it is sent once and then sits in the cached prefix like any other history. It is
//     never placed in the system prompt, which a caching lane keeps byte-stable.
//  2. WRAPPING: rendered through `wrapSystemReminder`, the envelope every harness reminder already
//     uses, with `<system-reminder>` tags inside the hook's text neutralised so it cannot close the
//     wrapper early (context/injection.ts's rule for untrusted text in a prompt position; a PostToolUse
//     hook may be echoing tool output).
//  3. DURABILITY: persisted through `recordAttachmentEntry` and re-rendered on resume through the SAME
//     renderer registry, so a resumed session carries the context the live one sent.
//
// THE TEXTS are claude 2.1.282's own (its attachment renderer): `<hookName> hook additional context:
// <lines>` and `<hookName> hook feedback:\n<reason>`, where hookName is `<Event>` or `<Event>:<subject>`.
// Payload shape mirrors claude's `hook_additional_context` transcript entry (`hookName`, `content`
// as a string array), so a transcript carries the same fields either runtime would write.
import { registerAttachmentRenderer, type AttachmentPayload } from "../context/attachments.ts";
import { neutralizeReminderTags } from "../context/injection.ts";

export const HOOK_ADDITIONAL_CONTEXT_ATTACHMENT = "hook_additional_context";
export const HOOK_FEEDBACK_ATTACHMENT = "hook_feedback";

export interface HookAdditionalContextAttachment extends AttachmentPayload {
  type: typeof HOOK_ADDITIONAL_CONTEXT_ATTACHMENT;
  hookName: string;
  content: string[];
  toolUseID?: string;
}

export interface HookFeedbackAttachment extends AttachmentPayload {
  type: typeof HOOK_FEEDBACK_ATTACHMENT;
  hookName: string;
  content: string[];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

registerAttachmentRenderer(HOOK_ADDITIONAL_CONTEXT_ATTACHMENT, (a) => {
  const content = stringsOf(a["content"]);
  if (content.length === 0) return undefined; // claude's own renderer returns nothing for an empty list
  const hookName = typeof a["hookName"] === "string" ? a["hookName"] : "hook";
  return neutralizeReminderTags(`${hookName} hook additional context: ${content.join("\n")}`);
});

registerAttachmentRenderer(HOOK_FEEDBACK_ATTACHMENT, (a) => {
  const content = stringsOf(a["content"]);
  if (content.length === 0) return undefined;
  const hookName = typeof a["hookName"] === "string" ? a["hookName"] : "hook";
  return neutralizeReminderTags(`${hookName} hook feedback:\n${content.join("\n")}`);
});

/** The `additionalContext` strings a composite accumulated, in evaluation order (non-string or empty entries dropped). */
export function contextStrings(extraContext: ReadonlyArray<{ context: unknown }> | undefined): string[] {
  return (extraContext ?? []).map((c) => c.context).filter((t): t is string => typeof t === "string" && t.length > 0);
}

/** `undefined` when there is nothing to say -- the caller then appends nothing at all. */
export function hookAdditionalContextAttachment(hookName: string, content: readonly string[], toolUseID?: string): HookAdditionalContextAttachment | undefined {
  if (content.length === 0) return undefined;
  return { type: HOOK_ADDITIONAL_CONTEXT_ATTACHMENT, hookName, content: [...content], ...(toolUseID !== undefined ? { toolUseID } : {}) };
}

export function hookFeedbackAttachment(hookName: string, content: readonly string[]): HookFeedbackAttachment | undefined {
  if (content.length === 0) return undefined;
  return { type: HOOK_FEEDBACK_ATTACHMENT, hookName, content: [...content] };
}
