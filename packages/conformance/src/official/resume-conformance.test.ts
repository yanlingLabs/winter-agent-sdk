// Phase 10b Lane S, S9: the decisive resume probe (P1-P6, design-memo.md), lifted into a real,
// repeatable conformance test rather than living only in a scratchpad script that does not survive
// the session.
//
// GATED, like every other test in this file family (`RUN_OFFICIAL_CAPTURE=1`): it fetches and
// installs the pinned 2.1.250 binary (checksum-verified, `fetch.ts`) into a CACHED prefix under the
// OS temp dir (keyed by version, so repeated runs across sessions reuse the install rather than
// re-fetching), then spawns it DIRECTLY (never through the JS wrapper -- `-p --resume` is the same
// public CLI surface a real Winter session would drive, and this is what actually proves the on-disk
// dialect entries the REAL writers (S1/S2: `assistantEntry`'s `message.id`, `claudeCompactBoundaryEntry`
// / `claudeCompactSummaryEntry`'s native compaction shape) resume correctly. `describe.skipIf` reports
// the reason plainly rather than silently omitting the suite.
//
// Every HOME/CLAUDE_CONFIG_DIR/cwd below is a fresh mkdtemp; the loopback fake never sees a real key
// (`ANTHROPIC_API_KEY=sk-ant-fake-...`) and the env passed to the child is an EXPLICIT, minimal
// object -- never `process.env` spread (Global Constraints' test-isolation rule).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hasBunRuntime } from "../bun-required.ts";
import { fetchAndVerifyUpstream } from "./fetch.ts";
import { userEntry, assistantEntry, claudeCompactBoundaryEntry, claudeCompactSummaryEntry, CLAUDE_COMPACT_SUMMARY_PREAMBLE, type SessionCtx, type Chain } from "winter-agent-runtime";

const CLAUDE_VERSION = "0.3.250";

/**
 * Resolves (fetching + installing on first use, into a CACHED prefix reused across runs) the pinned
 * claude binary. Returns `undefined` -- never throws -- for every reason it might be unavailable:
 * the gate is off, this isn't Bun, there is no network, or the platform has no darwin-arm64 native
 * binary. `describe.skipIf` reads the `undefined` case as "skip, and say why" via the returned reason.
 */
