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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaselineDenyRules } from "../engine.ts";
import { memoryDirFor, RESERVED_MEMORY_KEYS } from "../context/memory-key.ts";
import { MEMORY_INDEX_BASENAME } from "../context/memory.ts";
import {
  evaluate,
  PLAN_WRITE_WITHHELD_MESSAGE,
  REAL_SPECIAL_CHECKS,
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  type EvaluationContext,
  type PermissionCall,
} from "./evaluator.ts";
import { isMemoryCarveOut } from "./protected.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";

const HOME = "/synthetic/home/tester";
const CWD = "/synthetic/workspace";
// The three durable shapes M13 names, verbatim from `agent.ts`'s own `.output` stub and the store's
// own layout: a child transcript, its roster sidecar, and the session's own JSONL.
const TRANSCRIPT = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/subagents/agent-abc.jsonl`;
const SIDECAR = `${HOME}/.winter/projects/-synthetic-workspace/sess-1/subagents/agent-abc.meta.json`;
const SESSION_JSONL = `${HOME}/.winter/projects/-synthetic-workspace/sess-1.jsonl`;

function ctxFor(mode: PermissionMode, extraEntries: readonly SourcedRuleEntry[] = []): EvaluationContext {
  return {
    policy: { mode, rules: { ...emptyRuleSet(), entries: [...buildBaselineDenyRules(), ...extraEntries] }, version: 1 },
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

async function decide(
  call: PermissionCall,
  mode: PermissionMode = "bypassPermissions",
  extraEntries: readonly SourcedRuleEntry[] = [],
): Promise<{ decision: string; mechanism: string; message?: string }> {
  const record = await evaluate(call, ctxFor(mode, extraEntries));
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

// ---------------------------------------------------------------------------------------------
// SDK 0.0.4: the auto-memory carve-out
// ---------------------------------------------------------------------------------------------
//
// THE FINDING. `context/memory-key.ts` resolves auto-memory to `<winterHome>/projects/<memory-key>/
// memory`, and `context/memory.ts` tells the model, every turn, "there are no memory tools: read and
// write it with the ordinary file tools." The M13 deny above then refused every one of those writes:
// Winter's own feature was blocked by Winter's own floor, in every permission mode including
// `bypassPermissions` (a managed deny beats the bypass auto-allow by design), and no host allow rule
// could rescue it either (a managed deny beats stage 5 by design too).
//
// THE CARVE-OUT is P5-B's shape, one segment tighter and with one condition P5-B does not have:
// exactly `<home>/.winter/projects/<one segment>/memory/<at least one more>`, for the WRITE-CLASS
// tools only. Every fixture below drives the REAL `evaluate()` over the REAL production rule list.
const MEMORY_DIR = `${HOME}/.winter/projects/-synthetic-workspace/memory`;
const MEMORY_INDEX = `${MEMORY_DIR}/MEMORY.md`;
const MEMORY_TOPIC = `${MEMORY_DIR}/topics/build-conventions.md`;

// A host-authored allow rule over the whole projects subtree -- the thing the managed deny used to
// beat. HOME-ANCHORED (`~/...`), never a bare absolute path: WS-07 §3.1's own grammar
// (permissions/paths.ts `resolveAnchor`) reads a SINGLE leading `/` as "relative to the rule's own
// settings-file directory", which is `undefined` for a hand-built entry and makes the whole rule
// silently INERT -- the exact trap `buildBaselineDenyRules` carries its own `//`-anchor comment for.
// A bare-absolute spelling here made this fixture's `deny` case pass for the wrong reason.
const USER_ALLOW_PROJECTS = sourceRule({ toolName: "Write", ruleContent: "~/.winter/projects/**" }, "allow", "user");

