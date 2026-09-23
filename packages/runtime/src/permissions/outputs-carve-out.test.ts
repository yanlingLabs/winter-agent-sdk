// The session OUTPUTS directory (`RuntimeConfig.outputsDir`, the shell's `$OUTDIR`) and the protected
// floor. Winter's daemon puts it at `<winter home>/outputs/<sessionId>`, inside the winter home the
// floor covers wholesale, so every write the product told the model to make there was asked -- under
// bypass too. With `outputsDir` set, the winter-home part of the floor no longer covers that one
// directory (the floors below it still hold); without it nothing changes.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, PermissionRuleValue } from "@yanlinglabs/winter-agent-sdk";
import { evaluate, NO_OPINION_AUTO_ENGINE, NO_OPINION_HOOK_STAGE, REAL_SPECIAL_CHECKS, type EvaluationContext, type PermissionCall, type PromptStageMeta } from "./evaluator.ts";
import { emptyRuleSet, sourceRule, type SourcedRuleEntry } from "./ruleset.ts";

const HOME = "/synthetic/home/tester";
const CWD = "/work/repo";
const OUT = `${HOME}/.winter/outputs/s1`;

function rule(raw: string, behavior: "allow" | "deny" | "ask"): SourcedRuleEntry {
  const m = /^([^\s(]+)\((.*)\)$/s.exec(raw.trim());
  const value: PermissionRuleValue = m ? { toolName: m[1]!, ruleContent: m[2]! } : { toolName: raw.trim() };
  return sourceRule(value, behavior, "user");
}

function ctxWith(mode: PermissionMode, rules: SourcedRuleEntry[], extra: Partial<EvaluationContext> = {}): { ctx: EvaluationContext; prompts: PromptStageMeta[] } {
  const prompts: PromptStageMeta[] = [];
  const ctx: EvaluationContext = {
    policy: { mode, version: 0, rules: { ...emptyRuleSet(), entries: rules } },
    cwd: CWD,
    sessionRoot: CWD,
    home: HOME,
    trustedWorkspace: false,
    sessionBypassEnabled: mode === "bypassPermissions",
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: {
      async prompt(_c, _ctx, meta) {
        prompts.push(meta);
        return null; // headless: anything that needs a person fails closed
      },
    },
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: REAL_SPECIAL_CHECKS,
    ...extra,
  };
  return { ctx, prompts };
}

const bash = (command: string, escape = false): PermissionCall => ({ toolName: "Bash", input: { command, ...(escape ? { dangerouslyDisableSandbox: true } : {}) }, toolUseId: "t1" });
const write = (file_path: string): PermissionCall => ({ toolName: "Write", input: { file_path, content: "x" }, toolUseId: "t1" });
const escapeSeam = { bashSandboxEscape: (c: PermissionCall) => c.input["dangerouslyDisableSandbox"] === true };

describe("with outputsDir set, a write there is judged like any other (policy-appropriately)", () => {
  test("a Write the host's allow rule names is allowed; without outputsDir the floor asked", async () => {
    // Fix round 4 (SV-7): authored under Edit(...), not Write(...) -- a Write(...)-authored rule is
    // dead code claude never reads, even for a Write call (file-rules.ts's own
    // canonicalFileRuleAuthoringToolName). Edit is the ONE canonical authoring name for the whole
    // edit-class kind (Edit/Write/NotebookEdit).
    const rules = [rule(`Edit(/${OUT}/**)`, "allow")];
    const withOut = ctxWith("default", rules, { outputsDir: OUT });
    expect(await evaluate(write(`${OUT}/report.md`), withOut.ctx)).toMatchObject({ decision: "allow", mechanism: "rule" });
    const without = ctxWith("default", rules);
    expect((await evaluate(write(`${OUT}/report.md`), without.ctx)).decision).toBe("deny"); // asked, headless
    expect(without.prompts[0]!.decisionReason).toContain("protected path write");
  });

  test("a Write with no rule is an ordinary prompt, not the protected floor's", async () => {
    const { ctx, prompts } = ctxWith("default", [], { outputsDir: OUT });
    await evaluate(write(`${OUT}/report.md`), ctx);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.decisionReason).not.toContain("protected path write");
  });

  test("bypass: a shell write to the literal outputs path runs; without outputsDir it was asked", async () => {
    const withOut = ctxWith("bypassPermissions", [], { outputsDir: OUT });
    expect((await evaluate(bash(`echo x > ${OUT}/x.txt`), withOut.ctx)).decision).toBe("allow");
    expect(withOut.prompts).toHaveLength(0);
    const without = ctxWith("bypassPermissions", []);
    expect((await evaluate(bash(`echo x > ${OUT}/x.txt`), without.ctx)).decision).toBe("deny");
    expect(without.prompts).toHaveLength(1);
  });

  test("an ESCAPED rule-allowed `echo > <outputs>/x` runs (the outputs directory counts as writable); without outputsDir it was asked", async () => {
    const withOut = ctxWith("default", [rule("Bash(echo:*)", "allow")], { outputsDir: OUT, ...escapeSeam });
    expect(await evaluate(bash(`echo x > ${OUT}/x.txt`, true), withOut.ctx)).toMatchObject({ decision: "allow", mechanism: "rule" });
    const without = ctxWith("default", [rule("Bash(echo:*)", "allow")], escapeSeam);
    expect((await evaluate(bash(`echo x > ${OUT}/x.txt`, true), without.ctx)).decision).toBe("deny");
    expect(without.prompts).toHaveLength(1);
  });

  test("a SANDBOXED `echo > $OUTDIR/x` is the sandbox auto-allow's (with or without outputsDir)", async () => {
    for (const extra of [{ outputsDir: OUT }, {}]) {
      const { ctx, prompts } = ctxWith("default", [], { bashRunsSandboxed: () => true, ...extra });
      expect((await evaluate(bash("echo x > $OUTDIR/x.txt"), ctx)).decision).toBe("allow");
      expect(prompts).toHaveLength(0);
    }
  });

  test("the `$OUTDIR` spelling is still an expansion: a rule-allowed escape asks for it (claude's validatePath), bypass runs it", async () => {
    const ruled = ctxWith("default", [rule("Bash(echo:*)", "allow")], { outputsDir: OUT, ...escapeSeam });
    await evaluate(bash("echo x > $OUTDIR/x.txt", true), ruled.ctx);
    expect(ruled.prompts.map((p) => p.decisionReason)).toEqual(["Shell expansion syntax in paths requires manual approval"]);
    const bypass = ctxWith("bypassPermissions", [], { outputsDir: OUT });
    expect((await evaluate(bash("echo x > $OUTDIR/x.txt"), bypass.ctx)).decision).toBe("allow");
  });
});

