// The `<sandbox_violations>` block end to end on a REAL macOS Seatbelt: the Bash tool runs each
// command under real `sandbox-exec`, with a real `log stream` for its tag subscribed before it starts.
// Every probe is harmless even if it unexpectedly succeeded: a write into a temp dir this test made, a
// LaunchServices lookup of a bundle id that does not exist (`open -b`, which can launch nothing), a
// connection attempt to the discard port on loopback, and `swiftc -typecheck` of a one-line file.
// Nothing opens an app, a window or a URL. Paths are all mkdtemp-derived; no test touches the user's
// home.
//
// Skipped (visibly) where there is no Seatbelt, and where `log stream` is REFUSED (it exits non-zero,
// e.g. a non-admin account) -- there the feature degrades to no block, which violations.test.ts
// covers. A slow `log` is not a refusal: the availability probe waits as long as it takes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, existsSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundTaskMessage } from "@yanlinglabs/winter-agent-sdk";
import "../tools/impl/bash.ts";
import { getRegisteredTool, type ToolExecutionContext } from "../tools/registry.ts";
import { createSessionReadState } from "../tools/read-state.ts";
import { isSandboxAvailable, runCommand } from "./spawn.ts";
import { setViolationMonitorSpawnersForTest, VIOLATION_STREAM_MARGIN_SECONDS } from "./violations.ts";

const logStreamWorks =
  isSandboxAvailable() &&
  spawnSync("/usr/bin/log", ["stream", "--timeout", "1", "--style", "ndjson", "--predicate", 'eventMessage == "winter-sbx-availability-probe"'], { timeout: 120_000 }).status === 0;
const t = test.skipIf(!logStreamWorks);
const swiftcWorks = logStreamWorks && spawnSync("/usr/bin/xcrun", ["--find", "swiftc"], { timeout: 60_000 }).status === 0;

function dir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function ctxFor(cwd: string, overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const frames: BackgroundTaskMessage[] = [];
  return {
    cwd,
    home: "/home/test",
    sessionId: "violations",
    readState: createSessionReadState({ cwd }),
    emitFrame: (f) => frames.push(f),
    permissions: { probeReadAccess: () => "silent" },
    tempDir: dir("winter-violations-tmp-"),
    sandboxSettings: {},
    session: {
      setCwd() {},
      addBoundedRoot() {},
      removeBoundedRoot() {},
      setPermissionMode() {},
      getBoundedRoots: () => [],
      getPermissionMode: () => "default",
      getSessionRoot: () => cwd,
      setSessionRoot() {},
    },
    ...overrides,
  };
}

async function bash(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> {
  const result = await getRegisteredTool("Bash")!.executor!.execute(input, ctx);
  return result.output;
}

function blockOf(output: string): string[] | undefined {
  const match = /<sandbox_violations>\n([\s\S]*?)\n<\/sandbox_violations>/.exec(output);
  return match === null ? undefined : match[1]!.split("\n");
}

/** Live `log stream` processes for a violations tag whose parent is `parentPid` (zombies excluded). */
function violationStreamsOf(parentPid: number): number[] {
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" }).stdout;
  return ps
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && Number(m[2]) === parentPid && !m[3]!.startsWith("Z") && m[4]!.includes("log stream") && m[4]!.includes("winter-sbx-"))
    .map((m) => Number(m[1]));
}

