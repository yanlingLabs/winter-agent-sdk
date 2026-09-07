// P7a Lane C (WS-02 §9 Step 2): moved here verbatim from `scripts/capture-official-golden.ts`, which
// is now a thin caller: it imports `runCapture` below and keeps only the RUN_OFFICIAL_CAPTURE=1 gate
// and the `bun run scripts/capture-official-golden.ts` CLI entry point, both byte-for-byte unchanged
// by the move. Living inside `@yanlinglabs/winter-conformance` (re-exported from `./index.ts`) makes
// the capture harness an IMPORTABLE function for any consumer of the pinned-upstream mechanics, not
// only a script invoked by path.
//
// GATED — never runs in ordinary CI (needs the ~200MB darwin-arm64/linux-x64 native optional
// package and network egress). Behind RUN_OFFICIAL_CAPTURE=1 only.
//
// Procedure (WS-17 §4, report §5 probe): checksum-verify + ephemerally install
// @anthropic-ai/claude-agent-sdk@0.3.250 into a throwaway npm prefix ONCE, then run its own real
// query() against TWO SEPARATE loopback HTTP servers (one per scenario, each returning canned
// Anthropic-shaped Messages API responses tailored to that scenario), capture the yielded SDK
// message stream, normalizeTrace() it, and PRINT the result for each — never write a golden file,
// never auto-compare against a winter golden, never auto-commit anything. A human (the controller)
// diffs the printed output by eye. This is a differential SIGNAL, not a pass/fail gate.
//
// Scenario A (plain query): unchanged from the original capture — a single canned text reply.
// Scenario B (Task 13, permissions+hooks): a canUseTool callback, includeHookEvents:true, one
// observer-only PreToolUse hook, and a SessionEnd hook — driving the SAME single-shot query() shape
// T10 proved is structurally unable to observe SessionEnd's own hook body/lifecycle frames on
// Winter's side, so this scenario doubles as the official-runtime comparison T10's own WS-17
// capture-note asked for (does the OFFICIAL SDK invoke a SessionEnd hook / emit lifecycle frames in
// single-shot mode?). The canUseTool callback's received field set is captured and printed
// separately for controller eyeballing, exactly as this task's brief specifies.
// Scenario C (Task 8, WS-06 §6 obligation 1): the OFFICIAL runtime's own DEFAULT `system/init.tools`
// advertised list — zero permission/hook/tool config, same shape as Scenario A's own minimal
// options, so the ONLY variable is which branch produced the list. Printed alone (its own labeled
// block, in addition to the full normalized trace every scenario already prints) specifically so a
// controller can diff it directly against Winter's own default-config buildAdvertisedSet output
// (packages/runtime/src/tools/registry.test.ts / conformance.test.ts) without hunting through the
// rest of the trace for it. Report-only, exactly like A and B — never auto-compared, never a pass/
// fail gate, never written as a pinned golden (WS-06 §6 obligation 1 itself only requires a
// Winter-side snapshot fixture per configuration, which conformance.test.ts already supplies; this
// scenario is the separate, explicitly-named "capture the OFFICIAL list for a human to eyeball
// against it" signal task-8-brief.md asks for).
//
// Hermeticity (hard rule, non-negotiable): the official runtime must never read or write the real
// ~/.claude (or ~/.winter/~/.norma). Achieved by handing it the MINIMAL env an empirical probe
// proved sufficient — exactly {ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, HOME} with
// NO process.env spread — plus settingSources: [] (reads no real settings.json at any level) and a
// fresh mkdtemp cwd. Every request either scenario's loopback receives is logged to stderr below as
// direct evidence that the loopback is the only endpoint it ever contacts.
//
// Item 13 (P2 fix-wave) hardening: `HOME` is now ALSO explicitly set, to its own fresh mkdtemp dir,
// for BOTH scenarios — closing a gap Task 13's own review found (pre-existing, read-only, no PII,
// but real): `env` REPLACES the child/imported module's environment entirely (this repo's own
// established convention — see query.ts's identical semantics for Options.env), so a `HOME`-less
// env leaves `os.homedir()` free to fall back to its own OS-level user-database lookup (POSIX
// getpwuid), which resolves to the REAL ambient user's actual home directory regardless of
// CLAUDE_CONFIG_DIR — any internal path the official runtime derives directly from `os.homedir()`
// (a plugin/marketplace cache under `~/.claude`, observed by Task 13's reviewer, is exactly this
// shape) is invisible to CLAUDE_CONFIG_DIR's own scoping and needs this second, independent knob.
// `CLAUDE_CONFIG_DIR` itself was ALREADY a fresh mkdtemp for both scenarios before this fix — see
// each scenario's own `claudeConfigDir` local below; this hardening is additive, not a correction of
// that half. Every one of a scenario's own working files (the Scenario B dummy read target
// included) lives under fresh mkdtemp dirs — never a real path, never real user data — and every
// acquired resource is cleaned up in a `finally`, mirroring the T11 review's own
// resource-exhaustion-safety fix (acquire-then-register-cleanup, never a batch of acquisitions
// ahead of one shared try).
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchAndVerifyUpstream } from "./fetch.ts";
import { normalizeTrace, type ConformanceTraceEntry } from "../trace.ts";

