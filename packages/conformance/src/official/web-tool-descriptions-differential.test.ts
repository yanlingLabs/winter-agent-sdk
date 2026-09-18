// The two web tools' DESCRIPTIONS and INPUT SCHEMAS, differentially: what the pinned `claude` binary
// advertises for `WebSearch` / `WebFetch` in the `tools` array of its first request, against what
// Winter's own engine advertises (read off the request its provider actually receives) for a session
// on the equivalent model tier.
//
// The binary picks a LEAN or a FULL description by model, so it is driven once per tier. Which model
// ids are lean is the binary's own selector (full for the claude-3 line, haiku, sonnet and five named
// Opus 4.x builds; lean for everything else first-party); Winter's `sessionLeanModel` applies the same
// test to its own model key. The third tier below exists because an earlier Winter rule drew the line
// ABOVE the whole opus tier, and Opus 5 is where the two disagreed.
//
// SANCTIONED differences -- each asserted as EXACT SURGERY on the text (the binary's string must equal
// Winter's string with precisely that one edit applied), never skipped and never a loose "contains":
//   - WebSearch: Winter drops the sentence saying search is US-only (lean: ` US-only.`; full: the
//     `  - Web search is only available in the US` usage note). It describes Anthropic's own search
//     backend, not Winter's.
//   - WebFetch: Winter omits the binary's claude.ai-artifact lines. Those lines are conditional in the
//     binary; this test asserts whether they appear in THIS configuration and compares accordingly.
// Anything else is a finding: the assertion stays strict and the difference is reported.
//
// SCHEMAS are compared as canonical JSON, so the ORDER of keys inside a property (`description` before
// `type` in the binary, the reverse in Winter) is not a difference; the order of the property NAMES and
// of `required` is asserted separately.
//
// The Winter side is a first-party Anthropic session, which is the one configuration where Winter
// advertises the binary's own schema keywords (`$schema`, `additionalProperties: false`, `format`);
// every other provider is advertised the catalog's portable rendering of the same schema.
//
// GATED (`RUN_OFFICIAL_CAPTURE=1`) like every file in this family.
import { describe, test, expect } from "bun:test";
import { resolvePinnedClaudeBinary, sseResponse, sseTextTurn, CLAUDE_VERSION, type RawFrame } from "./differential-harness.ts";
import { runOfficialOnce, toolsOf } from "./web-tools-script.ts";
import "../../../runtime/src/tools/descriptors/index.ts";
import { runEngine, type EngineOptions, type Provider, type ProviderRequest } from "../../../runtime/src/engine.ts";
import { createInMemoryChannel } from "../../../runtime/src/protocol/channel.ts";
import type { SlotProviderResolution } from "../../../runtime/src/provider/slots.ts";
import type { RuntimeConfig } from "../../../sdk/src/index.ts";

const resolved = await resolvePinnedClaudeBinary();
const skipReason = "reason" in resolved ? resolved.reason : undefined;

// --- the tiers ---------------------------------------------------------------------------------------

interface Tier {
  id: string;
  /** The model id the pinned binary is driven with. */
  officialModel: string;
  /** Whether the BINARY advertises its lean text for that model (measured; asserted below). */
  officialLean: boolean;
  /** The Winter session this tier is "equivalent" to: a first-party Anthropic session on the same family tier. */
  winterModelKey: string;
}

const WINTER_TIER_KEYS: Record<string, string> = { haiku: "anthropic/haiku-fake", sonnet: "anthropic/sonnet-fake", opus: "anthropic/opus-fake" };
const WINTER_FABLE_KEY = "anthropic/fable-fake";

const TIERS: Tier[] = [
  { id: "haiku (full tier)", officialModel: "claude-haiku-4-5", officialLean: false, winterModelKey: WINTER_TIER_KEYS["haiku"]! },
  { id: "fable (lean tier)", officialModel: "claude-fable-5", officialLean: true, winterModelKey: WINTER_FABLE_KEY },
  { id: "opus 5 (lean in the binary's catalog; opus tier in Winter's rule)", officialModel: "claude-opus-5", officialLean: true, winterModelKey: WINTER_TIER_KEYS["opus"]! },
];

interface AdvertisedTool {
  description: string;
  schema: unknown;
}
interface Advertised {
  search: AdvertisedTool;
  fetch: AdvertisedTool;
}

// --- the OFFICIAL side ---------------------------------------------------------------------------------

