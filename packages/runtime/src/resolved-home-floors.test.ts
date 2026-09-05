// Phase 5 fix wave, I1 (+ T8-H2 + KNOWN-6) — THE RESOLVED-HOME CLASS, one fixture shape, six sites.
//
// THE FINDING. Every `~/.winter` fence Phase 5 landed is anchored to the OS HOME: the M13 transcript
// floor and the rider-25 backups floor resolve `~` through `permissionHome = homedir()`; both
// seatbelt profiles `join(ctx.home, ".winter", …)`; the P5-B workflow-script carve-out compares
// against `<ctx.home>/.winter/projects/…`; `loadAgentDefinitions` joins `.winter/agents` onto the OS
// home. Meanwhile the checkpoint SINK resolves its root through `resolveWinterHome(env)` and
// `workflows/store.ts` persists under `<winterHome>/projects/…`. Under a `WINTER_HOME` whose
// basename is not `.winter` the two halves point at different directories, and every fence vanishes.
//
// THE FIXTURE SHAPE IS THE WHOLE POINT: a mkdtemp root whose basename is NOT `.winter`. Every
// existing rider-25 / M13 / R5-5 fixture builds a `.winter`-shaped synthetic home and therefore
// structurally cannot see this class.
//
// RED (the whole-branch reviewer's PROBE-3/3b, verbatim in shape): under `WINTER_HOME=<mkdtemp>` and
// `bypassPermissions`, a `Write` to `<WINTER_HOME>/projects/<key>/<session>.jsonl` SUCCEEDED with
// `permission_denials: []`, and a `Write` to `<WINTER_HOME>/backups/sess/index.jsonl` succeeded too.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "./testing.ts";
import type { Provider, ProviderTurn } from "./engine.ts";
import { buildBaselineDenyRules } from "./engine.ts";
import { buildSeatbeltProfile, buildWorkflowWorkerSeatbeltProfile } from "./sandbox/profile.ts";
import { isWorkflowScriptCarveOut } from "./permissions/protected.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  // NOT named `.winter` -- that is the fixture shape this whole class needs.
  home = realpathSync(mkdtempSync(join(tmpdir(), "winter-i1-root-")));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-i1-cwd-")));
  expect(home.endsWith(".winter"), "the fixture root must NOT be named .winter, or it cannot see this class").toBe(false);
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

/** One bypass-mode envelope. Bypass is the mode the M13/rider-25 floors exist for (WS-07 §11 forces it on descendants). */
async function runBypass(turns: ProviderTurn[]): Promise<{ denials: unknown[] }> {
  const config: RuntimeConfig = {
    sessionId: `i1-${Math.random().toString(36).slice(2, 10)}`,
    cwd,
    model: "sonnet",
    winterHome: home,
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    sandbox: { enabled: false },
  };
  const proc = inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], scripted(turns), undefined, { WINTER_HOME: home });
  proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "e", subtype: "end_input", payload: undefined }));
  let denials: unknown[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    for (const frame of split.frames as WinterFrame[]) {
      if (frame.type !== "data") continue;
      const msg = (frame as { message: { type: string; permission_denials?: unknown[] } }).message;
      if (msg.type === "result" && Array.isArray(msg.permission_denials)) denials = msg.permission_denials;
    }
  }
  await proc.exited;
  return { denials };
}

