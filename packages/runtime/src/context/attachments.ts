// SDK 0.0.16 Lane C (P16-5/P16-6): PERSISTED ATTACHMENTS -- claude's `type: "attachment"` transcript
// entries, and the one place their model-facing text is rendered.
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
// is claude's own interface text, unchanged (spawn-surface-scope R-S10): the agent-listing section
// headers, the ambient sentence, the concurrency sentence, the skill-listing header and the
// date-change line.
import { DEFAULT_PLANS_DIRECTORY } from "@yanlinglabs/winter-agent-sdk";
import type { ProviderMessage } from "../engine.ts";
import { neutralizeReminderTags } from "./injection.ts";
import { renderPlanModeBlock } from "./plan-mode.ts";

/**
 * One attachment payload, exactly as the transcript stores it (`entry.attachment`). Open-ended: the
 * three types below are this lane's; any other `type` is carried verbatim and rendered only when a
 * renderer is registered for it.
 */
export interface AttachmentPayload {
  type: string;
  [key: string]: unknown;
}

/** claude's `agent_listing_delta`: what the Agent tool can spawn, as a delta over what the history already announced. */
export interface AgentListingDeltaAttachment extends AttachmentPayload {
  type: "agent_listing_delta";
  addedTypes: string[];
  addedLines: string[];
  removedTypes: string[];
  isInitial: boolean;
  showConcurrencyNote: boolean;
}

/** claude's `skill_listing`: the skills not yet sent this session. `names` seeds the sent set on resume. */
export interface SkillListingAttachment extends AttachmentPayload {
  type: "skill_listing";
  content: string;
  skillCount: number;
  isInitial: boolean;
  names: string[];
}

/** claude's `date_change`: the local date moved past the one the session's context was built with. */
export interface DateChangeAttachment extends AttachmentPayload {
  type: "date_change";
  newDate: string;
}

/**
 * WS-24 (I-1 fix round): Winter's own, no claude equivalent. Plan mode moved OUT of the system
 * prompt's dynamic half and into a persisted attachment at the tail of the conversation -- the block
 * used to sit ahead of the conversation history, so a toggle shifted every downstream token and
 * busted the whole cached prefix on the vendor's own prompt-cache accounting (WS-24 follow-up 8's
 * confirmed live finding, on every provider: OpenAI's byte-exact prefix match and Anthropic's `org`
 * dynamic system block alike). As an attachment it costs exactly ONE cache miss on the turn the mode
 * actually changes, and the history stays a stable, cacheable prefix while the mode holds steady in
 * either direction.
 */
export interface PlanModeAttachment extends AttachmentPayload {
  type: "plan_mode";
  state: "entered" | "exited";
  /**
   * Present only for `state: "entered"`. Captured ONCE at production time
   * (`SystemPromptAssembler.planModeInput`, the settings/brand precedence `assemble()` used to apply
   * inline) rather than re-derived at render time -- a renderer takes only the payload, never live
   * settings or the session's brand.
   */
  plansDirectory?: string;
  plansDirectoryFallback?: string;
  hostPlanBody?: string;
}

/**
 * claude's `deferred_tools_delta`: the DEFERRED tools (loaded through `ToolSearch` on first use) the
 * history has not yet announced, and the ones it announced that are gone. Without it a model cannot know
 * a deferred tool exists -- its schema is not in `tools` (or rides `defer_loading`, which the model does
 * not see) -- so it could only find one by guessing a keyword. Persisted like every attachment, so the
 * announcement is a stable, cacheable part of the history and a pool change costs one appended entry,
 * never a moved prefix (claude's reason for the delta form over its older per-request
 * `<available-deferred-tools>` prepend).
 */
export interface DeferredToolsDeltaAttachment extends AttachmentPayload {
  type: "deferred_tools_delta";
  addedNames: string[];
  addedLines: string[];
  removedNames: string[];
}

/** The two `deferred_tools_delta` headers (claude's interface text, unchanged). */
export const DEFERRED_TOOLS_ADDED_HEADER = "The following deferred tools are now available via ToolSearch:";
export const DEFERRED_TOOLS_REMOVED_HEADER = "The following deferred tools are no longer available (their MCP server disconnected). Do not search for them — ToolSearch will return no match:";

export const AGENT_LISTING_INITIAL_HEADER = "Available agent types for the Agent tool:";
export const AGENT_LISTING_ADDED_HEADER = "New agent types are now available for the Agent tool:";
export const AGENT_LISTING_REMOVED_HEADER = "The following agent types are no longer available:";
/** Appended after a "no longer available" section. */
export const AMBIENT_CONTEXT_SENTENCE = "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";
/** Appended to the INITIAL listing only, when `showConcurrencyNote` is set. */
export const AGENT_CONCURRENCY_SENTENCE = "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";
export const SKILL_LISTING_HEADER = "The following skills are available for use with the Skill tool:";

