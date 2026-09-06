// P6 fix wave, Rulings E-2 and E-3 (whole-branch review C-2, I-1, I-6, M-3, M-6, M-8): the SWITCH SEAM.
//
// Probe P2 of the whole-branch review drove a real catalog-resolved adapter against a loopback fake
// and applied a `set_model` between two turns. The wire got the right id for a provider-local request
// (P2a) and the CATALOG KEY verbatim for a picker row's `value` (P2b); every post-switch sidecar
// `origin` named the OLD model and domain; `providerHistory` mixed a key with a raw string. Each
// fixture below is one of those observations with its assertion inverted, plus the two things the
// ruling adds -- the cross-domain warning with its handoff record, and `fallbackModel` finally
// engaging -- and the two refusals (`provider-mismatch`, unresolvable) that must never be parked.
//
// GROUND TRUTH IS THE FAKE'S REQUEST LOG for the wire, the store double's records for the sidecar,
// and the frame stream for what the host saw.
import { describe, expect, test } from "bun:test";
import type { ProtocolSdkMessage as SdkMessage, RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { buildSessionProvider, type SessionProviderWiring } from "./session-provider.ts";
import { ProviderTurnError, runEngine, type EngineProviderIdentity, type ModelSwitchResolution, type Provider, type ProviderRequest, type ResolveModelSwitch } from "../engine.ts";
import { foldProviderStream } from "./bridge.ts";
import { stubExecutor } from "./mock.ts";
import { createInMemoryChannel } from "../protocol/channel.ts";
import type { ProviderStateRecordInput } from "../store/provider-state.ts";
import { chatCatalog, chatModel, chatProvider, startRawChatFake, type RawChatFake } from "./raw-chat-fake.test-support.ts";

// --- the harness ----------------------------------------------------------------------------------

type Step = { user: string } | { setModel: unknown; expectOk: boolean };

interface Driven {
  wireModels: (string | undefined)[];
  records: ProviderStateRecordInput[];
  switches: Array<{ from: string; to: string; reason: string }>;
  messages: SdkMessage[];
  controlResponses: Array<{ requestId: string; ok: boolean; error?: { code: string; message: string } }>;
  identities: Array<Record<string, unknown>>;
}

function dataMessages(frames: WinterFrame[]): SdkMessage[] {
  return frames.filter((f) => f.type === "data").map((f) => (f as { message: SdkMessage }).message);
}

/** Drives the REAL engine on a REAL catalog-resolved wiring against the fake, one step at a time, each user step awaited to its terminal result. */
async function drive(opts: { fake: RawChatFake; catalog: WinterCatalog; config: RuntimeConfig; steps: Step[]; wiringOverride?: (wiring: SessionProviderWiring) => Partial<Parameters<typeof runEngine>[0]> }): Promise<Driven> {
  const wiring = buildSessionProvider({ config: opts.config, env: {}, catalog: opts.catalog, credentials: createMemoryCredentialStore() });
  const records: ProviderStateRecordInput[] = [];
  const switches: Driven["switches"] = [];
  const identities: Array<Record<string, unknown>> = [];
  const { host, runtime } = createInMemoryChannel();
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const identity = wiring.identity;
  const done = runEngine({
    config: opts.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    tools: stubExecutor,
    supportedModels: () => wiring.supportedModels(),
    ...(identity !== undefined
      ? {
          providerIdentity: {
            providerId: identity.providerId,
            modelKey: identity.modelKey,
            family: String(wiring.resolved!.adapter.family),
            ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}),
            adapterId: identity.adapterId,
            adapterVersion: identity.adapterVersion,
            catalogVersion: identity.catalogVersion,
            authRefKind: identity.authRefKind,
          },
        }
      : {}),
    resolveModelSwitch: wiring.resolveModelSwitch,
    ...(wiring.fallbackModelKeys.length > 0 ? { fallbackModels: wiring.fallbackModelKeys } : {}),
    store: {
      recordUserEntry() {},
      recordAssistantEntry() {},
      recordProviderState(record: ProviderStateRecordInput) {
        records.push(record);
      },
      recordProviderSwitch(entry: { from: string; to: string; reason: string }) {
        switches.push(entry);
      },
      setProviderIdentity(id: Record<string, unknown>) {
        identities.push(id);
      },
    },
    ...(opts.wiringOverride?.(wiring) ?? {}),
  } as never);
  const awaitResults = async (n: number): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (dataMessages(frames).filter((m) => m.type === "result").length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} results`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const awaitControl = async (requestId: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for control response ${requestId}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  let results = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("user" in step) {
      host.output.write({ type: "user", text: step.user });
      results++;
      await awaitResults(results);
    } else {
      const requestId = `m${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: "set_model", payload: step.setModel });
      await awaitControl(requestId);
      const ack = frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId) as { ok: boolean };
      expect(ack.ok, `set_model ${JSON.stringify(step.setModel)} acknowledged ${ack.ok}`).toBe(step.expectOk);
    }
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await reader;
  await done;
  return {
    wireModels: opts.fake.requests.map((r) => r.model),
    records,
    switches,
    messages: dataMessages(frames),
    controlResponses: frames.filter((f) => f.type === "control_response") as Driven["controlResponses"],
    identities,
  };
}

