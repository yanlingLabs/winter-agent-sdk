import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
import { inMemoryProcess } from "../../runtime/src/testing.ts";
import { testProviderByName, userMessageText } from "../../runtime/src/provider/mock.ts";
import type { Provider, ProviderMessage } from "../../runtime/src/engine.ts";
import type { SpawnedRuntimeProcess } from "./transport.ts";
import { WINTER_BRAND, envName } from "./brand.ts";

const mainPath = fileURLToPath(new URL("../../runtime/src/main.ts", import.meta.url));
const preloadPath = fileURLToPath(new URL("../../../scripts/fixtures/subagent-cold-restart-provider.preload.ts", import.meta.url));
const REPLY = "COLD_RESTART_REPLY:";
type Report = { phase: string; markerSeen: boolean; personaSeen: boolean; currentPersonaSeen: boolean; interruptedIds: string[]; historyValid: boolean; priorReplies: number; cacheKey: string; pid: number };
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
  return collectParent(proc, prompt, phase);
}

async function collectParent(proc: SpawnedRuntimeProcess, prompt: string, phase: string) {
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

test.each([undefined, "cold-restart-project-override"])("SendMessage resumes the same named child through real parent restarts (project override: %s)", async (projectDirName) => {
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
    ...(projectDirName !== undefined ? { WINTER_PROJECT_DIR_NAME: projectDirName } : {}),
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
    const recordedProjectKey = projectDirName ?? compatibilityKeys(cwd).transcriptProjectKey;
    const projects = join(winterHome, "projects");
    const subagents = join(projects, recordedProjectKey, sessionId, "subagents");
    const transcriptPath = join(subagents, `agent-${childId}.jsonl`);
    const initialTranscript = readFileSync(transcriptPath, "utf8");
    expect(initialTranscript).toContain("COLD_RESTART_SECRET_MARKER");
    const initialFiles = readdirSync(subagents).sort();

    // Current trusted definitions remain authoritative across every process incarnation.
    const resumedConfig = { ...base, agents: { "cold-probe": { ...base.agents!["cold-probe"]!, prompt: "COLD_RESTART_CURRENT_PERSONA" } } };
    const changedEnv = { ...env, ...(projectDirName !== undefined ? { WINTER_PROJECT_DIR_NAME: "changed-project-override" } : {}) };
    const second = await runParent({ ...resumedConfig, resume: sessionId },
      "CALL ListAgents {}\nCALL SendMessage " + JSON.stringify({ to: childId, message: "FOLLOWUP_ONE" }), changedEnv, "FOLLOWUP_ONE");
    expect(second.pid).not.toBe(first.pid);
    expect(toolResults(second.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(JSON.stringify(toolResults(second.frames))).toContain("durable-probe");
    expect(JSON.stringify(toolResults(second.frames))).toContain(childId);
    const secondReply = childReplies(second.frames).at(-1)!;
    expect(secondReply).toMatchObject({ phase: "FOLLOWUP_ONE", markerSeen: true, personaSeen: false, currentPersonaSeen: true, priorReplies: 1, pid: second.pid });
    expect(secondReply.cacheKey).toBe(initialReply.cacheKey);
    expect(replyCorrelations(second.frames)).toEqual([originalSpawnId]);
    const secondTranscript = readFileSync(transcriptPath, "utf8");
    expect(secondTranscript.startsWith(initialTranscript)).toBe(true);
    expect(secondTranscript).toContain("FOLLOWUP_ONE");

    const unsetEnv = { ...env };
    delete unsetEnv.WINTER_PROJECT_DIR_NAME;
    const third = await runParent({ ...resumedConfig, resume: sessionId },
      "CALL ListAgents {}\nCALL SendMessage " + JSON.stringify({ to: "durable-probe", message: "FOLLOWUP_TWO" }), unsetEnv, "FOLLOWUP_TWO");
    expect(new Set([first.pid, second.pid, third.pid]).size).toBe(3);
    expect(toolResults(third.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(childReplies(third.frames).at(-1)).toMatchObject({ phase: "FOLLOWUP_TWO", markerSeen: true, personaSeen: false, currentPersonaSeen: true,
      priorReplies: 2, cacheKey: initialReply.cacheKey, pid: third.pid });
    expect(replyCorrelations(third.frames)).toEqual([originalSpawnId]);
    expect(JSON.stringify(toolResults(third.frames))).toContain(childId);
    expect(readdirSync(projects)).toEqual([recordedProjectKey]);
    expect(readdirSync(subagents).sort()).toEqual(initialFiles);
    const finalTranscript = readFileSync(transcriptPath, "utf8");
    expect(finalTranscript.startsWith(secondTranscript)).toBe(true);
    expect(finalTranscript).toContain("FOLLOWUP_TWO");
    expect(readFileSync(join(cwd, "initial-effects.txt"), "utf8")).toBe("initial-effect\n");
    const reports = readFileSync(reportsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Report);
    expect(new Set(reports.map((report) => report.pid))).toEqual(new Set([first.pid, second.pid, third.pid]));
    expect(reports.every((report) => report.markerSeen && report.historyValid)).toBe(true);
    // No restart may replay an original Agent call and create a second child.
    for (const run of [second, third]) expect(messages(run.frames).flatMap((message) => message.message?.content ?? [])
      .filter((block) => block.type === "tool_use" && block.name === "Agent")).toEqual([]);

    const { agents: _definitions, ...missingDefinitionConfig } = base;
    const refused = await runParent({ ...missingDefinitionConfig, resume: sessionId }, "CALL SendMessage " + JSON.stringify({
      to: childId, message: "FOLLOWUP_ONE MUST NOT EXECUTE",
    }), unsetEnv, "FOLLOWUP_ONE");
    expect(toolResults(refused.frames).find((result) => result.status !== undefined)?.status).toBe("unavailable");
    expect(childReplies(refused.frames)).toEqual([]);
    expect(readFileSync(transcriptPath, "utf8")).toBe(finalTranscript);
    expect(readFileSync(reportsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Report)
      .some((report) => report.pid === refused.pid)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 175_000);

test.each(["WINTER_", "ACME_"])("inMemoryProcess retains the recorded child directory after changed and unset %s overrides", async (envPrefix) => {
  const root = mkdtempSync(join(tmpdir(), "winter-subagent-project-key-"));
  const cwd = join(root, "workspace");
  const winterHome = join(root, "winter-home");
  mkdirSync(cwd);
  const sessionId = randomUUID();
  const brand = { ...WINTER_BRAND, envPrefix };
  const overrideName = envName(brand, "PROJECT_DIR_NAME");
  const recordedProjectKey = "recorded-child-directory";
  const base: RuntimeConfig = {
    sessionId, cwd, winterHome, brand, model: "winter-test/calls", settingSources: [],
    allowedTools: ["Agent", "SendMessage", "ListAgents"], forwardSubagentText: true,
    sandbox: { enabled: false }, autoMemory: { enabled: false },
    agents: { "cold-probe": { description: "Remember context", prompt: "COLD_RESTART_PERSONA", tools: [] } },
  };
  const calls = testProviderByName("calls");
  const provider: Provider = {
    async generate(request) {
      if (!request.cacheKey?.includes(":")) return calls.generate({ ...request, messages: request.messages.map((message): ProviderMessage =>
        message.role === "tool" && userMessageText(message).split("\n").some((line) => line.trim().startsWith("CALL "))
          ? { ...message, role: "user" } : message) });
      const text = request.messages.filter((message) => message.role === "user" || message.role === "tool").map(userMessageText).at(-1) ?? "";
      const report = {
        phase: text.includes("FOLLOWUP_TWO") ? "FOLLOWUP_TWO" : text.includes("FOLLOWUP_ONE") ? "FOLLOWUP_ONE" : "INITIAL",
        markerSeen: JSON.stringify(request.messages).includes("COLD_RESTART_SECRET_MARKER"),
        personaSeen: request.system?.includes("COLD_RESTART_PERSONA") === true,
        priorReplies: request.messages.filter((message) => message.role === "assistant" && userMessageText(message).includes(REPLY)).length,
        cacheKey: request.cacheKey,
      };
      return { kind: "text", text: REPLY + JSON.stringify(report) };
    },
  };
  const initialEnv: Record<string, string> = {
    [overrideName]: recordedProjectKey, [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY,
    // A branded session must never accidentally resolve Winter's env spelling.
    ...(envPrefix !== WINTER_BRAND.envPrefix ? { WINTER_PROJECT_DIR_NAME: "wrong-brand-directory" } : {}),
  };
  const run = (config: RuntimeConfig, prompt: string, env: Record<string, string>, phase: string) =>
    collectParent(inMemoryProcess(["--run", "--config-json", JSON.stringify(config)], provider, undefined, env), prompt, phase);
  try {
    const first = await run(base, "CALL Agent " + JSON.stringify({ name: "durable-probe", subagent_type: "cold-probe",
      description: "Persist memory", prompt: "COLD_RESTART_SECRET_MARKER", run_in_background: false }), initialEnv, "INITIAL");
    const childId = toolResults(first.frames).find((result) => typeof result.agentId === "string")?.agentId as string;
    expect(childId).toBeString();
    const projects = join(winterHome, "projects");
    const subagents = join(projects, recordedProjectKey, sessionId, "subagents");
    const transcriptPath = join(subagents, `agent-${childId}.jsonl`);
    const initialTranscript = readFileSync(transcriptPath, "utf8");
    const files = readdirSync(subagents).sort();
    expect(childReplies(first.frames).at(-1)).toMatchObject({ markerSeen: true, personaSeen: true, priorReplies: 0 });
    const changedEnv = { ...initialEnv, [overrideName]: "changed-child-directory" };
    const second = await run({ ...base, resume: sessionId }, "CALL ListAgents {}\nCALL SendMessage " + JSON.stringify({
      to: childId, message: "FOLLOWUP_ONE" }), changedEnv, "FOLLOWUP_ONE");
    const unsetEnv = { ...initialEnv };
    delete unsetEnv[overrideName];
    const third = await run({ ...base, resume: sessionId }, "CALL ListAgents {}\nCALL SendMessage " + JSON.stringify({
      to: "durable-probe", message: "FOLLOWUP_TWO" }), unsetEnv, "FOLLOWUP_TWO");
    for (const [index, resumed] of [second, third].entries()) {
      expect(toolResults(resumed.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
      expect(JSON.stringify(toolResults(resumed.frames))).toContain(childId);
      expect(childReplies(resumed.frames).at(-1)).toMatchObject({ markerSeen: true, personaSeen: true,
        priorReplies: index + 1, cacheKey: childReplies(first.frames).at(-1)!.cacheKey });
      expect(messages(resumed.frames).flatMap((message) => message.message?.content ?? [])
        .filter((block) => block.type === "tool_use" && block.name === "Agent")).toEqual([]);
    }
    expect(readdirSync(projects)).toEqual([recordedProjectKey]);
    expect(readdirSync(subagents).sort()).toEqual(files);
    const finalTranscript = readFileSync(transcriptPath, "utf8");
    expect(finalTranscript.startsWith(initialTranscript)).toBe(true);
    expect(finalTranscript).toContain("FOLLOWUP_ONE");
    expect(finalTranscript).toContain("FOLLOWUP_TWO");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 90_000);

test("nested children keep their depth, history and recorded project key across changed and unset overrides", async () => {
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
    WINTER_PROJECT_DIR_NAME: "nested-recorded-project",
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
    const projects = join(winterHome, "projects");
    const subagents = join(projects, env.WINTER_PROJECT_DIR_NAME!, sessionId, "subagents");
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
    const changedEnv = { ...env, WINTER_PROJECT_DIR_NAME: "changed-nested-project" };
    const second = await runParent({ ...base, resume: sessionId },
      "CALL SendMessage " + JSON.stringify({ to: "nested-leaf", message: "FOLLOWUP_ONE" }), changedEnv, "FOLLOWUP_ONE");
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

    // A restored parent child receives the raw TranscriptWriter. Its newly spawned descendant
    // must use that writer's recorded project identity, not the current environment's override.
    const newLeafScript = "CALL Agent " + JSON.stringify({ name: "post-restart-leaf", subagent_type: "cold-probe",
      description: "Created after the ancestor resumed", prompt: "COLD_RESTART_SECRET_MARKER", run_in_background: false });
    const third = await runParent({ ...base, resume: sessionId }, "CALL SendMessage " + JSON.stringify({
      to: "nested-parent", message: newLeafScript }), changedEnv, "INITIAL");
    expect(toolResults(third.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    const newLeafFile = readdirSync(subagents).filter((file) => file.endsWith(".meta.json"))
      .find((file) => JSON.parse(readFileSync(join(subagents, file), "utf8")).name === "post-restart-leaf")!;
    expect(newLeafFile).toBeString();
    const newLeafMetadata = JSON.parse(readFileSync(join(subagents, newLeafFile), "utf8")) as { id: string; spawnDepth: number };
    expect(newLeafMetadata.spawnDepth).toBe(2);
    const newLeafTranscriptPath = join(subagents, newLeafFile.replace(".meta.json", ".jsonl"));
    const newLeafBefore = readFileSync(newLeafTranscriptPath, "utf8");
    const unsetEnv = { ...env };
    delete unsetEnv.WINTER_PROJECT_DIR_NAME;
    const fourth = await runParent({ ...base, resume: sessionId }, "CALL ListAgents {}\nCALL SendMessage " + JSON.stringify({
      to: newLeafMetadata.id, message: "FOLLOWUP_ONE" }), unsetEnv, "FOLLOWUP_ONE");
    expect(new Set([first.pid, second.pid, third.pid, fourth.pid]).size).toBe(4);
    expect(toolResults(fourth.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(childReplies(fourth.frames).at(-1)).toMatchObject({ markerSeen: true, priorReplies: 1,
      cacheKey: childReplies(third.frames).at(-1)!.cacheKey });
    expect(readFileSync(newLeafTranscriptPath, "utf8").startsWith(newLeafBefore)).toBe(true);
    expect(readdirSync(subagents).filter((file) => file.endsWith(".meta.json"))).toHaveLength(3);
    expect(readdirSync(projects)).toEqual([env.WINTER_PROJECT_DIR_NAME!]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 175_000);

test("SIGKILL during a child tool resumes valid parent and child histories in a fresh PID without repeating its effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "winter-subagent-sigkill-"));
  const cwd = join(root, "workspace");
  const winterHome = join(root, "winter-home");
  mkdirSync(cwd);
  const sessionId = randomUUID();
  const config: RuntimeConfig = {
    sessionId, cwd, model: "winter-test/calls", settingSources: [],
    allowedTools: ["Agent", "SendMessage", "Bash"], forwardSubagentText: true,
    sandbox: { enabled: false }, autoMemory: { enabled: false },
    agents: { "cold-probe": { description: "Crash context probe", prompt: "COLD_RESTART_PERSONA", tools: ["Bash"] } },
  };
  const reportsPath = join(root, "provider-requests.jsonl");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), TZ: "UTC",
    WINTER_HOME: winterHome, WINTER_DISABLE_GIT_INSTRUCTIONS: "1",
    WINTER_COLD_RESTART_REPORTS: reportsPath, [TEST_KEYCHAIN_ENV]: TEST_KEYCHAIN_MEMORY,
  };
  const proc = defaultSpawn({ command: process.execPath, args: ["--preload", preloadPath, mainPath,
    "--run", "--config-json", JSON.stringify(config)], cwd, env });
  expect(proc.pid).toBeGreaterThan(0);
  expect(proc.pid).not.toBe(process.pid);
  let stderr = "";
  const readErr = (async () => { for await (const chunk of proc.stderr ?? []) stderr += chunk; })();
  const drain = (async () => { for await (const _chunk of proc.stdout) { /* keep pipes draining until the OS kill */ } })();
  try {
    proc.stdin.write(encodeFrame({ type: "user", text: "CALL Agent " + JSON.stringify({
      name: "crashed-probe", subagent_type: "cold-probe", description: "Crash mid tool",
      prompt: "COLD_RESTART_SECRET_MARKER CRASH_START", run_in_background: false,
    }) }));
    await bounded(new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (existsSync(join(cwd, "crash-started.txt"))) { clearInterval(interval); resolve(); }
      }, 10);
      // Do not retain a timer if startup fails before it can reach the tool.
      proc.exited.then(() => { clearInterval(interval); resolve(); });
    }), "child side effect before SIGKILL");
    expect(existsSync(join(cwd, "crash-started.txt")), stderr).toBe(true);
    const subagents = join(winterHome, "projects", compatibilityKeys(cwd).transcriptProjectKey, sessionId, "subagents");
    const metadataFile = readdirSync(subagents).find((file) => file.endsWith(".meta.json"))!;
    const metadata = JSON.parse(readFileSync(join(subagents, metadataFile), "utf8")) as { id: string };
    const transcriptPath = join(subagents, metadataFile.replace(".meta.json", ".jsonl"));
    const before = readFileSync(transcriptPath, "utf8");
    expect(before).toContain('"id":"crash-call"');
    expect(before).not.toContain('"tool_use_id":"crash-call"');
    const initialReport = JSON.parse(readFileSync(reportsPath, "utf8").trim().split("\n")[0]!) as Report;
    expect(initialReport.pid).toBe(proc.pid!);
    // This is an OS kill of the real runtime while Bash is still executing, with no graceful
    // interrupt frame and no chance for the live tool loop to persist its synthetic result.
    proc.kill("SIGKILL");
    expect(await bounded(proc.exited, "SIGKILL parent exit")).toEqual({ code: null, signal: "SIGKILL" });
    await Promise.all([drain, readErr]);
    const second = await runParent({ ...config, resume: sessionId }, "CALL SendMessage " + JSON.stringify({
      to: metadata.id, message: "FOLLOWUP_CRASH",
    }), env, "FOLLOWUP_CRASH");
    expect(second.pid).not.toBe(proc.pid);
    expect(toolResults(second.frames).find((result) => result.status !== undefined)?.status).toBe("resumed_and_delivered");
    expect(childReplies(second.frames).at(-1)).toMatchObject({ phase: "FOLLOWUP_CRASH", markerSeen: true,
      personaSeen: true, priorReplies: 0, interruptedIds: ["crash-call"], historyValid: true,
      cacheKey: initialReport.cacheKey, pid: second.pid });
    expect(readFileSync(transcriptPath, "utf8").startsWith(before)).toBe(true);
    const third = await runParent({ ...config, resume: sessionId }, "CALL SendMessage " + JSON.stringify({
      to: "crashed-probe", message: "FOLLOWUP_CRASH AGAIN",
    }), env, "FOLLOWUP_CRASH");
    expect(new Set([proc.pid, second.pid, third.pid]).size).toBe(3);
    expect(childReplies(third.frames).at(-1)).toMatchObject({ phase: "FOLLOWUP_CRASH", priorReplies: 1,
      interruptedIds: ["crash-call"], historyValid: true, cacheKey: initialReport.cacheKey });
    expect(readFileSync(join(cwd, "crash-effects.txt"), "utf8")).toBe("crash-effect\n");
    expect(existsSync(join(cwd, "initial-effects.txt"))).toBe(false);
    expect(readdirSync(subagents).filter((file) => file.endsWith(".meta.json"))).toHaveLength(1);
  } finally {
    proc.kill("SIGKILL");
    await bounded(proc.exited, "SIGKILL cleanup");
    await Promise.all([drain, readErr]);
    rmSync(root, { recursive: true, force: true });
  }
}, 135_000);
