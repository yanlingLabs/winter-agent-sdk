// WS-23: the LIVE probe for Claude CODE-MODE on the Winter SDK's Anthropic adapter. Run by a human
// (the controller), never by a test and never by CI.
//
// WHAT IT CONFIRMS that the hermetic suite (`provider-runtime/src/adapters/anthropic/messages.hardening.test.ts`,
// `runtime/src/provider/anthropic-code-mode.test.ts`) can only assume, because the loopback fakes there
// accept whatever Winter sends:
//   1. A 3-round TOOL LOOP WITH ADAPTIVE THINKING on `claude-opus-5-5` and on `claude-sonnet-5`: the
//      block order of every response (thinking / text / tool_use interleaving) is printed, and each
//      following request REPLAYS the previous turn's content in that exact stream order (the fold's
//      `turn.content`, WS-23 item 1). "HTTP 200 on rounds 2 and 3" is the confirmation that Anthropic
//      accepts Winter's replay -- signatures, order and all -- including under Opus 5.5's block binding.
//   2. WebSearch on `claude-fable-5-1` through the REAL executor (seed search on Exa's anonymous tier,
//      then the inner model with NO forced tool_choice, WS-23 item 6): the result must carry links and
//      an answer, never "Web search was not performed".
//   3. An Opus 5 request at effort `xhigh` with thinking DISABLED: the adapter must rewrite it to
//      adaptive (the catalog's conjunction token, item 8) and the vendor must answer 200, not 400.
//   4. ONE Console turn (`console` provider, bearer from `anthropic:console`) IF that dev Keychain item
//      exists -- the headers sent (beta list, user-agent) and the status. Skipped with one line if not.
//
// IT DRIVES THE SHIPPED WIRING: `createShippedAdapters(loadCatalog())`'s Anthropic adapter on a
// connection with NO `baseUrl` (the real `api.anthropic.com`), folded by the runtime's own
// `foldProviderStream`; WebSearch runs through `buildSessionProvider` exactly as a session would.
//
// NOTHING SECRET IS EVER PRINTED. Keys are read from the macOS Keychain -- the brand's DEV service
// (`DEFAULT_KEYCHAIN_SERVICE` + `.dev`), accounts `anthropic:default` and (optionally)
// `anthropic:console` -- READ ONLY, through the runtime's own Keychain store (the one file allowed to
// reach the secrets API; the tripwire in `keychain-store.test.ts` covers this directory too), handed to
// the adapter as an in-memory credential store and never touched as a string here. Output is block
// TYPE sequences, stop reasons, statuses, header NAMES and beta values, lengths and token counts.
// Never model text, never thinking text, never a signature, never an auth header.
//
// COST: ~10 small generations at effort `low` plus one WebSearch pass (one Exa search on the anonymous
// tier + one Fable 5.1 generation). A few cents on the dev key.
//
// Usage (from the worktree root):
//   WINTER_ANTHROPIC_PROBE=1 bun run scripts/probe-anthropic-code.ts
// Without `WINTER_ANTHROPIC_PROBE=1` it prints one line and exits 0, so a stray `bun run` costs nothing.
// The first Keychain read may raise a macOS consent prompt for `bun`; "Allow" once is enough.

import { loadCatalog } from "../packages/provider-catalog/src/index.ts";
import { createShippedAdapters } from "../packages/provider-runtime/src/adapters/index.ts";
import { createMemoryCredentialStore } from "../packages/provider-runtime/src/credentials/memory.ts";
import { CredentialResolutionError } from "../packages/provider-runtime/src/credentials/types.ts";
import type { ContentBlockLike, CredentialMaterial, CredentialRef, CredentialStore, ProviderAdapter, ProviderContext, ProviderMessageLike, TurnRequest } from "../packages/provider-runtime/src/types.ts";
import { DEFAULT_KEYCHAIN_SERVICE, createKeychainCredentialStore, createKeychainSecretReader } from "../packages/runtime/src/provider/keychain-store.ts";
import { foldProviderStream } from "../packages/runtime/src/provider/bridge.ts";
import { buildSessionProvider } from "../packages/runtime/src/provider/session-provider.ts";
import { registerWebSessionRuntime } from "../packages/runtime/src/web/session-runtime.ts";
import { createWebSearchExecutor } from "../packages/runtime/src/tools/impl/web-search.ts";
import type { ToolExecutionContext } from "../packages/runtime/src/tools/registry.ts";
import { resolveWebToolsConfig, type RuntimeConfig } from "../packages/sdk/src/index.ts";

