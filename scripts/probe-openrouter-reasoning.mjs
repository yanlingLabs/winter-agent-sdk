// 0.0.56 (W7): the LIVE probe for OpenRouter -- reasoning_details replay, Anthropic prompt caching through
// OpenRouter, and OpenRouter's reported cost. Run by the OWNER with their own key, never by a test, an
// agent or CI.
//
// PLAIN NODE ESM, importing the two provider packages BY NAME and nothing else, so the same file runs
// from a checkout (after `bun run build:packages`) and from a scratch project that installed the packed
// or published tarballs -- exactly the install a Node host has.
//
// WHAT IT DOES -- five requests, all through the shipped Chat Completions adapter, the stream assembler
// and the history renderer, i.e. the consumer's own path:
//   1. haiku-text     openrouter/anthropic/claude-haiku-5.5, one short answer, with `systemBlocks` at
//                     scope org and `cacheTtl: "1h"` (W1): PASS when it answers and reports usage.
//   2. haiku-cache    the SAME prefix again: PASS when the provider reports a cache read (W1).
//   3. haiku-cost     PASS when OpenRouter's `usage.cost` arrived as `reportedCostUsd` on both calls (W5).
//   4. sonnet-call    openrouter/anthropic/claude-sonnet-5.5 at effort `low`, one tool offered and asked
//                     for: PASS when it calls the tool AND `reasoning_details` were captured (W7).
//   5. sonnet-replay  the tool result sent back with the captured `reasoning_details` replayed verbatim:
//                     PASS when the provider accepts it and answers (W7 -- the step that breaks without it).
// Exactly ONE Sonnet tool round-trip (steps 4-5); the rest is Haiku 5.5, $0.10 / $0.50 per MTok. A run
// costs well under one US cent.
//
// THE KEY: read from ONE environment variable, OPENROUTER_API_KEY, by the package's own env credential
// store -- never from argv, never from a file, never from a Keychain. It is never printed, never logged,
// and every message this script prints passes `redact()`, which removes the key's value and any
// `sk-or-...` token. Output is step names, PASS/FAIL, token counts, costs, and the COUNT and `type`s of
// reasoning entries -- never model text, never a signature.
//
// Usage, from a checkout (the key already exported in your shell -- do not type it on the command line):
//   bun run build:packages && node scripts/probe-openrouter-reasoning.mjs
// From packed tarballs (`bun run release:pack` writes them):
//   mkdir probe && cd probe && npm init -y >/dev/null
//   npm install <path>/yanlinglabs-winter-provider-catalog-<v>.tgz <path>/yanlinglabs-winter-provider-runtime-<v>.tgz
//   cp <checkout>/scripts/probe-openrouter-reasoning.mjs . && node probe-openrouter-reasoning.mjs
// `--dry-run` answers every request from a canned in-process responder with a fake key (no network, no
// key needed), to check the probe's own plumbing. Its numbers are fabricated.
// Exit code: 0 when every step passes, 1 otherwise, 2 when OPENROUTER_API_KEY is unset.
import { createEnvCredentialStore, createHistoryRenderer, createRegistry, createShippedAdapters, assembledToMessage, foldProviderStream, setWinterIdentity } from "@yanlinglabs/winter-provider-runtime";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";

const KEY_VAR = "OPENROUTER_API_KEY";
const DRY_RUN = process.argv.includes("--dry-run");
const env = DRY_RUN ? { [KEY_VAR]: "dry-run-not-a-key" } : { [KEY_VAR]: process.env[KEY_VAR] };
const secret = (env[KEY_VAR] ?? "").trim();

