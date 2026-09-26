// SDK 0.0.16 Lane C (P16-5): the LIVE REQUEST'S LAYOUT -- claude 0.3.250's, byte for byte.
//
// Captured against the pinned binary (a loopback fake recording every request body), then traced in
// its bundled source. Three things decide the shape of a claude request, and this module ports each:
//
//  1. USER CONTEXT (`mbt`). The per-session context map -- `claudeMd`, then `currentDate` -- is
//     rendered as ONE meta `user` message prepended at INDEX 0 of every request, ahead of all
//     history. It is never stored in the history and never persisted; it is rebuilt from the
//     session's memoized map on every request, so its bytes are identical from turn to turn.
//
//  2. SYSTEM CONTEXT (`pbt` + `VEe`). The `gitStatus` snapshot is appended to the system prompt as
//     a final `key: value` part, and the prompt is split into cache blocks: the static prefix
//     (`global`) and everything after the dynamic boundary, systemContext included (`org`).
//
//  3. MESSAGE NORMALIZATION (`normalizeMessagesForAPI`, the default -- flag-off -- path):
//       a. ATTACHMENT REORDER (`SJn`): attachment messages bubble UP until they reach an assistant
//          message or a user message that begins with a `tool_result`, and land right after it;
//          any that reach the top stay at the top (above the index-0 context too).
//       b. MERGE: consecutive user-role messages become one. An ordinary user message joins with
//          `Noe` (the previous last text block gets a trailing "\n" when the next starts with text);
//          an attachment joins with `mIt` (no newline; SMOOSHED into a trailing string-content
//          `tool_result` when every block it adds is text -- `IMe`, trimmed and "\n\n"-joined).
//          Either way `tool_result` blocks are hoisted to the front (`$It`).
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
 * claude's `mbt` text for a userContext map, or `undefined` when the map is empty (claude then
 * prepends nothing). Exactly one trailing newline; the second one the wire shows comes from the
 * merge with the prompt (`Noe`).
 */
export function renderUserContext(entries: readonly ContextEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const body = entries.map(([key, value]) => `# ${key}\n${value}`).join("\n");
  return `<system-reminder>\n${USER_CONTEXT_PREAMBLE}\n${body}\n\n${USER_CONTEXT_POSTSCRIPT}\n</system-reminder>\n`;
}

/** claude's `pbt` systemContext part: `key: value` lines. `undefined` when there are none. */
export function renderSystemContext(entries: readonly ContextEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return entries.map(([key, value]) => `${key}: ${value}`).join("\n");
}

/**
 * claude's `VEe` for Winter's two halves. With a dynamic boundary (Winter's authored prompt, the
 * preset, or a caller array that names one) the static half is one `global` block and the dynamic
 * half -- systemContext appended last -- one `org` block. Without a boundary (a caller string, or a
 * caller array with none) everything is one `org` block. Empty parts are dropped (`filter(Boolean)`).
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

/** claude's `SJn` stopping point: an assistant message, or a user message whose FIRST block is a `tool_result`. */
function isReorderStop(message: ProviderMessage): boolean {
  if (message.role === "assistant") return true;
  return Array.isArray(message.content) && message.content[0]?.type === "tool_result";
}

/**
 * claude's `SJn` (reorderAttachmentsForAPI). WS-23: `stays` names attachments that keep their HISTORY
 * position instead of bubbling up -- a system-role reminder must follow the user turn that triggered
 * it, which is exactly where the engine appended it.
 */
export function reorderAttachments(messages: readonly ProviderMessage[], stays: (message: ProviderMessage) => boolean = () => false): ProviderMessage[] {
  if (!messages.some((m) => m.meta !== undefined)) return [...messages];
  const reversed: ProviderMessage[] = [];
  const pending: ProviderMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.meta !== undefined && !stays(m)) {
      pending.push(m);
      continue;
    }
    if (isReorderStop(m) && pending.length > 0) {
      for (const a of pending) reversed.push(a);
      reversed.push(m);
      pending.length = 0;
    } else {
      reversed.push(m);
    }
  }
  for (const a of pending) reversed.push(a);
  return reversed.reverse();
}

/** claude's `$It`: `tool_result` blocks first, everything else after, each in order. */
function hoistToolResults(blocks: ContentBlock[]): ContentBlock[] {
  const results: ContentBlock[] = [];
  const rest: ContentBlock[] = [];
  for (const b of blocks) (b.type === "tool_result" ? results : rest).push(b);
  return [...results, ...rest];
}

/** claude's `NJn` (an ordinary user message joining the previous one). */
function joinUserBlocks(prev: ContentBlock[], next: ContentBlock[]): ContentBlock[] {
  const last = prev[prev.length - 1];
  const first = next[0];
  if (last?.type === "text" && first?.type === "text") return [...prev.slice(0, -1), { ...last, text: `${last.text}\n` }, ...next];
  return [...prev, ...next];
}

/**
 * claude's `NMe`: a reminder that must never be folded into a tool result (its poll-event
 * deliveries). Ported literally; Winter produces neither prefix today, so this only keeps a
 * claude-written transcript's shape intact on resume.
 */
export function isSmooshExempt(text: string): boolean {
  if (!text.startsWith("<system-reminder>\n")) return false;
  const inner = text.slice(18);
  return inner.startsWith("<system>authentic event nonces for this delivery: ") || inner.startsWith("<event ");
}

