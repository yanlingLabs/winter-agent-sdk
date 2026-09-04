// RULING P5-D -- the FULL trust matrix, driven through every one of the four hand-mirrored gates.
//
// Why a matrix and not a hand trace. This phase family's standing lesson: P2-H was a hand-reasoned
// extension of the project-tier gate to `local`, defensible in isolation, and it stayed wrong for
// three phases because nothing enumerated the tier x behaviour x trust space. derived-shapes-p5
// capture (1) ran the discriminator against the pinned runtime, and the answer is narrower than
// P2-H assumed: the gate is PROJECT-TIER, PERMISSIVE-BEHAVIOUR only.
//
// THE FOUR GATES, all four hand-mirrored copies of one rule (each is exercised below):
//   1. `permissions/ruleset.ts`  resolveRules            -- the settings-side rule lookup
//   2. `permissions/ruleset.ts`  effectiveDirectories    -- additionalDirectories grants
//   3. `permissions/evaluator.ts` findMatchingRuleEntry  -- the live six-stage evaluator
//   4. `engine.ts`'s child-rule mirror                   -- what a subagent inherits
// Sites 2 and 4 are the ones a narrower fix forgets: nothing in the rule-matching path touches
// `effectiveDirectories`, and the child mirror is a separate literal in a different file.
//
// TWO RATIFIED READINGS ARE PINNED HERE TOO, both fail-closed and both NOT liftable by trust:
// an escalating project `defaultMode` still drops under `filterEscalatingDefaultMode` even in a
// trusted workspace, and `OVERLAY_NEVER_KEYS` stay unliftable. Trust widens permissive RULES; it is
// not a master key.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionBehavior, RuleSource } from "@yanlinglabs/winter-agent-sdk";
import { filterEscalatingDefaultMode, resolveSettingsDetailed, applyWorkspaceTrust, OVERLAY_NEVER_KEYS } from "../settings/resolve.ts";
import { emptyRuleSet, effectiveDirectories, resolveRules, sourceRule, type SourcedRuleEntry, type SourcedRuleSet } from "./ruleset.ts";
import { findMatchingRuleEntry, NO_OPINION_AUTO_ENGINE, NO_OPINION_HOOK_STAGE, NO_OPINION_PROMPT_STAGE, NO_SPECIAL_CHECKS, type EvaluationContext, type PermissionCall } from "./evaluator.ts";

/** Every tier a rule can carry, so the matrix is exhaustive by construction rather than by a hand-written list. */
const ALL_SOURCES: readonly RuleSource[] = ["managed", "user", "project", "local", "cliArg", "session", "sdk"];
const ALL_BEHAVIOURS: readonly PermissionBehavior[] = ["allow", "ask", "deny"];

/** P5-D in one predicate: the ONLY cell where trust matters. */
function shouldBeGated(source: RuleSource, behavior: PermissionBehavior): boolean {
  return source === "project" && behavior === "allow";
}

function seed(entries: SourcedRuleEntry[], directories: SourcedRuleSet["directories"] = []): SourcedRuleSet {
  return { ...emptyRuleSet(), entries, directories };
}

function evalCtx(rules: SourcedRuleSet, trustedWorkspace: boolean): EvaluationContext {
  return {
    policy: { mode: "default", rules, version: 1 },
    cwd: "/repo",
    home: "/home/u",
    sessionRoot: "/repo",
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
    trustedWorkspace,
  };
}

const CALL: PermissionCall = { toolName: "Bash", input: { command: "ls -la" }, toolUseId: "t1" };
const RULE = { toolName: "Bash", ruleContent: "ls *" } as const;

describe("RULING P5-D -- gate 1: resolveRules (settings-side lookup), full tier x behaviour x trust matrix", () => {
  for (const source of ALL_SOURCES) {
    for (const behavior of ALL_BEHAVIOURS) {
      for (const trustedWorkspace of [false, true]) {
        const gated = shouldBeGated(source, behavior) && !trustedWorkspace;
        test(`${source} / ${behavior} / trusted=${trustedWorkspace} -> ${gated ? "INERT" : "applies"}`, () => {
          const set = seed([sourceRule(RULE, behavior, source)]);
          const result = resolveRules(set, CALL, { trustedWorkspace });
          expect(result[behavior]?.source).toBe(gated ? undefined : source);
        });
      }
    }
  }
});

