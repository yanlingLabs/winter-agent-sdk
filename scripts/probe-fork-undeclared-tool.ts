// WS-24 (engine lane, fix round 1 I2): the LIVE probe behind the catalog's `undeclaredToolCalls` evidence
// key. Run by a human (the controller), never by a test and never by CI.
//
// WHAT IT ASKS, per row. A FORK sends its parent's exact `tools` (so the cached prefix is shared); a tool the
// fork loads itself through ToolSearch is not in that list. On a row with `undeclaredToolCalls` the engine
// lets the fork call such a tool anyway, its definition riding the ToolSearch result as text
// (`undeclaredToolDefinitionsText`, engine.ts). That is only safe if the endpoint takes it, which no vendor
// documents -- so each row is asked:
//   A. history holds a call to a tool NOT in `tools`, plus its result, then a user turn -> 200, or 400 + code?
//   B. the exact fork shape: a ToolSearch call whose result carries the `<functions>` definition, then a user
//      turn asking to call it -> does the model emit the call (and to the undeclared name)?
//   C. B's output fed back (its call and a result; synthesized when B made no call) + one more turn -> 200?
//   C-mixed (the Anthropic deferred-loading row only): a ToolSearch result that loads one REFERABLE tool
//      (declared `defer_loading`) and one undeclared name -> the adapter's references-only tool_result with
//      the text after it -> 200?
// On a row with OpenAI's client `tool_search` (`clientToolSearch`), B and C use that documented mechanism
// instead (the definition rides `tool_search_output`), which is how the engine loads there; A is the same
// raw question for every row.
//
// Rows: Anthropic Messages on a deferred-loading row (anthropic/claude-opus-5-5) and a non-deferred one
// (anthropic/claude-sonnet-5); OpenAI Responses with client tool_search (openai/gpt-6-luna) and without
// (openai/gpt-4.1-mini); Chat Completions on openai (openai/gpt-4.1-mini, the provider's adapter patched to
// Chat Completions for this probe only) and on deepseek (deepseek/deepseek-flash). Gemini and Bedrock are
// not probed (no dev credential). Set `undeclaredToolCalls` on a row only when its A and C answer 200 and
// its B shows the model calling the undeclared tool.
//
// IT USES WINTER'S OWN REQUEST BUILDERS: every request goes through `buildSessionProvider`'s real,
// catalog-resolved provider (the bridge, the history renderer, the adapter) -- the probe only builds the
// engine-level `ProviderRequest` the engine itself would build for a fork.
//
// NOTHING SECRET OR VERBATIM IS PRINTED. Credentials are read from the macOS Keychain -- the DEV service
// (`DEFAULT_KEYCHAIN_SERVICE` + `.dev`), accounts `anthropic:default`, `openai:default`, `deepseek:default` --
// READ ONLY, through the runtime's own Keychain store; a missing one skips that row. Output per request is the
// HTTP status, the error's type/code/param (never its message or any body), the stop reason, and whether the
// model called the undeclared tool.
//
// COST: about 22 small generations (tiny prompts, no effort named).
//
// Usage (from the worktree root):
//   WINTER_FORK_UNDECLARED_PROBE=1 bun run scripts/probe-fork-undeclared-tool.ts
// Pick rows with WINTER_FORK_UNDECLARED_PROBE_ROWS (comma-separated labels; default: all):
//   anthropic-deferred,anthropic-plain,responses-search,responses-plain,chat-openai,chat-deepseek
// DRY RUN (free, no Keychain, no network): add WINTER_FORK_UNDECLARED_PROBE_DRY_RUN=1 -- every request is
// built through the real adapters and answered 400 by an in-process stub, so the plumbing is checked first.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../packages/sdk/src/index.ts";
import { loadCatalog, type WinterCatalog } from "../packages/provider-catalog/src/index.ts";
import type { CredentialMaterial, CredentialRef, CredentialStore } from "../packages/provider-runtime/src/types.ts";
import { DEFAULT_KEYCHAIN_SERVICE, createKeychainCredentialStore } from "../packages/runtime/src/provider/keychain-store.ts";
import { buildSessionProvider } from "../packages/runtime/src/provider/session-provider.ts";
import { undeclaredToolDefinitionsText, type ContentBlock, type LoadedToolDefinition, type Provider, type ProviderMessage, type ProviderRequest, type ProviderToolSpec, type ProviderTurn } from "../packages/runtime/src/engine.ts";

