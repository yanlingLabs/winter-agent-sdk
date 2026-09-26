// WS-23 (reasoning-state): the LIVE probe for Claude -> GPT -> Claude. Run by a human (the controller),
// never by a test and never by CI.
//
// WHAT IT CONFIRMS that the hermetic suite (`runtime/src/provider/switch-return.test.ts`, against
// loopback fakes) can only assume, because only the real APIs can say it:
//   1. Claude's thinking -- moved out of the transcript into the provider-state sidecar -- is spliced
//      back BYTE-IDENTICALLY: the API accepts the replayed signed blocks after a resume (a 400 on an
//      edited or reordered block would show here) and the block-binding row keeps them;
//   2. GPT gets none of it natively: no signature on its wire, only the capped `<recovered_reasoning>`
//      decoration, and none of Claude's effort markers or tool changes;
//   3. back on Claude within the cache lifetime, the CACHE HOLDS: `cache_read_input_tokens` on the
//      return request covers Claude's earlier prefix (its tool epoch resumed, `tools` unchanged, its
//      top-level effort restored), and `diagnostics` reports no divergence before GPT's turn.
//
// IT DRIVES THE SHIPPED ENGINE AND STORE, not a hand-built request: three incarnations of one session
// through `resolveEngineSession` (the real transcript + sidecar under a temp home) and
// `buildSessionProvider`'s real catalog-resolved providers -- a cross-provider switch is a new
// incarnation in production too (the daemon evicts the child and resumes it on the new model).
//
// NOTHING SECRET IS EVER PRINTED. Keys come from the macOS Keychain's DEV service, READ ONLY
// (`anthropic:default`, and `openai:default` or `codex-oauth:default` for the GPT leg), through the
// runtime's own Keychain store. Output is counts, token numbers, field names and verdicts -- never
// model text, never a signature, never an encrypted payload.
//
// COST: five requests -- two on claude-opus-5-5 (Winter's own system prompt and tools; the second mostly
// cache reads), one on the GPT row, one on claude-opus-5-5 again (mostly cache reads). Pick the GPT leg
// with WINTER_SWITCH_PROBE_GPT (default `openai/gpt-6-sol`; `codex-oauth/gpt-6-sol` uses the ChatGPT
// sign-in instead of an API key -- its token must be fresh, the store is read-only).
//
// Usage (from the worktree root):
//   WINTER_SWITCH_PROBE=1 bun run scripts/probe-switch-return.ts
// DRY RUN (free, no Keychain, no network): add WINTER_SWITCH_PROBE_DRY_RUN=1 -- canned responders for
// both vendors check the probe's plumbing; its numbers are fabricated.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "../packages/sdk/src/index.ts";
import { loadCatalog } from "../packages/provider-catalog/src/index.ts";
import type { CredentialMaterial, CredentialRef, CredentialStore } from "../packages/provider-runtime/src/types.ts";
import { DEFAULT_KEYCHAIN_SERVICE, createKeychainCredentialStore } from "../packages/runtime/src/provider/keychain-store.ts";
import { buildSessionProvider, loadResumedChain } from "../packages/runtime/src/provider/session-provider.ts";
import { createInMemoryChannel } from "../packages/runtime/src/protocol/channel.ts";
import { runEngine, type EngineOptions } from "../packages/runtime/src/engine.ts";
import { createSystemPromptAssembler } from "../packages/runtime/src/context/assembler.ts";
import { describeCatalogModel } from "../packages/runtime/src/production-wiring.ts";
import { resolveEngineSession } from "../packages/runtime/src/store/dialect.ts";

const CLAUDE = "anthropic/claude-opus-5-5";
const GPT = process.env["WINTER_SWITCH_PROBE_GPT"] ?? "openai/gpt-6-sol";
const KEYCHAIN_SERVICE = `${DEFAULT_KEYCHAIN_SERVICE}.dev`;

if (process.env["WINTER_SWITCH_PROBE"] !== "1") {
  console.log("probe-switch-return: set WINTER_SWITCH_PROBE=1 to run (it calls the PAID Anthropic and OpenAI APIs with the dev Keychain's keys)");
  process.exit(0);
}
const DRY_RUN = process.env["WINTER_SWITCH_PROBE_DRY_RUN"] === "1";

// --- the dev-pinned, read-only credential store --------------------------------------------------------

const devKeychain = createKeychainCredentialStore(KEYCHAIN_SERVICE);
const credentials: CredentialStore = {
  async get(ref: CredentialRef): Promise<CredentialMaterial | null> {
    if (ref.kind !== "keychain") return null;
    if (DRY_RUN) return ref.account.startsWith("codex-oauth") ? { kind: "oauth", accessToken: "dry-run", refreshToken: "dry-run", accountId: "dry-run" } as CredentialMaterial : { kind: "api-key", key: "dry-run-not-a-key" };
    return await devKeychain.get({ ...ref, service: KEYCHAIN_SERVICE });
  },
  async set(): Promise<void> {
    throw new Error("probe-switch-return: the credential store is read-only");
  },
  async delete(): Promise<void> {
    throw new Error("probe-switch-return: the credential store is read-only");
  },
};