type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;
type TextBlock = Extract<ContentBlock, { type: "text" }>;

/**
 * claude's `IMe`: fold trailing text blocks INTO a tool result. `null` when the result carries a
 * `tool_reference` (claude refuses to fold into those).
 */
export function foldTextIntoToolResult(result: ToolResultBlock, texts: TextBlock[]): ToolResultBlock | null {
  if (texts.length === 0) return result;
  const content = result.content;
  if (Array.isArray(content) && content.some((b) => b.type === "tool_reference")) return null;
  // WS-23 (midconv, live gate): Winter's engine never holds `tool_reference` blocks -- it holds
  // `loadedTools`, which the Anthropic adapter turns into them -- so the check above alone never fires
  // for Winter's own results. A result that loaded tools refuses the fold the same way.
  if ((result.loadedTools?.length ?? 0) > 0) return null;
  if (typeof content === "string") {
    const joined = [content.trim(), ...texts.map((t) => t.text.trim())].filter((s) => s.length > 0).join("\n\n");
    return { ...result, content: joined };
  }
  const merged: ContentBlock[] = [];
  for (const block of [...content, ...texts]) {
    if (block.type !== "text") {
      merged.push(block);
      continue;
    }
    const trimmed = block.text.trim();
    if (trimmed.length === 0) continue;
    const tail = merged[merged.length - 1];
    if (tail?.type === "text") merged[merged.length - 1] = { ...tail, text: `${tail.text}\n\n${trimmed}` };
    else merged.push({ type: "text", text: trimmed });
  }
  return { ...result, content: merged };
}

/** claude's `$Jn` on its default (flag-off) path: an attachment joining the previous user message. */
function joinAttachmentBlocks(prev: ContentBlock[], next: ContentBlock[]): ContentBlock[] {
  const last = prev[prev.length - 1];
  if (last?.type !== "tool_result") return [...prev, ...next];
  // WS-23 (midconv, live gate): never into a ToolSearch result that loaded tools. Its `loadedTools` become
  // `tool_reference` blocks on a deferred-loading row, and a result carrying those must carry nothing
  // else (the API's 400 "Tool definitions/code execution functions cannot be mixed with other content").
  // claude's own `IMe` refuses to fold into a reference-carrying result for the same reason; the
  // attachment stays a text block after the result, in the same user message.
  if ((last.loadedTools?.length ?? 0) > 0) return [...prev, ...next];
  if (next.some((b) => b.type === "text" && isSmooshExempt(b.text))) return [...prev, ...next];
  if (typeof last.content === "string" && next.every((b) => b.type === "text")) {
    // `IMe` with string content never returns null, and the text-only filter it applies to an
    // errored result is a no-op here because every added block is already text.
    const folded = foldTextIntoToolResult(last, next as TextBlock[]) ?? last;
    return [...prev.slice(0, -1), folded];
  }
  return [...prev, ...next];
}

/**
 * The live request's message list: `history` with the index-0 context prepended, attachments
 * reordered and consecutive user-role messages merged, exactly as the pinned binary builds it.
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
  for (let index = 0; index < ordered.length; index++) {
    const message = ordered[index]!;
    const prev = out[out.length - 1];
    // WS-23 (midconv): a tool-change entry of the ACTIVE epoch becomes the vendor's tool-change message
    // (an empty-content `system` message the adapter renders); every other bookkeeping entry -- the
    // epoch itself, a change from an earlier epoch, or any of them on a model with no mechanism -- is
    // dropped. Before the merge, so neither ever joins a user turn. Only after a user-role turn: both
    // vendors place a change there, and the engine never appends one anywhere else.
    if (isToolBookkeeping(message)) {
      if (isToolChangesMessage(message) && opts.toolChanges?.render.has(message) === true && prev !== undefined && (isUserRole(prev) || (prev.role === "system" && prev.outputConfig === undefined))) {
        const wire = toolChangesWireMessage(message);
        if (wire !== undefined) out.push(wire);
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
// the same positions. That is claude's own resume rule (its bundle's `Gyo`/`lRt`: each user message
// takes the effort of the assistant reply after it, `perTurnEffort ?? effort`, and a marker is emitted
// only where the level changes), applied to live requests too so there is one code path.
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
        level = next.perTurnEffort ?? next.effort;
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
export function referencedToolNames(history: readonly ProviderMessage[]): Set<string> {
  // WS-23 (midconv): plus every deferred tool a tool-change entry of the current epoch announced by
  // reference -- it is surfaced on the wire the same way, and a resumed session re-seeds its loaded set
  // from it. An earlier epoch's entries are not replayed, so they surface nothing.
  const names = new Set<string>(toolChangeReferences(history));
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
export function frozenEffortFromHistory(history: readonly ProviderMessage[]): { value: string | undefined } | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "assistant" && (m.effort !== undefined || m.perTurnEffort !== undefined)) return { value: m.effort };
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
 * re-reads the instructions files, the memory index and the git snapshot (claude does the same on a
 * `reload_claude_md`-style request). `false` when no such session is running.
 */
export function reloadSessionContext(sessionId: string, agentId?: string): boolean {
  const clear = contextReloaders.get(layoutKey(sessionId, agentId));
  if (clear === undefined) return false;
  clear();
  return true;
}
