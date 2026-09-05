// Phase 5 fix wave, C1 (CRITICAL) — settings-file permission rules reach the LIVE evaluator.
//
// THE FINDING, restated so this file is readable without the review. `resolveSettingsDetailed` ran in
// `production-wiring.ts` and its `permissions` block had NO CONSUMER: the engine seeded its rule set
// from `config.{allowedTools,disallowedTools,permissions}` alone, so the only way a `project`/`local`/
// `user`-sourced entry could exist in a live session was a `canUseTool` answer carrying `addRules`.
// Every trust test in Phase 5 -- the P5-A/P5-D matrix, 60+ cells -- was green against that one
// producer. A `deny` a user wrote into `~/.winter/settings.json` was silently not a deny.
//
// THESE FIXTURES ARE THE WHOLE-BRANCH REVIEWER'S OWN PROBES, with the outcomes inverted. PROBE-2
// (user-tier allow → 1 prompt) and PROBE-4/5 (user- and project-tier deny → prompted, host allowed,
// Bash RAN, `permission_denials: []`) are the RED; each assertion below is the observed-wrong value
// turned into the required-right one.
//
// IN-MEMORY LEG, and that is sufficient by construction rather than by convenience:
// `production-wiring.ts` is ONE function both entrypoints call, and the seeded entries travel to the
// engine as plain data on `EngineOptions` -- the same channel `extraHookEntries` and the init fields
// use, all of which `transport-equivalence.test.ts` already proves leg-invariant. What needs a
// controlled `~/.winter` tree is which TIER won, which is what this file drives.
//
// Every fixture builds mkdtemp roots and passes `winterHome` explicitly. Nothing here reads a real
// `~/.winter`, `~/.norma`, `~/.claude` or the keychain, and no path carries a real username.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "./testing.ts";
import type { Provider, ProviderTurn } from "./engine.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-c1-home-"));
  cwd = mkdtempSync(join(tmpdir(), "winter-c1-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function scripted(turns: ProviderTurn[]): Provider {
  let i = 0;
  return {
    async generate(): Promise<ProviderTurn> {
      return turns[Math.min(i++, turns.length - 1)]!;
    },
  };
}

interface RunOutcome {
  /** How many runtime-originated permission prompts the host saw. */
  prompts: number;
  /** Did the tool actually execute? Proved by a real filesystem side effect, never by a frame. */
  ran: boolean;
  denials: unknown[];
  /** The mode the engine reported on its own init frame -- the observable for a settings `defaultMode`. */
  mode: string | undefined;
}

/**
 * One envelope through the real in-memory process, with the host answering EVERY prompt the way
 * `answer` says.
 *
 * `answer: "allow"` is the discriminating choice for a deny fixture: if the settings deny works, the
 * call never reaches a prompt at all, so `prompts === 0` AND `ran === false`. If it does not work,
 * the host's own allow lets the call through and the marker appears -- which is exactly what the
 * reviewer observed.
 */
async function run(config: RuntimeConfig, answer: "allow" | "deny", provider: Provider): Promise<RunOutcome> {
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], provider, undefined, { WINTER_HOME: home });
  proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
  let prompts = 0;
  let denials: unknown[] = [];
  let mode: string | undefined;
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    for (const frame of split.frames as WinterFrame[]) {
      if (frame.type === "control_request" && (frame as { subtype?: string }).subtype === "permission") {
        prompts++;
        proc.stdin.write(
          encodeFrame({
            type: "control_response",
            requestId: (frame as { requestId: string }).requestId,
            ok: true,
            payload: answer === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "host said no" },
          } as WinterFrame),
        );
      }
      if (frame.type === "init") mode = (frame as { permissionMode?: string }).permissionMode;
      if (frame.type === "data") {
        const msg = (frame as { message: { type: string; permission_denials?: unknown[] } }).message;
        if (msg.type === "result" && Array.isArray(msg.permission_denials)) denials = msg.permission_denials;
      }
    }
  }
  await proc.exited;
  return { prompts, ran: false, denials, mode };
}

/** A Bash turn whose only observable is a real file. A frame can lie about execution; a file cannot. */
function bashTouch(marker: string): Provider {
  return scripted([
    { kind: "tool_use", calls: [{ id: "c1", name: "Bash", input: { command: `touch ${marker}` } }] },
    { kind: "text", text: "done" },
  ]);
}

function writeSettings(dir: string, settings: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
}

const base = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId: `c1-${Math.random().toString(36).slice(2, 10)}`,
  cwd,
  model: "sonnet",
  winterHome: home,
  // `sandbox: {enabled:false}` so the fixture runs identically on a host without /usr/bin/sandbox-exec.
  // The subject is the permission decision, which happens well before any sandbox.
  sandbox: { enabled: false },
  ...overrides,
});

