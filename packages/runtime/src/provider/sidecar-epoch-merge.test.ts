// WS-23 (reasoning-state x midconv fix round): the tool epoch's bookkeeping lives in the sidecar (per
// model, restored before the reply it preceded), and midconv's C-1 layout carries a change past an
// orphaned prompt to just before the next reply. The two must agree: a session whose generation FAILED
// after a change was recorded sends, once resumed from the real store, exactly what the uninterrupted
// session sends. The real engine, store (transcript + sidecar), session-provider wiring and Anthropic
// adapter run against a loopback on the real Opus 5.5 row.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { buildSessionProvider, loadResumedChain } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { registerMcpServerTools, replaceExecutor, unregisterMcpServerTools } from "../tools/registry.ts";
import { createFakeMcpServerStateSource } from "../mcp/state.ts";
import { fakeAnthropicCatalog, startAnthropicFake, type AnthropicFake } from "./anthropic-fake.test-support.ts";
import "../tools/impl/index.ts";

const MODEL = "anthropic/claude-opus-5-5";
const SERVER = "ws23mergelate";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Fx {
  fake: AnthropicFake;
  home: string;
  cwd: string;
}

/** The endpoint refuses (non-retryably) the request whose last prompt is turn two -- the generation after the change. */
async function fixture(): Promise<Fx> {
  const fake = await startAnthropicFake((request) => {
    const messages = request.body["messages"] as Array<{ role: string; content: unknown }>;
    const lastUser = JSON.stringify(messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
    if (lastUser.includes("turn two") && !lastUser.includes("turn three")) return { status: 400, error: { type: "invalid_request_error", message: "an unrelated refusal (fixture)" } }; // non-retryable: no backoff
    return { blocks: [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "text", text: "ok" }], stopReason: "end_turn" };
  });
  const home = mkdtempSync(join(tmpdir(), "winter-ws23-merge-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-ws23-merge-cwd-"));
  cleanups.push(async () => {
    unregisterMcpServerTools(SERVER);
    await fake.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { fake, home, cwd };
}

async function run(fx: Fx, sessionId: string, steps: Array<string | (() => void)>, resume?: string): Promise<void> {
  const catalog = fakeAnthropicCatalog(fx.fake.url, [MODEL]);
  const config = {
    sessionId,
    cwd: fx.cwd,
    model: MODEL,
    winterHome: fx.home,
    provider: { providerId: "anthropic", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fx.fake.url, local: true } },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    capabilities: ["winter.mcp"],
    ...(resume !== undefined ? { resume } : {}),
  } as unknown as RuntimeConfig;
  const resolved = await resolveEngineSession({ config, resolveWinterHome: () => fx.home, env: {} });
  const chain = await loadResumedChain(resolved.store, resolved.initialMessages);
  const wiring = buildSessionProvider({ config: resolved.config, env: {}, catalog, credentials: createMemoryCredentialStore(), chain: () => chain });
  const identity = wiring.identity!;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: resolved.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: "anthropic", ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
    describeModel: (m: string, p?: string) => describeCatalogModel(catalog, m, p),
    mcpServerStateSource: createFakeMcpServerStateSource([{ name: SERVER, state: "connected", toolNames: [] }]),
    ...(resolved.store !== undefined ? { store: resolved.store } : {}),
    ...(resolved.initialMessages.length > 0 ? { initialMessages: resolved.initialMessages } : {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  for (const step of steps) {
    if (typeof step === "function") {
      step();
      continue;
    }
    host.output.write({ type: "user", text: step });
    users++;
    for (let n = 0; n < 3000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
}

const addLate = (): void => {
  registerMcpServerTools(SERVER, [{ name: "late", description: "A late tool.", inputSchema: { type: "object" } }], { deferredDefault: false });
  replaceExecutor(`mcp__${SERVER}__late`, { async execute() { return { output: "x" }; } });
};
const strip = (value: unknown): string => JSON.stringify(JSON.parse(JSON.stringify(value)), (key, v) => (key === "cache_control" ? undefined : v));

describe("the sidecar-kept tool epoch and midconv's C-1 carried placement agree across a resume", () => {
  test("a change recorded before a FAILED generation: the resumed turn-three request is the uninterrupted one's, byte for byte", async () => {
    const live = await fixture();
    await run(live, "merge-live", ["turn one", addLate, "turn two", "turn three"]);
    // The tool registry is process-global: the split session starts, like the live one did, without the late tool.
    unregisterMcpServerTools(SERVER);
    const split = await fixture();
    await run(split, "merge-split", ["turn one", addLate, "turn two"]);
    await run(split, "merge-split-resumed", ["turn three"], "merge-split");

    const lastOf = (fx: Fx) => fx.fake.requests.filter((r) => r.path === "/v1/messages").at(-1)!.body;
    const [a, b] = [lastOf(live), lastOf(split)];
    expect(JSON.stringify(b["tools"])).toBe(JSON.stringify(a["tools"]));
    expect(strip(b["messages"])).toBe(strip(a["messages"]));
    // C-1: the change sits right before the reply position (the end), never in front of a user turn.
    const messages = a["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const at = messages.findIndex((m) => m.role === "system" && m.content.some((c) => c["type"] === "tool_addition"));
    expect(at).toBeGreaterThan(0);
    expect(at).toBe(messages.length - 1);
    expect(messages[at - 1]!.role).toBe("user");
  });
});
