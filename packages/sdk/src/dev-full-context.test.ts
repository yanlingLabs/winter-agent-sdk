import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query } from "./query.ts";
import { inMemoryProcess } from "@yanlinglabs/winter-agent-runtime/testing";
import { recognizeEditOperation } from "../../runtime/src/permissions/edit-recognition.ts";
import { flattenSubcommands } from "../../runtime/src/permissions/shell-structure.ts";
import { isProtectedWrite } from "../../runtime/src/permissions/protected.ts";
import type { CanUseTool, PermissionMode } from "./permissions/types.ts";

// Minimal inert command text. The executor below NEVER runs Bash or any probe body.
const deviceRedirect = "printf x > /dev/full";
const appendedRelativeRedirect = 'printf fixture-only > "$phase_tmp/repo/fixture.txt"';
async function observe(command: string, colocated: boolean, mode: PermissionMode = "bypassPermissions") {
  const root = mkdtempSync(join(tmpdir(), "winter-device-analyzer-")), home = join(root, "runtime"), source = join(root, "source");
  mkdirSync(home); mkdirSync(source);
  const cwd = colocated ? home : source;
  const callbacks: Array<Parameters<CanUseTool>[2]> = [];
  let generations = 0, syntheticExecutions = 0;
  try {
    for await (const _ of query({ prompt: "source-only analyzer fixture", options: {
      cwd, env: { WINTER_HOME: home, WINTER_STORE_HOME: home }, persistSession: false, model: "winter-test/echo", tools: ["Bash"], settingSources: [],
      permissionMode: mode, allowDangerouslySkipPermissions: mode === "bypassPermissions", stderr() {},
      canUseTool: async (_tool, input, options) => { callbacks.push(options); return { behavior: "allow", updatedInput: input }; },
      spawnClaudeCodeProcess(options) { return inMemoryProcess(options.args, { async generate() {
        return generations++ === 0 ? { kind: "tool_use", calls: [{ id: "inert-bash", name: "Bash", input: { command } }] } : { kind: "text", text: "done" };
      } }, { async execute() { syntheticExecutions++; return { output: "synthetic executor: Bash NOT executed" }; } }, { WINTER_HOME: home, WINTER_STORE_HOME: home, HOME: root }); },
    } })) {}
    const candidates = recognizeEditOperation({ toolName: "Bash", input: { command } }, { home: root, sessionRoot: cwd })?.paths ?? [];
    return { colocated, parseable: flattenSubcommands(command) !== null, syntheticExecutions,
      callbacks: callbacks.map(({ blockedPath, decisionReason }) => ({ blockedPath, decisionReason })),
      candidates: candidates.map(path => ({ path, resolvesInsideProtectedHome: resolve(cwd, path).startsWith(`${home}/`) || resolve(cwd, path) === home,
        protected: isProtectedWrite(path, { cwd, home: root, winterHome: home, storeHome: home }) })) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("appended relative redirect changes the protected-home floor only in a colocated fixture", async () => {
  for (const colocated of [false, true]) {
    const before = await observe(deviceRedirect, colocated), after = await observe(`${deviceRedirect}; ${appendedRelativeRedirect}`, colocated);
    expect(before.callbacks).toHaveLength(0); expect(after.callbacks).toHaveLength(colocated ? 1 : 0);
    expect(before.syntheticExecutions).toBe(1); expect(after.syntheticExecutions).toBe(1);
    expect(before.parseable).toBe(true); expect(after.parseable).toBe(true);
    expect(after.candidates.find(candidate => candidate.path === "/dev/full")?.protected).toBe(false);
    expect(after.candidates.find(candidate => candidate.path === "$phase_tmp/repo/fixture.txt")?.protected).toBe(colocated);
  }
});

test("one ordinary relative redirect is sufficient to change the reported blocked path without changing the device", async () => {
  const command = "printf x > /dev/full; printf y > relative-target";
  const disjoint = await observe(command, false), colocated = await observe(command, true);
  expect(disjoint.callbacks).toHaveLength(0); expect(colocated.callbacks).toHaveLength(1);
  expect(colocated.callbacks[0]?.blockedPath).toBe("/dev/full");
  expect(colocated.candidates.find(candidate => candidate.path === "/dev/full")?.protected).toBe(false);
  expect(colocated.candidates.find(candidate => candidate.path === "relative-target")?.protected).toBe(true);
  expect(disjoint.parseable).toBe(true); expect(colocated.parseable).toBe(true);
});

test("device paths are classified independently from enclosing source/protected-home syntax", async () => {
  for (const device of ["null", "full", "zero", "random", "urandom"]) {
    const path = `/dev/${device}`, result = await observe(`printf x > ${path}`, false);
    expect(result.candidates.find(candidate => candidate.path === path)?.protected).toBe(false);
    expect(result.callbacks).toHaveLength(0); expect(result.syntheticExecutions).toBe(1);
    const colocated = await observe(`printf x > ${path}`, true);
    expect(colocated.candidates.find(candidate => candidate.path === path)?.protected).toBe(false);
    expect(colocated.callbacks).toHaveLength(0);
  }
});
