// WS-23 (midconv): the LIVE probe for OpenAI's mid-conversation mechanisms on Winter's Responses path
// (the OpenAI API and the ChatGPT Codex backend). Run by a human (the controller), never by a test and
// never by CI.
//
// WHAT IT CONFIRMS that the hermetic suite (`responses-midconv.test.ts`, `midconv-effort-wire.test.ts`,
// `midconv-prefix-wire.test.ts`, `tool-epoch.engine.test.ts`) can only assume, because only the real
// endpoints can say it:
//   1. cfg-openai   -- `configuration_update` on gpt-6-astra / -sol / -luna: an effort switch rides the item
//                      while the top-level `reasoning.effort` stays fixed, placed BEFORE the user message
//                      (the docs) and, in a second session, AFTER it (Codex's placement) -- which one the
//                      API accepts, and `cached_tokens` across the switch;
//   2. cfg-error    -- the error text for the item on a model without it (gpt-5.6, the row patched to
//                      claim it so the adapter sends it): the engine's one-time fallback keys on that text;
//   3. cfg-codex    -- the same two placements on the Codex backend (codex-oauth/gpt-6-*, rows patched to
//                      claim the item -- the catalog does NOT, pending this probe) and the error on
//                      codex-oauth/gpt-5.6-sol;
//   4. search       -- a client `tool_search` round trip (tool_search_call -> Winter's ToolSearch ->
//                      tool_search_output with a namespaced deferred MCP tool -> the namespaced call), on the
//                      OpenAI API and on the Codex backend, `tools` unchanged and `cached_tokens` throughout;
//   5. tools-openai -- a late tool through an `additional_tools` item, then a permission-mode switch that
//                      restricts the callable set through `tool_choice: allowed_tools` (a namespaced loaded
//                      tool named by `{"type": "namespace"}` is INFERRED -- this is where it is checked);
//   6. tools-codex  -- step 5 on the Codex backend, rows patched to claim both (the catalog does not).
//      Steps 5 and 6 load a namespaced MCP tool through ToolSearch BEFORE the restriction, so the plan-mode
//      request lists it in `allowed_tools` as `{"type": "function", "name": <name inside the namespace>}`
//      (fix round 1: never `tool_search`, never a namespace entry -- the spelling is INFERRED, checked here);
//   7. cache        -- (fix round 1, live L3) three plain turns on the OpenAI API and on the Codex backend,
//                      no changes at all: turn 2 and 3's `cached` should be most of their input on BOTH now
//                      that codex requests carry `session-id` / `thread-id` (codex-rs's cache affinity;
//                      each request line prints whether `session-id` was sent).
// Every request prints its SHAPE (item types in order, the update's placement, tools, tool_choice, the
// top-level effort) and the response's usage (`input_tokens`, `cached_tokens`); a non-2xx prints its error
// body, truncated.
//
// IT DRIVES THE SHIPPED ENGINE AND ADAPTERS: `runEngine` over `buildSessionProvider`'s real catalog-resolved
// provider. The only thing the probe itself does to a request is the "after-user" placement: its fetch
// wrapper moves each `configuration_update` behind the user message it precedes (the adapter's
// `CONFIGURATION_UPDATE_PLACEMENT` is the documented "before-user"; this is how the probe flips it without a
// production knob).
//
// NOTHING SECRET IS EVER PRINTED. Credentials are read from the macOS Keychain -- the brand's DEV service
// (`DEFAULT_KEYCHAIN_SERVICE` + `.dev`), accounts `openai:default` and `codex-oauth:default` -- READ ONLY,
// through the runtime's own Keychain store, and never touched as a string here. A Codex token that needs a
// refresh cannot be refreshed by this read-only store: the probe reports the failure, and signing in again
// in the dev app fixes it. Output is item types, counts, token numbers and error bodies. Never model text.
//
// COST: roughly thirty small generations across gpt-6-astra/sol/luna and gpt-5.6 (tiny prompts, effort
// high/low). Pick phases with WINTER_OPENAI_MIDCONV_PROBE_PHASES (comma-separated; default: all):
//   cfg-openai,cfg-error,cfg-codex,search,tools-openai,tools-codex,cache
//
// Usage (from the worktree root):
//   WINTER_OPENAI_MIDCONV_PROBE=1 bun run scripts/probe-openai-midconv.ts
// Without `WINTER_OPENAI_MIDCONV_PROBE=1` it prints one line and exits 0. DRY RUN (free, no Keychain, no
// network): add `WINTER_OPENAI_MIDCONV_PROBE_DRY_RUN=1` -- a canned in-process responder with a fake key, which
// answers a request with no credential 401 and the item on gpt-5.6 400, so the plumbing is checked first.

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
import { describeCatalogModel } from "../packages/runtime/src/production-wiring.ts";
import { registerMcpServerTools, registerTool, replaceExecutor, unregisterMcpServerTools, unregisterToolForTest } from "../packages/runtime/src/tools/registry.ts";
import { createFakeMcpServerStateSource } from "../packages/runtime/src/mcp/state.ts";
import "../packages/runtime/src/tools/impl/index.ts";

