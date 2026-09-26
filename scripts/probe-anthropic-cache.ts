// WS-23: the LIVE probe for prompt caching on Winter's Anthropic path. Run by a human (the
// controller), never by a test and never by CI.
//
// WHAT IT CONFIRMS that the hermetic suite (`messages-cache.test.ts`, `prefix-stability.test.ts`, the
// engine's own cache tests) can only assume, because only the real API can say it:
//   1. an effort switch before turn 3 rides a per-message `system` marker and `cache_read_input_tokens`
//      SURVIVES it (the top-level `output_config.effort` never moves);
//   2. the beta `mid-conversation-output-config-2026-07-01` is accepted on the account (a 400 would show
//      as the engine's one-line fallback notice, then a top-level change);
//   3. a ToolSearch load mid-session leaves `tools` untouched (the deferred tool is declared up front
//      with `defer_loading` and surfaced by a `tool_reference`), so the next request still reads cache;
//   4. `/compact` REUSES the session's own prefix: the summary request reads from cache;
//   5. what `diagnostics.cache_miss_reason` and `input_transformations` actually say at each step;
//   6. (WS-23 midconv) mid-conversation TOOL CHANGES keep the cache: a late tool by value and by
//      reference (a `defer_loading` declaration appended to `tools`), a redefinition under the same name,
//      a removal (of a tool only ever defined by value -- the docs are silent), each beta alone;
//   7. (WS-23 midconv) per-message effort on claude-opus-5 (documented; claude only enables it on
//      opus-5-5 and fable-5-1).
// Anthropic has NO way to restrict the callable set without editing `tools` except `tool_removal`
// (the mid-conversation page lists no allowed-tools control), so there is no allowed-tools step here.
//
// IT DRIVES THE SHIPPED ENGINE AND ADAPTER, not a hand-built request: `runEngine` over
// `buildSessionProvider`'s real catalog-resolved Anthropic provider, the real system-prompt assembler,
// the real compaction controller and the real ToolSearch. A `fetch` observer prints, per request, the
// request's SHAPE and the response's `message_start` usage and cache verdict.
//
// DIAGNOSTICS: every main-loop request carries `diagnostics` (`null` on the first and right after the
// compaction); only the /compact summary request (an auxiliary call, by design) shows "not sent".
//
// NOTHING SECRET IS EVER PRINTED. The key is read from the macOS Keychain -- the brand's DEV service
// (`DEFAULT_KEYCHAIN_SERVICE` + `.dev`), account `anthropic:default` -- READ ONLY, through the runtime's
// own Keychain store (the one file allowed to reach the secrets API), pinned to the dev service by a
// read-only wrapper, and never touched as a string here. Output is counts, token numbers, field
// names, beta names, stop reasons and miss types. Never model text.
//
// COST: about eighteen requests -- eight (effort) + four + four (tools-inline, tools-reference) on
// claude-opus-5-5 and two on claude-opus-5, with Winter's own tool list and system prompt (tens of
// thousands of input tokens each, most of them cache reads after the first of each phase). Pick phases
// with WINTER_ANTHROPIC_CACHE_PROBE_PHASES=effort,tools-inline,tools-reference,opus5-effort.
//
// Usage (from the worktree root):
//   WINTER_ANTHROPIC_CACHE_PROBE=1 bun run scripts/probe-anthropic-cache.ts
// Without `WINTER_ANTHROPIC_CACHE_PROBE=1` it prints one line and exits 0, so a stray `bun run` costs
// nothing. The first Keychain read may raise a macOS consent prompt for `bun`; "Allow" once is enough.
//
// DRY RUN (free, no Keychain, no network): `WINTER_ANTHROPIC_CACHE_PROBE=1 WINTER_ANTHROPIC_CACHE_PROBE_DRY_RUN=1`
// answers every request from a canned in-process responder with a fake key, so the probe's own plumbing
// -- the engine, the adapter's request shapes, the observer -- can be checked before spending anything.
// Its usage numbers are fabricated and mean nothing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "../packages/sdk/src/index.ts";
import { loadCatalog, type WinterCatalog } from "../packages/provider-catalog/src/index.ts";
import type { CredentialMaterial, CredentialRef, CredentialStore } from "../packages/provider-runtime/src/types.ts";
import { DEFAULT_KEYCHAIN_SERVICE, createKeychainCredentialStore } from "../packages/runtime/src/provider/keychain-store.ts";
import { buildSessionProvider } from "../packages/runtime/src/provider/session-provider.ts";
import { createInMemoryChannel } from "../packages/runtime/src/protocol/channel.ts";
import { runEngine, type EngineOptions } from "../packages/runtime/src/engine.ts";
import { createSystemPromptAssembler } from "../packages/runtime/src/context/assembler.ts";
import { createCompactionController } from "../packages/runtime/src/compaction/controller.ts";
import { describeCatalogModel } from "../packages/runtime/src/production-wiring.ts";
import { registerMcpServerTools, replaceExecutor, unregisterMcpServerTools } from "../packages/runtime/src/tools/registry.ts";
import { createFakeMcpServerStateSource } from "../packages/runtime/src/mcp/state.ts";