async function resolvePinnedClaudeBinary(): Promise<{ binaryPath: string } | { reason: string }> {
  if (process.env.RUN_OFFICIAL_CAPTURE !== "1") {
    return { reason: "RUN_OFFICIAL_CAPTURE is not set to \"1\" -- this suite never fetches the pinned binary or touches the network by default" };
  }
  if (!hasBunRuntime()) {
    return { reason: "this suite needs Bun.spawn/Bun.serve to drive the pinned binary" };
  }
  try {
    const cacheRoot = join(tmpdir(), "winter-conformance-cache", `claude-${CLAUDE_VERSION}`);
    mkdirSync(cacheRoot, { recursive: true });
    const { tarballPath } = await fetchAndVerifyUpstream({ cacheDir: join(cacheRoot, "tarball") });
    const npmPrefix = join(cacheRoot, "npm-prefix");
    mkdirSync(npmPrefix, { recursive: true });
    const binaryPath = join(npmPrefix, "node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude");
    if (!(await Bun.file(binaryPath).exists())) {
      const install = Bun.spawn(["npm", "install", "--no-save", "--ignore-scripts", "--prefix", npmPrefix, tarballPath], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(install.stdout).text()) + (await new Response(install.stderr).text());
      if ((await install.exited) !== 0) return { reason: `npm install into the cached prefix failed:\n${out.slice(0, 2000)}` };
    }
    if (!(await Bun.file(binaryPath).exists())) {
      return { reason: `installed the wrapper but found no darwin-arm64 binary at ${binaryPath} -- wrong platform, most likely` };
    }
    return { binaryPath };
  } catch (err) {
    return { reason: `could not fetch/install the pinned binary: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

// --- transcript construction, via the REAL dialect writers (S1/S2) -------------------------------

function buildChain(ctx: SessionCtx) {
  let parentUuid: string | null = null;
  const entries: unknown[] = [];
  return {
    entries,
    user(text: string) {
      const chain: Chain = { parentUuid };
      const e = userEntry({ text, chain, ctx });
      entries.push(e);
      parentUuid = e.uuid;
      return e;
    },
    assistant(text: string) {
      const chain: Chain = { parentUuid };
      const e = assistantEntry({ content: [{ type: "text", text }], chain, ctx });
      entries.push(e);
      parentUuid = e.uuid;
      return e;
    },
    toolRound(callId: string, name: string, input: unknown, resultText: string, closingText: string) {
      const chain: Chain = { parentUuid };
      const callEntry = assistantEntry({ content: [{ type: "tool_use", id: callId, name, input }], chain, ctx });
      entries.push(callEntry);
      parentUuid = callEntry.uuid;
      const resultEntry = userEntry({ content: [{ type: "tool_result", tool_use_id: callId, content: resultText }], chain: { parentUuid }, ctx });
      entries.push(resultEntry);
      parentUuid = resultEntry.uuid;
      const closingEntry = assistantEntry({ content: [{ type: "text", text: closingText }], chain: { parentUuid }, ctx });
      entries.push(closingEntry);
      parentUuid = closingEntry.uuid;
    },
    /** W18-12's own native shape, via the REAL S2 writers -- boundary first, then the summary parented on it. */
    compact(summaryText: string, preTokens: number) {
      const boundary = claudeCompactBoundaryEntry({ trigger: "manual", preTokens, logicalParentUuid: parentUuid!, ctx });
      entries.push(boundary);
      const summary = claudeCompactSummaryEntry({ summary: summaryText, boundaryUuid: boundary.uuid, ctx });
      entries.push(summary);
      parentUuid = summary.uuid;
    },
  };
}

// --- the loopback fake + spawn harness (the probe's own proven technique) ------------------------

interface CapturedRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
}

function startLoopback(reply: (req: CapturedRequest) => string): { baseUrl: string; requests: CapturedRequest[]; stop: () => void } {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      let body: { model?: string; messages?: unknown } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        /* non-JSON */
      }
      const messages = Array.isArray(body.messages) ? (body.messages as CapturedRequest["messages"]) : [];
      requests.push({ model: body.model ?? "", messages });
      const text = reply({ model: body.model ?? "", messages });
      return new Response(
        JSON.stringify({ id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: body.model ?? "claude-haiku-4-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  return { baseUrl: server.url.href.replace(/\/$/, ""), requests, stop: () => server.stop(true) };
}

async function spawnClaude(binaryPath: string, args: string[], env: Record<string, string>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const p = Bun.spawn([binaryPath, ...args], { stdout: "pipe", stderr: "pipe", env });
  const t = setTimeout(() => p.kill(), 60_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const exitCode = await p.exited;
  clearTimeout(t);
  return { exitCode, stdout, stderr };
}

interface Harness {
  binaryPath: string;
  home: string;
  cfg: string;
  cwd: string;
  baseUrl: string;
}

function makeHarness(binaryPath: string, baseUrl: string): Harness {
  const root = mkdtempSync(join(tmpdir(), "winter-resume-conformance-"));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  for (const dir of [home, cfg, cwd]) mkdirSync(dir, { recursive: true });
  return { binaryPath, home, cfg, cwd, baseUrl };
}

function envFor(h: Harness): Record<string, string> {
  return {
    HOME: h.home,
    USER: process.env.USER ?? "winter-conformance",
    LOGNAME: process.env.USER ?? "winter-conformance",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TMPDIR: join(h.home, "tmp") + "/",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CLAUDE_CONFIG_DIR: h.cfg,
    CLAUDE_CODE_PROJECT_DIR_NAME: "probekey",
    ANTHROPIC_BASE_URL: h.baseUrl,
    ANTHROPIC_API_KEY: "sk-ant-fake-resume-conformance-0000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
  };
}

function writeTranscript(h: Harness, sessionId: string, entries: unknown[]): void {
  const projectDir = join(h.cfg, "projects", "probekey");
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe.skipIf(skipReason !== undefined)(`resume conformance: Winter-written transcripts resume in the pinned ${CLAUDE_VERSION} binary (P1-P6, S9)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

  test("P1/P2: the request messages arrive in exact order with no merge", async () => {
    const sessionId = randomUUID();
    const ctx: SessionCtx = { sessionId, cwd: "/winter-fixture", version: "0.0.10" };
    const chain = buildChain(ctx);
    chain.user("Remember the code word ORCHID-47. Reply with just OK.");
    chain.assistant("OK.");
    chain.toolRound("call_conf_1", "Bash", { command: "ls", description: "list" }, "notes.txt", "There is one file: notes.txt.");

    const fake = startLoopback(() => "the code word is ORCHID-47");
    const h = makeHarness(binaryPath, fake.baseUrl);
    try {
      writeTranscript(h, sessionId, chain.entries);
      const { exitCode } = await spawnClaude(binaryPath, ["-p", "What is the code word?", "--model", "claude-haiku-4-5", "--resume", sessionId, "--max-turns", "1", "--output-format", "json"], envFor(h));
      expect(exitCode).toBe(0);
      expect(fake.requests.length).toBeGreaterThan(0);
      const last = fake.requests.at(-1)!;

      // Exact order, no merge: the five prior entries (user, assistant, tool_use, tool_result,
      // assistant) each arrive as their OWN message -- P2's own finding is that WITHOUT
      // `message.id` the two assistant turns merge across the tool_result into ONE message. The
      // stamped id (S1) is what keeps them separate here.
      const texts = last.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      const okIndex = texts.findIndex((t) => t.includes("\"text\":\"OK.\"") || t === "OK.");
      const toolUseIndex = texts.findIndex((t) => t.includes("call_conf_1") && t.includes("tool_use"));
      const toolResultIndex = texts.findIndex((t) => t.includes("call_conf_1") && t.includes("tool_result"));
      const closingIndex = texts.findIndex((t) => t.includes("notes.txt.") && !t.includes("tool_result"));
      expect(okIndex).toBeGreaterThanOrEqual(0);
      expect(toolUseIndex).toBeGreaterThan(okIndex);
      expect(toolResultIndex).toBeGreaterThan(toolUseIndex);
      expect(closingIndex).toBeGreaterThan(toolResultIndex);
      // The merge failure mode P2 found would fold the closing assistant text INTO the same
      // message as the tool_use call, immediately preceding the tool_result -- i.e. there would be
      // no SEPARATE assistant message after the tool_result at all. Asserting distinct, ordered
      // indices above already rules that out; this is the same fact stated the other way.
      expect(last.messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(2);
    } finally {
      fake.stop();
      rmSync(h.home, { recursive: true, force: true });
    }
  }, 90_000);

  test("P3/P4: after compaction, the request starts at the summary -- pre-compaction history is excluded", async () => {
    const sessionId = randomUUID();
    const ctx: SessionCtx = { sessionId, cwd: "/winter-fixture", version: "0.0.10" };
    const chain = buildChain(ctx);
    chain.user("Remember the code word BANANA-9. Reply with just OK.");
    chain.assistant("OK.");
    chain.compact("Summary: the user set the code word to ORCHID-47.", 1200);
    chain.user("Thanks, carry on.");
    chain.assistant("Sure.");

    const fake = startLoopback(() => "the code word is ORCHID-47, as recorded in the summary");
    const h = makeHarness(binaryPath, fake.baseUrl);
    try {
      writeTranscript(h, sessionId, chain.entries);
      const { exitCode } = await spawnClaude(binaryPath, ["-p", "What is the code word?", "--model", "claude-haiku-4-5", "--resume", sessionId, "--max-turns", "1", "--output-format", "json"], envFor(h));
      expect(exitCode).toBe(0);
      expect(fake.requests.length).toBeGreaterThan(0);
      const last = fake.requests.at(-1)!;
      const texts = last.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      const joined = texts.join("\n");

      // The summary (byte-exact preamble, S2) is present -- the request starts from it.
      expect(joined).toContain(CLAUDE_COMPACT_SUMMARY_PREAMBLE);
      expect(joined).toContain("ORCHID-47");
      // The pre-compaction turn is genuinely excluded (P3's own failure mode: a lost summary AND
      // leaked pre-compaction text) -- BANANA-9 must never reach the wire.
      expect(joined).not.toContain("BANANA-9");
    } finally {
      fake.stop();
      rmSync(h.home, { recursive: true, force: true });
    }
  }, 90_000);

  test("P5: --resume together with --session-id is refused", async () => {
    const sessionId = randomUUID();
    const otherSessionId = randomUUID();
    const ctx: SessionCtx = { sessionId, cwd: "/winter-fixture", version: "0.0.10" };
    const chain = buildChain(ctx);
    chain.user("hi");
    chain.assistant("hello");

    const fake = startLoopback(() => "should never be reached");
    const h = makeHarness(binaryPath, fake.baseUrl);
    try {
      writeTranscript(h, sessionId, chain.entries);
      const { exitCode, stderr, stdout } = await spawnClaude(
        binaryPath,
        ["-p", "hi again", "--model", "claude-haiku-4-5", "--resume", sessionId, "--session-id", otherSessionId, "--max-turns", "1", "--output-format", "json"],
        envFor(h),
      );
      expect(exitCode).not.toBe(0);
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain("--session-id");
      // Refused before ever reaching a real completions call -- the loopback's own non-completions
      // pings (e.g. a health-check HEAD) are captured too, so this checks specifically for a
      // MESSAGE-BEARING request, never a bare request count.
      expect(fake.requests.every((r) => r.messages.length === 0)).toBe(true);
    } finally {
      fake.stop();
      rmSync(h.home, { recursive: true, force: true });
    }
  }, 30_000);
});
