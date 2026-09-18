// The web tools' session seam, and the two capability tokens derived from it.
//
// The token half is driven against the REAL engine and read off `system/init.tools`, because the
// claim that matters is about what a session ADVERTISES: nothing before an executor exists, and
// then exactly what the session's own facts allow.
import { afterEach, describe, expect, test } from "bun:test";
import { resolveWebToolsConfig, type ProtocolSdkMessage as SdkMessage, type RuntimeConfig, type WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import "../tools/descriptors/index.ts";
import { runEngine, type EngineOptions, type Provider } from "../engine.ts";
import { scriptedProvider } from "../provider/mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { getRegisteredTool, registerTool, replaceExecutor, unregisterToolForTest, type RegisteredTool } from "../tools/registry.ts";
import {
  digestModelResolves,
  getWebSessionRuntime,
  inheritedWebSessionFacts,
  registerWebSessionRuntime,
  resetWebSessionRuntimesForTest,
  searchBackendUsable,
  webSessionRuntimeFor,
  type WebSessionRuntime,
} from "./session-runtime.ts";

const provider: Provider = scriptedProvider([{ kind: "text", text: "x" }]);
function runtimeWith(over: Partial<WebSessionRuntime> = {}): WebSessionRuntime {
  return { web: resolveWebToolsConfig(undefined), sessionModel: () => ({ provider, model: "prova/m" }), accountUsage() {}, ...over };
}

afterEach(() => resetWebSessionRuntimesForTest());

describe("the registry", () => {
  test("a child call resolves ITS OWN runtime; a child with none falls back to the owning session's; an unknown session resolves nothing", () => {
    const root = runtimeWith();
    const child = runtimeWith();
    registerWebSessionRuntime("session-1", root);
    registerWebSessionRuntime("agent-7", child);
    expect(webSessionRuntimeFor({ sessionId: "session-1" })).toBe(root);
    expect(webSessionRuntimeFor({ sessionId: "session-1", agentId: "agent-7" })).toBe(child);
    expect(webSessionRuntimeFor({ sessionId: "session-1", agentId: "agent-unregistered" })).toBe(root);
    expect(webSessionRuntimeFor({ sessionId: "session-other" })).toBeUndefined();
  });

  test("the disposer is IDENTITY-CHECKED: a previous generation's late teardown never removes the live registration", () => {
    const generation1 = runtimeWith();
    const generation2 = runtimeWith();
    const dispose1 = registerWebSessionRuntime("agent-7", generation1);
    const dispose2 = registerWebSessionRuntime("agent-7", generation2);
    dispose1();
    expect(getWebSessionRuntime("agent-7")).toBe(generation2);
    dispose2();
    expect(getWebSessionRuntime("agent-7")).toBeUndefined();
  });

  test("a child inherits the three SESSION-level facts from the root -- and nothing per-run", () => {
    const resolveAuxiliaryModel: NonNullable<WebSessionRuntime["resolveAuxiliaryModel"]> = () => ({ ok: false, code: "unknown-model", message: "" });
    const resolveToolSecret: NonNullable<WebSessionRuntime["resolveToolSecret"]> = async () => ({ status: "missing" });
    const web = resolveWebToolsConfig({ blockedDomains: ["blocked.example"] });
    registerWebSessionRuntime("session-1", runtimeWith({ web, resolveAuxiliaryModel, resolveToolSecret }));
    const inherited = inheritedWebSessionFacts("session-1")!;
    expect(inherited).toEqual({ web, resolveAuxiliaryModel, resolveToolSecret });
    expect("sessionModel" in inherited).toBe(false);
    expect("accountUsage" in inherited).toBe(false);
    expect(inheritedWebSessionFacts("no-such-session")).toBeUndefined();
  });
});

describe("the two session facts", () => {
  test("search is usable by default (the anonymous tier needs no credential) and unusable only when the host says so", () => {
    expect(searchBackendUsable(runtimeWith())).toBe(true);
    expect(searchBackendUsable(runtimeWith({ web: resolveWebToolsConfig({ search: { enabled: false } }) }))).toBe(false);
  });

  test("a digest model resolves when none is stated (the session's own); a STATED one must actually resolve", () => {
    expect(digestModelResolves(runtimeWith())).toBe(true);
    const stated = resolveWebToolsConfig({ fetch: { digestModel: "provb/small", authRef: { kind: "env", name: "WINTER_TEST_DIGEST" } } });
    // No catalog to resolve against -> unresolvable, never "fall back to the session's model".
    expect(digestModelResolves(runtimeWith({ web: stated }))).toBe(false);
    const asked: unknown[] = [];
    expect(digestModelResolves(runtimeWith({ web: stated, resolveAuxiliaryModel: (tag, opts) => (asked.push([tag, opts]), { ok: true, provider, modelKey: "provb/small" }) }))).toBe(true);
    expect(asked).toEqual([["provb/small", { authRef: { kind: "env", name: "WINTER_TEST_DIGEST" } }]]);
    expect(digestModelResolves(runtimeWith({ web: stated, resolveAuxiliaryModel: () => ({ ok: false, code: "unknown-model", message: "" }) }))).toBe(false);
    expect(
      digestModelResolves(
        runtimeWith({
          web: stated,
          resolveAuxiliaryModel: () => {
            throw new Error("a resolver that throws is a session with no digest model");
          },
        }),
      ),
    ).toBe(false);
  });
});

// --- the capability tokens, on the real engine -----------------------------------------------------

async function initTools(config: Partial<RuntimeConfig>, options: Partial<EngineOptions> = {}): Promise<string[]> {
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: `web-caps-${Math.random().toString(36).slice(2)}`, cwd: process.cwd(), model: "prova/m", persistSession: false, ...config } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider: scriptedProvider([{ kind: "text", text: "ok" }]),
    ...options,
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  const init = frames
    .filter((f) => f.type === "data")
    .map((f) => (f as { message: SdkMessage }).message)
    .find((m) => m.type === "system" && (m as { subtype?: string }).subtype === "init") as unknown as { tools: string[] };
  return init.tools;
}