describe("the carve-out lifts only the winter-home floor, and only for a carvable directory", () => {
  test("below the outputs directory the ordinary floors hold", async () => {
    for (const target of [`${OUT}/.git/config`, `${OUT}/app/package.json`, `${OUT}/.winter/settings.json`, `${OUT}/sub/permissions.local.json`]) {
      const { ctx, prompts } = ctxWith("bypassPermissions", [], { outputsDir: OUT });
      expect((await evaluate(bash(`echo x > ${target}`), ctx)).decision).toBe("deny");
      expect(prompts).toHaveLength(1);
    }
  });

  test("the rest of the winter home stays protected: another session's outputs, the outputs directory itself, the runtimes", async () => {
    for (const command of [`echo x > ${HOME}/.winter/outputs/s2/x.txt`, `rm -r ${OUT}`, `cp /tmp/evil ${HOME}/.winter/runtimes/bin/winter`]) {
      const { ctx, prompts } = ctxWith("bypassPermissions", [rule("Bash(rm:*)", "allow")], { outputsDir: OUT });
      await evaluate(bash(command), ctx);
      expect(prompts).toHaveLength(1);
    }
  });

  test("an outputs directory that IS the home, sits in its state, or sits in another protected directory lifts nothing", async () => {
    const cases: Array<[string, string]> = [
      [`${HOME}/.winter`, `${HOME}/.winter/runtimes/bin/winter`],
      [`${HOME}/.winter/runtimes/out`, `${HOME}/.winter/runtimes/out/x`],
      [`${HOME}/.winter/run/out`, `${HOME}/.winter/run/out/x`],
      [`${CWD}/.git/out`, `${CWD}/.git/out/x`],
    ];
    for (const [outputsDir, target] of cases) {
      const { ctx, prompts } = ctxWith("bypassPermissions", [], { outputsDir });
      await evaluate(bash(`echo x > ${target}`), ctx);
      expect(prompts).toHaveLength(1);
    }
  });

  test("a custom winter home: the carve-out follows the resolved home", async () => {
    const { ctx, prompts } = ctxWith("bypassPermissions", [], { winterHome: "/srv/winter-home", outputsDir: "/srv/winter-home/outputs/s1" });
    expect((await evaluate(bash("echo x > /srv/winter-home/outputs/s1/x.txt"), ctx)).decision).toBe("allow");
    await evaluate(bash("echo x > /srv/winter-home/outputs/s2/x.txt"), ctx);
    expect(prompts).toHaveLength(1);
  });

  test("a real home under a symlinked temp root (/var -> /private/var) matches at both symlink ends", async () => {
    const root = mkdtempSync(join(tmpdir(), "winter-outputs-")); // /var/folders/... on macOS
    const out = join(root, ".winter", "outputs", "s1");
    mkdirSync(out, { recursive: true });
    const { ctx, prompts } = ctxWith("bypassPermissions", [], { home: root, outputsDir: out });
    expect((await evaluate(bash(`echo x > ${out}/x.txt`), ctx)).decision).toBe("allow");
    expect(prompts).toHaveLength(0);
  });
});
