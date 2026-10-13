import { expect, test } from "bun:test";
import { evaluate, REAL_SPECIAL_CHECKS, NO_OPINION_HOOK_STAGE, NO_OPINION_PROMPT_STAGE, type EvaluationContext } from "../permissions/evaluator.ts";
import { emptyRuleSet, buildSdkSourcedEntries } from "../permissions/ruleset.ts";
import { createAutoEngine } from "../permissions/auto/engine.ts";
import { FRESH_LINUX_TOOLS } from "./linux-session-admission.ts";

const command = "test ! -e /workspace/.winter/conversations && printf shell > from-shell";
function fixturePolicy(mode: "default" | "auto", disallowedTools: string[] = []) {
  const audit: Array<{ type: string; reasonCode?: string }> = [];
  const context: EvaluationContext = {
    policy: { mode, version: 0, rules: { ...emptyRuleSet(), entries: buildSdkSourcedEntries({ allowedTools: [...FRESH_LINUX_TOOLS], disallowedTools }) } },
    cwd: "/workspace/folders/source", sessionRoot: "/workspace/folders/source",
    home: "/run/winter/conversations/logical", winterHome: "/run/winter/conversations/logical",
    storeHome: "/workspace/.winter/conversations/logical", trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE, promptStage: NO_OPINION_PROMPT_STAGE, specialChecks: REAL_SPECIAL_CHECKS,
    autoEngine: createAutoEngine({ sessionId: "fixture-backend", audit: { record(event) { audit.push(event); } } }),
  };
  return { context, audit };
}

test("Root fixture grants execute the original compound command without a model classifier", async () => {
  const { context, audit } = fixturePolicy("default");
  const decision = await evaluate({ toolName: "Bash", input: { command, timeout: 5000 } }, context);
  expect(decision.decision).toBe("allow");
  expect(decision.mechanism).toBe("rule");
  expect(audit.some(event => event.type === "classifier_started")).toBe(false);
});

test("SDK Auto still refuses the same broad fixture grant without an eligible classifier", async () => {
  const { context, audit } = fixturePolicy("auto");
  const decision = await evaluate({ toolName: "Bash", input: { command, timeout: 5000 } }, context);
  expect(decision.decision).toBe("deny");
  expect(decision.mechanism).toBe("autoEngine");
  expect(audit.some(event => event.reasonCode === "p2_no_real_classifier")).toBe(true);
});

test("fixture preauthorization preserves protected-store writes and explicit denies", async () => {
  const protectedPolicy = fixturePolicy("default");
  expect((await evaluate({ toolName: "Bash", input: { command: "printf shell > /workspace/.winter/conversations/logical/forbidden" } }, protectedPolicy.context)).decision).not.toBe("allow");
  const deniedPolicy = fixturePolicy("default", ["Bash"]);
  expect((await evaluate({ toolName: "Bash", input: { command } }, deniedPolicy.context)).decision).toBe("deny");
});