// --- the wire observer ----------------------------------------------------------------------------------

interface Observed {
  label: string;
  vendor: "anthropic" | "openai";
  status: number;
  shape: string;
  usage?: string;
  error?: string;
}
const observed: Observed[] = [];
let currentLabel = "setup";
/** Per Claude request, the messages it sent (for the prefix check) and its tools (for the epoch check). */
const claudeBodies: Array<{ messages: unknown[]; tools: unknown }> = [];

const strip = (value: unknown): string => JSON.stringify(JSON.parse(JSON.stringify(value)), (key, v) => (key === "cache_control" ? undefined : v));

function describeClaude(body: Record<string, unknown>): string {
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as Array<Record<string, unknown>>) : [];
  const blocks = messages.flatMap((m) => (Array.isArray(m["content"]) ? (m["content"] as Array<Record<string, unknown>>) : []));
  const signed = blocks.filter((b) => b["type"] === "thinking" && typeof b["signature"] === "string" && (b["signature"] as string).length > 0).length;
  const redacted = blocks.filter((b) => b["type"] === "redacted_thinking").length;
  const markers = messages.filter((m) => m["role"] === "system" && m["output_config"] !== undefined).map((m) => (m["output_config"] as { effort: string }).effort);
  const decorations = JSON.stringify(messages).split("recovered_reasoning").length - 1;
  const prev = claudeBodies.at(-1);
  const prefix = prev === undefined ? "n/a (first)" : strip(messages.slice(0, prev.messages.length)) === strip(prev.messages) ? "YES" : "NO";
  const sameTools = prev === undefined ? "n/a" : JSON.stringify(body["tools"]) === JSON.stringify(prev.tools) ? "same" : "CHANGED";
  claudeBodies.push({ messages, tools: body["tools"] });
  return `messages=${messages.length} signed_thinking=${signed} redacted=${redacted} decorations=${decorations} effort_markers=${JSON.stringify(markers)} top_level=${JSON.stringify(body["output_config"] ?? null)} tools=${sameTools} previous_claude_request_is_a_prefix=${prefix}`;
}

function describeGpt(raw: string, body: Record<string, unknown>): string {
  const input = Array.isArray(body["input"]) ? (body["input"] as Array<Record<string, unknown>>) : [];
  const types = input.map((i) => String(i["type"] ?? i["role"]));
  return `input=${input.length} types=${JSON.stringify(types)} signature_key_on_wire=${raw.includes('"signature"')} decorations=${raw.split("recovered_reasoning").length - 1} configuration_updates=${types.filter((t) => t === "configuration_update").length} additional_tools=${types.filter((t) => t === "additional_tools").length}`;
}

function canned(url: string, body: Record<string, unknown>): Response {
  if (url.includes("/v1/messages")) {
    const events = [
      { type: "message_start", message: { id: `msg_dry_${observed.length}`, model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, diagnostics: null } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "dry thoughts" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `dry-sig-${observed.length}` } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }
  const model = typeof body["model"] === "string" ? body["model"] : "gpt";
  const frames = [
    { type: "response.created", response: { id: "resp_dry", model, output: [] } },
    { type: "response.output_item.done", output_index: 0, item: { id: "rs_0", type: "reasoning", summary: [], encrypted_content: "dry-enc" } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "ok" },
    { type: "response.output_item.done", output_index: 1, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
    { type: "response.completed", response: { id: "resp_dry", model, status: "completed", usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } }, output: [] } },
  ];
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const isClaude = url.includes("/v1/messages");
  const isGpt = url.endsWith("/responses");
  // The dry run never touches the network, for any URL.
  if (!isClaude && !isGpt) return DRY_RUN ? new Response("dry run: no network", { status: 404 }) : originalFetch(input, init);
  const raw = typeof init?.body === "string" ? init.body : "";
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const response = DRY_RUN ? canned(url, body) : await originalFetch(input, init);
  const record: Observed = { label: currentLabel, vendor: isClaude ? "anthropic" : "openai", status: response.status, shape: isClaude ? describeClaude(body) : describeGpt(raw, body) };
  observed.push(record);
  if (!response.ok) {
    const text = await response.clone().text().catch(() => "(unreadable body)");
    record.error = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    return response;
  }
  if (response.body === null) return response;
  const [forAdapter, forObserver] = response.body.tee();
  void (async () => {
    const text = await new Response(forObserver).text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (payload["type"] === "message_start") {
          const message = (payload["message"] ?? {}) as Record<string, unknown>;
          const usage = (message["usage"] ?? {}) as Record<string, unknown>;
          const diagnostics = message["diagnostics"];
          const reason = diagnostics !== null && typeof diagnostics === "object" ? (diagnostics as Record<string, unknown>)["cache_miss_reason"] : undefined;
          record.usage = `input=${String(usage["input_tokens"])} cache_read=${String(usage["cache_read_input_tokens"])} cache_creation=${String(usage["cache_creation_input_tokens"])} diagnostics=${diagnostics === undefined ? "absent" : diagnostics === null ? "null" : JSON.stringify(reason === null ? null : { type: (reason as Record<string, unknown> | undefined)?.["type"] })}`;
        }
        if (payload["type"] === "response.completed") {
          const usage = ((payload["response"] as Record<string, unknown> | undefined)?.["usage"] ?? {}) as Record<string, unknown>;
          const cached = ((usage["input_tokens_details"] ?? {}) as Record<string, unknown>)["cached_tokens"];
          record.usage = `input=${String(usage["input_tokens"])} cached=${String(cached)}`;
        }
      } catch {
        /* not JSON */
      }
    }
  })();
  return new Response(forAdapter, { status: response.status, statusText: response.statusText, headers: response.headers });
}) as typeof fetch;

