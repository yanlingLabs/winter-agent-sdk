// Phase 5 Task 3 (T2 rider): the command-hook runner. Real subprocesses against real fixture
// scripts -- every one of them killed in `finally` with an explicit deadline, per the phase's
// process-spawning rule (macOS has no `timeout(1)`, so the invoker's own kill path IS the deadline).
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInvocationRequest, HookInvoker } from "./runner.ts";
import type { SourcedHookEntry } from "./registry.ts";
import { CommandHookError, createCommandHookInvoker } from "./command-invoker.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "winter-cmd-hook-"));
  dirs.push(dir);
  return dir;
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const REQUEST: HookInvocationRequest = {
  event: "PreToolUse",
  sessionId: "s-1",
  toolName: "Bash",
  toolUseID: "tu-1",
  input: { command: "ls" },
  policyVersion: "1",
  requestId: "r-1",
  hookId: "PreToolUse:sdk:0:0",
  hookName: "guard",
};

function entry(overrides: Partial<SourcedHookEntry> = {}): SourcedHookEntry {
  return { id: REQUEST.hookId, event: "PreToolUse", source: "project", ...overrides };
}

/** A `next` that records whether it was reached -- the passthrough half of the dispatch contract. */
function recordingNext(): { invoker: HookInvoker; calls: HookInvocationRequest[] } {
  const calls: HookInvocationRequest[] = [];
  return {
    calls,
    invoker: {
      async invoke(request) {
        calls.push(request);
        return { fromNext: true };
      },
    },
  };
}

function freshSignal(): { signal: AbortSignal; abort: () => void } {
  const controller = new AbortController();
  return { signal: controller.signal, abort: () => controller.abort() };
}

describe("command-invoker: dispatch", () => {
  test("an entry WITHOUT a command falls through to `next` untouched", async () => {
    const next = recordingNext();
    const invoker = createCommandHookInvoker([entry()], { next: next.invoker, cwd: fixtureDir() });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ fromNext: true });
    expect(next.calls).toHaveLength(1);
  });

  test("an entry WITH a command is executed as a subprocess and NEVER reaches `next`", async () => {
    const dir = fixtureDir();
    const next = recordingNext();
    const invoker = createCommandHookInvoker([entry({ command: `echo '{"decision":"allow"}'` })], { next: next.invoker, cwd: dir });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ decision: "allow" });
    expect(next.calls).toHaveLength(0);
  });

  test("dispatch is BY hookId, so a mixed session runs command hooks and callback hooks side by side", async () => {
    const dir = fixtureDir();
    const next = recordingNext();
    const invoker = createCommandHookInvoker([entry({ id: "cmd", command: `echo '{"ok":1}'` }), entry({ id: "cb" })], { next: next.invoker, cwd: dir });
    expect(await invoker.invoke({ ...REQUEST, hookId: "cmd" }, freshSignal())).toEqual({ ok: 1 });
    expect(await invoker.invoke({ ...REQUEST, hookId: "cb" }, freshSignal())).toEqual({ fromNext: true });
    expect(next.calls.map((c) => c.hookId)).toEqual(["cb"]);
  });
});

describe("command-invoker: the WS-08 §10 stdin contract", () => {
  test("the request payload arrives on stdin as JSON, verbatim -- and is NOT interpolated into the command", async () => {
    const dir = fixtureDir();
    const out = join(dir, "captured.json");
    const invoker = createCommandHookInvoker([entry({ command: `cat > ${JSON.stringify(out)}; echo '{}'` })], { next: recordingNext().invoker, cwd: dir });
    await invoker.invoke(REQUEST, freshSignal());
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(REQUEST as unknown as Record<string, unknown>);
  });

  test("a hook that never reads stdin still succeeds -- EPIPE on the write is normal, not a failure", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `echo '{"read":"nothing"}'` })], { next: recordingNext().invoker, cwd: dir });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ read: "nothing" });
  });

  test("the command runs in the SESSION cwd, not process.cwd()", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `printf '{"cwd":"%s"}' "$PWD"` })], { next: recordingNext().invoker, cwd: dir });
    const result = (await invoker.invoke(REQUEST, freshSignal())) as { cwd: string };
    // macOS symlinks /var -> /private/var, so compare the tails rather than the whole path.
    expect(result.cwd.endsWith(dir.replace(/^\/private/, ""))).toBe(true);
  });

  test("the environment is the one the caller declared, not an ambient inherit", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `printf '{"v":"%s"}' "$WINTER_TEST_MARKER"` })], {
      next: recordingNext().invoker,
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", WINTER_TEST_MARKER: "declared" },
    });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ v: "declared" });
  });
});

