// SDK 0.0.16 Lane C (P16-5/P16-6): PERSISTED ATTACHMENTS -- claude 0.3.250's `type: "attachment"`
// transcript entries, and the one place their model-facing text is rendered.
//
// WHAT AN ATTACHMENT IS. claude runs an attachment scan at the start of every turn and after every
// tool round; whatever it produces is appended to the conversation as its own transcript entry
// (`{type: "attachment", attachment: {type, ...payload}}`) right after the user prompt / tool results
// that triggered it, and is rendered to the model as a `user` message wrapped
// `<system-reminder>\n…\n</system-reminder>`. Because the entry is IN the conversation, it is sent
// once and then simply stays in the history -- a later request re-sends it at the same position (a
// stable, cacheable prefix) instead of re-announcing it -- and it survives resume. The folds that
// decide whether something changed (the agent listing, the date) read these entries back out of the
// history after the last compaction boundary.
//
// IN WINTER an attachment is a `user`-role `ProviderMessage` in the engine's history carrying
// `meta.attachment` (the payload) and `content` (the rendered, wrapped text). It is persisted through
// `SessionPersistence.recordAttachmentEntry` as claude's own entry shape (store/dialect.ts) and
// rebuilt on resume through `renderAttachment` below (store/resume.ts).
//
// REUSABLE BY DESIGN. Other lanes add their own attachment types (task notifications, plan-mode
// reminders, ...) with `registerAttachmentRenderer` and hand payloads to the engine through
// `EngineOptions.attachmentProducers`; nothing here is specific to the three types this lane ships.
//
// TEXTS. Every string below is a short one-line functional string (a header, a wrapper, a label) and
// matches the pinned binary EXACTLY (spawn-surface-scope R-S10), traced from its attachment renderer:
// the agent-listing section headers, the ambient sentence, the concurrency sentence, the skill-listing
// header and the date-change line.
import type { ProviderMessage } from "../engine.ts";
import { neutralizeReminderTags } from "./injection.ts";

/**
 * One attachment payload, exactly as the transcript stores it (`entry.attachment`). Open-ended: the
 * three types below are this lane's; any other `type` is carried verbatim and rendered only when a
 * renderer is registered for it.
 */
export interface AttachmentPayload {
  type: string;
  [key: string]: unknown;
}

/** claude's `agent_listing_delta` (`s1t`): what the Agent tool can spawn, as a delta over what the history already announced. */
export interface AgentListingDeltaAttachment extends AttachmentPayload {
  type: "agent_listing_delta";
  addedTypes: string[];
  addedLines: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote: boolean;
}

/** claude's `skill_listing` (`Urn`): the skills not yet sent this session. `names` seeds the sent set on resume. */
export interface SkillListingAttachment extends AttachmentPayload {
  type: "skill_listing";
  content: string;
  skillCount: number;
  isInitial: boolean;
  names: string[];
}

/** claude's `date_change` (`alr`): the local date moved past the one the session's context was built with. */
export interface DateChangeAttachment extends AttachmentPayload {
  type: "date_change";
  newDate: string;
}

export const AGENT_LISTING_INITIAL_HEADER = "Available agent types for the Agent tool:";
export const AGENT_LISTING_ADDED_HEADER = "New agent types are now available for the Agent tool:";
export const AGENT_LISTING_REMOVED_HEADER = "The following agent types are no longer available:";
/** claude's `s$`: appended after a "no longer available" section. */
export const AMBIENT_CONTEXT_SENTENCE = "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";
/** Appended to the INITIAL listing only, when `showConcurrencyNote` is set. */
export const AGENT_CONCURRENCY_SENTENCE = "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";
export const SKILL_LISTING_HEADER = "The following skills are available for use with the Skill tool:";

export function dateChangeText(newDate: string): string {
  return `The date has changed. Today's date is now ${newDate}. No need to announce the new date — the user's own clock shows it.`;
}

/** claude's attachment wrapper (`Qa`). Nothing is added around it and nothing after it. */
export function wrapSystemReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** claude's `Hc`: a field that should be a string array, read defensively (a resumed transcript is untrusted JSON). */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A renderer returns the UNWRAPPED body, or `undefined` when the attachment has nothing to say. */
export type AttachmentRenderer = (attachment: AttachmentPayload) => string | undefined;

/**
 * SDK 0.0.16 Lane N: `wrap: false` for the ONE attachment family claude does not wrap. Its
 * `queued_command` attachments (a task notification delivered mid-turn) are rendered as a BARE user
 * text block carrying their own `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble instead of the
 * `<system-reminder>` envelope every other attachment type gets (traced in the pinned binary: the
 * queued-command branch of its request builder calls its origin-aware renderer directly, never the
 * reminder wrapper). Defaults to `true`, so every type registered before this option existed is
 * unchanged.
 */
export interface AttachmentRendererOptions {
  wrap?: boolean;
}

const renderers = new Map<string, { render: AttachmentRenderer; wrap: boolean }>();