/** The dev profile's Keychain service. Read, never written. */
const KEYCHAIN_SERVICE = `${DEFAULT_KEYCHAIN_SERVICE}.dev`;
const PROBE_SERVER = "wsmidprobe";
const PROBE_TOOL = `mcp__${PROBE_SERVER}__lookup_order`;
const LATE_TOOL = "WsMidProbeLate";
const MODAL_TOOL = "WsMidProbeBypassOnly";

if (process.env["WINTER_OPENAI_MIDCONV_PROBE"] !== "1") {
  console.log("probe-openai-midconv: set WINTER_OPENAI_MIDCONV_PROBE=1 to run (it calls the PAID OpenAI API and the Codex backend with the dev Keychain's openai:default and codex-oauth:default)");
  process.exit(0);
}
const DRY_RUN = process.env["WINTER_OPENAI_MIDCONV_PROBE_DRY_RUN"] === "1";
const PHASES = new Set((process.env["WINTER_OPENAI_MIDCONV_PROBE_PHASES"] ?? "cfg-openai,cfg-error,cfg-codex,search,tools-openai,tools-codex,cache").split(",").map((p) => p.trim()));

// --- the dev-pinned, read-only credential store --------------------------------------------------------

const devKeychain = createKeychainCredentialStore(KEYCHAIN_SERVICE);
const credentials: CredentialStore = {
  async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
    if (ref.kind !== "keychain") return null;
    if (DRY_RUN) return ref.account.startsWith("codex-oauth") ? { kind: "oauth", accessToken: "dry-run-not-a-token", accountId: "dry-run-account" } : { kind: "api-key", key: "dry-run-not-a-key" };
    return await devKeychain.get({ ...ref, service: KEYCHAIN_SERVICE });
  },
  async set(): Promise<void> {
    throw new Error("probe-openai-midconv: the credential store is read-only (sign in again in the dev app if a Codex token needs a refresh)");
  },
  async delete(): Promise<void> {
    throw new Error("probe-openai-midconv: the credential store is read-only");
  },
};

// --- the wire observer ----------------------------------------------------------------------------------

interface Observed {
  label: string;
  url: string;
  status: number;
  sent: string;
  usage?: string;
  outputItems?: string;
  error?: string;
}
const observed: Observed[] = [];
let currentLabel = "setup";
/** The current session's placement: "after-user" rewrites the body in the fetch wrapper. */
let currentPlacement: "before-user" | "after-user" = "before-user";

type Item = Record<string, unknown>;

/** Codex's placement: each update moves behind the user message it precedes (or stays last). */
function toAfterUser(input: Item[]): Item[] {
  const out: Item[] = [];
  let pending: Item | undefined;
  for (const item of input) {
    if (item["type"] === "configuration_update") {
      pending = item;
      continue;
    }
    out.push(item);
    if (pending !== undefined && item["type"] === "message" && item["role"] === "user") {
      out.push(pending);
      pending = undefined;
    }
  }
  if (pending !== undefined) out.push(pending);
  return out;
}

