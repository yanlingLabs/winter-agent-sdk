import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@yanlinglabs/winter-agent-sdk";
import { copyHostCodeProtection, currentHostCodeProtectionPaths, hostCodePathAllowed, installHostCodeProtection, type HostCodeProtectionLease } from "./host-code-protection.ts";
import { runCommand } from "./spawn.ts";
import { spawnEmbeddedWorker, type EmbeddedWorkerProcess } from "../embedded-host.ts";
import { createSessionReadState } from "../tools/read-state.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../tools/registry.ts";
import "../tools/impl/read.ts";
import "../tools/impl/write.ts";
import "../tools/impl/edit.ts";
import "../tools/impl/glob.ts";
import "../tools/impl/grep.ts";
import "../tools/impl/notebook-edit.ts";

const roots: string[] = [], leases: HostCodeProtectionLease[] = [];
afterEach(() => { for (const lease of leases.splice(0)) lease.close(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-code-protection-"))); roots.push(dir);
  const cowork = join(dir, "cowork"), control = join(cowork, "control"), shared = join(cowork, "shared"), source = join(dir, "source");
  for (const path of [control, shared, source]) mkdirSync(path, { recursive: true });
  const data = join(control, "data.ext4"), ordinary = join(source, "ordinary.txt"), sharedFile = join(shared, "note.txt");
  for (const path of [data, ordinary, sharedFile]) writeFileSync(path, "synthetic-policy-needle");
  const policy = { revision: 1, denyReadPaths: [control], denyWritePaths: [cowork] };
  const readState = createSessionReadState({ cwd: source });
  const ctx: ToolExecutionContext = { cwd: source, home: dir, sandboxSettings: {}, readState, permissions: { probeReadAccess: () => "silent" }, sessionId: "fixture", tempDir: join(dir, "temp"), emitFrame() {},
    session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [source], getPermissionMode: () => "default", getSessionRoot: () => source, setSessionRoot() {} } };
  const execute = (name: string, input: unknown) => getRegisteredTool(name)!.executor!.execute(input, ctx);
  return { dir, cowork, control, shared, source, data, ordinary, sharedFile, policy, ctx, execute };
}
function enroll(value: Parameters<typeof installHostCodeProtection>[0]) { const lease = installHostCodeProtection(value); leases.push(lease); return lease; }

test("trusted snapshot bounds/revisions are copied and one owner cannot remove another", () => {
  const f = fixture(), paths = [f.control];
  const first = enroll({ revision: 1, denyReadPaths: paths, denyWritePaths: [] }); paths.length = 0;
  expect(hostCodePathAllowed(f.data, "read")).toBe(false);
  const second = enroll({ revision: 1, denyReadPaths: [], denyWritePaths: [f.cowork] });
  first.update({ revision: 2, denyReadPaths: [], denyWritePaths: [] });
  expect(hostCodePathAllowed(f.data, "read")).toBe(true);
  expect(hostCodePathAllowed(f.data, "write")).toBe(false);
  expect(() => second.update({ revision: 0, denyReadPaths: [], denyWritePaths: [] })).toThrow("stale");
  expect(() => second.update({ revision: 1, denyReadPaths: [], denyWritePaths: [] })).toThrow("conflicting");
  expect(() => copyHostCodeProtection({ revision: 1, denyReadPaths: ["relative"], denyWritePaths: [] })).toThrow("path");
  expect(() => copyHostCodeProtection({ revision: 1, denyReadPaths: ["/"], denyWritePaths: [] })).toThrow("path");
  first.close(); second.close(); second.close();
  expect(() => second.update(f.policy)).toThrow("closed");
  expect(currentHostCodeProtectionPaths()).toEqual({ denyReadPaths: [], denyWritePaths: [] });
});

test("actual Read/Write/Edit/NotebookEdit refuse protected paths while ordinary/shared reads work", async () => {
  const f = fixture(); enroll(f.policy);
  for (const input of [f.data, f.data + " "]) expect((await f.execute("Read", { file_path: input })).isError).toBe(true);
  expect((await f.execute("Read", { file_path: f.sharedFile })).output).toContain("synthetic-policy-needle");
  expect((await f.execute("Write", { file_path: join(f.shared, "new.txt"), content: "blocked" })).isError).toBe(true);
  expect(existsSync(join(f.shared, "new.txt"))).toBe(false);
  f.ctx.readState.recordRead(f.data, { complete: true, mtimeMs: statSync(f.data).mtimeMs });
  expect((await f.execute("Edit", { file_path: f.data, old_string: "synthetic", new_string: "changed" })).isError).toBe(true);
  const notebook = join(f.control, "data.ipynb"); writeFileSync(notebook, '{"cells":[{"id":"cell","cell_type":"code","source":["old"]}]}');
  expect((await f.execute("NotebookEdit", { notebook_path: notebook, cell_id: "cell", new_source: "changed" })).isError).toBe(true);
  expect((await f.execute("Write", { file_path: join(f.source, "new.txt"), content: "ordinary" })).isError).toBeUndefined();
  expect(readFileSync(f.data, "utf8")).toBe("synthetic-policy-needle");
});

test("canonical, case aliases and dangling symlinks cannot bypass the SDK file checks", async () => {
  const f = fixture(); enroll(f.policy);
  const alias = join(f.source, "alias.txt"), dangling = join(f.source, "dangling.txt");
  symlinkSync(f.data, alias); symlinkSync(join(f.control, "not-yet-created.txt"), dangling);
  expect((await f.execute("Read", { file_path: alias })).isError).toBe(true);
  expect((await f.execute("Write", { file_path: dangling, content: "blocked" })).isError).toBe(true);
  expect(existsSync(join(f.control, "not-yet-created.txt"))).toBe(false);
  if (process.platform === "darwin") expect(hostCodePathAllowed(f.data.toUpperCase(), "read")).toBe(false);
});

test("actual broad Glob/Grep retain shared/ordinary matches and prune protected paths", async () => {
  const f = fixture(); enroll(f.policy);
  for (const [tool, input] of [["Glob", { pattern: "**/*", path: f.dir }], ["Grep", { pattern: "synthetic-policy-needle", path: f.dir, output_mode: "files_with_matches" }]] as const) {
    const result = await f.execute(tool, input);
    expect(result.isError).toBeUndefined(); expect(result.output).toContain(f.ordinary); expect(result.output).toContain(f.sharedFile); expect(result.output).not.toContain(f.data);
  }
  expect((await f.execute("Grep", { pattern: "synthetic", path: f.data })).isError).toBe(true);
});

test("absolute glob policy protects VM backing names and leaves shared files readable", () => {
  const f = fixture(); enroll({ revision: 1, denyReadPaths: [join(f.cowork, "**", "*.ext4")], denyWritePaths: [] });
  expect(hostCodePathAllowed(f.data, "read")).toBe(false); expect(hostCodePathAllowed(f.sharedFile, "read")).toBe(true);
});

test("literal brackets in a protected host directory do not turn it into an ineffective glob", async () => {
  const f = fixture(), dir = join(f.cowork, "literal[1]"), file = join(dir, "control.txt"); mkdirSync(dir); writeFileSync(file, "synthetic-policy-needle");
  enroll({ revision: 1, denyReadPaths: [dir], denyWritePaths: [dir] });
  expect(hostCodePathAllowed(file, "read")).toBe(false);
  expect((await f.execute("Read", { file_path: file })).isError).toBe(true);
  if (process.platform === "darwin") {
    const result = await runCommand({ command: `/bin/cat '${file}'`, cwd: f.source, home: f.dir, env: { PATH: "/usr/bin:/bin", HOME: f.dir }, timeoutMs: 2000, settings: {} });
    expect(result.exitCode).not.toBe(0);
  }
});

test("live revision changes affect next ordinary Bash profile, while approved escapes retain main behavior", async () => {
  const f = fixture(), lease = enroll({ revision: 0, denyReadPaths: [], denyWritePaths: [] });
  const run = (escape: boolean) => runCommand({ command: `/bin/cat '${f.data}'`, cwd: f.source, env: { PATH: "/usr/bin:/bin", HOME: f.dir }, timeoutMs: 2000, settings: {}, home: f.dir, writableRoots: [f.source], ...(escape ? { dangerouslyDisableSandbox: true } : {}) });
  if (process.platform === "darwin") {
    expect((await run(false)).exitCode).toBe(0);
    lease.update(f.policy);
    expect((await run(false)).exitCode).not.toBe(0);
  } else lease.update(f.policy);
  const escaped = await run(true); expect(escaped.exitCode).toBe(0); expect(escaped.posture).toBe("override-requested"); expect(escaped.profile).toBeUndefined();
});

test("actual active Worker acknowledges live policy before Write without restarting session", async () => {
  const f = fixture(); let proc: EmbeddedWorkerProcess | undefined, applied = false, staleRefused = false;
  const messages: unknown[] = [];
  for await (const message of query({ prompt: f.ordinary, options: { model: "winter-test/p5checkpoint", cwd: f.source, persistSession: false,
    env: { WINTER_HOME: join(f.dir, "run-home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_HOST_CODE_PROTECTION: "disabled" },
    canUseTool: async (name, input) => {
      if (name === "Write") {
        expect(proc).toBeDefined();
        expect(await proc!.updateHostCodeProtection({ revision: 1, denyReadPaths: [f.ordinary], denyWritePaths: [f.ordinary] })).toBe(1);
        try { await proc!.updateHostCodeProtection({ revision: 0, denyReadPaths: [], denyWritePaths: [] }); }
        catch (error) { staleRefused = error instanceof Error && error.message.includes("refused"); }
        expect(await proc!.updateHostCodeProtection({ revision: 1, denyReadPaths: [f.ordinary], denyWritePaths: [f.ordinary] })).toBe(1);
        applied = true;
      }
      return { behavior: "allow", updatedInput: input };
    },
    spawnClaudeCodeProcess(resolved) {
      const args = [...resolved.args], at = args.indexOf("--config-json"), config = JSON.parse(args[at + 1]!);
      config.hostCodeProtection = { revision: 999, denyReadPaths: [], denyWritePaths: [] }; args[at + 1] = JSON.stringify(config);
      proc = spawnEmbeddedWorker({ workerEntry: join(import.meta.dir, "..", "embedded-worker.ts"), spawn: { ...resolved, args }, hostCodeProtection: { revision: 0, denyReadPaths: [], denyWritePaths: [] } });
      return proc;
    } } })) messages.push(message);
  expect(applied).toBe(true); expect(staleRefused).toBe(true); expect(readFileSync(f.ordinary, "utf8")).toBe("synthetic-policy-needle");
  const results = messages.filter(message => (message as { type?: string }).type === "user");
  expect(JSON.stringify(results[0])).toContain("synthetic-policy-needle"); expect(JSON.stringify(results[1])).toContain("protected host path access refused");
  await proc!.exited;
  await expect(proc!.updateHostCodeProtection({ revision: 2, denyReadPaths: [], denyWritePaths: [] })).rejects.toThrow("unavailable");
}, 30_000);

test("pre-start update is retained and initial snapshot mutation cannot weaken held Worker startup", async () => {
  const f = fixture(); let start!: () => void;
  const held = new Promise<void>(resolve => { start = resolve; });
  const reads = [f.data];
  const proc = spawnEmbeddedWorker({ workerEntry: join(import.meta.dir, "..", "embedded-worker.ts"), startAfter: held,
    hostCodeProtection: { revision: 1, denyReadPaths: reads, denyWritePaths: [] },
    spawn: { command: "winter", args: ["--run", "--config-json", JSON.stringify({ sessionId: "held-fixture", cwd: f.source, model: "winter-test/readimage", persistSession: false, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true })], cwd: f.source,
      env: { WINTER_HOME: join(f.dir, "home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_TEST_READ_IMAGE: f.data } } });
  reads.length = 0;
  let out = "", err = "";
  const drained = Promise.all([(async () => { for await (const chunk of proc.stdout) out += chunk; })(), (async () => { for await (const chunk of proc.stderr!) err += chunk; })()]);
  try {
    expect(await proc.updateHostCodeProtection({ revision: 2, denyReadPaths: [f.control], denyWritePaths: [f.cowork] })).toBe(2);
    proc.stdin.write(JSON.stringify({ type: "user", text: "fixture" }) + "\n");
    proc.stdin.write(JSON.stringify({ type: "control_request", requestId: "end", subtype: "end_input" }) + "\n");
    start();
    await drained;
    expect((await proc.exited).code, err).toBe(0);
    expect(out).toContain("protected host path access refused"); expect(out).not.toContain("synthetic-policy-needle");
  } finally { proc.kill(); proc.terminate(); await proc.exited; }
}, 30_000);
