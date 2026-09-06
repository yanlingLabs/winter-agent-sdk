// P6 fix wave, Rulings E-4 (R6-H cost goes live) and E-5 (the R6-14 classifier pin) -- whole-branch
// review I-2 and I-5, two mutual deferrals: `estimateCostUsd` had no production caller and
// `maxBudgetUsd` no reader; `classifierPin` was accepted by the dialect and never written. Every
// fixture drives the REAL engine on a REAL catalog-resolved wiring against a loopback fake and reads
// the ground truth off the result frames, the store double's identity stamps and the fake's log.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider } from "./session-provider.ts";
import { runEngine, type ProviderUsage } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import type { AutoAuditRecord } from "../permissions/auto/engine.ts";
import { CLASSIFIER_TOOL_NAME } from "./classifier/verdict-schema.ts";
import { chatCatalog, chatModel, chatProvider, startRawChatFake, type RawChatFake, type RawChatFakeOptions } from "./raw-chat-fake.test-support.ts";

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

interface Driven {
  results: Array<Record<string, unknown>>;
  identities: Array<Record<string, unknown>>;
  audits: AutoAuditRecord[];
  requests: RawChatFake["requests"];
}

async function drive(opts: { fake: RawChatFake; catalog: WinterCatalog; config: RuntimeConfig; turns: string[] }): Promise<Driven> {
  const wiring = buildSessionProvider({ config: opts.config, env: {}, catalog: opts.catalog, credentials: createMemoryCredentialStore() });
  const identities: Array<Record<string, unknown>> = [];
  const audits: AutoAuditRecord[] = [];
  const { host, runtime } = createInMemoryChannel();
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const identity = wiring.identity!;
  const done = runEngine({
    config: opts.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    tools: stubExecutor,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: String(wiring.resolved!.adapter.family), adapterId: identity.adapterId, adapterVersion: identity.adapterVersion, catalogVersion: identity.catalogVersion, authRefKind: identity.authRefKind },
    resolveModelSwitch: wiring.resolveModelSwitch,
    priceUsage: (modelKey: string, usage: ProviderUsage) => wiring.priceUsage(modelKey, usage),
    ...(wiring.classifier !== undefined ? { classifier: wiring.classifier } : {}),
    ...(wiring.classifierIdentity !== undefined ? { classifierIdentity: wiring.classifierIdentity } : {}),
    autoAudit: { record: (entry: AutoAuditRecord) => void audits.push(entry) },
    store: { recordUserEntry() {}, recordAssistantEntry() {}, setProviderIdentity: (id: Record<string, unknown>) => void identities.push(id) },
  } as never);
  const awaitResults = async (n: number): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (dataMessages(frames).filter((m) => m.type === "result").length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} results`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  for (let i = 0; i < opts.turns.length; i++) {
    host.output.write({ type: "user", text: opts.turns[i]! });
    await awaitResults(i + 1);
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await reader;
  await done;
  return { results: dataMessages(frames).filter((m) => m.type === "result") as Array<Record<string, unknown>>, identities, audits, requests: opts.fake.requests };
}

async function withFake(options: RawChatFakeOptions, run: (fake: RawChatFake) => Promise<void>): Promise<void> {
  const fake = await startRawChatFake(options);
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

function config(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { sessionId: "fixe-e4e5", cwd: process.cwd(), model: "prova/m1", persistSession: false, provider: { providerId: "prova", authRef: { kind: "inline", value: "fixture" } }, ...over } as RuntimeConfig;
}

// The fake reports 100 prompt + 10 completion tokens per generation; the priced row lists $2 / $10 per
// million, so ONE generation costs 100/1e6*2 + 10/1e6*10 = 0.0002 + 0.0001 = 0.0003.
const PER_GENERATION_USD = 0.0003;

function pricedCatalog(api: string): WinterCatalog {
  return chatCatalog([chatProvider("prova", api)], [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1", pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 10 }, contextWindow: 4096 })]);
}

describe("Ruling E-4 (R6-H): cost goes LIVE on the result frame", () => {
  test("a PRICED row: the result carries the exact `total_cost_usd` and a `modelUsage` row keyed by the model string, with the catalog key as `canonicalModel` and the descriptor's window", async () => {
    await withFake({}, async (fake) => {
      const r = await drive({ fake, catalog: pricedCatalog(fake.url), config: config(), turns: ["one"] });
      const result = r.results[0]!;
      expect(result.total_cost_usd as number).toBeCloseTo(PER_GENERATION_USD, 10);
      const usage = (result.modelUsage as Record<string, Record<string, unknown>>)["prova/m1"];
      expect(usage).toBeDefined();
      expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, canonicalModel: "prova/m1", contextWindow: 4096, costBasis: "list" });
      expect(usage!.costUSD as number).toBeCloseTo(PER_GENERATION_USD, 10);
      // OMITTED, never invented: the row declares no `maxOutputTokens`, and `prova` maps to no pinned `apiProvider` family.
      expect("maxOutputTokens" in usage!).toBe(false);
      expect("provider" in usage!).toBe(false);
    });
  });

  test("the total ACCUMULATES over the run and every result repeats it (the pinned lifecycle: read the newest, never add)", async () => {
    await withFake({}, async (fake) => {
      const r = await drive({ fake, catalog: pricedCatalog(fake.url), config: config(), turns: ["one", "two"] });
      expect(r.results[0]!.total_cost_usd as number).toBeCloseTo(PER_GENERATION_USD, 10);
      expect(r.results[1]!.total_cost_usd as number).toBeCloseTo(2 * PER_GENERATION_USD, 10);
      const usage = (r.results[1]!.modelUsage as Record<string, Record<string, unknown>>)["prova/m1"]!;
      expect(usage.inputTokens).toBe(200);
      expect(usage.outputTokens).toBe(20);
    });
  });

  test("an UNPRICED row: no cost field at all -- never an invented zero -- and `maxBudgetUsd` is inert", async () => {
    await withFake({}, async (fake) => {
      const catalog = chatCatalog([chatProvider("prova", fake.url)], [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1" })]);
      const r = await drive({ fake, catalog, config: config({ maxBudgetUsd: 0.0000001 }), turns: ["one", "two"] });
      for (const result of r.results) {
        expect("total_cost_usd" in result).toBe(false);
        expect("modelUsage" in result).toBe(false);
        expect(result.subtype).toBe("success");
      }
      expect(fake.requests).toHaveLength(2);
    });
  });

  test("`maxBudgetUsd`: the request that would cross an already-exceeded ceiling never goes out -- the turn ends on the pinned `error_max_budget_usd` result, carrying the cost that crossed it", async () => {
    await withFake({}, async (fake) => {
      // Turn 1 costs 0.0003 -- under a 0.0004 ceiling, so it completes. Turn 2's generation runs
      // (the ceiling is checked BEFORE each request, and 0.0003 < 0.0004) and lands the total at
      // 0.0006; turn 3's first request is what does not go out.
      const r = await drive({ fake, catalog: pricedCatalog(fake.url), config: config({ maxBudgetUsd: 0.0004 }), turns: ["one", "two", "three"] });
      expect(r.results[0]!.subtype).toBe("success");
      expect(r.results[1]!.subtype).toBe("success");
      expect(r.results[2]!.subtype).toBe("error_max_budget_usd");
      expect(r.results[2]!.is_error).toBe(true);
      expect(r.results[2]!.total_cost_usd as number).toBeCloseTo(2 * PER_GENERATION_USD, 10);
      expect((r.results[2]!.modelUsage as Record<string, unknown>)["prova/m1"]).toBeDefined();
      // Exactly two requests reached the provider: the cut is a request that was never sent.
      expect(fake.requests).toHaveLength(2);
    });
  });
});

// --- Ruling E-5 ---------------------------------------------------------------------------------

/** The fake, scripted for the pin: the SESSION's turns call Bash once then answer; the CLASSIFIER's forced tool call answers a verdict. */
function pinScript(): RawChatFakeOptions {
  return {
    script: (request) => {
      if (request.body.includes(`"name":"${CLASSIFIER_TOOL_NAME}"`)) {
        return { toolCall: { id: "verdict_1", name: CLASSIFIER_TOOL_NAME, arguments: JSON.stringify({ verdict: "allow", category: "network", severity: "low", reasonCode: "fixture_ok" }) } };
      }
      // The session: a Bash call that no built-in read-only rule covers, then the answer.
      if (!request.body.includes('"role":"tool"')) return { toolCall: { id: "call_bash", name: "Bash", arguments: JSON.stringify({ command: `curl https://example.invalid/${request.body.length}` }) } };
      return { text: "done" };
    },
  };
}

