import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { defaultSpawn } from "./transport.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import type { WinterFrame } from "./protocol/frames.ts";
import { TEST_KEYCHAIN_ENV, TEST_KEYCHAIN_MEMORY } from "./options.ts";
import { compatibilityKeys } from "./paths/keys.ts";

const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));
const preloadPath = fileURLToPath(new URL("../../../scripts/fixtures/subagent-cold-restart-provider.preload.ts", import.meta.url));
const REPLY = "COLD_RESTART_REPLY:";
type Report = { phase: string; markerSeen: boolean; personaSeen: boolean; priorReplies: number; cacheKey: string; pid: number };
type Block = { type: string; id?: string; text?: string; content?: string; name?: string; input?: unknown };
type Message = { type: string; parent_tool_use_id?: string | null; subtype?: string; message?: { content?: Block[] } };

function messages(frames: WinterFrame[]): Message[] {
  return frames.filter((frame) => frame.type === "data").map((frame) => (frame as { message: Message }).message);
}

function childReplies(frames: WinterFrame[]): Report[] {
  return messages(frames).filter((message) => message.type === "assistant" && message.parent_tool_use_id != null)
    .flatMap((message) => message.message?.content ?? [])
    .filter((block) => block.type === "text" && block.text?.startsWith(REPLY))
    .map((block) => JSON.parse(block.text!.slice(REPLY.length)) as Report);
}

function replyCorrelations(frames: WinterFrame[]): Array<string | null | undefined> {
  return messages(frames).filter((message) => message.type === "assistant"
    && message.message?.content?.some((block) => block.type === "text" && block.text?.startsWith(REPLY)))
    .map((message) => message.parent_tool_use_id);
}