const KEYCHAIN_SERVICE = `${DEFAULT_KEYCHAIN_SERVICE}.dev`;

if (process.env["WINTER_FORK_UNDECLARED_PROBE"] !== "1") {
  console.log("probe-fork-undeclared-tool: set WINTER_FORK_UNDECLARED_PROBE=1 to run (it calls the PAID Anthropic, OpenAI and DeepSeek APIs with the dev Keychain's anthropic:default, openai:default and deepseek:default)");
  process.exit(0);
}
const DRY_RUN = process.env["WINTER_FORK_UNDECLARED_PROBE_DRY_RUN"] === "1";
const ROWS = new Set((process.env["WINTER_FORK_UNDECLARED_PROBE_ROWS"] ?? "anthropic-deferred,anthropic-plain,responses-search,responses-plain,chat-openai,chat-deepseek").split(",").map((r) => r.trim()));

// --- the dev-pinned, read-only credential store --------------------------------------------------------

const devKeychain = createKeychainCredentialStore(KEYCHAIN_SERVICE);
const credentials: CredentialStore = {
  async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
    if (ref.kind !== "keychain") return null;
    if (DRY_RUN) return { kind: "api-key", key: "dry-run-not-a-key" };
    return await devKeychain.get({ ...ref, service: KEYCHAIN_SERVICE });
  },
  async set(): Promise<void> {
    throw new Error("probe-fork-undeclared-tool: the credential store is read-only");
  },
  async delete(): Promise<void> {
    throw new Error("probe-fork-undeclared-tool: the credential store is read-only");
  },
};

// --- the wire observer: status and the error's type/code/param, nothing else ---------------------------

interface Seen {
  status: number;
  error?: string;
}
let lastSeen: Seen | undefined;
const originalFetch = globalThis.fetch;
/** Dry run only: the request's path and item/block TYPES (fixture names only), so the plumbing is visible. */
function dryRunShape(url: string, body: string | undefined): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body ?? "{}") as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const types = (list: unknown): string[] =>
    Array.isArray(list)
      ? (list as Array<Record<string, unknown>>).map((m) => {
          const inner = Array.isArray(m["content"]) ? `(${(m["content"] as Array<Record<string, unknown>>).map((b) => String(b["type"])).join("+")})` : "";
          return `${String(m["type"] ?? m["role"])}${inner}`;
        })
      : [];
  return `${new URL(url).pathname} ${JSON.stringify(types(parsed["messages"] ?? parsed["input"]))}`;
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  if (DRY_RUN) console.log(`    dry run -> ${dryRunShape(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, typeof init?.body === "string" ? init.body : undefined)}`);
  const response = DRY_RUN
    ? new Response(JSON.stringify({ type: "error", error: { type: "dry_run", code: "dry_run", param: null, message: "dry run" } }), { status: 400, headers: { "content-type": "application/json" } })
    : await originalFetch(input, init);
  const seen: Seen = { status: response.status };
  if (!response.ok) {
    try {
      const body = (await response.clone().json()) as { error?: { type?: unknown; code?: unknown; param?: unknown } };
      const e = body.error ?? {};
      seen.error = `type=${String(e.type ?? "-")} code=${String(e.code ?? "-")} param=${String(e.param ?? "-")}`;
    } catch {
      seen.error = "type=- code=- param=- (non-JSON body)";
    }
  }
  lastSeen = seen;
  return response;
}) as typeof fetch;

// --- the fixture tools ------------------------------------------------------------------------------------

