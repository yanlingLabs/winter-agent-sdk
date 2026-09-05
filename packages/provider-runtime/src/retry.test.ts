import { describe, expect, test } from "bun:test";
import type { ProviderEvent } from "./types.ts";
import { normalizeHttpError, ProviderStallError } from "./errors.ts";
import { DEFAULT_MAX_RETRIES, RETRY_BACKOFF_BASE_MS, RETRY_BACKOFF_CAP_MS, RETRY_AFTER_HONOUR_CEILING_MS, createRetryPolicy, withRetry } from "./retry.ts";

type RetryEvent = Extract<ProviderEvent, { type: "retry" }>;

/** A deterministic policy: no real sleeping, no real randomness — every delay below is exact. */
function testPolicy(over: { maxRetries?: number; random?: () => number } = {}) {
  const slept: number[] = [];
  const policy = createRetryPolicy({
    ...(over.maxRetries !== undefined ? { maxRetries: over.maxRetries } : {}),
    random: over.random ?? ((): number => 1),
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  });
  return { policy, slept };
}

const h = (init: Record<string, string> = {}): Headers => new Headers(init);

describe("createRetryPolicy — the pinned constants (capture (G))", () => {
  test("maxRetries defaults to 10 — the value every api_retry frame of all three runs reported", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(10);
    expect(createRetryPolicy().maxRetries).toBe(10);
  });

  test("backoff is base 1s x2 with FULL jitter, capped at 30s", () => {
    expect(RETRY_BACKOFF_BASE_MS).toBe(1000);
    expect(RETRY_BACKOFF_CAP_MS).toBe(30_000);
    const { policy } = testPolicy({ random: () => 1 }); // full jitter's upper bound
    expect(policy.delayMs(1)).toBe(1000);
    expect(policy.delayMs(2)).toBe(2000);
    expect(policy.delayMs(3)).toBe(4000);
    expect(policy.delayMs(6)).toBe(30_000);
    expect(policy.delayMs(20)).toBe(30_000);
  });

  test("FULL jitter means the whole interval is in play, not a narrow band around the ceiling", () => {
    const low = createRetryPolicy({ random: () => 0 });
    // Full jitter's lower bound is 0; a floor of 1ms keeps a "delay" from being a busy spin.
    expect(low.delayMs(5)).toBeGreaterThanOrEqual(0);
    expect(low.delayMs(5)).toBeLessThan(100);
    const mid = createRetryPolicy({ random: () => 0.5 });
    expect(mid.delayMs(3)).toBe(2000);
  });

  test("Retry-After is honoured VERBATIM up to 60s and IGNORED above it", () => {
    expect(RETRY_AFTER_HONOUR_CEILING_MS).toBe(60_000);
    const { policy } = testPolicy({ random: () => 1 });
    // Capture (G) run (ii): `retry-after: 2` produced retry_delay_ms EXACTLY 2000, not the
    // jittered backoff (577ms/622ms in the neighbouring runs) — the header overrides the schedule.
    expect(policy.delayMs(1, 2000)).toBe(2000);
    expect(policy.delayMs(5, 60_000)).toBe(60_000);
    // Above the ceiling a provider is effectively asking us to hang; fall back to the schedule.
    expect(policy.delayMs(1, 60_001)).toBe(1000);
    expect(policy.delayMs(1, 3_600_000)).toBe(1000);
  });
});