describe("SDK 0.0.4: projects/<key>/memory/** is writable by the write-class tools", () => {
  test("the index and a topic file are allowed OUTRIGHT under bypassPermissions", async () => {
    // Bypass is the unambiguous leg: there is no prompt to fall through to, so `allow` here means
    // the managed deny was skipped AND the §6.7 protected-write exception cleared -- both halves.
    for (const path of [MEMORY_INDEX, MEMORY_TOPIC]) {
      const out = await decide({ toolName: "Write", input: { file_path: path, content: "# index\n" }, toolUseId: "m1" });
      expect(out.decision, `${path}: ${out.message ?? ""}`).toBe("allow");
    }
    const edit = await decide({ toolName: "Edit", input: { file_path: MEMORY_INDEX, old_string: "a", new_string: "b" }, toolUseId: "m2" });
    expect(edit.decision).toBe("allow");
  });

  test("under `default` and `acceptEdits` a host allow rule now RESCUES the write -- which is the whole fix", async () => {
    // The crisp before/after. A managed deny wins at stage 2 over any allow rule at stage 5, so
    // before the carve-out this was `deny`/`rule` even with the host's own grant in hand. It is also
    // the only way these two modes can reach `allow` at all in a fixture with no prompt handler:
    // the memory directory is outside cwd, so `acceptEdits` never auto-approves it either.
    for (const mode of ["default", "acceptEdits"] as const) {
      const out = await decide({ toolName: "Write", input: { file_path: MEMORY_INDEX, content: "x" }, toolUseId: "m3" }, mode, [USER_ALLOW_PROJECTS]);
      expect(out.decision, `mode ${mode}: ${out.message ?? ""}`).toBe("allow");
    }
  });

  test("without an allow rule, `default`/`acceptEdits` reach the PROMPT -- never a rule denial and never the protected-path exception", async () => {
    // What the evaluator's own stage order gives, asserted rather than wished for. With
    // NO_OPINION_PROMPT_STAGE the call ends `deny`/`mode` ("nobody answered"), exactly as any
    // ordinary out-of-cwd write does in this fixture -- the two things that must NOT be true are
    // that a RULE denied it (stage 2) or that the §6.7 standing exception intercepted it (stage 4).
    for (const mode of ["default", "acceptEdits"] as const) {
      const out = await decide({ toolName: "Write", input: { file_path: MEMORY_INDEX, content: "x" }, toolUseId: "m4" }, mode);
      expect(notRuleDenied(out), `mode ${mode} must not be RULE-denied: ${out.message ?? out.decision}`).toBe(true);
      expect(out.message ?? "", `mode ${mode} must not hit the protected-path exception`).not.toContain("protected path write");
    }
  });

  test("`plan` still withholds the write -- ITS OWN rule, not the managed deny (documented stage order)", async () => {
    // plan's write-withholding is a THIRD standing exception (WS-07 §2 stage 5), resolved inside
    // `evaluateModeStage` AFTER the protected-path check the carve-out clears and BEFORE stage 5's
    // allow rules -- so a plan session's memory write is withheld with plan's own message, and an
    // allow rule cannot convert it. This is the answer the evaluator gives, pinned verbatim.
    const out = await decide({ toolName: "Write", input: { file_path: MEMORY_INDEX, content: "x" }, toolUseId: "m5" }, "plan", [USER_ALLOW_PROJECTS]);
    expect(out.decision).toBe("deny");
    expect(out.message).toBe(PLAN_WRITE_WITHHELD_MESSAGE);
    // ...and with session bypass relaxing plan entirely (§6.4/§6.5), it executes like any other write.
    const record = await evaluate({ toolName: "Write", input: { file_path: MEMORY_INDEX, content: "x" }, toolUseId: "m5b" }, {
      ...ctxFor("plan"),
      sessionBypassEnabled: true,
    });
    expect(record.decision).toBe("allow");
  });

  test("the PRODUCT buckets `_global`/`_assistant` are inside the carve-out too -- one segment is one segment", async () => {
    // `context/memory-key.ts`'s RESERVED_MEMORY_KEYS: Winter's own assembler can never produce these
    // (the pinned sanitiser maps every non-alphanumeric to `-`, so a computed key cannot begin with
    // `_`), but they are named there precisely because a HOST layers them on -- Norma's `_global`
    // no-project bucket and its shared `_assistant` dream bucket. They are ordinary single segments,
    // so the carve-out admits them by construction rather than by a second rule. Pinned, because
    // "the fix works for Winter's own memory but not for the product's" would be an invisible half-fix.
    for (const key of RESERVED_MEMORY_KEYS) {
      const out = await decide(
        { toolName: "Write", input: { file_path: `${HOME}/.winter/projects/${key}/memory/MEMORY.md`, content: "x" }, toolUseId: "pb1" },
      );
      expect(out.decision, `${key}: ${out.message ?? ""}`).toBe("allow");
    }
  });

  test("a user-authored DENY still wins -- the skip is scoped to MANAGED entries", async () => {
    const userDeny = sourceRule({ toolName: "Write", ruleContent: "~/.winter/projects/**" }, "deny", "user");
    const out = await decide({ toolName: "Write", input: { file_path: MEMORY_INDEX, content: "x" }, toolUseId: "m6" }, "bypassPermissions", [userDeny]);
    expect(out.decision).toBe("deny");
    expect(out.mechanism).toBe("rule");
  });
});

