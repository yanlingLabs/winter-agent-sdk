// 2026-09-17 sdk-taskframes-parity, Lane D2, scenario 4 (plan-0.0.16.md ruling P16-8 / P16-7, R3a §2):
// FORK REQUEST BYTES. Official spawned with `CLAUDE_CODE_FORK_SUBAGENT=1`, Winter with
// `forkSubagent: true`; the parent batches TWO `subagent_type: "fork"` calls in ONE assistant
// message. Captures each fork child's own first request and compares it against the parent's own
// last request: `tools` (names/order/schemas), the main system-prompt text, the inherited
// userContext message, and the fork-specific tail (the assistant-message clone + a placeholder
// `tool_result` + the directive text block).
//
// Ground truth captured against the real pinned binary (spike, 2026-09-17) -- this REFINES R3a §2's
// own "(1) a CLONE of that in-flight assistant message M (new uuid, ALL BLOCKS KEPT)" claim: when the
// parent batches two fork calls in one assistant message, EACH fork's own clone keeps ONLY ITS OWN
// tool_use block (the sibling's is dropped), not both -- so "identical requests up to the directive
// text" holds at the fork-BOILERPLATE text (byte-identical prefix, captured verbatim below), never at
// the tool_use/tool_result block (which necessarily differs: different id/input per fork). `system`
// differs only in the billing-header block's byte length (transport metadata, not prompt content);
// the real system-prompt body and the inherited userContext message (cache_control aside) are
// byte-identical to the parent's own last request.
//
// Expected RED against Winter's current baseline: R3a §2 "Winter today" documents no boilerplate, no
// "Your directive:", the fork's OWN placeholder prompt sent as the system prompt (not the parent's
// rendered one), and re-rendered (not exact) tool specs -- this file proves each of those against the
// real pinned binary. See differential-harness.ts's own header for shared plumbing.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedClaudeBinary, makeOfficialRoots, cleanupRoots, minimalOfficialEnv, startCapturingLoopback, sseTextTurn, sseToolUseTurn, sseResponse, OFFICIAL_MODEL, CLAUDE_VERSION, type RawFrame } from "./differential-harness.ts";
import { query } from "../../../sdk/src/index.ts";
import { inMemoryProcess } from "../../../runtime/src/testing.ts";
import type { Provider } from "../../../runtime/src/engine.ts";

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

const PARENT_PROMPT = "spawn two forks to investigate in parallel, then report";
const TOOL_USE_A = "toolu_forkA1";
const TOOL_USE_B = "toolu_forkB2";
const FORK_A_MARKER = "FORK_A_DIRECTIVE_MARKER";
const FORK_B_MARKER = "FORK_B_DIRECTIVE_MARKER";
const FORK_A_DIRECTIVE = `${FORK_A_MARKER}: investigate the first half`;
const FORK_B_DIRECTIVE = `${FORK_B_MARKER}: investigate the second half`;
const FORK_A_REPLY = "forkA: done reporting";
const FORK_B_REPLY = "forkB: done reporting";
const PARENT_ACK_TEXT = "parent: kicked off both forks";
const PARENT_NOTIFICATION_REPLY = "parent: a fork finished";

/** Same bound as scenario 5, same reason: Winter's forked children may need real wall-clock time to
 *  run and be captured before the session tears down; there is no completion signal to wait on from
 *  the outside, so this is a fixed grace window after the parent's own first result. */
const WINTER_GRACE_MS = 5_000;