describe("I1: every home-anchored fence follows the RESOLVED winter home", () => {
  test("PROBE-3 INVERTED: a Write under <WINTER_HOME>/projects is DENIED under bypass (M13's floor, reopened)", async () => {
    const victim = join(home, "projects", "some-key", "some-session.jsonl");
    mkdirSync(join(home, "projects", "some-key"), { recursive: true });
    writeFileSync(victim, "ORIGINAL\n");
    const { denials } = await runBypass([
      { kind: "tool_use", calls: [{ id: "c1", name: "Read", input: { file_path: victim } }] },
      { kind: "tool_use", calls: [{ id: "c2", name: "Write", input: { file_path: victim, content: "TAMPERED\n" } }] },
      { kind: "text", text: "done" },
    ]);
    expect(readFileSync(victim, "utf8"), "the durable transcript must survive").toBe("ORIGINAL\n");
    expect(denials.length, "and the refusal must be on the ledger").toBeGreaterThan(0);
  });

  test("PROBE-3b INVERTED: a Write under <WINTER_HOME>/backups is DENIED under bypass (rider 25's fence 1)", async () => {
    const victim = join(home, "backups", "sess", "index.jsonl");
    mkdirSync(join(home, "backups", "sess"), { recursive: true });
    const { denials } = await runBypass([
      { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: victim, content: '{"kind":"snapshot","path":"/etc/hosts"}\n' } }] },
      { kind: "text", text: "done" },
    ]);
    expect(existsSync(victim), "the checkpoint index must not be writable").toBe(false);
    expect(denials.length).toBeGreaterThan(0);
  });

  test("a Read under <WINTER_HOME>/run is DENIED -- the sole baseline READ denial follows the root too", async () => {
    const secret = join(home, "run", "core.sock-info");
    mkdirSync(join(home, "run"), { recursive: true });
    writeFileSync(secret, "socket-secret\n");
    const { denials } = await runBypass([
      { kind: "tool_use", calls: [{ id: "c1", name: "Read", input: { file_path: secret } }] },
      { kind: "text", text: "done" },
    ]);
    expect(denials.length, "the run directory is the one baseline read denial (WS-12 §2)").toBeGreaterThan(0);
  });

  test("the P5-B carve-out still works under the resolved root -- the edit-then-rerun loop is not collateral damage", async () => {
    // The new `<winterHome>/projects` deny must NOT close the one subtree WS-11 §1.3 requires to be
    // model-writable. Asserted through the REAL predicate, so the deny and the carve-out cannot
    // disagree about where a persisted script lives.
    const scriptPath = join(home, "projects", "some-key", "some-uuid", "workflows", "scripts", "wf-wf_abc.js");
    expect(isWorkflowScriptCarveOut(scriptPath, homedir(), home), "the carve-out follows the resolved root").toBe(true);
    // ...and a sibling under the same session is still denied.
    expect(isWorkflowScriptCarveOut(join(home, "projects", "some-key", "some-uuid", "transcript.jsonl"), homedir(), home)).toBe(false);
  });

  test("a real Write to the carve-out under the resolved root SUCCEEDS under bypass", async () => {
    const dir = join(home, "projects", "some-key", "some-uuid", "workflows", "scripts");
    mkdirSync(dir, { recursive: true });
    const scriptPath = join(dir, "wf-wf_abc.js");
    const { denials } = await runBypass([
      { kind: "tool_use", calls: [{ id: "c1", name: "Write", input: { file_path: scriptPath, content: "// edited\n" } }] },
      { kind: "text", text: "done" },
    ]);
    expect(existsSync(scriptPath), "WS-11 §1.3's documented edit-then-rerun loop must still work").toBe(true);
    expect(denials.length).toBe(0);
  });

  test("the OS-HOME paths stay denied too -- the resolved-root denies are ADDED, never swapped in", () => {
    // Pinned as a property of the rule list rather than through a run: the user tier and the whole
    // carried seatbelt corpus still assume the literal `~/.winter` default, and a swap would silently
    // unprotect every default-home session.
    const rules = buildBaselineDenyRules(home);
    const contents = rules.map((r) => (r.ruleValue as { ruleContent?: string }).ruleContent ?? "");
    expect(contents.some((c) => c === "~/.winter/projects/**")).toBe(true);
    expect(contents.some((c) => c === "~/.winter/backups/**")).toBe(true);
    expect(contents.some((c) => c === "~/.winter/run/**")).toBe(true);
    // `//`-ANCHORED: a single leading `/` means "relative to the rule's own settings-file
    // directory" in WS-07 §3.1's grammar, which is undefined for an engine-seeded rule and makes it
    // silently inert. `//` is the filesystem-root anchor.
    expect(contents.some((c) => c === `/${home}/projects/**`)).toBe(true);
    expect(contents.some((c) => c === `/${home}/backups/**`)).toBe(true);
    expect(contents.some((c) => c === `/${home}/run/**`)).toBe(true);
  });

  test("with NO resolved root given, the rule list is byte-identical to the OS-home-only one", () => {
    // Every engine-level caller that does not thread a winter home (every pre-existing test) must be
    // unchanged -- the resolved-root entries are conditional, never unconditional.
    expect(JSON.stringify(buildBaselineDenyRules())).toBe(JSON.stringify(buildBaselineDenyRules(undefined)));
    expect(buildBaselineDenyRules().length).toBeLessThan(buildBaselineDenyRules(home).length);
  });

  test("a resolved root that IS the default emits no duplicates", () => {
    const def = join(homedir(), ".winter");
    const rules = buildBaselineDenyRules(def).map((r) => `${r.rule.toolName}|${(r.ruleValue as { ruleContent?: string }).ruleContent ?? ""}`);
    expect(new Set(rules).size, "the two anchors coincide -- one set, not two").toBe(rules.length);
  });

  test("both seatbelt profiles deny the RESOLVED root's run/backups, and still deny the OS-home ones", () => {
    const bash = buildSeatbeltProfile({ cwd, allowNetwork: false, home: homedir(), winterHome: home });
    expect(bash).toContain(`(deny file-read* (subpath "${join(homedir(), ".winter", "run")}"))`);
    expect(bash).toContain(`(deny file-read* (subpath "${join(home, "run")}"))`);
    expect(bash).toContain(`(deny file-write* (subpath "${join(homedir(), ".winter", "backups")}"))`);
    expect(bash).toContain(`(deny file-write* (subpath "${join(home, "backups")}"))`);

    const worker = buildWorkflowWorkerSeatbeltProfile("/usr/local/bin/winter", { home: homedir(), winterHome: home });
    expect(worker).toContain(`(deny file-read* (subpath "${join(homedir(), ".winter", "run")}"))`);
    expect(worker).toContain(`(deny file-read* (subpath "${join(home, "run")}"))`);
  });

  test("KNOWN-6: user AGENT definitions load from the RESOLVED root, not from <os home>/.winter/agents", async () => {
    // `tools/impl/agent.ts` passed `home: ctx.home` and `loadAgentDefinitions` joined `.winter/agents`
    // onto it -- so a session run with `WINTER_HOME=/somewhere/else` loaded its skills and commands
    // from that root and its user AGENT definitions from `~/.winter/agents`: two halves of one user
    // configuration in two places. Lane S's concern 4, filed as a spine bug.
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "i1probe.md"), "---\ndescription: an I1 probe agent\n---\nYou are the I1 probe persona.\n");
    const { loadAgentDefinitions } = await import("./subagents/definitions.ts");
    const defs = loadAgentDefinitions({ cwd, home: homedir(), winterHome: home, trustedWorkspace: false });
    expect(defs.get("i1probe")?.prompt).toBe("You are the I1 probe persona.");
    // And the OS-home fallback still works when no resolved root is supplied -- every pre-existing
    // caller is unchanged.
    const withoutRoot = loadAgentDefinitions({ cwd, home, trustedWorkspace: false });
    expect(withoutRoot.get("i1probe"), "without the resolved root, `<home>/.winter/agents` is the tier").toBeUndefined();
  });
});
