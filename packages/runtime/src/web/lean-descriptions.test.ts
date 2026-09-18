// The web tools' LEAN / FULL descriptions, per SESSION.
//
// A descriptor is a process-wide singleton and cannot see a session's model, so both tools register
// their FULL text statically; the engine's `toolSpecFor` picks the variant per run with the same
// `sessionLeanModel` rule the Agent tool's listing already follows. Read here off the REAL advertised
// tool list -- the `tools` array of the request the provider actually receives.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import "../tools/descriptors/index.ts";
import { runEngine, type EngineOptions, type Provider, type ProviderRequest } from "../engine.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import type { SlotProviderResolution } from "../provider/slots.ts";
import { WEB_FETCH_CANONICAL_NAME, WEB_FETCH_DESCRIPTION_FULL, WEB_FETCH_DESCRIPTION_LEAN, webFetchDescriptionFor } from "../tools/descriptors/web-fetch.ts";
import { WEB_SEARCH_CANONICAL_NAME, webSearchDescription } from "../tools/descriptors/web-search.ts";
import { getRegisteredTool } from "../tools/registry.ts";
import { resetWebSessionRuntimesForTest } from "./session-runtime.ts";

const FABLE_KEY = "anthropic/fable-fake";
const TIER_KEYS: Record<string, string> = { haiku: "anthropic/haiku-fake", sonnet: "anthropic/sonnet-fake", opus: "anthropic/opus-fake" };
/** Resolves a tier NAME to a fixed key, which is all `sessionLeanModel`'s reverse check needs. */
const resolveSlot = (requested: string): SlotProviderResolution => {
  const modelKey = TIER_KEYS[requested];
  if (modelKey === undefined) return { ok: false, code: "unknown-slot", message: `no such tier ${requested}`, wouldServe: [] };
  return { ok: true, modelKey, providerId: "anthropic", canonicalModelId: `claude-${requested}-fake`, slot: { family: "claude", name: requested as "haiku", source: "claude-pinned" }, viaSlotName: true };
};

afterEach(() => {
  setSystemTime();
  resetWebSessionRuntimesForTest();
});

/** Runs one turn on the real engine and returns the description each web tool was ADVERTISED with. */
async function advertised(config: Partial<RuntimeConfig>, options: Partial<EngineOptions> = {}): Promise<{ fetch: string | undefined; search: string | undefined }> {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async generate(input) {
      requests.push(input);
      return { kind: "text", text: "ok" };
    },
  };
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: `web-lean-${Math.random().toString(36).slice(2)}`, cwd: process.cwd(), model: "prova/m", persistSession: false, ...config } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider,
    ...options,
  });
  host.output.write({ type: "user", text: "go" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  const frames: WinterFrame[] = [];
  for await (const f of host.input) frames.push(f);
  await done;
  expect(requests.length).toBeGreaterThan(0);
  const tools = requests[0]!.tools ?? [];
  return { fetch: tools.find((t) => t.name === WEB_FETCH_CANONICAL_NAME)?.description, search: tools.find((t) => t.name === WEB_SEARCH_CANONICAL_NAME)?.description };
}

const leanSession = { providerIdentity: { providerId: "anthropic", modelKey: FABLE_KEY, family: "claude" }, resolveSlot } as Partial<EngineOptions>;
const sonnetSession = { providerIdentity: { providerId: "anthropic", modelKey: TIER_KEYS["sonnet"]!, family: "claude" }, resolveSlot } as Partial<EngineOptions>;

describe("WebFetch / WebSearch advertise the description variant the SESSION's model calls for", () => {
  test("the canonical-name constants ARE the registered names (the engine branches on them, never on a literal)", () => {
    expect(getRegisteredTool(WEB_FETCH_CANONICAL_NAME)?.descriptor.canonicalName).toBe(WEB_FETCH_CANONICAL_NAME);
    expect(getRegisteredTool(WEB_SEARCH_CANONICAL_NAME)?.descriptor.canonicalName).toBe(WEB_SEARCH_CANONICAL_NAME);
    // And the two variants really differ -- otherwise every case below passes vacuously.
    expect(webFetchDescriptionFor(true)).not.toBe(webFetchDescriptionFor(false));
    expect(webSearchDescription(true)).not.toBe(webSearchDescription(false));
  });

  test("a LEAN-tier session (first-party Anthropic, above the Opus tier) is advertised BOTH lean texts", async () => {
    setSystemTime(new Date("2031-03-15T12:00:00Z"));
    const tools = await advertised({ model: FABLE_KEY }, leanSession);
    expect(tools.fetch).toBe(WEB_FETCH_DESCRIPTION_LEAN);
    expect(tools.search).toBe(webSearchDescription(true));
    expect(tools.search).not.toBe(webSearchDescription(false));
  });

  test("a NON-lean session is advertised BOTH full texts: a sonnet-tier Anthropic session, and any non-Anthropic one", async () => {
    setSystemTime(new Date("2031-03-15T12:00:00Z"));
    for (const tools of [await advertised({ model: TIER_KEYS["sonnet"]! }, sonnetSession), await advertised({})]) {
      expect(tools.fetch).toBe(WEB_FETCH_DESCRIPTION_FULL);
      expect(tools.search).toBe(webSearchDescription(false));
    }
  });

  test("WebSearch's month is computed AT ADVERTISE TIME, in both variants -- a process that lives across a month boundary advertises the new month", async () => {
    for (const [options, config, lean] of [[leanSession, { model: FABLE_KEY }, true], [{}, {}, false]] as const) {
      setSystemTime(new Date("2031-03-15T12:00:00Z"));
      const march = await advertised(config, options);
      expect(march.search).toContain("March 2031");
      expect(march.search).toBe(webSearchDescription(lean, () => new Date("2031-03-15T12:00:00Z")));
      setSystemTime(new Date("2031-04-02T12:00:00Z"));
      const april = await advertised(config, options);
      expect(april.search).toContain("April 2031");
      expect(april.search).not.toContain("March 2031");
    }
  });
});