describe("RULING P5-D -- gate 3: findMatchingRuleEntry (the LIVE evaluator), same matrix", () => {
  for (const source of ALL_SOURCES) {
    for (const behavior of ALL_BEHAVIOURS) {
      for (const trustedWorkspace of [false, true]) {
        const gated = shouldBeGated(source, behavior) && !trustedWorkspace;
        test(`${source} / ${behavior} / trusted=${trustedWorkspace} -> ${gated ? "INERT" : "applies"}`, () => {
          const set = seed([sourceRule(RULE, behavior, source)]);
          const entry = findMatchingRuleEntry(set, CALL, behavior, evalCtx(set, trustedWorkspace));
          expect(entry?.source).toBe(gated ? undefined : source);
        });
      }
    }
  }

  test("gates 1 and 3 agree on EVERY cell -- they are hand-mirrored and must move together", () => {
    for (const source of ALL_SOURCES) {
      for (const behavior of ALL_BEHAVIOURS) {
        for (const trustedWorkspace of [false, true]) {
          const set = seed([sourceRule(RULE, behavior, source)]);
          const viaRuleset = resolveRules(set, CALL, { trustedWorkspace })[behavior]?.source;
          const viaEvaluator = findMatchingRuleEntry(set, CALL, behavior, evalCtx(set, trustedWorkspace))?.source;
          expect(viaEvaluator, `${source}/${behavior}/trusted=${trustedWorkspace}`).toBe(viaRuleset as RuleSource | undefined);
        }
      }
    }
  });
});

describe("RULING P5-D -- gate 2: effectiveDirectories (additionalDirectories), by tier", () => {
  for (const source of ALL_SOURCES) {
    for (const trustedWorkspace of [false, true]) {
      const gated = source === "project" && !trustedWorkspace;
      test(`${source} directory grant / trusted=${trustedWorkspace} -> ${gated ? "excluded" : "included"}`, () => {
        const set = seed([], [{ path: "/grant", source }]);
        expect(effectiveDirectories(set, { trustedWorkspace })).toEqual(gated ? [] : ["/grant"]);
      });
    }
  }

  test("a directory grant is trust-gated on the SAME tier a permissive rule is -- one rule, two surfaces", () => {
    for (const source of ALL_SOURCES) {
      const ruleGated = resolveRules(seed([sourceRule(RULE, "allow", source)]), CALL, { trustedWorkspace: false }).allow === undefined;
      const dirGated = effectiveDirectories(seed([], [{ path: "/grant", source }]), { trustedWorkspace: false }).length === 0;
      expect(dirGated, `${source}: rule gate and directory gate disagree`).toBe(ruleGated);
    }
  });
});

describe("RULING P5-D -- gate 4: the engine's child-rule mirror", () => {
  // A LITERAL PARITY CHECK, not a re-implementation. The mirror lives inside runEngine's
  // ChildEngineRunContext closure, and reaching it through a real spawn would need a LOCAL-sourced
  // parent rule -- which only a settings loader can produce (T8's wiring), not `allowedTools`, whose
  // rules are `sdk`-sourced. A test that re-declared the predicate here would assert my copy of it
  // and stay green while the engine's own copy drifted, which is exactly the failure mode this
  // codebase's other hand-mirrored lists (the remote allowlists) use literal parity tests to catch.
  //
  // The mirror re-tags what it mirrors as `sdk` in the child, where no trust gate applies -- so an
  // OVER-broad mirror widens, and an over-narrow one silently strips a rule the parent honours.
  const engineSource = readFileSync(new URL("../engine.ts", import.meta.url), "utf8");

  test("the mirror's allow-side skip is PROJECT-tier only, matching the evaluator's own predicate verbatim", () => {
    expect(engineSource).toContain(`if (entry.behavior === "allow" && entry.source === "project" && !trustedWorkspace) continue;`);
    // The P2-H two-tier form must be GONE -- its presence anywhere in engine.ts means a copy was missed.
    expect(engineSource).not.toContain(`(entry.source === "project" || entry.source === "local") && !trustedWorkspace`);
  });

  test("the evaluator's own predicate is the identical shape, so 'matching verbatim' is checkable rather than aspirational", () => {
    const evaluatorSource = readFileSync(new URL("./evaluator.ts", import.meta.url), "utf8");
    expect(evaluatorSource).toContain(`if (behavior === "allow" && entry.source === "project" && !ctx.trustedWorkspace) continue;`);
    expect(evaluatorSource).not.toContain(`(entry.source === "project" || entry.source === "local")`);
  });

  test("ruleset.ts's two gates carry the same narrowing -- all four copies, checked", () => {
    const rulesetSource = readFileSync(new URL("./ruleset.ts", import.meta.url), "utf8");
    expect(rulesetSource).toContain(`if (behavior === "allow" && entry.source === "project" && !opts.trustedWorkspace) continue;`);
    expect(rulesetSource).toContain(`set.directories.filter((d) => d.source !== "project" || opts.trustedWorkspace)`);
    expect(rulesetSource).not.toContain(`entry.source === "project" || entry.source === "local"`);
    expect(rulesetSource).not.toContain(`d.source !== "project" && d.source !== "local"`);
  });
});

