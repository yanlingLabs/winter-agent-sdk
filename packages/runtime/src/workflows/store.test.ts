// Phase 5 Lane W (task 4): name resolution (WS-11 §1.3) and script persistence (§1.3 + capture (3)).
//
// The persistence assertions are checked against the REAL `isWorkflowScriptCarveOut` predicate, not
// a re-spelled path literal: P5-B's carve-out is what makes the documented edit-then-rerun loop
// possible, and its shape is exact ("six fixed positions, exactly two wildcards"). A persister that
// wrote one segment off would leave every script unwritable, and a test that re-declared the path
// would agree with itself and miss it.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkflowByName, listBuiltinWorkflows, persistWorkflowScript, workflowTranscriptDir, workflowRunsDir } from "./store.ts";
import { isWorkflowScriptCarveOut, isProtectedWrite } from "../permissions/protected.ts";

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "winter-wf-store-"));
  mkdirSync(join(cwd, ".winter", "workflows"), { recursive: true });
  return cwd;
}

const SCRIPT = `export const meta = { name: "build", description: "Builds" };\nreturn 1;`;

describe("resolveWorkflowByName -- `.winter/workflows/<name>.js` (WS-11 §1.3)", () => {
  test("resolves a project workflow and returns its SOURCE and path", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const resolved = resolveWorkflowByName("build", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe(SCRIPT);
    expect(resolved.path).toBe(join(cwd, ".winter", "workflows", "build.js"));
  });

  test("an unknown name is a typed failure naming the directory it looked in -- never a throw", () => {
    const cwd = project();
    const resolved = resolveWorkflowByName("nope", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("nope");
    expect(resolved.error).toContain(".winter/workflows");
  });

  test("the name is SLUG-GUARDED before any filesystem call -- traversal can never reach outside the directory", () => {
    const cwd = project();
    writeFileSync(join(cwd, "escaped.js"), SCRIPT);
    for (const bad of ["../escaped", "a/b", ".", "..", "a.b", "", "with space"]) {
      const resolved = resolveWorkflowByName(bad, { cwd, trustedWorkspace: true });
      expect(resolved.ok).toBe(false);
    }
  });

  test("the project directory is TRUST-GATED -- an untrusted workspace resolves nothing (R4-7's treatment of project-supplied executable definitions)", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    expect(resolveWorkflowByName("build", { cwd, trustedWorkspace: true }).ok).toBe(true);
    const untrusted = resolveWorkflowByName("build", { cwd, trustedWorkspace: false });
    expect(untrusted.ok).toBe(false);
    if (untrusted.ok) return;
    expect(untrusted.error).toContain("trust");
  });

  test("a directory named `<name>.js` is not a workflow", () => {
    const cwd = project();
    mkdirSync(join(cwd, ".winter", "workflows", "dir.js"));
    expect(resolveWorkflowByName("dir", { cwd, trustedWorkspace: true }).ok).toBe(false);
  });

  test("the BUILT-IN registry is EMPTY -- Winter ships no built-in workflows (WS-01 forbids invented names)", () => {
    expect(listBuiltinWorkflows()).toEqual([]);
  });

  test("a built-in is consulted BEFORE the filesystem, so the empty registry changes nothing today", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    expect(resolveWorkflowByName("build", { cwd, trustedWorkspace: true, builtins: { build: "return 'builtin';" } })).toEqual({
      ok: true,
      source: "return 'builtin';",
      path: undefined,
      source_kind: "builtin",
    });
  });
});