/**
 * Registers (or replaces) the renderer for one attachment type. Another lane's types (task
 * notifications, plan-mode reminders) plug in here; the engine and the resume path then carry them
 * with no further change.
 */
export function registerAttachmentRenderer(type: string, renderer: AttachmentRenderer, options?: AttachmentRendererOptions): void {
  renderers.set(type, { render: renderer, wrap: options?.wrap !== false });
}

registerAttachmentRenderer("agent_listing_delta", (a) => {
  const addedLines = stringArray(a["addedLines"]);
  const addedTypes = stringArray(a["addedTypes"]);
  const removedTypes = stringArray(a["removedTypes"]);
  const sections: string[] = [];
  const hasAdded = addedLines.length > 0 && addedTypes.length > 0;
  if (hasAdded) sections.push(`${a["isInitial"] === true ? AGENT_LISTING_INITIAL_HEADER : AGENT_LISTING_ADDED_HEADER}\n${addedLines.join("\n")}`);
  if (removedTypes.length > 0) {
    sections.push(`${AGENT_LISTING_REMOVED_HEADER}\n${removedTypes.map((t) => `- ${t}`).join("\n")}`);
    sections.push(AMBIENT_CONTEXT_SENTENCE);
  }
  if (hasAdded && a["isInitial"] === true && a["showConcurrencyNote"] === true) sections.push(AGENT_CONCURRENCY_SENTENCE);
  if (sections.length === 0) return undefined;
  // The lines fold in a project/user/plugin definition's `description` verbatim, so a literal
  // `<system-reminder>` tag inside one is neutralised -- it cannot close this wrapper early.
  return neutralizeReminderTags(sections.join("\n\n"));
});

registerAttachmentRenderer("skill_listing", (a) => {
  const content = typeof a["content"] === "string" ? a["content"] : "";
  if (content.length === 0) return undefined;
  return neutralizeReminderTags(`${SKILL_LISTING_HEADER}\n\n${content}`);
});

registerAttachmentRenderer("date_change", (a) => (typeof a["newDate"] === "string" ? dateChangeText(a["newDate"]) : undefined));

/** The wrapped model-facing text for an attachment, or `undefined` when there is none (an unknown type included). */
export function renderAttachment(attachment: AttachmentPayload): string | undefined {
  const renderer = renderers.get(attachment.type);
  if (renderer === undefined) return undefined;
  const body = renderer.render(attachment);
  if (body === undefined) return undefined;
  return renderer.wrap ? wrapSystemReminder(body) : body;
}

/** The history message for an attachment, or `undefined` when it renders to nothing (it is then not appended at all). */
export function attachmentMessage(attachment: AttachmentPayload): ProviderMessage | undefined {
  const text = renderAttachment(attachment);
  if (text === undefined) return undefined;
  return { role: "user", content: text, meta: { attachment } };
}

export function isAttachmentMessage(message: ProviderMessage): message is ProviderMessage & { meta: { attachment: AttachmentPayload } } {
  return message.meta !== undefined;
}

/** Every attachment payload in `messages`, in order. The engine's history IS claude's post-compaction slice (`Ml`). */
export function attachmentsIn(messages: readonly ProviderMessage[]): AttachmentPayload[] {
  const out: AttachmentPayload[] = [];
  for (const m of messages) if (m.meta !== undefined) out.push(m.meta.attachment);
  return out;
}

// --- the folds ------------------------------------------------------------------------------------

/**
 * claude's `s1t` fold: the agent types the history has already announced. A delta's `addedTypes`
 * count only when it carries an `addedLines` array (claude's own guard); `removedTypes` always remove.
 */
export function announcedAgentTypes(messages: readonly ProviderMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const a of attachmentsIn(messages)) {
    if (a.type !== "agent_listing_delta") continue;
    if (Array.isArray(a["addedLines"])) for (const t of stringArray(a["addedTypes"])) announced.add(t);
    for (const t of stringArray(a["removedTypes"])) announced.delete(t);
  }
  return announced;
}

/** claude's `alr` fold: whether a `date_change` for `date` is already in the history. */
export function dateChangeAnnounced(messages: readonly ProviderMessage[], date: string): boolean {
  return attachmentsIn(messages).some((a) => a.type === "date_change" && a["newDate"] === date);
}

/**
 * claude's `vlr` resume seed for the skill listing: the names every persisted `skill_listing` sent,
 * and whether a legacy entry without `names` asks the next listing to be suppressed (claude's
 * `suppressNext`).
 */
export function skillListingResumeSeed(messages: readonly ProviderMessage[]): { names: string[]; suppressNext: boolean } {
  const names: string[] = [];
  let suppressNext = false;
  for (const a of attachmentsIn(messages)) {
    if (a.type !== "skill_listing") continue;
    if (Array.isArray(a["names"])) names.push(...stringArray(a["names"]));
    else suppressNext = true;
  }
  return { names, suppressNext };
}

/** claude's `tcn`: the LOCAL calendar date, `YYYY-MM-DD`. */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