/** Every string this script prints goes through here. */
function redact(text) {
  let out = String(text);
  if (secret.length > 0) out = out.split(secret).join("[redacted]");
  out = out.replace(/sk-or-[A-Za-z0-9_-]+/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out.length > 300 ? `${out.slice(0, 300)}...` : out;
}
const say = (line) => console.log(redact(line));

if (!DRY_RUN && secret.length === 0) {
  say(`probe-openrouter-reasoning: ${KEY_VAR} is not set -- nothing was sent. Export it in your shell (never pass it as an argument), or run with --dry-run.`);
  process.exit(2);
}

if (DRY_RUN) installDryRunResponder();

const catalog = loadCatalog();
const registry = createRegistry(catalog);
for (const adapter of createShippedAdapters(catalog)) registry.register(adapter);
const renderer = createHistoryRenderer(registry);
const disposeIdentity = setWinterIdentity({ product: "winter-openrouter-probe", codexOriginator: "winter-openrouter-probe", contactUrl: "https://github.com/yanlingLabs/winter-agent-sdk" });

const ctx = {
  connection: { providerId: "openrouter" },
  credentials: createEnvCredentialStore({ env }),
  authRef: { kind: "env", name: KEY_VAR },
  stallTimeoutMs: 60_000,
  log: () => {},
};

function resolve(model) {
  const resolved = registry.resolve({ model, provider: { providerId: "openrouter" } });
  if (!("adapter" in resolved)) throw new Error(`could not resolve openrouter/${model}: ${resolved.code}`);
  const origin = { providerId: resolved.providerId, modelKey: resolved.modelKey, family: resolved.adapter.family, ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}) };
  const target = { ...origin, readableState: "none" };
  return { resolved, origin, target };
}

// ~1,500 tokens of deterministic reference text: over the 512-token minimum cacheable prompt.
const REFERENCE = Array.from({ length: 120 }, (_, i) => `Reference line ${i + 1}: the probe's fixed context, kept byte-stable so the second request reads it from cache.`).join("\n");
const SYSTEM_A = "You are a terse assistant. Answer in at most five words.";

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass });
  say(`${pass ? "PASS" : "FAIL"}  ${step.padEnd(14)} ${detail}`);
}
const usageLine = (u) => (u === undefined ? "no usage" : `in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0} cost=${u.reportedCostUsd ?? "absent"}`);
const failure = (err) => (err && typeof err === "object" && "error" in err ? `${err.error.code}${err.error.status !== undefined ? ` ${err.error.status}` : ""}: ${err.error.message}` : String(err && err.message ? err.message : err));

async function haikuCall() {
  const { resolved, target } = resolve("anthropic/claude-haiku-5.5");
  const request = {
    model: resolved.providerModelId,
    system: `${SYSTEM_A}\n\n${REFERENCE}`,
    systemBlocks: [
      { text: SYSTEM_A, cacheScope: "org" },
      { text: REFERENCE, cacheScope: "org" },
    ],
    cacheTtl: "1h",
    maxOutputTokens: 2000,
    messages: renderer.render([{ role: "user", content: "Say hello." }], new Map(), target),
  };
  return foldProviderStream(resolved.adapter.streamTurn(request, ctx));
}