interface GenericMsg {
  role?: unknown;
  content?: unknown;
}
interface GenericBlock {
  type?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  cache_control?: unknown;
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

type Step = "parent-spawn-call" | "parent-ack-reply" | "parent-notification-reply" | "fork-a-reply" | "fork-b-reply";

/** ONLY text blocks / plain-string content -- NEVER `textsOf`'s `JSON.stringify` fallback over a
 *  `tool_result` block. Winter's own spawn-ack `tool_result` echoes the child's prompt inside its
 *  JSON content (the same shape scenario 3 observed: `"prompt":"..."`), so scanning every block
 *  indiscriminately misroutes the PARENT's own ack round (whose last message holds two
 *  tool_results) as a fork child's reply the instant either directive marker appears inside that
 *  JSON -- caught empirically: `decideStep` was routing the ack round to `fork-a-reply`. */
function directiveMarkerTextsOf(content: unknown): string[] {
  const blocks = blocksOf(content);
  if (blocks.length > 0) return blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  if (typeof content === "string") return [content];
  return [];
}

/** LAST-message routing throughout (never first-message) -- a fork child inherits the PARENT's own
 *  first message verbatim (R3a §2), so a first-message check would misroute every fork turn as a
 *  fresh parent turn. */
function decideStep(messages: GenericMsg[]): Step {
  const last = messages.at(-1);
  const lastMarkerTexts = directiveMarkerTextsOf(last?.content);
  if (lastMarkerTexts.some((t) => t.includes(FORK_A_MARKER))) return "fork-a-reply";
  if (lastMarkerTexts.some((t) => t.includes(FORK_B_MARKER))) return "fork-b-reply";
  if (lastUserText(messages).includes("<task-notification>")) return "parent-notification-reply";
  if (hasToolResultFor(messages, TOOL_USE_A) || hasToolResultFor(messages, TOOL_USE_B)) return "parent-ack-reply";
  return "parent-spawn-call";
}

/** Drops `cache_control` before comparing -- the one field legitimately allowed to move (R4/scenario
 *  1's own "prefix stable modulo cache_control" precedent). */
function stripCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (k, v) => (k === "cache_control" ? undefined : v))) as T;
}

/** The real system-prompt BODY, excluding the billing-header/identity metadata blocks -- official's
 *  `system` is an array where the bulk of the actual prompt is the longest block (ground truth: a
 *  ~28KB block vs a 74-byte billing header and a 62-byte identity line); Winter's `system` is a
 *  single string today, so it IS the whole thing. */
function mainSystemPromptText(system: unknown): string {
  if (Array.isArray(system)) {
    const blocks = system as Array<{ text?: unknown }>;
    let longest = "";
    for (const b of blocks) if (typeof b.text === "string" && b.text.length > longest.length) longest = b.text;
    return longest;
  }
  return typeof system === "string" ? system : "";
}

interface ToolSpec {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  input_schema?: unknown;
}
function toolNamesOrdered(tools: unknown): string[] {
  return Array.isArray(tools) ? (tools as ToolSpec[]).map((t) => String(t.name)) : [];
}
function toolSchemaOf(t: ToolSpec): unknown {
  return t.inputSchema ?? t.input_schema;
}

interface CapturedRequest {
  system: unknown;
  tools: unknown;
  messages: GenericMsg[];
}

interface FullCapture {
  parentSpawnCall: CapturedRequest | undefined;
  forkA: CapturedRequest | undefined;
  forkB: CapturedRequest | undefined;
}

// --- the OFFICIAL side: closed-input -p, full stdout collected, requests routed by content ---------

