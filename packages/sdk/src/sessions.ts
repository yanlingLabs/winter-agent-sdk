// Task 10 (WS-03 §3.1, §10): the standalone session-management API. These functions run OUTSIDE
// an active query, directly against the filesystem-backed WinterCompatibilitySessionStore (WS-05
// §6) — no engine, no provider. `sessions.ts` re-implements nothing of the store itself: it
// constructs the concrete WinterCompatibilitySessionStore directly (Post-Task-9 state: the
// exported `SessionStore` TYPE is exactly WS-03 §10's pinned six members; `listProjectKeys` lives
// only on the concrete class, which is why this file uses the concrete class rather than the
// pinned interface type).
//
// Semantics (WS-03 §3.1, restated for this file's implementation):
//   - an omitted `directory` searches every project; a supplied one constrains lookup to that
//     directory's own projectKey and NEVER falls back to searching elsewhere.
//   - unknown/ambiguous ids -> SessionNotFoundError (errors.ts), mirroring Task 9's
//     findResumeTarget ambiguity-refusal precedent (resume.ts) -- but this file's own search has
//     no "current directory" concept the way resume's cwd-scoped search does: an omitted
//     directory is a FLAT search across every project, so >1 match is always ambiguous, never
//     resolved by an implicit "current project wins" rule (there is no current project here).
//   - every function honors an explicit `winterHome` (tests use this) with the resolver default
//     (resolveWinterHome, i.e. WINTER_HOME || ~/.winter) otherwise.
//   - deleteSession cascades via the store's own delete() (WS-05 §6).
//   - listSubagents is listSubkeys filtered+stripped to the `subagents/<agentId>` convention the
//     store's own module doc pins -- P4 is what will ever populate a real one; empty until then.
import { WinterCompatibilitySessionStore, type SessionStoreEntry } from "./store/session-store.ts";
import { forkSessionByKey } from "./store/fork-session.ts";
import { resolveWinterHome } from "./paths/home.ts";
import { compatibilityKeys } from "./paths/keys.ts";
import { SessionNotFoundError } from "./errors.ts";

// Not exported (the brief's own signatures inline this shape rather than naming it) -- kept as one
// private alias purely so all nine functions below share the identical shape by construction
// rather than nine independently-typed copies risking drift.
interface SessionQueryOptions {
  directory?: string;
  winterHome?: string;
}

function resolveHome(winterHome: string | undefined): string {
  return winterHome ?? resolveWinterHome();
}

function openStore(winterHome: string | undefined): WinterCompatibilitySessionStore {
  return new WinterCompatibilitySessionStore({ winterHome: resolveHome(winterHome) });
}

async function findInProject(
  store: WinterCompatibilitySessionStore,
  projectKey: string,
  sessionId: string,
): Promise<{ mtime: number } | undefined> {
  const sessions = await store.listSessions(projectKey);
  return sessions.find((s) => s.sessionId === sessionId);
}

// Shared by every single-session function (getSessionInfo, getSessionMessages, renameSession,
// tagSession, deleteSession, forkSession, listSubagents, getSubagentMessages). Deliberately NOT
// findResumeTarget's shape (resume.ts): that search privileges "the current directory" ahead of
// every foreign project even when the id is ALSO ambiguous there, because a resuming engine always
// has a real cwd. This API has no such privileged directory -- an omitted `directory` is a flat
// search over every project, so more than one match is unconditionally ambiguous.
async function resolveSession(
  store: WinterCompatibilitySessionStore,
  sessionId: string,
  directory: string | undefined,
): Promise<{ projectKey: string; mtime: number }> {
  if (directory !== undefined) {
    const projectKey = compatibilityKeys(directory).transcriptProjectKey;
    const found = await findInProject(store, projectKey, sessionId);
    if (found === undefined) {
      throw new SessionNotFoundError("not_found", `session not found: ${sessionId} (in directory-scoped project ${projectKey})`);
    }
    return { projectKey, mtime: found.mtime };
  }

  const allProjectKeys = await store.listProjectKeys();
  const matches: Array<{ projectKey: string; mtime: number }> = [];
  for (const projectKey of allProjectKeys) {
    const found = await findInProject(store, projectKey, sessionId);
    if (found !== undefined) matches.push({ projectKey, mtime: found.mtime });
  }

  if (matches.length === 0) {
    throw new SessionNotFoundError("not_found", `session not found in any project: ${sessionId}`);
  }
  if (matches.length > 1) {
    throw new SessionNotFoundError(
      "ambiguous",
      `session ${sessionId} found in ${matches.length} projects (${matches.map((m) => m.projectKey).join(", ")}); refusing to pick arbitrarily`,
    );
  }
  return matches[0]!;
}

