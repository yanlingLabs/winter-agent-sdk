// A spawned runtime whose PARENT (the host) dies stops, with its tool subprocesses, within a bound --
// while a parent that merely closes the input (print mode, `end_input`) still gets its turn finished, a
// DETACHED batch run (stdin from a file) is never stopped by its launcher exiting, and a host that exits
// after its last result still lets a `SessionEnd` command hook finish.
//
// The parent here is a real intermediate process (a tiny bun script) that spawns the runtime with piped
// stdin/stdout, sends the prompt, answers permission prompts and stays alive; the test SIGKILLs it once
// the runtime is provably mid-turn (its Bash tool has written its pid). Both legs: `bun main.ts` (the
// same engine the compiled binary runs) and the compiled `winter` itself when it has been built
// (`build:runtime --platform-package`).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, splitFrames, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const COMPILED = fileURLToPath(new URL("../../platform/darwin-arm64/bin/winter", import.meta.url));
/** The bound the brief sets (2 s), widened for a loaded CI runner's polling. */
const STOP_BOUND_MS = 4_000;

const TEMP: string[] = [];
afterAll(() => {
  for (const d of TEMP) rmSync(d, { recursive: true, force: true });
});
function tempDir(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `winter-parent-death-${label}-`));
  TEMP.push(d);
  return d;
}

const LEGS: Array<[string, string[]]> = [["bun main.ts", [process.execPath, MAIN]]];
if (existsSync(COMPILED)) LEGS.push(["the compiled winter", [COMPILED]]);

/** Alive and not a zombie (Linux: `/proc/<pid>/stat`'s state field; macOS reaps an orphan's zombie at once). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no /proc (macOS)
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

function sessionArgs(dir: string): string[] {
  const config = {
    sessionId: crypto.randomUUID(),
    cwd: dir,
    model: "winter-test/calls",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    sandbox: { enabled: false },
  };
  return ["--run", "--config-json", JSON.stringify(config)];
}

const runtimeEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1", ...extra });

/** A Bash call that records its own pid in `pidFile`, then becomes a 300 s sleep -- a turn that would run for minutes. */
const hangingTool = (pidFile: string): string => `CALL Bash ${JSON.stringify({ command: `echo $$ > ${pidFile}; exec sleep 300` })}`;

/**
 * Starts the intermediate parent: it spawns the runtime (`command` + session args, piped stdio), sends
 * `prompt`, answers permission prompts, prints the runtime's pid, and stays alive -- or, with
 * `exitAfterResult`, exits on its own once it has read a result (a host that is simply done).
 */
async function startViaParent(command: string[], dir: string, prompt: string, opts: { exitAfterResult?: boolean; env?: Record<string, string> } = {}) {
  const parentScript = join(dir, "parent.ts");
  writeFileSync(
    parentScript,
    `const child = Bun.spawn(${JSON.stringify([...command, ...sessionArgs(dir)])}, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: ${JSON.stringify(runtimeEnv(dir, opts.env))} });
child.stdin.write(${JSON.stringify(encodeFrame({ type: "user", text: prompt }))});
child.stdin.flush();
console.log(String(child.pid));
(async () => {
  let carry = "";
  for await (const chunk of child.stdout) {
    const lines = (carry + new TextDecoder().decode(chunk)).split("\\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line);
      if (frame.type === "control_request" && frame.subtype === "permission") {
        child.stdin.write(JSON.stringify({ type: "control_response", requestId: frame.requestId, ok: true, payload: { behavior: "allow", updatedInput: frame.payload.input } }) + "\\n");
        child.stdin.flush();
      }
      if (${opts.exitAfterResult === true} && frame.type === "data" && frame.message.type === "result") process.exit(0);
    }
  }
})();
setInterval(() => {}, 1000);
`,
  );
  const parent = Bun.spawn([process.execPath, parentScript], { stdout: "pipe", stderr: "inherit" });
  const first = await parent.stdout.getReader().read();
  const runtimePid = Number(new TextDecoder().decode(first.value).trim());
  const cleanup = (): void => {
    parent.kill("SIGKILL");
    try {
      process.kill(runtimePid, "SIGKILL");
    } catch {
      /* gone, as it should be */
    }
  };
  return { parent, runtimePid, cleanup };
}

const toolPidIn = (pidFile: string): Promise<boolean> => until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 15_000);

