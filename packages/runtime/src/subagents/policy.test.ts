import { describe, test, expect } from "bun:test";
import { resolveForegroundBackground } from "./policy.ts";

describe("resolveForegroundBackground (WS-10 §5)", () => {
  test("WINTER_DISABLE_BACKGROUND_TASKS forces foreground no matter what else is set", () => {
    const decision = resolveForegroundBackground({
      isFork: false,
      invocationRequest: true,
      definitionBackground: true,
      env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" },
    });
    expect(decision).toEqual({ background: false, reason: "WINTER_DISABLE_BACKGROUND_TASKS" });
  });

  test("WINTER_DISABLE_BACKGROUND_TASKS=true (word form) also disables", () => {
    expect(resolveForegroundBackground({ isFork: false, invocationRequest: true, env: { WINTER_DISABLE_BACKGROUND_TASKS: "true" } }).background).toBe(false);
  });

  test("AgentDefinition.background:true forces background, overriding an explicit invocation false", () => {
    const decision = resolveForegroundBackground({ isFork: false, invocationRequest: false, definitionBackground: true, env: {} });
    expect(decision).toEqual({ background: true, reason: "AgentDefinition.background" });
  });

  test("an explicit invocation request decides an ordinary spawn, either way", () => {
    expect(resolveForegroundBackground({ isFork: false, invocationRequest: false, env: {} })).toEqual({ background: false, reason: "invocation run_in_background" });
    expect(resolveForegroundBackground({ isFork: false, invocationRequest: true, env: {} })).toEqual({ background: true, reason: "invocation run_in_background" });
  });

  test("with no invocation request and no definition force, resultNeededImmediately decides", () => {
    expect(resolveForegroundBackground({ isFork: false, resultNeededImmediately: true, env: {} })).toEqual({ background: false, reason: "result-needed" });
    expect(resolveForegroundBackground({ isFork: false, resultNeededImmediately: false, env: {} })).toEqual({ background: true, reason: "result-needed" });
  });

  // SDK 0.0.16 Lane N: BACKGROUND is the default, and a FORK is always background -- claude's own
  // ranking ("background unless run_in_background is explicitly false"; its fork definition forces it).
  test("a FORK is always background -- it outranks even an explicit run_in_background:false", () => {
    expect(resolveForegroundBackground({ isFork: true, env: {} })).toEqual({ background: true, reason: "fork" });
    expect(resolveForegroundBackground({ isFork: true, invocationRequest: false, env: {} })).toEqual({ background: true, reason: "fork" });
  });

  test("with nothing specified at all the default is BACKGROUND (SDK 0.0.16, as in claude)", () => {
    expect(resolveForegroundBackground({ isFork: false, env: {} })).toEqual({ background: true, reason: "SDK default (background)" });
  });

  test("the host kill switch still wins over everything, including a fork", () => {
    expect(resolveForegroundBackground({ isFork: true, env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" } })).toEqual({ background: false, reason: "WINTER_DISABLE_BACKGROUND_TASKS" });
    expect(resolveForegroundBackground({ isFork: false, definitionBackground: true, env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" } }).background).toBe(false);
  });
});
