// WS-23: the LIVE probe for the api-key `xai` provider on the Responses adapter. Run by a human
// (the controller), never by a test and never by CI.
//
// WHAT IT CONFIRMS that the hermetic suite (`provider-runtime/src/adapters/openai/xai-responses.test.ts`)
// can only assume, because xAI documents these facts thinly or not at all:
//   1. the SSE event vocabulary `api.x.ai/v1/responses` really streams (xAI enumerates none; its own
//      OpenAI-SDK example reads BOTH `response.reasoning_text.delta` and
//      `response.reasoning_summary_text.delta`; Winter's mapper surfaces both since fix round 1, and
//      the per-type counts show which one xAI actually sends);
//   2. that a reasoning item comes back with `encrypted_content`, and that replaying it verbatim on a
//      `store: false` follow-up is accepted;
//   3. a function-call round trip on the Responses shape;
//   4. a multi-agent turn (the Responses-only row) with no tools — and no tool surface on the wire —
//      then a follow-up REPLAYING its encrypted items (4b), since multi-agent's documented multi-turn
//      path is `previous_response_id`, which Winter never uses;
//   5. that effortless turns get the encrypted item back now that an opaque-continuation row asks for
//      it on every turn (fix round 1, I3): `grok-4.6` (5a), and the two rows that take NO effort at all,
//      `grok-4.20-0309-reasoning` (5b) and `grok-build-0.1` (5c) — the rows whose `continuation` claim
//      rests on this answer;
//   6. the ERROR body shape and status for a wrong key (free: it is refused before inference).
//
// IT DRIVES THE SHIPPED WIRING, not a hand-built request: `createShippedAdapters(loadCatalog())`'s
// Responses adapter on a connection with NO `baseUrl`, so every request also proves the base-URL rule
// against the real host (each request's URL is printed).
//
// NOTHING SECRET IS EVER PRINTED. The key is read from the macOS Keychain — the brand's DEV service
// (`DEFAULT_KEYCHAIN_SERVICE` + `.dev`, derived rather than spelled so the brand sweep gate stays
// green), account `xai:default` — READ ONLY, through the runtime's own Keychain store (the one
// file allowed to reach the secrets API; see the tripwire in `keychain-store.test.ts`), handed to the
// adapter as a credential store, and never touched as a string here. Output is event TYPE names and
// counts, item keys, lengths, token counts, stop reasons, status codes and normalized error codes.
// Never model text, never reasoning text, never the encrypted payload, never an error message a
// vendor might echo a key into (the wrong-key step uses a fake key, and prints the message's
// leading words only).
//
// COST: nine small generations (grok-4.7 at effort `low`, three effortless one-word turns, two
// multi-agent turns at 4 agents). Keep the prompts tiny.
//
// Usage (from the worktree root):
//   WINTER_XAI_PROBE=1 bun run scripts/probe-xai-responses.ts
// Without `WINTER_XAI_PROBE=1` it prints one line and exits 0, so a stray `bun run` costs nothing.
// The first Keychain read may raise a macOS consent prompt for `bun`; "Allow" once is enough.

import { loadCatalog } from "../packages/provider-catalog/src/index.ts";
import { createShippedAdapters } from "../packages/provider-runtime/src/adapters/index.ts";
import { createMemoryCredentialStore } from "../packages/provider-runtime/src/credentials/memory.ts";
import { CredentialResolutionError } from "../packages/provider-runtime/src/credentials/types.ts";
import type { CredentialMaterial, CredentialRef, CredentialStore, ProviderAdapter, ProviderContext, ProviderEvent, ProviderMessageLike, TurnRequest } from "../packages/provider-runtime/src/types.ts";
import { DEFAULT_KEYCHAIN_SERVICE, createKeychainCredentialStore, createKeychainSecretReader } from "../packages/runtime/src/provider/keychain-store.ts";

