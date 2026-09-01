// Task 9 (WS-05 §7): continue / resume / fork / resume-at. Pure, store-level primitives — the
// orchestration that wires these into a running engine session (P1-N project-dir-name record/apply,
// message-rebuild, chain continuation) lives in dialect.ts's resolveEngineSession, which is what
// main.ts and testing.ts actually call (Task 8's two persistence call sites — this task extends
// those paths, it never adds a third).
//
// WS-05 §7's table, as restated for P1 scope (worktree-awareness for `resume` is explicitly
// deferred — see findResumeTarget's own comment):
//   continue: true      -> newest session in the CURRENT directory only, no cross-project fallback.
//   resume: <uuid>       -> current project first; then every OTHER project; >1 foreign match is a
//                           typed refusal, never an arbitrary pick.
//   forkSession: true    -> (combined with continue/resume) copies the resolved target into a fresh
//                           uuid FIRST; the original is left byte-identical; no undo/file-history is
//                           copied (neither exists yet at P1 — nothing to carry or omit).
//   resumeSessionAt      -> keep only through the given uuid; resumeDropsTurn confirms (and
//                           validates) that doing so intentionally discards later entries.
import { randomUUID } from "node:crypto";
import type { ProviderMessage, ContentBlock } from "../engine.ts";
import type { SessionKey, SessionStore, SessionStoreEntry } from "./session-store.ts";

export class ResumeTargetError extends Error {
  readonly reason: "not_found" | "ambiguous";
  constructor(reason: "not_found" | "ambiguous", message: string) {
    super(message);
    this.name = "ResumeTargetError";
    this.reason = reason;
  }
}

export class ResumeTruncationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeTruncationError";
  }
}

// findContinueTarget's "newest by mtime" contract needs mtime, and findResumeTarget's cross-project
// search needs project enumeration — neither is available through load() (which also runs
// tail-repair, a MUTATING operation that must never fire against a foreign session file merely
// being PROBED during search; see projectHasSession below). Both walk store.listSessions(), a
// stat-level read with no such side effect.
async function projectHasSession(store: SessionStore, projectKey: string, sessionId: string): Promise<boolean> {
  if (!store.listSessions) return false;
  const sessions = await store.listSessions(projectKey);
  return sessions.some((s) => s.sessionId === sessionId);
}

/** `continue: true` — the newest session in exactly one directory (WS-05 §7: no cross-project fallback). */
export async function findContinueTarget(store: SessionStore, cwdKey: string): Promise<string | null> {
  if (!store.listSessions) return null;
  const sessions = await store.listSessions(cwdKey);
  if (sessions.length === 0) return null;
  // listSessions' own contract: "ORDER NOT GUARANTEED — sort yourself."
  let newest = sessions[0]!;
  for (const s of sessions) {
    if (s.mtime > newest.mtime) newest = s;
  }
  return newest.sessionId;
}

/**
 * `resume: <uuid>` — current project first (an unconditional win, never subject to the ambiguity
 * check below, even if the same id ALSO happens to exist elsewhere); then every other project,
 * resolving only on a unique foreign match.
 *
 * Deferred scope (documented, not silently dropped): WS-05 §7 also says to search "the current
 * project + its git worktrees" before falling through to every other project. P1 has no
 * worktree-aware transcriptProjectKey (compatibilityKeys' worktree-awareness is memoryProjectKey
 * only, WS-05 §3.2) and the outer task brief's own restatement of this rule omits worktrees
 * entirely — a worktree session resolves via the ordinary "every other project" fallback today
 * (correct, just not distinguished from any other foreign project), until a later task adds
 * worktree identity to the search's first phase.
 */
export async function findResumeTarget(store: SessionStore, opts: { sessionId: string; cwdKey: string }): Promise<{ projectKey: string }> {
  if (await projectHasSession(store, opts.cwdKey, opts.sessionId)) {
    return { projectKey: opts.cwdKey };
  }

  if (!store.listProjectKeys) {
    throw new ResumeTargetError("not_found", `session not found: ${opts.sessionId} (store cannot enumerate other projects)`);
  }
  const allProjectKeys = await store.listProjectKeys();
  const foreignMatches: string[] = [];
  for (const projectKey of allProjectKeys) {
    if (projectKey === opts.cwdKey) continue; // already checked above
    if (await projectHasSession(store, projectKey, opts.sessionId)) foreignMatches.push(projectKey);
  }

  if (foreignMatches.length === 0) {
    throw new ResumeTargetError("not_found", `session not found in any project: ${opts.sessionId}`);
  }
  if (foreignMatches.length > 1) {
    throw new ResumeTargetError(
      "ambiguous",
      `session ${opts.sessionId} found in ${foreignMatches.length} foreign projects (${foreignMatches.join(", ")}); refusing to pick arbitrarily`,
    );
  }
  return { projectKey: foreignMatches[0]! };
}

