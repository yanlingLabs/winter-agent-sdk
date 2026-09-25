// Phase 5 Task 3 (T2 rider): the command-hook runner. Real subprocesses against real fixture
// scripts -- every one of them killed in `finally` with an explicit deadline, per the phase's
// process-spawning rule (macOS has no `timeout(1)`, so the invoker's own kill path IS the deadline).
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInvocationRequest, HookInvoker, RunHooksContext } from "./runner.ts";
import { runHooks } from "./runner.ts";
import { buildHookRegistry, type SourcedHookEntry } from "./registry.ts";
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

describe("command-invoker: claude's stdin contract (WS-23)", () => {
  test("stdin carries claude's snake_case hook input -- and nothing from the request is interpolated into the command", async () => {
    const dir = fixtureDir();
    const out = join(dir, "captured.json");
    const invoker = createCommandHookInvoker([entry({ command: `cat > ${JSON.stringify(out)}; echo '{}'` })], {
      next: recordingNext().invoker,
      cwd: dir,
      transcriptPath: "/tmp/transcript.jsonl",
      permissionMode: () => "acceptEdits",
    });
    await invoker.invoke({ ...REQUEST, agentID: "agent-7", payload: { extra_field: 1 } }, freshSignal());
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      session_id: "s-1",
      transcript_path: "/tmp/transcript.jsonl",
      cwd: dir,
      permission_mode: "acceptEdits",
      agent_id: "agent-7",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "tu-1",
      extra_field: 1,
    });
  });

  test("an event's own fields ride the payload in claude's spelling (PostToolUse's tool_response)", async () => {
    const dir = fixtureDir();
    const out = join(dir, "captured.json");
    const invoker = createCommandHookInvoker([entry({ event: "PostToolUse", command: `cat > ${JSON.stringify(out)}` })], { next: recordingNext().invoker, cwd: dir });
    await invoker.invoke({ ...REQUEST, event: "PostToolUse", payload: { tool_response: "file contents" } }, freshSignal());
    const input = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(input["hook_event_name"]).toBe("PostToolUse");
    expect(input["tool_response"]).toBe("file contents");
    expect(input["transcript_path"]).toBe(""); // no transcript to name -> claude's required field, empty
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

  test("CLAUDE_PROJECT_DIR and its brand-named twin are exported for every hook", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `printf '{"c":"%s","w":"%s"}' "$CLAUDE_PROJECT_DIR" "$ACME_PROJECT_DIR"` })], {
      next: recordingNext().invoker,
      cwd: dir,
      projectDir: "/work/project",
      brand: { envPrefix: "ACME_" },
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ c: "/work/project", w: "/work/project" });
  });

  test("a plugin hook gets ${CLAUDE_PLUGIN_ROOT} substituted in its command AND exported (with the brand twin)", async () => {
    const dir = fixtureDir();
    const pluginRoot = join(dir, "my-plugin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    script(join(pluginRoot, "hooks"), "run.sh", `printf '{"env":"%s","twin":"%s"}' "$CLAUDE_PLUGIN_ROOT" "$ACME_PLUGIN_ROOT"`);
    const invoker = createCommandHookInvoker([entry({ command: "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh", pluginRoot })], {
      next: recordingNext().invoker,
      cwd: dir,
      brand: { envPrefix: "ACME_" },
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ env: pluginRoot, twin: pluginRoot });
  });

  test("a NON-plugin hook gets no CLAUDE_PLUGIN_ROOT and no substitution", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `printf '{"root":"%s"}' "\${CLAUDE_PLUGIN_ROOT:-unset}"` })], {
      next: recordingNext().invoker,
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ root: "unset" });
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

  test("exit 0 + a `{`-led stdout that does not parse -> an error of that hook (§8 row 3), never a silently-ignored output", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "echo '{not json'" })], { next: recordingNext().invoker, cwd: dir });
    await expect(invoker.invoke(REQUEST, freshSignal())).rejects.toThrow("unparseable output");
  });

  test("exit 0 + PLAIN-TEXT stdout -> claude's plain-text form: an acknowledgement on PreToolUse, CONTEXT on UserPromptSubmit/SessionStart", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "echo remember the style guide" })], { next: recordingNext().invoker, cwd: dir });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({});
    expect(await invoker.invoke({ ...REQUEST, event: "UserPromptSubmit" }, freshSignal())).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "remember the style guide" },
    });
    expect(await invoker.invoke({ ...REQUEST, event: "SessionStart" }, freshSignal())).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "remember the style guide" },
    });
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

  test("exit 2 BLOCKS with stderr as the reason, in the shape each event already understands (WS-23 ruling)", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: `echo '{"ignored":true}'; echo 'rm is not allowed here' >&2; exit 2` })], { next: recordingNext().invoker, cwd: dir });
    // stdout is ignored on exit 2 -- the block is the answer, stderr is its reason.
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ decision: "block", reason: "rm is not allowed here" });
    for (const event of ["UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "PostToolUseFailure"] as const) {
      expect(await invoker.invoke({ ...REQUEST, event }, freshSignal())).toEqual({ decision: "block", reason: "rm is not allowed here" });
    }
    expect(await invoker.invoke({ ...REQUEST, event: "PermissionRequest" }, freshSignal())).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "rm is not allowed here" } },
    });
    // Nothing to block: the user is still shown what the script said.
    expect(await invoker.invoke({ ...REQUEST, event: "SessionStart" }, freshSignal())).toEqual({ systemMessage: "rm is not allowed here" });
  });

  test("exit 2 with an empty stderr still blocks", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "exit 2" })], { next: recordingNext().invoker, cwd: dir });
    const out = (await invoker.invoke(REQUEST, freshSignal())) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason.length).toBeGreaterThan(0);
  });

  test("a command that cannot be spawned at all rejects rather than hanging", async () => {
    const dir = fixtureDir();
    const invoker = createCommandHookInvoker([entry({ command: "echo '{}'" })], { next: recordingNext().invoker, cwd: dir, shellPath: join(dir, "no-such-shell") });
    await expect(invoker.invoke(REQUEST, freshSignal())).rejects.toThrow();
  });
});

