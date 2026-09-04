import { describe, test, expect } from "bun:test";
import { createStallWatchdog, resolveStallTimeoutMs, ChildStalledError } from "./watchdog.ts";

describe("resolveStallTimeoutMs (WS-10 §6, R4-9)", () => {
  test("defaults to 600000ms", () => {
    expect(resolveStallTimeoutMs({})).toBe(600_000);
  });

  test("env override", () => {
    expect(resolveStallTimeoutMs({ WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "1234" })).toBe(1234);
  });

  test("a non-positive-finite env value falls back to the default", () => {
    expect(resolveStallTimeoutMs({ WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "0" })).toBe(600_000);
    expect(resolveStallTimeoutMs({ WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "-5" })).toBe(600_000);
    expect(resolveStallTimeoutMs({ WINTER_ASYNC_AGENT_STALL_TIMEOUT_MS: "nope" })).toBe(600_000);
  });
});

describe("createStallWatchdog", () => {
  test("fires exactly once, with a typed ChildStalledError, after timeoutMs with no pokes", async () => {
    let stalled: ChildStalledError | undefined;
    let fireCount = 0;
    const wd = createStallWatchdog(10, (err) => {
      fireCount += 1;
      stalled = err;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(fireCount).toBe(1);
    expect(stalled).toBeInstanceOf(ChildStalledError);
    expect(stalled?.timeoutMs).toBe(10);
    wd.cancel();
  });

  test("poke() resets the countdown -- steady poking never fires", async () => {
    let fired = false;
    const wd = createStallWatchdog(15, () => {
      fired = true;
    });
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 8));
      wd.poke();
    }
    expect(fired).toBe(false);
    wd.cancel();
  });

  test("cancel() before the deadline prevents it from ever firing", async () => {
    let fired = false;
    const wd = createStallWatchdog(10, () => {
      fired = true;
    });
    wd.cancel();
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(false);
  });

  test("poke()/cancel() after it has already fired are silent no-ops (never a second callback)", async () => {
    let fireCount = 0;
    const wd = createStallWatchdog(10, () => {
      fireCount += 1;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(fireCount).toBe(1);
    wd.poke();
    wd.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(fireCount).toBe(1);
  });
});

// ================================================================================================
// Phase 4 Task 8 (rider 20, RULING P4-I companion): pause / resume.
// ================================================================================================
//
// "An outstanding host control request (delivered, not yet answered) is NOT engine inactivity -- the
// 600 s progress clock pauses while one is outstanding, so a human at a child's permission prompt
// never trips it."
describe("pause/resume (rider 20)", () => {
  test("pause() stops the clock: no fire even well past the timeout, and resume() restarts it", async () => {
    let fired = 0;
    const wd = createStallWatchdog(30, () => {
      fired++;
    });
    wd.pause();
    await new Promise((r) => setTimeout(r, 120)); // 4x the timeout, paused
    expect(fired).toBe(0);
    wd.resume();
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toBe(1);
    wd.cancel();
  });

  test("pause is DEPTH-COUNTED: two outstanding requests need two resumes before the clock restarts", async () => {
    let fired = 0;
    const wd = createStallWatchdog(30, () => {
      fired++;
    });
    wd.pause();
    wd.pause();
    wd.resume(); // one answered, one still outstanding
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toBe(0);
    wd.resume(); // the last one answered
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toBe(1);
    wd.cancel();
  });

  test("a poke() while paused never re-arms the timer behind the pause's back", async () => {
    let fired = 0;
    const wd = createStallWatchdog(30, () => {
      fired++;
    });
    wd.pause();
    wd.poke();
    wd.poke();
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toBe(0);
    wd.cancel();
  });

  test("pause()/resume() after cancel() (or after a fire) are silent no-ops -- never a second callback", async () => {
    let fired = 0;
    const wd = createStallWatchdog(20, () => {
      fired++;
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(1);
    wd.pause();
    wd.resume();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(1);
  });
});
