import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMandatoryFloorToSpawnOptions, createMandatoryFloorSpawn, MandatoryFloorUnavailableError, query, type SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
import { spawnEmbeddedWorker } from "../embedded-host.ts";
import { runEmbeddedSession } from "../embedded.ts";
import { requireHostCodeProcessBroker, hostCodeProcessBrokerRequired, installHostCodeProcessClient, type HostCodeProcessClient } from "./host-code-process.ts";
import { runCommand, SandboxUnavailableError } from "./spawn.ts";
import { runEngine } from "../engine.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "winter-host-floor-enrollment-")));
  dirs.push(dir);
  const marker = join(dir, "must-not-execute");
  return { dir, marker, options: { command: "/bin/sh", args: [], cwd: dir, env: {} } satisfies SpawnRuntimeOptions };
}

test("required native enrollment refuses missing/empty registration before the spawner runs", () => {
  let launches = 0;
  const spawn = () => { launches++; throw new Error("unexpected launch"); };
  expect(() => createMandatoryFloorSpawn({ spawn, requireHostFloor: true })).toThrow(MandatoryFloorUnavailableError);
  expect(() => createMandatoryFloorSpawn({ spawn, requireHostFloor: true, floor: { denyReadPaths: [], denyWritePaths: [] } })).toThrow(MandatoryFloorUnavailableError);
  expect(() => applyMandatoryFloorToSpawnOptions({ ...fixture().options, requireHostFloor: true })).toThrow(MandatoryFloorUnavailableError);
  expect(launches).toBe(0);
});

test("required floor refuses embedded Worker construction and cannot be ignored by a wrapped spawner", () => {
  const f = fixture();
  let constructed = 0;
  const createWorker = () => { constructed++; throw new Error("unexpected Worker"); };
  expect(() => spawnEmbeddedWorker({ workerEntry: "unused", spawn: f.options, requireHostFloor: true, createWorker })).toThrow(MandatoryFloorUnavailableError);
  expect(() => spawnEmbeddedWorker({ workerEntry: "unused", spawn: { ...f.options, requireHostFloor: true }, createWorker })).toThrow(MandatoryFloorUnavailableError);
  // A Worker transport ignores command/argv resolution. Catch existing native wrappers too.
  expect(() => spawnEmbeddedWorker({ workerEntry: "unused", spawn: { ...f.options, command: "/usr/bin/sandbox-exec" }, createWorker })).toThrow(MandatoryFloorUnavailableError);
  if (process.platform === "darwin") {
    const spawn = createMandatoryFloorSpawn({ floor: { denyReadPaths: [join(f.dir, "protected")], denyWritePaths: [] }, requireHostFloor: true,
      spawn: resolved => spawnEmbeddedWorker({ workerEntry: "unused", spawn: resolved, createWorker }) });
    expect(() => spawn(f.options)).toThrow("embedded Workers");
  }
  expect(constructed).toBe(0);
});

test("required direct embedded session refuses before parsing config or consuming input", async () => {
  const f = fixture();
  let inputRead = false;
  let errors = "";
  const outcomes: unknown[] = [];
  const code = await runEmbeddedSession({ requireHostFloor: true, argv: ["malformed"], env: { WINTER_HOME: join(f.dir, "uncreated-home") },
    input: { [Symbol.asyncIterator]() { inputRead = true; throw new Error("unexpected input"); } }, write() { throw new Error("unexpected output"); },
    writeErr(chunk) { errors += chunk; }, onProtectedStoreOwnershipOutcome(outcome) { outcomes.push(outcome); } });
  expect(code).toBe(1);
  expect(errors).toContain("MandatoryFloorUnavailableError");
  expect(errors).not.toContain("missing --run");
  expect(inputRead).toBe(false);
  expect(existsSync(join(f.dir, "uncreated-home"))).toBe(false);
  expect(outcomes).toEqual([{ status: "not-acquired", reason: "not-requested", scope: null }]);
});

test("missing broker refuses every ordinary/escape posture without executing the command", async () => {
  const f = fixture();
  const release = requireHostCodeProcessBroker();
  const restore = installHostCodeProcessClient(undefined);
  try {
    const command = `touch '${f.marker}'`;
    for (const intent of [ { settings: { enabled: false } }, { settings: {}, dangerouslyDisableSandbox: true },
      { settings: { excludedCommands: [command], allowUnsandboxedCommands: true } }, { settings: {} } ]) {
      await expect(runCommand({ command, cwd: f.dir, env: {}, timeoutMs: 1000, ...intent })).rejects.toThrow("no local execution fallback");
      expect(existsSync(f.marker)).toBe(false);
    }
  } finally { restore(); release(); }
});

