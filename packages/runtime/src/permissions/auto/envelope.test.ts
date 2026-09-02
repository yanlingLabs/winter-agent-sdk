// Task 12 (WS-07 §10.6-1): buildActionEnvelope — P2-fillable fields for real, P3+ fields absent
// (never fabricated).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildActionEnvelope } from "./envelope.ts";
import {
  NO_OPINION_HOOK_STAGE,
  NO_OPINION_PROMPT_STAGE,
  NO_OPINION_AUTO_ENGINE,
  NO_SPECIAL_CHECKS,
  type EvaluationContext,
  type PermissionCall,
  type SpecialChecks,
} from "../evaluator.ts";
import { emptyRuleSet } from "../ruleset.ts";
import type { PolicyState } from "../policy-state.ts";

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const policy: PolicyState = { mode: "auto", version: 0, rules: emptyRuleSet() };
  return {
    policy,
    cwd: "/work",
    home: "/home/u",
    trustedWorkspace: false,
    hookStage: NO_OPINION_HOOK_STAGE,
    promptStage: NO_OPINION_PROMPT_STAGE,
    autoEngine: NO_OPINION_AUTO_ENGINE,
    specialChecks: NO_SPECIAL_CHECKS,
    ...overrides,
  };
}

function call(toolName: string, input: Record<string, unknown>): PermissionCall {
  return { toolName, input };
}

describe("buildActionEnvelope -- basic shape", () => {
  test("toolName/canonicalToolName/input/cwd/roots", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "pwd" }), ctx());
    expect(envelope.toolName).toBe("Bash");
    expect(envelope.canonicalToolName).toBe("Bash"); // no alias table at P2
    expect(envelope.input).toEqual({ command: "pwd" });
    expect(envelope.cwd).toBe("/work");
    expect(envelope.roots).toContain("/work");
  });

  test("sessionCreatedResources is always an empty array at P2 (field exists, never populated)", () => {
    expect(buildActionEnvelope(call("Bash", { command: "pwd" }), ctx()).sessionCreatedResources).toEqual([]);
  });

  test("classifierContext defaults to [] when no extras are given", () => {
    expect(buildActionEnvelope(call("Bash", { command: "pwd" }), ctx()).classifierContext).toEqual([]);
  });

  test("provenance is absent -- never a fabricated value (§10.4: no probe exists yet)", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "pwd" }), ctx());
    expect("provenance" in envelope).toBe(false);
  });

  test("toolUseId/agentId thread through from the call when present, absent when not (exactOptionalPropertyTypes)", () => {
    const withIds = buildActionEnvelope({ toolName: "Bash", input: { command: "pwd" }, toolUseId: "tu1", agentId: "ag1" }, ctx());
    expect(withIds.toolUseId).toBe("tu1");
    expect(withIds.agentId).toBe("ag1");
    const without = buildActionEnvelope(call("Bash", { command: "pwd" }), ctx());
    expect("toolUseId" in without).toBe(false);
    expect("agentId" in without).toBe(false);
  });
});

describe("buildActionEnvelope -- extras (sessionId/runtimeKind/classifierContext)", () => {
  test("populated when provided", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "pwd" }), ctx(), {
      sessionId: "sess1",
      runtimeKind: "winter-agent",
      classifierContext: [{ hookId: "h1", context: "wrote outside the workspace" }],
    });
    expect(envelope.sessionId).toBe("sess1");
    expect(envelope.runtimeKind).toBe("winter-agent");
    expect(envelope.classifierContext).toEqual([{ hookId: "h1", context: "wrote outside the workspace" }]);
  });

  test("absent (not merely undefined) when extras are omitted", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "pwd" }), ctx());
    expect("sessionId" in envelope).toBe(false);
    expect("runtimeKind" in envelope).toBe(false);
  });
});

