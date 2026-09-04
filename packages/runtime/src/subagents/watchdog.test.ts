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