export function dateChangeText(newDate: string): string {
  return `The date has changed. Today's date is now ${newDate}. No need to announce the new date — the user's own clock shows it.`;
}

/**
 * WS-24 (I-1): kept deliberately MINIMAL. The `ExitPlanMode` tool's own result already announces the
 * mode change in the model-visible function_call_output ("Plan approved; permission mode restored to
 * ..."), so this attachment's job is only to cover the OTHER way the mode can leave plan -- a host or
 * UI action (`set_permission_mode`) with no tool call at all -- without repeating that sentence.
 */
export const PLAN_MODE_EXITED_TEXT = "Plan mode has ended. The write restriction is lifted.";

/** The attachment wrapper. Nothing is added around it and nothing after it. */
export function wrapSystemReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/** A field that should be a string array, read defensively (a resumed transcript is untrusted JSON). */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A renderer returns the UNWRAPPED body, or `undefined` when the attachment has nothing to say. */
export type AttachmentRenderer = (attachment: AttachmentPayload) => string | undefined;

/**
 * SDK 0.0.16 Lane N: `wrap: false` for the ONE attachment family claude does not wrap. Its
 * `queued_command` attachments (a task notification delivered mid-turn) are rendered as a BARE user
 * text block carrying their own `[SYSTEM NOTIFICATION - NOT USER INPUT]` preamble instead of the
 * `<system-reminder>` envelope every other attachment type gets (as claude's requests show them).
 * Defaults to `true`, so every type registered before this option existed is unchanged.
 */
export interface AttachmentRendererOptions {
  wrap?: boolean;
  /**
   * WS-23: the attachment may ride as a MID-CONVERSATION `role: "system"` message on a model whose row
   * documents them (`ModelWireFeatures.midConversationSystem`), instead of as user-turn text. OPT-IN,
   * and only for text Winter itself AUTHORS: the vendor is explicit that a system message gives its
   * text operator authority and must not carry "text from outside the conversation"
   * (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations).
   * So the agent and skill listings (they fold in project, user and plugin descriptions verbatim) and
   * task notifications (subagent output) stay user text; `date_change` is the built-in that qualifies.
   */
  systemRole?: boolean;
}

const renderers = new Map<string, { render: AttachmentRenderer; wrap: boolean; systemRole: boolean }>();

/**
 * Registers (or replaces) the renderer for one attachment type. Another lane's types (task
 * notifications, plan-mode reminders) plug in here; the engine and the resume path then carry them
 * with no further change.
 */
export function registerAttachmentRenderer(type: string, renderer: AttachmentRenderer, options?: AttachmentRendererOptions): void {
  renderers.set(type, { render: renderer, wrap: options?.wrap !== false, systemRole: options?.systemRole === true });
}

/** WS-23: whether this attachment's renderer opted into the mid-conversation `system` role. */
export function isSystemRoleAttachment(attachment: AttachmentPayload): boolean {
  return renderers.get(attachment.type)?.systemRole === true;
}

// Renders an `agent_listing_delta` payload's sections (see the spec for the exact layout).
registerAttachmentRenderer("agent_listing_delta", (a) => {
  const addedLines = stringArray(a["addedLines"]);
  const addedTypes = stringArray(a["addedTypes"]);
  const removedTypes = stringArray(a["removedTypes"]);
  const initial = a["isInitial"] === true;
  const sections: string[] = [];
  const hasAdded = addedLines.length > 0 && addedTypes.length > 0;
  if (hasAdded) sections.push(`${initial ? AGENT_LISTING_INITIAL_HEADER : AGENT_LISTING_ADDED_HEADER}\n${addedLines.join("\n")}`);
  if (removedTypes.length > 0) {
    sections.push(`${AGENT_LISTING_REMOVED_HEADER}\n${removedTypes.map((name) => `- ${name}`).join("\n")}`);
    sections.push(AMBIENT_CONTEXT_SENTENCE);
  }
  if (hasAdded && initial && a["showConcurrencyNote"] === true) sections.push(AGENT_CONCURRENCY_SENTENCE);
  return sections.length === 0 ? undefined : neutralizeReminderTags(sections.join("\n\n"));
});

registerAttachmentRenderer("deferred_tools_delta", (a) => {
  const addedLines = stringArray(a["addedLines"]);
  const removedNames = stringArray(a["removedNames"]);
  const parts: string[] = [];
  if (addedLines.length > 0) parts.push(`${DEFERRED_TOOLS_ADDED_HEADER}\n${addedLines.join("\n")}`);
  if (removedNames.length > 0) parts.push(`${DEFERRED_TOOLS_REMOVED_HEADER}\n${removedNames.join("\n")}`);
  // Tool names may come from a connected MCP server: a literal `<system-reminder>` in one is neutralised.
  return parts.length === 0 ? undefined : neutralizeReminderTags(parts.join("\n\n"));
});