/**
 * `resume + forkSession: true` — copies `src`'s entries into a brand-new lowercase RFC4122 v4
 * session id, with each copied entry's OWN `sessionId` field rewritten to the fork's id (uuid/
 * parentUuid/content are otherwise untouched — the fork's conversational identity is byte-for-byte
 * the source's, just re-owned). `src` is never written to: forkSession only reads it (via
 * store.load) and appends to the NEW key, so the source stays byte-identical on disk by
 * construction. No undo/file-history copies (WS-05 §7) — neither exists in this codebase yet, so
 * there is nothing to carry forward or omit; revisit when either lands.
 */
export async function forkSession(store: SessionStore, src: SessionKey): Promise<{ sessionId: string }> {
  const entries = await store.load(src);
  if (entries === null) {
    throw new ResumeTargetError("not_found", `forkSession: source session not found: ${JSON.stringify(src)}`);
  }
  const newSessionId = randomUUID();
  const rewritten = entries.map((e) => (typeof e.sessionId === "string" ? { ...e, sessionId: newSessionId } : e));
  const destKey: SessionKey = { projectKey: src.projectKey, sessionId: newSessionId, ...(src.subpath !== undefined ? { subpath: src.subpath } : {}) };
  await store.append(destKey, rewritten);
  return { sessionId: newSessionId };
}

// The narrow slice of a loaded SessionStoreEntry that resume's own algorithms need: a real chain
// identity (uuid/parentUuid) plus enough of the message to rebuild provider context. Deliberately
// NOT SessionStoreEntry itself (whose `[key: string]: unknown` index signature makes object-spread
// construction against a target interface unreliable — see dialect.ts's BaseFields comment for the
// same TS quirk hit and worked around in Task 8) and deliberately narrower than DialectEntryBase
// (dialect.ts's OWN producer-side type): resume only ever READS entries, it never needs the
// producer's cwd/version/timestamp/isSidechain fields.
export interface DialectEntry {
  type: string;
  uuid: string;
  parentUuid: string | null;
  message?: { role: string; content: unknown };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Narrows a loaded SessionStoreEntry[] to the entries that actually carry a chain identity (WS-05
 * §5.2's chain guarantee applies to entries with a uuid; mirrors dialect.ts's own validateChain
 * narrowing) — an entry with no uuid at all is simply not part of the resumable chain. */
export function toDialectEntries(raw: SessionStoreEntry[]): DialectEntry[] {
  const result: DialectEntry[] = [];
  for (const e of raw) {
    if (typeof e.uuid !== "string") continue;
    const parentUuid = typeof e.parentUuid === "string" ? e.parentUuid : null;
    const rawMessage = (e as { message?: unknown }).message;
    const message = isRecord(rawMessage) && typeof rawMessage.role === "string" ? { role: rawMessage.role, content: rawMessage.content } : undefined;
    result.push({ type: e.type, uuid: e.uuid, parentUuid, ...(message !== undefined ? { message } : {}) });
  }
  return result;
}

/**
 * `resumeSessionAt` — keep only through `atUuid`; `resumeDropsTurn` confirms the caller intends to
 * discard whatever comes after it. This NEVER mutates or deletes stored entries — the store is
 * append-only (WS-05 §6) and the transcript is a graph, not a linear buffer (WS-05 §7): the tail
 * left out of the returned array stays on disk untouched, and continuing from `atUuid` grows a new
 * branch alongside it.
 *
 * dropsTurn validation (provisional interpretation, same standing as engine.ts's P1-G/P1-H synthetic
 * tool_result shapes — no official capture pins this yet): every entry AFTER atUuid in the given
 * array must be a descendant of atUuid by walking its OWN parentUuid chain. This is what "validates
 * every dropped entry descends from the target user turn" (the brief's phrasing) buys structurally:
 * a transcript that has previously branched (e.g. an earlier resumeSessionAt) can contain entries
 * positioned after atUuid in file order that are NOT actually part of its lineage — silently
 * dropping those would discard unrelated history, not merely "the tail of this turn," so that case
 * is rejected rather than accepted just because dropsTurn was passed.
 */
export function truncateAt(entries: DialectEntry[], opts: { atUuid: string; dropsTurn: boolean }): DialectEntry[] {
  const idx = entries.findIndex((e) => e.uuid === opts.atUuid);
  if (idx === -1) {
    throw new ResumeTruncationError(`resumeSessionAt target uuid not found in this transcript: ${opts.atUuid}`);
  }
  const kept = entries.slice(0, idx + 1);
  const dropped = entries.slice(idx + 1);
  if (dropped.length === 0) return kept;

  if (!opts.dropsTurn) {
    throw new ResumeTruncationError(
      `resumeSessionAt would drop ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"} after ${opts.atUuid}; pass resumeDropsTurn:true to confirm`,
    );
  }

  const byUuid = new Map(entries.map((e) => [e.uuid, e] as const));
  for (const d of dropped) {
    if (!descendsFrom(d, opts.atUuid, byUuid)) {
      throw new ResumeTruncationError(
        `resumeSessionAt: dropped entry ${d.uuid} does not descend from the target turn ${opts.atUuid}; refusing to discard unrelated history`,
      );
    }
  }
  return kept;
}

function descendsFrom(entry: DialectEntry, ancestorUuid: string, byUuid: Map<string, DialectEntry>): boolean {
  const seen = new Set<string>();
  let cursor: DialectEntry | undefined = entry;
  while (cursor) {
    if (cursor.uuid === ancestorUuid) return true;
    if (seen.has(cursor.uuid)) return false; // cycle guard — never true for a chain that passed validateChain; defensive only
    seen.add(cursor.uuid);
    cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid);
  }
  return false;
}