// Fix round 1 (low): the invoker THROUGH `runHooks`, not only as a bare object. Everything above
// calls `invoke()` directly, which cannot show what a failing command hook does to a turn -- and §8
// row 1 is precisely that it must contribute nothing and let evaluation continue, never deny a tool.
describe("command-invoker: composed with runHooks (WS-08 §8's failure rows, end to end)", () => {
  function ctx(invoker: HookInvoker, entries: SourcedHookEntry[]): RunHooksContext {
    return {
      registry: buildHookRegistry(entries, { trustedWorkspace: true }),
      invoker,
      audit: { record: () => {} },
      sessionId: "s-1",
      policyVersion: 1,
    };
  }

  test("a command hook's JSON output becomes a real hook DECISION through runHooks", async () => {
    const dir = fixtureDir();
    // The PreToolUse output shape, as a hook script would print it (runner.ts's own
    // `hookSpecificOutput` envelope) -- proof that a command hook reaches the SAME interpreter an
    // SDK-callback hook does, not merely that its bytes came back.
    const entries = [entry({ command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by policy"}}'` })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", toolUseID: "tu-1", input: { command: "ls" } }, ctx(createCommandHookInvoker(entries, { next: recordingNext().invoker, cwd: dir }), entries));
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("blocked by policy");
  });

  test("§8 row 1: a FAILING command hook contributes no decision -- it is an error of that hook, never a denial", async () => {
    const dir = fixtureDir();
    const audit: Array<{ outcome: string }> = [];
    const entries = [entry({ command: "echo 'exploded' >&2; exit 3" })];
    const composite = await runHooks(
      "PreToolUse",
      { toolName: "Bash", toolUseID: "tu-1", input: { command: "ls" } },
      { ...ctx(createCommandHookInvoker(entries, { next: recordingNext().invoker, cwd: dir }), entries), audit: { record: (r) => { audit.push({ outcome: r.outcome }); } } },
    );
    // The critical property: a hook that crashed must NOT read as a deny. A runner that folded a
    // thrown invoker into a decision would turn every broken hook script into a tool block.
    expect(composite.decision).toBeUndefined();
    expect(audit.map((a) => a.outcome)).toEqual(["error"]);
  });

  test("exit 2 through runHooks is a real DENY carrying stderr as the reason", async () => {
    const dir = fixtureDir();
    const entries = [entry({ command: "echo 'protected path' >&2; exit 2" })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", toolUseID: "tu-1", input: { command: "ls" } }, ctx(createCommandHookInvoker(entries, { next: recordingNext().invoker, cwd: dir }), entries));
    expect(composite.decision).toBe("deny");
    expect(composite.message).toBe("protected path");
  });

  test("a FAIL-CLOSED command hook that fails (exit 3) is a DENY naming the hook -- the opt-in inverts §8 row 1", async () => {
    const dir = fixtureDir();
    const entries = [entry({ command: "exit 3", failClosed: true })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", toolUseID: "tu-1", input: { command: "ls" } }, ctx(createCommandHookInvoker(entries, { next: recordingNext().invoker, cwd: dir }), entries));
    expect(composite.decision).toBe("deny");
    expect(composite.message).toContain(REQUEST.hookId);
    expect(composite.message).toContain("fail-closed");
  });

  test("the hook_response lifecycle carries the process output, and suppressOutput blanks stdout there", async () => {
    const dir = fixtureDir();
    const responses: Array<{ stdout?: string; stderr?: string; exitCode?: number }> = [];
    const lifecycle = { started: () => {}, response: (info: { stdout?: string; stderr?: string; exitCode?: number }) => { responses.push({ ...(info.stdout !== undefined ? { stdout: info.stdout } : {}), ...(info.stderr !== undefined ? { stderr: info.stderr } : {}), ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}) }); } };
    const loud = [entry({ id: "loud", command: `echo 'note' >&2; echo '{"systemMessage":"hi"}'` })];
    await runHooks("PreToolUse", { toolName: "Bash", input: {} }, { ...ctx(createCommandHookInvoker(loud, { next: recordingNext().invoker, cwd: dir }), loud), lifecycle });
    const quiet = [entry({ id: "quiet", command: `echo '{"suppressOutput":true}'` })];
    await runHooks("PreToolUse", { toolName: "Bash", input: {} }, { ...ctx(createCommandHookInvoker(quiet, { next: recordingNext().invoker, cwd: dir }), quiet), lifecycle });
    expect(responses[0]).toEqual({ stdout: '{"systemMessage":"hi"}\n', stderr: "note\n", exitCode: 0 });
    expect(responses[1]).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test("a command hook and a callback hook compose in one runHooks pass, in registry order", async () => {
    const dir = fixtureDir();
    const next: HookInvoker = { invoke: async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "from-callback" } }) };
    const entries = [entry({ id: "cmd", command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"from-command"}}'` }), entry({ id: "cb" })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", toolUseID: "tu-1", input: { command: "ls" } }, ctx(createCommandHookInvoker(entries, { next, cwd: dir }), entries));
    expect((composite.extraContext ?? []).map((c) => c.context)).toEqual(["from-command", "from-callback"]);
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

describe("command-invoker: WS-23 fix round 1", () => {
  test("M4: the plugin root is expanded by the SHELL from the exported variable, never spliced into the command -- a `$(...)` in the directory name does not run", async () => {
    const dir = fixtureDir();
    const { mkdirSync } = await import("node:fs");
    const pwned = join(dir, "pwned");
    const pluginRoot = join(dir, `weird $(touch ${pwned})`);
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    script(join(pluginRoot, "hooks"), "run.sh", `printf '{"ran":true}'`);
    const invoker = createCommandHookInvoker([entry({ command: `"\${CLAUDE_PLUGIN_ROOT}/hooks/run.sh"`, pluginRoot })], {
      next: recordingNext().invoker,
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    expect(await invoker.invoke(REQUEST, freshSignal())).toEqual({ ran: true });
    expect(existsSync(pwned)).toBe(false);
  });

  test("I2: a FAIL-CLOSED PreToolUse command hook's plain-text stdout is malformed (a deny through runHooks); an ordinary hook's stays an acknowledgement", async () => {
    const dir = fixtureDir();
    const strict = [entry({ command: "echo looks fine to me", failClosed: true })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: { command: "ls" } }, {
      registry: buildHookRegistry(strict, { trustedWorkspace: true }),
      invoker: createCommandHookInvoker(strict, { next: recordingNext().invoker, cwd: dir }),
      audit: { record: () => {} },
      sessionId: "s-1",
      policyVersion: 1,
    });
    expect(composite.decision).toBe("deny");
    expect(composite.message).toContain("(malformed_output)");
    expect(composite.message).not.toContain("echo looks fine"); // M3: never the command line
    const plain = createCommandHookInvoker([entry({ command: "echo looks fine to me" })], { next: recordingNext().invoker, cwd: dir });
    expect(await plain.invoke(REQUEST, freshSignal())).toEqual({});
  });

  test("M3: a fail-closed command hook's non-zero exit is denied with its exit CODE, never its command line or stderr", async () => {
    const dir = fixtureDir();
    const failing = [entry({ command: "echo 'secret-ish detail' >&2; exit 7", failClosed: true })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: { command: "ls" } }, {
      registry: buildHookRegistry(failing, { trustedWorkspace: true }),
      invoker: createCommandHookInvoker(failing, { next: recordingNext().invoker, cwd: dir }),
      audit: { record: () => {} },
      sessionId: "s-1",
      policyVersion: 1,
    });
    expect(composite.message).toContain("(exit_code_7)");
    expect(composite.message).not.toContain("secret-ish");
    expect(composite.message).not.toContain("exit 7");
  });

  test("C1: stdout capture is bounded -- a flooding script costs a bounded buffer, and its cut JSON is that hook's error", async () => {
    const dir = fixtureDir();
    const { MAX_HOOK_STDOUT_CAPTURE } = await import("./bounds.ts");
    const responses: Array<{ stdout?: string }> = [];
    const flood = [entry({ command: `printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"'; head -c 3000000 /dev/zero | tr '\\0' A; printf '"}}'` })];
    const composite = await runHooks("PreToolUse", { toolName: "Bash", input: {} }, {
      registry: buildHookRegistry(flood, { trustedWorkspace: true }),
      invoker: createCommandHookInvoker(flood, { next: recordingNext().invoker, cwd: dir }),
      audit: { record: () => {} },
      sessionId: "s-1",
      policyVersion: 1,
      lifecycle: { started: () => {}, response: (i) => { responses.push(i.stdout !== undefined ? { stdout: i.stdout } : {}); } },
    });
    expect(composite.extraContext).toBeUndefined(); // truncated at capture -> unparseable -> the hook's error, contributing nothing
    expect((responses[0]?.stdout ?? "").length).toBeLessThanOrEqual(MAX_HOOK_STDOUT_CAPTURE);
  }, 15_000);
});