/**
 * The fold for `deferred_tools_delta`: the deferred tool names the history has announced and not
 * since withdrawn. A delta's `addedNames` count only when it carries `addedLines` (as the agent fold).
 */
export function announcedDeferredTools(messages: readonly ProviderMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const a of attachmentsIn(messages)) {
    if (a.type !== "deferred_tools_delta") continue;
    if (Array.isArray(a["addedLines"])) for (const name of stringArray(a["addedNames"])) announced.add(name);
    for (const name of stringArray(a["removedNames"])) announced.delete(name);
  }
  return announced;
}

/**
 * The `deferred_tools_delta` this history needs now, or `undefined` when nothing changed. `deferred` = the
 * session's deferred tool names, as the model would call them; `offered` = EVERY name it is offered now,
 * eager ones included. An announced name is withdrawn only when it is not offered AT ALL: a tool that went
 * from deferred to eager (a switch to a provider that cannot search, which injects everything) is still
 * there, and telling the model "do not search for it" would be false. It stays announced, so it is not
 * re-announced if it defers again.
 */
export function computeDeferredToolsDelta(deferred: readonly string[], offered: readonly string[], history: readonly ProviderMessage[]): DeferredToolsDeltaAttachment | undefined {
  const announced = announcedDeferredTools(history);
  const offeredNow = new Set([...offered, ...deferred]);
  const added = [...new Set(deferred)].filter((name) => !announced.has(name)).sort();
  const removed = [...announced].filter((name) => !offeredNow.has(name)).sort();
  if (added.length === 0 && removed.length === 0) return undefined;
  return { type: "deferred_tools_delta", addedNames: added, addedLines: added, removedNames: removed };
}

registerAttachmentRenderer("skill_listing", (a) => {
  const content = typeof a["content"] === "string" ? a["content"] : "";
  if (content.length === 0) return undefined;
  return neutralizeReminderTags(`${SKILL_LISTING_HEADER}\n\n${content}`);
});

// Winter-authored end to end (only the date is data), so it may ride the system role (WS-23).
registerAttachmentRenderer("date_change", (a) => (typeof a["newDate"] === "string" ? dateChangeText(a["newDate"]) : undefined), { systemRole: true });

// WS-24 (I-1): `entered` renders EXACTLY what the system prompt used to render inline
// (`renderPlanModeBlock`, unchanged); `exited` is the one-line notice above. Winter-authored end to
// end -- `plansDirectory` is validated at render time (`renderablePlansDirectory`'s own RULING P5-L)
// and `hostPlanBody` is never wired from an untrusted source (M-4, reported not fixed) -- so, like
// `date_change`, it may ride the system role.
registerAttachmentRenderer(
  "plan_mode",
  (a) => {
    if (a["state"] === "exited") return PLAN_MODE_EXITED_TEXT;
    if (a["state"] !== "entered") return undefined;
    return renderPlanModeBlock({
      plansDirectory: typeof a["plansDirectory"] === "string" ? a["plansDirectory"] : DEFAULT_PLANS_DIRECTORY,
      plansDirectoryFallback: typeof a["plansDirectoryFallback"] === "string" ? a["plansDirectoryFallback"] : DEFAULT_PLANS_DIRECTORY,
      ...(typeof a["hostPlanBody"] === "string" ? { hostPlanBody: a["hostPlanBody"] } : {}),
    });
  },
  { systemRole: true },
);

// WS-23 (midconv): the tool epoch's two bookkeeping entries (context/tool-epoch.ts). Their text NEVER
// reaches a provider -- the request layout turns a `tool_changes` entry into the vendor's own tool-change
// message and drops a `tool_epoch` entry outright -- but a renderer must answer something, or the resume
// path (store/resume.ts) would drop the entry and the epoch with it. So each renders one legible line for
// the Winter-side readers of the history (the compaction summariser's transcript, the advisor's).
registerAttachmentRenderer(
  "tool_epoch",
  (a) => `[tool list fixed for the prompt cache: ${Array.isArray(a["tools"]) ? a["tools"].length : 0} tools]`,
  { wrap: false },
);
registerAttachmentRenderer(
  "tool_changes",
  (a) => {
    const names = (key: string): string[] => (Array.isArray(a[key]) ? (a[key] as Array<{ name?: unknown } | string>).map((x) => (typeof x === "string" ? x : String(x.name))) : []);
    const parts = [...names("add").map((n) => `+${n}`), ...names("remove").map((n) => `-${n}`)];
    return `[tools changed: ${parts.length > 0 ? parts.join(" ") : "declarations only"}]`;
  },
  { wrap: false },
);

