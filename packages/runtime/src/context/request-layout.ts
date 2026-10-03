// SDK 0.0.16 Lane C (P16-5): the LIVE REQUEST'S LAYOUT, in the shape claude's own requests have.
//
// Captured against the pinned binary (a loopback fake recording every request body). Three things
// decide the shape of a request, and this module reproduces each:
//
//  1. USER CONTEXT. The per-session context map -- `claudeMd`, then `currentDate` -- is rendered as
//     ONE meta `user` message prepended at INDEX 0 of every request, ahead of all history. It is
//     never stored in the history and never persisted; it is rebuilt from the session's memoized map
//     on every request, so its bytes are identical from turn to turn.
//
//  2. SYSTEM CONTEXT. The `gitStatus` snapshot is appended to the system prompt as a final
//     `key: value` part, and the prompt is split into cache blocks: the static prefix (`global`) and
//     everything after the dynamic boundary, systemContext included (`org`).
//
//  3. MESSAGE NORMALIZATION:
//       a. ATTACHMENT REORDER: attachment messages move UP until they reach an assistant message or a
//          user message that begins with a `tool_result`, and land right after it; any that reach
//          the top stay at the top (above the index-0 context too).
//       b. MERGE: consecutive user-role messages become one. An ordinary user message joining the
//          previous one gives the previous last text block a trailing "\n" when the next starts with
//          text; an attachment joins with no newline, and is folded INTO a trailing string-content
//          `tool_result` when every block it adds is text (trimmed, "\n\n"-joined). Either way
//          `tool_result` blocks come first in the merged turn.
//     The result for turn 1 is the single wire message
//       [agent listing, skill listing, ..., <index-0 context>+"\n", <prompt>]
//     and every later request repeats that message byte-identically.
//
// The engine calls `buildRequestMessages` on a COPY of its history for every provider call; its own
// history keeps claude's TRANSCRIPT order (prompt, then its attachments) so persistence and resume
// see exactly what claude's transcript holds.
import type { ContentBlock, ProviderMessage, ProviderToolSpec } from "../engine.ts";
import { isSystemRoleAttachment } from "./attachments.ts";
import { isToolBookkeeping, isToolChangesMessage, toolChangeReferences, toolChangesWireMessage } from "./tool-epoch.ts";
import type { SystemPromptBlock } from "@yanlinglabs/winter-provider-runtime";

/** One userContext / systemContext entry, in the order it is rendered. */
export type ContextEntry = readonly [key: string, value: string];

const USER_CONTEXT_PREAMBLE = "As you answer the user's questions, you can use the following context:";
const USER_CONTEXT_POSTSCRIPT = "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.";

/**
 * The index-0 context text for a userContext map, or `undefined` when the map is empty (nothing is
 * then prepended). Exactly one trailing newline; the second one the wire shows comes from the merge
 * with the prompt.
 */
export function renderUserContext(entries: readonly ContextEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const body = entries.map(([key, value]) => `# ${key}\n${value}`).join("\n");
  return `<system-reminder>\n${USER_CONTEXT_PREAMBLE}\n${body}\n\n${USER_CONTEXT_POSTSCRIPT}\n</system-reminder>\n`;
}

/** The systemContext part: `key: value` lines. `undefined` when there are none. */
export function renderSystemContext(entries: readonly ContextEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}

/**
 * The cache-block split for Winter's two halves. With a dynamic boundary (Winter's authored prompt, the
 * preset, or a caller array that names one) the static half is one `global` block and the dynamic
 * half -- systemContext appended last -- one `org` block. Without a boundary (a caller string, or a
 * caller array with none) everything is one `org` block. Empty parts are dropped.
 */
export function buildSystemBlocks(input: { staticParts: readonly string[]; dynamicParts: readonly string[]; systemContext?: string; hasBoundary: boolean }): SystemPromptBlock[] {
  const nonEmpty = (parts: readonly (string | undefined)[]): string[] => parts.filter((p): p is string => p !== undefined && p.length > 0);
  const dynamic = nonEmpty([...input.dynamicParts, input.systemContext]);
  if (!input.hasBoundary) {
    const all = nonEmpty([...input.staticParts, ...dynamic]).join("\n\n");
    return all.length > 0 ? [{ text: all, cacheScope: "org" }] : [];
  }
  const blocks: SystemPromptBlock[] = [];
  const staticText = nonEmpty(input.staticParts).join("\n\n");
  if (staticText.length > 0) blocks.push({ text: staticText, cacheScope: "global" });
  const dynamicText = dynamic.join("\n\n");
  if (dynamicText.length > 0) blocks.push({ text: dynamicText, cacheScope: "org" });
  return blocks;
}

