// Whole-branch review M13 (fix wave, follow-up item 7): `~/.winter/projects/**` is READ-ONLY to the
// model, under every mode including `bypassPermissions`.
//
// The finding: `permissions/protected.ts` protects `.winter/**` writes, but `resolveProtectedWrite`
// returns `allow` under `bypassPermissions` (WS-07 §6.7's matrix, verbatim), and WS-07 §11 FORCES
// bypass on every descendant of a bypass parent. So a forced-bypass child could rewrite the very
// JSONL transcript its own `resume()` rebuilds from -- injecting turns into durable history -- and
// `tools/impl/agent.ts`'s `.output` stub hands the model that exact absolute path with "Read that
// file directly". A `managed` deny binds where the protected-write check does not, because stage 2's
// deny lookup runs before stage 4's bypass auto-allow.
//
// Every fixture drives the REAL six-stage `evaluate()` against the REAL production rule list
// (`buildBaselineDenyRules`, imported from engine.ts -- never a re-typed copy, which would let the
// test agree with itself while production drifted) under a SYNTHETIC home. Nothing here touches a
// real `~/.winter`, and no file is written anywhere.
import { describe, test, expect } from "bun:test";
import { buildBaselineDenyRules } from "../engine.ts";
import {
  evaluate,
  REAL_SPECIAL_CHECKS,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  type EvaluationContext,
  type PermissionCall,
} from "./evaluator.ts";
import { emptyRuleSet } from "./ruleset.ts";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";

const HOME = "/synthetic/home/tester";
const CWD = "/synthetic/workspace";
// The three durable shapes M13 names, verbatim from `agent.ts`'s own `.output` stub and the store's
// own layout: a child transcript, its roster sidecar, and the session's own JSONL.
const TRANSCRIPT = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/subagents/agent-abc.jsonl`;
const SIDECAR = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/subagents/agent-abc.meta.json`;
const SESSION_JSONL = `${HOME}/.winter/projects/-synthetic-workspace/sess-1.jsonl`;

function ctxFor(mode: PermissionMode): EvaluationContext {
  return {
    policy: { mode, rules: { ...emptyRuleSet(), entries: buildBaselineDenyRules() }, version: 1 },
    cwd: CWD,
    sessionRoot: CWD,
    home: HOME,
    trustedWorkspace: false,
    sessionBypassEnabled: mode === "bypassPermissions",
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: REAL_SPECIAL_CHECKS,
    requiresInteraction: () => false,
  };
}

async function decide(call: PermissionCall, mode: PermissionMode = "bypassPermissions"): Promise<{ decision: string; mechanism: string; message?: string }> {
  const record = await evaluate(call, ctxFor(mode));
  return { decision: record.decision, mechanism: record.mechanism, ...(record.message !== undefined ? { message: record.message } : {}) };
}

// "No BASELINE RULE denies this" -- deliberately not "the call is allowed". These fixtures use
// `NO_OPINION_PROMPT_STAGE`, so an out-of-cwd read under `default` legitimately falls to the MODE
// floor ("no canUseTool handler answered this unmatched action", WS-07 §6.1) in a real session it
// would not: there, a host answers the prompt. Asserting on the MECHANISM is what isolates this
// item's own question -- did the managed floor take the path away? -- from the fixture's missing
// prompt handler.
function notRuleDenied(out: { decision: string; mechanism: string }): boolean {
  return !(out.decision === "deny" && out.mechanism === "rule");
}

describe("M13: writes under ~/.winter/projects are denied, even under bypassPermissions", () => {
  test("Write to a child's durable transcript is DENIED under bypass (the forced-bypass child case)", async () => {
    const out = await decide({ toolName: "Write", input: { file_path: TRANSCRIPT, content: "injected turn" }, toolUseId: "t1" });
    expect(out.decision).toBe("deny");
  });

  test("Edit of the roster sidecar is DENIED under bypass", async () => {
    const out = await decide({ toolName: "Edit", input: { file_path: SIDECAR, old_string: "a", new_string: "b" }, toolUseId: "t2" });
    expect(out.decision).toBe("deny");
  });

  test("Write to the SESSION's own jsonl is DENIED under bypass", async () => {
    const out = await decide({ toolName: "Write", input: { file_path: SESSION_JSONL, content: "x" }, toolUseId: "t3" });
    expect(out.decision).toBe("deny");
  });

  test("the deny binds in prompting modes too, not only under bypass", async () => {
    for (const mode of ["default", "acceptEdits", "dontAsk", "plan"] as const) {
      const out = await decide({ toolName: "Write", input: { file_path: TRANSCRIPT, content: "x" }, toolUseId: "t4" }, mode);
      expect(out.decision, `mode ${mode}`).toBe("deny");
    }
  });

  test("a Bash-shaped write to the same path is denied too (the hole one tool over)", async () => {
    // `Write`-toolName rules cannot match a `Bash` call directly (rule matching requires an exact
    // toolName match) -- this is `findFileDenyBlockingEdit`'s widened family doing the work, and
    // without it `echo >> transcript` walks straight past the rules above.
    const redirect = await decide({ toolName: "Bash", input: { command: `echo injected >> ${TRANSCRIPT}` }, toolUseId: "t5" });
    expect(redirect.decision).toBe("deny");
    const sed = await decide({ toolName: "Bash", input: { command: `sed -i 's/a/b/' ${SIDECAR}` }, toolUseId: "t6" });
    expect(sed.decision).toBe("deny");
  });

  test("a write ELSEWHERE under the home is untouched -- the deny is scoped, not a blanket home fence", async () => {
    const out = await decide({ toolName: "Write", input: { file_path: `${HOME}/notes.md`, content: "x" }, toolUseId: "t7" });
    expect(out.decision).toBe("allow");
  });
});

