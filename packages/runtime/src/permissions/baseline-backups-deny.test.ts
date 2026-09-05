// T8 rider 25 (SECURITY): `~/.winter/backups/**` joins the managed write floor, alongside the
// `projects` block M13 landed.
//
// The finding, in the same shape as M13's: `checkpoint/`'s backup store holds the PRE-IMAGE BYTES a
// `rewind_files` writes back over the user's own files, plus the `index.jsonl` that says WHICH files
// those bytes go to. `permissions/protected.ts` protects `.winter/**` writes -- but only when the
// resolved winter root is literally named `.winter`, and `resolveProtectedWrite` returns `allow`
// under `bypassPermissions` anyway (WS-07 §6.7's matrix), which WS-07 §11 FORCES on every descendant
// of a bypass parent. A model that can write `index.jsonl` can name any path on the filesystem and
// have the next rewind write attacker-chosen bytes there; a model that can write a BLOB can choose
// the bytes for a path the session legitimately tracked. A `managed` deny binds where the
// protected-write check does not, because stage 2's deny lookup runs before stage 4's bypass
// auto-allow.
//
// WRITE-SIDE ONLY, deliberately and for M13's own stated reason: reads on `~/.winter` are otherwise
// unrestricted by this product's tool-surface design (the sole baseline read denial is
// `~/.winter/run`), and denying reads here would buy nothing -- a backup blob is a copy of a file the
// model could already read in place.
//
// Every fixture drives the REAL six-stage `evaluate()` against the REAL production rule list
// (`buildBaselineDenyRules`, imported from engine.ts) under a SYNTHETIC home. Nothing here touches a
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
const INDEX = `${HOME}/.winter/backups/sess-1/index.jsonl`;
const BLOB = `${HOME}/.winter/backups/sess-1/0123456789abcdef@v1`;
const BACKUPS_DIR = `${HOME}/.winter/backups`;

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

async function decide(call: PermissionCall, mode: PermissionMode = "bypassPermissions"): Promise<{ decision: string; mechanism: string }> {
  const record = await evaluate(call, ctxFor(mode));
  return { decision: record.decision, mechanism: record.mechanism };
}

describe("rider 25: writes under ~/.winter/backups are denied, even under bypassPermissions", () => {
  test("Write to the checkpoint index is DENIED under bypass (the tampered-index case)", async () => {
    const out = await decide({ toolName: "Write", input: { file_path: INDEX, content: '{"kind":"snapshot","path":"/etc/hosts"}' }, toolUseId: "t1" });
    expect(out.decision).toBe("deny");
    expect(out.mechanism).toBe("rule");
  });

  test("Edit of a backup BLOB is DENIED under bypass (choose-the-restored-bytes case)", async () => {
    const out = await decide({ toolName: "Edit", input: { file_path: BLOB, old_string: "a", new_string: "b" }, toolUseId: "t2" });
    expect(out.decision).toBe("deny");
    expect(out.mechanism).toBe("rule");
  });

  test("NotebookEdit under backups is DENIED under bypass", async () => {
    const out = await decide({ toolName: "NotebookEdit", input: { notebook_path: `${BACKUPS_DIR}/sess-1/x.ipynb`, new_source: "x" }, toolUseId: "t3" });
    expect(out.decision).toBe("deny");
    expect(out.mechanism).toBe("rule");
  });

  test("the backups DIRECTORY itself is denied, not only its contents (the bare pattern)", async () => {
    const out = await decide({ toolName: "Write", input: { file_path: BACKUPS_DIR, content: "x" }, toolUseId: "t4" });
    expect(out.decision).toBe("deny");
    expect(out.mechanism).toBe("rule");
  });

  test("a Bash-shaped write to the index is denied too (findFileDenyBlockingEdit, the M13 mechanism)", async () => {
    const out = await decide({ toolName: "Bash", input: { command: `echo tampered >> ${INDEX}` }, toolUseId: "t5" });
    expect(out.decision).toBe("deny");
  });

  test("READS of a backup blob are NOT rule-denied -- the floor is write-side only", async () => {
    const out = await decide({ toolName: "Read", input: { file_path: BLOB }, toolUseId: "t6" });
    expect(out.decision === "deny" && out.mechanism === "rule").toBe(false);
  });
});
