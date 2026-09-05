// Retry policy. FROZEN as of P6 T2's merge (R6-12).
//
// R6-6 / R6-C, and every constant below is either a pinned observation or an explicitly ruled value:
//
//   - `maxRetries` DEFAULT 10 — capture (G) observed `max_retries: 10` on every `api_retry` frame of
//     all three runs, a value the pinned declaration itself never states.
//   - backoff base 1s, x2, FULL jitter, capped at 30s (ruled; capture (G)'s own measured curve runs
//     557 / 1162 / 2189 / 4026 / 9290 / 16675 / 36061 / … — roughly exponential with jitter to about
//     40s then flat, which this cap deliberately diverges from downward).
//   - `Retry-After` honoured VERBATIM up to 60s, and CLAMPED to 60s above it — capture (G) run (ii):
//     `retry-after: 2` produced `retry_delay_ms: 2000` exactly, against 577ms/622ms jittered delays
//     in the neighbouring runs. A cap is a clamp: an hour-long Retry-After still means "unavailable
//     now", so the ceiling is the answer, never the sub-second jittered schedule.
//   - retryable = 408/409/429/5xx/network/timeout, decided in `errors.ts` so exactly one place owns it.
//
// THE FIRST-BYTE RULE is the load-bearing one (WS-13 §13: "no unsafe automatic replay of effectful
// turns"). Retries happen ONLY before the first response byte is consumed. `policy.commit()` is how a
// caller says the stream has begun; after it, every failure is final. A "retry" past that point is a
// REPLAY — the model may already have emitted a tool call the caller executed, and the caller may
// already have shown text to a user. There is no way to un-ring that bell, so the policy refuses to.

import type { ProviderEvent } from "./types.ts";
import { normalizeThrown, toSdkAssistantMessageError } from "./errors.ts";

export const DEFAULT_MAX_RETRIES = 10;
export const RETRY_BACKOFF_BASE_MS = 1000;
export const RETRY_BACKOFF_CAP_MS = 30_000;
export const RETRY_AFTER_HONOUR_CEILING_MS = 60_000;

export interface RetryPolicyOptions {
  maxRetries?: number;
  /** Injected for deterministic tests. Full jitter multiplies the whole interval by this in [0, 1). */
  random?: () => number;
  /** Injected for deterministic tests — a real `withRetry` never sleeps in a unit test. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryPolicy {
  readonly maxRetries: number;
  /** True once `commit()` has been called: the stream has begun and no further retry is safe. */
  readonly committed: boolean;
  /** Called by the caller the moment the first response byte is consumed. Idempotent, one-way. */
  commit(): void;
  /** The delay before retry number `attempt` (1-based). `retryAfterMs`, when within the ceiling, replaces the schedule entirely. */
  delayMs(attempt: number, retryAfterMs?: number): number;
  /** Waits, ABORTABLY. A backoff can be 30 s (or a clamped 60 s of Retry-After), and an interrupt must not have to outlast it. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * The default wait. Rejects promptly on abort rather than running the timer down: with a clamped
 * `Retry-After` the backoff can be a full minute, so an unabortable sleep would make `interrupt`
 * feel broken for up to that long — and the timer is cleared either way, so nothing is left armed.
 */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      const err = new Error("retry backoff aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      const err = new Error("retry backoff aborted");
      err.name = "AbortError";
      reject(err);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function createRetryPolicy(opts: RetryPolicyOptions = {}): RetryPolicy {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  let committed = false;
  return {
    maxRetries,
    get committed(): boolean {
      return committed;
    },
    commit(): void {
      committed = true;
    },
    delayMs(attempt: number, retryAfterMs?: number): number {
      // CLAMPED, not discarded. R6-C says `Retry-After` is honoured "capped at 60 s", and a cap is a
      // clamp: a provider asking for an hour is still telling us it is unavailable NOW, so the right
      // response is to wait the ceiling, not to ignore the header and come back in under a second on
      // the jittered schedule (which is what discarding it produced — hammering a provider that had
      // just asked, explicitly, to be left alone).
      if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, RETRY_AFTER_HONOUR_CEILING_MS);
      const ceiling = Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
      // FULL jitter (the whole interval is in play, not a narrow band around the ceiling): the point
      // is to break up a thundering herd of clients that all failed on the same upstream blip.
      return Math.round(random() * ceiling);
    },
    sleep,
  };
}

/**
 * Runs `attempt` under the policy, emitting one `retry` event per retry — announced BEFORE the delay
 * is taken, which is the pinned ordering (capture (G): the frame's `retry_delay_ms` of 577 preceded
 * a measured 586ms gap).
 *
 * `attempt` is the RETRY ORDINAL starting at 1, matching the pin: a single failure then success
 * produced exactly one frame with `attempt: 1`. So the total number of invocations is
 * `maxRetries + 1`.
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<T>,
  policy: RetryPolicy,
  onRetry: (event: Extract<ProviderEvent, { type: "retry" }>) => void,
  /** Cancels the BACKOFF as well as the attempt. Optional so every existing call site is unchanged. */
  signal?: AbortSignal,
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      const normalized = normalizeThrown(err);
      // Order matters: `committed` is checked FIRST so a caller that consumed a byte and then hit a
      // retryable 503 mid-stream is never replayed, whatever the status says.
      if (policy.committed || !normalized.retryable || n > policy.maxRetries) throw err;
      const delayMs = policy.delayMs(n, normalized.retryAfterMs);
      onRetry({
        type: "retry",
        attempt: n,
        maxRetries: policy.maxRetries,
        retryDelayMs: delayMs,
        // ABSENT, not null, for a connection error with no HTTP response — the case the pinned
        // `api_retry.error_status: number | null` describes and capture (G) could not reach through
        // a responding loopback.
        ...(normalized.status !== undefined ? { errorStatus: normalized.status } : {}),
        error: toSdkAssistantMessageError(normalized),
      });
      await policy.sleep(delayMs, signal);
    }
  }
}