describe.each(LEGS)("the parent dies mid-turn (%s)", (_label, command) => {
  test("the runtime and its tool's subprocess are gone within the bound", async () => {
    const dir = tempDir("kill");
    const pidFile = join(dir, "tool.pid");
    const { parent, runtimePid, cleanup } = await startViaParent(command, dir, hangingTool(pidFile));
    expect(Number.isInteger(runtimePid) && runtimePid > 1).toBe(true);
    try {
      expect(await toolPidIn(pidFile)).toBe(true); // mid-turn: the tool is running
      const toolPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(toolPid)).toBe(true);
      parent.kill("SIGKILL");
      const killedAt = Date.now();
      expect(await until(() => !alive(runtimePid) && !alive(toolPid), STOP_BOUND_MS)).toBe(true);
      expect(Date.now() - killedAt).toBeLessThanOrEqual(STOP_BOUND_MS);
    } finally {
      cleanup();
    }
  }, 30_000);

  test("a host pid stated in WINTER_HOST_PID that is NOT this runtime's parent reads as a dead host: it stops", async () => {
    const dir = tempDir("hostpid");
    const pidFile = join(dir, "tool.pid");
    // Some live process that is not the runtime's parent: the host the runtime was told about is "gone".
    const other = Bun.spawn(["sleep", "30"]);
    const { runtimePid, cleanup } = await startViaParent(command, dir, hangingTool(pidFile), { env: { WINTER_HOST_PID: String(other.pid) } });
    try {
      expect(await until(() => !alive(runtimePid), STOP_BOUND_MS + 2_000)).toBe(true);
    } finally {
      other.kill("SIGKILL");
      cleanup();
    }
  }, 30_000);

  test("WINTER_DISABLE_PARENT_WATCH=1 opts out: the runtime outlives its parent", async () => {
    const dir = tempDir("optout");
    const pidFile = join(dir, "tool.pid");
    const { parent, runtimePid, cleanup } = await startViaParent(command, dir, hangingTool(pidFile), { env: { WINTER_DISABLE_PARENT_WATCH: "1" } });
    try {
      expect(await toolPidIn(pidFile)).toBe(true);
      parent.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 1_500));
      expect(alive(runtimePid)).toBe(true);
    } finally {
      cleanup();
      try {
        process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }, 30_000);

  test("a host that reads its last result and exits: a SessionEnd command hook still runs to completion", async () => {
    const dir = tempDir("sessionend");
    const done = join(dir, "hook.done");
    // The user settings tier carries the hook: 1.5 s, longer than the watch interval and the mid-turn grace.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: `sleep 1.5; echo ok > ${done}` }] }] } }));
    const { runtimePid, cleanup } = await startViaParent(command, dir, "just answer", { exitAfterResult: true });
    try {
      expect(await until(() => existsSync(done), 10_000)).toBe(true);
      expect(await until(() => !alive(runtimePid), 5_000)).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);
});

describe.each(LEGS)("a DETACHED batch run (%s)", (_label, command) => {
  test("`nohup … < in.ndjson > out.ndjson & sleep 0.5; exit` -- its launcher exiting never stops it", async () => {
    const dir = tempDir("nohup");
    const input = join(dir, "in.ndjson");
    const output = join(dir, "out.ndjson");
    writeFileSync(input, encodeFrame({ type: "user", text: `CALL Bash ${JSON.stringify({ command: "sleep 1.6; echo batch-finished" })}` }));
    const quoted = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;
    const line = `nohup ${[...command, ...sessionArgs(dir)].map(quoted).join(" ")} < ${quoted(input)} > ${quoted(output)} 2>/dev/null & sleep 0.5; exit`;
    const launcher = Bun.spawn(["sh", "-c", line], { env: runtimeEnv(dir), stdout: "ignore", stderr: "ignore" });
    await launcher.exited;
    const finished = (): boolean => existsSync(output) && readFileSync(output, "utf8").includes('"type":"result"');
    expect(await until(finished, 20_000)).toBe(true);
    const results = readFileSync(output, "utf8")
      .split("\n")
      .filter((l) => l.includes('"type":"result"'))
      .map((l) => (JSON.parse(l) as { message: Record<string, unknown> }).message);
    expect(results).toHaveLength(1);
    expect(results[0]!["interrupted"]).toBeUndefined();
    expect(String(results[0]!["result"])).toContain("batch-finished");
  }, 30_000);
});

/** Spawns the runtime from THIS (live) process, sends `frames`, closes stdin, and reads every frame to EOF. */
async function runWithLiveParent(command: string[], frames: WinterFrame[]): Promise<{ frames: WinterFrame[]; code: number | null }> {
  const dir = tempDir("live");
  const child = Bun.spawn([...command, ...sessionArgs(dir)], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: runtimeEnv(dir) });
  for (const frame of frames) child.stdin.write(encodeFrame(frame));
  child.stdin.end();
  const out: WinterFrame[] = [];
  let carry = "";
  for await (const chunk of child.stdout) {
    const split = splitFrames(new TextDecoder().decode(chunk), carry);
    carry = split.carry;
    out.push(...split.frames);
  }
  return { frames: out, code: await child.exited };
}

const resultsOf = (frames: WinterFrame[]): Array<Record<string, unknown>> =>
  frames.flatMap((f) => (f.type === "data" && (f as { message: { type: string } }).message.type === "result" ? [(f as { message: Record<string, unknown> }).message] : []));

describe.each(LEGS)("a LIVE parent that closes the input still gets its turn finished (%s)", (_label, command) => {
  // Longer than the watch interval and the stop grace together: a watcher misfiring on EOF would cut it.
  const slowTool = `CALL Bash ${JSON.stringify({ command: "sleep 1.6; echo finished-turn" })}`;

  test("print mode: the prompt, then stdin closes (no end_input) -- the turn completes", async () => {
    const run = await runWithLiveParent(command, [{ type: "user", text: slowTool }]);
    const results = resultsOf(run.frames);
    expect(results).toHaveLength(1);
    expect(results[0]!["interrupted"]).toBeUndefined();
    expect(String(results[0]!["result"])).toContain("finished-turn");
    expect(run.code).toBe(0);
  }, 30_000);

  test("a graceful end_input: the last turn still completes", async () => {
    const run = await runWithLiveParent(command, [
      { type: "user", text: slowTool },
      { type: "control_request", requestId: "end", subtype: "end_input", payload: undefined },
    ]);
    const results = resultsOf(run.frames);
    expect(results).toHaveLength(1);
    expect(String(results[0]!["result"])).toContain("finished-turn");
    expect(run.code).toBe(0);
  }, 30_000);
});