// --- rebuilding provider context from a resumed/continued/forked transcript ----------------------
//
// The inverse of engine.ts's own accumulation, which the dialect writer flattens into on-disk
// content-block arrays. Two shapes need un-flattening to reproduce EXACTLY what a continuous,
// never-resumed run would have accumulated in memory (pinned by resume.test.ts's
// continuous-vs-split-run fidelity test):
//   - a tool_result-only "user" entry was pushed to engine.ts's `messages` as role "tool" (the
//     dialect has no "tool" role — tool results ride "user" on disk, WS-05 §5.2 — but engine.ts's
//     OWN in-memory history keeps them on a distinct role for round/pairing bookkeeping);
//   - a plain-text assistant reply was pushed as a bare STRING (`messages.push({role:"assistant",
//     content: turn.text})`), never as the single-element content-block array the dialect always
//     persists it as (assistantEntry's `content: Block[]` contract is array-always) — collapsed
//     back to a string here.
// A resumed history containing engine.ts's own synthetic P1-G (`[interrupted]`) / P1-H (`[error:
// …]`) tool_result markers is legitimate input: neither is special-cased below, since from the
// provider's perspective a synthetic tool_result satisfying a tool_use_id is indistinguishable from
// a real one, and both must round-trip verbatim to preserve the tool_use/tool_result pairing
// invariant on the very next provider request.
export function rebuildProviderMessages(entries: DialectEntry[]): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  for (const e of entries) {
    const message = e.message;
    if (message === undefined) continue; // not a conversational entry — still counts toward chain continuity elsewhere, never fed to the provider
    const content = message.content;

    if (e.type === "user") {
      if (Array.isArray(content) && content.length > 0 && content.every((b) => isRecord(b) && b.type === "tool_result")) {
        messages.push({ role: "tool", content: content as ContentBlock[] });
      } else if (typeof content === "string") {
        messages.push({ role: "user", content });
      } else if (Array.isArray(content)) {
        // Not producible by this engine today (a user entry's content is always either plain text
        // or all-tool_result blocks), but WS-05 §5.1's wider corpus allows richer user content —
        // pass through rather than silently dropping an unrecognized-but-real shape.
        messages.push({ role: "user", content: content as ContentBlock[] });
      }
    } else if (e.type === "assistant") {
      if (Array.isArray(content) && content.length === 1 && isRecord(content[0]) && content[0]!.type === "text" && typeof content[0]!.text === "string") {
        messages.push({ role: "assistant", content: content[0]!.text as string });
      } else if (Array.isArray(content)) {
        messages.push({ role: "assistant", content: content as ContentBlock[] });
      }
    }
    // Unknown entry types are skipped for provider context — never fed to a real provider — but the
    // caller (dialect.ts's resolveEngineSession) computes chain continuity from the FULL entry
    // array, not from this function's output, so an unknown trailing entry still anchors the chain.
  }
  return messages;
}