// --- the incarnations -------------------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), "winter-switch-probe-home-"));
const cwd = mkdtempSync(join(tmpdir(), "winter-switch-probe-cwd-"));
const sessionId = `ws23-switch-probe-${Date.now()}`;
const catalog = loadCatalog();

async function incarnation(model: string, effort: string, turns: Array<{ text: string; label: string } | { effort: string }>, resume: boolean): Promise<void> {
  const providerId = model.slice(0, model.indexOf("/"));
  const config = {
    sessionId,
    cwd,
    model,
    effort,
    winterHome: home,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    provider: { providerId, authRef: { kind: "keychain", account: `${providerId}:default`, service: KEYCHAIN_SERVICE } },
    ...(resume ? { resume: sessionId } : {}),
  } as unknown as RuntimeConfig;
  const resolved = await resolveEngineSession({ config, resolveWinterHome: () => home, env: {} });
  const chain = await loadResumedChain(resolved.store, resolved.initialMessages);
  const wiring = buildSessionProvider({ config: resolved.config, env: {}, catalog, credentials, chain: () => chain });
  const identity = wiring.identity;
  if (identity === undefined) throw new Error(`probe-switch-return: ${model} did not resolve`);
  const { host, runtime } = createInMemoryChannel();
  const frames: WinterFrame[] = [];
  const done = runEngine({
    config: resolved.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: String(wiring.resolved!.adapter.family), ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
    ...(wiring.resolveModelSwitch !== undefined ? { resolveModelSwitch: wiring.resolveModelSwitch } : {}),
    describeModel: (m: string, p?: string) => describeCatalogModel(catalog, m, p),
    systemPromptAssembler: createSystemPromptAssembler({ home, settings: () => ({}) }),
    ...(resolved.store !== undefined ? { store: resolved.store } : {}),
    ...(resolved.initialMessages.length > 0 ? { initialMessages: resolved.initialMessages } : {}),
  } as EngineOptions);
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): Array<Record<string, unknown>> => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as unknown as { message: Record<string, unknown> }).message);
  for (const step of turns) {
    if ("effort" in step) {
      const id = `effort-${Date.now()}`;
      host.output.write({ type: "control_request", requestId: id, subtype: "set_effort", payload: { effort: step.effort } });
      for (let n = 0; n < 200 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === id); n++) await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    currentLabel = step.label;
    const before = results().length;
    host.output.write({ type: "user", text: step.text });
    for (let n = 0; n < 6000 && results().length <= before; n++) await new Promise((r) => setTimeout(r, 50));
    const result = results()[before];
    console.log(`[${step.label}] result: is_error=${String(result?.["is_error"])}${result?.["is_error"] === true ? ` (${String(result?.["terminal_reason"] ?? result?.["subtype"])})` : ""}`);
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
}

try {
  await incarnation(CLAUDE, "high", [
    { text: "Think briefly, then reply with the single word: one.", label: "1. Claude turn one" },
    { effort: "low" },
    { text: "Reply with the single word: two.", label: "2. Claude turn two (effort low, a marker)" },
  ], false);
  await incarnation(GPT, "medium", [{ text: "Reply with the single word: three.", label: `3. ${GPT} after the switch (resume)` }], true);
  await incarnation(CLAUDE, "low", [{ text: "Reply with the single word: four.", label: "4. back on Claude (resume, within the cache lifetime)" }], true);

  console.log("\n=== per request ===");
  observed.forEach((o, i) => console.log(`\n#${i + 1} [${o.label}] ${o.vendor} HTTP ${o.status}\n  sent:  ${o.shape}\n  usage: ${o.usage ?? "(none)"}${o.error !== undefined ? `\n  error: ${o.error}` : ""}`));
  console.log(
    "\nREAD IT AS: #1-#2 Claude -- signed_thinking grows by turn one's block(s) on #2, prefix YES. #3 GPT -- signature_key_on_wire=false, decorations>=1, configuration_updates only GPT's own leading level, no additional_tools. #4 Claude again -- HTTP 200 (the spliced signed blocks were accepted), signed_thinking back, tools=same (epoch resumed), previous_claude_request_is_a_prefix=YES, effort markers [high, low] with top_level high, and cache_read covering about #2's input (the cache held across the switch). A 400 on #4 naming a thinking block means the splice is not byte-identical.",
  );
} finally {
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