const MODEL = "anthropic/claude-opus-5-5";
/** The dev profile's Keychain service -- where the Winter dev daemon stores `anthropic:default`. Read, never written. */
const KEYCHAIN_SERVICE = `${DEFAULT_KEYCHAIN_SERVICE}.dev`;
const PROBE_SERVER = "wsprobe";
const PROBE_TOOL = `mcp__${PROBE_SERVER}__lookup_weather`;

if (process.env["WINTER_ANTHROPIC_CACHE_PROBE"] !== "1") {
  console.log("probe-anthropic-cache: set WINTER_ANTHROPIC_CACHE_PROBE=1 to run (it calls the PAID Anthropic API with the dev Keychain's anthropic:default key)");
  process.exit(0);
}

const DRY_RUN = process.env["WINTER_ANTHROPIC_CACHE_PROBE_DRY_RUN"] === "1";

// --- the dev-pinned, read-only credential store --------------------------------------------------------

const devKeychain = createKeychainCredentialStore(KEYCHAIN_SERVICE);
const credentials: CredentialStore = {
  async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
    // Only a KEYCHAIN ref resolves, in the dry run too: a session that names no credential (the live gate
    // found one -- `authRef` absent defaults to `{kind: "none"}`) must fail here exactly as it fails live.
    if (ref.kind !== "keychain") return null;
    if (DRY_RUN) return { kind: "api-key", key: "dry-run-not-a-key" };
    // Every keychain ref resolves against the DEV service, whatever service the session names.
    return await devKeychain.get({ ...ref, service: KEYCHAIN_SERVICE });
  },
  async set(): Promise<void> {
    throw new Error("probe-anthropic-cache: the credential store is read-only");
  },
  async delete(): Promise<void> {
    throw new Error("probe-anthropic-cache: the credential store is read-only");
  },
};

// --- the wire observer: request SHAPE and the response's message_start, nothing else ------------------

interface Observed {
  label: string;
  status: number;
  sent: string;
  usage?: string;
  verdict?: string;
  /** A non-2xx response's body, truncated -- the API's own error text (never a credential: the API does not echo keys). */
  error?: string;
}
const observed: Observed[] = [];
let currentLabel = "setup";