const officialRuns = new Map<string, Promise<Advertised>>();
function official(tier: Tier): Promise<Advertised> {
  let run = officialRuns.get(tier.officialModel);
  if (run === undefined) {
    run = (async () => {
      const captured = await runOfficialOnce({
        binaryPath: "binaryPath" in resolved ? resolved.binaryPath : "",
        model: tier.officialModel,
        prompt: "hello",
        logPrefix: `webdesc official ${tier.officialModel}`,
        route: () => sseResponse(sseTextTurn("ok")),
      });
      expect(captured.trapHits, "nothing may try to leave the box").toEqual([]);
      const first = captured.requests.find((r) => toolsOf(r).length > 0);
      if (first === undefined) throw new Error("the binary sent no request carrying a tools array");
      const pick = (name: string): AdvertisedTool => {
        const tool = toolsOf(first).find((t) => t.name === name);
        if (tool === undefined) throw new Error(`the binary's first request does not advertise ${name} (advertised: ${toolsOf(first).map((t) => String(t.name)).join(", ")})`);
        return { description: String(tool.description), schema: tool.input_schema };
      };
      return { search: pick("WebSearch"), fetch: pick("WebFetch") };
    })();
    officialRuns.set(tier.officialModel, run);
  }
  return run;
}

// --- the WINTER side: the real engine, one turn, read off the provider's own request ---------------------

const resolveSlot = (requested: string): SlotProviderResolution => {
  const modelKey = WINTER_TIER_KEYS[requested];
  if (modelKey === undefined) return { ok: false, code: "unknown-slot", message: `no such tier ${requested}`, wouldServe: [] };
  return { ok: true, modelKey, providerId: "anthropic", canonicalModelId: `claude-${requested}-fake`, slot: { family: "claude", name: requested as "haiku", source: "claude-pinned" }, viaSlotName: true };
};

async function winter(tier: Tier): Promise<Advertised> {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async generate(input) {
      requests.push(input);
      return { kind: "text", text: "ok" };
    },
  };
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: `webdesc-${crypto.randomUUID()}`, cwd: process.cwd(), model: tier.winterModelKey, persistSession: false } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider,
    providerIdentity: { providerId: "anthropic", modelKey: tier.winterModelKey, family: "claude" },
    resolveSlot,
  } as EngineOptions);
  host.output.write({ type: "user", text: "hello" });
  host.output.write({ type: "control_request", requestId: "end-1", subtype: "end_input", payload: undefined });
  for await (const _frame of host.input) void _frame;
  await done;
  const tools = requests[0]?.tools ?? [];
  const pick = (name: string): AdvertisedTool => {
    const tool = tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`Winter's first provider request does not advertise ${name}`);
    return { description: tool.description, schema: tool.inputSchema };
  };
  return { search: pick("WebSearch"), fetch: pick("WebFetch") };
}

// --- comparison helpers ----------------------------------------------------------------------------------

/** Replaces exactly ONE occurrence of `find` (throws unless there is exactly one) -- the "exact surgery" a sanctioned difference is asserted with. */
function replaceOnce(text: string, find: string, replacement: string): string {
  const first = text.indexOf(find);
  if (first < 0 || text.indexOf(find, first + 1) >= 0) throw new Error(`expected exactly one occurrence of ${JSON.stringify(find)}`);
  return text.slice(0, first) + replacement + text.slice(first + find.length);
}

/** Key-order-insensitive canonical JSON: two schemas that differ only in property ORDER say the same thing to the model's API. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]));
    return v;
  };
  return JSON.stringify(sort(value), null, 1);
}

/** A flat `path -> value` listing of every leaf, for a readable report of WHERE two schemas differ. */
function leaves(value: unknown, path = "$", out: Record<string, string> = {}): Record<string, string> {
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) leaves(v, `${path}.${k}`, out);
    return out;
  }
  out[path] = JSON.stringify(value);
  return out;
}

function schemaDifferences(officialSchema: unknown, winterSchema: unknown): string[] {
  const a = leaves(officialSchema);
  const b = leaves(winterSchema);
  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[key] !== b[key]) out.push(`${key}: official=${a[key] ?? "(absent)"} winter=${b[key] ?? "(absent)"}`);
  }
  return out;
}

const LEAN_SEARCH_OPENING = "Search the web. Returns result blocks with titles and URLs.";
const LEAN_FETCH_OPENING = "Fetches a URL, converts the page to markdown";
/** The VARIANT CHOICE is checked before the text: when the two sides pick different variants for the same tier, that -- not a 25-line text diff -- is the finding. */
const VARIANT_MESSAGE = (tier: Tier): string => `Winter must pick the same description VARIANT as the binary for this tier (the binary advertises its ${tier.officialLean ? "LEAN" : "FULL"} text for ${tier.officialModel})`;
const US_ONLY_LEAN = " US-only.";
const DOMAIN_FILTER_NOTE = "  - Domain filtering is supported to include or block specific websites\n";
const US_ONLY_FULL_NOTE = "  - Web search is only available in the US\n";