/** The `system` string equivalent of a block list (what a block-unaware provider receives). */
export function joinSystemBlocks(blocks: readonly SystemPromptBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

// --- message normalization --------------------------------------------------------------------------

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function isUserRole(message: ProviderMessage): boolean {
  // WS-23: a `system` message is its own wire entry and must never be merged into a user turn.
  return message.role !== "assistant" && message.role !== "system";
}

/** Whether an attachment climbing the history stops right after this message. */
function isReorderStop(message: ProviderMessage): boolean {
  if (message.role === "assistant") return true;
  if (typeof message.content === "string") return false;
  const first = message.content[0];
  return first !== undefined && first.type === "tool_result";
}

/**
 * Moves attachment messages up the history (see the module header). WS-23: `stays` names attachments
 * that keep their HISTORY position instead of moving -- a system-role reminder must follow the user
 * turn that triggered it, which is exactly where the engine appended it.
 */
export function reorderAttachments(messages: readonly ProviderMessage[], stays: (message: ProviderMessage) => boolean = () => false): ProviderMessage[] {
  if (!messages.some((m) => m.meta !== undefined)) return [...messages];
  // Attachments that climb to the very top, then one group per fixed message: the fixed message
  // followed by every moving attachment that settles right after it (only stops ever collect any).
  const top: ProviderMessage[] = [];
  const groups: { fixed: ProviderMessage; moved: ProviderMessage[] }[] = [];
  let landing: ProviderMessage[] = top;
  for (const message of messages) {
    const moving = message.meta !== undefined && !stays(message);
    if (moving) {
      landing.push(message);
      continue;
    }
    const group = { fixed: message, moved: [] as ProviderMessage[] };
    groups.push(group);
    if (isReorderStop(message)) landing = group.moved;
  }
  const out: ProviderMessage[] = [...top];
  for (const group of groups) out.push(group.fixed, ...group.moved);
  return out;
}

/** A merged turn's blocks with every `tool_result` first. */
function hoistToolResults(blocks: ContentBlock[]): ContentBlock[] {
  const results = blocks.filter((b) => b.type === "tool_result");
  const rest = blocks.filter((b) => b.type !== "tool_result");
  return [...results, ...rest];
}

/** An ordinary user message's blocks joining the previous user-role message's. */
function joinUserBlocks(prev: ContentBlock[], next: ContentBlock[]): ContentBlock[] {
  const last = prev[prev.length - 1];
  const first = next[0];
  if (last !== undefined && last.type === "text" && first !== undefined && first.type === "text") {
    return [...prev.slice(0, -1), { ...last, text: `${last.text}\n` }, ...next];
  }
  return [...prev, ...next];
}

const SMOOSH_EXEMPT_TAG = "<system-reminder>\n";
const SMOOSH_EXEMPT_BODIES = ["<system>authentic event nonces for this delivery: ", "<event "] as const;

/**
 * A reminder that must never be folded into a tool result (event deliveries). Winter produces
 * neither prefix today; this only keeps a claude-written transcript's shape intact on resume.
 */
export function isSmooshExempt(text: string): boolean {
  if (!text.startsWith(SMOOSH_EXEMPT_TAG)) return false;
  const rest = text.slice(SMOOSH_EXEMPT_TAG.length);
  return SMOOSH_EXEMPT_BODIES.some((prefix) => rest.startsWith(prefix));
}

type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;
type TextBlock = Extract<ContentBlock, { type: "text" }>;

/**
 * Folds trailing text blocks INTO a tool result. `null` when the result cannot take them (it carries
 * a `tool_reference`, or -- WS-23 -- it loaded tools).
 */
export function foldTextIntoToolResult(result: ToolResultBlock, texts: TextBlock[]): ToolResultBlock | null {
  if (texts.length === 0) return result;
  const content = result.content;
  if (Array.isArray(content) && content.some((b) => b.type === "tool_reference")) return null;
  if (Array.isArray(result.loadedTools) && result.loadedTools.length > 0) return null;
  if (typeof content === "string") {
    const pieces = [content.trim(), ...texts.map((t) => t.text.trim())].filter((piece) => piece.length > 0);
    return { ...result, content: pieces.join("\n\n") };
  }
  // Array content: adjacent text runs collapse into one fresh text block; any other block splits runs.
  const folded: ContentBlock[] = [];
  for (const block of [...content, ...texts]) {
    if (block.type !== "text") {
      folded.push(block);
      continue;
    }
    const trimmed = block.text.trim();
    if (trimmed.length === 0) continue;
    const tail = folded[folded.length - 1];
    if (tail !== undefined && tail.type === "text") folded[folded.length - 1] = { type: "text", text: `${tail.text}\n\n${trimmed}` };
    else folded.push({ type: "text", text: trimmed });
  }
  return { ...result, content: folded };
}

/** An attachment's blocks joining the previous user-role message's (WS-23: never into a result that loaded tools). */
function joinAttachmentBlocks(prev: ContentBlock[], next: ContentBlock[]): ContentBlock[] {
  const last = prev[prev.length - 1];
  if (last === undefined || last.type !== "tool_result") return [...prev, ...next];
  // A result that loaded tools carries nothing else; the attachment stays its own block.
  if (Array.isArray(last.loadedTools) && last.loadedTools.length > 0) return [...prev, ...next];
  if (next.some((b) => b.type === "text" && isSmooshExempt(b.text))) return [...prev, ...next];
  if (typeof last.content === "string" && next.every((b) => b.type === "text")) {
    const folded = foldTextIntoToolResult(last, next as TextBlock[]);
    return [...prev.slice(0, -1), folded ?? last];
  }
  return [...prev, ...next];
}

/**
 * The live request's message list: `history` with the index-0 context prepended, attachments
 * reordered and consecutive user-role messages merged, in the layout claude's requests have.
 * Never mutates `history`. Assistant messages pass through untouched (their own merge is the
 * adapters' business, as before).
 */
export function buildRequestMessages(history: readonly ProviderMessage[], userContextText?: string, opts: { systemReminders?: boolean; effort?: EffortMarkerPlan; toolChanges?: ToolChangeRendering } = {}): ProviderMessage[] {
  const withContext: ProviderMessage[] = userContextText !== undefined ? [{ role: "user", content: userContextText, isMeta: true }, ...history] : [...history];
  // WS-23: on a model that takes mid-conversation system messages, a reminder whose renderer opted in
  // rides as `role: "system"` (operator-level, and never merged into the user's own turn). The vendor's
  // placement rule decides each one: it "must immediately follow a `user` turn ... and must either be
  // the last entry in `messages` or be immediately followed by an `assistant` turn"
  // (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages). One that
  // cannot (a compaction's reminder after a retained assistant reply, or an interrupted turn with a
  // second user message behind it) falls back to today's user-text form, deterministically.
  const eligible = (message: ProviderMessage): boolean => opts.systemReminders === true && message.meta !== undefined && isSystemRoleAttachment(message.meta.attachment);
  // WS-23 (midconv): the tool epoch's bookkeeping entries keep their HISTORY position too -- a change
  // is placed right after the user or tool-result turn it follows, before the reply (context/tool-epoch.ts).
  const reordered = reorderAttachments(withContext, (message) => eligible(message) || isToolBookkeeping(message));
  const ordered = opts.effort !== undefined ? withEffortMarkers(reordered, opts.effort) : reordered;
  const out: ProviderMessage[] = [];
  // WS-23 (midconv, review C-1): tool-change messages waiting for their legal position (see below).
  const pendingChanges: ProviderMessage[] = [];
  const mayFollow = (prev: ProviderMessage | undefined): boolean => prev !== undefined && (isUserRole(prev) || (prev.role === "system" && prev.outputConfig === undefined));
  const flushChanges = (): void => {
    if (pendingChanges.length === 0 || !mayFollow(out[out.length - 1])) return;
    out.push(...pendingChanges);
    pendingChanges.length = 0;
  };
  for (let index = 0; index < ordered.length; index++) {
    const message = ordered[index]!;
    // A change that waited behind a later user turn lands right before the reply that follows it.
    if (message.role === "assistant") flushChanges();
    const prev = out[out.length - 1];
    // WS-23 (midconv): a tool-change entry of the ACTIVE epoch becomes the vendor's tool-change message
    // (an empty-content `system` message the adapter renders); every other bookkeeping entry -- the
    // epoch itself, a change from an earlier epoch, or any of them on a model with no mechanism -- is
    // dropped. Before the merge, so neither ever joins a user turn.
    //
    // PLACEMENT (review C-1): a system message carrying content "must immediately follow a `user` turn"
    // AND "must precede an `assistant` turn or end the array"
    // (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages). The engine
    // appends a change right before the generation it applies to, but a generation that then FAILS or is
    // interrupted records no reply, so the next prompt would land right behind the change -- `[..., user,
    // system(change), user]`, a placement 400 on every later request. So a change whose next real message
    // (reminders and bookkeeping skipped) is not an assistant turn is CARRIED FORWARD past the user turns
    // that follow it, to just before the next reply (or the end). Decided from the history alone, so every
    // later request lays it out at the same place.
    if (isToolBookkeeping(message)) {
      if (isToolChangesMessage(message) && opts.toolChanges?.render.has(message) === true) {
        const wire = toolChangesWireMessage(message);
        if (wire !== undefined) {
          if (pendingChanges.length === 0 && mayFollow(prev) && systemMayPrecede(ordered, index)) out.push(wire);
          else pendingChanges.push(wire);
        }
      }
      continue;
    }
    // A text-carrying system message may follow another one with content; never an effort-only
    // marker ("adding a text-carrying message next to an effort-only one makes the whole group follow
    // the content rule").
    if (eligible(message) && prev !== undefined && (isUserRole(prev) || (prev.role === "system" && prev.outputConfig === undefined)) && systemMayPrecede(ordered, index)) {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (prev === undefined || !isUserRole(message) || !isUserRole(prev)) {
      out.push({ ...message });
      continue;
    }
    const prevBlocks = toBlocks(prev.content);
    const nextBlocks = toBlocks(message.content);
    const merged = hoistToolResults(message.meta !== undefined ? joinAttachmentBlocks(prevBlocks, nextBlocks) : joinUserBlocks(prevBlocks, nextBlocks));
    // The engine keeps tool results on their own role; a merged turn that carries any keeps it.
    const role: ProviderMessage["role"] = merged.some((b) => b.type === "tool_result") ? "tool" : "user";
    out[out.length - 1] = { role, content: merged };
  }
  flushChanges();
  // WS-23 fix round 1 (I1): a LEADING effort-only marker at the level in force before any change (effort-
  // only messages are "accepted anywhere in `messages`, including as the first entry",
  // https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations).
  // It states nothing new, but it puts the per-message beta on EVERY request of the session, derived
  // from the body as the adapter derives every beta -- the diagnostics page lists "the set of active
  // `anthropic-beta` headers" among the prompt-affecting parameters, so a beta that appeared only on
  // the request carrying a change would cost that request its comparison. claude 2.1.282 sends a
  // turn-one effort equal to its top-level value too (loopback capture).
  if (opts.effort !== undefined) out.unshift({ role: "system", content: [], outputConfig: { effort: opts.effort.initial } });
  return out;
}

// --- WS-23: per-message effort markers ----------------------------------------------------------------
//
// On a model whose row documents per-message effort, the top-level `output_config.effort` stays FROZEN
// and every change rides an effort-only `system` message placed between the previous assistant reply
// and the user message it applies to -- the documented placement
// (https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta:
// "The new level takes effect from the next `user` turn"). Changing the top-level value instead
// "doesn't preserve cached prefixes from earlier turns" (same page).
//
// THE MARKERS ARE DERIVED, NEVER STORED. Every assistant message carries the level that was in force
// for its turn (`perTurnEffort`), and the markers are a pure function of those annotations, the frozen
// top-level value and the live level -- so turn N+1 re-derives turn N's markers byte-identically, and a
// resumed session (whose rebuilt messages carry the same two fields off the transcript) derives them at
// the same positions. claude's resumed sessions behave the same way (each user message takes the
// effort of the assistant reply after it, `perTurnEffort ?? effort`, and a marker appears only where
// the level changes); Winter applies that rule to live requests too, so there is one code path.
//
// DIVERGENCE FROM claude 2.1.282, deliberate: claude attaches the effort to the system message it sends
// AFTER the user message (its `# Environment` turn), and on the same request also moves the top-level
// value -- the loopback capture shows both. After-the-user placement would apply the level from the
// FOLLOWING user turn (a tool-result turn), not to the reply the user is waiting for, and moving the
// top-level value restarts the cache; Winter follows the vendor's documented placement instead.

/**
 * WS-23 (midconv): which `tool_changes` entries this request renders -- the active epoch's, by identity
 * (the engine's own history objects). Absent: every bookkeeping entry is dropped (today's layout).
 */
export interface ToolChangeRendering {
  render: ReadonlySet<ProviderMessage>;
}

/** WS-23: the per-message effort plan `buildRequestMessages` lays out -- see `withEffortMarkers`. */
export interface EffortMarkerPlan {
  /** The level in force before any marker: the frozen top-level value, or the model's default when none is sent. */
  initial: string;
  /** The level for the turn being generated now. */
  live: string;
  /** Levels the target row can take. */
  accepts: (effort: string) => boolean;
  /**
   * WS-23 (reasoning-state): whether an assistant message is the TARGET model's own. A per-message effort
   * level is a cache quirk of one model -- a vocabulary and a cached prefix of its own -- so only its own
   * replies' levels become markers; another model's reply is read as un-annotated (no marker). Absent:
   * every reply counts (the pre-WS-23 reading, and a session with no provider identity).
   */
  owns?: (message: ProviderMessage) => boolean;
}

/** A HUMAN turn start in the PRE-merge list: a user message that is neither an attachment nor the index-0 context. */
function isTurnStart(m: ProviderMessage): boolean {
  return m.role === "user" && m.meta === undefined && m.isMeta !== true;
}

/**
 * `ordered` (the history AFTER the attachment reorder and BEFORE the user-turn merge) with an
 * effort-only `system` marker before every human turn whose level differs from the one in force before
 * it. Run before the merge on purpose (fix round 1, I2): after it, a prompt that follows an INTERRUPTED
 * tool round is folded into the `tool` message ahead of it and is no longer recognisable as a turn
 * start -- the change would silently not apply while the transcript recorded it. A marker is never
 * merged, so it also keeps that prompt as its own user entry.
 *
 * PLACEMENT: before the turn's attachments when they bubbled up to the previous assistant reply (so
 * the common case keeps its merged user entry), otherwise directly before the prompt. A turn with no
 * annotated reply (a host-supplied or pre-WS-23 history) is left alone, and a level the row cannot take
 * gets no marker -- both deterministic, so still byte-stable.
 */
export function withEffortMarkers(ordered: readonly ProviderMessage[], plan: EffortMarkerPlan): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  let running = plan.initial;
  for (let i = 0; i < ordered.length; i++) {
    const message = ordered[i]!;
    if (isTurnStart(message)) {
      let level: string | undefined;
      let sawAssistant = false;
      let j = i + 1;
      for (; j < ordered.length && !isTurnStart(ordered[j]!); j++) {
        const next = ordered[j]!;
        if (next.role !== "assistant") continue;
        sawAssistant = true;
        level = plan.owns === undefined || plan.owns(next) ? (next.perTurnEffort ?? next.effort) : undefined;
        break;
      }
      // The turn being generated right now has no reply yet: it runs at the live level.
      if (!sawAssistant && j >= ordered.length) level = plan.live;
      if (level !== undefined && level !== running && plan.accepts(level)) {
        // Back over this turn's own leading attachments, but only when they sit right after an
        // assistant reply (they bubbled up to the top of the turn).
        let at = out.length;
        while (at > 0 && out[at - 1]!.meta !== undefined) at--;
        if (at === out.length || !(at === 0 || out[at - 1]!.role === "assistant")) at = out.length;
        out.splice(at, 0, { role: "system", content: [], outputConfig: { effort: level } });
        running = level;
      }
    }
    out.push(message);
  }
  return out;
}

/**
 * WS-23: every tool name a ToolSearch result in `history` surfaced (`tool_result.loadedTools`, advertised
 * names). A deferred tool in this set is referenced somewhere in the history, so it can stay declared
 * `defer_loading: true`; a loaded tool outside it would be invisible to the model and is sent plainly.
 */
export function referencedToolNames(history: readonly ProviderMessage[], modelKey?: string | null): Set<string> {
  // WS-23 (midconv): plus every deferred tool a tool-change entry of the current epoch announced by
  // reference -- it is surfaced on the wire the same way, and a resumed session re-seeds its loaded set
  // from it. An earlier epoch's entries are not replayed, so they surface nothing. WS-23 (reasoning-state):
  // with `modelKey`, "the current epoch" is that model's own (see `toolChangeReferences`).
  const names = new Set<string>(toolChangeReferences(history, modelKey));
  for (const message of history) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_result" && block.loadedTools !== undefined) for (const name of block.loadedTools) names.add(name);
    }
  }
  return names;
}