const switchFrames = (messages: SdkMessage[]) => messages.filter((m) => m.type === "system" && (m as { subtype?: string }).subtype === "model_switch") as Array<Record<string, unknown>>;
const warningFrames = (messages: SdkMessage[]) => messages.filter((m) => m.type === "system" && (m as { subtype?: string }).subtype === "continuity_warning") as Array<Record<string, unknown>>;
const origins = (records: ProviderStateRecordInput[]) => records.filter((r) => r.kind === "origin").map((r) => `${r.model} / ${r.continuationDomain ?? "none"}`);

function config(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { sessionId: "fixe-e2", cwd: process.cwd(), model: "prova/m1", persistSession: false, provider: { providerId: "prova", authRef: { kind: "inline", value: "fixture" } }, ...over } as RuntimeConfig;
}

/** Two models in TWO single-member continuation domains -- the P2 world. */
function twoDomainCatalog(api: string): WinterCatalog {
  return chatCatalog(
    [chatProvider("prova", api), chatProvider("provb", api)],
    [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1", domain: ["prova/m1"] }), chatModel({ key: "prova/m2", providerId: "prova", upstreamId: "m2", domain: ["prova/m2"], aliases: ["second"] }), chatModel({ key: "provb/other", providerId: "provb", upstreamId: "other" })],
  );
}

async function withFake(run: (fake: RawChatFake) => Promise<void>, options?: Parameters<typeof startRawChatFake>[0]): Promise<void> {
  const fake = await startRawChatFake(options);
  try {
    await run(fake);
  } finally {
    await fake.close();
  }
}

// --- Ruling E-2: the switch point ---------------------------------------------------------------

describe("Ruling E-2: `set_model` resolves FIRST and the switch rebuilds provider, identity and model key", () => {
  test("(P2a, inverted) a PROVIDER-LOCAL id: the wire gets m1 then m2, the post-switch origins name the NEW model and domain, and history/frames carry BOTH ids as catalog keys (M-3)", async () => {
    await withFake(async (fake) => {
      const r = await drive({ fake, catalog: twoDomainCatalog(fake.url), config: config(), steps: [{ user: "first" }, { setModel: { model: "m2" }, expectOk: true }, { user: "second" }] });
      expect(r.wireModels).toEqual(["m1", "m2"]);
      expect(origins(r.records)).toEqual(["prova/m1 / prova/m1", "prova/m2 / prova/m2"]);
      expect(r.switches).toEqual([{ from: "prova/m1", to: "prova/m2", reason: "set_model" }]);
      const frames = switchFrames(r.messages);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ reason: "set_model", from_model: "prova/m1", to_model: "prova/m2", provider: "prova" });
      // The dialect record is RESTAMPED with the whole new identity (setProviderIdentity SETS).
      expect(r.identities.at(-1)).toMatchObject({ providerId: "prova", modelKey: "prova/m2", adapterId: "winter.openai-chat-completions", authRefKind: "inline" });
    });
  });

  test("(P2b, inverted) the QUALIFIED catalog key -- what `supportedModels()` rows carry as `value` -- goes on the wire as the provider-local id", async () => {
    await withFake(async (fake) => {
      const r = await drive({
        fake,
        catalog: twoDomainCatalog(fake.url),
        config: config(),
        steps: [{ user: "first" }, { setModel: { model: "prova/m2" }, expectOk: true }, { user: "second" }],
      });
      expect(r.wireModels).toEqual(["m1", "m2"]);
      expect(origins(r.records)).toEqual(["prova/m1 / prova/m1", "prova/m2 / prova/m2"]);
    });
  });

  test("an ALIAS resolves to its row -- the key is what the identity carries and the wire id is the row's own", async () => {
    await withFake(async (fake) => {
      const r = await drive({ fake, catalog: twoDomainCatalog(fake.url), config: config(), steps: [{ user: "first" }, { setModel: { model: "second" }, expectOk: true }, { user: "second" }] });
      expect(r.wireModels).toEqual(["m1", "m2"]);
      expect(switchFrames(r.messages)[0]).toMatchObject({ from_model: "prova/m1", to_model: "prova/m2" });
    });
  });

  test("a CROSS-DOMAIN switch emits `continuity_warning: cross_domain_replay_dropped` (counts and identity only) and writes the `handoff` sidecar record anchored at the source's last entry (M-6)", async () => {
    await withFake(async (fake) => {
      const r = await drive({ fake, catalog: twoDomainCatalog(fake.url), config: config(), steps: [{ user: "first" }, { setModel: { model: "prova/m2" }, expectOk: true }, { user: "second" }] });
      const warnings = warningFrames(r.messages);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.warning).toBe("cross_domain_replay_dropped");
      const detail = String(warnings[0]!.detail);
      expect(detail).toContain("switching from prova/m1 to prova/m2");
      expect(detail).toContain("assistant message");
      // `warnings.ts`'s own prose for a hidden-reasoning source whose state is bound to its provider.
      expect(detail).toContain("starts a new reasoning context");
      // Ordering: the warning precedes the switch announcement.
      const kinds = r.messages.filter((m) => m.type === "system").map((m) => (m as { subtype: string }).subtype);
      expect(kinds.indexOf("continuity_warning")).toBeLessThan(kinds.indexOf("model_switch"));
      // The handoff record: kind `handoff`, anchored at the SOURCE's last assistant entry, produced
      // by `buildPortableHandoff` (its delimiter is the proof), naming source and target.
      const lastSourceOrigin = r.records.filter((rec) => rec.kind === "origin" && rec.model === "prova/m1").at(-1)!;
      const handoff = r.records.find((rec) => rec.kind === "handoff");
      expect(handoff).toBeDefined();
      expect(handoff!.anchorUuid).toBe(lastSourceOrigin.anchorUuid);
      expect(handoff!.model).toBe("prova/m1");
      // The frame carries NO anchor (a per-run uuid would break cross-leg and golden comparison); the record does.
      expect(warnings[0]!.anchor_uuid).toBeUndefined();
      const payload = handoff!.payload as { text: string; target: { providerId: string; modelKey: string } };
      expect(payload.text).toContain("<prior_model_handoff");
      expect(payload.text).toContain("prova / prova/m1");
      expect(payload.target).toEqual({ providerId: "prova", modelKey: "prova/m2" });
      // The handoff is NOT put on the wire: the next request carries the user's own text only.
      expect(fake.requests[1]!.body).not.toContain("prior_model_handoff");
    });
  });

  test("a SAME-DOMAIN switch (two models declaring one certified domain) is lossless: no warning, no handoff record, still announced", async () => {
    await withFake(async (fake) => {
      const catalog = chatCatalog(
        [chatProvider("prova", fake.url)],
        [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1", domain: ["prova/m1", "prova/m2"] }), chatModel({ key: "prova/m2", providerId: "prova", upstreamId: "m2", domain: ["prova/m1", "prova/m2"] })],
      );
      const r = await drive({ fake, catalog, config: config(), steps: [{ user: "first" }, { setModel: { model: "prova/m2" }, expectOk: true }, { user: "second" }] });
      expect(r.wireModels).toEqual(["m1", "m2"]);
      expect(warningFrames(r.messages)).toHaveLength(0);
      expect(r.records.some((rec) => rec.kind === "handoff")).toBe(false);
      expect(switchFrames(r.messages)).toHaveLength(1);
    });
  });

  test("a switch between two models with NO reasoning transport is trivially lossless: no warning", async () => {
    await withFake(async (fake) => {
      const catalog = chatCatalog([chatProvider("prova", fake.url)], [chatModel({ key: "prova/m1", providerId: "prova", upstreamId: "m1" }), chatModel({ key: "prova/m2", providerId: "prova", upstreamId: "m2" })]);
      const r = await drive({ fake, catalog, config: config(), steps: [{ user: "first" }, { setModel: { model: "prova/m2" }, expectOk: true }, { user: "second" }] });
      expect(warningFrames(r.messages)).toHaveLength(0);
      expect(r.wireModels).toEqual(["m1", "m2"]);
    });
  });

  test("a key qualified for ANOTHER provider is `ok:false invalid_model` (R6-K provider-mismatch) and is NEVER parked -- the next turn stays on the session's model", async () => {
    await withFake(async (fake) => {
      const r = await drive({ fake, catalog: twoDomainCatalog(fake.url), config: config(), steps: [{ user: "first" }, { setModel: { model: "provb/other" }, expectOk: false }, { user: "second" }] });
      const refusal = r.controlResponses.find((c) => c.requestId === "m1")!;
      expect(refusal.error?.code).toBe("invalid_model");
      expect(refusal.error?.message).toContain("provider-mismatch");
      expect(r.wireModels).toEqual(["m1", "m1"]);
      expect(switchFrames(r.messages)).toHaveLength(0);
      expect(r.switches).toEqual([]);
    });
  });

  test("an UNRESOLVABLE model is `ok:false invalid_model` naming the catalog miss, never parked", async () => {
    await withFake(async (fake) => {
      const r = await drive({ fake, catalog: twoDomainCatalog(fake.url), config: config(), steps: [{ user: "first" }, { setModel: { model: "no-such-model" }, expectOk: false }, { user: "second" }] });
      const refusal = r.controlResponses.find((c) => c.requestId === "m1")!;
      expect(refusal.error?.code).toBe("invalid_model");
      expect(refusal.error?.message).toContain("unknown-model");
      expect(r.wireModels).toEqual(["m1", "m1"]);
    });
  });

  test("the pin's THREE-WAY reset spelling goes through the seam: `default` resolves back to the session model, with keys on the frame", async () => {
    await withFake(async (fake) => {
      const r = await drive({
        fake,
        catalog: twoDomainCatalog(fake.url),
        config: config(),
        steps: [{ user: "first" }, { setModel: { model: "m2" }, expectOk: true }, { user: "second" }, { setModel: { model: "default" }, expectOk: true }, { user: "third" }],
      });
      expect(r.wireModels).toEqual(["m1", "m2", "m1"]);
      expect(r.switches).toEqual([
        { from: "prova/m1", to: "prova/m2", reason: "set_model" },
        { from: "prova/m2", to: "prova/m1", reason: "set_model" },
      ]);
    });
  });

  test("`set_model` to the model ALREADY running is acknowledged and announces nothing (the same exact profile is never a switch)", async () => {
    await withFake(async (fake) => {
      const r = await drive({ fake, catalog: twoDomainCatalog(fake.url), config: config(), steps: [{ user: "first" }, { setModel: { model: "prova/m1" }, expectOk: true }, { user: "second" }] });
      expect(r.wireModels).toEqual(["m1", "m1"]);
      expect(switchFrames(r.messages)).toHaveLength(0);
      expect(warningFrames(r.messages)).toHaveLength(0);
    });
  });

  test("a session that STARTED unresolvable recovers through `set_model` to a key that resolves (the refusal arm's builder is live)", async () => {
    await withFake(async (fake) => {
      const r = await drive({
        fake,
        catalog: twoDomainCatalog(fake.url),
        config: config({ model: "prova/never-existed" }),
        steps: [{ user: "first" }, { setModel: { model: "prova/m1" }, expectOk: true }, { user: "second" }],
      });
      const results = r.messages.filter((m) => m.type === "result") as Array<Record<string, unknown>>;
      expect(results[0]!.is_error).toBe(true);
      expect(results[0]!.terminal_reason).toBe("api_error");
      expect(results[1]!.is_error).toBeFalsy();
      expect(r.wireModels).toEqual(["m1"]);
      expect(switchFrames(r.messages)[0]).toMatchObject({ from_model: "prova/never-existed", to_model: "prova/m1", provider: "prova" });
    });
  });
});

