// WS-21 §6.3 item 2 (F17): the `rules/` loader (user + project tiers), `paths:` semantics, and the
// conditional-rule on-touch attachment producer.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderMessage } from "../engine.ts";
import { attachmentMessage } from "./attachments.ts";
import { announcedRulePaths, conditionalRuleAttachmentProducer, loadRules, ruleMatches, type LoadedRule } from "./rules.ts";

const BRAND = { projectDirName: ".winter" };

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeRule(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

describe("loadRules: tiers and source gating", () => {
  test("a user unconditional rule is loaded", () => {
    const home = mkTemp("rules-home-");
    const cwd = mkTemp("rules-cwd-");
    writeRule(join(home, "rules"), "style.md", "Always use tabs.");
    const { unconditional, conditional } = loadRules({ home, cwd, projectRoot: null, sources: ["user"], brand: BRAND });
    expect(unconditional.map((r) => r.content)).toEqual(["Always use tabs."]);
    expect(conditional).toEqual([]);
  });

  test("none without `user`", () => {
    const home = mkTemp("rules-home-");
    const cwd = mkTemp("rules-cwd-");
    writeRule(join(home, "rules"), "style.md", "Always use tabs.");
    const { unconditional, conditional } = loadRules({ home, cwd, projectRoot: null, sources: [], brand: BRAND });
    expect(unconditional).toEqual([]);
    expect(conditional).toEqual([]);
  });

  test("a project rule only with `project`", () => {
    const home = mkTemp("rules-home-");
    const repo = mkTemp("rules-repo-");
    writeRule(join(repo, ".winter", "rules"), "proj.md", "Project convention.");
    const withProject = loadRules({ home, cwd: repo, projectRoot: repo, sources: ["project"], brand: BRAND });
    expect(withProject.unconditional.map((r) => r.content)).toEqual(["Project convention."]);
    const withoutProject = loadRules({ home, cwd: repo, projectRoot: repo, sources: ["user"], brand: BRAND });
    expect(withoutProject.unconditional).toEqual([]);
  });

  test("a project rule with no projectRoot never loads, even when `project` is on", () => {
    const home = mkTemp("rules-home-");
    const cwd = mkTemp("rules-cwd-");
    writeRule(join(cwd, ".winter", "rules"), "proj.md", "never seen");
    const { unconditional } = loadRules({ home, cwd, projectRoot: null, sources: ["project"], brand: BRAND });
    expect(unconditional).toEqual([]);
  });
});

describe("loadRules: `paths:` frontmatter splits unconditional from conditional", () => {
  test("a `paths:` rule is CONDITIONAL; a plain rule is UNCONDITIONAL", () => {
    const home = mkTemp("rules-home-");
    const cwd = mkTemp("rules-cwd-");
    writeRule(join(home, "rules"), "plain.md", "Always on.");
    writeRule(join(home, "rules"), "scoped.md", "---\npaths: [src/**]\n---\nOnly for src.");
    const { unconditional, conditional } = loadRules({ home, cwd, projectRoot: null, sources: ["user"], brand: BRAND });
    expect(unconditional.map((r) => r.content)).toEqual(["Always on."]);
    expect(conditional).toHaveLength(1);
    expect(conditional[0]!.content).toBe("Only for src.");
    expect(conditional[0]!.paths).toEqual(["src/**"]);
  });
});

describe("ruleMatches: F17's `paths:` anchoring", () => {
  test("a user `paths: [\"src/**\"]` matches `<cwd>/src/a.ts` and not `<cwd>/../x/src/a.ts`", () => {
    const cwd = mkTemp("rules-cwd-");
    const rule: LoadedRule = { path: "/rules/scoped.md", tier: "user", content: "c", paths: ["src/**"] };
    expect(ruleMatches(rule, join(cwd, "src", "a.ts"), cwd)).toBe(true);
    expect(ruleMatches(rule, join(cwd, "..", "x", "src", "a.ts"), cwd)).toBe(false);
  });

  test("a pattern starting with `..` never matches (F17)", () => {
    const cwd = mkTemp("rules-cwd-");
    const rule: LoadedRule = { path: "/rules/escape.md", tier: "user", content: "c", paths: ["../secrets/**"] };
    expect(ruleMatches(rule, join(cwd, "..", "secrets", "key.pem"), cwd)).toBe(false);
  });

  test("an unconditional rule (no `paths:`) never matches anything", () => {
    const cwd = mkTemp("rules-cwd-");
    const rule: LoadedRule = { path: "/rules/plain.md", tier: "user", content: "c" };
    expect(ruleMatches(rule, join(cwd, "src", "a.ts"), cwd)).toBe(false);
  });

  test("a project base is the parent of `.winter`", () => {
    const repo = mkTemp("rules-repo-");
    writeRule(join(repo, ".winter", "rules"), "scoped.md", "---\npaths: [lib/**]\n---\nlib only");
    const { conditional } = loadRules({ home: mkTemp("rules-home-"), cwd: repo, projectRoot: repo, sources: ["project"], brand: BRAND });
    expect(conditional).toHaveLength(1);
    const rule = conditional[0]!;
    expect(rule.projectBase).toBe(repo);
    // matched relative to `repo` (the parent of `repo/.winter`), regardless of `originalCwd`:
    expect(ruleMatches(rule, join(repo, "lib", "a.ts"), "/somewhere/else")).toBe(true);
    expect(ruleMatches(rule, join(repo, "other", "a.ts"), "/somewhere/else")).toBe(false);
  });
});

describe("loadRules: symlinks (F6/F17: 'Symlinked files anywhere are accepted' for user rules)", () => {
  test("a symlinked external user rule is loaded", () => {
    const home = mkTemp("rules-home-");
    const cwd = mkTemp("rules-cwd-");
    const external = mkTemp("rules-external-");
    const target = join(external, "shared.md");
    writeFileSync(target, "Shared external rule.", "utf8");
    mkdirSync(join(home, "rules"), { recursive: true });
    symlinkSync(target, join(home, "rules", "shared.md"));
    const { unconditional } = loadRules({ home, cwd, projectRoot: null, sources: ["user"], brand: BRAND });
    expect(unconditional.map((r) => r.content)).toEqual(["Shared external rule."]);
  });

  test("a dangling rule symlink is skipped without an error", () => {
    const home = mkTemp("rules-home-");
    const cwd = mkTemp("rules-cwd-");
    mkdirSync(join(home, "rules"), { recursive: true });
    symlinkSync(join(home, "rules", "nowhere.md"), join(home, "rules", "ghost.md"));
    const { unconditional, conditional } = loadRules({ home, cwd, projectRoot: null, sources: ["user"], brand: BRAND });
    expect(unconditional).toEqual([]);
    expect(conditional).toEqual([]);
  });
});

describe("conditionalRuleAttachmentProducer: on-touch, exactly once", () => {
  function readToolUse(filePath: string): ProviderMessage {
    return { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: filePath } }] };
  }

  test("the producer emits a conditional rule on the first matching Read, and only once", async () => {
    const cwd = mkTemp("rules-cwd-");
    const rule: LoadedRule = { path: "/rules/scoped.md", tier: "user", content: "Only for src.", paths: ["src/**"] };
    const producer = conditionalRuleAttachmentProducer([rule], { originalCwd: cwd });

    // No touch yet: nothing produced.
    const messagesBefore: ProviderMessage[] = [{ role: "user", content: "hi" }];
    expect(await producer({ phase: "turn-start", messages: messagesBefore, sessionId: "s1" })).toEqual([]);

    // A Read of a matching file: the rule is produced.
    const messages: ProviderMessage[] = [...messagesBefore, readToolUse(join(cwd, "src", "a.ts"))];
    const produced = await producer({ phase: "tool-round", messages, sessionId: "s1" });
    expect(produced).toEqual([{ type: "conditional_rule", path: "/rules/scoped.md", content: "Only for src." }]);

    // Persist it into the history exactly as the engine would, then scan again: nothing more.
    const withAttachment = [...messages, attachmentMessage(produced[0]!)!];
    expect(announcedRulePaths(withAttachment).has("/rules/scoped.md")).toBe(true);
    const second = await producer({ phase: "tool-round", messages: withAttachment, sessionId: "s1" });
    expect(second).toEqual([]);
  });

  test("a Read of a non-matching file produces nothing", async () => {
    const cwd = mkTemp("rules-cwd-");
    const rule: LoadedRule = { path: "/rules/scoped.md", tier: "user", content: "Only for src.", paths: ["src/**"] };
    const producer = conditionalRuleAttachmentProducer([rule], { originalCwd: cwd });
    const messages: ProviderMessage[] = [readToolUse(join(cwd, "docs", "readme.md"))];
    expect(await producer({ phase: "tool-round", messages, sessionId: "s1" })).toEqual([]);
  });
});
