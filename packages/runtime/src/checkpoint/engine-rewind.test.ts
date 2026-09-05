// Phase 5 Task 7 (Lane K, R5-11): the REAL sink through the REAL engine, with real files on disk.
//
// The seam contract test drives the engine's half against the spine's in-memory fake, and
// `sink.test.ts` drives the store directly. Neither proves the join: that the path the engine
// extracts, the envelope id it mints, and the id it discloses to the host all line up with what the
// store recorded -- if any two of those diverged, `rewindFiles()` would silently restore nothing and
// every test on either side would stay green.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlResponseFrame, RuntimeConfig, WinterFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderTurn, type ToolExecutor } from "../engine.ts";
import { createFileCheckpointSink, CHECKPOINT_BACKUPS_DIRNAME } from "./sink.ts";

let home = "";
let work = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "winter-lane-k-e2e-"));
  work = join(home, "work");
  mkdirSync(work, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** A tool executor that really performs the writes, so the sink has something to have backed up. */
const realWriter: ToolExecutor = {
  async execute(call) {
    const input = call.input as { file_path?: string; content?: string; command?: string };
    if ((call.name === "Write" || call.name === "Edit") && typeof input.file_path === "string") {
      writeFileSync(input.file_path, input.content ?? "");
      return { output: `wrote ${input.file_path}` };
    }
    // A "Bash" round writes too -- and is never announced to the sink, which is the whole point.
    if (call.name === "Bash" && typeof input.file_path === "string") {
      writeFileSync(input.file_path, input.content ?? "");
      return { output: "ran" };
    }
    return { output: "ok" };
  },
};

function callsThen(calls: Array<{ id: string; name: string; input: unknown }>): Provider {
  let i = 0;
  return {
    async generate(): Promise<ProviderTurn> {
      if (i++ === 0) return { kind: "tool_use", calls };
      return { kind: "text", text: "done" };
    },
  };
}

const sessionId = "sess-e2e";
const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({
  sessionId,
  cwd: work,
  model: "sonnet",
  enableFileCheckpointing: true,
  winterHome: home,
  ...overrides,
});

describe("checkpoint -- the real sink through the real engine (R5-11)", () => {
  test("a Write is checkpointed, and the id the host is told is the id that rewinds it", async () => {
    const tracked = join(work, "tracked.ts");
    const byBash = join(work, "bash-made.txt");
    writeFileSync(tracked, "the original\n");

    // --- turn 1: the model writes a tracked file AND runs a Bash round ---------------------------
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({ allowedTools: ["Write", "Bash"] }),
      input: runtime.input,
      output: runtime.output,
      provider: callsThen([
        { id: "c1", name: "Write", input: { file_path: tracked, content: "the model's version\n" } },
        { id: "c2", name: "Bash", input: { command: "touch", file_path: byBash, content: "bash made this\n" } },
      ]),
      tools: realWriter,
      fileCheckpointSink: createFileCheckpointSink({ home, cwd: work, sessionUuid: sessionId }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    const result = dataMessages(frames).find((m) => m.type === "result") as { user_message_uuid?: string };
    const envelopeId = result.user_message_uuid;
    expect(typeof envelopeId).toBe("string");
    expect(readFileSync(tracked, "utf8")).toBe("the model's version\n");
    expect(readFileSync(byBash, "utf8")).toBe("bash made this\n");
    // Exactly ONE backup blob: the Write was intercepted, the Bash round was not.
    const blobs = readdirSync(join(home, CHECKPOINT_BACKUPS_DIRNAME, sessionId)).filter((f) => f.includes("@v"));
    expect(blobs).toHaveLength(1);

    // --- turn 2 (a later run): the host asks to rewind through the control request ---------------
    const second = createInMemoryChannel();
    const done2 = runEngine({
      config: baseConfig(),
      input: second.runtime.input,
      output: second.runtime.output,
      provider: { async generate() { return { kind: "text", text: "done" }; } },
      tools: realWriter,
      fileCheckpointSink: createFileCheckpointSink({ home, cwd: work, sessionUuid: sessionId }),
    });
    second.host.output.write({ type: "control_request", requestId: "rw", subtype: "rewind_files", payload: { user_message_id: envelopeId } });
    second.host.output.write({ type: "user", text: "undo that" });
    second.host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames2 = await drain(second.host.input);
    await done2;

    const response = frames2.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "rw") as ControlResponseFrame;
    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ canRewind: true, filesChanged: [tracked], skippedLinks: 0 });
    // The tracked file is back; the Bash-created file is exactly where Bash left it.
    expect(readFileSync(tracked, "utf8")).toBe("the original\n");
    expect(existsSync(byBash)).toBe(true);
    expect(readFileSync(byBash, "utf8")).toBe("bash made this\n");
  });

  test("a dry run answers over the wire without touching the tree", async () => {
    const tracked = join(work, "tracked.ts");
    writeFileSync(tracked, "original\n");

    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({ allowedTools: ["Write"] }),
      input: runtime.input,
      output: runtime.output,
      provider: callsThen([{ id: "c1", name: "Write", input: { file_path: tracked, content: "changed\nand grew\n" } }]),
      tools: realWriter,
      fileCheckpointSink: createFileCheckpointSink({ home, cwd: work, sessionUuid: sessionId }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const envelopeId = (dataMessages(frames).find((m) => m.type === "result") as { user_message_uuid?: string }).user_message_uuid;

    const second = createInMemoryChannel();
    const done2 = runEngine({
      config: baseConfig(),
      input: second.runtime.input,
      output: second.runtime.output,
      provider: { async generate() { return { kind: "text", text: "done" }; } },
      tools: realWriter,
      fileCheckpointSink: createFileCheckpointSink({ home, cwd: work, sessionUuid: sessionId }),
    });
    second.host.output.write({ type: "control_request", requestId: "rw", subtype: "rewind_files", payload: { user_message_id: envelopeId, dry_run: true } });
    second.host.output.write({ type: "user", text: "what would happen?" });
    second.host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames2 = await drain(second.host.input);
    await done2;

    const payload = (frames2.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "rw") as ControlResponseFrame).payload as Record<string, unknown>;
    expect(payload).toMatchObject({ canRewind: true, filesChanged: [tracked], insertions: 1, deletions: 2 });
    expect("skippedLinks" in payload).toBe(false);
    expect(readFileSync(tracked, "utf8")).toBe("changed\nand grew\n");
  });

  test("an id from a DIFFERENT session cannot rewind this one", async () => {
    const tracked = join(work, "tracked.ts");
    writeFileSync(tracked, "original\n");
    await createFileCheckpointSink({ home, cwd: work, sessionUuid: "someone-else" }).beforeMutation({
      path: tracked,
      tool: "Write",
      userMessageUuid: "u-elsewhere",
      sessionUuid: "someone-else",
    });
    writeFileSync(tracked, "changed by the other session\n");

    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig(),
      input: runtime.input,
      output: runtime.output,
      provider: { async generate() { return { kind: "text", text: "done" }; } },
      tools: realWriter,
      fileCheckpointSink: createFileCheckpointSink({ home, cwd: work, sessionUuid: sessionId }),
    });
    host.output.write({ type: "control_request", requestId: "rw", subtype: "rewind_files", payload: { user_message_id: "u-elsewhere" } });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    const response = frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "rw") as ControlResponseFrame;
    // An answer, not a fault -- and the other session's file is untouched.
    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ canRewind: false });
    expect(readFileSync(tracked, "utf8")).toBe("changed by the other session\n");
  });
});
