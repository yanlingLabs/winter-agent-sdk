// 2026-09-17 sdk-taskframes-parity, Lane D2, scenario 3 (plan-0.0.16.md ruling P16-8, R3b §4):
// Agent(type) DENY RULE. Drives the pinned `claude` 0.3.250 binary and Winter's own in-process
// engine, both with `Agent(Explore)` passed as a disallowed tool, through a single-spawn
// conversation where the model calls the Agent tool with `subagent_type: "Explore"`. Checks:
//
//   - Explore is ABSENT from the "Available agent types for the Agent tool:" listing;
//   - the spawn attempt comes back as a client-side REFUSAL -- a `tool_result` carrying
//     `is_error: true` and the pin's own denial text shape ("Agent type '<t>' has been denied by
//     permission rule 'Agent(<t>)' from <source>."), never a real spawn.
//
// Expected RED against Winter's current baseline: R3b §4 documents that nothing in
// permissions/evaluator.ts is Agent-specific today (grep for `findAgentDenyRule`/`Agent(` turns up
// nothing) -- `Agent(Explore)` parses as an ordinary, unrecognized deny-rule string with no effect,
// so Explore stays listed and the spawn actually runs. This file proves that against the real
// pinned binary. See differential-harness.ts's own header for the shared plumbing this reuses.
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

const PARENT_PROMPT_MARKER = "AGENT_DENY_SCENARIO_PARENT_PROMPT";
const PARENT_PROMPT = `${PARENT_PROMPT_MARKER}: use the Explore agent to look something up, then report back`;
const TOOL_USE_SPAWN = "toolu_explore_spawn1";
const SPAWN_DESCRIPTION = "explore probe";
const SPAWN_CHILD_PROMPT = "look something up";
const PARENT_FINAL_TEXT = "parent: done";
const CHILD_REPLY_TEXT = "child: nothing to report";

const AGENT_LISTING_MARKER = "Available agent types for the Agent tool:";

