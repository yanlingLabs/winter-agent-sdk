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
//   5. what `diagnostics.cache_miss_reason` and `input_transformations` actually say at each step.
//
// IT DRIVES THE SHIPPED ENGINE AND ADAPTER, not a hand-built request: `runEngine` over
// `buildSessionProvider`'s real catalog-resolved Anthropic provider, the real system-prompt assembler,
// the real compaction controller and the real ToolSearch. A `fetch` observer prints, per request, the
// request's SHAPE and the response's `message_start` usage and cache verdict.
//
// PREREQUISITE for step 5 and the per-request diagnostics: the cross-lane `bridge.ts` pass-through
// (TurnRequest.cacheDiagnostics / cacheTtl / cacheKey; ProviderTurn.responseId; the usage fields) must
// be applied. Without it NO request carries `diagnostics` ("not sent" on every line). With it, every
// main-loop request does -- `null` on the first and right after the compaction -- and only the /compact
// summary request (an auxiliary call, by design) shows "not sent".
//
// NOTHING SECRET IS EVER PRINTED. The key is read from the macOS Keychain -- the brand's DEV service
// (`DEFAULT_KEYCHAIN_SERVICE` + `.dev`), account `anthropic:default` -- READ ONLY, through the runtime's
// own Keychain store (the one file allowed to reach the secrets API), pinned to the dev service by a
// read-only wrapper, and never touched as a string here. Output is counts, token numbers, field
// names, beta names, stop reasons and miss types. Never model text.
//
// COST: about eight requests on claude-opus-5-5 at effort high/low with Winter's own tool list and
// system prompt (tens of thousands of input tokens, most of them cache reads after the first).
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
import { loadCatalog } from "../packages/provider-catalog/src/index.ts";
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
    if (DRY_RUN) return { kind: "api-key", key: "dry-run-not-a-key" };
    // Every keychain ref resolves against the DEV service, whatever service the session names.
    return ref.kind === "keychain" ? await devKeychain.get({ ...ref, service: KEYCHAIN_SERVICE }) : null;
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
    return [
      `tools=${tools.length} deferred=${tools.filter((t) => t["defer_loading"] === true).length}`,
      `system_blocks=${system.length} ttl=${JSON.stringify(system.map((s) => (s["cache_control"] as Record<string, unknown> | undefined)?.["ttl"] ?? "5m"))}`,
      `messages=${messages.length} effort_markers=${JSON.stringify(markers)} tool_references=${references}`,
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
function cannedResponse(body: unknown): Response {
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
  const response = DRY_RUN && url.includes("/v1/messages") ? cannedResponse(init?.body) : await originalFetch(input, init);
  if (!url.includes("/v1/messages")) return response;
  const headers = new Headers(init?.headers);
  const record: Observed = { label: currentLabel, status: response.status, sent: describeRequest(init?.body, headers.get("anthropic-beta") ?? "(none)") };
  observed.push(record);
  if (!response.ok || response.body === null) return response;
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

// --- the session ---------------------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), "winter-cache-probe-home-"));
const cwd = mkdtempSync(join(tmpdir(), "winter-cache-probe-cwd-"));
registerMcpServerTools(PROBE_SERVER, [{ name: "lookup_weather", description: "Look up today's weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }], { deferredDefault: true });
replaceExecutor(PROBE_TOOL, { async execute() { return { output: "sunny" }; } });

try {
  const catalog = loadCatalog();
  const config: RuntimeConfig = {
    sessionId: `ws23-cache-probe-${Date.now()}`,
    cwd,
    model: MODEL,
    effort: "high",
    winterHome: home,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    toolSearchEnabled: true,
    capabilities: ["winter.mcp"],
  };
  const wiring = buildSessionProvider({ config, env: {}, catalog, credentials });
  const identity = wiring.identity;
  if (identity === undefined) throw new Error(`probe-anthropic-cache: ${MODEL} did not resolve`);
  const { host, runtime } = createInMemoryChannel();
  const frames: WinterFrame[] = [];
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: String(wiring.resolved!.adapter.family), ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
    describeModel: (model: string, providerId?: string) => describeCatalogModel(catalog, model, providerId),
    systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
    compactionController: createCompactionController({ retainedPairs: 1 }),
    mcpServerStateSource: createFakeMcpServerStateSource([{ name: PROBE_SERVER, state: "connected", toolNames: [] }]),
    providerSupportsToolSearch: true,
    deferrableContextShare: 100,
  } as EngineOptions);
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): Array<Record<string, unknown>> =>
    frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
  const turn = async (label: string, text: string): Promise<void> => {
    currentLabel = label;
    const before = results().length;
    host.output.write({ type: "user", text });
    for (let n = 0; n < 6000 && results().length <= before; n++) await new Promise((r) => setTimeout(r, 50));
    const result = results()[before];
    const usage = result?.["usage"] as Record<string, unknown> | undefined;
    console.log(`\n[${label}] result: is_error=${String(result?.["is_error"])} cache_read=${String(usage?.["cache_read_input_tokens"])} cache_creation=${String(usage?.["cache_creation_input_tokens"])} cache_misses=${JSON.stringify(usage?.["cache_misses"] ?? null)}`);
  };
  const setEffort = async (effort: string): Promise<void> => {
    host.output.write({ type: "control_request", requestId: `effort-${effort}`, subtype: "set_effort", payload: { effort } });
    for (let n = 0; n < 200 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === `effort-${effort}`); n++) await new Promise((r) => setTimeout(r, 10));
    const ack = frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === `effort-${effort}`) as { ok?: boolean } | undefined;
    console.log(`\n[set_effort ${effort}] acknowledged ok=${String(ack?.ok)}`);
  };

  await turn("turn 1 (high)", "Reply with the single word: one.");
  await turn("turn 2 (high)", "Reply with the single word: two.");
  await setEffort("low");
  await turn("turn 3 (low, per-message marker)", "Reply with the single word: three.");
  await turn("turn 4 (ToolSearch load)", `Use the ToolSearch tool with the query "select:${PROBE_TOOL}", then call ${PROBE_TOOL} for Paris, then reply with its answer as one word.`);
  await turn("turn 5 (/compact)", "/compact");
  await turn("turn 6 (after compaction)", "Reply with the single word: six.");

  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;

  console.log("\n=== per request (request shape, then the response's message_start) ===");
  observed.forEach((o, i) => {
    console.log(`\n#${i + 1} [${o.label}] HTTP ${o.status}\n  sent:    ${o.sent}\n  usage:   ${o.usage ?? "(no message_start)"}\n  verdict: ${o.verdict ?? "(none)"}`);
  });
  console.log("\nREAD IT AS: turn 3's cache_read should stay close to turn 2's (the effort switch kept the prefix); turn 4's follow-up requests keep `tools` identical and read cache; the /compact summary request reads the conversation from cache.");
} finally {
  unregisterMcpServerTools(PROBE_SERVER);
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