// WS-21 §6.3 item 1, corrected in the batch-2 fix round: `PluginBundle.workflowsPath` was resolved
// by L1b's loader but had no consumer. Naming/loading now matches the PINNED BINARY exactly (claude
// CLI 2.1.250 / agent-sdk 0.3.250 -- confirmed via its own disassembled workflow-discovery module,
// not claude-code-reference, which has no "workflows" concept at all): a plugin workflow's identity
// is `${pluginName}:${meta.name}`, where `meta.name` is the SCRIPT'S OWN parsed meta block (via
// `parseWorkflowMeta`, this file's own `SCRIPT` fixture declares `meta.name: "build"`) -- NEVER the
// filename, the same way claude's `v()` builds `` `${plugin}:${r.meta.name}` `` after a lightweight,
// non-executing meta parse (`Kp(e, {validateBody: false})`), not a filename join. A file whose meta
// fails to parse is silently skipped (claude's own "has invalid meta ... skipping"), not an error.
// DELIBERATELY UNGATED by `trustedWorkspace` (a plugin is loaded because the host/user already
// decided to, matching every other plugin resource in this codebase).
describe("resolveWorkflowByName -- plugin workflows (WS-21 §6.3 item 1, batch-2 fix round: meta.name identity)", () => {
  function pluginDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "winter-wf-plugin-"));
    mkdirSync(join(dir, "workflows"), { recursive: true });
    return dir;
  }

  test("a plugin workflow resolves by <plugin>:<meta.name> -- the SCRIPT's own declared name, not its filename", () => {
    const dir = pluginDir();
    // The filename ("ship.js") deliberately differs from the script's own meta.name ("build",
    // SCRIPT's fixture value) -- proving resolution reads the file's CONTENT, not its path.
    writeFileSync(join(dir, "workflows", "ship.js"), SCRIPT);
    const resolved = resolveWorkflowByName("mypkg:build", {
      cwd: "/nonexistent",
      trustedWorkspace: false,
      pluginWorkflows: [{ name: "mypkg", workflowsPath: join(dir, "workflows") }],
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source).toBe(SCRIPT);
    expect(resolved.path).toBe(join(dir, "workflows", "ship.js"));
    expect(resolved.source_kind).toBe("plugin");
  });

  test("the plugin workflow's own FILENAME does not resolve it -- identity is meta.name only", () => {
    const dir = pluginDir();
    writeFileSync(join(dir, "workflows", "ship.js"), SCRIPT); // meta.name is "build", not "ship"
    const resolved = resolveWorkflowByName("mypkg:ship", { cwd: "/x", trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg", workflowsPath: join(dir, "workflows") }] });
    expect(resolved.ok).toBe(false);
  });

  test("a plugin workflow file with an INVALID meta block is silently skipped, matching claude's own 'has invalid meta -- skipping'", () => {
    const dir = pluginDir();
    writeFileSync(join(dir, "workflows", "broken.js"), "export const meta = { name: someIdentifier };\nreturn 1;"); // not a pure literal
    writeFileSync(join(dir, "workflows", "ship.js"), SCRIPT); // meta.name "build", still resolvable
    const broken = resolveWorkflowByName("mypkg:someIdentifier", { cwd: "/x", trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg", workflowsPath: join(dir, "workflows") }] });
    expect(broken.ok).toBe(false);
    const stillWorks = resolveWorkflowByName("mypkg:build", { cwd: "/x", trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg", workflowsPath: join(dir, "workflows") }] });
    expect(stillWorks.ok).toBe(true);
  });

  test("an unknown plugin name is a typed failure, never a throw", () => {
    const resolved = resolveWorkflowByName("nosuch:build", { cwd: "/x", trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg", workflowsPath: "/whatever" }] });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("nosuch");
  });

  test("a plugin present but with no workflowsPath is a typed failure, never a throw", () => {
    const resolved = resolveWorkflowByName("mypkg:build", { cwd: "/x", trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg" }] });
    expect(resolved.ok).toBe(false);
  });

  test("with no pluginWorkflows given at all, a qualified name is a typed failure (pre-fix-round-2 callers unaffected)", () => {
    const resolved = resolveWorkflowByName("mypkg:build", { cwd: "/x", trustedWorkspace: true });
    expect(resolved.ok).toBe(false);
  });

  test("an unknown meta.name within a known plugin is a typed failure naming the plugin", () => {
    const dir = pluginDir();
    writeFileSync(join(dir, "workflows", "ship.js"), SCRIPT);
    const resolved = resolveWorkflowByName("mypkg:nope", { cwd: "/x", trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg", workflowsPath: join(dir, "workflows") }] });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("mypkg");
  });

  test("a bare (unqualified) name still resolves against the project directory exactly as before -- the qualified branch never intercepts it", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const resolved = resolveWorkflowByName("build", { cwd, trustedWorkspace: true, pluginWorkflows: [{ name: "mypkg", workflowsPath: "/whatever" }] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source_kind).toBe("project");
  });
});

describe("persistWorkflowScript -- capture (3)'s durable location, and P5-B's carve-out", () => {
  function home(): string {
    return mkdtempSync(join(tmpdir(), "winter-wf-home-"));
  }
  const keys = { projectKey: "-synthetic-workspace", sessionId: "11111111-2222-3333-4444-555555555555" };

  test("the path is `<home>/projects/<key>/<session-uuid>/workflows/scripts/<meta.name>-<runId>.js`", () => {
    const winterHome = home();
    const path = persistWorkflowScript({ winterHome, ...keys, name: "build", runId: "wf_ab12", source: SCRIPT });
    expect(path).toBe(join(winterHome, "projects", keys.projectKey, keys.sessionId, "workflows", "scripts", "build-wf_ab12.js"));
    expect(readFileSync(path, "utf8")).toBe(SCRIPT);
  });

  test("the persisted path is INSIDE P5-B's model-writable carve-out -- asserted with the real predicate, so the edit-then-rerun loop actually works", () => {
    const winterHome = home();
    const path = persistWorkflowScript({ winterHome, ...keys, name: "build", runId: "wf_ab12", source: SCRIPT });
    // The carve-out is rooted at `<home>/.winter/projects/...`, so the winterHome this resolves
    // against is the `.winter` directory's PARENT.
    const path2 = persistWorkflowScript({ winterHome: join(winterHome, ".winter"), ...keys, name: "b", runId: "wf_1", source: SCRIPT });
    expect(isWorkflowScriptCarveOut(path2, winterHome)).toBe(true);
    expect(isProtectedWrite(path2, { cwd: "/anywhere", home: winterHome })).toBe(false);
    // ... while a sibling under the same session area is still protected.
    expect(isProtectedWrite(join(winterHome, ".winter", "projects", keys.projectKey, `${keys.sessionId}.jsonl`), { cwd: "/anywhere", home: winterHome })).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("a meta name with path characters is SANITIZED -- the filename can never climb out of the scripts directory", () => {
    const winterHome = home();
    const path = persistWorkflowScript({ winterHome, ...keys, name: "../../escape", runId: "wf_1", source: SCRIPT });
    expect(path.startsWith(join(winterHome, "projects", keys.projectKey, keys.sessionId, "workflows", "scripts"))).toBe(true);
    expect(path).not.toContain("..");
  });

  test("directories are created 0700, like every other Winter-owned tree (WS-05 §9)", () => {
    const winterHome = home();
    const path = persistWorkflowScript({ winterHome, ...keys, name: "b", runId: "wf_1", source: SCRIPT });
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  test("re-persisting the same run OVERWRITES -- an edited script re-invoked by `scriptPath` keeps one path", () => {
    const winterHome = home();
    const first = persistWorkflowScript({ winterHome, ...keys, name: "b", runId: "wf_1", source: SCRIPT });
    const second = persistWorkflowScript({ winterHome, ...keys, name: "b", runId: "wf_1", source: "return 2;" });
    expect(second).toBe(first);
    expect(readFileSync(first, "utf8")).toBe("return 2;");
  });

  test("the transcript directory is the sibling capture (3) recorded: `<session>/subagents/workflows/<runId>`", () => {
    const winterHome = home();
    expect(workflowTranscriptDir({ winterHome, ...keys, runId: "wf_1" })).toBe(
      join(winterHome, "projects", keys.projectKey, keys.sessionId, "subagents", "workflows", "wf_1"),
    );
  });

  test("the JOURNAL root is session-TEMP, not the durable area -- resume is same-session-only by contract and WS-01 forbids an invented durable name", () => {
    expect(workflowRunsDir("/tmp/winter-abc/session-temp")).toBe(join("/tmp/winter-abc/session-temp", "workflows", "runs"));
  });
});
