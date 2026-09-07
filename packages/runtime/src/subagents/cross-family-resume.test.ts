// P6.6 (WS-13c §8, Lane D Task 5): "SendMessage across families -- the child's own record is
// authoritative." This lane's own report opens with the investigation these tests were written to
// prove: BEFORE the fix in child-engine.ts, a "same-provider" child (one whose model equals whatever
// `deps.resolveChildProvider` treats as the parent's own baseline) recorded NO identity of its own at
// all, and every generation it ever ran -- spawn AND every future resume alike -- fell through to
// `deps.provider` by a fresh, un-memoized property read on every `startGeneration` call, with nothing
// pinning it to what was true when IT was spawned. `deps` is a plain, caller-held, mutable object;
// nothing in child-engine.ts's own structure stopped a later reassignment of `deps.provider` from
// reaching an already-spawned, already-resumed child. These tests simulate exactly that reassignment
// (never by re-registering the child-engine factory -- an empirical diagnostic run during this task's
// own investigation proved a fresh `registerChildEngineFactory()` call has ZERO effect on a handle
// spawned before it, since `engine.ts`'s own `ctx.session.spawnChild` reads the registry only ONCE,
// at spawn time; the only way a live handle's `deps` can change is a caller holding the same object
// mutating one of its properties directly, which is exactly what a stale-and-later-swapped `provider`
// field looks like from inside child-engine.ts).
//
// Drives `spawnChildEngine` directly through the public `createChildEngineFactory(deps)(runCtx).
// spawn(req, inherit)` seam (proven minimal shape: seam-contracts-p4.test.ts's `{parentSessionId,
// forwardChildFrame}` runCtx) rather than a full parent `runEngine()` round trip -- this suite is
// about `resume()`'s OWN provider re-resolution, not about the Agent tool's own spawn path (already
// covered end-to-end elsewhere in child-engine.test.ts).
import { describe, test, expect, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildEngineFactory, type ChildEngineFactoryDeps, type ChildProviderIdentity } from "./child-engine.ts";
import type { ChildEngineRunContext, ChildInheritance, SpawnChildRequest, ChildHandle, ChildSessionRecord } from "./child-handle.ts";
import { restoredChildHandle } from "./restore.ts";
import { createScriptedProviderFake } from "./test-fakes.ts";
import { resetSpawnLimitsForTest } from "./limits.ts";
import type { RecordedModelEffort } from "./resolution.ts";
import type { GlobalAgentMessage } from "../messaging/adapter.ts";

const tempDirs: string[] = [];
function freshSessionRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "winter-lane-d-cross-family-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  resetSpawnLimitsForTest();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeMessage(body: string): GlobalAgentMessage {
  const addr = { objectKind: "session" as const, runtimeKind: "winter-agent" as const, winterSessionId: "s1" };
  return {
    messageId: `m-${randomUUID()}`,
    from: addr,
    fromGeneration: 1,
    to: addr,
    toGeneration: 1,
    body,
    notifyWhenIdle: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    hopCount: 0,
    senderPermissionClass: "unknown",
  };
}

function baseInherit(overrides: Partial<ChildInheritance> = {}): ChildInheritance {
  return {
    policy: { effectiveMode: "bypassPermissions", parentPolicyVersion: 1, parentPolicyHash: "h" },
    tools: [],
    model: "winter-test/echo",
    effort: "inherit",
    thinking: undefined,
    systemPrompt: "",
    sessionRoot: freshSessionRoot(),
    ...overrides,
  };
}

function baseReq(overrides: Partial<SpawnChildRequest> = {}): SpawnChildRequest {
  return { parentToolUseId: "call-1", prompt: "hello child", runInBackground: false, ...overrides };
}

function minimalRunCtx(): ChildEngineRunContext {
  return { parentSessionId: `parent-${randomUUID()}`, forwardChildFrame: () => {} };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!predicate()) throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
}

// Spawns via the real seam and waits for the FIRST generation to settle -- every fake here answers a
// plain text turn (createScriptedProviderFake's own default), which completes a round immediately.
async function spawnAndSettle(deps: ChildEngineFactoryDeps, req: SpawnChildRequest, inherit: ChildInheritance): Promise<ChildHandle> {
  const childDeps = createChildEngineFactory(deps)(minimalRunCtx());
  const handle = await childDeps.spawn(req, inherit);
  await waitUntil(() => handle.status() === "completed" || handle.status() === "failed");
  return handle;
}

