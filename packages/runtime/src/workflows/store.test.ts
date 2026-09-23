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
import { resolveWorkflowByName, listBuiltinWorkflows, listWorkflowsForListing, persistWorkflowScript, workflowTranscriptDir, workflowRunsDir } from "./store.ts";
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

// SV-5 fix round 3 (M-3 + I-4 + the user-tier bullet): dump-confirmed against claude's own
// `h()`/`D()`/`M()`/`b()`/`k()` workflow-discovery functions (claude CLI 2.1.250 / agent-sdk 0.3.250).
describe("resolveWorkflowByName -- fix round 3: case sensitivity, size cap, duplicate override, user tier, settingSources (M-3 / I-4)", () => {
  function scriptNamed(name: string, description = "d"): string {
    return `export const meta = { name: "${name}", description: "${description}" };\nreturn 1;`;
  }

  test("`.js` is matched CASE-SENSITIVELY -- a `.JS` file is never discovered, matching claude's un-lower-cased `endsWith(\".js\")`", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "Weird.JS"), scriptNamed("shouty"));
    const resolved = resolveWorkflowByName("shouty", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(false);
  });

  test("a script over the pinned 524288-byte cap is silently skipped, like an unreadable file", () => {
    const cwd = project();
    const oversize = `${scriptNamed("huge")}\n// ${"x".repeat(600_000)}`;
    writeFileSync(join(cwd, ".winter", "workflows", "huge.js"), oversize);
    const resolved = resolveWorkflowByName("huge", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(false);
  });

  test("a script at or under the cap still resolves", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "ok.js"), scriptNamed("fine"));
    const resolved = resolveWorkflowByName("fine", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(true);
  });

  test("a duplicate meta.name within one directory: the LATER file in sorted order overrides the earlier one (claude's own `k`/`S`)", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "a-first.js"), `export const meta = { name: "dup", description: "first" };\nreturn "first";`);
    writeFileSync(join(cwd, ".winter", "workflows", "z-last.js"), `export const meta = { name: "dup", description: "last" };\nreturn "last";`);
    const resolved = resolveWorkflowByName("dup", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.path).toBe(join(cwd, ".winter", "workflows", "z-last.js"));
    expect(resolved.source).toContain('"last"');
  });

  function userHome(): string {
    return mkdtempSync(join(tmpdir(), "winter-wf-userhome-"));
  }

  test("a user-tier workflow resolves from `<winterHome>/workflows`, UNGATED by trustedWorkspace", () => {
    const winterHome = userHome();
    mkdirSync(join(winterHome, "workflows"), { recursive: true });
    writeFileSync(join(winterHome, "workflows", "mine.js"), scriptNamed("personal"));
    const resolved = resolveWorkflowByName("personal", { cwd: "/nonexistent", trustedWorkspace: false, winterHome });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source_kind).toBe("user");
  });

  test("with no winterHome given, the user tier is simply absent -- no throw, the pre-existing project-only error", () => {
    const cwd = project();
    const resolved = resolveWorkflowByName("personal", { cwd, trustedWorkspace: true });
    expect(resolved.ok).toBe(false);
  });

  test("a PROJECT workflow overrides a USER workflow of the same meta.name (claude's own project-after-user insertion order)", () => {
    const cwd = project();
    const winterHome = userHome();
    mkdirSync(join(winterHome, "workflows"), { recursive: true });
    writeFileSync(join(winterHome, "workflows", "shared.js"), `export const meta = { name: "shared", description: "d" };\nreturn "user";`);
    writeFileSync(join(cwd, ".winter", "workflows", "shared.js"), `export const meta = { name: "shared", description: "d" };\nreturn "project";`);
    const resolved = resolveWorkflowByName("shared", { cwd, trustedWorkspace: true, winterHome });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.source_kind).toBe("project");
    expect(resolved.source).toContain('"project"');
  });

  test("I-4: settingSources excluding \"project\" refuses the project tier even in a TRUSTED workspace", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const resolved = resolveWorkflowByName("build", { cwd, trustedWorkspace: true, settingSources: ["user"] });
    expect(resolved.ok).toBe(false);
  });

  test("I-4: settingSources excluding \"user\" refuses the user tier even when winterHome is given", () => {
    const winterHome = userHome();
    mkdirSync(join(winterHome, "workflows"), { recursive: true });
    writeFileSync(join(winterHome, "workflows", "mine.js"), scriptNamed("personal"));
    const resolved = resolveWorkflowByName("personal", { cwd: "/nonexistent", trustedWorkspace: false, winterHome, settingSources: ["project"] });
    expect(resolved.ok).toBe(false);
  });

  test("settingSources undefined allows every tier, matching claude's own default", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const resolved = resolveWorkflowByName("build", { cwd, trustedWorkspace: true, settingSources: undefined });
    expect(resolved.ok).toBe(true);
  });
});