test("broker removal cannot remove host enrollment; nested ownership releases are idempotent", async () => {
  const f = fixture();
  const outer = requireHostCodeProcessBroker();
  const inner = requireHostCodeProcessBroker();
  const client: HostCodeProcessClient = {
    async start() { throw new Error("host offline"); }, async poll() { throw new Error("unexpected poll"); },
    async write() {}, async signal() {}, async release() {},
  };
  const restore = installHostCodeProcessClient({ client, generationId: "fixture-generation" });
  try {
    await expect(runCommand({ command: `touch '${f.marker}'`, cwd: f.dir, env: {}, timeoutMs: 1000, settings: { enabled: false },
      hostCodeScope: { sessionId: "fixture-session", toolUseId: "fixture-call" } })).rejects.toBeInstanceOf(SandboxUnavailableError);
    restore();
    inner(); inner();
    expect(hostCodeProcessBrokerRequired()).toBe(true);
    await expect(runCommand({ command: `touch '${f.marker}'`, cwd: f.dir, env: {}, timeoutMs: 1000, settings: { enabled: false } })).rejects.toThrow("no local execution fallback");
    expect(existsSync(f.marker)).toBe(false);
  } finally { restore(); inner(); outer(); }
  expect(hostCodeProcessBrokerRequired()).toBe(false);
  const ordinary = await runCommand({ command: "printf standalone", cwd: f.dir, env: {}, timeoutMs: 1000, settings: { enabled: false } });
  expect(ordinary.exitCode).toBe(0);
});

test("broker requirement is removed after a session startup failure", async () => {
  const f = fixture();
  const code = await runEmbeddedSession({ brokerRequired: true, argv: [], env: { WINTER_HOME: f.dir }, input: (async function* () {})(), write() {}, writeErr() {} });
  expect(code).toBe(1);
  expect(hostCodeProcessBrokerRequired()).toBe(false);
});

test("real Worker Bash honors host enrollment despite serialized/env attempts to remove it", async () => {
  const f = fixture();
  const messages: unknown[] = [];
  for await (const message of query({ prompt: "fixture", options: { model: "winter-test/lanec", cwd: f.dir,
    persistSession: false, sandbox: { enabled: false }, env: { WINTER_HOME: join(f.dir, "home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1", WINTER_BROKER_REQUIRED: "false" },
    spawnClaudeCodeProcess(resolved) {
      const at = resolved.args.indexOf("--config-json");
      const config = JSON.parse(resolved.args[at + 1]!);
      config.brokerRequired = false;
      config.requireHostFloor = false;
      const args = [...resolved.args]; args[at + 1] = JSON.stringify(config);
      return spawnEmbeddedWorker({ workerEntry: join(import.meta.dir, "..", "embedded-worker.ts"), spawn: { ...resolved, args }, brokerRequired: true });
    } } })) messages.push(message);
  const results = messages.filter((m): m is { type: string; message: { content: unknown } } => typeof m === "object" && m !== null && (m as { type?: string }).type === "user");
  expect(results).toHaveLength(1);
  expect(JSON.stringify(results[0])).toContain("required host Code broker unavailable; no local execution fallback");
  expect(JSON.stringify(results[0])).toContain('"is_error":true');
  expect(JSON.stringify(results[0])).not.toContain("winter-t8-lanec");
}, 30_000);

test("every brokered engine retains enrollment after client removal and releases after teardown", async () => {
  const f = fixture();
  const { host, runtime } = createInMemoryChannel();
  let observed = false;
  const completion = runEngine({ config: { sessionId: "fixture-engine", cwd: f.dir, model: "winter-test/echo", persistSession: false,
    hostCodeProcessBroker: { generationId: "fixture-generation" } },
    input: runtime.input, output: runtime.output, env: { WINTER_HOME: join(f.dir, "home"), WINTER_DISABLE_GIT_INSTRUCTIONS: "1" },
    provider: scriptedProvider([{ kind: "tool_use", calls: [{ id: "fixture-call", name: "Bash", input: { command: "echo fixture" } }] }, { kind: "text", text: "done" }]),
    tools: { async execute() {
      observed = true;
      expect(hostCodeProcessBrokerRequired()).toBe(true);
      const restore = installHostCodeProcessClient(undefined);
      try {
        await expect(runCommand({ command: `touch '${f.marker}'`, cwd: f.dir, env: {}, timeoutMs: 1000, settings: { enabled: false } })).rejects.toThrow("no local execution fallback");
        return { output: "fixture refused" };
      } finally { restore(); }
    } } });
  host.output.write({ type: "user", text: "fixture" });
  host.output.write({ type: "control_request", requestId: "fixture-end", subtype: "end_input", payload: undefined });
  for await (const _frame of host.input) {}
  expect(await completion).toBe(0);
  expect(observed).toBe(true);
  expect(existsSync(f.marker)).toBe(false);
  expect(hostCodeProcessBrokerRequired()).toBe(false);
});