function toolResults(frames: WinterFrame[]): Array<Record<string, unknown>> {
  return messages(frames).filter((message) => message.type === "user" && message.parent_tool_use_id == null)
    .flatMap((message) => message.message?.content ?? [])
    .filter((block) => block.type === "tool_result" && typeof block.content === "string")
    .map((block) => JSON.parse(block.content!) as Record<string, unknown>);
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      // Source-runtime startup under the mandatory child Keychain/network guard preloads is
      // substantially slower than an unguarded Bun source process on some developer machines.
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 40_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

// Each invocation owns a REAL parent runtime process, not another inMemoryProcess call.
// The prior invocation is fully reaped before the caller starts the next one.
async function runParent(config: RuntimeConfig, prompt: string, env: Record<string, string>, phase: string) {
  const proc = defaultSpawn({ command: process.execPath, args: ["--preload", preloadPath, mainPath,
    "--run", "--config-json", JSON.stringify(config)], cwd: config.cwd, env });
  expect(proc.pid).toBeGreaterThan(0);
  expect(proc.pid).not.toBe(process.pid);
  const frames: WinterFrame[] = [];
  let stderr = "";
  const readErr = (async () => { for await (const chunk of proc.stderr ?? []) stderr += chunk; })();
  const read = (async () => {
    let carry = "";
    let ended = false;
    for await (const chunk of proc.stdout) {
      const split = splitFrames(chunk, carry);
      carry = split.carry;
      for (const frame of split.frames) {
        frames.push(frame);
        const parentFinished = messages(frames).some((message) => message.type === "result" && message.parent_tool_use_id == null);
        // A refusal must settle promptly too, so the old restoredChildHandle fails on its
        // actual unavailable result rather than a misleading fixture timeout.
        const refused = toolResults(frames).some((result) => result.status === "unavailable" || result.status === "not_found");
        if (!ended && parentFinished && (refused || childReplies(frames).some((reply) => reply.phase === phase))) {
          ended = true;
          proc.stdin.write(encodeFrame({ type: "control_request", requestId: "finish", subtype: "end_input", payload: {} }));
          proc.stdin.end();
        }
      }
    }
    expect(carry).toBe("");
  })();
  try {
    proc.stdin.write(encodeFrame({ type: "user", text: prompt }));
    await bounded(read, `parent ${proc.pid} (${phase})`).catch((error: unknown) => {
      throw new Error(`${String(error)}; stderr=${stderr}; frames=${JSON.stringify(frames)}`);
    });
    const exit = await bounded(proc.exited, `parent ${proc.pid} exit`);
    await readErr;
    expect(exit, stderr).toEqual({ code: 0, signal: null });
    return { frames, pid: proc.pid!, stderr };
  } finally {
    proc.kill("SIGKILL");
    await bounded(proc.exited, `cleanup ${proc.pid}`);
    await readErr;
  }
}

test("SendMessage resumes the same named child and its context through two real parent process restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "winter-subagent-cold-restart-"));
  const cwd = join(root, "workspace");
  const winterHome = join(root, "winter-home");
  const reportsPath = join(root, "provider-requests.jsonl");
  mkdirSync(cwd);
  const sessionId = randomUUID();
  const base: RuntimeConfig = {
    sessionId, cwd, model: "winter-test/calls", settingSources: [],
    allowedTools: ["Agent", "SendMessage", "ListAgents", "Bash"],
    forwardSubagentText: true, sandbox: { enabled: false }, autoMemory: { enabled: false },
    agents: { "cold-probe": { description: "Durable context probe", prompt: "COLD_RESTART_PERSONA", tools: ["Bash"] } },
  };
  // An explicit, small child environment excludes API keys, credential paths and the user's
  // Winter tree. HOME is neither read nor overridden by this harness.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), TZ: "UTC",
    WINTER_HOME: winterHome, WINTER_DISABLE_GIT_INSTRUCTIONS: "1",
    WINTER_COLD_RESTART_REPORTS: reportsPath, [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY,
  };
  try {
    const first = await runParent(base, "CALL Agent " + JSON.stringify({
      name: "durable-probe", subagent_type: "cold-probe", description: "Persist context before restart",
      prompt: "COLD_RESTART_SECRET_MARKER", run_in_background: false,
    }), env, "INITIAL");
    const childId = toolResults(first.frames).find((result) => typeof result.agentId === "string")?.agentId as string;
    expect(childId).toBeString();
    const originalSpawnId = messages(first.frames).filter((message) => message.type === "assistant" && message.parent_tool_use_id == null)
      .flatMap((message) => message.message?.content ?? []).find((block) => block.type === "tool_use" && block.name === "Agent")?.id;
    expect(originalSpawnId).toBeString();
    expect(replyCorrelations(first.frames)).toEqual([originalSpawnId]);
    const initialReply = childReplies(first.frames).at(-1)!;
    expect(initialReply).toMatchObject({ phase: "INITIAL", markerSeen: true, personaSeen: true, priorReplies: 0, pid: first.pid });
    const subagents = join(winterHome, "projects", compatibilityKeys(cwd).transcriptProjectKey, sessionId, "subagents");
    const transcriptPath = join(subagents, `agent-${childId}.jsonl`);
    const initialTranscript = readFileSync(transcriptPath, "utf8");
    expect(initialTranscript).toContain("COLD_RESTART_SECRET_MARKER");
    const initialFiles = readdirSync(subagents).sort();

    // Remove the original definition from restart configs. The restored child must keep its
    // original persona without needing the caller to repeat its original Agent definition.
    const { agents: _definitions, ...resumedConfig } = base;
    const second = await runParent({ ...resumedConfig, resume: sessionId },
      "CALL ListAgents {}\nCALL SendMessage " + JSON.stringify({ to: childId, message: "FOLLOWUP_ONE" }), env, "FOLLOWUP_ONE");
    expect(second.pid).not.toBe(first.pid);
    expect(toolResults(second.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(JSON.stringify(toolResults(second.frames))).toContain("durable-probe");
    const secondReply = childReplies(second.frames).at(-1)!;
    expect(secondReply).toMatchObject({ phase: "FOLLOWUP_ONE", markerSeen: true, personaSeen: true, priorReplies: 1, pid: second.pid });
    expect(secondReply.cacheKey).toBe(initialReply.cacheKey);
    expect(replyCorrelations(second.frames)).toEqual([originalSpawnId]);
    const secondTranscript = readFileSync(transcriptPath, "utf8");
    expect(secondTranscript.startsWith(initialTranscript)).toBe(true);
    expect(secondTranscript).toContain("FOLLOWUP_ONE");

    const third = await runParent({ ...resumedConfig, resume: sessionId },
      "CALL SendMessage " + JSON.stringify({ to: "durable-probe", message: "FOLLOWUP_TWO" }), env, "FOLLOWUP_TWO");
    expect(new Set([first.pid, second.pid, third.pid]).size).toBe(3);
    expect(toolResults(third.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(childReplies(third.frames).at(-1)).toMatchObject({ phase: "FOLLOWUP_TWO", markerSeen: true, personaSeen: true,
      priorReplies: 2, cacheKey: initialReply.cacheKey, pid: third.pid });
    expect(replyCorrelations(third.frames)).toEqual([originalSpawnId]);
    expect(readdirSync(subagents).sort()).toEqual(initialFiles);
    const finalTranscript = readFileSync(transcriptPath, "utf8");
    expect(finalTranscript.startsWith(secondTranscript)).toBe(true);
    expect(finalTranscript).toContain("FOLLOWUP_TWO");
    expect(readFileSync(join(cwd, "initial-effects.txt"), "utf8")).toBe("initial-effect\n");
    const reports = readFileSync(reportsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Report);
    expect(new Set(reports.map((report) => report.pid))).toEqual(new Set([first.pid, second.pid, third.pid]));
    expect(reports.every((report) => report.markerSeen && report.personaSeen)).toBe(true);
    // No restart may replay an original Agent call and create a second child.
    for (const run of [second, third]) expect(messages(run.frames).flatMap((message) => message.message?.content ?? [])
      .filter((block) => block.type === "tool_use" && block.name === "Agent")).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 135_000);

test("a nested child remains addressable with its original depth and history after its parent process exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "winter-nested-cold-restart-"));
  const cwd = join(root, "workspace");
  const winterHome = join(root, "winter-home");
  mkdirSync(cwd);
  const sessionId = randomUUID();
  const base: RuntimeConfig = {
    sessionId, cwd, model: "winter-test/calls", settingSources: [],
    allowedTools: ["Agent", "SendMessage", "ListAgents", "Bash"],
    forwardSubagentText: true, sandbox: { enabled: false }, autoMemory: { enabled: false },
    agents: {
      "nested-spawner": { description: "Spawn a durable descendant", prompt: "COLD_RESTART_NESTED_SPAWNER", tools: ["Agent", "Bash"] },
      "cold-probe": { description: "Durable context probe", prompt: "COLD_RESTART_PERSONA", tools: ["Bash"] },
    },
  };
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), TZ: "UTC",
    WINTER_HOME: winterHome, WINTER_DISABLE_GIT_INSTRUCTIONS: "1",
    WINTER_COLD_RESTART_REPORTS: join(root, "provider-requests.jsonl"), [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY,
  };
  try {
    const leafScript = "CALL Agent " + JSON.stringify({
      name: "nested-leaf", subagent_type: "cold-probe", description: "Remember nested context",
      prompt: "COLD_RESTART_SECRET_MARKER", run_in_background: false,
    });
    const first = await runParent(base, "CALL Agent " + JSON.stringify({
      name: "nested-parent", subagent_type: "nested-spawner", description: "Spawn nested context probe",
      prompt: leafScript, run_in_background: false,
    }), env, "INITIAL");
    const subagents = join(winterHome, "projects", compatibilityKeys(cwd).transcriptProjectKey, sessionId, "subagents");
    const initialFiles = readdirSync(subagents).sort();
    const metadata = initialFiles.filter((file) => file.endsWith(".meta.json"))
      .map((file) => ({ file, record: JSON.parse(readFileSync(join(subagents, file), "utf8")) as { id: string; name: string; spawnDepth: number; status: string } }));
    expect(metadata).toHaveLength(2);
    const leaf = metadata.find((entry) => entry.record.name === "nested-leaf")!;
    expect(leaf.record.spawnDepth).toBe(2);
    const transcriptPath = join(subagents, leaf.file.replace(".meta.json", ".jsonl"));
    const before = readFileSync(transcriptPath, "utf8");
    const originalReply = childReplies(first.frames).at(-1)!;
    expect(originalReply).toMatchObject({ markerSeen: true, personaSeen: true, priorReplies: 0 });
    const { agents: _definitions, ...resumedConfig } = base;
    const second = await runParent({ ...resumedConfig, resume: sessionId },
      "CALL SendMessage " + JSON.stringify({ to: "nested-leaf", message: "FOLLOWUP_ONE" }), env, "FOLLOWUP_ONE");
    expect(second.pid).not.toBe(first.pid);
    expect(toolResults(second.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(childReplies(second.frames).at(-1)).toMatchObject({ phase: "FOLLOWUP_ONE", markerSeen: true, personaSeen: true,
      priorReplies: 1, cacheKey: originalReply.cacheKey, pid: second.pid });
    const restoredMetadata = JSON.parse(readFileSync(join(subagents, leaf.file), "utf8")) as Record<string, unknown>;
    expect(restoredMetadata).toMatchObject({ id: leaf.record.id, name: "nested-leaf", spawnDepth: 2, status: "completed" });
    const after = readFileSync(transcriptPath, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("FOLLOWUP_ONE");
    expect(readdirSync(subagents).sort()).toEqual(initialFiles);
    expect(readFileSync(join(cwd, "initial-effects.txt"), "utf8")).toBe("initial-effect\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 95_000);