describe("M13 scoping: Read/Glob/Grep stay allowed, because the .output stub hands the model these paths", () => {
  // The load-bearing half of the scoping decision. `tools/impl/agent.ts`'s `.output` stub prints the
  // child's absolute transcript path and tells the model to "Read that file directly" (Lane C's M1
  // fix, WS-12 §7.2). A read deny here would close M13's write hole by regressing a shipped
  // model-facing contract, so the baseline is write-side only -- pinned here so a later "tighten it
  // to reads as well" edit has to confront the contract it breaks.
  for (const [tool, input] of [
    ["Read", { file_path: TRANSCRIPT }],
    // Glob/Grep are matched on their `path` field, never on `pattern` (edit-recognition.ts's own
    // `fileRulePathField`) -- using `pattern` here would make the assertion vacuous.
    ["Glob", { path: `${HOME}/.winter/projects`, pattern: "**/*.jsonl" }],
    ["Grep", { pattern: "tool_use", path: `${HOME}/.winter/projects` }],
  ] as const) {
    test(`${tool} on ~/.winter/projects is NOT denied (the .output stub contract)`, async () => {
      const out = await decide({ toolName: tool, input: input as Record<string, unknown>, toolUseId: "r1" }, "default");
      expect(notRuleDenied(out), `${tool} must not be RULE-denied: ${out.message ?? out.decision}`).toBe(true);
    });
  }

  // NEW-7 (residual round), the precision this scoping claim needs: it is "Read/Glob/Grep stay
  // allowed", NOT "reads stay allowed". A Bash `cp`/`mv` naming a protected path as its SOURCE is a
  // read in intent, but `recognizeEditOperation` reports every operand of a blessed fs-op as a write
  // path (it cannot tell a source from a destination for the deny check), so the floor denies it.
  // That is the right side to err on -- `cp` with the operands swapped IS a write -- but it is a
  // deliberate consequence rather than an accident, so it is pinned here. A plain `cat` of the same
  // file is unaffected, which is what actually keeps the `.output` stub's contract alive.
  test("NEW-7: a Bash `cp` naming a protected path as its SOURCE is denied, while `cat` of the same file is not", async () => {
    const cp = await decide({ toolName: "Bash", input: { command: `cp ${TRANSCRIPT} /tmp/copy.jsonl` }, toolUseId: "n7a" });
    expect(cp.decision, "cp's operands are all write-path candidates -- the floor errs strict").toBe("deny");
    const mv = await decide({ toolName: "Bash", input: { command: `mv ${TRANSCRIPT} /tmp/moved.jsonl` }, toolUseId: "n7b" });
    expect(mv.decision).toBe("deny");
    // The read the `.output` stub's contract actually depends on: no RULE denies it.
    const cat = await decide({ toolName: "Bash", input: { command: `cat ${TRANSCRIPT}` }, toolUseId: "n7c" }, "default");
    expect(notRuleDenied(cat), `cat must not be RULE-denied: ${cat.message ?? cat.decision}`).toBe(true);
  });

  test("...while ~/.winter/run stays unreadable through all three read tools (the pre-existing floor)", async () => {
    for (const [tool, input] of [
      ["Read", { file_path: `${HOME}/.winter/run/core.sock` }],
      ["Glob", { path: `${HOME}/.winter/run`, pattern: "**" }],
      ["Grep", { pattern: "x", path: `${HOME}/.winter/run` }],
    ] as const) {
      const out = await decide({ toolName: tool, input: input as Record<string, unknown>, toolUseId: "r2" }, "default");
      expect(out.decision, `${tool} on ~/.winter/run`).toBe("deny");
      expect(out.mechanism, `${tool} on ~/.winter/run must be denied by the RULE, not the mode floor`).toBe("rule");
    }
  });
});

describe("M13: the two model-facing spill paths are NOT under a denied prefix", () => {
  // Both live under the SESSION TEMP root (`/tmp/winter-<uid>/<projectKey>/<sessionId>/...`,
  // paths/temp.ts), never under `~/.winter/projects` -- checked here rather than asserted in prose,
  // because "the deny broke a path the model is told to read" is exactly the failure this item
  // could have introduced.
  test("a background task's .output file and P4-K's persisted MCP output are both writable and readable", async () => {
    const taskOutput = "/private/tmp/winter-501/winter-501/-synthetic-workspace/sess-1/tasks/task-1.output";
    const mcpSpill = "/private/tmp/winter-501/winter-501/-synthetic-workspace/sess-1/mcp-output/srv__tool-1-1.txt";
    for (const path of [taskOutput, mcpSpill]) {
      expect(notRuleDenied(await decide({ toolName: "Read", input: { file_path: path }, toolUseId: "s1" }, "default")), `read ${path}`).toBe(true);
      // The WRITE side is asserted as a real allow: under bypass there is no prompt to fall through
      // to, so "allow" is the honest, unambiguous signal that no managed floor covers these paths.
      expect((await decide({ toolName: "Write", input: { file_path: path, content: "x" }, toolUseId: "s2" })).decision, `write ${path}`).toBe("allow");
    }
  });
});
