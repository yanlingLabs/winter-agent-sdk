// The codex subscription-quota manager, ported from Norma's `packages/core/src/providers/quota.ts`
// and narrowed to what R6-B leaves it.
//
// WHAT THE PORT LOST, AND WHY. Norma's `withQuota` wrapped a provider with its own retry loop and
// backoff. Winter's retry lives in ONE place (`withRetry`, before the first byte, with the pinned
// schedule and `Retry-After` handling), so re-implementing it here would give a codex turn a second,
// differently-behaved retry policy. What survives is the part `withRetry` cannot know: the
// SUBSCRIPTION STATE — "this account is currently limited, and here is when it resumes" — plus the
// concurrency cap and usage accounting.
//
// R6-B, STATED AS THE RULE THIS FILE IMPLEMENTS. `rate_limit_event` in the pin is a
// subscription/overage signal, not a generic HTTP-429 one: capture (G) observed ZERO of them for a
// 429 carrying a full rate-limit header set, and the pinned 429 path is `api_retry` with
// `error_status: 429`. So an HTTP 429 anywhere in Winter is a `retry` event plus a normalized
// `rate_limit` ERROR CODE — and this manager, whose state is genuinely about a ChatGPT
// subscription's quota, is the ONE producer of the `rate_limit` EVENT. Header-derived limits never
// become events at all.

import type { ProviderEvent } from "../../types.ts";

export type QuotaState = { kind: "ok" } | { kind: "limited"; resumeAt: number };

export interface QuotaManagerOptions {
  maxConcurrent?: number;
  /** Injected so a fixture never waits out a real limit window. */
  now?: () => number;
  /**
   * How `waitIfLimited` waits. Injectable for the same reason `RetryPolicyOptions.sleep` is, and it
   * is NOT redundant with it: in production the retry backoff and the quota window are the same
   * wait (the backoff consumes the window), but a fixture that mocks only the retry sleep still
   * spends the real window here — twice per 429 scenario.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Tracks a ChatGPT account's quota state and caps concurrent turns against it.
 *
 * `resumeAt` is epoch MILLISECONDS internally and is rendered as epoch SECONDS on the event, which
 * is the pinned `SDKRateLimitInfo.resetsAt` convention. Only fields the pin actually declares are
 * emitted: `status` and `resetsAt`. Inventing a `rateLimitType` (whose six members are all
 * consumer-subscription shapes) would be a claim about which window was hit, and the backend's 429
 * does not say.
 */
export class QuotaManager {
  private readonly maxConcurrent: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private active = 0;
  private waiters: Array<() => void> = [];
  private limitedUntil = 0;
  private listeners: Array<(state: QuotaState) => void> = [];
  private totals = { inputTokens: 0, outputTokens: 0 };

  constructor(opts: QuotaManagerOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultQuotaSleep;
  }

  state(): QuotaState {
    return this.now() < this.limitedUntil ? { kind: "limited", resumeAt: this.limitedUntil } : { kind: "ok" };
  }

  onStateChange(callback: (state: QuotaState) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  /**
   * Records that the backend refused for quota reasons.
   *
   * `retryAfterMs` may be absent — a 429 without the header is common — in which case the window is
   * recorded as "limited now" with no claimed resume time rather than an invented one.
   */
  noteRateLimit(retryAfterMs: number | undefined): void {
    const until = this.now() + (retryAfterMs ?? 0);
    if (until <= this.limitedUntil) return;
    this.limitedUntil = until;
    this.emit();
  }

  /** The account is serving again. Silent when it never stopped — a listener must not see a state change that did not happen. */
  noteRecovered(): void {
    if (this.limitedUntil === 0) return;
    this.limitedUntil = 0;
    this.emit();
  }

  accumulate(inputTokens: number, outputTokens: number): void {
    this.totals.inputTokens += inputTokens;
    this.totals.outputTokens += outputTokens;
  }

  usage(): { inputTokens: number; outputTokens: number } {
    return { ...this.totals };
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }

  /** Waits out a known limit window, ABORTABLY: an interrupt must not have to outlast a quota reset. */
  async waitIfLimited(signal?: AbortSignal): Promise<void> {
    const wait = this.limitedUntil - this.now();
    if (wait <= 0 || signal?.aborted === true) return;
    await this.sleep(wait, signal);
  }
}

/** The default wait: a timer that an abort cuts short rather than outlasts. */
function defaultQuotaSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * A quota state -> the pinned-shaped `rate_limit` event.
 *
 * `kind: "subscription-quota"` is the type-level statement that this is NOT an HTTP 429 (R6-B), and
 * it is the only `kind` the seam admits.
 */
export function quotaEvent(state: QuotaState): Extract<ProviderEvent, { type: "rate_limit" }> {
  if (state.kind === "ok") return { type: "rate_limit", kind: "subscription-quota", info: { status: "allowed" } };
  return {
    type: "rate_limit",
    kind: "subscription-quota",
    info: {
      status: "rejected",
      // Epoch SECONDS: the pinned `SDKRateLimitInfo.resetsAt` convention. Omitted entirely when the
      // backend named no window, because "resets at now" is a claim, not an absence.
      ...(state.resumeAt > 0 ? { resetsAt: Math.round(state.resumeAt / 1000) } : {}),
    },
  };
}