/** The dev profile's Keychain service — where the Winter dev daemon stores `xai:default`. Read, never written. */
const KEYCHAIN_SERVICE = `${DEFAULT_KEYCHAIN_SERVICE}.dev`;
const KEYCHAIN_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "xai:default", service: KEYCHAIN_SERVICE };

// --- raw wire observation (event TYPES and shapes only) ---------------------------------------------

interface WireRecord {
  url: string;
  status: number;
  /** What the REQUEST carried, as shape only: model, include, the reasoning object, counts. */
  sent: string;
  /** SSE `type` -> count, in first-seen order. */
  eventTypes: Map<string, number>;
  /** One line per completed output item: its type, its keys, and the encrypted payload's LENGTH. */
  items: string[];
  /** `response.completed`'s usage object, numbers only. */
  usage: unknown;
  /** For a non-2xx: the error body's top-level keys and the JS type of `error`. */
  errorShape?: string;
  done: Promise<void>;
}

const wire: WireRecord[] = [];

/** The request body's shape, never its text: which knobs were on the wire, and how many replayed reasoning items. */
function describeRequest(body: unknown): string {
  if (typeof body !== "string") return "(no body)";
  try {
    const b = JSON.parse(body) as { model?: unknown; include?: unknown; reasoning?: unknown; input?: unknown; tools?: unknown; store?: unknown; max_output_tokens?: unknown };
    const replayed = Array.isArray(b.input) ? b.input.filter((i) => (i as { type?: unknown } | null)?.type === "reasoning").length : 0;
    // "absent" is the M2 shape: a tool-less request sends no tool surface at all.
    const tools = Array.isArray(b.tools) ? String(b.tools.length) : "absent";
    return `model=${String(b.model)} include=${JSON.stringify(b.include)} reasoning=${JSON.stringify(b.reasoning ?? null)} store=${String(b.store)} replayed_reasoning_items=${replayed} tools=${tools}${b.max_output_tokens !== undefined ? " max_output_tokens=set" : ""}`;
  } catch {
    return "(unparseable body)";
  }
}

/** Numbers and nested number objects only — a usage object carries nothing else worth printing. */
function numbersOnly(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const kept = numbersOnly(v);
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

function describeItem(item: Record<string, unknown>): string {
  const keys = Object.keys(item).sort().join(",");
  const enc = typeof item.encrypted_content === "string" ? ` encrypted_content=${item.encrypted_content.length} chars` : " encrypted_content=absent";
  const summary = Array.isArray(item.summary) ? ` summary_parts=${item.summary.length}` : "";
  return `${String(item.type)} {${keys}}${item.type === "reasoning" ? enc + summary : ""}`;
}

async function observeSse(body: ReadableStream<Uint8Array>, record: WireRecord): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        record.eventTypes.set("[DONE]", (record.eventTypes.get("[DONE]") ?? 0) + 1);
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        record.eventTypes.set("(unparseable)", (record.eventTypes.get("(unparseable)") ?? 0) + 1);
        continue;
      }
      const type = typeof payload.type === "string" ? payload.type : "(no type)";
      record.eventTypes.set(type, (record.eventTypes.get(type) ?? 0) + 1);
      if (type === "response.output_item.done" && payload.item !== null && typeof payload.item === "object") record.items.push(describeItem(payload.item as Record<string, unknown>));
      if (type === "response.completed") record.usage = numbersOnly((payload.response as { usage?: unknown } | undefined)?.usage);
    }
  }
}