async function main() {
  say(`probe-openrouter-reasoning${DRY_RUN ? " (DRY RUN: canned responses, fake key, no network)" : ""}`);
  let first;
  try {
    first = await haikuCall();
    record("haiku-text", first.kind === "text" && first.text.length > 0 && first.usage !== undefined, usageLine(first.usage));
  } catch (err) {
    record("haiku-text", false, failure(err));
  }
  let second;
  try {
    second = await haikuCall();
    record("haiku-cache", (second.usage?.cacheReadTokens ?? 0) > 0, usageLine(second.usage));
  } catch (err) {
    record("haiku-cache", false, failure(err));
  }
  record("haiku-cost", typeof first?.usage?.reportedCostUsd === "number" && typeof second?.usage?.reportedCostUsd === "number", `reportedCostUsd: ${first?.usage?.reportedCostUsd ?? "absent"}, ${second?.usage?.reportedCostUsd ?? "absent"}`);

  // --- the ONE Sonnet 5.5 tool round-trip -------------------------------------------------------
  const { resolved, origin, target } = resolve("anthropic/claude-sonnet-5.5");
  const tools = [{ name: "get_weather", description: "Returns today's weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
  const history = [{ role: "user", content: "Use the get_weather tool for Paris, then tell me in three words." }];
  const sonnetRequest = (messages) => ({ model: resolved.providerModelId, tools, effort: "low", maxOutputTokens: 4000, messages: renderer.render(messages, new Map(), target) });
  let call;
  let captured = [];
  try {
    call = await foldProviderStream(resolved.adapter.streamTurn(sonnetRequest(history), ctx));
    captured = (call.nativeState?.items ?? []).filter((i) => i && i.type === "winter.reasoning_details").flatMap((i) => i.details);
    const types = [...new Set(captured.map((d) => (d && typeof d === "object" ? String(d.type) : "?")))].join(",") || "none";
    record("sonnet-call", call.kind === "tool_use" && captured.length > 0, `kind=${call.kind} reasoning_details=${captured.length} (${types}) ${usageLine(call.usage)}`);
  } catch (err) {
    record("sonnet-call", false, failure(err));
  }
  if (call?.kind === "tool_use") {
    history.push(assembledToMessage(call, origin));
    history.push({ role: "tool", content: call.calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "Sunny, 21 C." })) });
    const replayed = (() => {
      const rendered = sonnetRequest(history).messages.find((m) => m.role === "assistant");
      return (rendered?.nativeState?.items ?? []).filter((i) => i && i.type === "winter.reasoning_details").flatMap((i) => i.details);
    })();
    try {
      const answer = await foldProviderStream(resolved.adapter.streamTurn(sonnetRequest(history), ctx));
      const verbatim = JSON.stringify(replayed) === JSON.stringify(captured);
      record("sonnet-replay", answer.kind === "text" && answer.text.length > 0 && verbatim, `accepted; replayed ${replayed.length} entr${replayed.length === 1 ? "y" : "ies"} ${verbatim ? "verbatim" : "NOT verbatim"}; ${usageLine(answer.usage)}`);
    } catch (err) {
      record("sonnet-replay", false, failure(err));
    }
  } else {
    record("sonnet-replay", false, "skipped: no tool call to answer");
  }

  const failed = results.filter((r) => !r.pass).length;
  say(failed === 0 ? `ALL ${results.length} STEPS PASS` : `${failed} OF ${results.length} STEPS FAILED`);
  return failed === 0 ? 0 : 1;
}

// --- the dry-run responder ----------------------------------------------------------------------
function installDryRunResponder() {
  const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  let haikuCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("https://openrouter.ai/api/v1/")) throw new Error(`dry run: refused a request to ${url}`);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const usage = (extra) => ({ choices: [], usage: { prompt_tokens: 1600, completion_tokens: 6, cost: 0.0002, prompt_tokens_details: extra } });
    if (String(body.model).includes("haiku")) {
      haikuCalls++;
      return sse([{ id: `dry-${haikuCalls}`, choices: [{ index: 0, delta: { content: "Hello there." }, finish_reason: "stop" }] }, usage(haikuCalls === 1 ? { cached_tokens: 0, cache_write_tokens: 1500 } : { cached_tokens: 1500 })]);
    }
    const replay = body.messages.some((m) => m.role === "assistant" && Array.isArray(m.reasoning_details));
    if (!replay) {
      return sse([
        { id: "dry-s1", choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", text: "", format: "anthropic-claude-v1", index: 0 }] }, finish_reason: null }] },
        { id: "dry-s1", choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", signature: "dry-signature", format: "anthropic-claude-v1", index: 0 }] }, finish_reason: null }] },
        { id: "dry-s1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "toolu_dry", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] }, finish_reason: "tool_calls" }] },
        usage({ cached_tokens: 0 }),
      ]);
    }
    return sse([{ id: "dry-s2", choices: [{ index: 0, delta: { content: "Sunny and mild." }, finish_reason: "stop" }] }, usage({ cached_tokens: 0 })]);
  };
}

let code = 1;
try {
  code = await main();
} catch (err) {
  say(`probe-openrouter-reasoning aborted: ${failure(err)}`);
} finally {
  disposeIdentity();
}
process.exit(code);
