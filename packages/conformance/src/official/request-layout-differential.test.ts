// 2026-09-17 sdk-taskframes-parity, Lane D2, scenario 1 (plan-0.0.16.md ruling P16-8 / P16-5, R4):
// REQUEST LAYOUT. Drives the pinned `claude` 0.3.250 binary and Winter's own in-process engine
// through the SAME two-turn conversation (a live, open-stdin session on both sides -- no tool
// calls, plain text replies) and compares the first and second model requests' STRUCTURE:
//
//   - is the per-session context (claude's `userContext`/`mbt` format) its OWN block/message at
//     index 0, distinct from the user's own prompt text, or string-concatenated into it;
//   - the `# <key>` set that block carries;
//   - the system prompt's block count and cache-scope markers;
//   - whether request 2's messages start with EXACTLY request 1's messages (the "index-0 stable
//     across turns" / prompt-cache-prefix claim) -- checked independently on each side, since the
//     two sides' actual text never matches (this is a STRUCTURE comparison, never a text one).
//
// Expected RED against Winter's current baseline (v0.0.15): R3a/R4 document that Winter recomputes
// the injected context every request and string-concatenates it onto the LAST user message rather
// than a stable index-0 block -- this file's own job is to PROVE that against the real pinned
// binary and give Lane C's fix a test that flips green once it lands `ProviderMessage.meta`/index-0.
//
// GATED (`RUN_OFFICIAL_CAPTURE=1`) like every file in this family. See differential-harness.ts's own
// header for the shared plumbing (binary resolution, mkdtemp roots, the capturing loopback, the
// open-stdin stream-json driver) and task-frames-script.ts's header for why routing stays local to
// each scenario rather than living in the shared module.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePinnedClaudeBinary, makeOfficialRoots, cleanupRoots, minimalOfficialEnv, startCapturingLoopback, spawnOfficialStreamJson, sseTextTurn, sseResponse, OFFICIAL_MODEL, CLAUDE_VERSION, type RawFrame } from "./differential-harness.ts";
// Same relative-import discipline as task-frames-differential.test.ts's own header explains:
// packages/conformance has no package.json dependency on the runtime/sdk packages (would be a
// cycle -- packages/sdk already devDepends on THIS package for its own tests), so this reaches
// straight into each sibling package's source. Never built into conformance's own dist/.
import { query } from "../../../sdk/src/index.ts";
import { inMemoryProcess } from "../../../runtime/src/testing.ts";
import type { Provider } from "../../../runtime/src/engine.ts";

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

const TURN1_TEXT = "turn one text";
const TURN2_TEXT = "turn two text";
const REPLY1 = "first reply";
const REPLY2 = "second reply";

// The literal preamble claude's own userContext wrapper (`mbt`) opens with -- see R4 §A. Used to
// FIND the userContext block among index-0's other content blocks (agent listing, skill listing,
// total_tokens...), never to assert its exact bytes (this is a structure test).
const USER_CONTEXT_PREAMBLE = "As you answer the user's questions, you can use the following context:";

// --- generic message/system description, shared across both wire shapes --------------------------
//
// Both sides structurally agree at the fields this reads: `{role, content}[]` where `content` is
// either a plain string or an array of blocks each carrying `.text` (official: Anthropic wire JSON;
// Winter: ProviderMessage[]/ContentBlock[]). One describer function for both, so nothing here can
// accidentally hand-roll two divergent notions of "the message's flattened text."

interface GenericMsg {
  role?: unknown;
  content?: unknown;
}
interface GenericBlock {
  type?: unknown;
  text?: unknown;
  cache_control?: unknown;
}

function blocksOf(content: unknown): GenericBlock[] | undefined {
  return Array.isArray(content) ? (content as GenericBlock[]) : undefined;
}

/** The message's content flattened to a list of text strings: one entry per block for an array, or
 *  the single string itself for a plain string. Used for the cross-turn stability comparison. */
function textsOf(content: unknown): string[] {
  const blocks = blocksOf(content);
  if (blocks) return blocks.map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b)));
  if (typeof content === "string") return [content];
  return [];
}

/** Strips `cache_control` before comparing two messages -- the ONE field claude's own request 2
 *  legitimately moves (the cache boundary follows the newest user text), never a content change. */
function stableView(m: GenericMsg | undefined): { role: unknown; texts: string[] } {
  return { role: m?.role, texts: textsOf(m?.content) };
}

interface Index0Report {
  role: unknown;
  isArray: boolean;
  blockCount: number;
  lastBlockText: string;
  fullTextJoined: string;
  userContextBlockText: string | undefined;
  userContextKeys: string[];
}