// --- Ruling E-3: fallbackModel ENGAGES -------------------------------------------------------------

/** A scripted seam: two identities in one domain, each with its own recording provider. */
function scriptedSeam(providers: Record<string, Provider>, domain: (key: string) => string | undefined): ResolveModelSwitch {
  return (model, from) => {
    const provider = providers[model];
    if (provider === undefined) return { refused: true, code: "unknown-model", message: `no ${model}` };
    const d = domain(model);
    const identity: EngineProviderIdentity = { providerId: "p", modelKey: model, family: "openai", ...(d !== undefined ? { continuationDomain: d } : {}) };
    const resolution: ModelSwitchResolution = {
      provider,
      identity,
      to: { providerId: "p", modelKey: model, family: "openai", readableState: "none", continuation: "none", ...(d !== undefined ? { continuationDomain: d } : {}) },
      ...(from !== undefined ? { from: { providerId: from.providerId, modelKey: from.modelKey, family: String(from.family), readableState: "none", continuation: "none", ...(from.continuationDomain !== undefined ? { continuationDomain: from.continuationDomain } : {}) } } : {}),
    };
    return resolution;
  };
}

function recording(script: Array<ProviderRequest | Error | string>): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let i = 0;
  return {
    requests,
    provider: {
      async generate(input) {
        requests.push(input);
        const step = script[Math.min(i, script.length - 1)];
        i++;
        if (step instanceof Error) throw step;
        return { kind: "text", text: typeof step === "string" ? step : "done" };
      },
    },
  };
}

