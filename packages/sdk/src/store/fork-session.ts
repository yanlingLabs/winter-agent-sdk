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
import type { SessionKey, SessionStore } from "./session-store.ts";
import { SessionNotFoundError } from "../errors.ts";

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
  return { sessionId: newSessionId };
}
