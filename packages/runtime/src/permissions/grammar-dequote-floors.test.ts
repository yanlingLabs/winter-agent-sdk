// The permission layer must stay at least as strict as it was before `dequoteShellWord` learned bash's
// exact double-quote rule (a backslash inside "…" is kept unless it escapes `$`, `` ` ``, `"`, `\` or a
// newline). Bash runs `"\-o"` as the literal word `\-o` and writes `"\.git/config"` to a directory named
// `\.git`, so the exact reading alone would stop a deny rule or a write floor that used to fire on those
// spellings. Every command below was caught before the change; each must still be caught after it.
import { describe, expect, test } from "bun:test";
import type { PermissionMode, PermissionRuleValue } from "@yanlinglabs/winter-agent-sdk";
import {
  evaluate,
  NO_OPINION_AUTO_ENGINE,
  NO_OPINION_HOOK_STAGE,
  REAL_SPECIAL_CHECKS,
  type EvaluationContext,
  type PermissionCall,
  type PromptDecision,
  type PromptStageMeta,
} from "./evaluator.ts";
import { dequoteShellWord, extractRedirectTargets, extractRedirectWrites, shellWords, stripWrappers } from "./grammar.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";

const HOME = "/synthetic/home/tester";
const CWD = "/work/repo";

function rule(raw: string, behavior: "allow" | "deny" | "ask"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, "user");
}

function ctxWith(mode: PermissionMode, rules: SourcedRuleEntry[]): { ctx: EvaluationContext; prompts: Array<{ call: PermissionCall; meta: PromptStageMeta }> } {
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
  };
  return { ctx, prompts };
}

const bash = (command: string): PermissionCall => ({ toolName: "Bash", input: { command }, toolUseId: "t1" });

const ALLOW_EVERYTHING_SHELL = ["echo", "cp", "cd", "tee", "touch", "sort", "rm", "timeout"].map((verb) => rule(`Bash(${verb}:*)`, "allow"));

describe("protected write floors still see a backslash-in-double-quotes spelling", () => {
  const cases: string[] = [
    'echo x > "\\.git/config"',
    'echo x > ".\\git/config"',
    'echo x >> "\\.winter/settings.local.json"',
    'cp /tmp/x "\\.winter/settings.local.json"',
    'echo x | tee "\\.git/config"',
    'touch "\\.git/hooks/pre-commit"',
  ];
  for (const command of cases) {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      test(`${JSON.stringify(command)} -- mode ${mode}: never allowed without a person`, async () => {
        const { ctx, prompts } = ctxWith(mode, ALLOW_EVERYTHING_SHELL);
        const record = await evaluate(bash(command), ctx);
        expect(record.decision).toBe("deny");
        expect(prompts.length).toBeGreaterThan(0);
      });
    }
  }

  // A command bash runs but the scanner cannot parse (the `)` of a `case` arm, an unterminated quote) is
  // read naively by edit-recognition.ts's `naiveWriteWords`, which judges every reading of each redirect
  // target (`shellWordReadings`): bash's own (`\.git/config`) and the backslash-dropping one
  // (`.git/config`). Under every mode, bypass included, the protected floor still fires.
  const unparseable = [
    'case a in a) echo x > "\\.git/config";; esac',
    'case a in a) echo x >> ".\\git/config";; esac',
    'case a in a) echo x > "\\.winter/settings.local.json";; esac',
    'case a in a) echo x 2> "\\.git/hooks/pre-commit";; esac',
    "echo x > \"\\.git/config\" '",
    'case a in a) echo x > ".git/config";; esac',
    "case a in a) echo x > .\\git/config;; esac",
  ];
  for (const command of unparseable) {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      test(`unparseable ${JSON.stringify(command)} -- mode ${mode}: never allowed without a person`, async () => {
        const { ctx, prompts } = ctxWith(mode, ALLOW_EVERYTHING_SHELL);
        expect((await evaluate(bash(command), ctx)).decision).toBe("deny");
        expect(prompts.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("deny rules still match a flag disguised as a backslash in double quotes", () => {
  const cases: Array<[string, string]> = [
    ["Bash(sort -o:*)", 'sort "\\-o" out in'],
    ["Bash(sort -o:*)", "sort \"\\-\"o out in"],
    ["Bash(find:*)", '"\\find" . -delete'],
    ["Bash(rm:*)", '"\\rm" -rf x'],
    ["Bash(rm:*)", 'timeout 5 "\\rm" -rf x'],
    ["Bash(rm:*)", '"\\timeout" 5 rm -rf x'],
    ["Bash(git push:*)", 'git "\\push" origin'],
  ];
  for (const [deny, command] of cases) {
    for (const mode of ["default", "bypassPermissions"] as const) {
      test(`${deny} denies ${JSON.stringify(command)} -- mode ${mode}`, async () => {
        const { ctx } = ctxWith(mode, [rule(deny, "deny"), ...ALLOW_EVERYTHING_SHELL]);
        const record = await evaluate(bash(command), ctx);
        expect(record.decision).toBe("deny");
      });
    }
  }
});

describe("grammar helpers keep the broader reading where the permission layer needs it", () => {
  test("a redirect target is reported in bash's reading AND the backslash-dropping one", () => {
    expect(extractRedirectTargets('echo x > "\\.git/config"')).toEqual(["\\.git/config", ".git/config"]);
    expect(extractRedirectWrites('echo x > "a\\b"').map((w) => w.target)).toEqual(["a\\b", "ab"]);
    expect(extractRedirectTargets("echo x > 'a\\b'")).toEqual(["a\\b"]);
    expect(extractRedirectTargets("echo x > a\\b")).toEqual(["ab"]);
    expect(extractRedirectTargets('echo x > "a\\$b"')).toEqual(["a$b"]);
  });

  test("a descriptor copy is skipped only when bash reads a descriptor", () => {
    expect(extractRedirectTargets("ls >&2")).toEqual([]);
    expect(extractRedirectTargets('ls >&"2"')).toEqual([]);
    expect(extractRedirectTargets('ls >&"\\2"')).toEqual(["\\2", "2"]);
  });

  test("denyAsk wrapper stripping looks through a wrapper in either reading; allow only in bash's", () => {
    expect(stripWrappers('"\\timeout" 5 rm -rf x', "denyAsk")).toBe("rm -rf x");
    expect(stripWrappers('"\\timeout" 5 ls', "allow")).toBe('"\\timeout" 5 ls');
    expect(stripWrappers("'timeout' 5 ls", "allow")).toBe("ls");
    expect(stripWrappers('"\\xargs" rm x', "denyAsk")).toBe("rm x");
  });

  test("shellWords keeps the broad reading by default and offers bash's on request", () => {
    expect(shellWords('sort "\\-o" x').map((w) => w.word)).toEqual(["sort", "-o", "x"]);
    expect(shellWords('sort "\\-o" x', true, "bash").map((w) => w.word)).toEqual(["sort", "\\-o", "x"]);
    expect(dequoteShellWord('"\\-o"')).toBe("\\-o");
  });
});
