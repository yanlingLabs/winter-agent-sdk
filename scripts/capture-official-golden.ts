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
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetchAndVerifyUpstream } from "./fetch-upstream.ts";
import { normalizeTrace, type ConformanceTraceEntry } from "winter-conformance/trace";

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

async function runCapture(): Promise<void> {
  const cleanups: Array<() => void> = [];
  try {
    const officialSdk = await installOfficialSdk(cleanups);
    await runPlainQueryCapture(officialSdk);
    await runPermissionsAndHooksCapture(officialSdk);
    await runInitToolsCapture(officialSdk);
    // Phase 4 Task 8 (rider 8): the P4 capture-pending cells.
    await runAdvertisedSchemaCapture(officialSdk);
    await runMcpOutputCapCapture(officialSdk, undefined);
    await runMcpOutputCapCapture(officialSdk, "100");
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

if (import.meta.main) {
  if (process.env.RUN_OFFICIAL_CAPTURE !== "1") {
    console.log("capture-official-golden: skipped (set RUN_OFFICIAL_CAPTURE=1 to run — ephemeral, network-using, not part of default CI)");
    process.exit(0);
  }
  await runCapture();
}
