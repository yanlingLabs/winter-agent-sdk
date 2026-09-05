// Phase 5 Lane S slice 4 (WS-11 §2.3, derived-shapes-p5 item (i)): the Skill EXECUTOR.
//
// `{ skill, args? }` in; the RESOLVED SKILL BODY out as the tool result, plus the Winter-defined
// `invoked_skills` attachment payload. One tool for every skill -- never one tool per skill.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillIndex, PROJECT_PLUGIN_NAME } from "../../skills/store.ts";
import { registerSkillSessionRuntime, clearSkillSessionRuntime } from "../../skills/runtime.ts";
import { INVOKED_SKILLS_ATTACHMENT_TYPE, type InvokedSkillsAttachment } from "../../skills/attachment.ts";
import { skillExecutor, SKILL_TOOL_NAME } from "./skill.ts";
import type { ToolExecutionContext } from "../registry.ts";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
const sessions: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of sessions.splice(0)) clearSkillSessionRuntime(s);
});

function ctx(sessionId: string): ToolExecutionContext {
  return {
    cwd: "/nowhere",
    home: "/nowhere",
    sessionId,
    readState: { markRead: () => {}, hasRead: () => false } as unknown as ToolExecutionContext["readState"],
    emitFrame: () => {},
    permissions: { probeReadAccess: () => "silent" as const },
    tempDir: "/nowhere",
    sandboxSettings: {} as ToolExecutionContext["sandboxSettings"],
    session: {
      setCwd() {},
      addBoundedRoot() {},
      removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => "/nowhere",
      setSessionRoot() {},
    },
  };
}