type OfficialQueryFn = (args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<{ type: string; subtype?: string }>;
type OfficialSdk = { query: OfficialQueryFn };

const CANNED_TEXT_RESPONSE = {
  id: "msg_capture_canned_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "echo: hi" }], // mirrors winter's own echoProvider convention —
  // maximizes how directly the printed output lines up against the winter plain-query golden.
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

// Scenario B's own two canned responses — a tool_use turn, then (once the loopback observes a
// tool_result in the conversation) a closing text turn. Standard PUBLIC Anthropic Messages API wire
// shapes (the same family CANNED_TEXT_RESPONSE above already uses) — not an Anthropic SDK-internal
// declaration, so this is not the "verbatim upstream artifact" the phase's hermeticity rule forbids.
function cannedToolUseResponse(readTargetPath: string): unknown {
  return {
    id: "msg_capture_canned_tooluse_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5-20250929",
    content: [{ type: "tool_use", id: "toolu_capture_01", name: "Read", input: { file_path: readTargetPath } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
const CANNED_TEXT_AFTER_TOOL_RESPONSE = {
  id: "msg_capture_canned_02",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [{ type: "text", text: "capture: tool round complete" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 6 },
};

// True once ANY message in the request body's `messages` array carries a `tool_result` content
// block — i.e. the wrapper has already sent the tool's result back, so the NEXT model turn should
// be the closing text reply rather than another tool_use. Defensive: any parse failure (a request
// shape this probe didn't anticipate — e.g. a non-completions endpoint) reports "no tool_result
// seen", which routes to the tool_use response — the same conservative default the original
// single-response capture already relied on for every non-completions request it received.
function requestAlreadySawToolResult(body: unknown): boolean {
  try {
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
      const content = (m as { content?: unknown }).content;
      if (Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_result")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function installOfficialSdk(cleanups: Array<() => void>): Promise<OfficialSdk> {
  // Checksum-verified ephemeral install (same contract as compile-official-fixture.ts: sha256 + the
  // Task-11 sha512 integrity pin, both re-verified here, never trusted from an earlier step).
  const { tarballPath, ownedDir } = await fetchAndVerifyUpstream();
  if (ownedDir) cleanups.push(() => rmSync(dirname(tarballPath), { recursive: true, force: true }));
  const npmPrefix = mkdtempSync(join(tmpdir(), "winter-official-capture-"));
  cleanups.push(() => rmSync(npmPrefix, { recursive: true, force: true }));

  const install = Bun.spawn(
    ["npm", "install", "--no-save", "--ignore-scripts", "--prefix", npmPrefix, tarballPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const installOut = (await new Response(install.stdout).text()) + (await new Response(install.stderr).text());
  if ((await install.exited) !== 0) {
    throw new Error(`npm install --prefix ${npmPrefix} failed:\n${installOut}`);
  }

  const officialPkgDir = join(npmPrefix, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  const officialPkgJson = JSON.parse(readFileSync(join(officialPkgDir, "package.json"), "utf8")) as { main?: string };
  if (!officialPkgJson.main) throw new Error('installed @anthropic-ai/claude-agent-sdk package.json has no "main" field');
  const entryPath = join(officialPkgDir, officialPkgJson.main);
  return (await import(entryPath)) as OfficialSdk;
}

// --- Scenario A: plain query (unchanged from the original capture) -----------------------------

async function runPlainQueryCapture(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-official-capture-config-"));
    cleanups.push(() => rmSync(claudeConfigDir, { recursive: true, force: true }));
    // Item 13 (P2 fix-wave): a SEPARATE fresh mkdtemp from claudeConfigDir -- see this file's own
    // header for why HOME needs to be independently isolated (os.homedir()'s own OS-level fallback
    // is invisible to CLAUDE_CONFIG_DIR's scoping).
    const homeDir = mkdtempSync(join(tmpdir(), "winter-official-capture-home-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const fixtureCwd = mkdtempSync(join(tmpdir(), "winter-official-capture-cwd-"));
    cleanups.push(() => rmSync(fixtureCwd, { recursive: true, force: true }));

    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        console.error(`[loopback A] #${requestCount} ${req.method} ${url.pathname}${url.search} host=${req.headers.get("host")}`);
        return new Response(JSON.stringify(CANNED_TEXT_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    console.error(`\n=== Scenario A: plain query ===`);
    console.error(`[capture A] loopback listening on ${server.url.href} (the ONLY endpoint the official runtime is given)`);
    console.error(`[capture A] CLAUDE_CONFIG_DIR=${claudeConfigDir} HOME=${homeDir} (both fresh mkdtemp — never the real ~/.claude or the real user home)`);

    const entries: ConformanceTraceEntry[] = [];
    let thrown: unknown;
    try {
      const q = officialSdk.query({
        prompt: "hi",
        options: {
          model: "sonnet",
          cwd: fixtureCwd,
          settingSources: [],
          env: {
            ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
            ANTHROPIC_API_KEY: "test",
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            HOME: homeDir,
          },
        },
      });
      for await (const msg of q) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: msg.type === "system" ? `system/${msg.subtype}` : msg.type, payload: msg });
      }
    } catch (e) {
      thrown = e;
    }

    console.error(`[capture A] official runtime made ${requestCount} request(s) to the loopback; ${entries.length} message(s) yielded`);
    if (thrown) console.error(`[capture A] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    console.log(`\n--- Scenario A normalized trace ---`);
    console.log(JSON.stringify(normalizeTrace(entries), null, 2));
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario C (Task 8, WS-06 §6 obligation 1): the official runtime's own default init.tools ---

async function runInitToolsCapture(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-official-capture-config-c-"));
    cleanups.push(() => rmSync(claudeConfigDir, { recursive: true, force: true }));
    // Item 13 (P2 fix-wave): see runPlainQueryCapture's own identical `homeDir` comment.
    const homeDir = mkdtempSync(join(tmpdir(), "winter-official-capture-home-c-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const fixtureCwd = mkdtempSync(join(tmpdir(), "winter-official-capture-cwd-c-"));
    cleanups.push(() => rmSync(fixtureCwd, { recursive: true, force: true }));

    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        console.error(`[loopback C] #${requestCount} ${req.method} ${url.pathname}${url.search} host=${req.headers.get("host")}`);
        // A single canned text turn is enough -- this scenario only needs the FIRST frame the
        // official runtime ever emits (init); the query() call is drained to completion anyway (a
        // hung/unread stream would leave the loopback server and the official runtime's own request
        // dangling), but nothing past the init frame is this scenario's own point.
        return new Response(JSON.stringify(CANNED_TEXT_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    console.error(`\n=== Scenario C: official default system/init.tools ===`);
    console.error(`[capture C] loopback listening on ${server.url.href} (the ONLY endpoint the official runtime is given)`);
    console.error(`[capture C] CLAUDE_CONFIG_DIR=${claudeConfigDir} HOME=${homeDir} (both fresh mkdtemp — never the real ~/.claude or the real user home)`);

    const entries: ConformanceTraceEntry[] = [];
    let thrown: unknown;
    try {
      // Deliberately the SAME minimal options as Scenario A -- no tools/allowedTools/disallowedTools/
      // permissions/hooks of any kind, so this is genuinely the official runtime's own UNMODIFIED
      // default advertised set, not a set already narrowed by this capture's own configuration.
      const q = officialSdk.query({
        prompt: "hi",
        options: {
          model: "sonnet",
          cwd: fixtureCwd,
          settingSources: [],
          env: {
            ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
            ANTHROPIC_API_KEY: "test",
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            HOME: homeDir,
          },
        },
      });
      for await (const msg of q) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: msg.type === "system" ? `system/${msg.subtype}` : msg.type, payload: msg });
      }
    } catch (e) {
      thrown = e;
    }

    console.error(`[capture C] official runtime made ${requestCount} request(s) to the loopback; ${entries.length} message(s) yielded`);
    if (thrown) console.error(`[capture C] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    const normalized = normalizeTrace(entries);
    const initEntry = normalized.find((e) => e.kind === "system/init");
    const officialTools = initEntry ? (initEntry.payload as { tools?: unknown }).tools : undefined;

    console.log(`\n--- Scenario C normalized trace ---`);
    console.log(JSON.stringify(normalized, null, 2));
    console.log(`\n--- Scenario C: the official runtime's own default system/init.tools list (compare by eye against Winter's own default buildAdvertisedSet output) ---`);
    console.log(JSON.stringify(officialTools ?? "(no system/init message observed)", null, 2));
    if (Array.isArray(officialTools)) {
      console.error(`[capture C] official default advertised set has ${officialTools.length} name(s) -- see the printed list above for the exact names (WS-06 §6 obligation 1/4: report-only, never asserted as a count anywhere in the committed test suite)`);
    }
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario B (Task 13): canUseTool + includeHookEvents + PreToolUse + SessionEnd -------------

async function runPermissionsAndHooksCapture(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-official-capture-config-b-"));
    cleanups.push(() => rmSync(claudeConfigDir, { recursive: true, force: true }));
    // Item 13 (P2 fix-wave): see runPlainQueryCapture's own identical `homeDir` comment.
    const homeDir = mkdtempSync(join(tmpdir(), "winter-official-capture-home-b-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const fixtureCwd = mkdtempSync(join(tmpdir(), "winter-official-capture-cwd-b-"));
    cleanups.push(() => rmSync(fixtureCwd, { recursive: true, force: true }));
    // A dedicated dummy read target, OUTSIDE fixtureCwd (so it's genuinely promptable, never
    // baseline-auto-approved as "routine read-only work in cwd") — no real file, no real content,
    // never read for real either: canUseTool denies before execution ever reaches it.
    const readTargetDir = mkdtempSync(join(tmpdir(), "winter-official-capture-readtarget-"));
    cleanups.push(() => rmSync(readTargetDir, { recursive: true, force: true }));
    const readTargetPath = join(readTargetDir, "capture-dummy.txt");
    writeFileSync(readTargetPath, "winter capture fixture -- not real data\n");

    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        let sawToolResult = false;
        try {
          const bodyText = await req.clone().text();
          sawToolResult = bodyText.length > 0 && requestAlreadySawToolResult(JSON.parse(bodyText));
        } catch {
          // non-JSON or unreadable body — conservative default (tool_use response) below.
        }
        console.error(`[loopback B] #${requestCount} ${req.method} ${url.pathname}${url.search} host=${req.headers.get("host")} sawToolResult=${sawToolResult}`);
        const body = sawToolResult ? CANNED_TEXT_AFTER_TOOL_RESPONSE : cannedToolUseResponse(readTargetPath);
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    console.error(`\n=== Scenario B: canUseTool + includeHookEvents + PreToolUse (observer) + SessionEnd ===`);
    console.error(`[capture B] loopback listening on ${server.url.href} (the ONLY endpoint the official runtime is given)`);
    console.error(`[capture B] CLAUDE_CONFIG_DIR=${claudeConfigDir} HOME=${homeDir} (both fresh mkdtemp); read target=${readTargetPath} (fresh mkdtemp, dummy content, never read for real)`);

    // Captured for the report's own "callback field set" printout. `signal` (an AbortSignal) is
    // recorded by TYPE only, never JSON.stringify'd (it doesn't serialize meaningfully); every other
    // field is recorded verbatim — none of WS-07 §7.1's fields are ever secret-shaped.
    let canUseToolCallCount = 0;
    let canUseToolFieldSet: string[] = [];
    let canUseToolPrintableSnapshot: Record<string, unknown> = {};
    let sessionEndHookRan = false;
    const preToolUseHookInvocations: unknown[] = [];

    const entries: ConformanceTraceEntry[] = [];
    let thrown: unknown;
    try {
      const q = officialSdk.query({
        prompt: "please read the capture fixture file",
        options: {
          model: "sonnet",
          cwd: fixtureCwd,
          settingSources: [],
          includeHookEvents: true,
          env: {
            ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
            ANTHROPIC_API_KEY: "test",
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            HOME: homeDir,
          },
          // Denies immediately — the point of this scenario is observing the callback's received
          // fields and the hook lifecycle stream, never actually letting Read execute.
          canUseTool: async (toolName: string, input: Record<string, unknown>, opts: Record<string, unknown>) => {
            canUseToolCallCount++;
            canUseToolFieldSet = Object.keys(opts);
            canUseToolPrintableSnapshot = {
              toolName,
              input,
              ...Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, k === "signal" ? `<${typeof v}>` : v])),
            };
            return { behavior: "deny", message: "capture: denied by canUseTool (Task 13 official capture)" };
          },
          // Pure OBSERVER (no opinion) -- deliberately never "allow", so this scenario does not
          // entangle "does a hook-allow shadow canUseTool in the official runtime" with this
          // capture's primary goal (the canUseTool field set + lifecycle frames). That question is
          // recorded as a recommended FOLLOW-UP capture in the report, not risked here.
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input: unknown) => {
                    preToolUseHookInvocations.push(input);
                    return {};
                  },
                ],
              },
            ],
            SessionEnd: [
              {
                hooks: [
                  async () => {
                    sessionEndHookRan = true;
                    return {};
                  },
                ],
              },
            ],
          },
        },
      });
      for await (const msg of q) {
        entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: msg.type === "system" ? `system/${msg.subtype}` : msg.type, payload: msg });
      }
    } catch (e) {
      thrown = e;
    }

    console.error(`[capture B] official runtime made ${requestCount} request(s) to the loopback; ${entries.length} message(s) yielded`);
    if (thrown) console.error(`[capture B] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);
    console.error(`[capture B] canUseTool invoked ${canUseToolCallCount} time(s); PreToolUse hook invoked ${preToolUseHookInvocations.length} time(s); SessionEnd hook body ran: ${sessionEndHookRan}`);

    const normalized = normalizeTrace(entries);
    const lifecycleKinds = normalized.map((e) => e.kind).filter((k) => k.startsWith("system/hook_"));
    console.error(`[capture B] lifecycle-family messages observed on the stream: ${lifecycleKinds.length ? lifecycleKinds.join(", ") : "(none)"}`);

    console.log(`\n--- Scenario B normalized trace ---`);
    console.log(JSON.stringify(normalized, null, 2));
    console.log(`\n--- Scenario B: canUseTool's received field set (WS-07 §7.1 comparison) ---`);
    console.log(JSON.stringify(canUseToolFieldSet, null, 2));
    console.log(`\n--- Scenario B: canUseTool's received values (signal recorded by type only) ---`);
    console.log(JSON.stringify(canUseToolPrintableSnapshot, null, 2));
    console.log(`\n--- Scenario B: Carry 3 (WS-17 capture-note) signals ---`);
    console.log(JSON.stringify({ sessionEndHookBodyRan: sessionEndHookRan, lifecycleMessagesObserved: lifecycleKinds }, null, 2));
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}


// --- Scenario D (Phase 4 Task 8, rider 8): the ADVERTISED TOOL SCHEMAS in the live request ------
//
// WS-09 §8.5's own "Ground truth" rule -- "every deferral decision is verified against what the
// model actually received (the live request's tools array), never against configuration intent
// alone" -- has one and only one observable source on the official branch: the `tools[]` array of
// the Messages API request body the runtime sends. This scenario's loopback captures that body and
// reports, per configuration:
//
//   (1) every advertised tool NAME (the official default advertised set, at the request layer
//       rather than at system/init -- Scenario C already prints the latter, and the two disagreeing
//       would itself be a finding);
//   (2) the Agent/Task tool's own input_schema PROPERTY NAMES + `required` -- which is exactly
//       WS-10 §17 Open Question 1's evidence gap ("the pinned default session did not advertise
//       `name`... the exact capability predicate that turns it on must be captured");
//   (3) explicit presence checks for the names Winter advertises and the pinned artifact does not
//       declare a schema for at all (SendMessage/ListAgents -- derived-shapes-p4 item (e)'s
//       "exhaustive absence"), plus the MCP/Tool-Search family.
//
// PROSE IS NEVER PRINTED: only property names, `required` lists, enum members, and types. Every
// `description` field is stripped before printing (this repo's own hermeticity rule: no Anthropic
// prose beyond names). Report-only, like every other scenario here.
function schemaShapeOnly(schema: unknown, insidePropertiesMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((v) => schemaShapeOnly(v));
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    // Strip prose ANNOTATIONS only. Correction found by the first real run of this scenario: the
    // naive version also deleted a PROPERTY whose own name happens to be `description` -- which
    // Agent's schema has -- making the printed shape wrongly look like `description` was required
    // but not declared. Inside a `properties` map the keys are FIELD NAMES, never annotations.
    if (!insidePropertiesMap && (k === "description" || k === "title" || k === "$comment")) continue;
    out[k] = schemaShapeOnly(v, k === "properties");
  }
  return out;
}

interface CapturedRequestTools {
  names: string[];
  agentSchema: unknown;
}

function capturedToolsFrom(body: unknown): CapturedRequestTools | undefined {
  const tools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return undefined;
  const names = tools.map((t) => String((t as { name?: unknown }).name));
  const agent = tools.find((t) => {
    const n = (t as { name?: unknown }).name;
    return n === "Agent" || n === "Task";
  });
  return { names, agentSchema: agent === undefined ? undefined : schemaShapeOnly((agent as { input_schema?: unknown }).input_schema) };
}

async function runAdvertisedSchemaCapture(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-official-capture-config-d-"));
    cleanups.push(() => rmSync(claudeConfigDir, { recursive: true, force: true }));
    const homeDir = mkdtempSync(join(tmpdir(), "winter-official-capture-home-d-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const fixtureCwd = mkdtempSync(join(tmpdir(), "winter-official-capture-cwd-d-"));
    cleanups.push(() => rmSync(fixtureCwd, { recursive: true, force: true }));

    let captured: CapturedRequestTools | undefined;
    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        console.error(`[loopback D] #${requestCount} ${req.method} ${url.pathname}${url.search}`);
        try {
          const body = await req.json();
          if (captured === undefined) captured = capturedToolsFrom(body);
        } catch {
          /* a non-JSON / non-completions request -- nothing to capture from it */
        }
        return new Response(JSON.stringify(CANNED_TEXT_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    console.error(`\n=== Scenario D: the live request's advertised tools[] (WS-09 §8.5 ground truth; WS-10 §17 OQ1) ===`);
    console.error(`[capture D] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${claudeConfigDir} HOME=${homeDir} (both fresh mkdtemp)`);

    let thrown: unknown;
    try {
      const q = officialSdk.query({
        prompt: "hi",
        options: {
          model: "sonnet",
          cwd: fixtureCwd,
          settingSources: [],
          env: {
            ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
            ANTHROPIC_API_KEY: "test",
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            HOME: homeDir,
          },
        },
      });
      for await (const _msg of q) {
        /* drained to completion so the loopback and the runtime both shut down cleanly */
      }
    } catch (e) {
      thrown = e;
    }
    if (thrown) console.error(`[capture D] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    console.log(`\n--- Scenario D: every tool NAME in the live request's tools[] ---`);
    console.log(JSON.stringify(captured?.names ?? "(no completions request body with a tools[] array was observed)", null, 2));
    console.log(`\n--- Scenario D: the Agent/Task tool's own input_schema (SHAPE ONLY -- descriptions stripped) ---`);
    console.log(JSON.stringify(captured?.agentSchema ?? "(no Agent/Task tool present in the advertised set)", null, 2));

    // WS-10 §17 OQ1, answered directly and printed as a one-line verdict rather than left for the
    // reader to spot inside the schema dump.
    const agentProps = Object.keys(((captured?.agentSchema as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {});
    console.log(`\n--- Scenario D verdicts ---`);
    console.log(JSON.stringify(
      {
        "WS-10 §17 OQ1 -- is `name` advertised on Agent in a DEFAULT session?": agentProps.length === 0 ? "(no Agent schema captured)" : agentProps.includes("name"),
        "Agent input_schema property names": agentProps,
        // derived-shapes-p4 item (e) recorded these as declaration-absent; this is the RUNTIME half
        // of that same finding (does the default session advertise them to the model at all?).
        "SendMessage advertised?": captured?.names.includes("SendMessage") ?? "(unknown)",
        "ListAgents advertised?": captured?.names.includes("ListAgents") ?? "(unknown)",
        "ToolSearch advertised?": captured?.names.includes("ToolSearch") ?? "(unknown)",
        "WaitForMcpServers advertised?": captured?.names.includes("WaitForMcpServers") ?? "(unknown)",
        "MCP bridge tools advertised?": (captured?.names ?? []).filter((n) => n.startsWith("ListMcpResources") || n.startsWith("ReadMcpResource") || n === "RefreshMcpTools"),
      },
      null,
      2,
    ));
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario E (Phase 4 Task 8, rider 8): MAX_MCP_OUTPUT_TOKENS default + truncation ------------
//
// WS-09 §12 Open Question 1, verbatim: "The pinned report has no entry for it; the value here
// (default 25000) comes from public env-var documentation. The drift gate MUST capture the exact
// 0.3.250-runtime default and truncation behavior before the §7 fixture is trusted."
//
// The observable: an in-process SDK MCP server tool returns a deliberately enormous text payload;
// whatever the runtime actually puts into the NEXT request's `messages` (as that call's
// tool_result) is what survived the cap. Printed as LENGTHS and a head/tail sample of any marker
// text the runtime inserted -- never the payload itself, which is this script's own synthetic
// filler. Run TWICE: once with no env override (the default), once with MAX_MCP_OUTPUT_TOKENS=100
// (does the knob bind at all, and does the marker change?).
async function runMcpOutputCapCapture(officialSdk: OfficialSdk, maxOutputTokens: string | undefined): Promise<void> {
  const label = maxOutputTokens === undefined ? "default" : `MAX_MCP_OUTPUT_TOKENS=${maxOutputTokens}`;
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const claudeConfigDir = mkdtempSync(join(tmpdir(), "winter-official-capture-config-e-"));
    cleanups.push(() => rmSync(claudeConfigDir, { recursive: true, force: true }));
    const homeDir = mkdtempSync(join(tmpdir(), "winter-official-capture-home-e-"));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const fixtureCwd = mkdtempSync(join(tmpdir(), "winter-official-capture-cwd-e-"));
    cleanups.push(() => rmSync(fixtureCwd, { recursive: true, force: true }));

    // ~400k characters of synthetic filler -- far past any plausible token cap, and entirely this
    // script's own content (never upstream prose).
    const HUGE = "winterfiller ".repeat(30_000);
    const sdkAny = officialSdk as unknown as {
      createSdkMcpServer?: (opts: Record<string, unknown>) => unknown;
      tool?: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => unknown;
    };
    if (typeof sdkAny.createSdkMcpServer !== "function" || typeof sdkAny.tool !== "function") {
      console.log(`\n--- Scenario E (${label}): SKIPPED -- the installed package does not export createSdkMcpServer/tool ---`);
      return;
    }
    // `tool()` takes "a Zod schema or raw shape", NOT a JSON Schema object -- the first real run of
    // this scenario failed with exactly that error. An empty RAW SHAPE (`{}`, i.e. a zero-field
    // object of Zod types) is the dependency-free way to say "no arguments"; this repository does not
    // declare `zod` as a dependency of its own (it is a peer of the MCP SDK), and taking one just to
    // describe an empty input would be a real dependency for a report-only probe.
    const bigTool = sdkAny.tool("bigoutput", "returns a very large payload", {}, async () => ({
      content: [{ type: "text", text: HUGE }],
    }));
    const mcpServer = sdkAny.createSdkMcpServer({ name: "capfixture", version: "1.0.0", tools: [bigTool] });

    let toolResultTexts: string[] = [];
    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify(CANNED_TEXT_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
        }
        // Harvest every tool_result text the runtime has put into the conversation so far.
        const messages = (body as { messages?: unknown[] }).messages ?? [];
        for (const m of messages) {
          const content = (m as { content?: unknown }).content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if ((block as { type?: string }).type !== "tool_result") continue;
            const c = (block as { content?: unknown }).content;
            const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => String((b as { text?: unknown }).text ?? "")).join("") : "";
            if (text.length > 0) toolResultTexts.push(text);
          }
        }
        if (requestAlreadySawToolResult(body)) {
          return new Response(JSON.stringify(CANNED_TEXT_AFTER_TOOL_RESPONSE), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(
          JSON.stringify({
            id: "msg_capture_mcp_01",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            content: [{ type: "tool_use", id: "toolu_capture_mcp_01", name: "mcp__capfixture__bigoutput", input: {} }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    console.error(`\n=== Scenario E (${label}): MAX_MCP_OUTPUT_TOKENS default + truncation (WS-09 §12 OQ1) ===`);
    console.error(`[capture E/${label}] loopback ${server.url.href}; payload sent by the fixture server: ${HUGE.length} chars`);

    let thrown: unknown;
    try {
      const q = officialSdk.query({
        prompt: "call the big tool",
        options: {
          model: "sonnet",
          cwd: fixtureCwd,
          settingSources: [],
          allowedTools: ["mcp__capfixture__bigoutput"],
          permissionMode: "bypassPermissions",
          mcpServers: { capfixture: mcpServer },
          env: {
            ANTHROPIC_BASE_URL: server.url.href.replace(/\/$/, ""),
            ANTHROPIC_API_KEY: "test",
            CLAUDE_CONFIG_DIR: claudeConfigDir,
            HOME: homeDir,
            ...(maxOutputTokens !== undefined ? { MAX_MCP_OUTPUT_TOKENS: maxOutputTokens } : {}),
          },
        },
      });
      for await (const _msg of q) {
        /* drained */
      }
    } catch (e) {
      thrown = e;
    }
    if (thrown) console.error(`[capture E/${label}] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    const longest = toolResultTexts.reduce((a, b) => (b.length > a.length ? b : a), "");
    console.log(`\n--- Scenario E (${label}) ---`);
    console.log(
      JSON.stringify(
        {
          "payload chars the fixture server returned": HUGE.length,
          "tool_result blocks observed": toolResultTexts.length,
          "longest tool_result chars the runtime forwarded": longest.length,
          truncated: longest.length > 0 && longest.length < HUGE.length,
          // The MARKER is the load-bearing half of WS-09 §7 ("Winter marks the truncation explicitly
          // in the result the model sees"). Printed as the head+tail of the surviving text with the
          // synthetic filler collapsed, so any marker sentence the official runtime inserted is
          // visible without reprinting 25k characters of this script's own filler.
          "head (first 300 chars)": longest.slice(0, 300),
          "tail (last 300 chars)": longest.slice(-300),
        },
        null,
        2,
      ),
    );
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// ===============================================================================================
// Phase 6 Task 1 (WS-13) scenarios F-K.
//
// LETTERING NOTE: the phase plan and this task's brief both say "scenarios D-H". D and E were
// already taken by Phase 4 Task 8 (rider 8) above — reusing those letters would overwrite committed
// P4 evidence — so this task's six scenarios continue the sequence at F. The mapping from the
// brief's capture numbers is: (1)=F streaming, (2)=G retry/rate-limit/fallback, (3)=H the WS-17
// probe (a) neighbour-file survival, (4)=I failure shapes, (5)=J model control API, (6)=K cost.
//
// Every one of them follows scenarios A-C's structure exactly: its own loopback `Bun.serve` on
// 127.0.0.1:0, its own fresh mkdtemp CLAUDE_CONFIG_DIR / HOME / cwd, `settingSources: []`, an `env`
// that is EXACTLY the four hermetic vars with no process.env spread, every received request logged
// to stderr as evidence the loopback was the only endpoint, and cleanup in a `finally`. Two
// additions this phase needs and A-E did not:
//   * a WALL-CLOCK DEADLINE per run (`abortController` + a timer): scenario G deliberately makes the
//     runtime retry, and a retrying runtime with no deadline can hang the harness indefinitely;
//   * SSE. A-E return plain JSON bodies, which the runtime tolerates for non-streaming requests, but
//     `stream_event` frames only exist when the response is real `text/event-stream` framing. The
//     helpers below branch on the request body's own `stream` flag.
//
// PROSE IS NEVER PRINTED, exactly as scenario D established: request bodies are summarised
// structurally (roles, block types, key presence) and their `system`/`tools` fields are never read
// or logged. The only string values printed are ones this script itself authored.
// ===============================================================================================

type OfficialMessage = { type: string; subtype?: string; [k: string]: unknown };
type OfficialQueryHandle = AsyncIterable<{ type: string; subtype?: string }> & {
  supportedModels?: () => Promise<unknown>;
  setModel?: (model?: string) => Promise<void>;
  accountInfo?: () => Promise<unknown>;
};

interface ScenarioDirs {
  claudeConfigDir: string;
  homeDir: string;
  fixtureCwd: string;
}

/** The three fresh mkdtemp dirs every scenario needs, each registered for cleanup as it is acquired
 *  (acquire-then-register, never a batch ahead of one try — the T11 review's own rule). */
function makeScenarioDirs(tag: string, cleanups: Array<() => void>): ScenarioDirs {
  const claudeConfigDir = mkdtempSync(join(tmpdir(), `winter-official-capture-config-${tag}-`));
  cleanups.push(() => rmSync(claudeConfigDir, { recursive: true, force: true }));
  const homeDir = mkdtempSync(join(tmpdir(), `winter-official-capture-home-${tag}-`));
  cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
  const fixtureCwd = mkdtempSync(join(tmpdir(), `winter-official-capture-cwd-${tag}-`));
  cleanups.push(() => rmSync(fixtureCwd, { recursive: true, force: true }));
  return { claudeConfigDir, homeDir, fixtureCwd };
}

/** EXACTLY the four hermetic vars (plus any scenario-specific extra). `env` replaces the child's
 *  environment wholesale, so anything not listed here is genuinely absent from the runtime. */
function hermeticEnv(dirs: ScenarioDirs, baseUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl.replace(/\/$/, ""),
    ANTHROPIC_API_KEY: "test",
    CLAUDE_CONFIG_DIR: dirs.claudeConfigDir,
    HOME: dirs.homeDir,
    ...extra,
  };
}

/** Drains a query to completion under a wall-clock deadline, collecting trace entries. Returns
 *  whatever the iteration threw (or undefined). The deadline aborts via the caller's
 *  AbortController — the pinned `Options.abortController` contract — and also stops waiting. */
async function drainWithDeadline(
  q: AsyncIterable<{ type: string; subtype?: string }>,
  entries: ConformanceTraceEntry[],
  label: string,
  deadlineMs: number,
  ac?: AbortController,
): Promise<{ thrown: unknown; deadlineHit: boolean }> {
  let deadlineHit = false;
  const timer = setTimeout(() => {
    deadlineHit = true;
    console.error(`[${label}] WALL-CLOCK DEADLINE ${deadlineMs}ms reached — aborting the run`);
    ac?.abort();
  }, deadlineMs);
  let thrown: unknown;
  try {
    for await (const msg of q) {
      entries.push({
        sequence: entries.length,
        direction: "runtime-to-host",
        kind: msg.type === "system" ? `system/${msg.subtype}` : msg.type,
        payload: msg,
      });
    }
  } catch (e) {
    thrown = e;
  } finally {
    clearTimeout(timer);
  }
  return { thrown, deadlineHit };
}

function describeThrown(thrown: unknown): unknown {
  if (thrown === undefined) return undefined;
  if (thrown instanceof Error) {
    return { class: thrown.constructor.name, name: thrown.name, message: thrown.message };
  }
  return { class: typeof thrown, value: String(thrown) };
}

/** Server-sent-events framing, the shape the streaming Messages API uses. */
function sseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const CAPTURE_STREAM_SIGNATURE = "WinterCaptureFakeThinkingSignature0123456789ABCDEF";

/** SHAPE-ONLY rendering of a request body's `messages` — roles, block types, and the presence (never
 *  the value) of the fields item (f) turns on. `system`, `tools` and every text value are excluded. */
function messagesShape(body: unknown): unknown {
  const messages = (body as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages)) return "(no messages array)";
  return messages.map((m) => {
    const rec = m as Record<string, unknown>;
    const content = rec.content;
    if (typeof content === "string") return { role: rec.role, content: `<string:${content.length} chars>` };
    if (!Array.isArray(content)) return { role: rec.role, content: typeof content };
    return {
      role: rec.role,
      blocks: content.map((b) => {
        const block = b as Record<string, unknown>;
        const out: Record<string, unknown> = { type: block.type };
        if (block.type === "thinking") {
          out.hasSignature = Object.prototype.hasOwnProperty.call(block, "signature");
          out.signatureIsTheCannedOne = block.signature === CAPTURE_STREAM_SIGNATURE;
          out.thinkingChars = typeof block.thinking === "string" ? block.thinking.length : null;
        }
        if (block.type === "redacted_thinking") out.hasData = Object.prototype.hasOwnProperty.call(block, "data");
        if (block.type === "tool_use") out.name = block.name;
        if (block.type === "tool_result") {
          out.contentKind = Array.isArray(block.content) ? "blocks" : typeof block.content;
          if (Array.isArray(block.content)) out.blockTypes = block.content.map((c) => (c as { type?: unknown }).type);
        }
        if (block.type === "image") out.sourceType = (block.source as { type?: unknown } | undefined)?.type;
        return out;
      }),
    };
  });
}

/** The request's own top-level shape, minus everything prose-bearing. `thinking` is a small config
 *  object this script itself set, so printing it is free evidence for item (c)'s wire spelling. */
function requestEnvelopeShape(body: unknown): unknown {
  const rec = body as Record<string, unknown>;
  return {
    model: rec.model,
    stream: rec.stream,
    max_tokens: rec.max_tokens,
    thinking: rec.thinking,
    topLevelKeys: Object.keys(rec).sort(),
    toolCount: Array.isArray(rec.tools) ? rec.tools.length : null,
  };
}

// --- Scenario F (capture 1): includePartialMessages over text + thinking + tool_use --------------
//
// The brief's capture (1). The canned SSE stream carries a `thinking` block (with a `signature_delta`
// in run (i), WITHOUT one in run (ii)), a `text` block, and a `tool_use` block for the built-in
// `Read` tool pointed at a fresh mkdtemp file, so the ordering under `includePartialMessages: true`
// covers all three block kinds; the second request (after the tool result) returns a plain text
// end_turn. A `ping` event is included deliberately — the pinned JSDoc's six-name event list omits it
// while `user_message_uuid`'s own JSDoc names it, so whether it reaches the consumer is a real
// question about the union's true membership.
//
// The two runs are what makes this capture answer R6-8 (derived-shapes item (f)): the pinned
// artifact does NOT declare the assistant `thinking` block, so "is `signature` required?" can only be
// answered by watching what the runtime does with a signed vs. unsigned block — specifically whether
// the block survives verbatim into the NEXT request's `messages`.
function streamTurn1Events(readTargetPath: string, withSignature: boolean): Array<{ event: string; data: unknown }> {
  const model = "claude-sonnet-4-5-20250929";
  const evs: Array<{ event: string; data: unknown }> = [];
  evs.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_capture_stream_01",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 1 },
      },
    },
  });
  evs.push({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index: 0,
      content_block: withSignature ? { type: "thinking", thinking: "", signature: "" } : { type: "thinking", thinking: "" },
    },
  });
  evs.push({ event: "ping", data: { type: "ping" } });
  evs.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "winter capture: weighing two options" } },
  });
  if (withSignature) {
    evs.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: CAPTURE_STREAM_SIGNATURE } },
    });
  }
  evs.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
  evs.push({ event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
  evs.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "reading the " } } });
  evs.push({ event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "capture fixture" } } });
  evs.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 1 } });
  evs.push({
    event: "content_block_start",
    data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_capture_stream_01", name: "Read", input: {} } },
  });
  evs.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path": ' } },
  });
  evs.push({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: `${JSON.stringify(readTargetPath)}}` } },
  });
  evs.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 2 } });
  evs.push({
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } },
  });
  evs.push({ event: "message_stop", data: { type: "message_stop" } });
  return evs;
}

function streamTurn2Events(): Array<{ event: string; data: unknown }> {
  const model = "claude-sonnet-4-5-20250929";
  return [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: "msg_capture_stream_02", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "capture: stream round complete" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

async function runStreamEventCapture(officialSdk: OfficialSdk, withSignature: boolean): Promise<void> {
  const label = withSignature ? "signed" : "unsigned";
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dirs = makeScenarioDirs(`f-${label}`, cleanups);
    const readTargetPath = join(dirs.fixtureCwd, "capture-stream-fixture.txt");
    writeFileSync(readTargetPath, "winter capture fixture -- not real data\n");

    let requestCount = 0;
    const envelopes: unknown[] = [];
    const messageShapes: unknown[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          console.error(`[loopback F/${label}] #${requestCount} ${req.method} ${url.pathname} (non-JSON body)`);
          return jsonResponse(CANNED_TEXT_RESPONSE);
        }
        envelopes.push(requestEnvelopeShape(body));
        messageShapes.push(messagesShape(body));
        const sawToolResult = requestAlreadySawToolResult(body);
        const wantsStream = (body as { stream?: unknown }).stream === true;
        console.error(`[loopback F/${label}] #${requestCount} ${req.method} ${url.pathname} stream=${wantsStream} sawToolResult=${sawToolResult}`);
        if (!wantsStream) return jsonResponse(sawToolResult ? CANNED_TEXT_AFTER_TOOL_RESPONSE : CANNED_TEXT_RESPONSE);
        return sseResponse(sawToolResult ? streamTurn2Events() : streamTurn1Events(readTargetPath, withSignature));
      },
    });
    console.error(`\n=== Scenario F (${label}): includePartialMessages over text + thinking + tool_use ===`);
    console.error(`[capture F/${label}] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${dirs.claudeConfigDir} HOME=${dirs.homeDir} (fresh mkdtemp)`);

    const entries: ConformanceTraceEntry[] = [];
    const ac = new AbortController();
    const q = officialSdk.query({
      prompt: "please read the capture fixture file",
      options: {
        model: "sonnet",
        cwd: dirs.fixtureCwd,
        settingSources: [],
        includePartialMessages: true,
        // Free evidence for derived-shapes item (c): whatever the runtime puts on the wire for this
        // is the pinned ThinkingConfig's actual request spelling, printed by requestEnvelopeShape.
        thinking: { type: "enabled", budgetTokens: 1024 },
        permissionMode: "bypassPermissions",
        abortController: ac,
        env: hermeticEnv(dirs, server.url.href),
      },
    });
    const { thrown, deadlineHit } = await drainWithDeadline(q, entries, `capture F/${label}`, 120_000, ac);

    console.error(`[capture F/${label}] ${requestCount} loopback request(s); ${entries.length} message(s) yielded; deadlineHit=${deadlineHit}`);
    if (thrown) console.error(`[capture F/${label}] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    const normalized = normalizeTrace(entries);
    const streamEvents = entries
      .map((e) => e.payload as OfficialMessage)
      .filter((p) => p.type === "stream_event");

    console.log(`\n--- Scenario F (${label}) normalized trace ---`);
    console.log(JSON.stringify(normalized, null, 2));
    console.log(`\n--- Scenario F (${label}): the raw stream_event list, in order (event.type / delta.type / index) ---`);
    console.log(
      JSON.stringify(
        streamEvents.map((p, i) => {
          const ev = p.event as Record<string, unknown> | undefined;
          const delta = ev?.delta as Record<string, unknown> | undefined;
          const cb = ev?.content_block as Record<string, unknown> | undefined;
          return {
            i,
            eventType: ev?.type,
            index: ev?.index,
            deltaType: delta?.type,
            contentBlockType: cb?.type,
            parent_tool_use_id: p.parent_tool_use_id,
            hasUuid: typeof p.uuid === "string",
            hasSessionId: typeof p.session_id === "string",
            ttft_ms: p.ttft_ms,
            user_message_uuid: p.user_message_uuid === undefined ? "(absent)" : "(present)",
          };
        }),
        null,
        2,
      ),
    );
    console.log(`\n--- Scenario F (${label}): every stream_event's own top-level key set (union) ---`);
    console.log(JSON.stringify([...new Set(streamEvents.flatMap((p) => Object.keys(p)))].sort(), null, 2));
    console.log(`\n--- Scenario F (${label}): request envelope shapes (item (c) wire spelling of ThinkingConfig) ---`);
    console.log(JSON.stringify(envelopes, null, 2));
    console.log(`\n--- Scenario F (${label}): request messages SHAPE ONLY (item (f) — does the thinking block survive replay?) ---`);
    console.log(JSON.stringify(messageShapes, null, 2));
    console.log(`\n--- Scenario F (${label}) verdicts ---`);
    console.log(
      JSON.stringify(
        {
          "stream_event frames observed": streamEvents.length,
          "distinct event.type values, in first-seen order": [...new Set(streamEvents.map((p) => (p.event as { type?: unknown } | undefined)?.type))],
          "did a ping reach the consumer?": streamEvents.some((p) => (p.event as { type?: unknown } | undefined)?.type === "ping"),
          "frames carrying user_message_uuid": streamEvents.filter((p) => p.user_message_uuid !== undefined).length,
          "frames carrying ttft_ms": streamEvents.filter((p) => p.ttft_ms !== undefined).length,
          "completed assistant frames": entries.filter((e) => (e.payload as OfficialMessage).type === "assistant").length,
          "query() threw": describeThrown(thrown) ?? false,
          deadlineHit,
        },
        null,
        2,
      ),
    );
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario G (capture 2): api_retry / rate_limit_event / fallback ----------------------------
//
// Three runs against three loopback policies:
//   (i)  529 overloaded_error on the first N POSTs, then 200 — captures api_retry's attempt
//        numbering, max_retries, retry_delay_ms progression and the mapped `error` taxonomy member;
//   (ii) 429 with `retry-after: 2` and the anthropic-ratelimit-* headers on the first N POSTs, then
//        200 — captures
//        whether retry_delay_ms honours retry-after, and whether ANY rate_limit_event appears (the
//        pinned type's own JSDoc scopes it to claude.ai subscription users, so its ABSENCE under an
//        API key is the finding, and a real one for OQ-P6-4);
//   (iii) PERSISTENT 529 with `fallbackModel` set — captures whatever refusal/fallback frame appears
//        (the pinned pair are both `trigger: 'refusal'`, so possibly none) and, decisively, whether
//        the `model` field of the outgoing requests ever changes to the fallback id.
// Every run is deadline-bounded: a retrying runtime with no deadline can hang the harness.
type RetryPolicy = "overloaded-then-ok" | "ratelimit-then-ok" | "persistent-overloaded";

async function runRetryCapture(officialSdk: OfficialSdk, policy: RetryPolicy): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  // POSTs only. Review r1 Minor 5: this counter previously incremented on every request, and the
  // runtime's `HEAD /api/hello` preflight is request #1 -- so runs (i)/(ii) delivered exactly ONE
  // failing POST each and produced one retry, not the multi-attempt progression this scenario's
  // header promises. Gating on the method makes the promise true for all three runs.
  const failingPostsBeforeSuccess = 2;
  try {
    const dirs = makeScenarioDirs(`g-${policy}`, cleanups);
    let requestCount = 0;
    let postCount = 0;
    const requestLog: Array<{ n: number; model: unknown; atMs: number }> = [];
    const t0 = Date.now();
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        const n = requestCount;
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          body = {};
        }
        const model = (body as { model?: unknown }).model;
        requestLog.push({ n, model, atMs: Date.now() - t0 });
        const url = new URL(req.url);
        const isPost = req.method === "POST";
        if (isPost) postCount++;
        console.error(`[loopback G/${policy}] #${n} (POST #${isPost ? postCount : "-"}) ${req.method} ${url.pathname} model=${JSON.stringify(model)} t+${Date.now() - t0}ms`);
        if (policy === "overloaded-then-ok") {
          if (isPost && postCount <= failingPostsBeforeSuccess) return jsonResponse({ type: "error", error: { type: "overloaded_error", message: "capture: synthetic overload" } }, 529);
          return jsonResponse(CANNED_TEXT_RESPONSE);
        }
        if (policy === "ratelimit-then-ok") {
          if (isPost && postCount <= failingPostsBeforeSuccess) {
            return jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "capture: synthetic rate limit" } }, 429, {
              "retry-after": "2",
              "anthropic-ratelimit-requests-limit": "1000",
              "anthropic-ratelimit-requests-remaining": "0",
              "anthropic-ratelimit-requests-reset": new Date(Date.now() + 2000).toISOString(),
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-reset": new Date(Date.now() + 2000).toISOString(),
            });
          }
          return jsonResponse(CANNED_TEXT_RESPONSE);
        }
        return jsonResponse({ type: "error", error: { type: "overloaded_error", message: "capture: synthetic persistent overload" } }, 529);
      },
    });
    console.error(`\n=== Scenario G (${policy}): api_retry / rate_limit_event / fallback ===`);
    console.error(`[capture G/${policy}] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${dirs.claudeConfigDir} HOME=${dirs.homeDir} (fresh mkdtemp)`);

    const entries: ConformanceTraceEntry[] = [];
    const ac = new AbortController();
    const q = officialSdk.query({
      prompt: "hi",
      options: {
        model: "sonnet",
        cwd: dirs.fixtureCwd,
        settingSources: [],
        abortController: ac,
        ...(policy === "persistent-overloaded" ? { fallbackModel: "haiku" } : {}),
        env: hermeticEnv(dirs, server.url.href),
      },
    });
    const { thrown, deadlineHit } = await drainWithDeadline(q, entries, `capture G/${policy}`, 180_000, ac);

    console.error(`[capture G/${policy}] ${requestCount} loopback request(s); ${entries.length} message(s) yielded; deadlineHit=${deadlineHit}`);
    if (thrown) console.error(`[capture G/${policy}] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    const payloads = entries.map((e) => e.payload as OfficialMessage);
    const retries = payloads.filter((p) => p.type === "system" && p.subtype === "api_retry");
    const rateLimits = payloads.filter((p) => p.type === "rate_limit_event");
    const refusals = payloads.filter((p) => p.type === "system" && (p.subtype === "model_refusal_fallback" || p.subtype === "model_refusal_no_fallback"));
    const results = payloads.filter((p) => p.type === "result");

    console.log(`\n--- Scenario G (${policy}) normalized trace ---`);
    console.log(JSON.stringify(normalizeTrace(entries), null, 2));
    console.log(`\n--- Scenario G (${policy}): every api_retry frame, verbatim ---`);
    console.log(JSON.stringify(retries, null, 2));
    console.log(`\n--- Scenario G (${policy}): every rate_limit_event frame ---`);
    console.log(JSON.stringify(rateLimits.length > 0 ? rateLimits : "(none observed)", null, 2));
    // Review r1 Minor 7: SDKModelRefusal{Fallback,NoFallback}Message carry `content` and
    // `api_refusal_explanation`, both vendor-authored prose (the latter is doc-marked unstable human
    // prose, display-only). Stringifying the frame whole was a latent prose-to-stdout path even
    // though no refusal frame has ever been observed here; both fields are now reported as lengths.
    const prosefreeRefusals = refusals.map((r) => {
      const out: Record<string, unknown> = { ...r };
      for (const k of ["content", "api_refusal_explanation"]) {
        const v = out[k];
        if (typeof v === "string") out[k] = `<${v.length} chars, withheld: vendor prose>`;
      }
      return out;
    });
    console.log(`\n--- Scenario G (${policy}): every refusal/fallback frame (prose fields as lengths) ---`);
    console.log(JSON.stringify(prosefreeRefusals.length > 0 ? prosefreeRefusals : "(none observed)", null, 2));
    console.log(`\n--- Scenario G (${policy}): the model on each outgoing request, with arrival times ---`);
    console.log(JSON.stringify(requestLog, null, 2));
    console.log(`\n--- Scenario G (${policy}) verdicts ---`);
    console.log(
      JSON.stringify(
        {
          "api_retry frames": retries.length,
          "attempt / max_retries / retry_delay_ms / error_status / error": retries.map((r) => ({
            attempt: r.attempt,
            max_retries: r.max_retries,
            retry_delay_ms: r.retry_delay_ms,
            error_status: r.error_status,
            error: r.error,
          })),
          "rate_limit_event frames": rateLimits.length,
          "refusal/fallback frames": refusals.map((r) => r.subtype),
          "distinct models the loopback was asked for": [...new Set(requestLog.map((r) => String(r.model)))],
          "result subtype / is_error": results.map((r) => ({ subtype: r.subtype, is_error: r.is_error, api_error_status: r.api_error_status, terminal_reason: r.terminal_reason })),
          "query() threw": describeThrown(thrown) ?? false,
          deadlineHit,
        },
        null,
        2,
      ),
    );
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario H (capture 3): WS-17 probe (a) — neighbour-file survival ---------------------------
//
// THE probe the controller rules on before Lane C is briefed (R6-7 / R6-7a). Sequence:
//   run 1  — a real turn with a FIXED sessionId under a fresh CLAUDE_CONFIG_DIR, so the official
//            runtime creates its own resumable transcript wherever it likes;
//   drop   — `<sessionId>.provider-state.jsonl` is written BESIDE that transcript (same directory),
//            a few JSON lines carrying a distinctive high-entropy marker; sha256 recorded;
//   run 2  — `resume: <sessionId>` + one more turn against the same loopback, REUSING the same cwd,
//            CLAUDE_CONFIG_DIR and HOME (a fresh cwd would change the derived project key and make
//            an untouched sidecar prove nothing);
//   run 3  — a `/compact` attempt in the same single-shot shape, recorded as a limitation if the
//            runtime cannot drive it that way (P2 found streaming-input captures stall).
// Assertions: (i) the sidecar's sha256 is unchanged, (ii) the marker appears in NO request body the
// loopback received, (iii) the transcript still parses as JSONL. Plus: the directory's file NAMES
// before and after, since a renamed/moved/indexed sidecar is a finding even with identical bytes.
function findFileRecursive(root: string, predicate: (name: string, full: string) => boolean, depth = 0): string[] {
  if (depth > 6) return [];
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...findFileRecursive(full, predicate, depth + 1));
    else if (predicate(name, full)) out.push(full);
  }
  return out;
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** sha256 of a file AT AN EXACT PATH. A file that is missing (deleted, moved or renamed) yields a
 *  sentinel rather than throwing, so the caller reports a FAILED assertion instead of crashing past
 *  its own verdict block. Never falls back to searching by name — see runNeighborFileProbe. */
function sha256AtPath(path: string): string {
  try {
    return sha256OfFile(path);
  } catch {
    return "(ABSENT AT ITS OWN PATH — ASSERTION FAILED)";
  }
}

/** Non-empty JSONL line count at an exact path; -1 when the file cannot be read there. */
function countLinesAtPath(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return -1;
  }
}

async function runNeighborFileProbe(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    // ONE set of dirs, reused across every run — see this scenario's header for why.
    const dirs = makeScenarioDirs("h", cleanups);
    const sessionId = "0192f4c8-6f21-7c3a-9d55-1b8e2a7c40d1"; // fixed, valid-UUID-shaped, this script's own
    const marker = `WINTER-PROVIDER-STATE-MARKER-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;

    let requestCount = 0;
    let markerSeenInAnyRequestBody = false;
    const requestPaths: string[] = [];
    // The append turns answer with a LARGE canned reply, an attempt to give the resumed conversation
    // enough content to compact. IT DID NOT WORK, and the comment says so rather than describing the
    // intent as the outcome (review r1 Minor 3): all three /compact attempts -- six short turns, six
    // long turns, and this ~250KB-of-context variant -- were refused identically with
    // compact_error "Not enough messages to compact", num_turns 0, and no POST reaching the loopback
    // at all. The refusal is an ordering property, not a size threshold, so the filler is retained
    // only because it rules the size hypothesis out. Synthetic filler authored here, never upstream.
    let bulkyReplies = false;
    const BULK_TEXT = "winter capture filler sentence for the compaction threshold. ".repeat(700);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        requestPaths.push(`${req.method} ${url.pathname}`);
        let raw = "";
        try {
          raw = await req.clone().text();
        } catch {
          /* body already consumed or absent */
        }
        // Substring check only — the body is NEVER printed (it carries the system prompt).
        if (raw.includes(marker)) markerSeenInAnyRequestBody = true;
        console.error(`[loopback H] #${requestCount} ${req.method} ${url.pathname} bodyBytes=${raw.length} markerPresent=${raw.includes(marker)}`);
        if (!bulkyReplies) return jsonResponse(CANNED_TEXT_RESPONSE);
        return jsonResponse({
          ...CANNED_TEXT_RESPONSE,
          content: [{ type: "text", text: BULK_TEXT }],
          usage: { input_tokens: 12_000, output_tokens: 12_000 },
        });
      },
    });
    console.error(`\n=== Scenario H: WS-17 probe (a) — neighbour-file survival across resume ===`);
    console.error(`[capture H] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${dirs.claudeConfigDir} HOME=${dirs.homeDir} cwd=${dirs.fixtureCwd} (all fresh mkdtemp, REUSED across runs)`);

    // ---- run 1: create the resumable transcript -------------------------------------------------
    const entries1: ConformanceTraceEntry[] = [];
    const ac1 = new AbortController();
    const r1 = await drainWithDeadline(
      officialSdk.query({
        prompt: "hi from run one",
        options: { model: "sonnet", cwd: dirs.fixtureCwd, settingSources: [], sessionId, abortController: ac1, env: hermeticEnv(dirs, server.url.href) },
      }),
      entries1,
      "capture H/run1",
      120_000,
      ac1,
    );
    const init1 = entries1.map((e) => e.payload as OfficialMessage).find((p) => p.type === "system" && p.subtype === "init");
    console.error(`[capture H] run 1: ${entries1.length} message(s); session_id on init = ${String(init1?.session_id)}`);
    if (r1.thrown) console.error(`[capture H] run 1 threw: ${r1.thrown instanceof Error ? (r1.thrown.stack ?? r1.thrown.message) : String(r1.thrown)}`);

    const observedSessionId = typeof init1?.session_id === "string" ? init1.session_id : sessionId;
    const transcripts = findFileRecursive(dirs.claudeConfigDir, (name) => name === `${observedSessionId}.jsonl`);
    console.error(`[capture H] transcript search under <CLAUDE_CONFIG_DIR> found ${transcripts.length} match(es)`);
    if (transcripts.length === 0) {
      console.log(`\n--- Scenario H: NOT CAPTURABLE — no <sessionId>.jsonl transcript was written under <CLAUDE_CONFIG_DIR> after run 1 ---`);
      console.log(JSON.stringify({ observedSessionId, filesUnderConfigDir: findFileRecursive(dirs.claudeConfigDir, () => true).map((f) => f.replace(dirs.claudeConfigDir, "<CLAUDE_CONFIG_DIR>")) }, null, 2));
      return;
    }
    const transcriptPath = transcripts[0]!;
    const projectDir = dirname(transcriptPath);
    const namesBefore = readdirSync(projectDir).sort();

    // ---- drop the sidecar BESIDE the transcript -------------------------------------------------
    const sidecarPath = join(projectDir, `${observedSessionId}.provider-state.jsonl`);
    const sidecarLines = [
      { type: "provider-state", kind: "origin", sessionId: observedSessionId, anchorUuid: "00000000-0000-4000-8000-000000000001", provider: "winter-capture", model: "winter-capture-model", family: "capture", itemIndex: 0, marker, payload: {} },
      { type: "provider-state", kind: "native-state", sessionId: observedSessionId, anchorUuid: "00000000-0000-4000-8000-000000000001", itemIndex: 1, marker, payload: { opaque: marker } },
      { type: "provider-state", kind: "summary", sessionId: observedSessionId, anchorUuid: "00000000-0000-4000-8000-000000000001", itemIndex: 2, marker, payload: { text: "capture-only summary" } },
    ];
    writeFileSync(sidecarPath, sidecarLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const sidecarSha256Before = sha256AtPath(sidecarPath);
    const sidecarBytesBefore = readFileSync(sidecarPath).length;
    const transcriptLinesBefore = countLinesAtPath(transcriptPath);
    console.error(`[capture H] sidecar written beside the transcript: ${sidecarBytesBefore} bytes, sha256=${sidecarSha256Before}`);

    // ---- run 2: resume + more turns -------------------------------------------------------------
    // Several append turns rather than one: the first pass drove `/compact` after a single turn and
    // the runtime refused it. More turns were an attempt to clear that threshold; they did NOT
    // (see the loopback comment above). What this probe therefore covers is session creation,
    // resume, six appending turns, and an ATTEMPTED compaction -- never a completed one. The turns
    // are kept because each one is another append the sidecar has to survive.
    const entries2: ConformanceTraceEntry[] = [];
    let r2: { thrown: unknown; deadlineHit: boolean } = { thrown: undefined, deadlineHit: false };
    const appendTurns = 6;
    bulkyReplies = true; // run 1's transcript is already created; the append turns are the bulky ones
    for (let turn = 0; turn < appendTurns; turn++) {
      const ac2 = new AbortController();
      const r = await drainWithDeadline(
        officialSdk.query({
          prompt: `hi from append turn ${turn + 1}`,
          options: { model: "sonnet", cwd: dirs.fixtureCwd, settingSources: [], resume: observedSessionId, abortController: ac2, env: hermeticEnv(dirs, server.url.href) },
        }),
        entries2,
        `capture H/run2.${turn + 1}`,
        120_000,
        ac2,
      );
      if (r.thrown !== undefined) r2 = { thrown: r.thrown, deadlineHit: r2.deadlineHit || r.deadlineHit };
      else r2 = { thrown: r2.thrown, deadlineHit: r2.deadlineHit || r.deadlineHit };
      if (r.thrown) console.error(`[capture H] append turn ${turn + 1} threw: ${r.thrown instanceof Error ? (r.thrown.stack ?? r.thrown.message) : String(r.thrown)}`);
    }
    const init2 = entries2.map((e) => e.payload as OfficialMessage).find((p) => p.type === "system" && p.subtype === "init");
    // Attribution: hash the sidecar again BEFORE the /compact run, so a change can be pinned to the
    // resume/append half or the compaction half rather than to "somewhere in the whole probe".
    // Review r1 Minor 1: hashed by PATH, never by a recursive name search. Searching by name would
    // have hashed a MOVED file and still reported "unchanged", which is exactly the failure mode this
    // assertion exists to catch. A file that is not at `sidecarPath` any more is a FAILED assertion,
    // reported as such -- `sha256AtPath` returns a sentinel instead of throwing.
    const sidecarSha256AfterResume = sha256AtPath(sidecarPath);
    const transcriptLinesAfterResume = countLinesAtPath(transcriptPath);
    console.error(`[capture H] after ${appendTurns} append turns: transcript ${transcriptLinesBefore} -> ${transcriptLinesAfterResume} lines; sidecar sha256=${sidecarSha256AfterResume}`);

    // ---- run 3: the /compact attempt (recorded as a limitation if it cannot be driven) ----------
    const entries3: ConformanceTraceEntry[] = [];
    const ac3 = new AbortController();
    const r3 = await drainWithDeadline(
      officialSdk.query({
        prompt: "/compact",
        options: { model: "sonnet", cwd: dirs.fixtureCwd, settingSources: [], resume: observedSessionId, abortController: ac3, env: hermeticEnv(dirs, server.url.href) },
      }),
      entries3,
      "capture H/run3",
      120_000,
      ac3,
    );
    const payloads3 = entries3.map((e) => e.payload as OfficialMessage);
    if (r3.thrown) console.error(`[capture H] run 3 (/compact) threw: ${r3.thrown instanceof Error ? (r3.thrown.stack ?? r3.thrown.message) : String(r3.thrown)}`);

    // ---- assertions -----------------------------------------------------------------------------
    const sidecarSha256After = sha256AtPath(sidecarPath);
    // Where the sidecar ended up if it is no longer at its own path -- reported alongside the FAILED
    // assertion so a move is diagnosable, never used to rescue the assertion itself.
    const sidecarFoundElsewhere = findFileRecursive(dirs.claudeConfigDir, (name) => name === `${observedSessionId}.provider-state.jsonl`)
      .map((f) => f.replace(dirs.claudeConfigDir, "<CLAUDE_CONFIG_DIR>"));
    const namesAfter = readdirSync(projectDir).sort();
    // Review r1 Minor 4: a renamed transcript used to throw here, past the verdict block, so the
    // probe would have crashed instead of reporting. Absence/unreadability is now a FAILED assertion.
    let transcriptParses = true;
    let transcriptLinesAfter = 0;
    try {
      for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        JSON.parse(line);
        transcriptLinesAfter++;
      }
    } catch {
      transcriptParses = false;
      transcriptLinesAfter = -1; // -1 = unreadable at its own path, distinct from an empty file
    }

    console.log(`\n--- Scenario H: WS-17 probe (a) verdicts (R6-7 / R6-7a) ---`);
    console.log(
      JSON.stringify(
        {
          sessionIdRequested: sessionId,
          sessionIdObservedOnInit: observedSessionId,
          "run 2 resumed the same session": init2?.session_id === observedSessionId,
          transcriptPath: transcriptPath.replace(dirs.claudeConfigDir, "<CLAUDE_CONFIG_DIR>"),
          sidecarPath: sidecarPath.replace(dirs.claudeConfigDir, "<CLAUDE_CONFIG_DIR>"),
          appendTurnsDriven: appendTurns,
          "ASSERTION 1 — sidecar sha256 unchanged": sidecarSha256Before === sidecarSha256After,
          "ASSERTION 1a — unchanged after the resume+append half alone": sidecarSha256Before === sidecarSha256AfterResume,
          sidecarSha256Before,
          sidecarSha256AfterResume,
          sidecarSha256After,
          transcriptLinesAfterResume,
          sidecarBytesBefore,
          sidecarBytesAfter: (() => {
            try {
              return readFileSync(sidecarPath).length;
            } catch {
              return null;
            }
          })(),
          "sidecar found elsewhere under <CLAUDE_CONFIG_DIR> (diagnostic only — never rescues the assertion)":
            sidecarFoundElsewhere.length === 1 && sidecarFoundElsewhere[0]?.endsWith(`${observedSessionId}.provider-state.jsonl`) && sidecarSha256After.startsWith("(") === false
              ? "(at its own path, as expected)"
              : sidecarFoundElsewhere,
          "ASSERTION 2 — marker absent from EVERY request body": !markerSeenInAnyRequestBody,
          "ASSERTION 3 — transcript still parses as JSONL": transcriptParses,
          transcriptLinesBefore,
          transcriptLinesAfter,
          "transcript grew across resume": transcriptLinesAfter > transcriptLinesBefore,
          "project dir file NAMES before the resume": namesBefore,
          "project dir file NAMES after the resume + compact": namesAfter,
          "names added": namesAfter.filter((n) => !namesBefore.includes(n)),
          "names removed": namesBefore.filter((n) => !namesAfter.includes(n)),
          "run 3 (/compact): message kinds": payloads3.map((p) => (p.type === "system" ? `system/${p.subtype}` : p.type)),
          "run 3 (/compact): a compact_boundary frame appeared": payloads3.some((p) => p.type === "system" && p.subtype === "compact_boundary"),
          "run 3 threw": describeThrown(r3.thrown) ?? false,
          "loopback saw": requestPaths,
          "deadlines hit (run1/run2/run3)": [r1.deadlineHit, r2.deadlineHit, r3.deadlineHit],
        },
        null,
        2,
      ),
    );
    console.log(`\n--- Scenario H: run 2 normalized trace ---`);
    console.log(JSON.stringify(normalizeTrace(entries2), null, 2));
    console.log(`\n--- Scenario H: run 3 (/compact) normalized trace ---`);
    console.log(JSON.stringify(normalizeTrace(entries3), null, 2));
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario I (capture 4): the failure shape ---------------------------------------------------
//
// Two runs: (i) NO ANTHROPIC_API_KEY in the child env at all (the other three vars kept), and
// (ii) an unknown model against a loopback answering 404 not_found_error. What is captured is the
// SHAPE — result subtype, is_error, the thrown error's class+name, whether an auth_status frame
// appears, whether the process exits — never prose beyond the identifiers.
//
// HERMETICITY CAVEAT, stated rather than assumed: HOME and CLAUDE_CONFIG_DIR do NOT redirect the
// macOS Keychain, and the pinned declaration has no knob that does. Run (i) may therefore find an
// ambient OAuth credential belonging to the real user. That is itself the finding if it happens —
// it is recorded, and the run is deadline-bounded so an interactive login prompt cannot wedge the
// harness. No credential value is ever read or printed; only `apiKeySource` (an enum) is reported.
async function runFailureShapeCapture(officialSdk: OfficialSdk, variant: "no-key" | "unknown-model"): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dirs = makeScenarioDirs(`i-${variant}`, cleanups);
    let requestCount = 0;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        console.error(`[loopback I/${variant}] #${requestCount} ${req.method} ${url.pathname}`);
        if (variant === "unknown-model") {
          return jsonResponse({ type: "error", error: { type: "not_found_error", message: "capture: synthetic unknown model" } }, 404);
        }
        return jsonResponse(CANNED_TEXT_RESPONSE);
      },
    });
    console.error(`\n=== Scenario I (${variant}): the failure shape ===`);
    console.error(`[capture I/${variant}] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${dirs.claudeConfigDir} HOME=${dirs.homeDir} (fresh mkdtemp)`);

    const fullEnv = hermeticEnv(dirs, server.url.href);
    const env: Record<string, string> = { ...fullEnv };
    if (variant === "no-key") {
      delete env.ANTHROPIC_API_KEY;
      console.error(`[capture I/no-key] the child env is EXACTLY ${JSON.stringify(Object.keys(env).sort())} — no API key of any kind`);
    }

    const entries: ConformanceTraceEntry[] = [];
    const ac = new AbortController();
    const q = officialSdk.query({
      prompt: "hi",
      options: {
        model: variant === "unknown-model" ? "definitely-not-a-model" : "sonnet",
        cwd: dirs.fixtureCwd,
        settingSources: [],
        abortController: ac,
        env,
      },
    });
    const { thrown, deadlineHit } = await drainWithDeadline(q, entries, `capture I/${variant}`, 90_000, ac);

    const payloads = entries.map((e) => e.payload as OfficialMessage);
    const init = payloads.find((p) => p.type === "system" && p.subtype === "init");
    const auth = payloads.filter((p) => p.type === "auth_status");
    const results = payloads.filter((p) => p.type === "result");

    console.error(`[capture I/${variant}] ${requestCount} loopback request(s); ${entries.length} message(s) yielded; deadlineHit=${deadlineHit}`);
    console.log(`\n--- Scenario I (${variant}) normalized trace ---`);
    console.log(JSON.stringify(normalizeTrace(entries), null, 2));
    console.log(`\n--- Scenario I (${variant}) verdicts ---`);
    console.log(
      JSON.stringify(
        {
          "messages yielded": entries.length,
          "loopback requests": requestCount,
          "system/init observed": init !== undefined,
          "init.apiKeySource": init?.apiKeySource ?? "(no init frame)",
          "init.model": init?.model ?? "(no init frame)",
          "auth_status frames": auth.length,
          "auth_status payloads": auth.length > 0 ? auth : "(none)",
          "result frames": results.map((r) => ({
            subtype: r.subtype,
            is_error: r.is_error,
            api_error_status: r.api_error_status,
            terminal_reason: r.terminal_reason,
            num_turns: r.num_turns,
            total_cost_usd: r.total_cost_usd,
            "result string length": typeof r.result === "string" ? r.result.length : null,
          })),
          "query() threw": describeThrown(thrown) ?? false,
          deadlineHit,
        },
        null,
        2,
      ),
    );
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario J (capture 5): supportedModels() / setModel() --------------------------------------
//
// Both are Query methods, so the query has to still be ALIVE when they are called: the loopback
// holds its first response behind a gate this scenario resolves only after both control calls have
// settled, otherwise a single-shot process is gone before the questions are asked. `setModel` is
// doc-marked streaming-input-only, so a throw here is a real captured fact, not a harness bug.
// Also recorded: whether ANY request reaches the loopback other than /v1/messages — `list_models` is
// a CONTROL subtype in the pin, not an HTTP path, so a /v1/models request would be a surprise.
async function runModelControlCapture(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dirs = makeScenarioDirs("j", cleanups);
    let requestCount = 0;
    const requestPaths: string[] = [];
    const modelsAsked: unknown[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateTimer = setTimeout(() => releaseGate(), 60_000); // never let the gate wedge the run
    cleanups.push(() => clearTimeout(gateTimer));
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        const url = new URL(req.url);
        requestPaths.push(`${req.method} ${url.pathname}`);
        try {
          modelsAsked.push((await req.json() as { model?: unknown }).model);
        } catch {
          modelsAsked.push(null); // the HEAD preflight has no body
        }
        console.error(`[loopback J] #${requestCount} ${req.method} ${url.pathname} model=${JSON.stringify(modelsAsked[modelsAsked.length - 1])} (holding behind the control-call gate)`);
        await gate;
        return jsonResponse(CANNED_TEXT_RESPONSE);
      },
    });
    console.error(`\n=== Scenario J: supportedModels() / setModel() ===`);
    console.error(`[capture J] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${dirs.claudeConfigDir} HOME=${dirs.homeDir} (fresh mkdtemp)`);

    const entries: ConformanceTraceEntry[] = [];
    const ac = new AbortController();
    const q = officialSdk.query({
      prompt: "hi",
      options: { model: "sonnet", cwd: dirs.fixtureCwd, settingSources: [], abortController: ac, env: hermeticEnv(dirs, server.url.href) },
    }) as unknown as OfficialQueryHandle;

    const drained = drainWithDeadline(q, entries, "capture J", 120_000, ac);

    const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          p,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`capture J: control call timed out after ${ms}ms`)), ms);
          }),
        ]);
        return { ok: true, value };
      } catch (e) {
        return { ok: false, error: e };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const modelsResult = typeof q.supportedModels === "function" ? await withTimeout(q.supportedModels(), 45_000) : ({ ok: false, error: new Error("supportedModels is not a function on the returned query") } as const);
    const setModelResult = typeof q.setModel === "function" ? await withTimeout(q.setModel("haiku"), 45_000) : ({ ok: false, error: new Error("setModel is not a function on the returned query") } as const);
    const accountResult = typeof q.accountInfo === "function" ? await withTimeout(q.accountInfo(), 45_000) : ({ ok: false, error: new Error("accountInfo is not a function on the returned query") } as const);

    releaseGate();
    const { thrown, deadlineHit } = await drained;

    const models = modelsResult.ok ? (modelsResult.value as unknown[]) : [];
    console.error(`[capture J] ${requestCount} loopback request(s); ${entries.length} message(s) yielded; deadlineHit=${deadlineHit}`);
    if (thrown) console.error(`[capture J] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    console.log(`\n--- Scenario J: supportedModels() return shape ---`);
    console.log(
      JSON.stringify(
        modelsResult.ok
          ? {
              isArray: Array.isArray(models),
              count: Array.isArray(models) ? models.length : null,
              "union of row key names": Array.isArray(models) ? [...new Set(models.flatMap((m) => Object.keys(m as Record<string, unknown>)))].sort() : null,
              // SHAPE ONLY, per scenario D's own rule: `displayName` and `description` are
              // vendor-authored prose, so their LENGTHS are reported, never their text.
              "every row, prose stripped": Array.isArray(models)
                ? models.map((m) => {
                    const row = m as Record<string, unknown>;
                    return {
                      ...row,
                      displayName: typeof row.displayName === "string" ? `<${row.displayName.length} chars>` : row.displayName,
                      description: typeof row.description === "string" ? `<${row.description.length} chars>` : row.description,
                    };
                  })
                : null,
            }
          : { threw: describeThrown(modelsResult.error) },
        null,
        2,
      ),
    );
    console.log(`\n--- Scenario J: setModel("haiku") outcome ---`);
    console.log(JSON.stringify(setModelResult.ok ? { resolved: true, value: setModelResult.value } : { threw: describeThrown(setModelResult.error) }, null, 2));
    console.log(`\n--- Scenario J: accountInfo() outcome (item (d) — the account surface a query() stream never carries) ---`);
    console.log(
      JSON.stringify(
        accountResult.ok
          ? { resolved: true, "key names present": Object.keys((accountResult.value ?? {}) as Record<string, unknown>).sort() }
          : { threw: describeThrown(accountResult.error) },
        null,
        2,
      ),
    );
    console.log(`\n--- Scenario J verdicts ---`);
    console.log(
      JSON.stringify(
        {
          "every request path the loopback saw": requestPaths,
          "the model on each request (did setModel take effect on the wire?)": modelsAsked,
          "did any /v1/models request reach the loopback?": requestPaths.some((p) => p.includes("/models")),
          "system/init.model": (entries.map((e) => e.payload as OfficialMessage).find((p) => p.type === "system" && p.subtype === "init"))?.model ?? "(no init frame)",
          "query() threw": describeThrown(thrown) ?? false,
          deadlineHit,
        },
        null,
        2,
      ),
    );
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

// --- Scenario K (capture 6): total_cost_usd / modelUsage / costBasis for a fake model -------------
//
// A plain-query shape whose canned response reports a model id nothing could have a price row for.
// The findings: which string KEYS modelUsage (the option alias, a resolved id, or the response's own
// `model`), what costBasis reads (item (e) predicts 'unknown'), what costUSD/total_cost_usd become,
// and the actual key set of `usage` — which is the only way to learn NonNullableUsage's field names,
// since the type maps over an unpinned external one.
async function runCostCapture(officialSdk: OfficialSdk): Promise<void> {
  const cleanups: Array<() => void> = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  const fakeModel = "winter-capture-fake-model-1";
  try {
    const dirs = makeScenarioDirs("k", cleanups);
    let requestCount = 0;
    const modelsAsked: unknown[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        requestCount++;
        let body: unknown = {};
        try {
          body = await req.json();
        } catch {
          /* non-JSON */
        }
        modelsAsked.push((body as { model?: unknown }).model);
        const url = new URL(req.url);
        console.error(`[loopback K] #${requestCount} ${req.method} ${url.pathname} model=${JSON.stringify((body as { model?: unknown }).model)}`);
        return jsonResponse({
          id: "msg_capture_cost_01",
          type: "message",
          role: "assistant",
          model: fakeModel,
          content: [{ type: "text", text: "echo: cost" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 17, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
        });
      },
    });
    console.error(`\n=== Scenario K: total_cost_usd / modelUsage / costBasis for a fake model id ===`);
    console.error(`[capture K] loopback ${server.url.href}; CLAUDE_CONFIG_DIR=${dirs.claudeConfigDir} HOME=${dirs.homeDir} (fresh mkdtemp)`);

    const entries: ConformanceTraceEntry[] = [];
    const ac = new AbortController();
    const q = officialSdk.query({
      prompt: "hi",
      options: { model: fakeModel, cwd: dirs.fixtureCwd, settingSources: [], abortController: ac, env: hermeticEnv(dirs, server.url.href) },
    });
    const { thrown, deadlineHit } = await drainWithDeadline(q, entries, "capture K", 90_000, ac);

    const payloads = entries.map((e) => e.payload as OfficialMessage);
    const result = payloads.find((p) => p.type === "result");
    const modelUsage = (result?.modelUsage ?? {}) as Record<string, Record<string, unknown>>;

    console.error(`[capture K] ${requestCount} loopback request(s); ${entries.length} message(s) yielded; deadlineHit=${deadlineHit}`);
    if (thrown) console.error(`[capture K] query() threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);

    console.log(`\n--- Scenario K normalized trace ---`);
    console.log(JSON.stringify(normalizeTrace(entries), null, 2));
    console.log(`\n--- Scenario K verdicts ---`);
    console.log(
      JSON.stringify(
        {
          "option model / response model / models the loopback was asked for": { option: fakeModel, response: fakeModel, requested: modelsAsked },
          "system/init.model": payloads.find((p) => p.type === "system" && p.subtype === "init")?.model ?? "(no init frame)",
          "result subtype / is_error": { subtype: result?.subtype, is_error: result?.is_error },
          total_cost_usd: result?.total_cost_usd,
          "modelUsage KEYS": Object.keys(modelUsage),
          "modelUsage rows": modelUsage,
          "costBasis per row": Object.fromEntries(Object.entries(modelUsage).map(([k, v]) => [k, v.costBasis ?? "(absent)"])),
          "usage (NonNullableUsage) key names — the only pinned way to learn them": Object.keys((result?.usage ?? {}) as Record<string, unknown>).sort(),
          usage: result?.usage,
          "query() threw": describeThrown(thrown) ?? false,
          deadlineHit,
        },
        null,
        2,
      ),
    );
  } finally {
    server?.stop(true);
    for (const cleanup of cleanups) cleanup();
  }
}

export async function runCapture(): Promise<void> {
  // Scenario filter: RUN_OFFICIAL_CAPTURE_ONLY=F,H runs only those. Empty/unset runs everything.
  // The ephemeral install happens once either way; this only skips the scenarios themselves, so an
  // iteration on one scenario does not re-run the other nine.
  const only = (process.env.RUN_OFFICIAL_CAPTURE_ONLY ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  const want = (letter: string): boolean => only.length === 0 || only.includes(letter);

  const cleanups: Array<() => void> = [];
  try {
    const officialSdk = await installOfficialSdk(cleanups);
    if (want("A")) await runPlainQueryCapture(officialSdk);
    if (want("B")) await runPermissionsAndHooksCapture(officialSdk);
    if (want("C")) await runInitToolsCapture(officialSdk);
    // Phase 4 Task 8 (rider 8): the P4 capture-pending cells.
    if (want("D")) await runAdvertisedSchemaCapture(officialSdk);
    if (want("E")) {
      await runMcpOutputCapCapture(officialSdk, undefined);
      await runMcpOutputCapCapture(officialSdk, "100");
    }
    // Phase 6 Task 1 (WS-13): see the block header above for why these are F-K, not D-H.
    if (want("F")) {
      await runStreamEventCapture(officialSdk, true);
      await runStreamEventCapture(officialSdk, false);
    }
    if (want("G")) {
      await runRetryCapture(officialSdk, "overloaded-then-ok");
      await runRetryCapture(officialSdk, "ratelimit-then-ok");
      await runRetryCapture(officialSdk, "persistent-overloaded");
    }
    if (want("H")) await runNeighborFileProbe(officialSdk);
    if (want("I")) {
      await runFailureShapeCapture(officialSdk, "no-key");
      await runFailureShapeCapture(officialSdk, "unknown-model");
    }
    if (want("J")) await runModelControlCapture(officialSdk);
    if (want("K")) await runCostCapture(officialSdk);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

// No `if (import.meta.main)` CLI entry here on purpose: this module is a pure library now (P7a Lane
// C). The RUN_OFFICIAL_CAPTURE=1 gate and the CLI entry point live in the thin caller
// `scripts/capture-official-golden.ts`, which imports `runCapture` from here.