// --- the differential tests ------------------------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(`web tool descriptions + input schemas: Winter vs pinned ${CLAUDE_VERSION} claude${skipReason !== undefined ? ` -- SKIPPED: ${skipReason}` : ""}`, () => {
  for (const tier of TIERS) {
    describe(tier.id, () => {
      test(
        `the binary advertises its ${tier.officialLean ? "LEAN" : "FULL"} texts for ${tier.officialModel}`,
        async () => {
          const o = await official(tier);
          expect(o.search.description.startsWith(LEAN_SEARCH_OPENING), "WebSearch variant").toBe(tier.officialLean);
          expect(o.fetch.description.startsWith(LEAN_FETCH_OPENING), "WebFetch variant").toBe(tier.officialLean);
        },
        180_000,
      );

      test(
        "WebSearch description: identical but for the ONE sanctioned edit (Winter drops the US-only sentence)",
        async () => {
          const [o, w] = [await official(tier), await winter(tier)];
          console.log(`\n--- [${tier.id}] WebSearch description, official ---\n${JSON.stringify(o.search.description)}\n--- winter ---\n${JSON.stringify(w.search.description)}`);
          // The sanctioned edit itself, asserted on the binary's text: the sentence is THERE, exactly once.
          expect(w.search.description.startsWith(LEAN_SEARCH_OPENING), VARIANT_MESSAGE(tier)).toBe(tier.officialLean);
          const officialMinusUsOnly = tier.officialLean ? replaceOnce(o.search.description, LEAN_SEARCH_OPENING + US_ONLY_LEAN, LEAN_SEARCH_OPENING) : replaceOnce(o.search.description, DOMAIN_FILTER_NOTE + US_ONLY_FULL_NOTE, DOMAIN_FILTER_NOTE);
          // ...and Winter's text carries no trace of it.
          expect(/US-only|only available in the US/.test(w.search.description), "Winter's text must not claim a US-only restriction").toBe(false);
          // With that one sentence removed, the two are byte-identical (the month included -- both
          // render it from the same clock at advertise time).
          expect(w.search.description).toBe(officialMinusUsOnly);
        },
        180_000,
      );

      test(
        "WebFetch description: byte-identical (the binary's claude.ai-artifact lines are the one sanctioned omission, and are absent in this configuration)",
        async () => {
          const [o, w] = [await official(tier), await winter(tier)];
          console.log(`\n--- [${tier.id}] WebFetch description, official ---\n${JSON.stringify(o.fetch.description)}\n--- winter ---\n${JSON.stringify(w.fetch.description)}`);
          // The sanctioned omission, stated explicitly for THIS configuration: a headless session
          // with no claude.ai account gets no artifact lines from the binary, so there is nothing to
          // omit and the comparison below is exact. (If this ever fails, the binary started sending
          // them here, and the comparison must then strip exactly those lines -- not be loosened.)
          expect(w.fetch.description.startsWith(LEAN_FETCH_OPENING), VARIANT_MESSAGE(tier)).toBe(tier.officialLean);
          expect(/artifact/i.test(o.fetch.description), "the binary's artifact lines are not expected in this configuration").toBe(false);
          expect(/artifact/i.test(w.fetch.description), "Winter never carries the artifact lines").toBe(false);
          expect(w.fetch.description).toBe(o.fetch.description);
        },
        180_000,
      );

      for (const name of ["WebSearch", "WebFetch"] as const) {
        test(
          `${name} input_schema: the same schema (property order aside)`,
          async () => {
            const [o, w] = [await official(tier), await winter(tier)];
            const [os, ws] = name === "WebSearch" ? [o.search.schema, w.search.schema] : [o.fetch.schema, w.fetch.schema];
            const differences = schemaDifferences(os, ws);
            console.log(`\n--- [${tier.id}] ${name} input_schema differences (${differences.length}) ---\n${differences.join("\n") || "(none)"}`);
            const names = (schema: unknown): string => JSON.stringify([Object.keys((schema as { properties?: object }).properties ?? {}), (schema as { required?: unknown }).required]);
            expect(names(ws), "property NAME order and `required`").toBe(names(os));
            expect(canonical(ws)).toBe(canonical(os));
          },
          180_000,
        );
      }
    });
  }
});
