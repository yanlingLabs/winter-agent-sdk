// 2026-09-17 sdk-taskframes-parity, Lane D2, scenario 5 (plan-0.0.16.md ruling P16-8 / P16-3, R3a §1):
// UNSOLICITED NOTIFICATION TURN. On an OPEN-INPUT host (official: `--input-format stream-json` with
// stdin held open; Winter: a streaming-input `query()` whose prompt AsyncIterable stays pending),
// the parent spawns a background agent and ends its turn. R3a's claim: an open-input host NEVER
// holds `result` back (that is `winter -p`-style closed-input behaviour only) -- turn 1's `result`
// goes out immediately, and once the background child finishes, the runtime starts a NEW model
// request BY ITSELF (no new host input) whose last user content is a `<task-notification>` block,
// followed by a second `result`.
//
// Ground truth captured against the real pinned binary (spike, 2026-09-17): the tool_result for the
// backgrounded spawn is an immediate "Async agent launched successfully..." ack (never the child's
// real result); the unsolicited turn's last user message is wrapped in a
// "[SYSTEM NOTIFICATION - NOT USER INPUT]" anti-injection preamble -- NOT documented in R3a, which
// jumps straight to the `<task-notification>` tags -- around the exact tag set R3a documents
// (task-id, tool-use-id, output-file, status, summary, note, result, usage).
//
// Expected RED against Winter's current baseline: R3a "Winter today" documents that no background
// completion ever reaches the model (no held result, no wait loop) and that the engine tears down
// the instant its own input iterable ends, regardless of a still-running child -- so Winter's side of
// this test is bounded by a grace period (see `runWinter`'s own comment) rather than waiting forever
// for a frame that today never arrives. See differential-harness.ts's own header for shared plumbing.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedClaudeBinary, makeOfficialRoots, cleanupRoots, minimalOfficialEnv, startCapturingLoopback, spawnOfficialStreamJson, sseTextTurn, sseToolUseTurn, sseResponse, OFFICIAL_MODEL, CLAUDE_VERSION, type RawFrame } from "./differential-harness.ts";
import { query } from "../../../sdk/src/index.ts";
import { inMemoryProcess } from "../../../runtime/src/testing.ts";
import type { Provider } from "../../../runtime/src/engine.ts";

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

const PARENT_PROMPT = "spawn a background agent to look something up, then just acknowledge and stop";
const TOOL_USE_SPAWN = "toolu_bgspawn1";
const CHILD_MARKER = "NOTIFY_SCENARIO_CHILD_MARKER";
const CHILD_PROMPT = `${CHILD_MARKER}: just say done`;
const SPAWN_DESCRIPTION = "bg probe";
const PARENT_ACK_TEXT = "parent: kicked off the background agent";
const CHILD_FINAL_TEXT = "child done, nothing found";
const NOTIFICATION_REPLY_TEXT = "ack: saw the notification";

/** Winter has no background-completion delivery today (R3a "Winter today"), so waiting forever for
 *  a frame that never arrives would just be a 120s test timeout with no diagnosis. This bounds it:
 *  once turn 1's own `result` is seen, wait this long for ANY further activity before concluding
 *  "no unsolicited turn" and ending the input iterable so `query()` terminates cleanly. */
const WINTER_GRACE_MS = 5_000;

interface GenericMsg {
  role?: unknown;
  content?: unknown;
}
interface GenericBlock {
  type?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
}

function blocksOf(content: unknown): GenericBlock[] {
  return Array.isArray(content) ? (content as GenericBlock[]) : [];
}
function textsOf(content: unknown): string[] {
  const blocks = blocksOf(content);
  if (blocks.length > 0) return blocks.map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)));
  if (typeof content === "string") return [content];
  return [];
}
function hasToolResultFor(messages: GenericMsg[], id: string): boolean {
  for (const m of messages) for (const b of blocksOf(m.content)) if (b.type === "tool_result" && b.tool_use_id === id) return true;
  return false;
}
function lastUserText(messages: GenericMsg[]): string {
  const u = [...messages].reverse().find((m) => m.role === "user");
  return u ? textsOf(u.content).join("\n") : "";
}
function firstUserIncludes(messages: GenericMsg[], marker: string): boolean {
  const u = messages.find((m) => m.role === "user");
  return u ? textsOf(u.content).some((t) => t.includes(marker)) : false;
}

type Step = "spawn-call" | "spawn-ack-reply" | "child-final" | "notification-reply";

/** Shared routing, marker/tool-result based (never message-count based -- see scenario 3's own
 *  comment on why: the child's own first turn must never be misrouted as a fresh parent turn). */
function decideStep(messages: GenericMsg[]): Step {
  if (lastUserText(messages).includes("<task-notification>")) return "notification-reply";
  if (firstUserIncludes(messages, CHILD_MARKER)) return "child-final";
  if (hasToolResultFor(messages, TOOL_USE_SPAWN)) return "spawn-ack-reply";
  return "spawn-call";
}

