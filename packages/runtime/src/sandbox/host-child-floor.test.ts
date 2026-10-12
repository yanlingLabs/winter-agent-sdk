import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { MandatoryFloorUnavailableError, query, type HostExecutionFloor } from "@yanlinglabs/winter-agent-sdk";
import { installHostChildFloor, prepareHostChildLaunch, currentHostChildFloorProfile } from "./host-child-floor.ts";
import { createCommandHookInvoker } from "../hooks/command-invoker.ts";
import { WinterStdioTransport } from "../mcp/transports/stdio.ts";
import { runCommand } from "./spawn.ts";
import { buildWorkerSpawn } from "../workflows/sandbox.ts";
import { runGit } from "../tools/impl/enter-worktree.ts";
import { spawnEmbeddedWorker } from "../embedded-host.ts";
import { prepareImageForModel } from "../tools/image-prep.ts";
import { realPng } from "../tools/image-test-fixtures.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-child-floor-"))); dirs.push(dir);
  const protectedDir = join(dir, "protected"), source = join(dir, "source");
  mkdirSync(protectedDir); mkdirSync(source);
  const secret = join(protectedDir, "synthetic.txt"), allowed = join(source, "ordinary.txt");
  writeFileSync(secret, "synthetic-floor-needle"); writeFileSync(allowed, "ordinary");
  const floor: HostExecutionFloor = { denyReadPaths: [protectedDir], denyWritePaths: [protectedDir] };
  return { dir, protectedDir, source, secret, allowed, floor };
}
function execute(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => execFile(command, args, { cwd, env, timeout: 2000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve({ ok: err === null, stdout: String(stdout) })));
}

test("absent registration preserves normal executable/argv and empty registration fails closed", () => {
  expect(prepareHostChildLaunch("git", ["status"])).toEqual({ command: "git", args: ["status"] });
  expect(() => installHostChildFloor({ denyReadPaths: [], denyWritePaths: [] })).toThrow(MandatoryFloorUnavailableError);
  expect(currentHostChildFloorProfile()).toBeUndefined();
});