describe("`winter.search-backend` / `winter.fetch-extractor` are DERIVED: executor present AND the session fact", () => {
  const originals = new Map<string, RegisteredTool>();
  /** Installs a throwaway executor over the descriptor-only stub, exactly as `impl/web-*.ts` will at module load. */
  function installExecutor(name: string): void {
    if (!originals.has(name)) originals.set(name, getRegisteredTool(name)!);
    replaceExecutor(name, { execute: async () => ({ output: "" }) });
  }
  afterEach(() => {
    for (const [name, original] of originals) {
      unregisterToolForTest(name);
      registerTool(original);
    }
    originals.clear();
  });

  test("TODAY, with no executor installed, NEITHER tool is advertised -- whatever the host configures", async () => {
    expect(getRegisteredTool("WebFetch")?.executor).toBeUndefined();
    expect(getRegisteredTool("WebSearch")?.executor).toBeUndefined();
    const tools = await initTools({ web: { search: { enabled: true }, fetch: {} } });
    expect(tools).not.toContain("WebFetch");
    expect(tools).not.toContain("WebSearch");
  });

  test("once the executors exist, both light up BY THEMSELVES -- no host token, no configuration", async () => {
    installExecutor("WebFetch");
    installExecutor("WebSearch");
    const tools = await initTools({});
    expect(tools).toContain("WebFetch");
    expect(tools).toContain("WebSearch");
  });

  test("`web.search.enabled: false` withdraws WebSearch and leaves WebFetch", async () => {
    installExecutor("WebFetch");
    installExecutor("WebSearch");
    const tools = await initTools({ web: { search: { enabled: false } } });
    expect(tools).toContain("WebFetch");
    expect(tools).not.toContain("WebSearch");
  });

  test("a STATED digest model that does not resolve withdraws WebFetch; one that resolves keeps it", async () => {
    installExecutor("WebFetch");
    installExecutor("WebSearch");
    const stated = { web: { fetch: { digestModel: "provb/small" } } };
    // No resolver at all (a bare engine over a double): a stated tag cannot resolve.
    expect(await initTools(stated)).not.toContain("WebFetch");
    expect(await initTools(stated, { resolveAuxiliaryModel: () => ({ ok: false, code: "unknown-model", message: "no such row" }) })).not.toContain("WebFetch");
    const resolved = await initTools(stated, { resolveAuxiliaryModel: () => ({ ok: true, provider, modelKey: "provb/small" }) });
    expect(resolved).toContain("WebFetch");
    expect(resolved).toContain("WebSearch");
  });

  test("a host-supplied token still unions in (the pre-existing contract), executor or not", async () => {
    const tools = await initTools({ capabilities: ["winter.fetch-extractor"] });
    expect(tools).toContain("WebFetch");
    expect(tools).not.toContain("WebSearch");
  });
});