function describeRequest(body: unknown, betas: string): string {
  if (typeof body !== "string") return "(no body)";
  try {
    const b = JSON.parse(body) as Record<string, unknown>;
    const tools = Array.isArray(b["tools"]) ? (b["tools"] as Array<Record<string, unknown>>) : [];
    const messages = Array.isArray(b["messages"]) ? (b["messages"] as Array<Record<string, unknown>>) : [];
    const system = Array.isArray(b["system"]) ? (b["system"] as Array<Record<string, unknown>>) : [];
    const markers = messages.filter((m) => m["role"] === "system" && m["output_config"] !== undefined).map((m) => JSON.stringify(m["output_config"]));
    const breakpoints = JSON.stringify(b).split('"cache_control"').length - 1;
    const references = JSON.stringify(messages).split('"tool_reference"').length - 1;
    // WS-23 midconv: the tool-change messages this request carries (by value / by reference / removals).
    const changeBlocks = messages.filter((m) => m["role"] === "system" && Array.isArray(m["content"])).flatMap((m) => m["content"] as Array<Record<string, unknown>>);
    const byValue = changeBlocks.filter((c) => c["type"] === "tool_addition" && (c["tool"] as Record<string, unknown>)["type"] === "tool_definition").length;
    const byReference = changeBlocks.filter((c) => c["type"] === "tool_addition" && (c["tool"] as Record<string, unknown>)["type"] === "tool_reference").length;
    const removals = changeBlocks.filter((c) => c["type"] === "tool_removal").length;
    const toolNames = tools.map((t) => String(t["name"]));
    return [
      `tools=${tools.length} deferred=${tools.filter((t) => t["defer_loading"] === true).length}`,
      `system_blocks=${system.length} ttl=${JSON.stringify(system.map((s) => (s["cache_control"] as Record<string, unknown> | undefined)?.["ttl"] ?? "5m"))}`,
      `messages=${messages.length} effort_markers=${JSON.stringify(markers)} tool_references=${references}`,
      `tool_changes: added_by_value=${byValue} added_by_reference=${byReference} removed=${removals} tools_tail=${JSON.stringify(toolNames.slice(-2))}`,
      `output_config=${JSON.stringify(b["output_config"] ?? null)} thinking=${JSON.stringify((b["thinking"] as Record<string, unknown> | undefined)?.["type"] ?? null)}`,
      `breakpoints=${breakpoints} diagnostics=${b["diagnostics"] === undefined ? "not sent" : JSON.stringify(b["diagnostics"])}`,
      `betas=${betas}`,
    ].join(" | ");
  } catch {
    return "(unparseable body)";
  }
}

function describeStart(message: Record<string, unknown>): { usage: string; verdict: string } {
  const usage = (message["usage"] ?? {}) as Record<string, unknown>;
  const creation = (usage["cache_creation"] ?? {}) as Record<string, unknown>;
  const numbers = {
    input: usage["input_tokens"],
    cache_read: usage["cache_read_input_tokens"],
    cache_creation: usage["cache_creation_input_tokens"],
    creation_5m: creation["ephemeral_5m_input_tokens"],
    creation_1h: creation["ephemeral_1h_input_tokens"],
  };
  const diagnostics = message["diagnostics"];
  const reason = diagnostics !== null && typeof diagnostics === "object" ? (diagnostics as Record<string, unknown>)["cache_miss_reason"] : undefined;
  const transformations = Array.isArray(message["input_transformations"]) ? (message["input_transformations"] as Array<Record<string, unknown>>) : undefined;
  return {
    usage: JSON.stringify(numbers),
    verdict: [
      `diagnostics=${diagnostics === undefined ? "absent" : diagnostics === null ? "null (no divergence / nothing to compare)" : JSON.stringify(reason === null ? { cache_miss_reason: null } : { type: (reason as Record<string, unknown>)?.["type"], cache_missed_input_tokens: (reason as Record<string, unknown>)?.["cache_missed_input_tokens"] })}`,
      `input_transformations=${transformations === undefined ? "absent" : JSON.stringify(transformations.map((t) => `${String(t["type"])}:${String(t["reason"])}`))}`,
    ].join(" | "),
  };
}

/**
 * The dry run's canned Messages endpoint: ToolSearch, then the probe tool, then text for the ToolSearch
 * turn; text for everything else. Fabricated usage, flagged as such.
 */
