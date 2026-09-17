// 2026-09-17 sdk-taskframes-parity: the ACCEPTANCE PROOF for the task-frame parity contract --
// Winter must emit the same `system/task_*`/`background_tasks_changed` frames, with the same
// field shapes and wire spellings, that the pinned `claude` binary emits for Bash, Agent, Monitor
// and Workflow tasks (see task-frames-script.ts's own header for the exact scope).
//
// Drives the pinned `claude` 0.3.250 binary and Winter's own in-process engine through the SAME
// scripted conversation (packages/conformance/src/official/task-frames-script.ts owns the routing
// decision shared by both) and compares the `system/task_started|task_progress|task_updated|
// task_notification|background_tasks_changed` frames each emits, normalized so two independently
// minted id/uuid spaces are comparable. Expected to FAIL against today's `main` (Winter is missing
// most of these frames entirely -- see the task report) and to PASS once the sibling
// runtime-side branch lands.
//
// GATED, like every other file in this family (`RUN_OFFICIAL_CAPTURE=1`): fetches/installs the
// pinned binary into the shared cached prefix under the OS temp dir (fetch.ts, keyed by version, so
// repeated runs across sessions never re-download), then spawns it DIRECTLY -- never through the JS
// wrapper -- with a minimal explicit env (never a `process.env` spread), a loopback
// `ANTHROPIC_BASE_URL` fake, a fake `ANTHROPIC_API_KEY`, and fresh mkdtemp HOME/CLAUDE_CONFIG_DIR/cwd.
// `describe.skipIf` states the reason plainly when the gate is off.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBunRuntime } from "../bun-required.ts";
import { fetchAndVerifyUpstream } from "./fetch.ts";
import {
  TOOL_USE_BG,
  TOOL_USE_FG,
  TOOL_USE_AGENT,
  TOOL_USE_CHILD_ECHO,
  BG_COMMAND,
  FG_COMMAND,
  BG_DESCRIPTION,
  FG_DESCRIPTION,
  AGENT_DESCRIPTION,
  CHILD_PROMPT,
  SUBAGENT_TYPE,
  CHILD_ECHO_COMMAND,
  PARENT_FINAL_TEXT,
  CHILD_FINAL_TEXT,
  FALLBACK_TEXT,
  decideStep,
  normalizeAndProject,
  formatTextEntries,
  diffTextEntries,
  type GenericMessage,
  type GenericBlock,
  type RawFrame,
  type Step,
} from "./task-frames-script.ts";
// Same relative-import discipline as resume-conformance.test.ts's own `dialect.ts` import in this
// file family: `packages/conformance` has NO package.json dependencies at all (it publishes
// independently of both `@yanlinglabs/winter-agent-sdk` and the private `winter-agent-runtime`, and
// `packages/sdk` already devDepends on THIS package for its own tests -- a package.json dependency
// edge the other way would be a cycle). A relative path straight to each package's own source is the
// established door; this file is never built into conformance's own `dist/` (test files are excluded
// from the package build), so the relative import never reaches a published tarball either.
import { query } from "../../../sdk/src/index.ts";
import { inMemoryProcess } from "../../../runtime/src/testing.ts";
import type { Provider, ProviderMessage } from "../../../runtime/src/engine.ts";

const CLAUDE_VERSION = "0.3.250";
const OFFICIAL_MODEL = "claude-haiku-4-5";
// Any name in the reserved namespace resolves to the injected `Provider` regardless of the specific
// name (testing.ts's `testProviders: () => provider` ignores its argument) -- see selection.ts's own
// "(1) The reserved namespace" step. A descriptive name here is for a reader of a log line only.
const WINTER_TEST_MODEL = "winter-test/task-frames-differential";