function describeRequest(body: Record<string, unknown>, headers: Headers): string {
  const input = Array.isArray(body["input"]) ? (body["input"] as Item[]) : [];
  const shape = input.map((i) => {
    if (i["type"] === "configuration_update") return `cfg(${String((i["reasoning"] as Item)["effort"])})`;
    if (i["type"] === "message") return `msg:${String(i["role"])}`;
    if (i["type"] === "function_call") return i["namespace"] !== undefined ? `call(${String(i["namespace"])}/${String(i["name"])})` : `call(${String(i["name"])})`;
    if (i["type"] === "additional_tools") return `additional_tools(${(i["tools"] as unknown[]).length})`;
    if (i["type"] === "tool_search_output") return `tool_search_output(${JSON.stringify((i["tools"] as Item[]).map((t) => (t["type"] === "namespace" ? `ns:${String(t["name"])}[${(t["tools"] as unknown[]).length}]` : String(t["name"]))))})`;
    return String(i["type"]);
  });
  const tools = Array.isArray(body["tools"]) ? (body["tools"] as Item[]).map((t) => (t["type"] === "tool_search" ? "tool_search" : String(t["name"]))) : [];
  const choice = body["tool_choice"];
  const choiceShape = choice !== null && typeof choice === "object" ? `${String((choice as Item)["type"])}${(choice as Item)["type"] === "allowed_tools" ? `(${String((choice as Item)["mode"])}: ${JSON.stringify(((choice as Item)["tools"] as Item[]).map((t) => `${String(t["type"])}${t["name"] !== undefined ? `:${String(t["name"])}` : ""}`))})` : ""}` : JSON.stringify(choice);
  return [
    `model=${String(body["model"])} reasoning=${JSON.stringify(body["reasoning"] ?? null)} placement=${currentPlacement}`,
    `input=[${shape.join(", ")}]`,
    `tools=${tools.length} tool_search=${tools.includes("tool_search")} tool_choice=${choiceShape} prompt_cache_key=${body["prompt_cache_key"] !== undefined ? "set" : "absent"} session-id=${headers.get("session-id") !== null ? "set" : "absent"} thread-id=${headers.get("thread-id") !== null ? "set" : "absent"}`,
  ].join(" | ");
}

