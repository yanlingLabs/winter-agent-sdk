// Phase 6 Task 3 (R6-7's P4-M MUST): the provider-state sidecars are READ-DENIED, and everything
// beside them stays readable.
//
// THE POSITIVE CONTROL IS THE POINT. M13 made `~/.winter/projects/**` write-denied and deliberately
// left READS alone, because `tools/impl/agent.ts`'s `.output` stub hands the model a durable
// transcript path with "Read that file directly" -- a model-facing contract a blanket read deny would
// regress. So this deny cannot be a subpath: it has to name the sidecar FILENAME and nothing else,
// and every fixture below pairs a denied sidecar with a readable neighbour to prove it does.
//
// The sidecars are the one place opaque provider state lands (encrypted_content, thinking signatures,
// thoughtSignature, xAI opaque items). The model must never read back what it was structurally
// prevented from seeing in its own transcript.
//
// Every fixture drives the REAL six-stage `evaluate()` against the REAL production rule list
// (`buildBaselineDenyRules`, imported from engine.ts -- never a re-typed copy) under a SYNTHETIC
// home. Nothing here touches a real `~/.winter`, and no file is written anywhere.
import { describe, test, expect } from "bun:test";
import { buildBaselineDenyRules } from "../engine.ts";
import { buildSeatbeltProfile } from "../sandbox/profile.ts";
import {
  evaluate,
  probeReadAccess,
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
const PROJECT = `${HOME}/.winter/projects/-synthetic-workspace`;

const SESSION_SIDECAR = `${PROJECT}/sess-1.provider-state.jsonl`;
const CHILD_SIDECAR = `${PROJECT}/sess-1/subagents/agent-abc.provider-state.jsonl`;
// The positive controls: the neighbours that MUST stay readable.
const SESSION_TRANSCRIPT = `${PROJECT}/sess-1.jsonl`;
const CHILD_TRANSCRIPT = `${PROJECT}/sess-1/subagents/agent-abc.jsonl`;
const ROSTER_SIDECAR = `${PROJECT}/sess-1/subagents/agent-abc.meta.json`;

function ctxFor(mode: PermissionMode, resolvedWinterHome?: string): EvaluationContext {
  return {
    policy: { mode, rules: { ...emptyRuleSet(), entries: buildBaselineDenyRules(resolvedWinterHome) }, version: 1 },
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

async function decide(call: PermissionCall, mode: PermissionMode = "bypassPermissions", resolvedWinterHome?: string): Promise<{ decision: string; mechanism: string }> {
  const record = await evaluate(call, ctxFor(mode, resolvedWinterHome));
  return { decision: record.decision, mechanism: record.mechanism };
}

/**
 * "No BASELINE RULE denies this" -- deliberately not "the call is allowed", for the same reason
 * baseline-projects-deny.test.ts states: these fixtures use `NO_OPINION_PROMPT_STAGE`, so an
 * out-of-cwd read under a prompting mode legitimately falls to the MODE floor. Asserting on the
 * MECHANISM isolates this item's question -- did the managed floor take the path away? -- from the
 * fixture's missing prompt handler.
 */
function ruleDenied(out: { decision: string; mechanism: string }): boolean {
  return out.decision === "deny" && out.mechanism === "rule";
}

describe("P4-M: the provider-state sidecars are read-denied under every mode", () => {
  for (const [label, path] of [
    ["SESSION", SESSION_SIDECAR],
    ["CHILD", CHILD_SIDECAR],
  ] as const) {
    test(`Read of the ${label} sidecar is rule-denied, even under bypassPermissions`, async () => {
      expect(ruleDenied(await decide({ toolName: "Read", input: { file_path: path }, toolUseId: `t-${label}` }))).toBe(true);
    });

    test(`Grep rooted AT the ${label} sidecar is rule-denied (its rule path field is \`path\`)`, async () => {
      expect(ruleDenied(await decide({ toolName: "Grep", input: { pattern: "x", path }, toolUseId: `g-${label}` }))).toBe(true);
    });

    test(`Glob and Grep DISCOVERY of the ${label} sidecar is excluded per-file`, () => {
      // The real mechanism, and it is not the Glob/Grep rule path. `fileRulePathField` maps both
      // tools to their OWN `path` input (the search ROOT), so a scan rooted at the project directory
      // never names the sidecar and no rule on the call itself could catch it. Both executors close
      // exactly that gap by filtering their candidate/matched files through
      // `ctx.permissions.probeReadAccess` (glob.ts's own `matched.filter`, grep.ts's own
      // `candidateFiles.filter`) -- so a Read deny on the sidecar removes it from a directory-rooted
      // scan too. This asserts the probe those filters consult.
      expect(probeReadAccess(path, ctxFor("bypassPermissions"))).toBe("deny");
    });
  }

  test("the deny also binds under `default`, not only under bypass", async () => {
    expect(ruleDenied(await decide({ toolName: "Read", input: { file_path: SESSION_SIDECAR }, toolUseId: "d1" }, "default"))).toBe(true);
  });

  test("POSITIVE CONTROL: the sibling transcript, the child transcript and the roster sidecar stay readable", async () => {
    // If any of these three starts being rule-denied, the deny has become a subpath and has
    // regressed the `.output` stub's model-facing contract.
    for (const path of [SESSION_TRANSCRIPT, CHILD_TRANSCRIPT, ROSTER_SIDECAR]) {
      expect(ruleDenied(await decide({ toolName: "Read", input: { file_path: path }, toolUseId: `p-${path}` }))).toBe(false);
      // And a Glob/Grep scan of the project directory still finds them.
      expect(probeReadAccess(path, ctxFor("bypassPermissions"))).not.toBe("deny");
    }
  });

  test("a file merely NAMED like a sidecar outside the projects root is not denied by this rule", async () => {
    // The deny is anchored at the winter projects root, not at the filename globally -- a user's own
    // `~/notes/foo.provider-state.jsonl` is their file.
    expect(ruleDenied(await decide({ toolName: "Read", input: { file_path: `${HOME}/notes/foo.provider-state.jsonl` }, toolUseId: "n1" }))).toBe(false);
  });

  test("the RESOLVED-root twin binds under a WINTER_HOME that is not `<home>/.winter`", async () => {
    // Phase 5 fix wave I1's own lesson: the floors follow the RESOLVED winter root, or they protect a
    // directory that does not exist while the real one stays open.
    const resolved = "/synthetic/elsewhere/winter-root";
    const sidecar = `${resolved}/projects/-synthetic-workspace/sess-1.provider-state.jsonl`;
    expect(ruleDenied(await decide({ toolName: "Read", input: { file_path: sidecar }, toolUseId: "r1" }, "bypassPermissions", resolved))).toBe(true);
    // And its neighbour under the same resolved root stays readable.
    expect(ruleDenied(await decide({ toolName: "Read", input: { file_path: `${resolved}/projects/-synthetic-workspace/sess-1.jsonl` }, toolUseId: "r2" }, "bypassPermissions", resolved))).toBe(false);
  });
});

describe("P4-M: the Bash seatbelt profile denies the same files", () => {
  // A bash-invoked `cat ~/.winter/projects/.../sess-1.provider-state.jsonl` never passes through a
  // read TOOL's permission fence at all -- reads are otherwise deliberately unrestricted in this
  // product -- so the seatbelt is the only enforcement point left, exactly as WS-12 §2 records for
  // `~/.winter/run`.
  const profile = buildSeatbeltProfile({ cwd: CWD, allowNetwork: false, home: HOME });

  // The regex is case-folded PER CHARACTER -- SBPL ignores `(?i)` and the default macOS volume is
  // case-insensitive, so `Sess-1.Provider-State.JSONL` reaches the same file a case-exact regex
  // misses. That is why the assertions match the folded classes, not the literal filename.
  const PROVIDER_STATE_CF = String.raw`[Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr]-[Ss][Tt][Aa][Tt][Ee]\.[Jj][Ss][Oo][Nn][Ll]`;

  test("the profile carries a file-read deny naming the case-folded sidecar suffix, anchored at the projects root", () => {
    const line = profile.split("\n").find((l) => l.includes("[Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr]"));
    expect(line).toBeDefined();
    expect(line).toContain("(deny file-read* (regex ");
    expect(line).toContain(PROVIDER_STATE_CF);
    // Anchored, so a user's own `~/notes/foo.provider-state.jsonl` is untouched.
    // Anchored at the resolved winter root -- the ROOT prefix stays literal (identical posture to the
    // run-dir/backups denies in profile.ts, which anchor on the resolved path verbatim), while the
    // `projects` segment this rule owns is folded.
    expect(line).toContain(`^${HOME}/\\.winter/[Pp][Rr][Oo][Jj][Ee][Cc][Tt][Ss]/`);
  });

  test("POSITIVE CONTROL: it is a REGEX on the filename, never a subpath deny of the projects tree", () => {
    // A `(deny file-read* (subpath ".../projects"))` line would deny the transcripts too. Its absence
    // is what keeps `cat`-ing a transcript working.
    expect(profile).not.toMatch(/\(deny file-read\* \(subpath "[^"]*\/projects"\)\)/);
  });

  test("the RESOLVED-root twin is emitted when winterHome differs from `<home>/.winter`", () => {
    const resolved = "/synthetic/elsewhere/winter-root";
    const withResolved = buildSeatbeltProfile({ cwd: CWD, allowNetwork: false, home: HOME, winterHome: resolved });
    const denies = withResolved.split("\n").filter((l) => l.includes("[Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr]"));
    expect(denies.length).toBeGreaterThanOrEqual(2);
    expect(denies.some((l) => l.includes("winter-root"))).toBe(true);
  });
});
