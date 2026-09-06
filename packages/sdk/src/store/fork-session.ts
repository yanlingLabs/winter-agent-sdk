// Task 10 (Controller resolution, task-10-brief.md): the store-level fork primitive relocated
// from the runtime's store/resume.ts — ONE implementation, sdk-side, now that the store itself
// lives here too (WS-05 §6: "the SDK repo implements it"; WS-02 §3's dependency inversion: runtime
// -> sdk, never the reverse). Named `forkSessionByKey` (not `forkSession`) specifically to avoid
// colliding with the public `forkSession(sessionId, opts)` in ../sessions.ts, which wraps this
// primitive after resolving a bare sessionId to a SessionKey (see its own header comment) — the
// runtime's dialect.ts (resolveEngineSession's forkSession-on-resume orchestration) is this
// module's other caller, importing it directly since it takes an already-resolved SessionKey.
// Never fork-copied: this is the only implementation of the primitive in the codebase.
import { randomUUID } from "node:crypto";
import { DIALECT_RECORD_ENTRY_TYPE, type SessionKey, type SessionStore, type SessionStoreEntry, type SessionSummaryEntry } from "./session-store.ts";
import { SessionNotFoundError } from "../errors.ts";

/**
 * The two Winter-only capabilities the fork's PROVIDER STATE rides on (P6 fix wave), reached through
 * a LOCAL intersection exactly as `resume.ts` reaches `listProjectKeys`: the pinned six-member
 * `SessionStore` stays untouched, and a foreign store without them forks the conversation and nothing
 * else -- which is what it did before, now disclosed rather than accidental.
 */
type StoreWithForkCarry = SessionStore & {
  copyProviderStateForFork?(src: SessionKey, dest: SessionKey): Promise<number>;
  readSessionSummary?(key: { projectKey: string; sessionId: string }): Promise<SessionSummaryEntry | null>;
};

/** The identity fields a session's summary carries (folded from the dialect record) and a fork must inherit -- never `entryCount`, name or tags. */
const IDENTITY_FIELDS = ["providerId", "modelKey", "adapterId", "adapterVersion", "catalogVersion", "authRef", "classifierPin"] as const;

/**
 * `resume + forkSession: true` (WS-05 §7) — copies `src`'s entries into a brand-new lowercase
 * RFC4122 v4 session id, with each copied entry's OWN `sessionId` field rewritten to the fork's
 * id (uuid/parentUuid/content are otherwise untouched — the fork's conversational identity is
 * byte-for-byte the source's, just re-owned). `src` is never written to: this only reads it (via
 * store.load) and appends to the NEW key, so the source stays byte-identical on disk by
 * construction. No undo/file-history copies (WS-05 §7) — neither exists in this codebase yet, so
 * there is nothing to carry forward or omit; revisit when either lands.
 *
 * Throws `SessionNotFoundError("not_found", ...)` — not resume.ts's ResumeTargetError, which this
 * primitive no longer has access to post-relocation — when `src` doesn't exist. The public
 * `forkSession(sessionId, opts)` wrapper in ../sessions.ts already validates existence before
 * calling this, so that branch is a defensive backstop (a TOCTOU race, or a direct caller) rather
 * than the primary path a normal caller hits.
 */
export async function forkSessionByKey(store: SessionStore, src: SessionKey): Promise<{ sessionId: string }> {
  const entries = await store.load(src);
  if (entries === null) {
    throw new SessionNotFoundError("not_found", `forkSession: source session not found: ${JSON.stringify(src)}`);
  }
  const newSessionId = randomUUID();
  const rewritten = entries.map((e) => (typeof e.sessionId === "string" ? { ...e, sessionId: newSessionId } : e));
  const destKey: SessionKey = { projectKey: src.projectKey, sessionId: newSessionId, ...(src.subpath !== undefined ? { subpath: src.subpath } : {}) };
  await store.append(destKey, rewritten);
  // P6 fix wave: THE FORK CARRIES ITS PROVIDER STATE, at the store level, for BOTH callers -- this
  // public door and the runtime's `resume + forkSession` orchestration -- so there is one
  // implementation of it. Before this the runtime copied the sidecar on its own path and the public
  // `forkSession()` landed chain-less, so a fork through the session API resumed on the pre-P6 silent
  // path and lost every native continuation the source had accumulated (T3 re-review round 2, M3).
  //
  // AUXILIARY, like every other store side effect on a fork: a chain that could not be copied is a
  // degraded chain, which the resume warning already reports -- never a reason to fail a fork whose
  // CONVERSATION copied fine.
  const carry = store as StoreWithForkCarry;
  try {
    await carry.copyProviderStateForFork?.(src, destKey);
    // THE IDENTITY BLOCK travels with it: the resume side reads it to tell "this session had provider
    // state" from "this session predates the concept", so a fork with the records but no block would
    // still take the silent path. Landed the way the runtime lands it -- a dialect-record entry the
    // store folds into the fork's summary and never writes as a transcript line -- with ONLY the
    // identity fields, so the fork's own `entryCount`/name/tags are never overwritten by the source's.
    const summary = destKey.subpath === undefined && carry.readSessionSummary !== undefined ? await carry.readSessionSummary({ projectKey: src.projectKey, sessionId: src.sessionId }) : null;
    if (summary !== null && typeof summary.providerId === "string" && typeof summary.modelKey === "string") {
      const identity: SessionStoreEntry = { type: DIALECT_RECORD_ENTRY_TYPE };
      for (const field of IDENTITY_FIELDS) {
        const value = (summary as Record<string, unknown>)[field];
        if (typeof value === "string") identity[field] = value;
      }
      await store.append(destKey, [identity]);
    }
  } catch {
    /* auxiliary -- see above */
  }
  return { sessionId: newSessionId };
}