describe("buildActionEnvelope -- shell decomposition (T3 helpers)", () => {
  test("a compound Bash command is split into subcommands", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "ls && rm -rf /tmp/x" }), ctx());
    expect(envelope.shellSubcommands).toEqual(["ls", "rm -rf /tmp/x"]);
  });

  test("a redirect target is captured separately from subcommands", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "echo hi > out.txt" }), ctx());
    expect(envelope.shellRedirectTargets).toEqual(["out.txt"]);
  });

  test("a non-Bash call has neither field", () => {
    const envelope = buildActionEnvelope(call("Edit", { file_path: "/work/x" }), ctx());
    expect(envelope.shellSubcommands).toBeUndefined();
    expect(envelope.shellRedirectTargets).toBeUndefined();
  });

  test("an unparseable Bash command yields no subcommands rather than throwing", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "echo 'unterminated" }), ctx());
    expect(envelope.shellSubcommands).toBeUndefined();
  });
});

describe("buildActionEnvelope -- boundaries (reuses ctx.specialChecks, T7's seam)", () => {
  test("protectedWrite/criticalRemoval false by default (NO_SPECIAL_CHECKS)", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "rm -rf /" }), ctx());
    expect(envelope.boundaries).toEqual({ protectedWrite: false, criticalRemoval: false });
  });

  test("protectedWrite true + criticalRemoval + reason surfaced when specialChecks flags them", () => {
    const specialChecks: SpecialChecks = {
      isProtectedWrite: () => true,
      isCriticalRemoval: () => ({ critical: true, reason: "root fs" }),
    };
    const envelope = buildActionEnvelope(call("Bash", { command: "rm -rf /" }), ctx({ specialChecks }));
    expect(envelope.boundaries).toEqual({ protectedWrite: true, criticalRemoval: true, criticalReason: "root fs" });
  });
});

describe("buildActionEnvelope -- resolved paths + symlink targets (T4 helpers)", () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    // realpath the freshly-created dir BEFORE use -- on macOS, os.tmpdir() lives under /var, which
    // is itself a symlink to /private/var; skipping this makes every "no symlink" assertion below
    // spuriously see a symlink (paths.test.ts's own documented mkdtemp/realpath-the-base convention).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-envelope-")));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("Read's file_path is resolved (absolute, no symlink)", () => {
    withTempDir((dir) => {
      const target = join(dir, "real.txt");
      writeFileSync(target, "x");
      const envelope = buildActionEnvelope(call("Read", { file_path: target }), ctx({ cwd: dir }));
      expect(envelope.resolvedPaths).toEqual([{ path: target, resolvedTarget: target, isSymlink: false }]);
    });
  });

  test("a symlinked Read target resolves to its real target, isSymlink true", () => {
    withTempDir((dir) => {
      const real = join(dir, "real.txt");
      const link = join(dir, "link.txt");
      writeFileSync(real, "x");
      symlinkSync(real, link);
      const envelope = buildActionEnvelope(call("Read", { file_path: link }), ctx({ cwd: dir }));
      expect(envelope.resolvedPaths).toEqual([{ path: link, resolvedTarget: real, isSymlink: true }]);
    });
  });

  test("Edit/Write file_path is resolved via the same shared extraction as evaluator.ts's SpecialChecks", () => {
    withTempDir((dir) => {
      const target = resolve(dir, "new-file.txt"); // does not exist yet -- a Write's target need not pre-exist
      const envelope = buildActionEnvelope(call("Write", { file_path: target }), ctx({ cwd: dir }));
      expect(envelope.resolvedPaths).toEqual([{ path: target, resolvedTarget: target, isSymlink: false }]);
    });
  });

  test("a relative path is resolved against ctx.cwd", () => {
    withTempDir((dir) => {
      const envelope = buildActionEnvelope(call("Read", { file_path: "./rel.txt" }), ctx({ cwd: dir }));
      expect(envelope.resolvedPaths[0]!.path).toBe(resolve(dir, "rel.txt"));
    });
  });

  test("a Bash fs-op's operand is included via extractCandidateWritePaths", () => {
    withTempDir((dir) => {
      const envelope = buildActionEnvelope(call("Bash", { command: "touch newfile.txt" }), ctx({ cwd: dir }));
      expect(envelope.resolvedPaths.map((p) => p.path)).toEqual([resolve(dir, "newfile.txt")]);
    });
  });

  test("a call with no recognized path yields an empty resolvedPaths array", () => {
    const envelope = buildActionEnvelope(call("Bash", { command: "pwd" }), ctx());
    expect(envelope.resolvedPaths).toEqual([]);
  });
});