/** The dev profile's Keychain service -- where the Winter dev daemon stores provider credentials. Read, never written. */
const KEYCHAIN_SERVICE = `${DEFAULT_KEYCHAIN_SERVICE}.dev`;
const API_KEY_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "anthropic:default", service: KEYCHAIN_SERVICE };
const CONSOLE_REF: Extract<CredentialRef, { kind: "keychain" }> = { kind: "keychain", account: "anthropic:console", service: KEYCHAIN_SERVICE };

// --- raw wire observation (shapes only) ------------------------------------------------------------

interface WireRecord {
  host: string;
  status: number;
  /** What the REQUEST carried, as shape only. */
  sent: string;
  /** Header NAMES and the two non-secret values worth seeing. Never an auth header's value. */
  headers: string;
}

const wire: WireRecord[] = [];

function describeRequest(body: unknown): string {
  if (typeof body !== "string") return "(no body)";
  try {
    const b = JSON.parse(body) as { model?: unknown; max_tokens?: unknown; thinking?: unknown; output_config?: unknown; tool_choice?: unknown; tools?: unknown; messages?: unknown };
    const messages = Array.isArray(b.messages) ? (b.messages as Array<{ role?: unknown; content?: unknown }>) : [];
    // The replayed ASSISTANT turns' block TYPE sequences -- the thing item 1 changed.
    const replay = messages
      .filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .map((m) => `[${(m.content as Array<{ type?: unknown }>).map((c) => String(c.type)).join(",")}]`)
      .join(" ");
    const thinking = b.thinking !== null && typeof b.thinking === "object" ? JSON.stringify({ ...(b.thinking as object) }) : "absent";
    return `model=${String(b.model)} max_tokens=${String(b.max_tokens)} thinking=${thinking} output_config=${JSON.stringify(b.output_config ?? null)} tool_choice=${JSON.stringify(b.tool_choice ?? null)} tools=${Array.isArray(b.tools) ? b.tools.length : 0} messages=${messages.length}${replay.length > 0 ? ` replayed_assistant=${replay}` : ""}`;
  } catch {
    return "(unparseable body)";
  }
}

function describeHeaders(headers: HeadersInit | undefined): string {
  const h = new Headers(headers);
  const names = [...h.keys()].sort();
  return `names=[${names.join(",")}] anthropic-beta=${h.get("anthropic-beta") ?? "(none)"} user-agent=${h.get("user-agent") ?? "(none)"} auth=${h.has("authorization") ? "bearer" : h.has("x-api-key") ? "api-key" : "none"}`;
}