/** Extracts the `<task-notification>...</task-notification>` XML (if present) from a message list's
 *  LAST user turn, and parses its top-level tags into a flat map -- structural presence/tag-set
 *  comparison, never text equality (each side's `<summary>`/`<result>` text is its own). */
function extractTaskNotification(messages: GenericMsg[]): { raw: string; tags: Record<string, string> } | undefined {
  const text = lastUserText(messages);
  const match = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(text);
  if (!match) return undefined;
  const inner = match[1]!;
  const tags: Record<string, string> = {};
  for (const m of inner.matchAll(/<([a-z-]+)>([\s\S]*?)<\/\1>/g)) tags[m[1]!] = m[2]!;
  return { raw: match[0], tags };
}

// --- the OFFICIAL side: open-stdin stream-json session -----------------------------------------

interface RunResult {
  frames: RawFrame[];
  resultCount: number;
  /** The messages of the request WHERE `decideStep` read "notification-reply" -- i.e. the request
   *  actually carrying the `<task-notification>` XML in its last user turn, captured directly from
   *  the wire/provider input (the SDK's own OUTPUT frames carry an already-PARSED `task_notification`
   *  system message, never the raw XML the MODEL sees -- this is the only place the XML itself is
   *  observable). `undefined` when no such request ever arrived. */
  notificationRequestMessages: GenericMsg[] | undefined;
}

async function runOfficial(binaryPath: string): Promise<RunResult> {
  const roots = makeOfficialRoots("winter-notify-official-");
  let notificationRequestMessages: GenericMsg[] | undefined;
  const loop = startCapturingLoopback((messages, _body, count) => {
    const step = decideStep(messages as GenericMsg[]);
    console.error(`[notify official] #${count} -> step=${step}`);
    if (step === "notification-reply") notificationRequestMessages = messages as GenericMsg[];
    switch (step) {
      case "spawn-call":
        return sseResponse(sseToolUseTurn([{ id: TOOL_USE_SPAWN, name: "Agent", input: { subagent_type: "general-purpose", description: SPAWN_DESCRIPTION, prompt: CHILD_PROMPT, run_in_background: true } }]));
      case "spawn-ack-reply":
        return sseResponse(sseTextTurn(PARENT_ACK_TEXT));
      case "child-final":
        return sseResponse(sseTextTurn(CHILD_FINAL_TEXT));
      case "notification-reply":
        return sseResponse(sseTextTurn(NOTIFICATION_REPLY_TEXT));
    }
  }, "notify official");
  try {
    const env = minimalOfficialEnv({ home: roots.home, cfg: roots.cfg, baseUrl: loop.url });
    const session = spawnOfficialStreamJson({
      binaryPath,
      env,
      cwd: roots.cwd,
      args: ["--model", OFFICIAL_MODEL, "--permission-mode", "bypassPermissions", "--setting-sources", ""],
    });
    session.send(PARENT_PROMPT);
    // Wait for TWO results: turn 1 (the immediate, non-held reply) and the unsolicited notification
    // turn's own result -- never send a second stdin frame; if a second result never arrives on its
    // own, this throws with the stderr tail, which is the correct failure for the official side (it
    // should ALWAYS arrive there).
    let resultCount = 0;
    while (resultCount < 2) {
      await session.readUntil((f) => f.type === "result", 30_000);
      resultCount++;
    }
    session.close();
    const exitCode = await session.exited;
    console.error(`[notify official] exit=${exitCode}; ${loop.requests.length} loopback request(s)`);
    if (exitCode !== 0) throw new Error(`the pinned claude binary exited ${exitCode}\n${session.stderrTail()}`);
    return { frames: session.allFrames, resultCount, notificationRequestMessages };
  } finally {
    loop.stop();
    cleanupRoots(roots);
  }
}

// --- the WINTER side: streaming-input query(), bounded grace period for the second turn -----------

