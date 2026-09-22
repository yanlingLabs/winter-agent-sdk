// The Bash WRITE-TARGET floor (dist-session fixes, lane C C3 prerequisites 1+2) -- mirroring claude's
// path validation for a shell command's write targets (tools/BashTool/pathValidation.ts's
// checkPathConstraints -> validatePath -> checkPathSafetyForAutoEdit, run BEFORE the allow rules):
//
//   - a target on the protected set -- the SDK's own (dot-dirs, VCS/editor dirs, shell rc files,
//     lockfiles), the resolved winter home wholesale, and the three control-plane filenames at any
//     depth -- is never auto-approved: no allow rule clears it and, for a SHELL write, not bypass
//     either (claude's safety check is bypass-immune);
//   - a target a host's Edit/Write/Read deny rule names is DENIED (already true; pinned here);
//   - an allow RULE does not clear a write outside the session's working directories, nor a
//     compound command that changes directory before writing -- those ask, as claude's do.
//
// Until now the Seatbelt was the only floor for a shell write to these paths, and an escape
// (`dangerouslyDisableSandbox`) removes the Seatbelt.
import { describe, expect, test } from "bun:test";
import type { PermissionMode, PermissionRuleValue } from "@yanlinglabs/winter-agent-sdk";
import {
  evaluate,
  NO_OPINION_AUTO_ENGINE,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  REAL_SPECIAL_CHECKS,
  type EvaluationContext,
  type PermissionCall,
  type PromptDecision,
  type PromptStageMeta,
} from "./evaluator.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";

const HOME = "/synthetic/home/tester";
const CWD = "/work/repo";

function rule(raw: string, behavior: "allow" | "deny" | "ask"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, "userSettings");
}

function ctxWith(mode: PermissionMode, rules: SourcedRuleEntry[], extra: Partial<EvaluationContext> = {}): { ctx: EvaluationContext; prompts: Array<{ call: PermissionCall; meta: PromptStageMeta }> } {
  const prompts: Array<{ call: PermissionCall; meta: PromptStageMeta }> = [];
  const ctx: EvaluationContext = {
    policy: { mode, version: 0, rules: { ...emptyRuleSet(), entries: rules } },
    cwd: CWD,
    sessionRoot: CWD,
    home: HOME,
    trustedWorkspace: false,
    sessionBypassEnabled: mode === "bypassPermissions",
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: {
      async prompt(c, _ctx, meta): Promise<PromptDecision | null> {
        prompts.push({ call: c, meta });
        return null; // headless: whatever needs a person fails closed
      },
    },
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: REAL_SPECIAL_CHECKS,
    ...extra,
  };
  return { ctx, prompts };
}

const bash = (command: string): PermissionCall => ({ toolName: "Bash", input: { command }, toolUseId: "t1" });