describe("SDK 0.0.4: everything the memory carve-out must NOT open", () => {
  for (const [label, path] of [
    // A sibling of the memory directory under the same key: the durable transcript shape M13 exists for.
    ["a transcript beside the memory directory", `${HOME}/.winter/projects/-synthetic-workspace/agent-1.jsonl`],
    // The P5-B nesting refusal, restated one segment shorter: a session-uuid directory under a key is
    // not the memory directory, and `projects/**/memory` would have admitted it.
    ["a `memory` directory nested under a SESSION", `${HOME}/.winter/projects/-synthetic-workspace/1f0e-uuid/memory/x.md`],
    // Traversal: `resolve()` normalizes before the segments are compared, so this IS the transcript.
    ["a traversal OUT of the memory directory", `${MEMORY_DIR}/../agent-1.jsonl`],
    // A project whose KEY is literally "memory" -- a prefix match on the segment would admit it.
    ["a project key that is literally `memory`", `${HOME}/.winter/projects/memory/x.md`],
    // The directory itself, exactly as P5-B refuses its own.
    ["the memory DIRECTORY itself", MEMORY_DIR],
    // The rider-25 backup store, which shares nothing with this carve-out.
    ["the checkpoint backup store", `${HOME}/.winter/backups/sess-1/index.jsonl`],
  ] as const) {
    test(`${label} is STILL denied under bypassPermissions`, async () => {
      const out = await decide({ toolName: "Write", input: { file_path: path, content: "x" }, toolUseId: "d1" });
      expect(out.decision, `${path} must stay denied`).toBe("deny");
      expect(out.mechanism, `${path} must be denied by the RULE`).toBe("rule");
    });
  }

  test("Bash is UNTOUCHED: a shell redirect into the memory directory is still denied", async () => {
    // Condition 3 of the carve-out. The memory feature never needs a shell to maintain its own
    // directory, and a shell carve-out keyed on one operand's path would hand the model an
    // arbitrary-command door. `findFileDenyBlockingEdit`'s cross-tool rule is what catches it.
    const redirect = await decide({ toolName: "Bash", input: { command: `echo poisoned >> ${MEMORY_INDEX}` }, toolUseId: "b1" });
    expect(redirect.decision).toBe("deny");
    const tee = await decide({ toolName: "Bash", input: { command: `cp /tmp/x ${MEMORY_INDEX}` }, toolUseId: "b2" });
    expect(tee.decision).toBe("deny");
  });

  test("a compound write touching the memory index AND a transcript is denied outright", async () => {
    // Condition 2: EVERY candidate path must be inside the carve-out, so the all-or-nothing property
    // P5-B pins for workflow scripts holds here too.
    const out = await decide(
      { toolName: "Bash", input: { command: `cp ${MEMORY_INDEX} ${HOME}/.winter/projects/-synthetic-workspace/agent-1.jsonl` }, toolUseId: "c1" },
    );
    expect(out.decision).toBe("deny");
  });

  test("Read/Glob/Grep are unchanged -- this carve-out is write-side only and adds no read denial", async () => {
    for (const [tool, input] of [
      ["Read", { file_path: MEMORY_INDEX }],
      ["Glob", { path: MEMORY_DIR, pattern: "**/*.md" }],
      ["Grep", { pattern: "x", path: MEMORY_DIR }],
    ] as const) {
      const out = await decide({ toolName: tool, input: input as Record<string, unknown>, toolUseId: "r1" }, "default");
      expect(notRuleDenied(out), `${tool}: ${out.message ?? out.decision}`).toBe(true);
    }
  });
});

describe("SDK 0.0.4: the carve-out names the directory the memory feature ACTUALLY writes", () => {
  test("`memoryDirFor`'s own output is inside the carve-out, asserted through the REAL predicate", () => {
    // The store.test.ts pattern: the floor and the feature must not be able to disagree about where
    // memory lives. A re-spelled path literal here would let this file agree with itself forever.
    const cwd = mkdtempSync(join(tmpdir(), "winter-memcarve-"));
    try {
      const dir = memoryDirFor({ cwd, home: `${HOME}/.winter`, env: {} });
      expect(isMemoryCarveOut(join(dir, MEMORY_INDEX_BASENAME), HOME), `${dir} must be inside the carve-out`).toBe(true);
      expect(isMemoryCarveOut(join(dir, "topics", "x.md"), HOME), "topic files nest freely BELOW the memory directory").toBe(true);
      expect(isMemoryCarveOut(dir, HOME), "the directory itself is not writable").toBe(false);
      // The RESOLVED-root anchor (a <PREFIX>HOME whose basename is not the brand dot-dir) -- the
      // Phase 5 I1 class, which P5-B had to be fixed for and which this carve-out carries from birth.
      const elsewhere = memoryDirFor({ cwd, home: "/var/tmp/winter-root", env: {} });
      expect(isMemoryCarveOut(join(elsewhere, MEMORY_INDEX_BASENAME), HOME, "/var/tmp/winter-root")).toBe(true);
      expect(isMemoryCarveOut(join(elsewhere, MEMORY_INDEX_BASENAME), HOME), "and NOT without the resolved root").toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
