import { describe, test, expect } from "bun:test";
import { resolveForegroundBackground, resolveBackgroundByDefaultEnabled } from "./policy.ts";

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

// I4 (fix wave): a programmatic opt-out of the 0.0.16 background default, WITHOUT touching the
// WINTER_DISABLE_BACKGROUND_TASKS kill switch's own, unrelated meaning (it still removes
// `run_in_background` from the advertised schema entirely; this knob never does).
describe("resolveBackgroundByDefaultEnabled (I4, fix wave)", () => {
  test("absent-and-unset keeps the 0.0.16 default: background", () => {
    expect(resolveBackgroundByDefaultEnabled({})).toBe(true);
  });

  test("a falsy env value ('0'/'false'/'no'/'off', any case) restores the 0.0.15 default: foreground", () => {
    for (const v of ["0", "false", "FALSE", "no", "off", " off "]) {
      expect(resolveBackgroundByDefaultEnabled({ WINTER_BACKGROUND_BY_DEFAULT: v })).toBe(false);
    }
  });

  test("any other env value (including the literal word 'true') keeps the default: background", () => {
    expect(resolveBackgroundByDefaultEnabled({ WINTER_BACKGROUND_BY_DEFAULT: "true" })).toBe(true);
    expect(resolveBackgroundByDefaultEnabled({ WINTER_BACKGROUND_BY_DEFAULT: "1" })).toBe(true);
  });
});

describe("resolveForegroundBackground: the I4 knob at stage 5", () => {
  test("backgroundByDefault: false restores foreground for an ordinary, unflagged spawn", () => {
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: false, env: {} })).toEqual({ background: false, reason: "WINTER_BACKGROUND_BY_DEFAULT" });
  });

  test("backgroundByDefault: false is ITSELF outranked by every real override above it", () => {
    // A definition force, a fork, and the invocation's own explicit request all still win outright.
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: false, definitionBackground: true, env: {} }).background).toBe(true);
    expect(resolveForegroundBackground({ isFork: true, backgroundByDefault: false, env: {} }).background).toBe(true);
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: false, invocationRequest: true, env: {} }).background).toBe(true);
  });

  test("the env fallback is consulted only when the field itself is not given", () => {
    expect(resolveForegroundBackground({ isFork: false, env: { WINTER_BACKGROUND_BY_DEFAULT: "off" } }).background).toBe(false);
    // The RuntimeConfig-equivalent field wins over the env either way, exactly like forkSubagent.
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: true, env: { WINTER_BACKGROUND_BY_DEFAULT: "off" } }).background).toBe(true);
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: false, env: { WINTER_BACKGROUND_BY_DEFAULT: "true" } }).background).toBe(false);
  });

  test("interaction with the env kill switch: the kill switch wins regardless of the I4 knob, in either direction", () => {
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: true, env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" } })).toEqual({ background: false, reason: "WINTER_DISABLE_BACKGROUND_TASKS" });
    expect(resolveForegroundBackground({ isFork: false, backgroundByDefault: false, env: { WINTER_DISABLE_BACKGROUND_TASKS: "1" } })).toEqual({ background: false, reason: "WINTER_DISABLE_BACKGROUND_TASKS" });
  });
});