async function runWinter(): Promise<RunResult> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-notify-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-notify-cwd-"));
  let notificationRequestMessages: GenericMsg[] | undefined;

  const provider: Provider = {
    async generate({ messages }) {
      const step = decideStep(messages as unknown as GenericMsg[]);
      console.error(`[notify winter] -> step=${step}`);
      if (step === "notification-reply") notificationRequestMessages = structuredClone(messages) as unknown as GenericMsg[];
      switch (step) {
        case "spawn-call":
          return { kind: "tool_use", calls: [{ id: TOOL_USE_SPAWN, name: "Agent", input: { subagent_type: "general-purpose", description: SPAWN_DESCRIPTION, prompt: CHILD_PROMPT, run_in_background: true } }], usage: { inputTokens: 10, outputTokens: 12 } };
        case "spawn-ack-reply":
          return { kind: "text", text: PARENT_ACK_TEXT, usage: { inputTokens: 12, outputTokens: 6 } };
        case "child-final":
          return { kind: "text", text: CHILD_FINAL_TEXT, usage: { inputTokens: 6, outputTokens: 5 } };
        case "notification-reply":
          return { kind: "text", text: NOTIFICATION_REPLY_TEXT, usage: { inputTokens: 8, outputTokens: 5 } };
      }
    },
  };

  let resolveTurn1!: () => void;
  const turn1Done = new Promise<void>((r) => (resolveTurn1 = r));

  async function* prompts(): AsyncGenerator<string> {
    yield PARENT_PROMPT;
    await turn1Done;
    // Hold the input channel open (mirrors the official side's stdin staying open) for a bounded
    // grace period, giving Winter's engine a real chance to deliver an unsolicited turn on its own
    // before this generator ends and `query()` tears the session down.
    await new Promise((r) => setTimeout(r, WINTER_GRACE_MS));
  }

  const frames: RawFrame[] = [];
  let resultCount = 0;
  try {
    for await (const msg of query({
      prompt: prompts(),
      options: {
        model: "winter-test/unsolicited-notification",
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ["Bash", "Agent"],
        agents: { "general-purpose": { description: "general-purpose (fixture)", prompt: "" } },
        sandbox: { enabled: false },
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      frames.push(msg as unknown as RawFrame);
      if ((msg as RawFrame).type === "result") {
        resultCount++;
        if (resultCount === 1) resolveTurn1();
      }
    }
    return { frames, resultCount, notificationRequestMessages };
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// --- the differential test itself ------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(`unsolicited notification turn: Winter runtime vs pinned ${CLAUDE_VERSION} claude (2026-09-17-sdk-taskframes-parity, scenario 5)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

  test(
    "open-input host: turn-1 result is never held, a background completion starts a new turn on its own",
    async () => {
      console.error("\n=== running the OFFICIAL pinned binary (open stdin, one host turn, no second send) ===");
      const official = await runOfficial(binaryPath);
      console.error("\n=== running WINTER's in-process engine (streaming-input query(), bounded grace) ===");
      const winter = await runWinter();

      const officialSeq = official.frames.map((f) => (f.type === "system" ? `system:${f.subtype}` : f.type === "assistant" ? "assistant" : f.type === "result" ? "result" : String(f.type)));
      const winterSeq = winter.frames.map((f) => (f.type === "system" ? `system:${f.subtype}` : f.type === "assistant" ? "assistant" : f.type === "result" ? "result" : String(f.type)));
      console.log("\n--- SDK message sequence (types only) ---");
      console.log(`official (${officialSeq.length}): ${JSON.stringify(officialSeq)}`);
      console.log(`winter   (${winterSeq.length}): ${JSON.stringify(winterSeq)}`);

      const officialResultIndices = official.frames.map((f, i) => (f.type === "result" ? i : -1)).filter((i) => i >= 0);
      const winterResultIndices = winter.frames.map((f, i) => (f.type === "result" ? i : -1)).filter((i) => i >= 0);
      console.log(`\nresult frame indices: official=${JSON.stringify(officialResultIndices)} winter=${JSON.stringify(winterResultIndices)}`);

      const officialNotification = official.notificationRequestMessages && extractTaskNotification(official.notificationRequestMessages);
      const winterNotification = winter.notificationRequestMessages && extractTaskNotification(winter.notificationRequestMessages);
      console.log("\n--- <task-notification> extraction ---");
      console.log(`official: ${officialNotification === undefined ? "(no notification-reply request observed)" : JSON.stringify(officialNotification, null, 2)}`);
      console.log(`winter:   ${winterNotification === undefined ? "(no notification-reply request observed)" : JSON.stringify(winterNotification, null, 2)}`);

      const sides = [
        { label: "official", resultCount: official.resultCount, notification: officialNotification },
        { label: "winter", resultCount: winter.resultCount, notification: winterNotification },
      ];

      for (const side of sides) {
        // --- target 1 (R3a §1 "streaming-input hosts... never get a held result"): turn 1 produces
        // its OWN result promptly -- at least one result exists at all (a harness sanity check,
        // expected to pass on both sides).
        expect(side.resultCount >= 1, `${side.label}: turn 1 should produce its own result`).toBe(true);

        // --- target 2 (P16-3, this scenario's own point): a SECOND result arrives WITHOUT any new
        // host input -- the background completion starts an unsolicited turn on its own.
        expect(side.resultCount >= 2, `${side.label}: a background completion should start a second, UNSOLICITED turn (its own assistant + result) with no new host input`).toBe(true);

        // --- target 3 (R3a §1 XML tag shape): the unsolicited turn's own request carries a
        // `<task-notification>` block in its last user content, with the documented tag set.
        expect(side.notification, `${side.label}: the unsolicited turn's request should carry a <task-notification> block in its last user content`).toBeDefined();
        const tagNames = Object.keys(side.notification?.tags ?? {}).sort();
        for (const requiredTag of ["task-id", "tool-use-id", "status", "summary"]) {
          expect(tagNames, `${side.label}: <task-notification> should carry a <${requiredTag}> tag`).toContain(requiredTag);
        }
        expect(side.notification?.tags["tool-use-id"], `${side.label}: <tool-use-id> should name the backgrounded spawn's own tool_use id`).toBe(TOOL_USE_SPAWN);
        expect(side.notification?.tags.status, `${side.label}: <status> should read 'completed' for a clean child finish`).toBe("completed");
      }
    },
    120_000,
  );
});
