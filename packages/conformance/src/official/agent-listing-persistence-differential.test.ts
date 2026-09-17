// 2026-09-17 sdk-taskframes-parity, Lane D2, scenario 2 (plan-0.0.16.md ruling P16-8 / P16-6, R3a §3):
// AGENT LISTING PERSISTENCE. Drives the pinned `claude` 0.3.250 binary and Winter's own in-process
// engine through the SAME two-turn open-stdin conversation (no tool calls -- the listing itself is
// the thing under test, not spawning) and checks:
//
//   - the `Available agent types for the Agent tool:` block appears exactly once in request 1, as
//     its own meta content (never merged into the user's own prompt text);
//   - it does NOT reappear as a SECOND, freshly-appended block in request 2 -- it stays exactly
//     where it was, byte-identical, never duplicated;
//   - the per-type LINE FORMAT (`- <type>: <description> (Tools: <spec>)`);
//   - the listed TYPE SET -- Winter's built-ins (general-purpose, Explore, Plan, claude) against the
//     pin's own default headless set.
//
// Expected RED against Winter's current baseline: R3a "Winter today" documents that Winter
// recomputes the FULL listing on every request (no persistence, no fold-based delta) -- this file
// proves that against the real pinned binary. See differential-harness.ts's own header for the
// shared plumbing this reuses.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedClaudeBinary, makeOfficialRoots, cleanupRoots, minimalOfficialEnv, startCapturingLoopback, spawnOfficialStreamJson, sseTextTurn, sseResponse, OFFICIAL_MODEL, CLAUDE_VERSION, type RawFrame } from "./differential-harness.ts";
import { query } from "../../../sdk/src/index.ts";
import { inMemoryProcess } from "../../../runtime/src/testing.ts";
import type { Provider } from "../../../runtime/src/engine.ts";

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

const TURN1_TEXT = "turn one text";
const TURN2_TEXT = "turn two text";
const REPLY1 = "first reply";
const REPLY2 = "second reply";

const AGENT_LISTING_MARKER = "Available agent types for the Agent tool:";
const CONCURRENCY_NOTE = "When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently.";

interface GenericMsg {
  role?: unknown;
  content?: unknown;
}
interface GenericBlock {
  type?: unknown;
  text?: unknown;
}

function textsOf(content: unknown): string[] {
  if (Array.isArray(content)) return (content as GenericBlock[]).map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)));
  if (typeof content === "string") return [content];
  return [];
}

function allTexts(messages: GenericMsg[]): string[] {
  return messages.flatMap((m) => textsOf(m.content));
}

/** Every distinct text BLOCK (across every message) that carries the listing marker -- normally
 *  exactly one; more than one means the listing got duplicated/re-sent as new content. */
function findAgentListingBlocks(messages: GenericMsg[]): string[] {
  return allTexts(messages).filter((t) => t.includes(AGENT_LISTING_MARKER));
}

/** The index of the MESSAGE (not block) carrying the listing marker, or -1 if absent. A count check
 *  alone ("exactly one occurrence") cannot tell "persisted in place" from "moved": a layout that
 *  drops the listing from message 0 and re-adds it to the newest turn's message would still show
 *  count=1 and (with the right timing) byte-identical text, yet be exactly the bug this scenario
 *  exists to catch. Position is the check that actually discriminates the two. */
function findAgentListingMessageIndex(messages: GenericMsg[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (textsOf(messages[i]!.content).some((t) => t.includes(AGENT_LISTING_MARKER))) return i;
  }
  return -1;
}

interface ListingLine {
  type: string;
  description: string;
  toolsSpec: string;
}

/** Parses the `- <type>: <description> (Tools: <spec>)` lines out of a listing block -- the FORMAT
 *  claude authors, per R3a's `hrt` renderer; description text is expected to differ between the two
 *  runtimes (each authors its own copy) so it is captured but never compared for equality. */
function parseListingLines(blockText: string): ListingLine[] {
  const out: ListingLine[] = [];
  for (const line of blockText.split("\n")) {
    const m = /^- (\S+): (.*) \(Tools: (.*)\)$/.exec(line);
    if (m) out.push({ type: m[1]!, description: m[2]!, toolsSpec: m[3]! });
  }
  return out;
}

// --- the OFFICIAL side: one live stream-json session, two plain-text turns ------------------------