describe("RULING P5-D -- what trust does NOT lift (both fail-closed, both ratified)", () => {
  async function withProjectSettings<T>(settings: unknown, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "winter-p5d-"));
    try {
      mkdirSync(join(dir, ".winter"), { recursive: true });
      writeFileSync(join(dir, ".winter", "settings.json"), JSON.stringify(settings));
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("an escalating project `defaultMode` is dropped even in a TRUSTED workspace -- trust widens rules, not modes", async () => {
    await withProjectSettings({ permissions: { defaultMode: "bypassPermissions", allow: ["Bash(ls *)"] } }, async (dir) => {
      // `winterHome` points at a directory that does not exist, so the `user` tier contributes
      // nothing and this test never reads the real ~/.winter (a standing rule for this settings
      // layer: the pinned resolveSettings has no home-injection point, so every test either excludes
      // the user tier or passes an explicit winterHome -- never a process.env mutation, which would
      // race in a shared-process bun test).
      const resolved = await resolveSettingsDetailed({ cwd: dir, settingSources: ["project"], winterHome: join(dir, "fake-home") });
      const trusted = applyWorkspaceTrust(resolved, { trustedWorkspace: true });
      // Trust LIFTS the project-tier allow...
      expect(trusted.permissions?.allow).toEqual(["Bash(ls *)"]);
      // ...and does NOT lift the escalating defaultMode, which its own tier-based filter drops first.
      expect((trusted.permissions as Record<string, unknown> | undefined)?.["defaultMode"]).toBeUndefined();
      expect((filterEscalatingDefaultMode(resolved).permissions as Record<string, unknown> | undefined)?.["defaultMode"]).toBeUndefined();
    });
  });

  test("OVERLAY_NEVER_KEYS are never liftable by trust -- they are excluded before the trust filter ever runs", async () => {
    await withProjectSettings({ autoMode: "on", autoMemoryDirectory: "/evil", permissions: { allow: ["Bash(ls *)"] } }, async (dir) => {
      const resolved = await resolveSettingsDetailed({ cwd: dir, settingSources: ["project"], winterHome: join(dir, "fake-home") });
      const trusted = applyWorkspaceTrust(resolved, { trustedWorkspace: true });
      for (const key of OVERLAY_NEVER_KEYS) {
        expect((trusted as Record<string, unknown>)[key], `${key} must stay unliftable`).toBeUndefined();
      }
      // The permissive rule in the SAME file IS lifted, so this is not a vacuous assertion about the
      // whole file being ignored.
      expect(trusted.permissions?.allow).toEqual(["Bash(ls *)"]);
    });
  });

  test("an untrusted workspace drops the project allow while the escalating mode stays dropped -- the two filters compose, neither substitutes for the other", async () => {
    await withProjectSettings({ permissions: { defaultMode: "bypassPermissions", allow: ["Bash(ls *)"], deny: ["Bash(rm *)"] } }, async (dir) => {
      const resolved = await resolveSettingsDetailed({ cwd: dir, settingSources: ["project"], winterHome: join(dir, "fake-home") });
      const untrusted = applyWorkspaceTrust(resolved, { trustedWorkspace: false });
      expect(untrusted.permissions?.allow).toBeUndefined();
      expect((untrusted.permissions as Record<string, unknown> | undefined)?.["defaultMode"]).toBeUndefined();
      // deny from the same untrusted project file still applies -- the half of WS-07 §3.2 that was
      // never in question.
      expect(untrusted.permissions?.deny).toEqual(["Bash(rm *)"]);
    });
  });
});
