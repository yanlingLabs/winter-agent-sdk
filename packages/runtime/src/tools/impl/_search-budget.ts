// WebSearch's SESSION-WIDE call budget -- a module that REGISTERS NOTHING, so `impl/web-search.ts`
// (and any future consumer) may import it without breaching `tools/impl-isolation.test.ts`.
//
// 200 WebSearch TOOL CALLS per session (claude's own default), counted BEFORE the search runs, SHARED
// with every descendant subagent, reset with the session. The sharing is free: `session-runtime.ts`'s
// own header records that "a child shares its parent's session id" (only `agentId` tells a child
// apart from its root) -- so a plain `Map<sessionId, number>` keyed on `ctx.sessionId` (never
// `ctx.agentId`) is ALREADY the shared, per-session counter the spec asks for, with no inheritance
// machinery of its own to write.
//
// "RESET WITH THE SESSION" IS AN EXPLICIT TEARDOWN (whole-branch review MINOR 4 -- this header used to
// claim it needed none, on the reasoning that a new session brings an id this map has never seen. That
// is true of a fresh session and FALSE of an in-process `--resume`, which re-enters the SAME id: the
// resumed run inherited the spent count and its own entry outlived it forever). `forgetSession` is
// called from the ROOT run's own teardown in `engine.ts`, so a resumed session starts at zero -- which
// is exactly what a resumed session gets in claude, where `--resume` is a new process with a fresh
// registry. The cap is per session-RUN here, deliberately, not per session-id-for-all-time.
import { WINTER_BRAND, envName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

type EnvBrand = Pick<BrandProfile, "envPrefix">;

export const DEFAULT_MAX_WEB_SEARCHES_PER_SESSION = 200;

/**
 * claude's own env name is `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` (research file, verbatim); this
 * is Winter's copy of the MECHANISM (a session-cap override), branded through `envName` like every
 * other product env name in this codebase -- never a literal `WINTER_...` string (brand-gate rule 9/10).
 */
export function maxWebSearchesPerSessionEnvName(brand: EnvBrand = WINTER_BRAND): string {
  return envName(brand, "MAX_WEB_SEARCHES_PER_SESSION");
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function resolveMaxWebSearchesPerSession(env: Record<string, string | undefined> = process.env, brand: EnvBrand = WINTER_BRAND): number {
  return parsePositiveIntEnv(env[maxWebSearchesPerSessionEnvName(brand)], DEFAULT_MAX_WEB_SEARCHES_PER_SESSION);
}

// Absent from this map = 0 calls spent (a fresh session, or one this module has never seen).
const usedBySession = new Map<string, number>();

export interface WebSearchBudgetReservation {
  ok: boolean;
  /** Calls already spent BEFORE this reservation (never incremented by a refusal). */
  used: number;
  cap: number;
}

/**
 * Reserves ONE WebSearch call against `sessionId`'s budget -- called BEFORE the search runs, so a
 * call that is never reserved (an input-validation failure, a wiring gap) never counts against it,
 * matching claude's own `validateInput`-before-`call` ordering.
 *
 * `ok: false` leaves the counter UNCHANGED: the 201st call and the 202nd both read "200 of 200", not
 * "201 of 200" -- the refusal is a repeatable fact about the session, not an escalating one.
 */
export function reserveWebSearchCall(sessionId: string, cap: number): WebSearchBudgetReservation {
  const used = usedBySession.get(sessionId) ?? 0;
  if (used >= cap) return { ok: false, used, cap };
  usedBySession.set(sessionId, used + 1);
  return { ok: true, used, cap };
}

export function webSearchCallsUsed(sessionId: string): number {
  return usedBySession.get(sessionId) ?? 0;
}

/**
 * claude's own refusal text (research file, verbatim), with the env var name substituted for
 * Winter's branded one. A RESULT, never an error: `durationSeconds:0, searchCount:0` in claude's own
 * structured output, which this runtime does not carry -- the string alone is what reaches the model.
 */
export function webSearchBudgetRefusalText(used: number, cap: number, brand: EnvBrand = WINTER_BRAND): string {
  return `Web search was not performed: this session has used its web search budget (${used} of ${cap} WebSearch calls). Continue with the information already gathered instead of issuing more searches. If more searches are genuinely needed, ask the user to raise ${maxWebSearchesPerSessionEnvName(brand)}.`;
}

/** Forgets `sessionId`'s spend (whole-branch review MINOR 4). Called from the ROOT run's teardown; idempotent. */
export function forgetWebSearchBudgetForSession(sessionId: string): void {
  usedBySession.delete(sessionId);
}

export function resetWebSearchBudgetForTest(): void {
  usedBySession.clear();
}