/**
 * The top-level effort the session sent, read back off a history: the newest ANNOTATED assistant
 * message's own `effort` (absent means the session sent none at the top level). `undefined` when no
 * assistant message is annotated at all -- nothing to restore.
 */
export function frozenEffortFromHistory(history: readonly ProviderMessage[], owns?: (message: ProviderMessage) => boolean): { value: string | undefined } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    // WS-23 (reasoning-state): only the target model's OWN replies -- another model's top-level effort is
    // a value in another vocabulary, sent on another cached prefix.
    if (m.role === "assistant" && (m.effort !== undefined || m.perTurnEffort !== undefined) && (owns === undefined || owns(m))) return { value: m.effort };
  }
  return undefined;
}

/** WS-23: the next non-reminder message after `index` is an assistant turn, or there is none. */
function systemMayPrecede(ordered: readonly ProviderMessage[], index: number): boolean {
  for (let j = index + 1; j < ordered.length; j++) {
    const next = ordered[j]!;
    if (next.meta !== undefined && isSystemRoleAttachment(next.meta.attachment)) continue;
    // WS-23 (midconv): a tool-change entry is itself a system message between the turn and its reply.
    if (isToolBookkeeping(next)) continue;
    return next.role === "assistant";
  }
  return true;
}

// --- the last request, per session (for the fork lane) ---------------------------------------------