function describeIndex0(m: GenericMsg | undefined): Index0Report {
  const content = m?.content;
  const blocks = blocksOf(content);
  const texts = textsOf(content);
  const userContextBlockText = texts.find((t) => t.includes(USER_CONTEXT_PREAMBLE));
  const userContextKeys = userContextBlockText === undefined ? [] : [...userContextBlockText.matchAll(/^# (\w+)$/gm)].map((mm) => mm[1]!);
  return {
    role: m?.role,
    isArray: blocks !== undefined,
    blockCount: blocks?.length ?? (typeof content === "string" ? 1 : 0),
    lastBlockText: texts.at(-1) ?? "",
    fullTextJoined: texts.join("\n\n---BLOCK---\n\n"),
    userContextBlockText,
    userContextKeys,
  };
}

interface SystemReport {
  blockCount: number;
  cacheControlCount: number;
  totalLength: number;
}

function describeSystem(system: unknown): SystemReport {
  if (Array.isArray(system)) {
    const blocks = system as Array<{ text?: unknown; cache_control?: unknown }>;
    return {
      blockCount: blocks.length,
      cacheControlCount: blocks.filter((b) => b.cache_control !== undefined).length,
      totalLength: blocks.reduce((n, b) => n + (typeof b.text === "string" ? b.text.length : 0), 0),
    };
  }
  if (typeof system === "string") return { blockCount: system.length > 0 ? 1 : 0, cacheControlCount: 0, totalLength: system.length };
  return { blockCount: 0, cacheControlCount: 0, totalLength: 0 };
}

// --- the OFFICIAL side: one live stream-json session, two turns -----------------------------------

async function runOfficial(binaryPath: string): Promise<{ req1: RawFrame; req2: RawFrame }> {
  const roots = makeOfficialRoots("winter-reqlayout-official-");
  const loop = startCapturingLoopback((_messages, _body, count) => sseResponse(sseTextTurn(count === 1 ? REPLY1 : REPLY2)), "reqlayout official");
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
    console.error(`[reqlayout official] exit=${exitCode}; ${loop.requests.length} loopback request(s)`);
    if (exitCode !== 0) throw new Error(`the pinned claude binary exited ${exitCode}\n${session.stderrTail()}`);
    if (loop.requests.length < 2) throw new Error(`expected at least 2 loopback requests, saw ${loop.requests.length} -- the harness itself is broken`);
    return { req1: loop.requests[0]!, req2: loop.requests[1]! };
  } finally {
    loop.stop();
    cleanupRoots(roots);
  }
}

// --- the WINTER side: query() with a streaming-input (AsyncIterable) prompt, two turns ------------

async function runWinter(): Promise<{ req1: RawFrame; req2: RawFrame }> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-reqlayout-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-reqlayout-cwd-"));
  const requests: RawFrame[] = [];
  let turnCount = 0;
  let resolveTurn1!: () => void;
  const turn1Done = new Promise<void>((r) => (resolveTurn1 = r));

  const provider: Provider = {
    async generate(req) {
      turnCount++;
      requests.push({ system: req.system, messages: structuredClone(req.messages) as unknown, model: req.model } as RawFrame);
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
        model: "winter-test/request-layout",
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

describe.skipIf(skipReason !== undefined)(`request layout: Winter runtime vs pinned ${CLAUDE_VERSION} claude (2026-09-17-sdk-taskframes-parity, scenario 1)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

  test(
    "index-0 meta message, system block/cache shape, and turn-1->turn-2 prefix stability",
    async () => {
      console.error("\n=== running the OFFICIAL pinned binary (two live turns, one session) ===");
      const official = await runOfficial(binaryPath);

      console.error("\n=== running WINTER's in-process engine (two live turns, one query()) ===");
      const winter = await runWinter();

      const officialMessages1 = (official.req1.messages as GenericMsg[]) ?? [];
      const officialMessages2 = (official.req2.messages as GenericMsg[]) ?? [];
      const winterMessages1 = (winter.req1.messages as GenericMsg[]) ?? [];
      const winterMessages2 = (winter.req2.messages as GenericMsg[]) ?? [];

      const report = {
        official: {
          system1: describeSystem(official.req1.system),
          system2: describeSystem(official.req2.system),
          messageCount1: officialMessages1.length,
          messageCount2: officialMessages2.length,
          index0Turn1: describeIndex0(officialMessages1[0]),
          index0Turn2: describeIndex0(officialMessages2[0]),
        },
        winter: {
          system1: describeSystem(winter.req1.system),
          system2: describeSystem(winter.req2.system),
          messageCount1: winterMessages1.length,
          messageCount2: winterMessages2.length,
          index0Turn1: describeIndex0(winterMessages1[0]),
          index0Turn2: describeIndex0(winterMessages2[0]),
        },
      };
      console.log("\n--- STRUCTURE report (full) ---");
      console.log(JSON.stringify(report, null, 2));

      console.log("\n--- TEXT (index-0 full content, both turns) -- printed for a human, never asserted ---");
      console.log(`official turn1 index0:\n${report.official.index0Turn1.fullTextJoined}`);
      console.log(`official turn2 index0:\n${report.official.index0Turn2.fullTextJoined}`);
      console.log(`winter turn1 index0:\n${report.winter.index0Turn1.fullTextJoined}`);
      console.log(`winter turn2 index0:\n${report.winter.index0Turn2.fullTextJoined}`);

      // --- basic turn-taking sanity (expected to PASS on both sides -- a divergence here means the
      // harness itself is broken, not a request-layout gap) -----------------------------------------
      expect(officialMessages1.length, "official request 1 should be a single (fresh) turn").toBe(1);
      expect(winterMessages1.length, "winter request 1 should be a single (fresh) turn").toBe(1);
      expect(officialMessages2.length, "official request 2 = request 1 + assistant reply + new user turn").toBe(officialMessages1.length + 2);
      expect(winterMessages2.length, "winter request 2 = request 1 + assistant reply + new user turn").toBe(winterMessages1.length + 2);

      // Every check below states the SAME target contract for BOTH runtimes (never "winter is
      // expected to fail this specific way" -- that would just re-encode the bug as the spec and
      // stay green forever). Winter is expected to FAIL some of these against today's v0.0.15
      // baseline; that is this test's whole point, and it is meant to flip to PASS, unmodified, once
      // Lane C lands the index-0 meta message. `officialFirst`/`winterOnly` name which struct each
      // failure message reads from, so a RED run still points at the right side.
      const sides: Array<{ label: string; index0Turn1: Index0Report; messages1: GenericMsg[]; messages2: GenericMsg[] }> = [
        { label: "official", index0Turn1: report.official.index0Turn1, messages1: officialMessages1, messages2: officialMessages2 },
        { label: "winter", index0Turn1: report.winter.index0Turn1, messages1: winterMessages1, messages2: winterMessages2 },
      ];

      for (const side of sides) {
        // --- target 1 (R4 "mbt"): index 0 carries the per-session context as its OWN block,
        // distinct from the user's own prompt text -- never string-concatenated into it.
        expect(side.index0Turn1.isArray, `${side.label}: index-0 content should be an array of blocks, not a bare string (R4 'mbt' format)`).toBe(true);

        // --- target 2: the real user prompt text is recoverable at the END of index-0's flattened
        // text -- true whether the prompt lives in its own trailing block or (today, on Winter) is
        // merely the tail of a concatenated string.
        expect(side.index0Turn1.fullTextJoined.endsWith(TURN1_TEXT), `${side.label}: the real prompt text should be the tail of index-0's flattened content`).toBe(true);

        // --- target 3 (R4 userContext keys): a claude.md-style block wrapped with the "As you
        // answer the user's questions..." preamble, carrying a `# <key>` set -- currentDate is the
        // only key guaranteed present with no CLAUDE.md/OAuth email/claude.ai project configured.
        expect(side.index0Turn1.userContextBlockText, `${side.label}: index-0 should carry a userContext block (the 'As you answer...' preamble)`).toBeDefined();
        expect(side.index0Turn1.userContextKeys, `${side.label}: userContext key set for a config-free session`).toEqual(["currentDate"]);

        // --- target 4 (R4 "index-0 stable across turns" / P16-5 memoization): index-0 on turn 2 is
        // BYTE-IDENTICAL (modulo cache_control) to index-0 on turn 1 -- memoized per session, never
        // recomputed from whatever message happens to be last.
        const stable = JSON.stringify(stableView(side.messages1[0])) === JSON.stringify(stableView(side.messages2[0]));
        expect(stable, `${side.label}: index-0's text (cache_control aside) must be identical across turn 1 and turn 2`).toBe(true);

        // --- target 5 (P16-5 / R4 "prefix of request 2 equals request 1"): request 2's messages,
        // truncated to request 1's own length, equal request 1's messages (cache_control aside) --
        // the new turn is a pure suffix, nothing earlier moved or was rewritten.
        const prefixStable = JSON.stringify(side.messages2.slice(0, side.messages1.length).map(stableView)) === JSON.stringify(side.messages1.map(stableView));
        expect(prefixStable, `${side.label}: request 2's messages[0..N) must equal request 1's messages exactly (cache_control aside)`).toBe(true);
      }
    },
    120_000,
  );
});
