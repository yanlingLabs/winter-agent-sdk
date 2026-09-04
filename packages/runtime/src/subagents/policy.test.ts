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

  test("an explicit invocation request wins over the fork-mode default", () => {
    expect(resolveForegroundBackground({ isFork: true, interactiveDefault: true, invocationRequest: false, env: {} }).background).toBe(false);
    expect(resolveForegroundBackground({ isFork: false, invocationRequest: true, env: {} }).background).toBe(true);
  });

  test("with no invocation request and no definition force, resultNeededImmediately decides", () => {
    expect(resolveForegroundBackground({ isFork: false, resultNeededImmediately: true, env: {} })).toEqual({ background: false, reason: "result-needed" });
    expect(resolveForegroundBackground({ isFork: false, resultNeededImmediately: false, env: {} })).toEqual({ background: true, reason: "result-needed" });
  });

  test("fork mode's own base default applies only once every later stage is silent", () => {
    expect(resolveForegroundBackground({ isFork: true, interactiveDefault: true, env: {} })).toEqual({ background: true, reason: "fork mode default" });
    expect(resolveForegroundBackground({ isFork: true, interactiveDefault: false, env: {} })).toEqual({ background: false, reason: "fork mode default" });
  });

  test("the SDK (non-fork) default with nothing else specified is foreground -- never a hardcoded independent default", () => {
    expect(resolveForegroundBackground({ isFork: false, env: {} })).toEqual({ background: false, reason: "SDK default (foreground)" });
  });

  test("a fork with no interactiveDefault set behaves like the SDK default (off)", () => {
    expect(resolveForegroundBackground({ isFork: true, env: {} }).background).toBe(false);
  });
});