function installWireObserver(): () => void {
  const original = globalThis.fetch;
  const observed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await original(input as Parameters<typeof fetch>[0], init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const record: WireRecord = { url, status: response.status, sent: describeRequest(init?.body), eventTypes: new Map(), items: [], usage: undefined, done: Promise.resolve() };
    wire.push(record);
    if (!response.ok) {
      const text = await response.clone().text();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        record.errorShape = `keys [${Object.keys(parsed).sort().join(", ")}], error is ${Array.isArray(parsed.error) ? "array" : typeof parsed.error}`;
      } catch {
        record.errorShape = `not JSON (${text.length} bytes)`;
      }
      return response;
    }
    if (response.body === null || !(response.headers.get("content-type") ?? "").includes("event-stream")) return response;
    const [forAdapter, forProbe] = response.body.tee();
    record.done = observeSse(forProbe, record).catch(() => {});
    return new Response(forAdapter, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  globalThis.fetch = observed as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// --- the credential, from the Keychain, never as a printed string ------------------------------------

/**
 * The dev Keychain item as a credential store. The runtime's store expects JSON `CredentialMaterial`
 * (what this SDK writes); a host may have stored the BARE key instead, so a `malformed` answer falls
 * back to the raw reader. Either way the value goes straight into an in-memory store the adapter
 * reads, and this file never logs, prints or inspects it.
 */
async function devKeychainCredentials(): Promise<CredentialStore> {
  let material: CredentialMaterial | null;
  try {
    material = await createKeychainCredentialStore(KEYCHAIN_SERVICE).get(KEYCHAIN_REF);
  } catch (err) {
    if (!(err instanceof CredentialResolutionError) || err.code !== "malformed") throw err;
    const raw = await createKeychainSecretReader(KEYCHAIN_SERVICE)(KEYCHAIN_REF);
    material = raw !== null && raw.trim().length > 0 ? { kind: "api-key", key: raw.trim() } : null;
  }
  if (material === null) throw new Error(`no Keychain item at service ${KEYCHAIN_SERVICE}, account ${KEYCHAIN_REF.account} — store the dev xAI key there first`);
  return createMemoryCredentialStore([[KEYCHAIN_REF, material]]);
}

function contextWith(credentials: CredentialStore, authRef: CredentialRef): ProviderContext {
  // NO `baseUrl`: the endpoint must come from the `xai` catalog row through the shipped wiring.
  return { connection: { providerId: "xai" }, credentials, authRef, stallTimeoutMs: 180_000, log: () => {} };
}

// --- one turn, reported ----------------------------------------------------------------------------------

interface TurnReport {
  events: ProviderEvent[];
  text: string;
  nativeItems: unknown[] | undefined;
  toolCalls: Array<{ id: string; name: string; args: string }>;
}

async function runTurn(label: string, adapter: ProviderAdapter, ctx: ProviderContext, req: TurnRequest): Promise<TurnReport> {
  const before = wire.length;
  const events: ProviderEvent[] = [];
  const started = Date.now();
  for await (const event of adapter.streamTurn(req, ctx)) events.push(event);
  const records = wire.slice(before);
  await Promise.all(records.map((r) => r.done));

  const text = events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
  const nativeItems = events.find((e): e is Extract<ProviderEvent, { type: "native_state" }> => e.type === "native_state")?.items;
  const toolCalls = new Map<string, { id: string; name: string; args: string }>();
  for (const e of events) {
    if (e.type === "tool_call_start") toolCalls.set(e.id, { id: e.id, name: e.name, args: "" });
    if (e.type === "tool_call_delta") toolCalls.get(e.id)!.args += e.argumentsJsonDelta;
  }
  const normalizedCounts = new Map<string, number>();
  for (const e of events) normalizedCounts.set(e.type, (normalizedCounts.get(e.type) ?? 0) + 1);

  console.log(`\n=== ${label} (${Date.now() - started} ms)`);
  for (const r of records) {
    const u = new URL(r.url);
    console.log(`  wire: POST ${u.host}${u.pathname} -> HTTP ${r.status}`);
    console.log(`  wire sent: ${r.sent}`);
    if (r.errorShape !== undefined) console.log(`  wire error body: ${r.errorShape}`);
    if (r.eventTypes.size > 0) console.log(`  wire SSE types: ${[...r.eventTypes].map(([t, n]) => `${t}×${n}`).join(", ")}`);
    for (const item of r.items) console.log(`  wire item done: ${item}`);
    if (r.usage !== undefined) console.log(`  wire usage: ${JSON.stringify(r.usage)}`);
  }
  console.log(`  normalized events: ${[...normalizedCounts].map(([t, n]) => `${t}×${n}`).join(", ")}`);
  const start = events.find((e): e is Extract<ProviderEvent, { type: "message_start" }> => e.type === "message_start");
  if (start?.model !== undefined) console.log(`  response model: ${start.model}`);
  const usage = events.find((e) => e.type === "usage");
  if (usage !== undefined) console.log(`  normalized usage: ${JSON.stringify(usage)}`);
  console.log(`  native_state: ${nativeItems === undefined ? "none" : `${nativeItems.length} item(s), encrypted lengths [${nativeItems.map((i) => String((i as { encrypted_content?: string }).encrypted_content?.length ?? 0)).join(", ")}]`}`);
  const summaryChars = events.reduce((n, e) => n + (e.type === "thinking_summary_delta" ? e.text.length : 0), 0);
  console.log(`  summary text surfaced: ${summaryChars} chars; answer text: ${text.length} chars; tool calls: ${[...toolCalls.values()].map((c) => c.name).join(", ") || "none"}`);
  const done = events.find((e) => e.type === "done");
  if (done !== undefined) console.log(`  stop reason: ${done.stopReason}`);
  for (const e of events) if (e.type === "error") console.log(`  ERROR: code=${e.error.code} status=${e.error.status ?? "-"} providerCode=${e.error.providerCode ?? "-"} retryable=${e.error.retryable}`);
  return { events, text, nativeItems, toolCalls: [...toolCalls.values()] };
}

// --- the probe ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.WINTER_XAI_PROBE !== "1") {
    console.log("probe-xai-responses: set WINTER_XAI_PROBE=1 to run it (it spends a few cents on the dev xAI key). Nothing was sent.");
    return;
  }
  const adapter = createShippedAdapters(loadCatalog()).find((a) => a.id === "winter.openai-responses");
  if (adapter === undefined) throw new Error("the shipped wiring has no winter.openai-responses adapter");
  const restore = installWireObserver();
  try {
    const credentials = await devKeychainCredentials();
    const ctx = contextWith(credentials, KEYCHAIN_REF);

    // 1. A reasoning turn on grok-4.7, asking for the encrypted item and a summary.
    const q1 = "What is 17 * 23? Reply with the number only.";
    const first = await runTurn("1. grok-4.7 reasoning turn (effort low, summary requested)", adapter, ctx, {
      model: "grok-4.7",
      effort: "low",
      requestSummary: true,
      messages: [{ role: "user", content: q1 }],
    });

    // 2. The same conversation, replaying turn 1's encrypted item verbatim (`store: false` throughout).
    if (first.nativeItems !== undefined && first.nativeItems.length > 0) {
      const history: ProviderMessageLike[] = [
        { role: "user", content: q1 },
        { role: "assistant", content: first.text, nativeState: { family: "openai", continuationDomain: "xai/grok-4.7", items: first.nativeItems } },
        { role: "user", content: "Add 1 to that. Reply with the number only." },
      ];
      await runTurn("2. grok-4.7 follow-up REPLAYING turn 1's encrypted reasoning", adapter, ctx, { model: "grok-4.7", effort: "low", messages: history });
    } else {
      console.log("\n=== 2. SKIPPED: turn 1 returned no encrypted reasoning item to replay (itself a finding)");
    }

    // 3. A function-call round trip.
    const tool = { name: "get_weather", description: "Current weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
    const ask3: ProviderMessageLike = { role: "user", content: "Use the get_weather tool to check Paris, then tell me in five words." };
    const call = await runTurn("3a. grok-4.7 function call (tool_choice required)", adapter, ctx, { model: "grok-4.7", effort: "low", tools: [tool], toolChoice: { type: "any" }, messages: [ask3] });
    const firstCall = call.toolCalls[0];
    if (firstCall !== undefined) {
      const history: ProviderMessageLike[] = [
        ask3,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: firstCall.id, name: firstCall.name, input: firstCall.args.length > 0 ? (JSON.parse(firstCall.args) as unknown) : {} }],
          ...(call.nativeItems !== undefined ? { nativeState: { family: "openai", continuationDomain: "xai/grok-4.7", items: call.nativeItems } } : {}),
        },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: firstCall.id, content: "18°C, light rain" }] },
      ];
      await runTurn("3b. grok-4.7 function result -> final answer", adapter, ctx, { model: "grok-4.7", effort: "low", tools: [tool], messages: history });
    } else {
      console.log("\n=== 3b. SKIPPED: turn 3a produced no tool call");
    }

    // 4. The Responses-only multi-agent row, no tools, 4 agents — then a follow-up replaying its items.
    const MULTI = "grok-4.20-multi-agent-0309";
    const q4 = "In one sentence: why is the sky blue?";
    const multi = await runTurn("4a. grok-4.20-multi-agent-0309 (effort low = 4 agents, no tools)", adapter, ctx, { model: MULTI, effort: "low", messages: [{ role: "user", content: q4 }] });
    if (multi.nativeItems !== undefined && multi.nativeItems.length > 0) {
      await runTurn("4b. multi-agent follow-up REPLAYING 4a's encrypted items (store: false)", adapter, ctx, {
        model: MULTI,
        effort: "low",
        messages: [
          { role: "user", content: q4 },
          { role: "assistant", content: multi.text, nativeState: { family: "openai", continuationDomain: `xai/${MULTI}`, items: multi.nativeItems } },
          { role: "user", content: "Now say it in five words." },
        ],
      });
    } else {
      console.log("\n=== 4b. SKIPPED: 4a returned no encrypted item to replay — the multi-agent row's `opaque-provider-state` claim is then UNSUPPORTED (a finding)");
    }

    // 5. EFFORTLESS turns. Since fix round 1 (I3) an opaque-continuation row sends `include` on every
    // turn, so each should come back with an encrypted item. For 5b/5c that answer is the whole basis
    // of the row's `continuation: "opaque-provider-state"`; "native_state: none" there is a finding.
    for (const [label, model] of [
      ["5a. grok-4.6 effortless turn (include sent, no reasoning object)", "grok-4.6"],
      ["5b. grok-4.20-0309-reasoning (takes no effort) — does the encrypted item come back?", "grok-4.20-0309-reasoning"],
      ["5c. grok-build-0.1 (takes no effort) — does the encrypted item come back?", "grok-build-0.1"],
    ] as const) {
      await runTurn(label, adapter, ctx, { model, messages: [{ role: "user", content: "Reply with OK." }] });
    }

    // 6. A WRONG key (a fake literal, never the real one): the error body's shape and status, and Winter's classification.
    const fakeKey: CredentialRef = { kind: "inline", value: "xai-winter-probe-not-a-real-key-0000000000" };
    const wrong = await runTurn("6. wrong key -> error shape + classification", adapter, contextWith(createMemoryCredentialStore(), fakeKey), {
      model: "grok-4.7",
      effort: "low",
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    const error = wrong.events.find((e): e is Extract<ProviderEvent, { type: "error" }> => e.type === "error")?.error;
    if (error !== undefined) console.log(`  message begins: ${JSON.stringify(error.message.split(" ").slice(0, 7).join(" "))}`);

    // Pre-flight refusals (no request is made; printed so the report shows the typed codes).
    const refusal = await runTurn("7. multi-agent + tools -> refused BEFORE the request (expect no wire line)", adapter, ctx, { model: "grok-4.20-multi-agent-0309", tools: [tool], messages: [{ role: "user", content: "x" }] });
    void refusal;
  } finally {
    restore();
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // A CredentialResolutionError's message is ref-redacted by construction; anything else is reported by name only.
    console.error(`probe-xai-responses failed: ${err instanceof CredentialResolutionError || (err instanceof Error && err.message.startsWith("no Keychain item")) ? err.message : err instanceof Error ? err.name : "unknown error"}`);
    process.exitCode = 1;
  });
}