async function runOfficial(binaryPath: string): Promise<{ req1: RawFrame; req2: RawFrame }> {
  const roots = makeOfficialRoots("winter-listing-official-");
  const loop = startCapturingLoopback((_messages, _body, count) => sseResponse(sseTextTurn(count === 1 ? REPLY1 : REPLY2)), "listing official");
  try {
    const env = minimalOfficialEnv({ home: roots.home, cfg: roots.cfg, baseUrl: loop.url });
    const session = spawnOfficialStreamJson({
      binaryPath,
      env,
      cwd: roots.cwd,
      args: ["--model", OFFICIAL_MODEL, "--permission-mode", "bypassPermissions", "--setting-sources", ""],
    });
    session.send(TURN1_TEXT);
    await session.readUntil((f) => f.type === "result", 60_000);
    session.send(TURN2_TEXT);
    await session.readUntil((f) => f.type === "result", 60_000);
    session.close();
    const exitCode = await session.exited;
    console.error(`[listing official] exit=${exitCode}; ${loop.requests.length} loopback request(s)`);
    if (exitCode !== 0) throw new Error(`the pinned claude binary exited ${exitCode}\n${session.stderrTail()}`);
    if (loop.requests.length < 2) throw new Error(`expected at least 2 loopback requests, saw ${loop.requests.length}`);
    return { req1: loop.requests[0]!, req2: loop.requests[1]! };
  } finally {
    loop.stop();
    cleanupRoots(roots);
  }
}

// --- the WINTER side: query() with a streaming-input prompt, two plain-text turns ------------------