function cannedResponse(body: unknown, headers: Headers): Response {
  // The real API's answer to a request carrying no credential, so the dry run catches a session that
  // names none (the live gate's 401s) before anything is spent.
  if (headers.get("x-api-key") === null && headers.get("authorization") === null) {
    return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "x-api-key header is required" } }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const request = JSON.parse(typeof body === "string" ? body : "{}") as { messages?: Array<{ role: string; content: unknown }> };
  const messages = request.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = JSON.stringify(lastUser?.content ?? "");
  const toolUseIds = JSON.stringify(messages).match(/"tool_use_id":"([^"]+)"/g) ?? [];
  let block: Record<string, unknown> = { type: "text", text: "ok" };
  let stop = "end_turn";
  if (lastText.includes("ToolSearch") && toolUseIds.length === 0) {
    block = { type: "tool_use", id: "toolu_dry_search", name: "ToolSearch", input: { query: `select:${PROBE_TOOL}` } };
    stop = "tool_use";
  } else if (lastText.includes("toolu_dry_search") && !lastText.includes("toolu_dry_weather")) {
    block = { type: "tool_use", id: "toolu_dry_weather", name: PROBE_TOOL, input: { city: "Paris" } };
    stop = "tool_use";
  }
  const events: Array<Record<string, unknown>> = [
    { type: "message_start", message: { id: `msg_dry_${observed.length}`, model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, diagnostics: null } },
    { type: "content_block_start", index: 0, content_block: block["type"] === "text" ? { type: "text", text: "" } : { ...block, input: {} } },
    block["type"] === "text" ? { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } : { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block["input"]) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const requestHeaders = new Headers(init?.headers);
  const response = DRY_RUN && url.includes("/v1/messages") ? cannedResponse(init?.body, requestHeaders) : await originalFetch(input, init);
  if (!url.includes("/v1/messages")) return response;
  const headers = requestHeaders;
  const record: Observed = { label: currentLabel, status: response.status, sent: describeRequest(init?.body, headers.get("anthropic-beta") ?? "(none)") };
  observed.push(record);
  if (!response.ok) {
    // The error BODY, truncated: a 400 names the rule the request broke, which is the whole point of a probe.
    const text = await response.clone().text().catch(() => "(unreadable body)");
    record.error = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    return response;
  }
  if (response.body === null) return response;
  // Tee the stream: the adapter reads one branch, this observer reads message_start off the other.
  const [forAdapter, forObserver] = response.body.tee();
  void (async () => {
    const reader = forObserver.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        try {
          const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
          if (payload["type"] === "message_start") Object.assign(record, describeStart((payload["message"] ?? {}) as Record<string, unknown>));
        } catch {
          /* not JSON: nothing to record */
        }
      }
    }
  })();
  return new Response(forAdapter, { status: response.status, statusText: response.statusText, headers: response.headers });
}) as typeof fetch;

// --- the sessions --------------------------------------------------------------------------------------
//
// PHASES (WINTER_ANTHROPIC_CACHE_PROBE_PHASES, comma-separated; default: all), each its own session:
//   effort          -- the original eight requests on claude-opus-5-5 (per-message effort, ToolSearch, /compact);
//   tools-inline    -- WS-23 midconv on claude-opus-5-5 as shipped (inline-tools-2026-09-15): a late MCP tool
//                      added BY VALUE, then REDEFINED (a new description under the same name), then REMOVED
//                      (a removal of a tool that was only ever defined by value -- undocumented, hence here);
//   tools-reference -- the same steps with the row patched to the reference beta only
//                      (mid-conversation-tool-changes-2026-07-01): the late tool is declared `defer_loading`
//                      AFTER the frozen list and added by reference (does appending a deferred tool keep the
//                      cache?), the redefinition restarts the epoch (an expected, logged miss), then removal;
//   opus5-effort    -- per-message effort on claude-opus-5 (the effort page lists it; claude enables it only
//                      for opus-5-5 / fable-5-1).
// READ each request's `cache_read` against the previous one's: it should hold (or grow) across every tool
// change except the reference phase's redefinition, and `diagnostics` should say no divergence.