export async function listSessions(
  opts?: SessionQueryOptions,
): Promise<Array<{ sessionId: string; projectKey: string; mtime: number; name?: string; tags?: string[] }>> {
  const store = openStore(opts?.winterHome);
  const projectKeys = opts?.directory !== undefined ? [compatibilityKeys(opts.directory).transcriptProjectKey] : await store.listProjectKeys();

  const result: Array<{ sessionId: string; projectKey: string; mtime: number; name?: string; tags?: string[] }> = [];
  for (const projectKey of projectKeys) {
    const [sessions, summaries] = await Promise.all([store.listSessions(projectKey), store.listSessionSummaries(projectKey)]);
    const summaryById = new Map(summaries.map((s) => [s.sessionId, s] as const));
    for (const s of sessions) {
      const summary = summaryById.get(s.sessionId);
      result.push({
        sessionId: s.sessionId,
        projectKey,
        mtime: s.mtime,
        ...(summary?.name !== undefined ? { name: summary.name } : {}),
        ...(summary?.tags !== undefined ? { tags: summary.tags } : {}),
      });
    }
  }
  return result;
}

export async function getSessionInfo(
  sessionId: string,
  opts?: SessionQueryOptions,
): Promise<{ sessionId: string; projectKey: string; mtime: number; entryCount: number; name?: string; tags?: string[] }> {
  const store = openStore(opts?.winterHome);
  const { projectKey, mtime } = await resolveSession(store, sessionId, opts?.directory);

  const summaries = await store.listSessionSummaries(projectKey);
  const summary = summaries.find((s) => s.sessionId === sessionId);

  // entryCount source (task-10-report.md has the full "pick + why"): the summary sidecar is
  // PRIMARY -- foldSummary runs unconditionally inside append() on every main-key append with
  // native entries (session-store.ts), so it is accurate by construction, not an approximation,
  // and far cheaper than a full load()+tail-repair pass for what is fundamentally a listing-surface
  // read. load() is the FALLBACK for the one real gap: a summary sidecar that is missing (deleted,
  // corrupted-and-dropped by readJsonIfExists's aux-not-fatal posture) even though the session's
  // jsonl genuinely exists -- never silently reports 0 for a session that has real entries.
  const entryCount = summary?.entryCount ?? (await store.load({ projectKey, sessionId }))?.length ?? 0;

  return {
    sessionId,
    projectKey,
    mtime,
    entryCount,
    ...(summary?.name !== undefined ? { name: summary.name } : {}),
    ...(summary?.tags !== undefined ? { tags: summary.tags } : {}),
  };
}

export async function getSessionMessages(sessionId: string, opts?: SessionQueryOptions): Promise<SessionStoreEntry[]> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  const entries = await store.load({ projectKey, sessionId });
  return entries ?? [];
}

export async function renameSession(sessionId: string, name: string, opts?: SessionQueryOptions): Promise<void> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  await store.mergeSessionMetadata({ projectKey, sessionId }, { name });
}

export async function tagSession(sessionId: string, tags: string[], opts?: SessionQueryOptions): Promise<void> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  await store.mergeSessionMetadata({ projectKey, sessionId }, { tags });
}

export async function deleteSession(sessionId: string, opts?: SessionQueryOptions): Promise<void> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  await store.delete({ projectKey, sessionId });
}

export async function forkSession(sessionId: string, opts?: SessionQueryOptions): Promise<{ sessionId: string }> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  return forkSessionByKey(store, { projectKey, sessionId });
}

const SUBAGENT_SUBPATH_PREFIX = "subagents/";

export async function listSubagents(sessionId: string, opts?: SessionQueryOptions): Promise<Array<{ agentId: string }>> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  const subkeys = await store.listSubkeys({ projectKey, sessionId });

  const agents: Array<{ agentId: string }> = [];
  for (const subkey of subkeys) {
    if (subkey.startsWith(SUBAGENT_SUBPATH_PREFIX)) {
      agents.push({ agentId: subkey.slice(SUBAGENT_SUBPATH_PREFIX.length) });
    }
    // A subkey that doesn't match the documented subagents/<agentId> convention (session-store.ts's
    // own module doc) is not a subagent -- excluded rather than passed through raw, so a future
    // non-agent subpath convention (e.g. checkpoints) is never misreported as an agent.
  }
  return agents;
}

export async function getSubagentMessages(sessionId: string, agentId: string, opts?: SessionQueryOptions): Promise<SessionStoreEntry[]> {
  const store = openStore(opts?.winterHome);
  const { projectKey } = await resolveSession(store, sessionId, opts?.directory);
  const entries = await store.load({ projectKey, sessionId, subpath: `${SUBAGENT_SUBPATH_PREFIX}${agentId}` });
  if (entries === null) {
    throw new SessionNotFoundError("not_found", `subagent not found: ${agentId} (session ${sessionId})`);
  }
  return entries;
}