/**
 * A host message folded into the RUNNING turn (the engine's `foldPendingHostInput`): the user sent it
 * while the model was working, and it reaches the model right after the turn's last tool results
 * instead of waiting for a turn of its own. Stored as claude's own `queued_command` entry for a typed
 * prompt (`commandMode: "prompt"`, no `origin`), so a resumed session rebuilds the same history.
 */
export interface QueuedPromptAttachment extends AttachmentPayload {
  type: "queued_command";
  prompt: string;
  commandMode: "prompt";
}

/** The two fixed lines around a folded message (claude's interface text, unchanged). */
export const QUEUED_PROMPT_HEADER = "The user sent a new message while you were working:";
export const QUEUED_PROMPT_FOOTER = "IMPORTANT: After completing your current task, you MUST address the user's message above. Do not ignore it.";

export function queuedPromptAttachment(prompt: string): QueuedPromptAttachment {
  return { type: "queued_command", prompt, commandMode: "prompt" };
}

// Renders the shape the engine writes: a string `prompt`, `commandMode: "prompt"`, no `origin`. claude
// writes that SAME shape for a message its user typed mid-turn, so a session adopted from claude's
// transcript now gets those messages back on resume, where before this renderer they were dropped -- a
// one-time change of the rebuilt history (and of its cached prefix) on that session's first resume.
// Every other `queued_command` renders to nothing, as before: another command mode (claude's task
// notifications are delivered through Winter's own attachment), one carrying an `origin` (not the
// user's own words), and one whose `prompt` is a block ARRAY (claude's form for a message with pasted
// images). The array stays dropped because an attachment here is TEXT ONLY -- a renderer returns a
// string, and the request layout folds a text attachment into the tool result -- so its image blocks
// have nowhere to go, and rendering only its text would hand the model a message with its images
// silently missing.
registerAttachmentRenderer("queued_command", (a) => {
  const prompt = a["prompt"];
  if (a["commandMode"] !== "prompt" || a["origin"] !== undefined || typeof prompt !== "string") return undefined;
  return `${QUEUED_PROMPT_HEADER}\n${neutralizeReminderTags(prompt)}\n\n${QUEUED_PROMPT_FOOTER}`;
});

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

/** Every attachment payload in `messages`, in order. The engine's history is already the post-compaction slice. */
export function attachmentsIn(messages: readonly ProviderMessage[]): AttachmentPayload[] {
  const out: AttachmentPayload[] = [];
  for (const m of messages) if (m.meta !== undefined) out.push(m.meta.attachment);
  return out;
}

// --- the folds ------------------------------------------------------------------------------------

/** The agent types the history has already announced (and not since withdrawn). */
export function announcedAgentTypes(messages: readonly ProviderMessage[]): Set<string> {
  const announced = new Set<string>();
  for (const a of attachmentsIn(messages)) {
    if (a.type !== "agent_listing_delta") continue;
    // Additions count only from a delta that also carries its lines.
    if (Array.isArray(a["addedLines"])) for (const type of stringArray(a["addedTypes"])) announced.add(type);
    for (const type of stringArray(a["removedTypes"])) announced.delete(type);
  }
  return announced;
}

/** Whether a `date_change` for `date` is already in the history. */
export function dateChangeAnnounced(messages: readonly ProviderMessage[], date: string): boolean {
  return attachmentsIn(messages).some((a) => a.type === "date_change" && a["newDate"] === date);
}

/**
 * WS-24 (I-1): the last `plan_mode` attachment's state, or `"exited"` when none exists yet -- a
 * session that never entered plan mode is, correctly, not IN it. This is what the engine's own
 * producer compares against the LIVE `policyStateStore` mode to decide whether anything changed
 * since the history's own last word on it -- emitting only on a genuine difference, never every turn.
 */
export function lastPlanModeState(messages: readonly ProviderMessage[]): "entered" | "exited" {
  const attachments = attachmentsIn(messages).filter((a) => a.type === "plan_mode");
  const last = attachments.at(-1);
  return last !== undefined && last["state"] === "entered" ? "entered" : "exited";
}

/** The skill-listing resume seed: the names persisted listings already sent, and whether to suppress the next listing. */
export function skillListingResumeSeed(messages: readonly ProviderMessage[]): { names: string[]; suppressNext: boolean } {
  const names: string[] = [];
  let suppressNext = false;
  for (const a of attachmentsIn(messages)) {
    if (a.type !== "skill_listing") continue;
    // A listing without a `names` array cannot say what it sent, so the next listing is suppressed.
    if (Array.isArray(a["names"])) names.push(...stringArray(a["names"]));
    else suppressNext = true;
  }
  return { names, suppressNext };
}

/** The LOCAL calendar date, `YYYY-MM-DD`. */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