/**
 * What a session last sent: the exact system blocks, the userContext entries behind its index-0
 * message, and the tool specs. A byte-exact fork (a later lane) reuses these verbatim; nothing in
 * this lane reads them.
 */
export interface SessionRequestLayout {
  system?: string;
  systemBlocks: SystemPromptBlock[];
  userContext: ContextEntry[];
  tools: ProviderToolSpec[];
}

const lastLayouts = new Map<string, SessionRequestLayout>();

// M3 (fix wave, whole-branch review): the separator between the two halves is a NUL character
// (`\u0000`), not the visually-identical blank a plain space would leave -- verified byte-for-byte
// against this branch's own starting commit, so the SEPARATOR CHOICE was already true before this
// fix wave; only the SPELLING changed here (a raw embedded NUL byte -> the `\u0000` escape, which
// produces the identical runtime string), to satisfy this repo's own source-hygiene gate
// (`scripts/source-hygiene.test.ts`'s "no raw control bytes in source" scan, item 6) rather than
// leaving a byte no editor renders sitting unescaped in a committed source file. A NUL is
// collision-safe here for the reason the gate's own suggested fix implies: neither a session id nor
// an agent id this codebase ever generates or accepts can contain one, unlike a space (a session id
// CAN contain a literal space), so the two halves can never be reassembled into a different
// (sessionId, agentId) pair.
function layoutKey(sessionId: string, agentId: string | undefined): string {
  return agentId === undefined ? sessionId : `${sessionId}\u0000${agentId}`;
}