describe("Ruling E-5 (R6-14): the first successful classification PINS the classifier", () => {
  test("through the REAL route against the fake: the identity is restamped with `classifierPin`, the audit stream gets the `fallback_state` record with the pinned model and the live policy version/hash, and it happens ONCE", async () => {
    await withFake(pinScript(), async (fake) => {
      const catalog = chatCatalog([chatProvider("prova", fake.url)], [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1" }), chatModel({ key: "prova/reviewer", providerId: "prova", upstreamId: "reviewer" })]);
      const r = await drive({
        fake,
        catalog,
        config: config({ permissionMode: "auto", allowDangerouslySkipPermissions: false, autoClassifier: { model: "prova/reviewer" } }),
        turns: ["one", "two"],
      });
      // The classifier was CONSULTED, on the fake, with the reviewer's wire id (the second turn's
      // call may be answered from the auto engine's own verdict cache -- the pin is about the FIRST).
      const reviews = fake.requests.filter((req) => req.body.includes(`"name":"${CLASSIFIER_TOOL_NAME}"`));
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews.every((req) => req.model === "reviewer")).toBe(true);
      // Both turns completed: the verdict allowed the call.
      expect(r.results.map((res) => res.subtype)).toEqual(["success", "success"]);
      // THE PIN, restamped WHOLE (the identity's own fields survive beside it), exactly once.
      const pinned = r.identities.filter((id) => id.classifierPin !== undefined);
      expect(pinned).toHaveLength(1);
      expect(pinned[0]).toMatchObject({ providerId: "prova", modelKey: "prova/m1", adapterId: "winter.openai-chat-completions", authRefKind: "inline", classifierPin: "prova/reviewer" });
      // THE AUDIT EVENT: T10's promised `fallback_state` record, naming the pinned model.
      const pinEvents = r.audits.filter((a) => a.reasonCode === "classifier_pinned");
      expect(pinEvents).toHaveLength(1);
      expect(pinEvents[0]).toMatchObject({ type: "fallback_state", fallbackActive: false, model: "prova/reviewer", toolName: "Bash", verdict: "allow" });
      expect(typeof pinEvents[0]!.policyVersion).toBe("number");
      expect(typeof pinEvents[0]!.policyHash).toBe("string");
      expect(pinEvents[0]!.policyHash.length).toBeGreaterThan(0);
      expect(typeof pinEvents[0]!.latencyMs).toBe("number");
      // The pin event sits among the auto engine's OWN records (the recorder is shared).
      expect(r.audits.some((a) => a.type === "classifier_result")).toBe(true);
    });
  });

  test("a classification that yields NO verdict pins nothing", async () => {
    await withFake(
      {
        script: (request) => {
          if (request.body.includes(`"name":"${CLASSIFIER_TOOL_NAME}"`)) return { text: "I would rather not say" }; // no tool call -> no_verdict
          if (!request.body.includes('"role":"tool"')) return { toolCall: { id: "call_bash", name: "Bash", arguments: JSON.stringify({ command: "curl https://example.invalid/x" }) } };
          return { text: "done" };
        },
      },
      async (fake) => {
        const catalog = chatCatalog([chatProvider("prova", fake.url)], [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1" }), chatModel({ key: "prova/reviewer", providerId: "prova", upstreamId: "reviewer" })]);
        const r = await drive({
          fake,
          catalog,
          config: config({ permissionMode: "auto", allowDangerouslySkipPermissions: false, autoClassifier: { model: "prova/reviewer" } }),
          turns: ["one"],
        });
        expect(fake.requests.some((req) => req.body.includes(`"name":"${CLASSIFIER_TOOL_NAME}"`))).toBe(true);
        expect(r.identities.some((id) => id.classifierPin !== undefined)).toBe(false);
        expect(r.audits.some((a) => a.reasonCode === "classifier_pinned")).toBe(false);
      },
    );
  });
});
