// `dangerouslyDisableSandbox` under claude's rule, replacing RULING P3-J (dist-session fixes, lane C C3).
//
// P3-J made every escape MANDATORY INTERACTION ahead of the allow rules, even under bypass, so the
// user's "Allow `Bash(gh repo:*)` everywhere" never cleared `gh repo view … dangerouslyDisableSandbox`.
// The pinned claude 0.3.250 Bash `checkPermissions` runs the ordinary evaluation and escalates an
// escape to an ask ("Run outside of the sandbox", decisionReason sandboxOverride) ONLY when that
// evaluation allowed it by MODE -- not by a rule (`Kit(r.decisionReason)`) -- and only when the flag
// actually takes the command out of a sandbox it would otherwise run in; `sandboxOverride` is not in
// its bypass-immune table, so bypass turns the ask into an allow. Winter mirrors that, with one host
// requirement on top: an escape no allow rule sanctions ALWAYS reaches the host's canUseTool -- in
// auto and plan too, never the classifier -- because the host's own reviewer clears it there.
import { describe, expect, test } from "bun:test";
import type { PermissionMode, PermissionRuleValue } from "@yanlinglabs/winter-agent-sdk";
import {
  evaluate,
  NO_OPINION_HOOK_STAGE,
  REAL_SPECIAL_CHECKS,
  type AutoEngine,
  type EvaluationContext,
  type HookStage,
  type PermissionCall,
  type PromptDecision,
  type PromptStageMeta,
} from "./evaluator.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";

const CWD = "/work/repo";

function rule(raw: string, behavior: "allow" | "deny" | "ask"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, "user");
}

interface Harness {
  ctx: EvaluationContext;
  prompts: Array<{ call: PermissionCall; meta: PromptStageMeta }>;
  classified: PermissionCall[];
}

function harness(mode: PermissionMode, rules: SourcedRuleEntry[], opts: { answer?: PromptDecision | null; escape?: (c: PermissionCall) => boolean; hookStage?: HookStage } = {}): Harness {
  const prompts: Harness["prompts"] = [];
  const classified: PermissionCall[] = [];
  const autoEngine: AutoEngine = {
    async classify(c: PermissionCall) {
      classified.push(c);
      return { verdict: "allow", fallbackToPrompt: false };
    },
  } as unknown as AutoEngine;
  const ctx: EvaluationContext = {
    policy: { mode, version: 0, rules: { ...emptyRuleSet(), entries: rules } },
    cwd: CWD,
    sessionRoot: CWD,
    home: "/synthetic/home/tester",
    trustedWorkspace: false,
    sessionBypassEnabled: mode === "bypassPermissions",
    hookStage: opts.hookStage ?? NO_OPINION_HOOK_STAGE,
    promptStage: {
      async prompt(c, _ctx, meta) {
        prompts.push({ call: c, meta });
        return opts.answer === undefined ? { decision: "allow" } : opts.answer;
      },
    },
    autoEngine,
    specialChecks: REAL_SPECIAL_CHECKS,
    ...(opts.escape !== undefined ? { bashSandboxEscape: opts.escape } : {}),
  };
  return { ctx, prompts, classified };
}

const escape = (command: string): PermissionCall => ({ toolName: "Bash", input: { command, dangerouslyDisableSandbox: true }, toolUseId: "t1" });
const RUN_OUTSIDE = "Run outside of the sandbox";

describe("a matching allow RULE runs an escape with no prompt", () => {
  for (const mode of ["default", "acceptEdits", "dontAsk", "auto", "plan"] as const) {
    test(`mode ${mode}: \`gh repo view\` under Bash(gh repo:*) is allowed by the rule`, async () => {
      const h = harness(mode, [rule("Bash(gh repo:*)", "allow")]);
      const record = await evaluate(escape("gh repo view yanlingLabs/winter"), h.ctx);
      expect(record).toMatchObject({ decision: "allow", mechanism: "rule" });
      expect(h.prompts).toHaveLength(0);
      expect(h.classified).toHaveLength(0);
    });
  }
});

describe("an escape no rule sanctions reaches the host's canUseTool -- never the classifier", () => {
  for (const mode of ["default", "acceptEdits", "auto", "plan"] as const) {
    test(`mode ${mode}: one prompt, reason "${RUN_OUTSIDE}", the classifier untouched`, async () => {
      const h = harness(mode, []);
      const record = await evaluate(escape("curl -s https://example.com"), h.ctx);
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]!.meta.decisionReason).toBe(RUN_OUTSIDE);
      expect(h.prompts[0]!.meta.matchedAskRule).toBeUndefined();
      expect(h.classified).toHaveLength(0);
      expect(record).toMatchObject({ decision: "allow", mechanism: "canUseTool" });
    });
  }

  test("a MODE allow is escalated, not trusted: a read-only `ls` and an acceptEdits in-project mkdir both ask when they escape", async () => {
    const readOnly = harness("default", []);
    await evaluate(escape("ls -la"), readOnly.ctx);
    expect(readOnly.prompts.map((p) => p.meta.decisionReason)).toEqual([RUN_OUTSIDE]);
    const bounded = harness("acceptEdits", []);
    await evaluate(escape("mkdir build"), bounded.ctx);
    expect(bounded.prompts.map((p) => p.meta.decisionReason)).toEqual([RUN_OUTSIDE]);
  });

  test("no answering host fails CLOSED", async () => {
    const h = harness("default", [], { answer: null });
    const record = await evaluate(escape("curl -s https://example.com"), h.ctx);
    expect(record.decision).toBe("deny");
    expect(record.message).toContain("sandbox");
  });
});

