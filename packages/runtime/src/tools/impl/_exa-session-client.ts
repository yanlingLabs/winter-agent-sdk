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
// A CLOSE LEAVES A TOMBSTONE (whole-branch review MINOR 6). Teardown on the throw path does not stop
// children first, so a still-running child's next WebSearch could reach this module AFTER the root
// closed the session's client -- and build a brand new one that nothing would ever close. A closed
// session id is therefore remembered, and a later `exaSearchClientForSession` for it answers
// `undefined` rather than building: `impl/web-search.ts` turns that into an ordinary error RESULT (a
// torn-down session is not a crash). The memory is a bounded FIFO -- the window it has to cover is the
// few seconds between a root's teardown and its last child noticing, so remembering the last
// `MAX_REMEMBERED_CLOSED_SESSIONS` closes is enough and can never itself become the leak MINOR 4 is
// about. `reopenExaSearchClientsForSession` clears it, and the ROOT run calls that when it REGISTERS
// its web session runtime: an in-process `--resume` re-enters the same session id and must be able to
// search again (the same "a resumed run starts fresh" rule `_search-budget.ts` and the fetch cache
// follow).
//
// SESSION TEARDOWN: `engine.ts` calls `closeExaSearchClientForSession(sessionId)` from the ROOT run's
// teardown -- beside `disposeWebSessionRuntime()` on the ordinary path (awaited), and on the run's
// outer `finally` for a run that throws. ROOT ONLY (`config.agentId === undefined`), and that
// condition is the whole point: `exaSearchClientForSession` is keyed on `ctx.sessionId`, and a CHILD
// shares its ROOT's `sessionId` by construction (`web/session-runtime.ts`'s own header: "a child
// shares its parent's session id"). The cached entry therefore belongs to the WHOLE agent tree, not
// to whichever run happened to create it first -- closing it from a CHILD's teardown would drop the
// connection out from under a parent or a sibling that is still mid-search. Pinned by
// `web/search-client-teardown.test.ts`.
import type { ExaSearchClient } from "./_exa-client.ts";

const clientsBySession = new Map<string, ExaSearchClient>();

/** How many recently-closed session ids the tombstone remembers. See the module header for why a bound is the right shape. */
const MAX_REMEMBERED_CLOSED_SESSIONS = 64;
/** Insertion-ordered, so the oldest entry is the one evicted (a `Set` iterates in insertion order). */
const closedSessions = new Set<string>();

function rememberClosed(sessionId: string): void {
  closedSessions.delete(sessionId); // re-inserted below, so this id becomes the NEWEST again
  closedSessions.add(sessionId);
  while (closedSessions.size > MAX_REMEMBERED_CLOSED_SESSIONS) {
    const oldest = closedSessions.values().next();
    if (oldest.done === true) break;
    closedSessions.delete(oldest.value);
  }
}

/**
 * The session's own client -- built by `factory()` on the first call for this `sessionId` and reused
 * by every later one, REGARDLESS of whatever options a later call's `factory` closure would have
 * built (a session's search wiring -- credential ref, blocked-domain floor, test endpoint -- is fixed
 * for the life of one engine run, the same assumption `web/session-runtime.ts`'s own registry makes).
 *
 * `undefined` means this session's client was CLOSED and nothing may build another one for it (the
 * tombstone, see the module header) -- the caller answers with an ordinary error result.
 */
export function exaSearchClientForSession(sessionId: string, factory: () => ExaSearchClient): ExaSearchClient | undefined {
  const existing = clientsBySession.get(sessionId);
  if (existing !== undefined) return existing;
  if (closedSessions.has(sessionId)) return undefined;
  const client = factory();
  clientsBySession.set(sessionId, client);
  return client;
}

/**
 * Closes and forgets `sessionId`'s client, if it ever built one, and TOMBSTONES the id either way --
 * "no client had been built yet" is exactly the state in which a late child would build one.
 * Idempotent; never throws.
 */
export async function closeExaSearchClientForSession(sessionId: string): Promise<void> {
  rememberClosed(sessionId);
  const existing = clientsBySession.get(sessionId);
  if (existing === undefined) return;
  clientsBySession.delete(sessionId);
  await existing.close().catch(() => {});
}

/** Lifts the tombstone: a ROOT run starting (or RESUMING) this session id may search again. Idempotent. */
export function reopenExaSearchClientsForSession(sessionId: string): void {
  closedSessions.delete(sessionId);
}

/** Test/diagnostic only: is this session id tombstoned? */
export function exaSearchClientIsClosedForTest(sessionId: string): boolean {
  return closedSessions.has(sessionId);
}

/** Test hygiene only: forgets every cached client WITHOUT closing it -- a test's own fixture teardown closes its client itself -- and lifts every tombstone. */
export function resetExaSessionClientsForTest(): void {
  clientsBySession.clear();
  closedSessions.clear();
}