describe("C1: settings-file permission rules reach the live evaluator", () => {
  test("PROBE-2 INVERTED: a USER-tier `allow` SILENCES the prompt, and the call runs", async () => {
    // The reviewer observed 1 prompt and no execution. Capture (1) cells D/J/P/N are the pinned
    // runtime silencing exactly this prompt from a user-tier file.
    writeSettings(home, { permissions: { allow: ["Bash(touch *)"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: ["user"] }), "deny", bashTouch(marker));
    expect(out.prompts, "a user-tier allow must not prompt").toBe(0);
    expect(existsSync(marker), "and the call must actually run").toBe(true);
  });

  test("PROBE-4 INVERTED: a USER-tier `deny` DENIES -- no prompt, no execution, and the denial is on the ledger", async () => {
    // The reviewer observed: prompted, host allowed, Bash RAN, `permission_denials: []`. The host
    // answers ALLOW here deliberately -- if the deny works the prompt never happens, so the host's
    // own answer can never be what produced the outcome.
    writeSettings(home, { permissions: { deny: ["Bash"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: ["user"] }), "allow", bashTouch(marker));
    expect(out.prompts, "a deny is decided before any prompt").toBe(0);
    expect(existsSync(marker), "the call must NOT run").toBe(false);
    expect(out.denials.length, "result.permission_denials is the ledger (Finding 3, P2 fix wave)").toBeGreaterThan(0);
  });

  test("PROBE-5 INVERTED: a PROJECT-tier `deny` denies too -- the half of WS-07 §3.2 that applies WITHOUT trust", async () => {
    writeSettings(join(cwd, ".winter"), { permissions: { deny: ["Bash"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: ["project"] }), "allow", bashTouch(marker));
    expect(out.prompts).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("P5-A: a PROJECT-tier `allow` does NOT widen without host-declared trust -- it still prompts", async () => {
    // The discriminating counterpart to the user-tier allow above. Without this, "settings rules are
    // wired" could equally mean "wired with the trust filter" or "wired without it", and the whole
    // point of P5-A is which.
    writeSettings(join(cwd, ".winter"), { permissions: { allow: ["Bash(touch *)"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: ["project"] }), "deny", bashTouch(marker));
    expect(out.prompts, "an untrusted project allow must not silence the prompt").toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  test("P5-A: the SAME project file DOES widen once the host declares trust", async () => {
    writeSettings(join(cwd, ".winter"), { permissions: { allow: ["Bash(touch *)"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: ["project"], trustedWorkspace: true }), "deny", bashTouch(marker));
    expect(out.prompts).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test("capture (1) cell K: a PROJECT deny beats a LOCAL allow", async () => {
    writeSettings(join(cwd, ".winter"), { permissions: { deny: ["Bash"] } });
    mkdirSync(join(cwd, ".winter"), { recursive: true });
    writeFileSync(join(cwd, ".winter", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(touch *)"] } }));
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: ["project", "local"] }), "allow", bashTouch(marker));
    expect(out.prompts).toBe(0);
    expect(existsSync(marker), "deny wins over a permissive rule from any tier").toBe(false);
  });

  test("`settingSources: []` reads no file -- the SAME user-tier deny is inert, which is what makes the fixtures above about the FILE", async () => {
    writeSettings(home, { permissions: { deny: ["Bash"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(base({ settingSources: [] }), "allow", bashTouch(marker));
    expect(out.prompts).toBe(1);
    expect(existsSync(marker)).toBe(true);
  });

  test("a MANAGED-tier deny beats everything, including a user-tier allow of the same call", async () => {
    // The managed tier had NO PRODUCER on any leg before this fix -- `production-wiring.ts` never
    // passed `managedSettings` to the resolution, and `RuntimeConfig` carried no field for it, so
    // the pinned `managed` source was unreachable in a live session.
    writeSettings(home, { permissions: { allow: ["Bash(touch *)"] } });
    const marker = join(cwd, "ran.txt");
    const out = await run(
      base({ settingSources: ["user"], managedSettings: { permissions: { deny: ["Bash"] } } }),
      "allow",
      bashTouch(marker),
    );
    expect(out.prompts).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("a settings-file `additionalDirectories` grants an out-of-cwd write from the USER tier, and does not from an untrusted PROJECT tier", async () => {
    // `realpathSync`: on macOS every mkdtemp path is a `/var` -> `/private/var` symlink, and
    // `isWithinBounds` requires BOTH the path and its resolved target to fall inside a granted root
    // (rider 2's symlink-aware composition). A grant written in the `/var` spelling would therefore
    // fail its own realpath check -- a property of the temp dir, not of the grant.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "winter-c1-outside-")));
    try {
      const target = join(outside, "note.txt");
      // A FRESH provider per half. `scripted` closes over its own cursor, so reusing one object
      // across two runs leaves the second run's first `generate()` returning the CLOSING TEXT turn --
      // no tool call, no prompt, and a green assertion that measured nothing. Found by running it.
      const writeTurn = (): Provider =>
        scripted([
          { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: target, content: "hi\n" } }] },
          { kind: "text", text: "done" },
        ]);
      // TWO fixture choices, both discriminating, both found by running this wrong first:
      //
      //   * NO `allowedTools: ["Write"]`. A bare `Write` allow rule matches regardless of input, so
      //     it would approve BOTH halves of the pair and the fixture would pass for the wrong reason.
      //   * `acceptEdits`, not `default`. The in-bounds auto-approve arm (`evaluator.ts`'s
      //     `isWithinBounds` call at the MODE stage) is reached in `acceptEdits`/`auto` only -- in
      //     `default` an in-cwd Write prompts too, so the grant would move nothing and both halves
      //     would prompt.
      //
      // With both set, the in-bounds/out-of-bounds boundary is the ONLY thing deciding -- and a
      // directory GRANT is exactly what moves it, which is what this pair measures.
      writeSettings(home, { permissions: { additionalDirectories: [outside] } });
      const granted = await run(base({ settingSources: ["user"], permissionMode: "acceptEdits" }), "deny", writeTurn());
      expect(granted.prompts, "a user-tier directory grant makes the write in-bounds").toBe(0);
      expect(existsSync(target)).toBe(true);

      rmSync(target, { force: true });
      rmSync(join(home, "settings.json"), { force: true });
      writeSettings(join(cwd, ".winter"), { permissions: { additionalDirectories: [outside] } });
      const ungranted = await run(base({ settingSources: ["project"], permissionMode: "acceptEdits" }), "deny", writeTurn());
      expect(ungranted.prompts, "an untrusted project directory grant does not widen (P5-A)").toBe(1);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an ESCALATING `defaultMode` from the PROJECT tier is dropped; a non-escalating one survives; a USER-tier escalating one survives", async () => {
    // `filterEscalatingDefaultMode` had zero non-test callers. The init frame's `permissionMode` is
    // the observable.
    writeSettings(join(cwd, ".winter"), { permissions: { defaultMode: "bypassPermissions" } });
    const dropped = await run(base({ settingSources: ["project"] }), "deny", scripted([{ kind: "text", text: "ok" }]));
    expect(dropped.mode, "a repo-committed escalating mode never survives").toBe("default");

    rmSync(join(cwd, ".winter", "settings.json"), { force: true });
    writeSettings(join(cwd, ".winter"), { permissions: { defaultMode: "plan" } });
    const kept = await run(base({ settingSources: ["project"] }), "deny", scripted([{ kind: "text", text: "ok" }]));
    expect(kept.mode, "`plan` is not escalating -- it survives from any tier").toBe("plan");

    rmSync(join(cwd, ".winter", "settings.json"), { force: true });
    writeSettings(home, { permissions: { defaultMode: "acceptEdits" } });
    const user = await run(base({ settingSources: ["user"] }), "deny", scripted([{ kind: "text", text: "ok" }]));
    expect(user.mode, "the filter is TIER-based: a user-tier escalating mode is the user's own choice").toBe("acceptEdits");
  });

  test("an explicit `config.permissionMode` BEATS a settings-file `defaultMode` -- the file is a default, not an override", async () => {
    writeSettings(home, { permissions: { defaultMode: "acceptEdits" } });
    const out = await run(base({ settingSources: ["user"], permissionMode: "plan" }), "deny", scripted([{ kind: "text", text: "ok" }]));
    expect(out.mode).toBe("plan");
  });

  test("a file-tier `disableBypassPermissionsMode` vetoes bypass, even though the host asked for it", async () => {
    // WS-07 §6.4's managed veto. `engine.ts` read `config.permissions?.disableBypassPermissionsMode`
    // only, so a veto written into a settings file was inert.
    writeSettings(home, { permissions: { disableBypassPermissionsMode: true } });
    const proc = inMemoryProcess(
      ["--run", "--config-json", JSON.stringify(base({ settingSources: ["user"], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }))],
      scripted([{ kind: "text", text: "ok" }]),
      undefined,
      { WINTER_HOME: home },
    );
    proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
    proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
    let sawAny = false;
    let carry = "";
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const f of split.frames as WinterFrame[]) if (f.type === "init") sawAny = true;
    }
    const exited = await proc.exited;
    // The engine's startup validation rejects bypass under a veto BEFORE the init frame -- the same
    // "exited before init" path an unrecognised permissionMode takes.
    expect(sawAny, "the run must not reach its init frame").toBe(false);
    expect(exited.code).not.toBe(0);
  });
});