// `ChildSessionRecord.model` (child-handle.ts, spine-frozen) still declares the pre-P6.6 inline
// shape; child-engine.ts's own `record` widens it locally to `RecordedModelEffort` (see that file's
// own comment on `record`'s declaration) but `ChildHandle.record`'s PUBLIC type is unchanged, so a
// consumer outside that file needs the identical cast to read `effectiveProvider`/`slot` back.
function modelInfo(handle: ChildHandle): RecordedModelEffort {
  return handle.record.model as RecordedModelEffort;
}

describe("WS-13c §8: SendMessage across families -- the child's own record is authoritative on resume", () => {
  test("WS13c-SM1: a claude-slot child resumed after the parent moved to claude keeps its own provider and model", async () => {
    const fakeA = createScriptedProviderFake(); // the parent's provider AT SPAWN (e.g. gpt)
    const fakeB = createScriptedProviderFake(); // the CHILD's own resolved provider (anthropic) -- must serve every generation
    const fakeC = createScriptedProviderFake(); // the parent's NEW provider after `set_model` to claude -- must never be reached by this child
    const model = "anthropic/claude-sonnet-5";
    const identity: ChildProviderIdentity = { providerId: "anthropic", modelKey: model, family: "claude" };
    const deps: ChildEngineFactoryDeps = {
      provider: fakeA,
      env: {},
      resolveChildProvider: (requested) => (requested === model ? { provider: fakeB, identity } : undefined),
    };

    const handle = await spawnAndSettle(deps, baseReq({ model }), baseInherit({ model, slot: { family: "claude", name: "sonnet", source: "family-default" } }));
    expect(handle.record.model.effectiveModel).toBe(model);
    expect(modelInfo(handle).effectiveProvider).toBe("anthropic");
    expect(fakeB.callCount()).toBe(1);
    expect(fakeA.callCount()).toBe(0);

    // The parent's own factory now hands out fakeC for any FUTURE spawn (a family switch) -- this
    // already-live handle must never observe it.
    deps.provider = fakeC;

    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("resumed_and_delivered");
    await waitUntil(() => handle.status() === "completed");

    expect(fakeB.callCount()).toBe(2); // served BOTH the spawn and the resume
    expect(fakeA.callCount()).toBe(0);
    expect(fakeC.callCount()).toBe(0); // the parent's post-switch provider never saw this child
    expect(modelInfo(handle).effectiveProvider).toBe("anthropic"); // the record's identity is unchanged
    expect(modelInfo(handle).slot).toEqual({ family: "claude", name: "sonnet", source: "family-default" });
  });

  test("WS13c-SM2: the mirror -- a luna child resumed after the parent moved from claude to gpt", async () => {
    const fakeA = createScriptedProviderFake(); // the parent's provider AT SPAWN (claude)
    const fakeB = createScriptedProviderFake(); // the child's own resolved provider (openai/luna)
    const fakeC = createScriptedProviderFake(); // the parent's new provider after moving to gpt
    const model = "openai/gpt-5.6-luna";
    const identity: ChildProviderIdentity = { providerId: "openai", modelKey: model, family: "gpt" };
    const deps: ChildEngineFactoryDeps = {
      provider: fakeA,
      env: {},
      resolveChildProvider: (requested) => (requested === model ? { provider: fakeB, identity } : undefined),
    };

    const handle = await spawnAndSettle(deps, baseReq({ model }), baseInherit({ model, slot: { family: "gpt", name: "luna", source: "family-default" } }));
    expect(modelInfo(handle).effectiveProvider).toBe("openai");
    expect(fakeB.callCount()).toBe(1);

    deps.provider = fakeC;

    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("resumed_and_delivered");
    await waitUntil(() => handle.status() === "completed");

    expect(fakeB.callCount()).toBe(2);
    expect(fakeA.callCount()).toBe(0);
    expect(fakeC.callCount()).toBe(0);
    expect(modelInfo(handle).effectiveProvider).toBe("openai");
  });

  test("I1 (Fix round 1, review repro 4): a successful re-resolution onto a DIFFERENT provider than recorded is a typed refusal, never a silent substitution", async () => {
    // Not a WS13c-SM* named case -- a permanent regression test for a review finding (I1): a
    // resolver that returns a genuinely SUCCESSFUL resolution (no `refused`, not `undefined`) for
    // the child's own recorded model, but onto a DIFFERENT provider id than the one recorded at
    // spawn, must never be trusted unconditionally. Before this fix: `resumed_and_delivered`, the
    // substituted provider served the resume, and `record.model.effectiveProvider` was silently
    // rewritten out from under its own history -- inert only because today's production resolver is
    // deterministic over a session-start snapshot (see the report's §1.6/I1 finding); once that
    // snapshot is made live, a bare-id resolution after a parent `set_model` reaches exactly this
    // branch for real.
    const fakeA = createScriptedProviderFake(); // deps.provider -- irrelevant to this cross-provider child
    const fakeB = createScriptedProviderFake(); // the CHILD's own resolved provider at spawn (anthropic)
    const fakeD = createScriptedProviderFake(); // what the resolver maps the SAME model onto by resume time (bedrock) -- must never be reached
    const model = "anthropic/claude-sonnet-5";
    let mapToBedrock = false;
    const deps: ChildEngineFactoryDeps = {
      provider: fakeA,
      env: {},
      resolveChildProvider: (requested) => {
        if (requested !== model) return undefined;
        return mapToBedrock
          ? { provider: fakeD, identity: { providerId: "bedrock", modelKey: model, family: "claude" } }
          : { provider: fakeB, identity: { providerId: "anthropic", modelKey: model, family: "claude" } };
      },
    };

    const handle = await spawnAndSettle(deps, baseReq({ model }), baseInherit({ model }));
    expect(modelInfo(handle).effectiveProvider).toBe("anthropic");
    expect(fakeB.callCount()).toBe(1);

    mapToBedrock = true; // the resolver now maps this SAME recorded model onto a different provider
    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain("child-provider-unavailable");
      expect(outcome.reason).toContain("anthropic");
      expect(outcome.reason).toContain("bedrock");
    }
    // No substitution: the record is UNCHANGED, and the substituted provider never served anything.
    expect(handle.status()).toBe("completed");
    expect(modelInfo(handle).effectiveProvider).toBe("anthropic");
    expect(fakeD.callCount()).toBe(0);
    expect(fakeB.callCount()).toBe(1);
  });

  test("I1's mirror: a successful re-resolution onto the SAME recorded provider (recovery after an at-spawn refusal) is honoured, not refused", async () => {
    // The guard above must not make every successful re-resolution suspect -- only a provider-id
    // MISMATCH refuses. A child refused at spawn under Ruling E-1 still records the target it was
    // refused for (`childProvider.identity` on the refused branch); once that credential exists again,
    // resume's re-resolution matches the recorded id and must recover onto a real adapter.
    const fakeRefused = createScriptedProviderFake(); // never actually called -- the deferred-refusal provider throws if invoked
    const fakeRecovered = createScriptedProviderFake(); // the SAME provider id, now servable
    const model = "anthropic/claude-sonnet-5";
    const identity: ChildProviderIdentity = { providerId: "anthropic", modelKey: model, family: "claude" };
    let credentialPresent = false;
    const deps: ChildEngineFactoryDeps = {
      provider: createScriptedProviderFake(),
      env: {},
      resolveChildProvider: (requested) => {
        if (requested !== model) return undefined;
        if (!credentialPresent) {
          return {
            refused: { providerId: "anthropic", modelKey: model, reason: "no credential yet" },
            provider: {
              async generate(): Promise<never> {
                throw new Error("the deferred-refusal provider must never actually be called");
              },
            },
            identity,
          };
        }
        return { provider: fakeRecovered, identity };
      },
    };

    const handle = await spawnAndSettle(deps, baseReq({ model }), baseInherit({ model }));
    // A refused-at-spawn child still records the target identity (childProvider.identity is set on
    // the refused branch too) -- its own first generation settles immediately (the deferred-refusal
    // provider's `generate` throws, caught by `startGeneration`'s own `.catch`, settling "failed").
    expect(modelInfo(handle).effectiveProvider).toBe("anthropic");

    credentialPresent = true; // the credential now exists
    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("resumed_and_delivered");
    await waitUntil(() => handle.status() === "completed");
    expect(fakeRecovered.callCount()).toBe(1);
    expect(fakeRefused.callCount()).toBe(0);
    expect(modelInfo(handle).effectiveProvider).toBe("anthropic");
  });

  test("Fix round 1 (coordinator follow-up): recordModelEffort stamps BOTH effectiveProvider and slot from the child's own materialised identity, and omits both keys entirely when absent", async () => {
    const fakeA = createScriptedProviderFake();
    const fakeWithSlot = await spawnAndSettle(
      { provider: fakeA, env: {} },
      baseReq(),
      baseInherit({
        provider: { providerId: "openai", modelKey: "gpt-5.6-luna", family: "gpt" },
        slot: { family: "gpt", name: "luna", source: "family-default" },
      }),
    );
    expect(modelInfo(fakeWithSlot).effectiveProvider).toBe("openai");
    expect(modelInfo(fakeWithSlot).slot).toEqual({ family: "gpt", name: "luna", source: "family-default" });

    const fakeB = createScriptedProviderFake();
    const withoutSlot = await spawnAndSettle(
      { provider: fakeB, env: {} },
      baseReq(),
      baseInherit({ provider: { providerId: "openai", modelKey: "gpt-5.6-luna", family: "gpt" } }), // no `slot`
    );
    expect(modelInfo(withoutSlot).effectiveProvider).toBe("openai"); // identity alone is still recorded
    // The spine's own JSON round-trip rule (resolution.ts's `recordModelEffort`): an unset field is a
    // genuinely ABSENT key, never a `slot: undefined` that would disagree with a fresh parse of the
    // same record from its durable sidecar.
    expect(Object.hasOwn(modelInfo(withoutSlot), "slot")).toBe(false);
  });

  test("WS13c-SM3: a child whose provider lost its credential is a typed refusal on resume, never the parent's provider (a REFUSED re-resolution)", async () => {
    const fakeA = createScriptedProviderFake();
    const fakeB = createScriptedProviderFake();
    const model = "anthropic/claude-sonnet-5";
    const identity: ChildProviderIdentity = { providerId: "anthropic", modelKey: model, family: "claude" };
    let credentialLost = false;
    const deps: ChildEngineFactoryDeps = {
      provider: fakeA,
      env: {},
      resolveChildProvider: (requested) => {
        if (requested !== model) return undefined;
        if (credentialLost) {
          return {
            refused: { providerId: "anthropic", modelKey: model, reason: "credential revoked" },
            provider: {
              async generate(): Promise<never> {
                throw new Error("must never be called -- a refused re-resolution must never start a generation");
              },
            },
            identity,
          };
        }
        return { provider: fakeB, identity };
      },
    };

    const handle = await spawnAndSettle(deps, baseReq({ model }), baseInherit({ model }));
    expect(fakeB.callCount()).toBe(1);

    credentialLost = true;
    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain("child-provider-unavailable");
      expect(outcome.reason).toContain("anthropic");
    }
    // No generation ever started: the record never left its prior terminal status, and neither the
    // child's OWN provider nor the parent's saw a second call.
    expect(handle.status()).toBe("completed");
    expect(fakeA.callCount()).toBe(0);
    expect(fakeB.callCount()).toBe(1);
  });

  test("WS13c-SM3: a child whose provider lost its credential is a typed refusal on resume, never the parent's provider (an UNRESOLVABLE re-resolution)", async () => {
    const fakeA = createScriptedProviderFake();
    const fakeB = createScriptedProviderFake();
    const model = "anthropic/claude-sonnet-5";
    const identity: ChildProviderIdentity = { providerId: "anthropic", modelKey: model, family: "claude" };
    let resolvable = true;
    const deps: ChildEngineFactoryDeps = {
      provider: fakeA,
      env: {},
      resolveChildProvider: (requested) => {
        if (requested !== model) return undefined;
        return resolvable ? { provider: fakeB, identity } : undefined; // "cannot be resolved at all" once false
      },
    };

    // Fix round 1 (I2): the parent's OWN identity, DIFFERENT from the child's ("anthropic"), through
    // `inherit.provider` -- the PRODUCTION source (R6-17, engine.ts:2405's live `buildChildInheritance`
    // read), not the deleted `deps.parentIdentity` override. If resume ever fell back onto
    // `deps.provider` here it would be a silent substitution onto the parent's family.
    const handle = await spawnAndSettle(deps, baseReq({ model }), baseInherit({ model, provider: { providerId: "openai", modelKey: "gpt-5.6-terra", family: "gpt" } }));
    expect(fakeB.callCount()).toBe(1);

    resolvable = false;
    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain("child-provider-unavailable");
      expect(outcome.reason).toContain("anthropic");
    }
    expect(handle.status()).toBe("completed");
    expect(fakeA.callCount()).toBe(0);
    expect(fakeB.callCount()).toBe(1);
  });

  test("a same-provider child (childProvider undefined at spawn) records the parent's identity at spawn and re-resolves to THAT on resume", async () => {
    const fakeA = createScriptedProviderFake(); // deps.provider AT SPAWN
    const fakeC = createScriptedProviderFake(); // deps.provider AFTER the swap -- must never be reached
    const deps: ChildEngineFactoryDeps = {
      provider: fakeA,
      env: {},
      // No `resolveChildProvider` at all -- the exact bug this lane's report investigates: today,
      // pre-fix, `childProvider` stays `undefined` here and every generation reads `deps.provider`
      // fresh, forever, with nothing pinning it to what was true at spawn.
    };

    // Fix round 1 (I2): the identity comes from `inherit.provider` -- the PRODUCTION source
    // (R6-17, engine.ts:2405) -- never the deleted `deps.parentIdentity` override, so this is the
    // ONE test in this file that exercises the exact path a real spawned session uses.
    const handle = await spawnAndSettle(deps, baseReq(), baseInherit({ provider: { providerId: "openai", modelKey: "gpt-5.6-terra", family: "gpt" } }));
    expect(fakeA.callCount()).toBe(1);
    expect(modelInfo(handle).effectiveProvider).toBe("openai");

    // Simulate the parent's family switch the ONLY way a live handle could ever observe one: the
    // SAME `deps` object this handle's own closure holds gets a new `.provider`.
    deps.provider = fakeC;

    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("resumed_and_delivered");
    await waitUntil(() => handle.status() === "completed");

    expect(fakeA.callCount()).toBe(2); // served BOTH generations -- the fix
    expect(fakeC.callCount()).toBe(0); // never reached, despite being `deps.provider` throughout the resume
    expect(modelInfo(handle).effectiveProvider).toBe("openai"); // unchanged
  });

  test("a same-provider child spawned and resumed with NO identity information anywhere is byte-identical to a pre-P6.6 child (no effectiveProvider key, no refusal)", async () => {
    const fakeA = createScriptedProviderFake();
    const deps: ChildEngineFactoryDeps = { provider: fakeA, env: {} }; // no resolveChildProvider, no parentIdentity, inherit.provider absent
    const handle = await spawnAndSettle(deps, baseReq(), baseInherit());
    expect(modelInfo(handle).effectiveProvider).toBeUndefined();

    const outcome = await handle.resume(fakeMessage("second turn"));
    expect(outcome.status).toBe("resumed_and_delivered"); // never a refusal -- there is nothing to contradict
    await waitUntil(() => handle.status() === "completed");
    expect(fakeA.callCount()).toBe(2);
    expect(modelInfo(handle).effectiveProvider).toBeUndefined();
  });

  test("restore.ts: a restored handle's resume refusal names the recorded provider id (WS-13c §8's restore.ts requirement)", async () => {
    const modelField: RecordedModelEffort = { effectiveModel: "anthropic/claude-sonnet-5", effectiveEffort: "inherit", effectiveProvider: "anthropic" };
    const record: ChildSessionRecord = {
      id: "agent-restored-1",
      parentSessionId: "session-restored-1",
      parentToolUseId: "call-restored-1",
      transcript: "/tmp/nowhere/agent-agent-restored-1.jsonl",
      status: "stopped",
      runtime: "winter-agent",
      model: modelField,
      permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
    };
    const handle = restoredChildHandle(record);
    const outcome = await handle.resume(fakeMessage("hi"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain("restored from durable storage"); // pre-existing text, unchanged
      expect(outcome.reason).toContain("recorded provider: anthropic");
    }
  });

  test("restore.ts: a restored handle with no recorded provider identity keeps the pre-existing refusal text verbatim (no fabricated note)", async () => {
    const record: ChildSessionRecord = {
      id: "agent-restored-2",
      parentSessionId: "session-restored-2",
      parentToolUseId: "call-restored-2",
      transcript: "/tmp/nowhere/agent-agent-restored-2.jsonl",
      status: "failed",
      runtime: "winter-agent",
      model: { effectiveModel: "sonnet", effectiveEffort: "inherit" },
      permission: { effectiveMode: "default", parentPolicyHash: "h", parentPolicyVersion: 1 },
    };
    const handle = restoredChildHandle(record);
    const outcome = await handle.resume(fakeMessage("hi"));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.reason).not.toContain("recorded provider");
    }
  });
});