function cannedResponse(body: Record<string, unknown>, headers: Headers): Response {
  if (headers.get("authorization") === null) {
    return new Response(JSON.stringify({ error: { message: "You didn't provide an API key.", type: "invalid_request_error", code: null } }), { status: 401, headers: { "content-type": "application/json" } });
  }
  const input = Array.isArray(body["input"]) ? (body["input"] as Item[]) : [];
  // The live API's answer to an `allowed_tools` entry naming a function `tools` does not declare at top
  // level (a tool loaded inside a namespace): HTTP 400, `param: "tool_choice"` (live probe, 2026-09-26).
  const choice = body["tool_choice"] as Item | undefined;
  if (choice !== undefined && typeof choice === "object" && choice["type"] === "allowed_tools") {
    const declared = new Set((Array.isArray(body["tools"]) ? (body["tools"] as Item[]) : []).map((t) => t["name"]));
    const missing = (choice["tools"] as Item[]).find((t) => t["type"] === "function" && !declared.has(t["name"]));
    if (missing !== undefined) return new Response(JSON.stringify({ error: { message: `Tool choice '${String(missing["name"])}' not found in 'tools' parameter.`, type: "invalid_request_error", param: "tool_choice", code: null } }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (String(body["model"]).startsWith("gpt-5.6") && input.some((i) => i["type"] === "configuration_update")) {
    return new Response(JSON.stringify({ error: { message: "Invalid value: 'configuration_update'. (dry run)", type: "invalid_request_error", param: "input[0].type", code: "invalid_value" } }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const tools = Array.isArray(body["tools"]) ? (body["tools"] as Item[]) : [];
  const lastUser = [...input].reverse().find((i) => i["type"] === "message" && i["role"] === "user");
  const asked = JSON.stringify(lastUser ?? {}).includes("ToolSearch");
  const searched = input.find((i) => i["type"] === "tool_search_output");
  const called = input.some((i) => i["type"] === "function_call");
  let item: Item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
  if (asked && tools.some((t) => t["type"] === "tool_search") && searched === undefined) {
    item = { type: "tool_search_call", call_id: "ts_dry", execution: "client", status: "completed", arguments: { query: `select:${PROBE_TOOL}` } };
  } else if (JSON.stringify(lastUser ?? {}).includes("again") && input.at(-1)?.["type"] === "message") {
    // The plan-mode turn: the model calls the loaded namespaced tool again, as a live model does.
    item = { type: "function_call", call_id: "fc_again", namespace: `mcp__${PROBE_SERVER}`, name: "lookup_order", arguments: '{"id":"8"}' };
  } else if (searched !== undefined && !called) {
    const ns = (searched["tools"] as Item[]).find((t) => t["type"] === "namespace");
    item = { type: "function_call", call_id: "fc_dry", ...(ns !== undefined ? { namespace: ns["name"], name: String(((ns["tools"] as Item[])[0] ?? {})["name"]) } : { name: PROBE_TOOL }), arguments: '{"id":"7"}' };
  }
  const events: Item[] = [
    { type: "response.created", response: { id: `resp_dry_${observed.length}`, model: body["model"] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, ...(item["type"] === "message" ? { content: [] } : {}) } },
    ...(item["type"] === "message" ? [{ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "ok" }] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_dry_${observed.length}`, status: "completed", usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } }, output: [] } },
  ];
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.endsWith("/responses")) return DRY_RUN ? new Response("{}", { status: 404 }) : await originalFetch(input, init);
  let body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  if (currentPlacement === "after-user" && Array.isArray(body["input"])) {
    body = { ...body, input: toAfterUser(body["input"] as Item[]) };
    init = { ...init, body: JSON.stringify(body) };
  }
  const headers = new Headers(init?.headers);
  const response = DRY_RUN ? cannedResponse(body, headers) : await originalFetch(input, init);
  const record: Observed = { label: currentLabel, url: new URL(url).host + new URL(url).pathname, status: response.status, sent: describeRequest(body, headers) };
  observed.push(record);
  if (!response.ok) {
    const text = await response.clone().text().catch(() => "(unreadable body)");
    record.error = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    return response;
  }
  if (response.body === null) return response;
  const [forAdapter, forObserver] = response.body.tee();
  void (async () => {
    const reader = forObserver.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const items: string[] = [];
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
          const payload = JSON.parse(line.slice(5).trim()) as Item;
          if (payload["type"] === "response.output_item.done") items.push(String((payload["item"] as Item)["type"]));
          if (payload["type"] === "response.completed") {
            const usage = ((payload["response"] as Item)["usage"] ?? {}) as Item;
            record.usage = JSON.stringify({ input: usage["input_tokens"], cached: (usage["input_tokens_details"] as Item | undefined)?.["cached_tokens"], output: usage["output_tokens"] });
          }
        } catch {
          /* not JSON */
        }
      }
    }
    record.outputItems = items.join(",");
  })();
  return new Response(forAdapter, { status: response.status, statusText: response.statusText, headers: response.headers });
}) as typeof fetch;

// --- the sessions ---------------------------------------------------------------------------------------

type Step = { turn: string; label: string } | { effort: string } | { mode: string } | { act: () => void; note: string };
type Row = WinterCatalog["models"][number];
const evidence = { source: "official-doc" as const, confidence: "declared" as const, sourceRef: "probe-openai-midconv: patched for this probe only", observedAt: "2026-09-26T00:00:00Z" };
const claimItem = (row: Row): Row => (row.reasoning === undefined ? row : { ...row, reasoning: { ...row.reasoning, perMessageEffort: { ...evidence, value: { item: "configuration_update" as const } } } });
const claimTools = (row: Row): Row => ({ ...row, additionalToolsItem: { ...evidence, value: true }, allowedToolsChoice: { ...evidence, value: true } });

async function runSession(phase: string, model: string, patch: (row: Row) => Row, steps: Step[], placement: "before-user" | "after-user" = "before-user"): Promise<void> {
  currentPlacement = placement;
  const compiled = loadCatalog();
  const catalog: WinterCatalog = { ...compiled, models: compiled.models.map((m) => (m.key === model ? patch(m) : m)) };
  const providerId = model.split("/")[0]!;
  const home = mkdtempSync(join(tmpdir(), "winter-openai-midconv-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-openai-midconv-cwd-"));
  try {
    const config: RuntimeConfig = {
      sessionId: `ws23-openai-midconv-${phase}-${Date.now()}`,
      cwd,
      model,
      effort: "high",
      winterHome: home,
      // Bypass, so a tool call never waits on a permission prompt this probe has no one to answer.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      toolSearchEnabled: true,
      capabilities: ["winter.mcp"],
      provider: { providerId, authRef: { kind: "keychain", account: `${providerId}:default`, service: KEYCHAIN_SERVICE } },
    };
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials });
    const identity = wiring.identity;
    if (identity === undefined) throw new Error(`probe-openai-midconv: ${model} did not resolve`);
    const { host, runtime } = createInMemoryChannel();
    const frames: WinterFrame[] = [];
    const done = runEngine({
      config,
      input: runtime.input,
      output: runtime.output,
      provider: wiring.provider,
      providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: "openai" },
      describeModel: (m: string, p?: string) => describeCatalogModel(catalog, m, p),
      systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
      mcpServerStateSource: createFakeMcpServerStateSource([{ name: PROBE_SERVER, state: "connected", toolNames: [] }]),
      providerSupportsToolSearch: true,
      deferrableContextShare: 100,
    } as EngineOptions);
    const reader = (async () => {
      for await (const f of host.input) {
        frames.push(f);
        // A PERMISSION request (plan mode asks before a tool runs) is answered with a deny, so the turn
        // ends. The first live run of the tools phases never answered one and hung for hours in plan
        // mode -- the engine was waiting on its host, as designed.
        if (f.type === "control_request" && (f as { subtype?: unknown }).subtype === "permission") {
          const requestId = (f as { requestId: string }).requestId;
          console.log(`\n[${phase}] a permission request -> denied (plan mode; the probe answers every one)`);
          host.output.write({ type: "control_response", requestId, ok: true, payload: { behavior: "deny", message: "probe-openai-midconv: denied (plan mode)" } });
        }
      }
    })();
    const results = (): Array<Record<string, unknown>> => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
    let controls = 0;
    const control = async (subtype: string, payload: unknown): Promise<boolean> => {
      const id = `c${++controls}`;
      host.output.write({ type: "control_request", requestId: id, subtype, payload });
      for (let n = 0; n < 200 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === id); n++) await new Promise((r) => setTimeout(r, 10));
      return (frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === id) as { ok?: boolean } | undefined)?.ok === true;
    };
    for (const step of steps) {
      if ("act" in step) {
        step.act();
        console.log(`\n[${phase}] ${step.note}`);
      } else if ("effort" in step) {
        console.log(`\n[${phase}] set_effort ${step.effort} ok=${String(await control("set_effort", { effort: step.effort }))}`);
      } else if ("mode" in step) {
        console.log(`\n[${phase}] set_permission_mode ${step.mode} ok=${String(await control("set_permission_mode", step.mode))}`);
      } else {
        currentLabel = `${phase} ${model} (${placement}): ${step.label}`;
        const before = results().length;
        host.output.write({ type: "user", text: step.turn });
        for (let n = 0; n < 6000 && results().length <= before; n++) await new Promise((r) => setTimeout(r, 50));
        const result = results()[before];
        console.log(`\n[${currentLabel}] result: is_error=${String(result?.["is_error"])}${result?.["is_error"] === true ? ` terminal_reason=${String(result?.["terminal_reason"])}` : ""}`);
      }
    }
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

const effortSteps: Step[] = [
  { turn: "Reply with the single word: one.", label: "turn 1 (high, the baseline update)" },
  { effort: "low" },
  { turn: "Reply with the single word: two.", label: "turn 2 (low, a configuration_update)" },
];
const searchSteps: Step[] = [{ turn: `Use the ToolSearch tool with the query "select:${PROBE_TOOL}", then call it with id "7", then reply with its answer as one word.`, label: "a ToolSearch round trip" }];
const toolSteps: Step[] = [
  { act: () => dropTool(LATE_TOOL), note: `(${LATE_TOOL} absent at the start)` },
  { turn: "Reply with the single word: one.", label: "turn 1 (frozen list)" },
  { act: () => addTool(LATE_TOOL), note: `a late tool ${LATE_TOOL} is registered` },
  { turn: "Reply with the single word: two.", label: "turn 2 (additional_tools)" },
  { turn: `Use the ToolSearch tool with the query "select:${PROBE_TOOL}", then call it with id "7", then reply with its answer as one word.`, label: "turn 3 (load a namespaced MCP tool)" },
  { mode: "plan" },
  { turn: `Call ${PROBE_TOOL} with id "8" again, then reply with its answer as one word.`, label: "turn 4 (plan mode: allowed_tools names the loaded namespaced tool as a function)" },
  { mode: "bypassPermissions" },
  { turn: "Reply with the single word: five.", label: "turn 5 (bypass again: restriction lifted)" },
];

const registered: string[] = [];
function dropTool(name: string): void {
  if (!registered.includes(name)) return;
  unregisterToolForTest(name);
  registered.splice(registered.indexOf(name), 1);
}
function addTool(name: string, modes?: Array<"bypassPermissions">): void {
  // A later phase re-adds the same stand-in: the previous session's registration goes first.
  if (registered.includes(name)) {
    unregisterToolForTest(name);
    registered.splice(registered.indexOf(name), 1);
  }
  registerTool({
    descriptor: { canonicalName: name, advertisedName: name, source: "sdk", inputSchema: { type: "object", properties: { q: { type: "string" } } }, description: `${name}: a probe stand-in. Never call it.`, exposure: "eager", permissionClass: "read", availability: modes !== undefined ? { modes } : {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: { async execute() { return { output: "ok" }; } },
  });
  registered.push(name);
}

registerMcpServerTools(PROBE_SERVER, [{ name: "lookup_order", description: "Look up an order by id.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }], { deferredDefault: true });
replaceExecutor(PROBE_TOOL, { async execute() { return { output: "shipped" }; } });
addTool(MODAL_TOOL, ["bypassPermissions"]);

try {
  for (const model of ["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna"]) {
    if (!PHASES.has("cfg-openai")) break;
    await runSession("cfg-openai", model, (row) => row, effortSteps, "before-user");
    await runSession("cfg-openai", model, (row) => row, effortSteps, "after-user");
  }
  if (PHASES.has("cfg-error")) await runSession("cfg-error", "openai/gpt-5.6", claimItem, effortSteps);
  if (PHASES.has("cfg-codex")) {
    for (const model of ["codex-oauth/gpt-6-astra", "codex-oauth/gpt-6-sol", "codex-oauth/gpt-6-luna"]) {
      await runSession("cfg-codex", model, claimItem, effortSteps, "before-user");
      await runSession("cfg-codex", model, claimItem, effortSteps, "after-user");
    }
    await runSession("cfg-codex", "codex-oauth/gpt-5.6-sol", claimItem, effortSteps);
  }
  if (PHASES.has("search")) {
    await runSession("search", "openai/gpt-6-astra", (row) => row, searchSteps);
    await runSession("search", "codex-oauth/gpt-6-astra", (row) => row, searchSteps);
  }
  if (PHASES.has("tools-openai")) await runSession("tools-openai", "openai/gpt-6-astra", (row) => row, toolSteps);
  if (PHASES.has("tools-codex")) await runSession("tools-codex", "codex-oauth/gpt-6-astra", claimTools, toolSteps);
  if (PHASES.has("cache")) {
    const plain: Step[] = [
      { turn: "Reply with the single word: one.", label: "turn 1" },
      { turn: "Reply with the single word: two.", label: "turn 2 (no change: should read cache)" },
      { turn: "Reply with the single word: three.", label: "turn 3 (no change: should read cache)" },
    ];
    await runSession("cache", "openai/gpt-6-astra", (row) => row, plain);
    await runSession("cache", "codex-oauth/gpt-6-astra", (row) => row, plain);
  }

  console.log("\n=== per request (request shape, then the response) ===");
  observed.forEach((o, i) => {
    console.log(`\n#${i + 1} [${o.label}] HTTP ${o.status} ${o.url}\n  sent:   ${o.sent}\n  usage:  ${o.usage ?? "(none)"}\n  output: ${o.outputItems ?? "(none)"}${o.error !== undefined ? `\n  error:  ${o.error}` : ""}`);
  });
  console.log(
    "\nREAD IT AS: cfg-* -- a 2xx on turn 2 means the placement is accepted (compare before-user vs after-user; if only after-user passes, flip CONFIGURATION_UPDATE_PLACEMENT), `cached` on turn 2 should be close to turn 1's input, and the top-level reasoning.effort never moves; cfg-error / gpt-5.6 prints the API's own error text for the item (the engine's fallback regex keys on `configuration_update`); cfg-codex decides whether codex-oauth/gpt-6-* may record the item. search -- tools unchanged across the round trip, the namespaced call accepted. tools-* -- tools unchanged; turn 2 carries additional_tools, turn 4 tool_choice allowed_tools without the bypass-only tool, functions only (a 400 here names the allowed_tools spelling the endpoint refused, and the session's one fallback line must say allowed_tools, not tool search), turn 5 back to auto. cache -- codex turn 2/3 `cached` near their input, as on api.openai.com; still 0 means the backend does not report it (or needs more than the headers).",
  );
} finally {
  unregisterMcpServerTools(PROBE_SERVER);
  for (const name of registered) unregisterToolForTest(name);
  globalThis.fetch = originalFetch;
}