function installWireObserver(): () => void {
  const original = globalThis.fetch;
  const observed = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await original(input as Parameters<typeof fetch>[0], init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    // Only the Anthropic API is recorded; the Exa MCP traffic of step 2 is not this probe's subject.
    if (url.host === "api.anthropic.com") wire.push({ host: `${url.host}${url.pathname}`, status: response.status, sent: describeRequest(init?.body), headers: describeHeaders(init?.headers) });
    return response;
  };
  globalThis.fetch = observed as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function printWireSince(before: number): void {
  for (const r of wire.slice(before)) {
    console.log(`  wire: POST ${r.host} -> HTTP ${r.status}`);
    console.log(`  wire sent: ${r.sent}`);
    console.log(`  wire headers: ${r.headers}`);
  }
}

// --- credentials, from the Keychain, never as a printed string ----------------------------------------

/**
 * One dev Keychain item as material. The runtime's store expects JSON `CredentialMaterial`; a host may
 * have stored the BARE key instead, so a `malformed` answer falls back to the raw reader (as an api-key).
 */
async function readMaterial(ref: Extract<CredentialRef, { kind: "keychain" }>): Promise<CredentialMaterial | null> {
  try {
    return await createKeychainCredentialStore(KEYCHAIN_SERVICE).get(ref);
  } catch (err) {
    if (!(err instanceof CredentialResolutionError) || err.code !== "malformed") throw err;
    const raw = await createKeychainSecretReader(KEYCHAIN_SERVICE)(ref);
    return raw !== null && raw.trim().length > 0 ? { kind: "api-key", key: raw.trim() } : null;
  }
}

function contextFor(providerId: string, credentials: CredentialStore, authRef: CredentialRef): ProviderContext {
  // NO `baseUrl`: the adapter's own reviewed endpoint, the real API.
  return { connection: { providerId }, credentials, authRef, stallTimeoutMs: 180_000, log: () => {} };
}

// --- 1. the tool loop ----------------------------------------------------------------------------------

const LOOKUP_TOOL = {
  name: "read_number",
  description: "Returns the integer stored under a key. Only one key per call.",
  inputSchema: { type: "object", properties: { key: { type: "string", description: "One of: alpha, beta, gamma." } }, required: ["key"] },
};
const NUMBERS: Record<string, number> = { alpha: 17, beta: 23, gamma: 2 };

async function toolLoop(adapter: ProviderAdapter, ctx: ProviderContext, model: string): Promise<void> {
  console.log(`\n=== 1. ${model}: 3-round tool loop, adaptive thinking (effort low, summary requested)`);
  const history: ProviderMessageLike[] = [
    {
      role: "user",
      content:
        "Read the numbers stored under the keys alpha, beta and gamma using read_number, ONE key per call and one call at a time: call it, wait for the result, then call it for the next key. When you have all three, reply with their sum only.",
    },
  ];
  for (let round = 1; round <= 4; round++) {
    const before = wire.length;
    const req: TurnRequest = { model, messages: history, tools: [LOOKUP_TOOL], thinking: { type: "adaptive" }, effort: "low", requestSummary: true };
    let turn;
    try {
      turn = await foldProviderStream(adapter.streamTurn(req, ctx));
    } catch (err) {
      printWireSince(before);
      const e = err as { status?: number; providerCode?: string; code?: string };
      console.log(`  round ${round}: FAILED status=${e.status ?? "-"} code=${e.code ?? "-"} providerCode=${e.providerCode ?? "-"}  <-- a replay rejection here is the finding this probe exists for`);
      return;
    }
    printWireSince(before);
    const order = (turn.content ?? []).map((b) => b.type);
    const thinkingLengths = (turn.content ?? []).flatMap((b) => (b.type === "thinking" ? [`${b.thinking.length}c/sig${b.signature.length}`] : []));
    console.log(`  round ${round}: block order [${order.join(", ")}] stop=${turn.stopReason ?? "-"} thinking=${thinkingLengths.join(" ") || "none"} usage=${JSON.stringify(turn.usage ?? null)}`);
    if (turn.kind !== "tool_use") {
      console.log(`  final answer: ${turn.text.length} chars (${turn.text.trim() === "42" ? "the expected sum" : "NOT the expected sum -- check the transcript by hand"})`);
      return;
    }
    // REPLAYED IN STREAM ORDER -- exactly what the engine persists (`inStreamOrder`), signatures untouched.
    history.push({ role: "assistant", content: (turn.content ?? []) as ContentBlockLike[] });
    history.push({
      role: "tool",
      content: turn.calls.map((c) => {
        const key = (c.input as { key?: unknown } | null)?.key;
        return { type: "tool_result" as const, tool_use_id: c.id, content: typeof key === "string" && key in NUMBERS ? String(NUMBERS[key]) : "unknown key" };
      }),
    });
  }
  console.log("  stopped after 4 rounds without a final answer (a finding, not a failure of the replay)");
}

// --- 2. WebSearch on Fable 5.1 --------------------------------------------------------------------------

async function webSearch(credentials: CredentialStore): Promise<void> {
  const model = "anthropic/claude-fable-5-1";
  console.log(`\n=== 2. WebSearch on ${model} (seeded Exa search, then the inner model with NO forced tool_choice)`);
  const sessionId = `probe-anthropic-websearch-${crypto.randomUUID()}`;
  const config = { sessionId, cwd: "/tmp", model, persistSession: false, provider: { providerId: "anthropic", authRef: API_KEY_REF } } as RuntimeConfig;
  const wiring = buildSessionProvider({ config, env: {}, catalog: loadCatalog(), credentials });
  const unregister = registerWebSessionRuntime(sessionId, { web: resolveWebToolsConfig(undefined), sessionModel: () => ({ provider: wiring.provider, model }), accountUsage() {} });
  const before = wire.length;
  try {
    const ctx = {
      cwd: "/tmp",
      home: "/tmp",
      sessionId,
      readState: { readFiles: new Map() },
      emitFrame: () => {},
      permissions: { probeReadAccess: () => "silent" },
      tempDir: "/tmp",
      sandboxSettings: {},
      session: { setCwd() {}, addBoundedRoot() {}, removeBoundedRoot() {}, setPermissionMode() {}, getBoundedRoots: () => [], getPermissionMode: () => "default", getSessionRoot: () => "/tmp", setSessionRoot() {} },
    } as unknown as ToolExecutionContext;
    const result = await createWebSearchExecutor().execute({ query: "Bun JavaScript runtime latest release notes" }, ctx);
    printWireSince(before);
    const links = result.output.match(/Links: (\[.*\])/g) ?? [];
    const linkCount = links.reduce((n, l) => n + (JSON.parse(l.slice("Links: ".length)) as unknown[]).length, 0);
    console.log(`  result: isError=${result.isError === true} length=${result.output.length} links=${linkCount} not_performed=${result.output.includes("not performed")} reminder=${result.output.includes("REMINDER:")}`);
  } finally {
    unregister();
  }
}

// --- 3. Opus 5, xhigh + disabled ------------------------------------------------------------------------

async function opus5Clamp(adapter: ProviderAdapter, ctx: ProviderContext): Promise<void> {
  console.log("\n=== 3. claude-opus-5 at effort xhigh with thinking DISABLED (expect: rewritten to adaptive, HTTP 200)");
  const before = wire.length;
  try {
    const turn = await foldProviderStream(adapter.streamTurn({ model: "claude-opus-5", messages: [{ role: "user", content: "Reply with OK." }], thinking: { type: "disabled" }, effort: "xhigh" }, ctx));
    printWireSince(before);
    console.log(`  stop=${turn.stopReason ?? "-"} answer=${turn.kind === "text" ? turn.text.length : 0} chars`);
  } catch (err) {
    printWireSince(before);
    const e = err as { status?: number; code?: string; providerCode?: string };
    console.log(`  FAILED status=${e.status ?? "-"} code=${e.code ?? "-"} providerCode=${e.providerCode ?? "-"}`);
  }
}

// --- 4. one Console turn ---------------------------------------------------------------------------------

async function consoleTurn(adapter: ProviderAdapter): Promise<void> {
  console.log("\n=== 4. one Console turn (`console` provider, bearer from anthropic:console)");
  const material = await readMaterial(CONSOLE_REF);
  if (material === null) {
    console.log(`  SKIPPED: no Keychain item at service ${KEYCHAIN_SERVICE}, account ${CONSOLE_REF.account} (run the dev Console login first to include this step)`);
    return;
  }
  console.log(`  credential kind: ${material.kind}`);
  const ctx = contextFor("console", createMemoryCredentialStore([[CONSOLE_REF, material]]), CONSOLE_REF);
  const before = wire.length;
  try {
    const turn = await foldProviderStream(adapter.streamTurn({ model: "claude-sonnet-5", messages: [{ role: "user", content: "Reply with OK." }] }, ctx));
    printWireSince(before);
    console.log(`  stop=${turn.stopReason ?? "-"} answer=${turn.kind === "text" ? turn.text.length : 0} chars`);
  } catch (err) {
    printWireSince(before);
    const e = err as { status?: number; code?: string; providerCode?: string };
    console.log(`  FAILED status=${e.status ?? "-"} code=${e.code ?? "-"} providerCode=${e.providerCode ?? "-"}  <-- whether /v1/messages accepts an ant-minted bearer from a non-claude client is exactly what this step measures`);
  }
}

// --- main --------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.WINTER_ANTHROPIC_PROBE !== "1") {
    console.log("probe-anthropic-code: set WINTER_ANTHROPIC_PROBE=1 to run it (it spends a few cents on the dev Anthropic key). Nothing was sent.");
    return;
  }
  const adapter = createShippedAdapters(loadCatalog()).find((a) => a.id === "winter.anthropic-messages");
  if (adapter === undefined) throw new Error("the shipped wiring has no winter.anthropic-messages adapter");
  const material = await readMaterial(API_KEY_REF);
  if (material === null) throw new Error(`no Keychain item at service ${KEYCHAIN_SERVICE}, account ${API_KEY_REF.account} -- store the dev Anthropic key there first`);
  const credentials = createMemoryCredentialStore([[API_KEY_REF, material]]);
  const ctx = contextFor("anthropic", credentials, API_KEY_REF);
  const restore = installWireObserver();
  try {
    await toolLoop(adapter, ctx, "claude-opus-5-5");
    await toolLoop(adapter, ctx, "claude-sonnet-5");
    await webSearch(credentials);
    await opus5Clamp(adapter, ctx);
    await consoleTurn(adapter);
  } finally {
    restore();
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // A CredentialResolutionError's message is ref-redacted by construction; anything else is reported by name only.
    console.error(`probe-anthropic-code failed: ${err instanceof CredentialResolutionError || (err instanceof Error && err.message.startsWith("no Keychain item")) ? err.message : err instanceof Error ? err.name : "unknown error"}`);
    process.exitCode = 1;
  });
}