describe("listWorkflowsForListing -- SV-5's three listing surfaces feed off this (fix round 3)", () => {
  function scriptNamed(name: string, description: string): string {
    return `export const meta = { name: "${name}", description: "${description}" };\nreturn 1;`;
  }

  test("lists project, user and plugin workflows together, plugin entries qualified as <plugin>:<meta.name>", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const winterHome = mkdtempSync(join(tmpdir(), "winter-wf-listing-home-"));
    mkdirSync(join(winterHome, "workflows"), { recursive: true });
    writeFileSync(join(winterHome, "workflows", "mine.js"), scriptNamed("personal", "Mine"));
    const pluginDir = mkdtempSync(join(tmpdir(), "winter-wf-listing-plugin-"));
    mkdirSync(join(pluginDir, "workflows"), { recursive: true });
    writeFileSync(join(pluginDir, "workflows", "flow-file.js"), scriptNamed("sv-flow", "Runs the flow"));

    const listing = listWorkflowsForListing({
      cwd,
      trustedWorkspace: true,
      winterHome,
      pluginWorkflows: [{ name: "sv-plugin", workflowsPath: join(pluginDir, "workflows") }],
    });

    expect(listing).toContainEqual({ name: "build", description: "Builds", source: "project" });
    expect(listing).toContainEqual({ name: "personal", description: "Mine", source: "user" });
    expect(listing).toContainEqual({ name: "sv-plugin:sv-flow", description: "Runs the flow", source: "plugin" });
  });

  test("an untrusted workspace excludes the project entry but keeps user and plugin", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const listing = listWorkflowsForListing({ cwd, trustedWorkspace: false });
    expect(listing.find((w) => w.name === "build")).toBeUndefined();
  });

  test("I-4: settingSources gates the listing exactly like resolution", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "build.js"), SCRIPT);
    const listing = listWorkflowsForListing({ cwd, trustedWorkspace: true, settingSources: ["user"] });
    expect(listing.find((w) => w.name === "build")).toBeUndefined();
  });

  test("a project entry overrides a same-named user entry -- one listing row, tagged \"project\"", () => {
    const cwd = project();
    const winterHome = mkdtempSync(join(tmpdir(), "winter-wf-listing-collision-"));
    mkdirSync(join(winterHome, "workflows"), { recursive: true });
    writeFileSync(join(winterHome, "workflows", "shared.js"), scriptNamed("shared", "from user"));
    writeFileSync(join(cwd, ".winter", "workflows", "shared.js"), scriptNamed("shared", "from project"));
    const listing = listWorkflowsForListing({ cwd, trustedWorkspace: true, winterHome });
    const rows = listing.filter((w) => w.name === "shared");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: "shared", description: "from project", source: "project" });
  });

  test("entries are sorted by name within the user/project group", () => {
    const cwd = project();
    writeFileSync(join(cwd, ".winter", "workflows", "zeta.js"), scriptNamed("zeta", "z"));
    writeFileSync(join(cwd, ".winter", "workflows", "alpha.js"), scriptNamed("alpha", "a"));
    const listing = listWorkflowsForListing({ cwd, trustedWorkspace: true });
    const names = listing.map((w) => w.name);
    expect(names.indexOf("alpha")).toBeLessThan(names.indexOf("zeta"));
  });

  test("no plugins, no winterHome, no project dir contents -- an empty listing, never a throw", () => {
    const cwd = project();
    expect(listWorkflowsForListing({ cwd, trustedWorkspace: true })).toEqual([]);
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