/** Records the layout of the request a session (or one of its agents) just sent. */
export function recordSessionRequestLayout(sessionId: string, agentId: string | undefined, layout: SessionRequestLayout): void {
  lastLayouts.set(layoutKey(sessionId, agentId), layout);
}

/** The layout a session (or one of its agents) last sent, or `undefined` before its first request. */
export function getSessionRequestLayout(sessionId: string, agentId?: string): SessionRequestLayout | undefined {
  return lastLayouts.get(layoutKey(sessionId, agentId));
}

/** Drops a session's (or agent's) recorded layout -- the engine's teardown calls this. */
export function clearSessionRequestLayout(sessionId: string, agentId?: string): void {
  lastLayouts.delete(layoutKey(sessionId, agentId));
}

// --- explicit reload -------------------------------------------------------------------------------

const contextReloaders = new Map<string, () => void>();

/** The engine registers its session-context memo's clear hook here (and withdraws it at teardown). */
export function registerSessionContextReload(sessionId: string, agentId: string | undefined, clear: () => void): void {
  contextReloaders.set(layoutKey(sessionId, agentId), clear);
}

export function unregisterSessionContextReload(sessionId: string, agentId?: string): void {
  contextReloaders.delete(layoutKey(sessionId, agentId));
}

/**
 * EXPLICIT RELOAD: drop a live session's memoized userContext/systemContext so its next request
 * re-reads the instructions files, the memory index and the git snapshot (claude re-reads them on an
 * explicit reload too). `false` when no such session is running.
 */
export function reloadSessionContext(sessionId: string, agentId?: string): boolean {
  const clear = contextReloaders.get(layoutKey(sessionId, agentId));
  if (clear === undefined) return false;
  clear();
  return true;
}