describe("bypass, dontAsk, deny rules and hooks", () => {
  test("bypassPermissions: an unsanctioned escape is ALLOWED with no prompt (claude: sandboxOverride is not bypass-immune)", async () => {
    const h = harness("bypassPermissions", []);
    const record = await evaluate(escape("curl -s https://example.com"), h.ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    expect(h.prompts).toHaveLength(0);
  });

  test("dontAsk: an unsanctioned escape is DENIED, no prompt", async () => {
    const h = harness("dontAsk", []);
    const record = await evaluate(escape("curl -s https://example.com"), h.ctx);
    expect(record).toMatchObject({ decision: "deny", mechanism: "mode" });
    expect(record.message).toContain("dangerouslyDisableSandbox");
    expect(h.prompts).toHaveLength(0);
  });

  test("a deny rule still wins outright, under a matching allow rule and in bypass", async () => {
    const h = harness("bypassPermissions", [rule("Bash(curl:*)", "deny"), rule("Bash(curl -s:*)", "allow")]);
    expect(await evaluate(escape("curl -s https://example.com"), h.ctx)).toMatchObject({ decision: "deny", mechanism: "rule" });
  });

  test("a PreToolUse hook's forced ask keeps the HOOK's own reason (P3-J used to overwrite it)", async () => {
    const hookStage: HookStage = { ...NO_OPINION_HOOK_STAGE, async preToolUse() { return { decision: "ask", message: "the security hook wants a look", hookId: "h1" }; } };
    const h = harness("default", [], { hookStage });
    await evaluate(escape("curl -s https://example.com"), h.ctx);
    expect(h.prompts.map((p) => p.meta.decisionReason)).toEqual(["the security hook wants a look"]);
  });

  test("the escape rule does not loosen the write floor: a rule-allowed escape still cannot write a control-plane file, bypass included", async () => {
    const h = harness("bypassPermissions", [rule("Bash(echo:*)", "allow")], { answer: null });
    const record = await evaluate(escape("echo '{}' > .winter/permissions.local.json"), h.ctx);
    expect(record.decision).toBe("deny");
    expect(h.prompts.map((p) => p.meta.decisionReason)).toEqual(["Denied: protected path write requires approval (WS-07 §6.7)"]);
  });
});

describe("a flag that removes no sandbox is not an escape", () => {
  test("when the host says the call would not have been sandboxed anyway (sandbox off, or the policy ignores the flag), `ls` stays a silent read", async () => {
    const h = harness("default", [], { escape: () => false });
    const record = await evaluate(escape("ls -la"), h.ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
    expect(h.prompts).toHaveLength(0);
  });

  test("dangerouslyDisableSandbox: false is no escape at all", async () => {
    const h = harness("default", []);
    const record = await evaluate({ toolName: "Bash", input: { command: "ls", dangerouslyDisableSandbox: false } }, h.ctx);
    expect(record).toMatchObject({ decision: "allow", mechanism: "mode" });
  });
});

describe("a standing exception that also escapes goes to the host -- never the classifier (auto, plan borrow)", () => {
  // A protected write / critical removal under `auto` (and plan's classifier borrow) normally goes to
  // the classifier. With the sandbox off as well, an allowing classifier would have cleared
  // `rm -rf /` to run unsandboxed; the host decides instead.
  const cases: Array<[string, string]> = [
    ["a critical removal", "rm -rf /"],
    ["a protected write", "echo x > .git/config"],
  ];
  for (const [label, command] of cases) {
    test(`auto: ${label} + escape -> one prompt, classifier untouched`, async () => {
      const h = harness("auto", [], { answer: null });
      const record = await evaluate(escape(command), h.ctx);
      expect(h.classified).toHaveLength(0);
      expect(h.prompts).toHaveLength(1);
      expect(record.decision).toBe("deny"); // headless -> fail closed
    });
    test(`plan with the classifier borrow on: ${label} + escape -> one prompt, classifier untouched`, async () => {
      const h = harness("plan", [], { answer: null });
      h.ctx.policy = { ...h.ctx.policy, autoConfig: { ...(h.ctx.policy.autoConfig ?? {}), useAutoModeDuringPlan: true } } as EvaluationContext["policy"];
      const record = await evaluate(escape(command), h.ctx);
      expect(h.classified).toHaveLength(0);
      expect(h.prompts).toHaveLength(1);
      expect(record.decision).toBe("deny");
    });
    test(`auto: ${label} WITHOUT the escape still goes to the classifier (unchanged)`, async () => {
      const h = harness("auto", []);
      await evaluate({ toolName: "Bash", input: { command }, toolUseId: "t2" }, h.ctx);
      expect(h.classified).toHaveLength(1);
    });
  }
});