describe("command-invoker: exit-code and output semantics (WS-08 §8)", () => {
  test("exit 0 + parseable JSON -> that object is the hook's output", async () => {
    const dir = fixtureDir();
    const path = script(dir, "ok.sh", `echo '{"decision":"deny","message":"nope"}'`);
    const invoker = createCommandHookInvoker([entry({ command: path })], { next: recordingNext().invoker, cwd: dir });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ decision: "deny", message: "nope" });
  });

  test("exit 0 + EMPTY stdout -> an acknowledgement, `{}` -- a hook that ran and said nothing is not an error", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "exit 0" })], { next: recordingNext().invoker, cwd: dir });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({});
  });

  test("exit 0 + UNPARSEABLE stdout -> an error of that hook (§8 row 3), never a silently-ignored output", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "echo not json at all" })], { next: recordingNext().invoker, cwd: dir });
    await expect(invoker.invoke(REQUEST, freshSignal())).rejects.toThrow("unparseable output");
  });

  test("a NON-ZERO exit is an error of that hook, carrying the code and a stderr tail", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "echo 'broke' >&2; exit 3" })], { next: recordingNext().invoker, cwd: dir });
    try {
      await invoker.invoke(REQUEST, freshSignal());
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(CommandHookError);
      expect((err as CommandHookError).exitCode).toBe(3);
      expect((err as CommandHookError).stderr).toContain("broke");
    }
  });

  test("NO exit code carries a special meaning -- exit 2 is an error like any other, never a block", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `echo '{"decision":"deny"}'; exit 2` })], { next: recordingNext().invoker, cwd: dir });
    // Even with a well-formed deny on stdout, a non-zero exit is an ERROR: the "exit 2 blocks"
    // convention is in neither this spec nor the pinned artifact, and honouring it would let a hook
    // deny a tool through an undocumented side channel.
    await expect(invoker.invoke(REQUEST, freshSignal())).rejects.toThrow("exited with code 2");
  });

  test("a command that cannot be spawned at all rejects rather than hanging", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "echo '{}'" })], { next: recordingNext().invoker, cwd: dir, shellPath: join(dir, "no-such-shell") });
    await expect(invoker.invoke(REQUEST, freshSignal())).rejects.toThrow();
  });
});

describe("command-invoker: abort kills the process (the runner's timeout, made effective)", () => {
  test("aborting the signal terminates a long-running hook instead of waiting it out", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "sleep 30" })], { next: recordingNext().invoker, cwd: dir, killGraceMs: 50 });
    const { signal, abort } = freshSignal();
    const started = Date.now();
    const pending = invoker.invoke(REQUEST, { signal });
    setTimeout(abort, 30);
    await expect(pending).rejects.toThrow(/terminated by SIG/);
    // Bounded far below the 30s the hook asked for -- the assertion is "it did not wait it out".
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  test("an ALREADY-aborted signal kills immediately -- no missed-event race", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "sleep 30" })], { next: recordingNext().invoker, cwd: dir, killGraceMs: 50 });
    const { signal, abort } = freshSignal();
    abort();
    await expect(invoker.invoke(REQUEST, { signal })).rejects.toThrow(/terminated by SIG/);
  }, 10_000);

  test("the hook's own background children die with it -- the process GROUP is killed, not just the shell", async () => {
    const dir = fixtureDir();
    const marker = join(dir, "orphan-was-alive");
    // The backgrounded child would create the marker 3s from now; killing the group must prevent it.
    const invoker = createCommandHookInvoker([entry({ command: `(sleep 3; touch ${JSON.stringify(marker)}) & sleep 30` })], {
      next: recordingNext().invoker,
      cwd: dir,
      killGraceMs: 50,
    });
    const { signal, abort } = freshSignal();
    const pending = invoker.invoke(REQUEST, { signal });
    setTimeout(abort, 30);
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(marker), "a backgrounded grandchild outlived the hook").toBe(false);
  }, 15_000);
});