const PHASES = new Set((process.env["WINTER_ANTHROPIC_CACHE_PROBE_PHASES"] ?? "effort,tools-inline,tools-reference,opus5-effort").split(",").map((p) => p.trim()));
const LATE_SERVER = "wsprobelate";
const LATE_TOOL = `mcp__${LATE_SERVER}__lookup_city`;
const lateTool = (description: string) => [{ name: "lookup_city", description, inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];

type ProbeStep = { turn: string; label: string } | { effort: string } | { act: () => void; note: string };

async function runSession(phase: string, model: string, patch: (row: WinterCatalog["models"][number]) => WinterCatalog["models"][number], steps: ProbeStep[], opts: { compaction?: boolean } = {}): Promise<void> {
  const compiled = loadCatalog();
  const catalog: WinterCatalog = { ...compiled, models: compiled.models.map((m) => (m.key === model ? patch(m) : m)) };
  const home = mkdtempSync(join(tmpdir(), "winter-cache-probe-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-cache-probe-cwd-"));
  try {
    const config: RuntimeConfig = {
      sessionId: `ws23-cache-probe-${phase}-${Date.now()}`,
      cwd,
      model,
      effort: "high",
      winterHome: home,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolSearchEnabled: true,
      capabilities: ["winter.mcp"],
      // THE CREDENTIAL (live-gate fix): without `provider.authRef` the session defaults to `{kind: "none"}`
      // and every request is a 401. The dev Keychain's `anthropic:default`, read through the read-only store above.
      provider: { providerId: "anthropic", authRef: { kind: "keychain", account: "anthropic:default", service: KEYCHAIN_SERVICE } },
    };
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials });
    const identity = wiring.identity;
    if (identity === undefined) throw new Error(`probe-anthropic-cache: ${model} did not resolve`);
    const { host, runtime } = createInMemoryChannel();
    const frames: WinterFrame[] = [];
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: String(wiring.resolved!.adapter.family), ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
      describeModel: (m: string, providerId?: string) => describeCatalogModel(catalog, m, providerId),
      systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
      ...(opts.compaction === true ? { compactionController: createCompactionController({ retainedPairs: 1 }) } : {}),
      mcpServerStateSource: createFakeMcpServerStateSource([
        { name: PROBE_SERVER, state: "connected", toolNames: [] },
        { name: LATE_SERVER, state: "connected", toolNames: [] },
      ]),
      providerSupportsToolSearch: true,
      deferrableContextShare: 100,
    } as EngineOptions);
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    const results = (): Array<Record<string, unknown>> =>
      frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
    for (const step of steps) {
      if ("act" in step) {
        step.act();
        console.log(`\n[${phase}] ${step.note}`);
        continue;
      }
      if ("effort" in step) {
        const id = `effort-${step.effort}-${Date.now()}`;
        host.output.write({ type: "control_request", requestId: id, subtype: "set_effort", payload: { effort: step.effort } });
        for (let n = 0; n < 200 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === id); n++) await new Promise((r) => setTimeout(r, 10));
        const ack = frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === id) as { ok?: boolean } | undefined;
        console.log(`\n[${phase}] set_effort ${step.effort} acknowledged ok=${String(ack?.ok)}`);
        continue;
      }
      currentLabel = `${phase}: ${step.label}`;
      const before = results().length;
      host.output.write({ type: "user", text: step.turn });
      for (let n = 0; n < 6000 && results().length <= before; n++) await new Promise((r) => setTimeout(r, 50));
      const result = results()[before];
      const usage = result?.["usage"] as Record<string, unknown> | undefined;
      console.log(`\n[${currentLabel}] result: is_error=${String(result?.["is_error"])} cache_read=${String(usage?.["cache_read_input_tokens"])} cache_creation=${String(usage?.["cache_creation_input_tokens"])} cache_misses=${JSON.stringify(usage?.["cache_misses"] ?? null)}`);
    }
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