/**
 * Resolves (fetching + installing on first use, into a CACHED prefix reused across runs) the pinned
 * claude binary. Returns `undefined` -- never throws -- for every reason it might be unavailable.
 * Copied from resume-conformance.test.ts's own identical resolver (same cache key, same shape) --
 * not factored into a shared helper because that file's own header explains why this whole family
 * keeps its gate logic local rather than adding a shared-module seam for an eleven-line function.
 */
async function resolvePinnedClaudeBinary(): Promise<{ binaryPath: string } | { reason: string }> {
  if (process.env.RUN_OFFICIAL_CAPTURE !== "1") {
    return { reason: 'RUN_OFFICIAL_CAPTURE is not set to "1" -- this suite never fetches the pinned binary or touches the network by default' };
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

// --- shared logging helpers (never print system/tools prose; structural facts only) --------------

function extractToolUseIds(messages: readonly GenericMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const raw of m.content as unknown[]) {
      const b = raw as GenericBlock & { id?: unknown };
      if (b?.type === "tool_use" && typeof b.id === "string") ids.push(b.id);
    }
  }
  return ids;
}

function extractToolResultIds(messages: readonly GenericMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const raw of m.content as unknown[]) {
      const b = raw as GenericBlock;
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") ids.push(b.tool_use_id);
    }
  }
  return ids;
}

// --- the OFFICIAL side: spawn the pinned binary directly, headless, stream-json ------------------