async function runWinter(): Promise<{ req1: RawFrame; req2: RawFrame }> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-listing-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-listing-cwd-"));
  const requests: RawFrame[] = [];
  let turnCount = 0;
  let resolveTurn1!: () => void;
  const turn1Done = new Promise<void>((r) => (resolveTurn1 = r));

  const provider: Provider = {
    async generate(req) {
      turnCount++;
      requests.push({ messages: structuredClone(req.messages) as unknown } as RawFrame);
      return { kind: "text", text: turnCount === 1 ? REPLY1 : REPLY2, usage: { inputTokens: 8, outputTokens: 6 } };
    },
  };

  async function* prompts(): AsyncGenerator<string> {
    yield TURN1_TEXT;
    await turn1Done;
    yield TURN2_TEXT;
  }

  try {
    let resultCount = 0;
    for await (const msg of query({
      prompt: prompts(),
      options: {
        model: "winter-test/agent-listing",
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      if ((msg as RawFrame).type === "result") {
        resultCount++;
        if (resultCount === 1) resolveTurn1();
      }
    }
    if (requests.length < 2) throw new Error(`expected 2 provider.generate() calls, saw ${requests.length}`);
    return { req1: requests[0]!, req2: requests[1]! };
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// --- the differential test itself ------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(`agent listing persistence: Winter runtime vs pinned ${CLAUDE_VERSION} claude (2026-09-17-sdk-taskframes-parity, scenario 2)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

  test(
    "listing appears once in request 1, is never re-sent as new content in request 2, same line format",
    async () => {
      console.error("\n=== running the OFFICIAL pinned binary (two live turns, one session) ===");
      const official = await runOfficial(binaryPath);
      console.error("\n=== running WINTER's in-process engine (two live turns, one query()) ===");
      const winter = await runWinter();

      const officialMessages1 = (official.req1.messages as GenericMsg[]) ?? [];
      const officialMessages2 = (official.req2.messages as GenericMsg[]) ?? [];
      const winterMessages1 = (winter.req1.messages as GenericMsg[]) ?? [];
      const winterMessages2 = (winter.req2.messages as GenericMsg[]) ?? [];

      const officialBlocks1 = findAgentListingBlocks(officialMessages1);
      const officialBlocks2 = findAgentListingBlocks(officialMessages2);
      const winterBlocks1 = findAgentListingBlocks(winterMessages1);
      const winterBlocks2 = findAgentListingBlocks(winterMessages2);

      const officialIndex1 = findAgentListingMessageIndex(officialMessages1);
      const officialIndex2 = findAgentListingMessageIndex(officialMessages2);
      const winterIndex1 = findAgentListingMessageIndex(winterMessages1);
      const winterIndex2 = findAgentListingMessageIndex(winterMessages2);

      const report = {
        official: {
          occurrencesInRequest1: officialBlocks1.length,
          occurrencesInRequest2: officialBlocks2.length,
          byteStableAcrossTurns: officialBlocks1[0] === officialBlocks2[0],
          messageIndexInRequest1: officialIndex1,
          messageIndexInRequest2: officialIndex2,
          isLastMessageInRequest2: officialIndex2 === officialMessages2.length - 1,
          lines: officialBlocks1[0] === undefined ? [] : parseListingLines(officialBlocks1[0]),
          hasConcurrencyNote: officialBlocks1[0]?.includes(CONCURRENCY_NOTE) ?? false,
        },
        winter: {
          occurrencesInRequest1: winterBlocks1.length,
          occurrencesInRequest2: winterBlocks2.length,
          byteStableAcrossTurns: winterBlocks1[0] === winterBlocks2[0],
          messageIndexInRequest1: winterIndex1,
          messageIndexInRequest2: winterIndex2,
          isLastMessageInRequest2: winterIndex2 === winterMessages2.length - 1,
          lines: winterBlocks1[0] === undefined ? [] : parseListingLines(winterBlocks1[0]),
          hasConcurrencyNote: winterBlocks1[0]?.includes(CONCURRENCY_NOTE) ?? false,
        },
      };
      console.log("\n--- STRUCTURE report ---");
      console.log(JSON.stringify(report, null, 2));

      console.log("\n--- TEXT (the listing block itself, request 1) -- printed for a human, never asserted ---");
      console.log(`official:\n${officialBlocks1[0] ?? "(absent)"}`);
      console.log(`winter:\n${winterBlocks1[0] ?? "(absent)"}`);

      const EXPECTED_WINTER_BUILTIN_TYPES = ["claude", "Explore", "general-purpose", "Plan"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const sides: Array<{ label: string; blocks1: string[]; blocks2: string[]; lines: ListingLine[]; index1: number; index2: number; total2: number }> = [
        { label: "official", blocks1: officialBlocks1, blocks2: officialBlocks2, lines: report.official.lines, index1: officialIndex1, index2: officialIndex2, total2: officialMessages2.length },
        { label: "winter", blocks1: winterBlocks1, blocks2: winterBlocks2, lines: report.winter.lines, index1: winterIndex1, index2: winterIndex2, total2: winterMessages2.length },
      ];

      for (const side of sides) {
        // --- target 1 (R3a §3): the listing is its OWN meta content, present exactly once in
        // request 1 -- never zero (missing), never more than one (already duplicated at turn 1).
        expect(side.blocks1.length, `${side.label}: request 1 should carry the agent listing exactly once`).toBe(1);

        // --- target 2 (R3a §3, this scenario's own point): NOT re-sent as new content in request 2
        // -- still exactly once total, and it is the SAME occurrence (byte-identical), not a second
        // fresh copy appended after the tool round / the new user turn.
        expect(side.blocks2.length, `${side.label}: request 2 should STILL carry the listing exactly once (never duplicated as new content)`).toBe(1);
        expect(side.blocks1[0], `${side.label}: the listing block must be byte-identical between request 1 and request 2 (it stays in place, unmodified)`).toBe(side.blocks2[0]);

        // --- target 2b (POSITION, not just count/bytes): a count-of-1 plus byte-identical text
        // cannot by itself distinguish "persisted in place" from "moved" -- a layout that drops the
        // listing from message 0 and re-adds an identical copy to the NEWEST turn would pass both
        // checks above while still being exactly the bug this scenario exists to catch. The
        // message INDEX holding the listing must be the same in both requests, and must never be
        // request 2's own last message (the new turn).
        expect(side.index2, `${side.label}: the listing's message index should be the SAME in request 2 as in request 1 (persisted in place, not moved)`).toBe(side.index1);
        expect(side.index2 === side.total2 - 1, `${side.label}: the listing must NOT be part of request 2's own last message (i.e. not attached to the new turn)`).toBe(false);

        // --- target 3: the concurrency-note trailer sentence is present (both runtimes' listings
        // carry it, per the captured ground truth).
        expect(side.blocks1[0]?.includes(CONCURRENCY_NOTE), `${side.label}: the listing should carry the concurrency-note trailer sentence`).toBe(true);

        // --- target 4 (line format): every one of Winter's built-in types renders as
        // `- <type>: <description> (Tools: <spec>)` -- format, not text, is what's compared (each
        // runtime authors its own description).
        const types = side.lines.map((l) => l.type).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
        for (const expectedType of EXPECTED_WINTER_BUILTIN_TYPES) {
          expect(types, `${side.label}: the listing should include Winter's built-in type '${expectedType}'`).toContain(expectedType);
        }
        for (const t of EXPECTED_WINTER_BUILTIN_TYPES) {
          const line = side.lines.find((l) => l.type === t);
          expect(line, `${side.label}: '${t}' should parse as '- ${t}: <description> (Tools: <spec>)'`).toBeDefined();
          expect(line!.description.length > 0, `${side.label}: '${t}' should carry a non-empty description`).toBe(true);
          expect(line!.toolsSpec.length > 0, `${side.label}: '${t}' should carry a non-empty Tools spec`).toBe(true);
        }
      }

      // Informational only (never asserted): the pin's own default headless set vs Winter's four
      // built-ins -- printed so a reader can see any EXTRA type the pin ships that Winter doesn't
      // (e.g. 'statusline-setup'), which is a scope difference, not one of this scenario's targets.
      const officialTypes = report.official.lines.map((l) => l.type).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const winterTypes = report.winter.lines.map((l) => l.type).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      console.log(`\npin's default headless type set:    ${JSON.stringify(officialTypes)}`);
      console.log(`Winter's built-in type set:          ${JSON.stringify(winterTypes)}`);
      console.log(`types the pin has that Winter lacks: ${JSON.stringify(officialTypes.filter((t) => !winterTypes.includes(t)))}`);
    },
    120_000,
  );
});
