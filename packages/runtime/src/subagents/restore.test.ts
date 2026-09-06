// Phase 4 fix wave (I3): the PRODUCTION wiring proof for WS-10 §7's "the roster rebuilds from
// durable storage". `roster.test.ts` proves the rebuild FUNCTION; this file proves a real resumed
// session actually calls it -- the gap the whole-branch review found (a MUST cited as covered by
// unit tests of a function with zero production callers).
//
// Drives `inMemoryProcess` (the same entrypoint wiring main.ts performs, per
// register-default-factory.ts's own cross-leg argument) end to end: session 1 spawns a REAL child
// through the REAL Agent tool, the process ends, and session 2 resumes the same session and asks
// `ListAgents` what it can see.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { encodeFrame, splitFrames } from "@yanlinglabs/winter-agent-sdk";
import { inMemoryProcess } from "../testing.ts";
import type { Provider } from "../engine.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import { resetChildEngineFactoryForTest } from "./child-handle.ts";
import { restoredChildHandle } from "./restore.ts";

const CHILD_MARKER = "restore-fixture child prompt";

const tempDirs: string[] = [];
function freshHome(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-fixwave-restore-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  resetChildEngineFactoryForTest();
  resetSpawnLimitsForTest();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function runOneEnvelope(config: RuntimeConfig, home: string, provider: Provider): Promise<WinterFrame[]> {
  const proc = inMemoryProcess(["--config-json", JSON.stringify(config)], provider, undefined, { WINTER_HOME: home });
  proc.stdin.write(encodeFrame({ type: "user", text: "go" }));
  proc.stdin.write(encodeFrame({ type: "control_request", requestId: "r1", subtype: "end_input", payload: undefined }));
  const frames: WinterFrame[] = [];
  let carry = "";
  for await (const chunk of proc.stdout) {
    const split = splitFrames(chunk, carry);
    carry = split.carry;
    frames.push(...split.frames);
  }
  await proc.exited;
  return frames;
}

// A pure function of the messages it sees -- ONE provider instance serves both the parent's turns
// and the spawned child's (createChildEngineFactory hands `deps.provider` straight to the child).
const spawningProvider: Provider = {
  async generate({ messages }) {
    const firstUser = messages.find((m) => m.role === "user");
    const firstText = typeof firstUser?.content === "string" ? firstUser.content : "";
    if (firstText.includes(CHILD_MARKER)) return { kind: "text", text: "child finished" };
    const alreadySpawned = messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === "Agent"));
    if (alreadySpawned) return { kind: "text", text: "parent finished" };
    return { kind: "tool_use", calls: [{ id: "agent-call-1", name: "Agent", input: { description: "restore fixture", prompt: CHILD_MARKER, name: "restorable" } }] };
  },
};

const listingProvider: Provider = {
  async generate({ messages }) {
    const alreadyListed = messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" && b.name === "ListAgents"));
    if (alreadyListed) return { kind: "text", text: "listed" };
    return { kind: "tool_use", calls: [{ id: "list-call-1", name: "ListAgents", input: {} }] };
  },
};

function toolResultContent(frames: WinterFrame[], toolUseId: string): string | undefined {
  return frames
    .filter((f) => f.type === "data")
    .map((f) => (f as { message: SdkMessage }).message)
    .filter((m) => m.type === "user")
    .flatMap((m) => ((m as unknown as { message: { content: Array<{ tool_use_id: string; content: string }> } }).message.content ?? []))
    .find((b) => b.tool_use_id === toolUseId)?.content;
}

describe("WS-10 §7: a resumed session rebuilds its child roster from durable storage (fix wave I3)", () => {
  test("a child spawned in session 1 is listed by ListAgents after the session is RESUMED in a fresh process", async () => {
    const home = freshHome();
    const cwd = "/winter-fixture";
    const sessionId = randomUUID();

    const firstFrames = await runOneEnvelope({ sessionId, cwd, model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, home, spawningProvider);
    const spawnResult = toolResultContent(firstFrames, "agent-call-1");
    expect(spawnResult, "session 1 must genuinely spawn a child").toBeDefined();
    const agentId = (JSON.parse(spawnResult!) as { agentId: string }).agentId;
    expect(typeof agentId).toBe("string");

    // A SEPARATE run, resuming the same session -- the shape a restart takes (store/resume.test.ts's
    // own established fixture): a fresh instance id plus `resume`.
    const secondFrames = await runOneEnvelope(
      { sessionId: randomUUID(), cwd, model: "winter-test/echo", resume: sessionId, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      home,
      listingProvider,
    );
    const listing = toolResultContent(secondFrames, "list-call-1");
    expect(listing, "the resumed session must produce a ListAgents result").toBeDefined();
    // Before the fix: `rebuildChildRoster` had NO production caller, the resumed run started with an
    // empty roster, and this listing was empty -- the prior child was unreachable by any tool.
    expect(listing!).toContain(agentId);
    expect(listing!).toContain("restorable");
  }, 20_000);

  test("a FORK does not inherit the source session's children (a fork is a new session; its children belong to the source)", async () => {
    const home = freshHome();
    const cwd = "/winter-fixture";
    const sessionId = randomUUID();
    const firstFrames = await runOneEnvelope({ sessionId, cwd, model: "winter-test/echo", permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }, home, spawningProvider);
    const agentId = (JSON.parse(toolResultContent(firstFrames, "agent-call-1")!) as { agentId: string }).agentId;

    const forkFrames = await runOneEnvelope(
      { sessionId: randomUUID(), cwd, model: "winter-test/echo", resume: sessionId, forkSession: true, permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true },
      home,
      listingProvider,
    );
    expect(toolResultContent(forkFrames, "list-call-1")!).not.toContain(agentId);
  }, 20_000);
});

describe("restoredChildHandle (fix wave I3): identity yes, live resume no", () => {
  test("a restored handle answers from the durable record and refuses steer/resume with a legible, NON-retryable reason", async () => {
    const record = {
      id: "agent-x",
      parentSessionId: "session-x",
      parentToolUseId: "call-x",
      transcript: "/tmp/nowhere/agent-agent-x.jsonl",
      status: "stopped" as const,
      runtime: "winter-agent" as const,
      model: { effectiveModel: "sonnet", effectiveEffort: "inherit" },
      permission: { effectiveMode: "default" as const, parentPolicyHash: "h", parentPolicyVersion: 1 },
    };
    const handle = restoredChildHandle(record);
    expect(handle.status()).toBe("stopped");
    const msg = { messageId: "m1" } as never;
    expect((await handle.steer(msg)).status).toBe("not_found");
    const resumed = await handle.resume(msg);
    expect(resumed.status).toBe("unavailable");
    expect(resumed).toMatchObject({ retryable: false });
    expect("reason" in resumed ? resumed.reason : "").toContain("restored from durable storage");
    expect((await handle.result()).status).toBe("stopped");
    await handle.stop(); // idempotent, never throws
  });
});