const UNDECLARED = "probe_lookup_order";
const REFERABLE = "probe_referable_status";
const lookupDefinition: LoadedToolDefinition = {
  name: UNDECLARED,
  description: "Look up an order by its id and return its shipping status.",
  inputSchema: { type: "object", properties: { id: { type: "string", description: "The order id." } }, required: ["id"] },
};
const referableDefinition: LoadedToolDefinition = {
  name: REFERABLE,
  description: "Return the status of the order service.",
  inputSchema: { type: "object", properties: {} },
};
const toolSearchSpec = (native: boolean): ProviderToolSpec => ({
  name: "ToolSearch",
  description: "Fetches full schema definitions for deferred tools so they can be called.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  ...(native ? { toolSearch: true as const } : {}),
});
const echoSpec: ProviderToolSpec = { name: "probe_echo", description: "Echo the given text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const SYSTEM = "You are a terse test assistant. Use tools when asked. Keep replies to one short sentence.";

// --- one row -----------------------------------------------------------------------------------------------

interface Row {
  label: string;
  model: string;
  /** OpenAI's client `tool_search` is the load mechanism (the definition rides `tool_search_output`). */
  nativeSearch?: boolean;
  /** Anthropic deferred loading: a declared `defer_loading` tool can be referenced (the C-mixed case). */
  deferred?: boolean;
  patchCatalog?: (catalog: WinterCatalog) => WinterCatalog;
}

const toolUse = (id: string, name: string, input: Record<string, unknown>): ProviderMessage => ({ role: "assistant", content: [{ type: "tool_use", id, name, input } as ContentBlock] });
const toolResult = (id: string, content: string, extra: Record<string, unknown> = {}): ProviderMessage => ({ role: "tool", content: [{ type: "tool_result", tool_use_id: id, content, ...extra } as ContentBlock] });
const user = (text: string): ProviderMessage => ({ role: "user", content: text });

function outcome(turn: ProviderTurn | undefined, err: unknown): string {
  const seen = lastSeen;
  const status = seen !== undefined ? `HTTP ${seen.status}` : "no HTTP response";
  if (turn === undefined) return `${status}${seen?.error !== undefined ? ` ${seen.error}` : ""}${err !== undefined && seen === undefined ? ` (failed before a request: ${err instanceof Error ? err.name : "error"})` : ""}`;
  const calls = turn.kind === "tool_use" ? turn.calls.map((c) => c.name) : [];
  return `${status} stop=${String(turn.stopReason ?? "-")} kind=${turn.kind}${calls.length > 0 ? ` calls=[${calls.map((n) => (n === UNDECLARED ? `${n} (UNDECLARED)` : n)).join(", ")}]` : ""}`;
}

async function ask(provider: Provider, label: string, req: ProviderRequest): Promise<ProviderTurn | undefined> {
  lastSeen = undefined;
  let turn: ProviderTurn | undefined;
  let err: unknown;
  try {
    turn = await provider.generate(req);
  } catch (e) {
    err = e;
  }
  console.log(`  ${label}: ${outcome(turn, err)}`);
  return turn;
}

async function probeRow(row: Row): Promise<void> {
  console.log(`\n[${row.label}] ${row.model}${row.nativeSearch ? " (client tool_search)" : ""}${row.deferred ? " (deferred tool loading)" : ""}`);
  const base = loadCatalog();
  const catalog = row.patchCatalog?.(base) ?? base;
  const providerId = row.model.split("/")[0]!;
  const home = mkdtempSync(join(tmpdir(), "winter-fork-undeclared-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-fork-undeclared-cwd-"));
  try {
    const config: RuntimeConfig = {
      sessionId: `ws24-fork-undeclared-${row.label}-${Date.now()}`,
      cwd,
      model: row.model,
      winterHome: home,
      provider: { providerId, authRef: { kind: "keychain", account: `${providerId}:default`, service: KEYCHAIN_SERVICE } },
    };
    if (!DRY_RUN && (await credentials.get({ kind: "keychain", account: `${providerId}:default`, service: KEYCHAIN_SERVICE })) === null) {
      console.log(`  skipped: no ${providerId}:default in the dev Keychain`);
      return;
    }
    const wiring = buildSessionProvider({ config, env: {}, catalog, credentials });
    const provider = wiring.provider;
    // The frozen `tools` a fork inherits: ToolSearch, a filler, and (deferred row) one referable deferred tool.
    const tools: ProviderToolSpec[] = [
      echoSpec,
      toolSearchSpec(row.nativeSearch === true),
      ...(row.deferred ? [{ name: REFERABLE, description: referableDefinition.description, inputSchema: referableDefinition.inputSchema, deferLoading: true as const }] : []),
    ];
    const request = (messages: ProviderMessage[]): ProviderRequest => ({ messages, system: SYSTEM, tools });

    // A: a call to a tool absent from `tools`, and its result, in the history.
    await ask(provider, "A (undeclared call + result in history)", request([
      user("Look up order 7."),
      toolUse("call_a1", UNDECLARED, { id: "7" }),
      toolResult("call_a1", "Order 7: shipped."),
      user("Thanks. Reply with one word."),
    ]));

    // B: the fork shape. Without client tool_search the definition rides the ToolSearch result as the
    // engine's own text; with it, `tool_search_output` carries it (`loadedToolDefinitions`).
    const searchResult = row.nativeSearch
      ? toolResult("call_s1", JSON.stringify({ matches: [UNDECLARED], query: `select:${UNDECLARED}`, total_deferred_tools: 1 }), { loadedTools: [UNDECLARED], loadedToolDefinitions: [lookupDefinition] })
      : toolResult("call_s1", `${JSON.stringify({ matches: [UNDECLARED], query: `select:${UNDECLARED}`, total_deferred_tools: 1 })}${undeclaredToolDefinitionsText([lookupDefinition])}`, { loadedTools: [UNDECLARED] });
    const bHistory: ProviderMessage[] = [
      user("Find the tool that looks up orders."),
      toolUse("call_s1", "ToolSearch", { query: `select:${UNDECLARED}` }),
      searchResult,
      user(`Now call ${UNDECLARED} for order 7.`),
    ];
    const b = await ask(provider, "B (fork shape: does the model call it?)", request(bHistory));

    // C: B's own output fed back (its call and a result), or a synthesized call when B made none.
    const call = b?.kind === "tool_use" ? b.calls.find((c) => c.name === UNDECLARED) : undefined;
    const callId = call?.id ?? "call_c1";
    const assistant: ProviderMessage =
      call !== undefined && b !== undefined
        ? { role: "assistant", content: (b.content ?? [{ type: "tool_use", id: call.id, name: call.name, input: call.input }]) as ContentBlock[], ...(b.nativeState !== undefined ? { nativeState: b.nativeState } : {}) }
        : toolUse(callId, UNDECLARED, { id: "7" });
    await ask(provider, `C (${call !== undefined ? "B's own call" : "synthesized call -- B made none"} fed back + one more turn)`, request([
      ...bHistory,
      assistant,
      toolResult(callId, "Order 7: shipped."),
      user("Thanks. Reply with one word."),
    ]));

    // C-mixed (deferred row): one referable + one undeclared name loaded by the same ToolSearch result.
    if (row.deferred) {
      await ask(provider, "C-mixed (references-only result + definition text after it)", request([
        user("Find the order tools."),
        toolUse("call_m1", "ToolSearch", { query: `select:${REFERABLE},${UNDECLARED}` }),
        toolResult("call_m1", `${JSON.stringify({ matches: [REFERABLE, UNDECLARED], query: `select:${REFERABLE},${UNDECLARED}`, total_deferred_tools: 2 })}${undeclaredToolDefinitionsText([lookupDefinition])}`, { loadedTools: [REFERABLE, UNDECLARED] }),
        user("Reply with one word."),
      ]));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Chat Completions on the `openai` provider: its adapter patched for this probe only. */
const openaiOnChatCompletions = (catalog: WinterCatalog): WinterCatalog => ({
  ...catalog,
  providers: catalog.providers.map((p) => (p.id === "openai" ? { ...p, adapterId: "winter.openai-chat-completions" } : p)),
});

const rows: Row[] = [
  { label: "anthropic-deferred", model: "anthropic/claude-opus-5-5", deferred: true },
  { label: "anthropic-plain", model: "anthropic/claude-sonnet-5" },
  { label: "responses-search", model: "openai/gpt-6-luna", nativeSearch: true },
  { label: "responses-plain", model: "openai/gpt-4.1-mini" },
  { label: "chat-openai", model: "openai/gpt-4.1-mini", patchCatalog: openaiOnChatCompletions },
  { label: "chat-deepseek", model: "deepseek/deepseek-flash" },
];

for (const row of rows) {
  if (!ROWS.has(row.label)) continue;
  try {
    await probeRow(row);
  } catch (err) {
    console.log(`  row failed: ${err instanceof Error ? err.name : "error"}`);
  }
}
globalThis.fetch = originalFetch;