function alive(pid: number): boolean {
  const out = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return out !== "" && !out.startsWith("Z");
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const SLOW = 30_000;

describe("the Bash tool shows a failed sandboxed command's own Seatbelt denials (real sandbox-exec + log stream)", () => {
  t(
    "a denied write: the block names the refused file-write and its path, between the output and the [exit]/[sandbox] tail",
    async () => {
      const cwd = dir("winter-violations-cwd-");
      const outside = dir("winter-violations-outside-");
      const target = join(outside, "x.txt");
      const output = await bash({ command: `echo hi > ${target}` }, ctxFor(cwd));
      expect(existsSync(target)).toBe(false);
      const block = blockOf(output);
      expect(block).toBeDefined();
      expect(block).toContain(`bash deny(1) file-write-create ${target}`);
      const lines = output.split("\n");
      expect(lines.at(-1)).toBe("[sandbox: sandboxed]");
      expect(lines.at(-2)).toBe("[exit 1]");
      expect(lines.at(-3)).toBe("</sandbox_violations>");
      expect(output.indexOf("Operation not permitted")).toBeLessThan(output.indexOf("<sandbox_violations>"));
    },
    SLOW,
  );

  t(
    "a LaunchServices lookup (`open -b` of a bundle id that does not exist): the block names the refused launchservices mach-lookup",
    async () => {
      const output = await bash({ command: "/usr/bin/open -b com.example.nonexistent.bundleid" }, ctxFor(dir("winter-violations-cwd-")));
      expect(output).toContain("[exit 1]");
      const block = blockOf(output);
      expect(block).toBeDefined();
      expect(block!.some((line) => /^open deny\(1\) mach-lookup com\.apple\.(lsd\.|coreservices\.launchservicesd)/.test(line))).toBe(true);
      // The start-up noise every process makes is not in it.
      expect(block!.join("\n")).not.toContain("dtracehelper");
      expect(block!.join("\n")).not.toContain("opendirectoryd");
      expect(block!.join("\n")).not.toContain("diagnosticd");
    },
    SLOW,
  );

  t(
    "a network attempt: the block names the refused network-outbound",
    async () => {
      const output = await bash({ command: "/usr/bin/nc -z -G 1 127.0.0.1 9" }, ctxFor(dir("winter-violations-cwd-")));
      expect(blockOf(output)).toContain("nc deny(1) network-outbound remote:*:9");
    },
    SLOW,
  );

  t(
    "an explicit filesystem.denyWrite rule still holds with the tag, and its denial is reported",
    async () => {
      const cwd = dir("winter-violations-cwd-");
      const guarded = join(cwd, "guarded");
      mkdirSync(guarded);
      const target = join(guarded, "y.txt");
      const output = await bash({ command: `echo hi > ${target}` }, ctxFor(cwd, { sandboxSettings: { filesystem: { denyWrite: [guarded] } } }));
      expect(existsSync(target)).toBe(false);
      expect(blockOf(output)).toContain(`bash deny(1) file-write-create ${target}`);
    },
    SLOW,
  );

  test.skipIf(!swiftcWorks)(
    "`swiftc -typecheck` (swift-driver's nested temp dir is outside the fence): the block names the refused write",
    async () => {
      const cwd = dir("winter-violations-cwd-");
      writeFileSync(join(cwd, "t.swift"), "let x = 1\n");
      const output = await bash({ command: "swiftc -typecheck t.swift" }, ctxFor(cwd));
      expect(output).not.toContain("[exit 0]");
      expect(blockOf(output)!.some((line) => /^swift-driver deny\(1\) file-write-create .*\/\.keep-directory$/.test(line))).toBe(true);
    },
    SLOW,
  );

  t(
    'a working directory with a `"` in its name: the profile loads, is tagged, and the refused write (an any-depth regex deny) is reported',
    async () => {
      // Before: the cwd's regexes were `#"...\"..."` literals -- Seatbelt refused the profile (every
      // command exited 65) and the tagger would not read it (no block).
      const cwd = join(dir("winter-violations-cwd-"), 'q"uo\\te (x);y é');
      mkdirSync(join(cwd, "sub", ".git", "hooks"), { recursive: true });
      const output = await bash({ command: "echo ok > ok.txt && echo hi > sub/.git/hooks/x" }, ctxFor(cwd));
      expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
      expect(existsSync(join(cwd, "sub", ".git", "hooks", "x"))).toBe(false);
      expect(output).toContain("[exit 1]");
      expect(blockOf(output)).toContain(`bash deny(1) file-write-create ${join(cwd, "sub", ".git", "hooks", "x")}`);
    },
    SLOW,
  );

  t(
    "a failure that is NOT the sandbox's (`ls` of a missing path) gets no block: only start-up noise was denied",
    async () => {
      const output = await bash({ command: "ls /nonexistent-winter-violations-probe" }, ctxFor(dir("winter-violations-cwd-")));
      expect(output).toContain("No such file or directory");
      expect(output).not.toContain("sandbox_violations");
    },
    SLOW,
  );

  t(
    "a successful command gets no block, and its stream is gone when it returns",
    async () => {
      const ok = await bash({ command: "echo fine" }, ctxFor(dir("winter-violations-cwd-")));
      expect(ok).toContain("[exit 0]");
      expect(ok).not.toContain("sandbox_violations");
      expect(await until(() => violationStreamsOf(process.pid).length === 0, 2_000)).toBe(true);
    },
    SLOW,
  );

  t(
    "an unsandboxed run (`dangerouslyDisableSandbox`) is unchanged: no stream, no block",
    async () => {
      let streams = 0;
      const restore = setViolationMonitorSpawnersForTest({
        stream() {
          streams++;
          throw new Error("no stream expected");
        },
        canary() {},
      });
      try {
        const output = await bash({ command: "exit 5", dangerouslyDisableSandbox: true }, ctxFor(dir("winter-violations-cwd-")));
        expect(output).toBe("(no stdout)\n[exit 5]\n[sandbox: override-requested]");
        expect(streams).toBe(0);
      } finally {
        restore();
      }
    },
    SLOW,
  );

  t(
    "runCommand: denials only when asked for and only on failure; the reported profile is never the tagged one",
    async () => {
      const cwd = dir("winter-violations-cwd-");
      const outside = dir("winter-violations-outside-");
      const base = { cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: 8_000, settings: {} };
      const plain = await runCommand({ ...base, command: `echo hi > ${outside}/a` });
      expect(plain.sandboxViolations).toBeUndefined();
      const reported = await runCommand({ ...base, command: `echo hi > ${outside}/b`, reportViolations: true });
      expect(reported.sandboxViolations?.lines).toContain(`bash deny(1) file-write-create ${outside}/b`);
      expect(reported.profile).toBe(plain.profile!);
      expect(reported.profile).not.toContain("with message");
      const ok = await runCommand({ ...base, command: "true", reportViolations: true });
      expect(ok.sandboxViolations).toBeUndefined();
    },
    SLOW,
  );
});

describe("no `log stream` outlives its command (real processes)", () => {
  const marker = () => `30.${randomBytes(3).readUIntBE(0, 3)}`;

  t(
    "an interrupted command: the stream is gone",
    async () => {
      const cwd = dir("winter-violations-cwd-");
      const seconds = marker();
      const turn = new AbortController();
      const pending = runCommand({ command: `exec sleep ${seconds}`, cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: 20_000, settings: {}, reportViolations: true, signal: turn.signal });
      expect(await until(() => violationStreamsOf(process.pid).length === 1, 5_000)).toBe(true);
      const [stream] = violationStreamsOf(process.pid);
      turn.abort();
      const result = await pending;
      expect(result.aborted).toBe(true);
      expect(result.sandboxViolations).toBeUndefined();
      expect(await until(() => !alive(stream!), 2_000)).toBe(true);
    },
    SLOW,
  );

  t(
    "a timed-out command: drained, then the stream is gone",
    async () => {
      const cwd = dir("winter-violations-cwd-");
      const pending = runCommand({ command: `exec sleep ${marker()}`, cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: 1_500, settings: {}, reportViolations: true });
      expect(await until(() => violationStreamsOf(process.pid).length === 1, 5_000)).toBe(true);
      const [stream] = violationStreamsOf(process.pid);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(await until(() => !alive(stream!), 2_000)).toBe(true);
    },
    SLOW,
  );

  t(
    "the parent runtime SIGKILLed mid-command: the stream ends by its own --timeout (command timeout + margin)",
    async () => {
      const work = dir("winter-violations-parent-");
      const seconds = marker();
      const timeoutMs = 2_000;
      const script = join(work, "parent.ts");
      writeFileSync(
        script,
        [
          `import { runCommand } from ${JSON.stringify(join(import.meta.dir, "spawn.ts"))};`,
          `const cwd = ${JSON.stringify(work)};`,
          `await runCommand({ command: "exec sleep ${seconds}", cwd, env: { ...process.env, TMPDIR: cwd }, timeoutMs: ${timeoutMs}, settings: {}, reportViolations: true, onSpawned: () => console.log("SPAWNED") });`,
        ].join("\n"),
      );
      const parent = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
      try {
        let out = "";
        parent.stdout.setEncoding("utf8");
        parent.stdout.on("data", (chunk: string) => (out += chunk));
        expect(await until(() => out.includes("SPAWNED"), 10_000)).toBe(true);
        const streams = violationStreamsOf(parent.pid!);
        expect(streams).toHaveLength(1);
        const killedAt = Date.now();
        parent.kill("SIGKILL");
        const lifetimeMs = (Math.ceil(timeoutMs / 1000) + VIOLATION_STREAM_MARGIN_SECONDS) * 1000;
        expect(await until(() => !alive(streams[0]!), lifetimeMs + 3_000)).toBe(true);
        expect(Date.now() - killedAt).toBeLessThan(lifetimeMs + 3_000);
      } finally {
        parent.kill("SIGKILL");
        spawnSync("/usr/bin/pkill", ["-f", `sleep ${seconds}`]); // the orphaned command itself (pre-existing behaviour, not this feature's)
      }
    },
    SLOW,
  );
});
