// ONE EXA CLIENT PER SESSION -- a module that REGISTERS NOTHING, so `impl/web-search.ts` may import
// it without breaching `tools/impl-isolation.test.ts`.
//
// WHY NOT ONE CLIENT PER CALL. `createExaSearchClient` opens a fresh MCP session (an `initialize`
// round trip, its own notification, a tools listing) on its FIRST call and reuses that connection for
// every later one -- see its own header. A client built fresh per `WebSearch` invocation pays that
// handshake EVERY time, and the handshake itself is unpaced (`EXA_ANONYMOUS_MIN_INTERVAL_MS` only
// spaces actual SEARCH calls), so a burst of WebSearch calls from one session could trip the
// anonymous-tier rate limit on the HANDSHAKE alone, before a single real search ran.
//
// WHY NOT ONE CLIENT FOR THE WHOLE PROCESS. The client caches its resolved KEY (`key ??= ...resolveKey
// ...`, called "at most once per client") and its keyed connection for its entire life. Two sessions
// sharing one client would search on whichever session's key resolved FIRST, forever, including a
// session with no key of its own riding a sibling session's -- exactly the credential-crossing bug
// `web/session-runtime.ts`'s own header describes for the identical reason (`webSessionRuntimeFor`'s
// keyed-not-shared registry). So the grain is ONE client per session, created on that session's FIRST
// WebSearch call and reused by every later one in the SAME session.
//
// SESSION TEARDOWN: NOT WIRED HERE, DISCLOSED. Closing gracefully on session end needs a call from
// wherever a session's run actually ends -- the exact shape `toolsearch/search.ts`'s own
// `disposeToolSearchSessionRuntime()` already is, called once from `engine.ts` teardown. That call
// site is a spine edit this lane does not make. In PRODUCTION this is a narrower gap than it looks:
// per CLAUDE.md's own architecture, one `winter` runtime child is one OS PROCESS for the life of one
// session (plus its own descendants, sharing that session id) -- so a cached client's life is already
// bounded by the process's, and the OS reclaims its socket on exit. What is missing is a GRACEFUL
// close (flushing the MCP session cleanly) rather than a leak; `closeExaSearchClientForSession` is
// exported so a future one-line spine hook can call it, and tests call it directly for hygiene.
import type { ExaSearchClient } from "./_exa-client.ts";

const clientsBySession = new Map<string, ExaSearchClient>();

/**
 * The session's own client -- built by `factory()` on the first call for this `sessionId` and reused
 * by every later one, REGARDLESS of whatever options a later call's `factory` closure would have
 * built (a session's search wiring -- credential ref, blocked-domain floor, test endpoint -- is fixed
 * for the life of one engine run, the same assumption `web/session-runtime.ts`'s own registry makes).
 */
export function exaSearchClientForSession(sessionId: string, factory: () => ExaSearchClient): ExaSearchClient {
  const existing = clientsBySession.get(sessionId);
  if (existing !== undefined) return existing;
  const client = factory();
  clientsBySession.set(sessionId, client);
  return client;
}

/** Closes and forgets `sessionId`'s client, if it ever built one. Idempotent; never throws. */
export async function closeExaSearchClientForSession(sessionId: string): Promise<void> {
  const existing = clientsBySession.get(sessionId);
  if (existing === undefined) return;
  clientsBySession.delete(sessionId);
  await existing.close().catch(() => {});
}

/** Test hygiene only: forgets every cached client WITHOUT closing it -- a test's own fixture teardown closes its client itself. */
export function resetExaSessionClientsForTest(): void {
  clientsBySession.clear();
}