const retryableFailure = () => new ProviderTurnError("provider request failed (server): scripted 503 after retries", { status: 503, code: "server", retryable: true });
const terminalFailure = () => new ProviderTurnError("provider request failed (bad_request): scripted 400", { status: 400, code: "bad_request", retryable: false });

async function driveScripted(opts: { primary: Provider; seam: ResolveModelSwitch; fallbackModels: string[]; turns: number; parkedSetModel?: string; identityDomain?: string }): Promise<{ messages: SdkMessage[]; switches: Array<{ from: string; to: string; reason: string }> }> {
  const switches: Array<{ from: string; to: string; reason: string }> = [];
  const { host, runtime } = createInMemoryChannel();
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const done = runEngine({
    config: { sessionId: "fixe-e3", cwd: process.cwd(), model: "p/a", persistSession: false } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider: opts.primary,
    tools: stubExecutor,
    providerIdentity: { providerId: "p", modelKey: "p/a", family: "openai", ...(opts.identityDomain !== undefined ? { continuationDomain: opts.identityDomain } : {}) },
    resolveModelSwitch: opts.seam,
    fallbackModels: opts.fallbackModels,
    store: { recordUserEntry() {}, recordAssistantEntry() {}, recordProviderSwitch(entry: { from: string; to: string; reason: string }) { switches.push(entry); } },
  } as never);
  const awaitResults = async (n: number): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (dataMessages(frames).filter((m) => m.type === "result").length < n) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} results`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  for (let t = 1; t <= opts.turns; t++) {
    if (t === 2 && opts.parkedSetModel !== undefined) host.output.write({ type: "control_request", requestId: "park", subtype: "set_model", payload: { model: opts.parkedSetModel } });
    host.output.write({ type: "user", text: `turn ${t}` });
    await awaitResults(t);
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await reader;
  await done;
  return { messages: dataMessages(frames), switches };
}

describe("Ruling E-3: `fallbackModel` engages on an R6-6 retryable-class failure, silently at parity, announced by Winter", () => {
  test("the primary fails on a retryable class -> the candidate serves the SAME round; `model_switch{reason:'fallback'}` + providerHistory; the primary is re-tried at the next user turn and restored, announced", async () => {
    const a = recording([retryableFailure(), "a is back"]);
    const b = recording(["b served it"]);
    const seam = scriptedSeam({ "p/a": a.provider, "p/b": b.provider }, () => undefined);
    const r = await driveScripted({ primary: a.provider, seam, fallbackModels: ["p/b"], turns: 2 });
    // Turn 1: a failed once, b served the same user turn on the re-run.
    expect(a.requests[0]!.model).toBe("p/a");
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.model).toBe("p/b");
    const results = r.messages.filter((m) => m.type === "result") as Array<Record<string, unknown>>;
    expect(results[0]!.result).toBe("b served it");
    expect(results[0]!.is_error).toBeFalsy();
    // Turn 2: the primary was re-tried FIRST, and answered.
    expect(a.requests).toHaveLength(2);
    expect(results[1]!.result).toBe("a is back");
    // Announced both ways, as `fallback`, with the keys.
    expect(r.switches).toEqual([
      { from: "p/a", to: "p/b", reason: "fallback" },
      { from: "p/b", to: "p/a", reason: "fallback" },
    ]);
    const frames = switchFrames(r.messages);
    expect(frames.map((f) => [f.reason, f.from_model, f.to_model])).toEqual([
      ["fallback", "p/a", "p/b"],
      ["fallback", "p/b", "p/a"],
    ]);
    // Silent at parity: no pinned refusal-fallback frame for an overload.
    expect(r.messages.some((m) => String((m as { subtype?: string }).subtype ?? "").startsWith("model_refusal"))).toBe(false);
  });

  test("candidates are tried IN ORDER and each once per turn; when every candidate fails the turn lands on R6-F", async () => {
    const a = recording([retryableFailure()]);
    const b = recording([retryableFailure()]);
    const c = recording([retryableFailure()]);
    const seam = scriptedSeam({ "p/a": a.provider, "p/b": b.provider, "p/c": c.provider }, () => undefined);
    const r = await driveScripted({ primary: a.provider, seam, fallbackModels: ["p/b", "p/c"], turns: 1 });
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(c.requests).toHaveLength(1);
    const result = r.messages.find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.is_error).toBe(true);
    expect(result.terminal_reason).toBe("api_error");
    expect(result.api_error_status).toBe(503);
    expect(r.switches.map((s) => s.to)).toEqual(["p/b", "p/c"]);
  });

  test("a NON-retryable class never engages a fallback: the turn lands on R6-F at once and the candidate is never called", async () => {
    const a = recording([terminalFailure()]);
    const b = recording(["never"]);
    const seam = scriptedSeam({ "p/a": a.provider, "p/b": b.provider }, () => undefined);
    const r = await driveScripted({ primary: a.provider, seam, fallbackModels: ["p/b"], turns: 1 });
    expect(b.requests).toHaveLength(0);
    expect(r.switches).toEqual([]);
    expect((r.messages.find((m) => m.type === "result") as Record<string, unknown>).api_error_status).toBe(400);
  });

  test("a candidate OUTSIDE the current model's continuation domain is skipped (R6-9), even though the list was accepted at init", async () => {
    const a = recording([retryableFailure()]);
    const b = recording(["never"]);
    const seam = scriptedSeam({ "p/a": a.provider, "p/b": b.provider }, (key) => key); // each model its own domain
    const r = await driveScripted({ primary: a.provider, seam, fallbackModels: ["p/b"], turns: 1, identityDomain: "p/a" });
    expect(b.requests).toHaveLength(0);
    expect(r.switches).toEqual([]);
    expect((r.messages.find((m) => m.type === "result") as Record<string, unknown>).is_error).toBe(true);
  });

  test("a `set_model` parked during the fallback turn WINS over the primary's restoration", async () => {
    const a = recording([retryableFailure(), "never again"]);
    const b = recording(["b served it", "b again"]);
    const c = recording(["c chosen by the host"]);
    const seam = scriptedSeam({ "p/a": a.provider, "p/b": b.provider, "p/c": c.provider }, () => undefined);
    const r = await driveScripted({ primary: a.provider, seam, fallbackModels: ["p/b"], turns: 2, parkedSetModel: "p/c" });
    expect(a.requests).toHaveLength(1);
    expect(c.requests).toHaveLength(1);
    expect(r.switches).toEqual([
      { from: "p/a", to: "p/b", reason: "fallback" },
      { from: "p/b", to: "p/c", reason: "set_model" },
    ]);
  });

  test("the bridge carries R6-6's verdict onto the typed error: an adapter's normalized `server` error folds to `retryable: true`, a `bad_request` to `false`", async () => {
    async function* failing(code: "server" | "bad_request") {
      yield { type: "error" as const, error: { code, message: "scripted", status: code === "server" ? 503 : 400, retryable: code === "server" } };
    }
    let server: unknown;
    try {
      await foldProviderStream(failing("server") as never);
    } catch (err) {
      server = err;
    }
    expect(server).toBeInstanceOf(ProviderTurnError);
    expect((server as ProviderTurnError).retryable).toBe(true);
    expect((server as ProviderTurnError).code).toBe("server");
    let bad: unknown;
    try {
      await foldProviderStream(failing("bad_request") as never);
    } catch (err) {
      bad = err;
    }
    expect((bad as ProviderTurnError).retryable).toBe(false);
  });
});
