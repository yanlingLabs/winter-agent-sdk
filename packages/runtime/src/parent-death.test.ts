// A spawned runtime whose PARENT dies mid-turn stops, with its tool subprocesses, within a bound --
// while a parent that merely closes the input (print mode, `end_input`) still gets its turn finished.
//
// The parent here is a real intermediate process (a tiny bun script) that spawns the runtime with piped
// stdin/stdout, sends the prompt and stays alive; the test SIGKILLs it once the runtime is provably
// mid-turn (its Bash tool has written its pid). Both legs: `bun main.ts` (the same engine the compiled
// binary runs) and the compiled `winter` itself when it has been built (`build:runtime --platform-package`).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, splitFrames, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const COMPILED = fileURLToPath(new URL("../../platform/darwin-arm64/bin/winter", import.meta.url));
/** The bound the brief sets (2 s), plus this test's own polling slack. */
const STOP_BOUND_MS = 2_500;

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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

const runtimeEnv = (home: string): Record<string, string> => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, WINTER_HOME: home, WINTER_DISABLE_GIT_INSTRUCTIONS: "1" });

describe.each(LEGS)("the parent dies mid-turn (%s)", (_label, command) => {
  test("the runtime and its tool's subprocess are gone within the bound", async () => {
    const dir = tempDir("kill");
    const pidFile = join(dir, "tool.pid");
    // The tool: records its own pid, then becomes a 300 s sleep -- a turn that would run for minutes.
    const prompt = `CALL Bash ${JSON.stringify({ command: `echo $$ > ${pidFile}; exec sleep 300` })}`;
    const parentScript = join(dir, "parent.ts");
    writeFileSync(
      parentScript,
      `const child = Bun.spawn(${JSON.stringify([...command, ...sessionArgs(dir)])}, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: ${JSON.stringify(runtimeEnv(dir))} });
child.stdin.write(${JSON.stringify(encodeFrame({ type: "user", text: prompt }))});
child.stdin.flush();
console.log(String(child.pid));
// A host: answers every permission request with allow.
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
    }
  }
})();
setInterval(() => {}, 1000);
`,
    );
    const parent = Bun.spawn([process.execPath, parentScript], { stdout: "pipe", stderr: "inherit" });
    const reader = parent.stdout.getReader();
    const first = await reader.read();
    const runtimePid = Number(new TextDecoder().decode(first.value).trim());
    expect(Number.isInteger(runtimePid) && runtimePid > 1).toBe(true);
    try {
      // Mid-turn: the tool is running.
      expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 15_000)).toBe(true);
      const toolPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(toolPid)).toBe(true);

      parent.kill("SIGKILL");
      const killedAt = Date.now();
      expect(await until(() => !alive(runtimePid) && !alive(toolPid), STOP_BOUND_MS)).toBe(true);
      expect(Date.now() - killedAt).toBeLessThanOrEqual(STOP_BOUND_MS);
    } finally {
      parent.kill("SIGKILL");
      try {
        process.kill(runtimePid, "SIGKILL");
      } catch {
        /* gone, as it should be */
      }
    }
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