function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function officialToolUseTurn(id: string, name: string, input: unknown): Array<{ event: string; data: unknown }> {
  return [
    { event: "message_start", data: { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: OFFICIAL_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

function officialTextTurn(text: string): Array<{ event: string; data: unknown }> {
  return [
    { event: "message_start", data: { type: "message_start", message: { id: `msg_text_${crypto.randomUUID()}`, type: "message", role: "assistant", model: OFFICIAL_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

/**
 * Spawns the pinned binary headless (`-p ... --output-format stream-json --verbose`, permission
 * mode bypassed so Bash never prompts), answers every request from a loopback `Bun.serve` fake that
 * routes by content (`decideStep`, the SAME function the Winter driver below uses), and parses
 * stdout line by line into raw SDK messages. Every request the binary makes is logged to stderr,
 * including non-POST pings -- never the request's `system`/`tools` prose, only structural facts.
 */
interface OfficialRun {
  rawFrames: RawFrame[];
  /** The routing decision for every POST request, in order -- the harness's own solidity check
   *  (see the test body): a broken route here must fail LOUDLY and distinctly from a genuine
   *  Winter-side gap, never silently produce a short `official.structure` that misattributes the
   *  failure to Winter. */
  steps: Step[];
}

async function runOfficialScript(binaryPath: string): Promise<OfficialRun> {
  let requestCount = 0;
  const steps: Step[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      requestCount++;
      const url = new URL(req.url);
      if (req.method !== "POST") {
        console.error(`[official loopback] #${requestCount} ${req.method} ${url.pathname} (non-completions ping, benign ack)`);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      let body: { messages?: GenericMessage[] } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        /* non-JSON body -- falls through to the empty-messages default below */
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const step = decideStep(messages);
      steps.push(step);
      console.error(
        `[official loopback] #${requestCount} POST ${url.pathname} messages=${messages.length} roles=${messages.map((m) => String(m.role)).join(",")} ` +
          `toolResultIds=${JSON.stringify(extractToolResultIds(messages))} toolUseIds=${JSON.stringify(extractToolUseIds(messages))} -> step=${step}`,
      );
      switch (step) {
        case "bg-call":
          return sseResponse(officialToolUseTurn(TOOL_USE_BG, "Bash", { command: BG_COMMAND, run_in_background: true, description: BG_DESCRIPTION }));
        case "fg-call":
          return sseResponse(officialToolUseTurn(TOOL_USE_FG, "Bash", { command: FG_COMMAND, description: FG_DESCRIPTION }));
        case "agent-call":
          return sseResponse(
            officialToolUseTurn(TOOL_USE_AGENT, "Agent", { subagent_type: SUBAGENT_TYPE, description: AGENT_DESCRIPTION, prompt: CHILD_PROMPT, run_in_background: false }),
          );
        case "agent-final":
          return sseResponse(officialTextTurn(PARENT_FINAL_TEXT));
        case "child-echo":
          return sseResponse(officialToolUseTurn(TOOL_USE_CHILD_ECHO, "Bash", { command: CHILD_ECHO_COMMAND }));
        case "child-final":
          return sseResponse(officialTextTurn(CHILD_FINAL_TEXT));
        case "fallback":
          return sseResponse(officialTextTurn(FALLBACK_TEXT));
      }
    },
  });

  const root = mkdtempSync(join(tmpdir(), "winter-taskframes-official-"));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  for (const dir of [home, cfg, cwd]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });

  const env: Record<string, string> = {
    HOME: home,
    USER: process.env.USER ?? "winter-conformance",
    LOGNAME: process.env.USER ?? "winter-conformance",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TMPDIR: `${join(home, "tmp")}/`,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
    ANTHROPIC_API_KEY: "sk-ant-fake-taskframes-differential-0000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
  };

  try {
    const p = Bun.spawn(
      [
        binaryPath,
        "-p",
        "run the scripted task-frame conversation",
        "--model",
        OFFICIAL_MODEL,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "",
      ],
      { stdout: "pipe", stderr: "pipe", env, cwd },
    );
    const timer = setTimeout(() => p.kill(), 90_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const exitCode = await p.exited;
    clearTimeout(timer);
    console.error(`[official] exit=${exitCode}; ${requestCount} loopback request(s) total`);
    if (stderr.trim().length > 0) console.error(`[official stderr tail]\n${stderr.slice(-1500)}`);

    const rawFrames: RawFrame[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        rawFrames.push(JSON.parse(line) as RawFrame);
      } catch {
        /* a non-JSON stdout line would be a harness bug on this leg -- surfaced below via the exitCode/frame-count checks rather than swallowed silently */
      }
    }
    if (exitCode !== 0) {
      throw new Error(`the pinned claude binary exited ${exitCode} -- see the [official stderr tail] log above`);
    }
    return { rawFrames, steps };
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

// --- the WINTER side: the SAME script through the in-process scripted provider -------------------

/**
 * Drives Winter's own engine (`query()` + `inMemoryProcess`) through the identical script, via a
 * single pure-function `Provider` shared by the parent's conversation AND every spawned child's
 * (provider/mock.ts's own "subagent"/"subagentperm" cases use the same discipline, for the same
 * reason: one Provider instance serves both, so a queue-popping script would race a parent turn
 * against a child turn). Real tool executors run underneath it (Bash, Agent) -- nothing about task
 * registration/frames is mocked; only the model's own replies are scripted.
 */
async function runWinterScript(): Promise<RawFrame[]> {
  const winterHome = mkdtempSync(join(tmpdir(), "winter-taskframes-winterhome-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-taskframes-cwd-"));

  const provider: Provider = {
    async generate({ messages }) {
      const step = decideStep(messages as unknown as GenericMessage[]);
      console.error(`[winter provider] messages=${messages.length} roles=${(messages as ProviderMessage[]).map((m) => m.role).join(",")} -> step=${step}`);
      switch (step) {
        case "bg-call":
          return {
            kind: "tool_use",
            calls: [{ id: TOOL_USE_BG, name: "Bash", input: { command: BG_COMMAND, run_in_background: true, description: BG_DESCRIPTION } }],
            usage: { inputTokens: 8, outputTokens: 12 },
          };
        case "fg-call":
          return {
            kind: "tool_use",
            calls: [{ id: TOOL_USE_FG, name: "Bash", input: { command: FG_COMMAND, description: FG_DESCRIPTION } }],
            usage: { inputTokens: 10, outputTokens: 12 },
          };
        case "agent-call":
          return {
            kind: "tool_use",
            calls: [{ id: TOOL_USE_AGENT, name: "Agent", input: { subagent_type: SUBAGENT_TYPE, description: AGENT_DESCRIPTION, prompt: CHILD_PROMPT, run_in_background: false } }],
            usage: { inputTokens: 12, outputTokens: 14 },
          };
        case "agent-final":
          return { kind: "text", text: PARENT_FINAL_TEXT, usage: { inputTokens: 14, outputTokens: 6 } };
        case "child-echo":
          return {
            kind: "tool_use",
            calls: [{ id: TOOL_USE_CHILD_ECHO, name: "Bash", input: { command: CHILD_ECHO_COMMAND } }],
            usage: { inputTokens: 6, outputTokens: 10 },
          };
        case "child-final":
          return { kind: "text", text: CHILD_FINAL_TEXT, usage: { inputTokens: 8, outputTokens: 5 } };
        case "fallback":
          return { kind: "text", text: FALLBACK_TEXT, usage: { inputTokens: 4, outputTokens: 3 } };
      }
    },
  };

  try {
    const rawFrames: RawFrame[] = [];
    for await (const msg of query({
      prompt: "run the scripted task-frame conversation",
      options: {
        model: WINTER_TEST_MODEL,
        cwd,
        permissionMode: "bypassPermissions",
        // policy-state.ts's own bypass gate: `permissionMode: "bypassPermissions"` alone is refused
        // (WinterPermissionError "bypassPermissions requires allowDangerouslySkipPermissions: true"),
        // a Winter-side opt-in with no official-CLI-flag equivalent needed here -- the pinned binary
        // accepted `--permission-mode bypassPermissions` alone from a headless `-p` invocation with no
        // separate flag (verified: real Bash calls ran unprompted in every probe run).
        allowDangerouslySkipPermissions: true,
        allowedTools: ["Bash", "Agent"],
        sandbox: { enabled: false },
        // The official pin's "general-purpose" is a stock built-in subagent type needing no
        // configuration; Winter has no bundled default of that name (definitions.ts loads only from
        // the filesystem or this programmatic map), so the identical `subagent_type` in the script
        // needs a matching definition here. `prompt: ""` contributes nothing to the child's own
        // system prompt (child-engine.ts drops an empty definition.prompt), keeping the child's
        // conversation byte-for-byte the same shape as if no definition existed at all -- this
        // fixture's only job is making the NAME resolve, not shaping the child's behaviour.
        agents: { [SUBAGENT_TYPE]: { description: "general-purpose (fixture)", prompt: "" } },
        spawnClaudeCodeProcess: (opts) => inMemoryProcess(opts.args, provider, undefined, { ...opts.env, WINTER_HOME: winterHome }),
      },
    })) {
      rawFrames.push(msg as unknown as RawFrame);
    }
    return rawFrames;
  } finally {
    rmSync(winterHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// --- the differential test itself ------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(
  `task-frame parity: Winter runtime vs pinned ${CLAUDE_VERSION} claude (contract 2026-09-17-sdk-taskframes-parity)${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`,
  () => {
    const binaryPath = "binaryPath" in resolved ? resolved.binaryPath : "";

    test(
      "STRUCTURE parity: bg-bash (fails) -> fg-bash (crosses 2000ms) -> foreground Agent whose child calls Bash -> final text",
      async () => {
        console.error("\n=== running the OFFICIAL pinned binary ===");
        const officialRun = await runOfficialScript(binaryPath);
        // The official side is the ground truth this whole test is built on -- a broken route here
        // (e.g. a routing regression that silently falls through to "fallback" on turn 1) must fail
        // LOUDLY and distinctly from a genuine Winter-side gap, never quietly produce a short
        // `official.structure` that misattributes the failure to Winter (a short official sequence
        // and a short Winter sequence can otherwise "match" by both being wrong the same way).
        const expectedSteps: Step[] = ["bg-call", "fg-call", "agent-call", "child-echo", "child-final", "agent-final"];
        expect(
          officialRun.steps,
          `the official loopback took an unexpected route -- the harness itself is broken, not (necessarily) Winter:\n` +
            `expected: ${JSON.stringify(expectedSteps)}\nactual:   ${JSON.stringify(officialRun.steps)}`,
        ).toEqual(expectedSteps);

        console.error("\n=== running WINTER's in-process engine ===");
        const winterRaw = await runWinterScript();

        const official = normalizeAndProject(officialRun.rawFrames);
        const winter = normalizeAndProject(winterRaw);

        console.log("\n--- OFFICIAL normalized task-frame sequence (full, uuid/session_id dropped, task ids relabeled) ---");
        console.log(JSON.stringify(official.normalized, null, 2));
        console.log("\n--- WINTER normalized task-frame sequence (full, uuid/session_id dropped, task ids relabeled) ---");
        console.log(JSON.stringify(winter.normalized, null, 2));

        console.log("\n--- background_tasks_changed: distinct listed-set snapshots, in emission order ---");
        console.log(`official: ${JSON.stringify(official.bgSnapshots)}`);
        console.log(`winter:   ${JSON.stringify(winter.bgSnapshots)}`);

        console.log("\n--- TEXT (description/summary/prompt) -- printed for a human to read, never asserted ---");
        console.log(formatTextEntries("official", official.textEntries));
        console.log(formatTextEntries("winter", winter.textEntries));
        console.log("\n--- TEXT diff (official vs winter, keyed by task/subtype/field) ---");
        console.log(diffTextEntries(official.textEntries, winter.textEntries));

        console.log("\n--- STRUCTURE sequences (the assertion) ---");
        console.log(`official (${official.structure.length} frames): ${JSON.stringify(official.structure, null, 2)}`);
        console.log(`winter (${winter.structure.length} frames):   ${JSON.stringify(winter.structure, null, 2)}`);

        // Element-wise BEFORE the length check: a length mismatch alone ("Expected 9, Received 2")
        // is true but useless next to "index 0 is missing task_type/tool_use_id" -- checking the
        // overlapping prefix first means the FIRST failure line always names the first frame whose
        // CONTENT actually differs, falling back to a length-only message only when every
        // overlapping frame already matches (Winter emitted a strict, correct prefix and just
        // stopped early or ran on).
        const minLen = Math.min(official.structure.length, winter.structure.length);
        for (let i = 0; i < minLen; i++) {
          expect(
            winter.structure[i],
            `STRUCTURE differs at index ${i} (${official.structure[i]?.subtype}):\n` +
              `official: ${JSON.stringify(official.structure[i], null, 2)}\nwinter:   ${JSON.stringify(winter.structure[i], null, 2)}`,
          ).toEqual(official.structure[i]);
        }
        expect(
          winter.structure.length,
          `STRUCTURE frame count differs (every overlapping frame above matched): official has ${official.structure.length}, winter has ${winter.structure.length}.\n` +
            `official: ${JSON.stringify(official.structure, null, 2)}\nwinter:   ${JSON.stringify(winter.structure, null, 2)}`,
        ).toBe(official.structure.length);

        // Asserted SEPARATELY, per the contract's own "keep Winter's current emission positions;
        // do not reorder existing frames" -- background_tasks_changed's interleaving with the other
        // frames is unspecified, but the SET it lists at each of its own distinct emissions is not:
        // this is the one place §1/§7's "a foreground task is never listed" and §2's task_type
        // spellings on a listed entry are checked.
        expect(
          winter.bgSnapshots,
          `background_tasks_changed distinct snapshots differ:\nofficial: ${JSON.stringify(official.bgSnapshots)}\nwinter:   ${JSON.stringify(winter.bgSnapshots)}`,
        ).toEqual(official.bgSnapshots);
      },
      120_000,
    );
  },
);