describe.skipIf(process.platform !== "darwin")("native floor on actual embedded subprocess families", () => {
  test("registration snapshots paths and survives nesting without out-of-order removal", async () => {
    const f = fixture();
    const paths = [f.protectedDir];
    const outer = installHostChildFloor({ denyReadPaths: paths, denyWritePaths: [] });
    paths.length = 0;
    const inner = installHostChildFloor(f.floor);
    try {
      expect(() => outer()).toThrow("overlapped");
      inner(); inner();
      const launch = prepareHostChildLaunch("/bin/cat", [f.secret], { cwd: f.source });
      expect((await execute(launch.command, launch.args, f.source)).ok).toBe(false);
      expect(currentHostChildFloorProfile()).toBeDefined();
    } finally { inner(); outer(); }
    expect(currentHostChildFloorProfile()).toBeUndefined();
  });

  test("actual PATH-resolved native child cannot read/write protected data and can use ordinary files", async () => {
    const f = fixture();
    const release = installHostChildFloor(f.floor);
    try {
      const env = { PATH: "/bin:/usr/bin" };
      for (const body of [`cat '${f.secret}'`, `printf changed > '${f.secret}'`]) {
        const launch = prepareHostChildLaunch("sh", ["-c", body], { cwd: f.source, env });
        expect(launch.command).toBe("/usr/bin/sandbox-exec");
        expect((await execute(launch.command, launch.args, f.source, env)).ok).toBe(false);
      }
      const launch = prepareHostChildLaunch("sh", ["-c", `cat '${f.allowed}'; printf writable > ordinary-write.txt`], { cwd: f.source, env });
      const result = await execute(launch.command, launch.args, f.source, env);
      expect(result).toEqual({ ok: true, stdout: "ordinary" });
      expect(readFileSync(join(f.source, "ordinary-write.txt"), "utf8")).toBe("writable");
      expect(readFileSync(f.secret, "utf8")).toBe("synthetic-floor-needle");
      expect(() => prepareHostChildLaunch("missing-fixture-command", [], { cwd: f.source, env })).toThrow("could not be resolved");
      expect(() => prepareHostChildLaunch("./relative", [])).toThrow("explicit absolute cwd");
    } finally { release(); }
  });

  test("Bash composes the child floor for ordinary, disabled, excluded and approved override calls", async () => {
    const f = fixture(), release = installHostChildFloor(f.floor);
    try {
      const command = `/bin/cat '${f.secret}'`;
      for (const intent of [{ settings: {} }, { settings: { enabled: false } }, { settings: {}, dangerouslyDisableSandbox: true },
        { settings: { excludedCommands: [command], allowUnsandboxedCommands: true } }]) {
        const result = await runCommand({ command, cwd: f.source, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 2000, ...intent });
        expect(result.exitCode).not.toBe(0);
        expect(result.profile).toContain(f.protectedDir);
      }
      const workflow = buildWorkerSpawn({ command: { file: process.execPath, args: ["unused"] }, home: f.dir });
      expect(workflow.file).toBe("/usr/bin/sandbox-exec");
      expect(workflow.args[1]).toContain(f.protectedDir);
    } finally { release(); }
  });

  test("actual hook shell inherits the floor and retains ordinary success behavior", async () => {
    const f = fixture(), release = installHostChildFloor(f.floor);
    const request = { event: "PreToolUse" as const, sessionId: "fixture", toolName: "Bash", toolUseID: "fixture-call", input: { command: "true" },
      policyVersion: "1", requestId: "fixture-request", hookId: "fixture-hook" };
    try {
      const denied = createCommandHookInvoker([{ id: request.hookId, event: "PreToolUse", source: "sdk", command: `/bin/cat '${f.secret}'` }],
        { cwd: f.source, env: { PATH: "/usr/bin:/bin" }, next: { async invoke() { throw new Error("unexpected delegation"); } } });
      await expect(denied.invoke(request, { signal: new AbortController().signal })).rejects.toThrow();
      const allowed = createCommandHookInvoker([{ id: request.hookId, event: "PreToolUse", source: "sdk", command: "printf '{}'" }],
        { cwd: f.source, env: { PATH: "/usr/bin:/bin" }, next: { async invoke() { throw new Error("unexpected delegation"); } } });
      expect(await allowed.invoke(request, { signal: new AbortController().signal })).toEqual({});
    } finally { release(); }
  });

  test("actual MCP stdio server is floored without changing its JSON-RPC transport", async () => {
    const f = fixture(), release = installHostChildFloor(f.floor);
    const transport = new WinterStdioTransport({ command: "/bin/sh", args: ["-c", `if /bin/cat '${f.secret}' >/dev/null 2>&1; then denied=false; else denied=true; fi; printf '{"jsonrpc":"2.0","method":"fixture","params":{"denied":%s}}\\n' "$denied"`], cwd: f.source, env: {} });
    let received!: (message: unknown) => void;
    const message = new Promise(resolve => { received = resolve; });
    transport.onmessage = received;
    try {
      await transport.start();
      expect(await message).toEqual({ jsonrpc: "2.0", method: "fixture", params: { denied: true } });
    } finally { await transport.close(); release(); }
  });

  test("Bun worktree git launch also inherits the floor", async () => {
    const f = fixture(), release = installHostChildFloor(f.floor);
    try {
      const result = await runGit(["-c", `alias.fixture=!cat '${f.secret}'`, "fixture"], f.source);
      expect(result.ok).toBe(false);
      expect(result.stdout).not.toContain("synthetic-floor-needle");
    } finally { release(); }
  });

  test("image converter process is floored and real sips still resizes ordinary fixture images", async () => {
    const f = fixture(), release = installHostChildFloor(f.floor);
    const sips = join(f.source, "fixture-sips"), leaked = join(f.source, "leaked"), launched = join(f.source, "launched");
    writeFileSync(sips, `#!/bin/sh\nif /bin/cat '${f.secret}' >/dev/null 2>&1; then /usr/bin/touch '${leaked}'; fi\n/usr/bin/touch '${launched}'\nexit 1\n`);
    chmodSync(sips, 0o755);
    try {
      const source = realPng(2000, 1800);
      const refused = await prepareImageForModel(source, { workRoot: () => join(f.dir, "image-work"), sipsPath: sips });
      // Preserve the ordinary valid-source fallback when conversion fails.
      expect(refused.ok).toBe(true);
      expect(existsSync(launched)).toBe(true);
      expect(existsSync(leaked)).toBe(false);
      const ordinary = await prepareImageForModel(source, { workRoot: () => join(f.dir, "ordinary-image-work") });
      expect(ordinary.ok).toBe(true);
      if (ordinary.ok) { expect(ordinary.width).toBe(1568); expect(ordinary.height).toBeLessThanOrEqual(1568); }
    } finally { release(); }
  });

  test("actual Worker lifecycle installs host child floor despite config/env lookalikes", async () => {
    const f = fixture();
    const messages: unknown[] = [];
    // lanec's command is fixed. An ordinary success proves the trusted registration does not
    // blanket-disable Bash; the native helper tests above prove the same registered floor denies.
    for await (const message of query({ prompt: "fixture", options: { model: "winter-test/lanec", cwd: f.source, persistSession: false,
      sandbox: { enabled: false }, env: { WINTER_HOME: join(f.dir, "home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_HOST_CHILD_FLOOR: "disabled" },
      spawnClaudeCodeProcess(resolved) {
        const args = [...resolved.args], at = args.indexOf("--config-json");
        const config = JSON.parse(args[at + 1]!); config.hostChildFloor = { denyReadPaths: [], denyWritePaths: [] }; args[at + 1] = JSON.stringify(config);
        return spawnEmbeddedWorker({ workerEntry: join(import.meta.dir, "..", "embedded-worker.ts"), spawn: { ...resolved, args }, hostChildFloor: f.floor });
      } } })) messages.push(message);
    const result = JSON.stringify(messages.filter(m => (m as { type?: string }).type === "user"));
    expect(result).toContain("winter-t8-lanec");
    expect(result).toContain("[sandbox: config-disabled]");
    expect(result).not.toContain('"is_error":true');
    expect(existsSync(f.secret)).toBe(true);
  }, 30_000);
});