interface GenericMsg {
  role?: unknown;
  content?: unknown;
}
interface GenericBlock {
  type?: unknown;
  text?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

function blocksOf(content: unknown): GenericBlock[] {
  if (Array.isArray(content)) return content as GenericBlock[];
  return [];
}

function textsOf(content: unknown): string[] {
  const blocks = blocksOf(content);
  if (blocks.length > 0) return blocks.map((b) => (typeof b.text === "string" ? b.text : ""));
  if (typeof content === "string") return [content];
  return [];
}

function hasToolResultFor(messages: GenericMsg[], id: string): boolean {
  for (const m of messages) {
    for (const b of blocksOf(m.content)) {
      if (b.type === "tool_result" && b.tool_use_id === id) return true;
    }
  }
  return false;
}

function firstUserTextIncludes(messages: GenericMsg[], marker: string): boolean {
  const first = messages.find((m) => m.role === "user");
  if (!first) return false;
  return textsOf(first.content).some((t) => t.includes(marker));
}

type Step = "spawn-call" | "spawn-final" | "child-any";

/** Shared routing decision (mirrors task-frames-script.ts's own discipline): the CHILD's own
 *  conversation never carries `TOOL_USE_SPAWN`'s tool_result and never opens with the PARENT's own
 *  marker prompt, so it falls to `child-any` regardless of message count -- this matters here
 *  specifically because Winter's current baseline (no deny support) actually spawns a REAL child,
 *  whose first turn would otherwise be misrouted as a fresh `spawn-call` (an infinite spawn loop) by
 *  a naive `messages.length === 1` check. */
function decideStep(messages: GenericMsg[]): Step {
  if (hasToolResultFor(messages, TOOL_USE_SPAWN)) return "spawn-final";
  if (firstUserTextIncludes(messages, PARENT_PROMPT_MARKER)) return "spawn-call";
  return "child-any";
}

function findAgentListingBlock(messages: GenericMsg[]): string | undefined {
  for (const m of messages) {
    for (const t of textsOf(m.content)) {
      if (t.includes(AGENT_LISTING_MARKER)) return t;
    }
  }
  return undefined;
}

function listedTypes(blockText: string | undefined): string[] {
  if (blockText === undefined) return [];
  const out: string[] = [];
  for (const line of blockText.split("\n")) {
    const m = /^- (\S+):/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Finds the `tool_result` block for `id` anywhere across every message, regardless of role -- the
 *  official wire carries it on a `role:"user"` message, Winter's own ProviderMessage carries it on
 *  `role:"tool"`; both structurally agree on the block shape itself. */
function findToolResultBlock(messages: GenericMsg[], id: string): GenericBlock | undefined {
  for (const m of messages) {
    for (const b of blocksOf(m.content)) {
      if (b.type === "tool_result" && b.tool_use_id === id) return b;
    }
  }
  return undefined;
}

function toolResultText(block: GenericBlock | undefined): string {
  if (block === undefined) return "";
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c as GenericBlock[]).map((b) => (typeof b.text === "string" ? b.text : "")).join("\n");
  return "";
}

// `m` (multiline) so `^`/`$` match line boundaries, not the whole string -- the pin appends a
// trailing `total_tokens` reminder attachment after the denial paragraph (ground truth, captured
// 2026-09-17: "...from cliArg.\n\n<system-reminder>\n<total_tokens>N tokens left</total_tokens>...").
const DENIAL_TEXT_SHAPE = /^Agent type '.*' has been denied by permission rule 'Agent\(.*\)' from \S+\.$/m;

// --- the OFFICIAL side: one closed-input -p spawn, Agent(Explore) denied ----------------------------

async function runOfficial(binaryPath: string): Promise<{ req1: RawFrame; req2: RawFrame }> {
  const roots = makeOfficialRoots("winter-deny-official-");
  const loop = startCapturingLoopback((messages, _body, _count) => {
    const step = decideStep(messages as GenericMsg[]);
    console.error(`[deny official] -> step=${step}`);
    switch (step) {
      case "spawn-call":
        return sseResponse(sseToolUseTurn([{ id: TOOL_USE_SPAWN, name: "Agent", input: { subagent_type: "Explore", description: SPAWN_DESCRIPTION, prompt: SPAWN_CHILD_PROMPT, run_in_background: false } }]));
      case "spawn-final":
        return sseResponse(sseTextTurn(PARENT_FINAL_TEXT));
      case "child-any":
        return sseResponse(sseTextTurn(CHILD_REPLY_TEXT));
    }
  }, "deny official");
  try {
    const env = minimalOfficialEnv({ home: roots.home, cfg: roots.cfg, baseUrl: loop.url });
    const p = Bun.spawn(
      [binaryPath, "-p", PARENT_PROMPT, "--model", OFFICIAL_MODEL, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--setting-sources", "", "--disallowedTools", "Agent(Explore)"],
      { stdout: "pipe", stderr: "pipe", env, cwd: roots.cwd },
    );
    const timer = setTimeout(() => p.kill(), 60_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const exitCode = await p.exited;
    clearTimeout(timer);
    console.error(`[deny official] exit=${exitCode}; ${loop.requests.length} loopback request(s)`);
    if (stderr.trim().length > 0) console.error(`[deny official stderr tail]\n${stderr.slice(-1500)}`);
    if (exitCode !== 0) throw new Error(`the pinned claude binary exited ${exitCode} -- see stderr tail above`);
    if (loop.requests.length < 2) throw new Error(`expected at least 2 loopback requests, saw ${loop.requests.length}; stdout tail:\n${stdout.slice(-1000)}`);
    return { req1: loop.requests[0]!, req2: loop.requests[1]! };
  } finally {
    loop.stop();
    cleanupRoots(roots);
  }
}

// --- the WINTER side: one query() call, same disallowedTools, same script -------------------------

async function runWinter(): Promise<{ req1: RawFrame; req2: RawFrame }> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-deny-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-deny-cwd-"));
  const requests: RawFrame[] = [];

  const provider: Provider = {
    async generate({ messages }) {
      const step = decideStep(messages as unknown as GenericMsg[]);
      console.error(`[deny winter] -> step=${step}`);
      requests.push({ messages: structuredClone(messages) as unknown } as RawFrame);
      switch (step) {
        case "spawn-call":
          return { kind: "tool_use", calls: [{ id: TOOL_USE_SPAWN, name: "Agent", input: { subagent_type: "Explore", description: SPAWN_DESCRIPTION, prompt: SPAWN_CHILD_PROMPT, run_in_background: false } }], usage: { inputTokens: 10, outputTokens: 12 } };
        case "spawn-final":
          return { kind: "text", text: PARENT_FINAL_TEXT, usage: { inputTokens: 12, outputTokens: 5 } };
        case "child-any":
          return { kind: "text", text: CHILD_REPLY_TEXT, usage: { inputTokens: 6, outputTokens: 5 } };
      }
    },
  };

  try {
    for await (const _msg of query({
      prompt: PARENT_PROMPT,
      options: {
        model: "winter-test/agent-deny",
        cwd,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ["Bash", "Agent"],
        disallowedTools: ["Agent(Explore)"],
        sandbox: { enabled: false },
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      /* draining is enough -- the scripted provider records every request it sees */
    }
    // The FIRST captured request whose messages contain the parent's own marker prompt is the
    // parent's turn 1; the first captured request AFTER that carrying TOOL_USE_SPAWN's tool_result
    // is the parent's turn 2 -- filtered this way (rather than requests[0]/[1]) because, on today's
    // baseline where the spawn actually succeeds, the CHILD's own generate() calls interleave into
    // `requests` between the parent's two turns.
    const parentRequests = requests.filter((r) => {
      const messages = (r.messages as GenericMsg[]) ?? [];
      return firstUserTextIncludes(messages, PARENT_PROMPT_MARKER) || hasToolResultFor(messages, TOOL_USE_SPAWN);
    });
    if (parentRequests.length < 2) throw new Error(`expected at least 2 PARENT requests (spawn-call, spawn-final), saw ${parentRequests.length} of ${requests.length} total`);
    return { req1: parentRequests[0]!, req2: parentRequests[1]! };
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// --- the differential test itself ------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(`Agent(type) deny rule: Winter runtime vs pinned ${CLAUDE_VERSION} claude (2026-09-17-sdk-taskframes-parity, scenario 3)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

  test(
    "Agent(Explore) denied: filtered from the listing, spawn refused with is_error + the pin's denial text shape",
    async () => {
      console.error("\n=== running the OFFICIAL pinned binary (Agent(Explore) disallowed) ===");
      const official = await runOfficial(binaryPath);
      console.error("\n=== running WINTER's in-process engine (Agent(Explore) disallowed) ===");
      const winter = await runWinter();

      const officialMessages1 = (official.req1.messages as GenericMsg[]) ?? [];
      const officialMessages2 = (official.req2.messages as GenericMsg[]) ?? [];
      const winterMessages1 = (winter.req1.messages as GenericMsg[]) ?? [];
      const winterMessages2 = (winter.req2.messages as GenericMsg[]) ?? [];

      const officialListing = findAgentListingBlock(officialMessages1);
      const winterListing = findAgentListingBlock(winterMessages1);
      const officialResult = findToolResultBlock(officialMessages2, TOOL_USE_SPAWN);
      const winterResult = findToolResultBlock(winterMessages2, TOOL_USE_SPAWN);

      const report = {
        official: {
          listedTypes: listedTypes(officialListing),
          resultIsError: officialResult?.is_error,
          resultText: toolResultText(officialResult),
        },
        winter: {
          listedTypes: listedTypes(winterListing),
          resultIsError: winterResult?.is_error,
          resultText: toolResultText(winterResult),
        },
      };
      console.log("\n--- STRUCTURE report ---");
      console.log(JSON.stringify(report, null, 2));
      console.log("\n--- TEXT (the Agent(Explore) tool_result) -- printed for a human, never asserted ---");
      console.log(`official: ${JSON.stringify(report.official.resultText)}`);
      console.log(`winter:   ${JSON.stringify(report.winter.resultText)}`);

      const sides = [
        { label: "official", listing: report.official.listedTypes, result: officialResult, resultText: report.official.resultText },
        { label: "winter", listing: report.winter.listedTypes, result: winterResult, resultText: report.winter.resultText },
      ];

      for (const side of sides) {
        // --- target 1 (R3b §4 "Deny... removes the type from the listing"): Explore absent.
        expect(side.listing, `${side.label}: Explore should be absent from the Agent listing when Agent(Explore) is disallowed`).not.toContain("Explore");

        // --- target 2: the spawn attempt is refused client-side, never a real spawn -- a
        // `tool_result` carrying `is_error: true`.
        expect(side.result, `${side.label}: the Agent(Explore) spawn should produce SOME tool_result (denied or not) in the next request`).toBeDefined();
        expect(side.result?.is_error, `${side.label}: the Agent(Explore) spawn's tool_result should carry is_error: true (a refusal, never a real spawn)`).toBe(true);

        // --- target 3: the pin's own denial text shape -- "Agent type '<t>' has been denied by
        // permission rule 'Agent(<t>)' from <source>." (R3b §4).
        expect(DENIAL_TEXT_SHAPE.test(side.resultText), `${side.label}: the denial text should match "Agent type '<t>' has been denied by permission rule 'Agent(<t>)' from <source>." -- got ${JSON.stringify(side.resultText)}`).toBe(true);
      }
    },
    120_000,
  );
});
