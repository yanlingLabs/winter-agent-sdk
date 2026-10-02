// A redirection GLUED to a wrapper's word -- its duration, a flag, an assignment value -- is still a
// redirection to bash: `timeout x>.git/config` writes `.git/config` even though `x` is no duration and
// `timeout` may not be installed. `stripWrappers` consumes such a word whole, so it carries the
// redirection over onto the end of the command it returns, and every write floor sees it.
//
// And an allow rule never covers a command whose wrapper is spelled so that only the backslash-dropping
// reading names it (`"\timeout" …`): bash runs a program called `\timeout`, not the one the rule's text
// suggests.
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
} from "./evaluator.ts";
import { extractRedirectTargets, isRecognizedReadOnly, matchesRule, parseRule, stripWrappers } from "./grammar.ts";
import { recognizeEditOperation } from "./edit-recognition.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";

const HOME = "/synthetic/home/tester";
const CWD = "/work/repo";

function rule(raw: string, behavior: "allow" | "deny" | "ask"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, "user");
}

async function decide(command: string, mode: PermissionMode, rules: SourcedRuleEntry[]): Promise<{ decision: string; prompted: number }> {
  let prompted = 0;
  const ctx: EvaluationContext = {
    policy: { mode, version: 0, rules: { ...emptyRuleSet(), entries: rules } },
    cwd: CWD,
    sessionRoot: CWD,
    home: HOME,
    trustedWorkspace: false,
    sessionBypassEnabled: mode === "bypassPermissions",
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: {
      async prompt(): Promise<PromptDecision | null> {
        prompted++;
        return null; // headless: whatever needs a person fails closed
      },
    },
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: REAL_SPECIAL_CHECKS,
  };
  const call: PermissionCall = { toolName: "Bash", input: { command }, toolUseId: "t1" };
  return { decision: (await evaluate(call, ctx)).decision, prompted };
}

/** The reviewer's commands: each writes a protected file through a redirection glued to a wrapper's word. */
const GLUED_PROTECTED_WRITES = [
  "timeout x>.git/config",
  "timeout x>~/.bashrc",
  "timeout x>.winter/settings.json",
  "timeout x>|.git/config",
  "timeout x&>.git/config",
  "timeout 5>.git/config",
  "nice -n5>.git/config",
  "timeout -k1>.git/config 5 ls",
  "time -p>.git/config ls",
  // the same shape on every other wrapper, an assignment, and xargs
  "nohup -x>.git/config ls",
  "stdbuf -o0>.git/config ls",
  "command -p>.git/config ls",
  "builtin -x>.git/config ls",
  "noglob -x>.git/config ls",
  "A=1>.git/config ls",
  "A=x B=1>>.git/config ls",
  "timeout -s KILL x>.git/config",
  "timeout x> .git/config",
  "timeout x>>.git/config",
  "timeout x<>.git/config",
  "timeout x2>.git/config",
];

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

describe("a redirection glued to a wrapper's word is a write the floors see", () => {
  for (const command of GLUED_PROTECTED_WRITES) {
    test(`${JSON.stringify(command)}: recognized as a write`, () => {
      const write = recognizeEditOperation({ toolName: "Bash", input: { command } }, { sessionRoot: CWD, home: HOME });
      expect(write).not.toBeNull();
      expect(write!.paths.length).toBeGreaterThan(0);
    });
    for (const mode of MODES) {
      for (const withAllowAll of [false, true]) {
        test(`${JSON.stringify(command)} -- mode ${mode}${withAllowAll ? ", allow Bash(*)" : ""}: never allowed without a person`, async () => {
          const { decision, prompted } = await decide(command, mode, withAllowAll ? [rule("Bash(*)", "allow")] : []);
          expect(decision).not.toBe("allow");
          if (mode !== "plan") expect(prompted).toBeGreaterThan(0);
        });
      }
    }
  }

  test("plan mode with an allow Bash(*) does not run a glued write to an ordinary file either", async () => {
    for (const command of ["timeout x>important.txt", "timeout x>>important.txt", "nice -n x>important.txt"]) {
      expect((await decide(command, "plan", [rule("Bash(*)", "allow")])).decision).not.toBe("allow");
    }
  });
});