registerMcpServerTools(PROBE_SERVER, [{ name: "lookup_weather", description: "Look up today's weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }], { deferredDefault: true });
replaceExecutor(PROBE_TOOL, { async execute() { return { output: "sunny" }; } });
const addLate = (description: string) => (): void => {
  registerMcpServerTools(LATE_SERVER, lateTool(description), { deferredDefault: false });
  replaceExecutor(LATE_TOOL, { async execute() { return { output: "found" }; } });
};
const toolSteps: ProbeStep[] = [
  { turn: "Reply with the single word: one.", label: "turn 1 (frozen list)" },
  { act: addLate("Look up a city's country."), note: `a late MCP tool ${LATE_TOOL} connects` },
  { turn: "Reply with the single word: two.", label: "turn 2 (late tool)" },
  { act: addLate("Look up a city's country and population."), note: `${LATE_TOOL} is REDEFINED (new description)` },
  { turn: "Reply with the single word: three.", label: "turn 3 (redefinition)" },
  { act: () => unregisterMcpServerTools(LATE_SERVER), note: `${LATE_TOOL}'s server goes away` },
  { turn: "Reply with the single word: four.", label: "turn 4 (removal)" },
];

try {
  if (PHASES.has("effort")) {
    await runSession(
      "effort",
      MODEL,
      (row) => row,
      [
        { turn: "Reply with the single word: one.", label: "turn 1 (high)" },
        { turn: "Reply with the single word: two.", label: "turn 2 (high)" },
        { effort: "low" },
        { turn: "Reply with the single word: three.", label: "turn 3 (low, per-message marker)" },
        { turn: `Use the ToolSearch tool with the query "select:${PROBE_TOOL}", then call ${PROBE_TOOL} for Paris, then reply with its answer as one word.`, label: "turn 4 (ToolSearch load)" },
        { turn: "/compact", label: "turn 5 (/compact)" },
        { turn: "Reply with the single word: six.", label: "turn 6 (after compaction)" },
      ],
      { compaction: true },
    );
  }
  if (PHASES.has("tools-inline")) await runSession("tools-inline", MODEL, (row) => row, toolSteps);
  if (PHASES.has("tools-reference")) {
    await runSession("tools-reference", MODEL, (row) => {
      const { inlineToolDefinitions: _inline, ...rest } = row;
      return rest;
    }, toolSteps);
  }
  if (PHASES.has("opus5-effort")) {
    await runSession("opus5-effort", "anthropic/claude-opus-5", (row) => row, [
      { turn: "Reply with the single word: one.", label: "turn 1 (high)" },
      { effort: "low" },
      { turn: "Reply with the single word: two.", label: "turn 2 (low, per-message marker)" },
    ]);
  }

  console.log("\n=== per request (request shape, then the response's message_start) ===");
  observed.forEach((o, i) => {
    console.log(`\n#${i + 1} [${o.label}] HTTP ${o.status}\n  sent:    ${o.sent}\n  usage:   ${o.usage ?? "(no message_start)"}\n  verdict: ${o.verdict ?? "(none)"}${o.error !== undefined ? `\n  error:   ${o.error}` : ""}`);
  });
  console.log("\nREAD IT AS: effort -- turn 3's cache_read should stay close to turn 2's (the effort switch kept the prefix); turn 4's follow-up requests keep `tools` identical and read cache; the /compact summary request reads the conversation from cache. tools-* -- every request's `tools` is identical within the phase (except reference turn 3, a new epoch), each change shows as a `tool_changes` count, and cache_read keeps growing; a 400 prints its error body. opus5-effort -- the marker is accepted (or the one fallback notice appears).");
} finally {
  unregisterMcpServerTools(PROBE_SERVER);
  unregisterMcpServerTools(LATE_SERVER);
  globalThis.fetch = originalFetch;
}