describe("withRetry — attempt accounting and the emitted event", () => {
  test("returns the first success without emitting anything", async () => {
    const { policy, slept } = testPolicy();
    const events: RetryEvent[] = [];
    const value = await withRetry(async () => "ok", policy, (e) => events.push(e));
    expect(value).toBe("ok");
    expect(events).toEqual([]);
    expect(slept).toEqual([]);
  });

  test("retries a retryable failure and announces the delay BEFORE taking it", async () => {
    const { policy, slept } = testPolicy({ random: () => 1 });
    const events: RetryEvent[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw normalizeHttpError(529, h(), JSON.stringify({ error: { type: "overloaded_error" } }));
        return "recovered";
      },
      policy,
      (e) => events.push(e),
    );
    expect(value).toBe("recovered");
    expect(calls).toBe(2);
    // Capture (G) run (i): one api_retry, attempt 1, max_retries 10, error_status 529,
    // error "overloaded", and the announced delay is the one actually taken.
    expect(events).toEqual([{ type: "retry", attempt: 1, maxRetries: 10, retryDelayMs: 1000, errorStatus: 529, error: "overloaded" }]);
    expect(slept).toEqual([1000]);
  });

  test("`attempt` is the RETRY ordinal starting at 1, and the budget is maxRetries retries after the first try", async () => {
    const { policy, slept } = testPolicy({ maxRetries: 3, random: () => 1 });
    const events: RetryEvent[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw normalizeHttpError(503, h(), "");
        },
        policy,
        (e) => events.push(e),
      ),
    ).rejects.toMatchObject({ code: "server" });
    expect(calls).toBe(4); // 1 initial + 3 retries
    expect(events.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.maxRetries === 3)).toBe(true);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  test("honours a per-attempt Retry-After from the error itself", async () => {
    const { policy, slept } = testPolicy({ random: () => 1 });
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw normalizeHttpError(429, h({ "retry-after": "2" }), "");
        return "ok";
      },
      policy,
      () => {},
    );
    expect(slept).toEqual([2000]);
  });

  test("`errorStatus` is OMITTED for a connection error with no HTTP response", async () => {
    const { policy } = testPolicy();
    const events: RetryEvent[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return "ok";
      },
      policy,
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect("errorStatus" in events[0]!).toBe(false);
    // The pinned union has no transport member; `unknown` is the honest bucket.
    expect(events[0]!.error).toBe("unknown");
  });
});

describe("withRetry — what is NOT retried", () => {
  test("a non-retryable error is rethrown immediately, with no event", async () => {
    const { policy, slept } = testPolicy();
    const events: RetryEvent[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw normalizeHttpError(401, h(), "");
        },
        policy,
        (e) => events.push(e),
      ),
    ).rejects.toMatchObject({ code: "auth" });
    expect(calls).toBe(1);
    expect(events).toEqual([]);
    expect(slept).toEqual([]);
  });

  test("an abort is never retried", async () => {
    const { policy } = testPolicy();
    let calls = 0;
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw abort;
        },
        policy,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test("a 429 whose provider code is a billing exhaustion is not retried", async () => {
    const { policy } = testPolicy();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw normalizeHttpError(429, h(), JSON.stringify({ error: { code: "insufficient_quota" } }));
        },
        policy,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test("policy.commit() disables every further retry — the FIRST-BYTE rule (R6-6, WS-13 §13)", async () => {
    // The rule this enforces: retries happen ONLY before the first response byte is consumed. Once
    // a stream has begun, a "retry" is a REPLAY of an effectful turn — the model may already have
    // called a tool, and the caller may already have shown text to a user.
    const { policy, slept } = testPolicy();
    const events: RetryEvent[] = [];
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          policy.commit();
          throw normalizeHttpError(503, h(), "");
        },
        policy,
        (e) => events.push(e),
      ),
    ).rejects.toMatchObject({ code: "server" });
    expect(calls).toBe(1);
    expect(events).toEqual([]);
    expect(slept).toEqual([]);
    expect(policy.committed).toBe(true);
  });

  test("commit() mid-flight stops a retry loop that was already going", async () => {
    const { policy } = testPolicy({ maxRetries: 5, random: () => 1 });
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          if (calls === 3) policy.commit();
          throw normalizeHttpError(503, h(), "");
        },
        policy,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(3); // attempts 1 and 2 retried; attempt 3 committed, so it is final
  });

  test("a stall is never retried — bytes already flowed", async () => {
    const { policy } = testPolicy();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new ProviderStallError("no bytes for 120000ms");
        },
        policy,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test("maxRetries: 0 means try once and never retry", async () => {
    const { policy } = testPolicy({ maxRetries: 0 });
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw normalizeHttpError(503, h(), "");
        },
        policy,
        () => {},
      ),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });
});