async function runOfficial(binaryPath: string): Promise<FullCapture> {
  const roots = makeOfficialRoots("winter-fork-official-");
  const captured: FullCapture = { parentSpawnCall: undefined, forkA: undefined, forkB: undefined };
  const loop = startCapturingLoopback((messages, body, count) => {
    const step = decideStep(messages as GenericMsg[]);
    console.error(`[fork official] #${count} messages=${messages.length} -> step=${step}`);
    const req: CapturedRequest = { system: body.system, tools: body.tools, messages: messages as GenericMsg[] };
    if (step === "parent-spawn-call") captured.parentSpawnCall = req;
    if (step === "fork-a-reply" && captured.forkA === undefined) captured.forkA = req;
    if (step === "fork-b-reply" && captured.forkB === undefined) captured.forkB = req;
    switch (step) {
      case "parent-spawn-call":
        return sseResponse(
          sseToolUseTurn([
            { id: TOOL_USE_A, name: "Agent", input: { subagent_type: "fork", description: "fork A", prompt: FORK_A_DIRECTIVE } },
            { id: TOOL_USE_B, name: "Agent", input: { subagent_type: "fork", description: "fork B", prompt: FORK_B_DIRECTIVE } },
          ]),
        );
      case "fork-a-reply":
        return sseResponse(sseTextTurn(FORK_A_REPLY));
      case "fork-b-reply":
        return sseResponse(sseTextTurn(FORK_B_REPLY));
      case "parent-ack-reply":
        return sseResponse(sseTextTurn(PARENT_ACK_TEXT));
      case "parent-notification-reply":
        return sseResponse(sseTextTurn(PARENT_NOTIFICATION_REPLY));
    }
  }, "fork official");
  try {
    const env = minimalOfficialEnv({ home: roots.home, cfg: roots.cfg, baseUrl: loop.url, extra: { CLAUDE_CODE_FORK_SUBAGENT: "1" } });
    const p = Bun.spawn(
      [binaryPath, "-p", PARENT_PROMPT, "--model", OFFICIAL_MODEL, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--setting-sources", ""],
      { stdout: "pipe", stderr: "pipe", env, cwd: roots.cwd },
    );
    const timer = setTimeout(() => p.kill(), 90_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const exitCode = await p.exited;
    clearTimeout(timer);
    console.error(`[fork official] exit=${exitCode}; ${loop.requests.length} loopback request(s)`);
    if (stderr.trim().length > 0) console.error(`[fork official stderr tail]\n${stderr.slice(-1500)}`);
    if (exitCode !== 0) throw new Error(`the pinned claude binary exited ${exitCode} -- see stderr tail above; stdout tail:\n${stdout.slice(-1000)}`);
    return captured;
  } finally {
    loop.stop();
    cleanupRoots(roots);
  }
}

// --- the WINTER side: streaming-input query(), forkSubagent: true, bounded grace period -----------

async function runWinter(): Promise<FullCapture> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-fork-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-fork-cwd-"));
  const captured: FullCapture = { parentSpawnCall: undefined, forkA: undefined, forkB: undefined };

  let resolveTurn1!: () => void;
  const turn1Done = new Promise<void>((r) => (resolveTurn1 = r));

  const provider: Provider = {
    async generate({ messages, system, tools }) {
      const step = decideStep(messages as unknown as GenericMsg[]);
      console.error(`[fork winter] -> step=${step}`);
      const req: CapturedRequest = { system, tools, messages: structuredClone(messages) as unknown as GenericMsg[] };
      if (step === "parent-spawn-call") captured.parentSpawnCall = req;
      if (step === "fork-a-reply" && captured.forkA === undefined) captured.forkA = req;
      if (step === "fork-b-reply" && captured.forkB === undefined) captured.forkB = req;
      switch (step) {
        case "parent-spawn-call":
          return {
            kind: "tool_use",
            calls: [
              { id: TOOL_USE_A, name: "Agent", input: { subagent_type: "fork", description: "fork A", prompt: FORK_A_DIRECTIVE } },
              { id: TOOL_USE_B, name: "Agent", input: { subagent_type: "fork", description: "fork B", prompt: FORK_B_DIRECTIVE } },
            ],
            usage: { inputTokens: 14, outputTokens: 20 },
          };
        case "fork-a-reply":
          return { kind: "text", text: FORK_A_REPLY, usage: { inputTokens: 8, outputTokens: 5 } };
        case "fork-b-reply":
          return { kind: "text", text: FORK_B_REPLY, usage: { inputTokens: 8, outputTokens: 5 } };
        case "parent-ack-reply":
          return { kind: "text", text: PARENT_ACK_TEXT, usage: { inputTokens: 10, outputTokens: 6 } };
        case "parent-notification-reply":
          return { kind: "text", text: PARENT_NOTIFICATION_REPLY, usage: { inputTokens: 10, outputTokens: 6 } };
      }
    },
  };

  async function* prompts(): AsyncGenerator<string> {
    yield PARENT_PROMPT;
    await turn1Done;
    await new Promise((r) => setTimeout(r, WINTER_GRACE_MS));
  }

  try {
    let resultCount = 0;
    for await (const msg of query({
      prompt: prompts(),
      options: {
        model: "winter-test/fork-request-bytes",
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ["Bash", "Agent"],
        forkSubagent: true,
        sandbox: { enabled: false },
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      if ((msg as RawFrame).type === "result") {
        resultCount++;
        if (resultCount === 1) resolveTurn1();
      }
    }
    return captured;
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// --- the differential test itself ------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(`fork request bytes: Winter runtime vs pinned ${CLAUDE_VERSION} claude (2026-09-17-sdk-taskframes-parity, scenario 4)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

  test(
    "fork child's first request: parent's tools/system/userContext, plus the placeholder tool_result + directive tail",
    async () => {
      console.error("\n=== running the OFFICIAL pinned binary (CLAUDE_CODE_FORK_SUBAGENT=1, closed input) ===");
      const official = await runOfficial(binaryPath);
      console.error("\n=== running WINTER's in-process engine (forkSubagent: true, bounded grace) ===");
      const winter = await runWinter();

      function report(label: string, c: FullCapture) {
        const parent = c.parentSpawnCall;
        const a = c.forkA;
        const b = c.forkB;
        return {
          haveAll: parent !== undefined && a !== undefined && b !== undefined,
          toolNamesMatchA: a === undefined || parent === undefined ? undefined : JSON.stringify(toolNamesOrdered(a.tools)) === JSON.stringify(toolNamesOrdered(parent.tools)),
          systemMatchA: a === undefined || parent === undefined ? undefined : mainSystemPromptText(a.system) === mainSystemPromptText(parent.system),
          messages0MatchA: a === undefined || parent === undefined ? undefined : JSON.stringify(stripCache(a.messages[0])) === JSON.stringify(stripCache(parent.messages[0])),
          childMessageCount: a?.messages.length,
          parentMessageCount: parent?.messages.length,
        };
      }
      console.log("\n--- STRUCTURE report ---");
      console.log(`official: ${JSON.stringify(report("official", official), null, 2)}`);
      console.log(`winter:   ${JSON.stringify(report("winter", winter), null, 2)}`);

      console.log("\n--- TEXT (fork A's directive tail block) -- printed for a human, never asserted ---");
      const officialTail = official.forkA?.messages.at(-1);
      const winterTail = winter.forkA?.messages.at(-1);
      console.log(`official: ${officialTail === undefined ? "(absent)" : JSON.stringify(officialTail, null, 2)}`);
      console.log(`winter:   ${winterTail === undefined ? "(absent)" : JSON.stringify(winterTail, null, 2)}`);

      const sides: Array<{ label: string; c: FullCapture }> = [
        { label: "official", c: official },
        { label: "winter", c: winter },
      ];

      for (const { label, c } of sides) {
        const parent = c.parentSpawnCall;
        const forkA = c.forkA;
        const forkB = c.forkB;

        // --- sanity: all three requests were actually observed (a harness/bounding check -- on
        // Winter this can ALSO fail simply because the fork never ran within the grace window,
        // which is itself part of the documented gap, not a harness bug).
        expect(parent, `${label}: the parent's own spawn-call request should have been captured`).toBeDefined();
        expect(forkA, `${label}: fork A's own first request should have been captured (spawned, and ran within the grace window)`).toBeDefined();
        expect(forkB, `${label}: fork B's own first request should have been captured (spawned, and ran within the grace window)`).toBeDefined();
        if (parent === undefined || forkA === undefined || forkB === undefined) continue;

        // --- target 1 (R3a §2 "exact tool pool"): fork A's tools match the parent's own, names AND
        // order AND schemas.
        expect(toolNamesOrdered(forkA.tools), `${label}: fork A's tool NAMES/ORDER should equal the parent's own`).toEqual(toolNamesOrdered(parent.tools));
        expect(JSON.stringify((forkA.tools as ToolSpec[]).map(toolSchemaOf)), `${label}: fork A's tool SCHEMAS should equal the parent's own, in order`).toBe(JSON.stringify((parent.tools as ToolSpec[]).map(toolSchemaOf)));

        // --- target 2 (R3a §2 "the parent's LAST RENDERED system prompt verbatim"): the real
        // system-prompt BODY (billing-header/identity metadata aside) is byte-identical.
        expect(mainSystemPromptText(forkA.system), `${label}: fork A's system-prompt body should equal the parent's own last rendered system prompt`).toBe(mainSystemPromptText(parent.system));

        // --- target 3 (R3a §2 "parent's user context"): the inherited index-0 userContext message
        // is byte-identical (cache_control aside).
        expect(JSON.stringify(stripCache(forkA.messages[0])), `${label}: fork A's index-0 message should equal the parent's own (cache_control aside)`).toBe(JSON.stringify(stripCache(parent.messages[0])));

        // --- target 4 (R3a §2 history shape, REFINED by ground truth): child.messages =
        // parent.messages (length N) + [assistant clone carrying ONLY this fork's own tool_use] +
        // [tool_result(placeholder) + directive text, in ONE user message] = N + 2.
        expect(forkA.messages.length, `${label}: fork A's history should be the parent's own (${parent.messages.length}) + 2 (the assistant clone + the tool_result/directive message)`).toBe(parent.messages.length + 2);

        const cloneMsg = forkA.messages[parent.messages.length];
        const cloneBlocks = blocksOf(cloneMsg?.content);
        expect(cloneMsg?.role, `${label}: the message right after the parent's history should be the assistant clone`).toBe("assistant");
        expect(cloneBlocks.length, `${label}: the assistant clone should carry exactly ONE tool_use block (this fork's own -- the sibling's is dropped, per ground truth)`).toBe(1);
        expect(cloneBlocks[0]?.type, `${label}: the clone's one block should be a tool_use`).toBe("tool_use");
        expect(cloneBlocks[0]?.id, `${label}: the clone's tool_use id should be fork A's own`).toBe(TOOL_USE_A);

        const tailMsg = forkA.messages[parent.messages.length + 1];
        const tailBlocks = blocksOf(tailMsg?.content);
        const placeholderBlock = tailBlocks.find((b) => b.type === "tool_result");
        const directiveBlock = tailBlocks.find((b) => b.type === "text");
        expect(placeholderBlock?.tool_use_id, `${label}: the placeholder tool_result should answer fork A's own tool_use id`).toBe(TOOL_USE_A);

        // --- target 5 (R3a §2 "Fork started — processing in background"): the SAME constant
        // placeholder text on both sides (fork.ts's own FORK_PLACEHOLDER_TOOL_RESULT already matches
        // this byte-for-byte -- a point of EXISTING parity, not a gap).
        const placeholderText = typeof placeholderBlock?.content === "string" ? placeholderBlock.content : textsOf(placeholderBlock?.content)[0];
        expect(placeholderText, `${label}: the placeholder tool_result text`).toBe("Fork started — processing in background");

        // --- target 6 (R3a §2 "Your directive: <prompt>" + fork boilerplate): the directive text
        // block ends with the fork's own directive, and the boilerplate PREFIX before it is
        // byte-identical between sibling forks A and B (the cache-sharing design point).
        const directiveText = typeof directiveBlock?.text === "string" ? directiveBlock.text : "";
        expect(directiveText.endsWith(`Your directive: ${FORK_A_DIRECTIVE}`), `${label}: the directive text block should end with 'Your directive: <the fork's own prompt>'`).toBe(true);

        if (forkB !== undefined) {
          const bTailMsg = forkB.messages[parent.messages.length + 1];
          const bDirectiveBlock = blocksOf(bTailMsg?.content).find((b) => b.type === "text");
          const bDirectiveText = typeof bDirectiveBlock?.text === "string" ? bDirectiveBlock.text : "";
          const markerIndex = directiveText.indexOf("Your directive:");
          const bMarkerIndex = bDirectiveText.indexOf("Your directive:");
          expect(markerIndex >= 0 && bMarkerIndex >= 0, `${label}: both sibling forks' directive blocks should carry a 'Your directive:' marker`).toBe(true);
          if (markerIndex >= 0 && bMarkerIndex >= 0) {
            expect(directiveText.slice(0, markerIndex), `${label}: sibling forks A and B should share a byte-identical boilerplate PREFIX up to 'Your directive:'`).toBe(bDirectiveText.slice(0, bMarkerIndex));
          }
        }
      }
    },
    150_000,
  );
});