describe("protected shell write targets: no allow rule and no bypass clears them", () => {
  const cases: Array<[string, string]> = [
    ["a project control-plane file via redirect", "echo '{}' > .winter/permissions.local.json"],
    ["a project settings file via cp", "cp /tmp/x .winter/settings.local.json"],
    ["the winter home's runtimes via cp", `cp /tmp/evil ${HOME}/.winter/runtimes/bin/winter`],
    ["the winter home's run dir via redirect", `echo x > ${HOME}/.winter/run/core.sock`],
    ["a control-plane filename reached through a cd (any depth, any directory)", "cd .winter && echo '{}' > permissions.local.json"],
    ["a settings.json at any depth", "echo '{}' > config/nested/settings.json"],
    [".git via redirect", "echo x > .git/config"],
  ];
  for (const [label, command] of cases) {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      test(`${label} -- mode ${mode}, with a matching allow rule: never allowed without a person`, async () => {
        const { ctx, prompts } = ctxWith(mode, [rule("Bash(echo:*)", "allow"), rule("Bash(cp:*)", "allow"), rule("Bash(cd:*)", "allow")]);
        const record = await evaluate(bash(command), ctx);
        expect(record.decision).toBe("deny"); // headless prompt stage -> fail closed
        expect(prompts).toHaveLength(1); // it was put to a person -- under bypass too
        expect(prompts[0]!.meta.decisionReason).toContain("protected path write");
      });
    }
  }

  test("a CUSTOM winter home (no `.winter` segment anywhere) is protected wholesale", async () => {
    const { ctx, prompts } = ctxWith("bypassPermissions", [rule("Bash(cp:*)", "allow")], { winterHome: "/srv/winter-home" });
    const record = await evaluate(bash("cp /tmp/evil /srv/winter-home/runtimes/bin/winter"), ctx);
    expect(record.decision).toBe("deny");
    expect(prompts).toHaveLength(1);
  });

  test("the carve-outs inside the winter home stay writable (auto-memory)", async () => {
    const { ctx } = ctxWith("bypassPermissions", [], { winterHome: "/srv/winter-home" });
    const record = await evaluate(bash("echo note >> /srv/winter-home/projects/-work-repo/memory/MEMORY.md"), ctx);
    expect(record.decision).toBe("allow");
  });

  test("an ordinary in-project write under bypass is still allowed (only the floor changed)", async () => {
    const { ctx, prompts } = ctxWith("bypassPermissions", []);
    const record = await evaluate(bash("echo hi > notes.txt"), ctx);
    expect(record.decision).toBe("allow");
    expect(prompts).toHaveLength(0);
  });

  test("scope: the Edit TOOL's protected write under bypass is unchanged (WS-07 §6.7 allow) -- the host's deny rules are its floor", async () => {
    const { ctx } = ctxWith("bypassPermissions", []);
    const record = await evaluate({ toolName: "Edit", input: { file_path: `${CWD}/.git/config`, old_string: "a", new_string: "b" } }, ctx);
    expect(record.decision).toBe("allow");
  });
});

describe("a host's Edit/Write deny rule reaches a shell command's write targets", () => {
  for (const denyRule of ["Write(**/secrets/**)", "Edit(**/secrets/**)"]) {
    for (const command of ["echo token > secrets/api.txt", "cp /tmp/x secrets/api.txt"]) {
      test(`${denyRule} denies \`${command}\` outright -- even under bypass and with a matching allow rule`, async () => {
        const { ctx, prompts } = ctxWith("bypassPermissions", [rule(denyRule, "deny"), rule("Bash(echo:*)", "allow"), rule("Bash(cp:*)", "allow")]);
        const record = await evaluate(bash(command), ctx);
        expect(record).toMatchObject({ decision: "deny", mechanism: "rule" });
        expect(prompts).toHaveLength(0);
      });
    }
  }
});

describe("an allow RULE does not clear a write outside the working directories, or after a cd", () => {
  test("`echo x > /tmp/out.txt` with Bash(echo:*) allowed: asks (claude: outside the allowed working directories)", async () => {
    const { ctx, prompts } = ctxWith("default", [rule("Bash(echo:*)", "allow")]);
    const record = await evaluate(bash("echo x > /tmp/out.txt"), ctx);
    expect(record.decision).toBe("deny"); // headless
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.meta.decisionReason).toContain("/tmp/out.txt");
  });

  test("`cd sub && echo x > f` with the rules allowed: asks (the target cannot be resolved against the cwd)", async () => {
    const { ctx, prompts } = ctxWith("default", [rule("Bash(echo:*)", "allow"), rule("Bash(cd:*)", "allow")]);
    const record = await evaluate(bash("cd sub && echo x > f"), ctx);
    expect(record.decision).toBe("deny");
    expect(prompts).toHaveLength(1);
  });

  test("inside the working directory, and to /dev/null, the rule still allows with no prompt", async () => {
    const { ctx, prompts } = ctxWith("default", [rule("Bash(echo:*)", "allow")]);
    expect((await evaluate(bash("echo x > build/out.txt"), ctx)).decision).toBe("allow");
    expect((await evaluate(bash("echo x > /dev/null"), ctx)).decision).toBe("allow");
    expect(prompts).toHaveLength(0);
  });

  test("bypass allows the outside-the-working-directories write (claude: not a bypass-immune reason)", async () => {
    const { ctx, prompts } = ctxWith("bypassPermissions", [rule("Bash(echo:*)", "allow")]);
    expect((await evaluate(bash("echo x > /tmp/out.txt"), ctx)).decision).toBe("allow");
    expect(prompts).toHaveLength(0);
  });
});