describe("stripWrappers carries glued redirections over", () => {
  const cases: Array<[string, string]> = [
    ["timeout x>.git/config", ">.git/config"],
    ["timeout 5>.git/config", "5>.git/config"],
    ["nice -n5>.git/config", "5>.git/config"],
    ["timeout -k1>.git/config 5 ls", "ls 1>.git/config"],
    ["time -p>.git/config ls", "ls >.git/config"],
    ["A=1>f ls", "ls 1>f"],
    ["timeout x> .git/config", ".git/config > .git/config"],
    // nothing glued: unchanged
    ["timeout 5 ls > f", "ls > f"],
    ["ls >f", "ls >f"],
    ["timeout 5 ls", "ls"],
  ];
  for (const [command, stripped] of cases) {
    test(JSON.stringify(command), () => {
      expect(stripWrappers(command, "denyAsk")).toBe(stripped);
      expect(stripWrappers(command, "allow")).toBe(stripped);
    });
  }

  test("every glued target survives into the stripped text", () => {
    for (const command of GLUED_PROTECTED_WRITES) {
      const targets = extractRedirectTargets(command);
      const fromStripped = extractRedirectTargets(stripWrappers(command, "denyAsk"));
      for (const target of targets) expect(fromStripped).toContain(target);
    }
  });

  test("a glued redirection stops the inner command from counting as recognized read-only", () => {
    expect(isRecognizedReadOnly("timeout -k1>.git/config 5 ls")).toBe(false);
    expect(isRecognizedReadOnly("time -p>x ls")).toBe(false);
    expect(isRecognizedReadOnly("timeout 5 ls")).toBe(true);
  });

  test("a deny/ask rule still matches the command it matched before (carried redirections aside)", () => {
    const bash = (command: string) => ({ toolName: "Bash", input: { command } });
    expect(matchesRule(parseRule("Bash(ls)"), bash("timeout -k1>f 5 ls"), { direction: "denyAsk" })).toBe(true);
    expect(matchesRule(parseRule("Bash(rm -rf x)"), bash("A=1>f rm -rf x"), { direction: "denyAsk" })).toBe(true);
    // an ALLOW matches the looked-through command only -- never text from a carried redirection
    expect(matchesRule(parseRule("Bash(ls)"), bash("timeout -k1>f 5 ls"), { direction: "allow" })).toBe(true);
    expect(matchesRule(parseRule("Bash(ls:*)"), bash("timeout 5 ls"), { direction: "allow" })).toBe(true);
    expect(matchesRule(parseRule("Bash(*push*)"), bash("timeout x<>push ls"), { direction: "allow" })).toBe(false);
    expect(matchesRule(parseRule("Bash(*-delete*)"), bash("timeout cd>&-delete<>push tee"), { direction: "allow" })).toBe(false);
    expect(matchesRule(parseRule("Bash(* x)"), bash("timeout x<> x"), { direction: "allow" })).toBe(false);
  });
});

describe("an allow glob is never satisfied by a carried redirection's target", () => {
  // Each target spells what an allow glob looks for (`push`, `-rf`, `-delete`, ` x`, `timeout`); the
  // command itself (`tee`, `ls`, `cat`, nothing) does not.
  const GLOBS = ["Bash(*timeout*)", "Bash(*nice*)", "Bash(*rm*)", "Bash(* x)", "Bash(*-rf*)", "Bash(*.git/config)", "Bash(*settings.json)", "Bash(*push*)", "Bash(*-delete*)"];
  const B = "\\";
  const commands = [
    `timeout cd>&-delete<>push "${B}tee"`,
    "timeout cd>&-delete<>push tee",
    `timeout x<>push "${B}tee"`,
    `timeout x>>push "${B}cat"`,
    `timeout x>&-rf "${B}tee"`,
    `timeout -k1>timeout 5 "${B}ls"`,
    "timeout x<> x",
    "timeout x>&-push",
    "timeout x<>push",
    "nice -n5<>push tee",
    "A=1>&-rf tee",
    "timeout x>rm cat",
  ];
  for (const command of commands) {
    // (Under bypass an ordinary write inside the working directory is allowed by design, as before.)
    for (const mode of ["default", "acceptEdits", "dontAsk", "plan"] as PermissionMode[]) {
      test(`${JSON.stringify(command)} -- mode ${mode}, allow globs: not allowed`, async () => {
        const { decision } = await decide(command, mode, GLOBS.map((g) => rule(g, "allow")));
        expect(decision).not.toBe("allow");
      });
    }
  }
});

describe("an allow rule never covers a wrapper only the backslash-dropping reading names", () => {
  const cases: Array<[string, string]> = [
    ["*timeout*", '"\\timeout" x > important.txt'],
    ["*timeout*", '"\\timeout" x > /etc/hosts'],
    ["*timeout*", '"\\timeout" x > .git/config'],
    ["*timeout*", '"\\timeout" x > ~/.bashrc'],
    ["*push*", '"ti\\meout" "\\push">>rm'],
    ["*push*", '"ti\\meout" push>>rm'],
    ["*push*", '"ti\\meout" push > rm'],
    ["ls:*", '"\\timeout" 5 ls'],
    ["*nice*", '"\\nice" ls'],
    ["*xargs*", '"\\xargs" ls'],
  ];
  for (const [allow, command] of cases) {
    for (const mode of ["default", "plan", "dontAsk", "acceptEdits"] as PermissionMode[]) {
      test(`Bash(${allow}) + ${JSON.stringify(command)} -- mode ${mode}: not allowed`, async () => {
        expect((await decide(command, mode, [rule(`Bash(${allow})`, "allow")])).decision).not.toBe("allow");
      });
    }
    test(`Bash(${allow}) does not match ${JSON.stringify(command)} as an allow`, () => {
      expect(matchesRule(parseRule(`Bash(${allow})`), { toolName: "Bash", input: { command } }, { direction: "allow" })).toBe(false);
    });
  }
  test("a deny/ask rule still looks through the same spelling", () => {
    expect(matchesRule(parseRule("Bash(rm:*)"), { toolName: "Bash", input: { command: '"\\timeout" 5 rm -rf x' } }, { direction: "denyAsk" })).toBe(true);
  });
});