function fixture(opts?: { skills?: string[] | "all"; overrides?: Record<string, string> }): { sessionId: string; attachments: InvokedSkillsAttachment[]; repo: string } {
  const repo = mkTemp("winter-skillexec-repo-");
  const winterHome = mkTemp("winter-skillexec-home-");
  for (const name of ["review", "lint"]) {
    const dir = join(repo, ".winter", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} desc\n---\n\nINSTRUCTIONS FOR ${name.toUpperCase()}`, "utf8");
  }
  const index = SkillIndex.build({ cwd: repo, winterHome });
  const attachments: InvokedSkillsAttachment[] = [];
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  sessions.push(sessionId);
  registerSkillSessionRuntime(sessionId, {
    index,
    ...(opts?.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts?.overrides !== undefined ? { skillOverrides: opts.overrides } : {}),
    onInvoked: (a) => attachments.push(a),
  });
  return { sessionId, attachments, repo };
}

describe("skillExecutor: the happy path", () => {
  test("the RESOLVED BODY is the tool result -- not a pointer, not a summary", async () => {
    const { sessionId } = fixture();
    const result = await skillExecutor.execute({ skill: "review" }, ctx(sessionId));
    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("INSTRUCTIONS FOR REVIEW");
  });

  test("an alias resolves to the same body", async () => {
    const { sessionId } = fixture();
    expect((await skillExecutor.execute({ skill: `${PROJECT_PLUGIN_NAME}:review` }, ctx(sessionId))).output).toBe("INSTRUCTIONS FOR REVIEW");
  });

  test("the `invoked_skills` attachment is emitted with the resolved identity, source, path and args", async () => {
    const { sessionId, attachments, repo } = fixture();
    await skillExecutor.execute({ skill: "review", args: "src/main.ts" }, ctx(sessionId));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.type).toBe(INVOKED_SKILLS_ATTACHMENT_TYPE);
    expect(attachments[0]!.skills).toEqual([
      {
        name: "review",
        source: "project",
        path: join(repo, ".winter", "skills", "review", "SKILL.md"),
        args: "src/main.ts",
        bodyBytes: Buffer.byteLength("INSTRUCTIONS FOR REVIEW", "utf8"),
      },
    ]);
  });

  test("the tool door does NOT substitute `$ARGUMENTS` -- deliberate and capture-pending (fix round 1, Minor 3)", async () => {
    // The `/name args` door DOES substitute (commands/resolver.ts, R5-14). This door hands the body
    // over verbatim and reports `args` on the attachment instead, because item (i) found NO `Skill`
    // tool schema in the pinned declaration at all -- what `args` means here is uncaptured, and
    // substituting would be Winter inventing a semantic on the door a MODEL drives. Pinned so the
    // asymmetry is a decision, and so a later capture that overturns it fails loudly here.
    const repo = mkTemp("winter-argsdoor-repo-");
    const winterHome = mkTemp("winter-argsdoor-home-");
    const dir = join(repo, ".winter", "skills", "tmpl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: tmpl\ndescription: d\n---\n\nReview [$ARGUMENTS] now.", "utf8");
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    sessions.push(sessionId);
    const seen: InvokedSkillsAttachment[] = [];
    registerSkillSessionRuntime(sessionId, { index: SkillIndex.build({ cwd: repo, winterHome }), onInvoked: (a) => seen.push(a) });
    const result = await skillExecutor.execute({ skill: "tmpl", args: "src/main.ts" }, ctx(sessionId));
    expect(result.output).toBe("Review [$ARGUMENTS] now.");
    expect(seen[0]!.skills[0]!.args).toBe("src/main.ts");
  });

  test("no `args` means the attachment omits the field entirely", async () => {
    const { sessionId, attachments } = fixture();
    await skillExecutor.execute({ skill: "review" }, ctx(sessionId));
    expect(attachments[0]!.skills[0]).not.toHaveProperty("args");
  });

  test("a failed invocation emits NO attachment -- the record is of what actually entered the conversation", async () => {
    const { sessionId, attachments } = fixture();
    await skillExecutor.execute({ skill: "nope" }, ctx(sessionId));
    expect(attachments).toEqual([]);
  });
});

describe("skillExecutor: typed refusals, never a throw", () => {
  test("no session runtime registered is a wiring error that says so", async () => {
    const result = await skillExecutor.execute({ skill: "review" }, ctx("never-registered"));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no skill runtime");
  });

  test("a malformed input is a typed input error", async () => {
    const { sessionId } = fixture();
    for (const bad of [null, {}, { skill: 5 }, { skill: "review", args: 7 }]) {
      const result = await skillExecutor.execute(bad, ctx(sessionId));
      expect(result.isError).toBe(true);
    }
  });

  test("a name that could traverse is refused BEFORE any filesystem lookup", async () => {
    const { sessionId } = fixture();
    const result = await skillExecutor.execute({ skill: "../../etc/passwd" }, ctx(sessionId));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not a valid skill name");
  });

  test("an unknown skill names the known ones", async () => {
    const { sessionId } = fixture();
    const result = await skillExecutor.execute({ skill: "missing" }, ctx(sessionId));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("review");
  });

  test("a skill outside this session's `skills` option is refused, and the option is named", async () => {
    const { sessionId } = fixture({ skills: ["review"] });
    const ok = await skillExecutor.execute({ skill: "review" }, ctx(sessionId));
    expect(ok.isError).toBeUndefined();
    const refused = await skillExecutor.execute({ skill: "lint" }, ctx(sessionId));
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("skills");
  });

  test('`skillOverrides` "off" and "user-invocable-only" both refuse a MODEL invocation', async () => {
    const { sessionId } = fixture({ overrides: { review: "off", lint: "user-invocable-only" } });
    expect((await skillExecutor.execute({ skill: "review" }, ctx(sessionId))).isError).toBe(true);
    expect((await skillExecutor.execute({ skill: "lint" }, ctx(sessionId))).isError).toBe(true);
  });

  test("a skill deleted from disk after indexing is a typed error, not a crash", async () => {
    const { sessionId, repo } = fixture();
    rmSync(join(repo, ".winter", "skills", "review"), { recursive: true, force: true });
    const result = await skillExecutor.execute({ skill: "review" }, ctx(sessionId));
    expect(result.isError).toBe(true);
  });
});

describe("skillExecutor: registration", () => {
  test("the executor is installed over the descriptor stub under the pinned tool name", () => {
    expect(SKILL_TOOL_NAME).toBe("Skill");
  });

  test("a CHILD resolves its OWN runtime by agentId, never the parent's", async () => {
    const parent = fixture();
    const child = fixture({ skills: [] });
    const asChild = { ...ctx(parent.sessionId), agentId: child.sessionId };
    const result = await skillExecutor.execute({ skill: "review" }, asChild);
    expect(result.isError).toBe(true); // the CHILD's own empty skills option decided this
  });
});
