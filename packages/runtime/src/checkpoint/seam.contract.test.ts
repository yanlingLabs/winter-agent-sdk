// Phase 5 Task 3 (R5-2): the SEAM AUTHORITY for `checkpoint/seam.ts`. Lane K keeps this green
// against its real backup store; the engine keeps it green against interception and the control
// request.
import { test, expect, describe } from "bun:test";
import type { RewindFilesResult, RuntimeConfig, WinterFrame, ControlResponseFrame, ProtocolSdkMessage as SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type Provider, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { CHECKPOINTED_TOOLS, fakeFileCheckpointSink, isCheckpointedTool, type CheckpointMutation } from "./seam.ts";

const baseConfig = (overrides: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ sessionId: "s", cwd: "/tmp/x", model: "sonnet", ...overrides });

async function drain(source: AsyncIterable<WinterFrame>): Promise<WinterFrame[]> {
  const out: WinterFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** One tool-use round, then plain text. */
function oneToolRound(name: string, input: unknown): Provider {
  let i = 0;
  return {
    async generate(): Promise<ProviderTurn> {
      if (i++ === 0) return { kind: "tool_use", calls: [{ id: "c1", name, input }] };
      return { kind: "text", text: "done" };
    },
  };
}

describe("checkpoint/seam.ts -- FileCheckpointSink (Lane K implements)", () => {
  test("the intercepted set is exactly Write/Edit/NotebookEdit -- Bash and subagent changes are out of scope", () => {
    expect([...CHECKPOINTED_TOOLS]).toEqual(["Write", "Edit", "NotebookEdit"]);
    expect(isCheckpointedTool("Write")).toBe(true);
    expect(isCheckpointedTool("Bash")).toBe(false);
    expect(isCheckpointedTool("Agent")).toBe(false);
  });

  test("the rewind signature is the AMENDED R5-11 one: an options object and a six-field typed result", async () => {
    const rewindCalls: Array<{ userMessageUuid: string; dryRun: boolean }> = [];
    const full: RewindFilesResult = { canRewind: true, filesChanged: ["/w/a.ts"], insertions: 3, deletions: 1, skippedLinks: 0 };
    const sink = fakeFileCheckpointSink({ rewindCalls, results: { "u-1": full } });
    expect(await sink.rewind("u-1")).toEqual(full);
    expect(await sink.rewind("u-1", { dryRun: true })).toEqual(full);
    expect(rewindCalls).toEqual([
      { userMessageUuid: "u-1", dryRun: false },
      { userMessageUuid: "u-1", dryRun: true },
    ]);
    // An unknown id is an ANSWER, not a throw.
    expect(await sink.rewind("nope")).toMatchObject({ canRewind: false });
  });

  // --- The engine's half -----------------------------------------------------------------------------

  test("beforeMutation fires for a Write when checkpointing is ON, with the path, tool, session and envelope id", async () => {
    const mutations: CheckpointMutation[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({ enableFileCheckpointing: true, allowedTools: ["Write"] }),
      input: runtime.input,
      output: runtime.output,
      provider: oneToolRound("Write", { file_path: "/w/a.ts", content: "x" }),
      tools: stubExecutor,
      fileCheckpointSink: fakeFileCheckpointSink({ mutations }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;

    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.tool).toBe("Write");
    expect(mutations[0]!.path).toBe("/w/a.ts");
    expect(mutations[0]!.sessionUuid).toBe("s");
    // The envelope id the sink was handed is the SAME one the host is told to rewind to -- if these
    // two ever diverged, every rewindFiles() call would silently target nothing.
    const result = dataMessages(frames).find((m) => m.type === "result") as { user_message_uuid?: string };
    expect(result.user_message_uuid).toBe(mutations[0]!.userMessageUuid);
  });

  test("beforeMutation does NOT fire when checkpointing is off, and the result carries no envelope id", async () => {
    const mutations: CheckpointMutation[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({ allowedTools: ["Write"] }),
      input: runtime.input,
      output: runtime.output,
      provider: oneToolRound("Write", { file_path: "/w/a.ts", content: "x" }),
      tools: stubExecutor,
      fileCheckpointSink: fakeFileCheckpointSink({ mutations }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    expect(mutations).toHaveLength(0);
    // No `user_message_uuid` on the result -- the field is conditional so no pre-P5 trace moves.
    const result = dataMessages(frames).find((m) => m.type === "result") as Record<string, unknown>;
    expect("user_message_uuid" in result).toBe(false);
  });

  test("a Bash write is NOT intercepted -- the scope boundary, not an oversight", async () => {
    const mutations: CheckpointMutation[] = [];
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({ enableFileCheckpointing: true, allowedTools: ["Bash"] }),
      input: runtime.input,
      output: runtime.output,
      provider: oneToolRound("Bash", { command: "echo hi > /w/a.ts" }),
      tools: stubExecutor,
      fileCheckpointSink: fakeFileCheckpointSink({ mutations }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    await drain(host.input);
    await done;
    expect(mutations).toHaveLength(0);
  });

  test("a sink that THROWS is auxiliary: the edit still runs and the turn still completes", async () => {
    const { host, runtime } = createInMemoryChannel();
    const done = runEngine({
      config: baseConfig({ enableFileCheckpointing: true, allowedTools: ["Write"] }),
      input: runtime.input,
      output: runtime.output,
      provider: oneToolRound("Write", { file_path: "/w/a.ts", content: "x" }),
      tools: stubExecutor,
      fileCheckpointSink: fakeFileCheckpointSink({ failBeforeMutation: "disk full" }),
    });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    const messages = dataMessages(frames);
    expect(messages.filter((m) => m.type === "result")).toHaveLength(1);
    expect(messages.some((m) => (m as { checkpoint_error?: string }).checkpoint_error === "disk full")).toBe(true);
  });

  // --- The rewind_files control request ---------------------------------------------------------------

  async function rewindThrough(opts: { enabled: boolean; withSink: boolean; payload: unknown }): Promise<ControlResponseFrame> {
    const { host, runtime } = createInMemoryChannel();
    const sink = fakeFileCheckpointSink({ results: { "u-1": { canRewind: true, filesChanged: ["/w/a.ts"], insertions: 2, deletions: 0, skippedLinks: 1 } } });
    const done = runEngine({
      config: baseConfig({ enableFileCheckpointing: opts.enabled }),
      input: runtime.input,
      output: runtime.output,
      provider: { async generate() { return { kind: "text", text: "done" }; } },
      tools: stubExecutor,
      ...(opts.withSink ? { fileCheckpointSink: sink } : {}),
    });
    host.output.write({ type: "control_request", requestId: "rw", subtype: "rewind_files", payload: opts.payload });
    host.output.write({ type: "user", text: "go" });
    host.output.write({ type: "control_request", requestId: "r", subtype: "end_input", payload: undefined });
    const frames = await drain(host.input);
    await done;
    return frames.find((f) => f.type === "control_response" && (f as ControlResponseFrame).requestId === "rw") as ControlResponseFrame;
  }

  test("the wire shape is snake_case and the RESULT rides the control response payload", async () => {
    const response = await rewindThrough({ enabled: true, withSink: true, payload: { user_message_id: "u-1", dry_run: true } });
    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ canRewind: true, filesChanged: ["/w/a.ts"], insertions: 2, deletions: 0, skippedLinks: 1 });
  });

  test("every failure mode answers `canRewind: false` with an error, NEVER ok:false -- a host must be able to tell 'nothing to rewind' from a transport fault", async () => {
    const noSink = await rewindThrough({ enabled: true, withSink: false, payload: { user_message_id: "u-1" } });
    expect(noSink.ok).toBe(true);
    expect(noSink.payload).toMatchObject({ canRewind: false });
    expect((noSink.payload as { error: string }).error).toContain("sink");

    const disabled = await rewindThrough({ enabled: false, withSink: true, payload: { user_message_id: "u-1" } });
    expect(disabled.ok).toBe(true);
    expect((disabled.payload as { error: string }).error).toContain("enableFileCheckpointing");

    const malformed = await rewindThrough({ enabled: true, withSink: true, payload: {} });
    expect(malformed.ok).toBe(true);
    expect((malformed.payload as { error: string }).error).toContain("user_message_id");

    const unknownId = await rewindThrough({ enabled: true, withSink: true, payload: { user_message_id: "nope" } });
    expect(unknownId.payload).toMatchObject({ canRewind: false });
  });
});
