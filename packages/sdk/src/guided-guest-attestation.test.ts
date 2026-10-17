// This is the ONLY test file in the repository that calls claimGuidedGuestIssuer() against the real module instance:
// the issuer is claimable once per module instance and `bun test` shares one registry across files. Other
// instances (a cache-busted import, a capacity subprocess) are separate module instances.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "./query.ts";
import type { Options } from "./options.ts";
import type { SpawnRuntimeOptions, SpawnedRuntimeProcess } from "./transport.ts";
import { prepareGuidedQuery, claimGuidedQuery, closeGuidedQuery, consumeGuidedQueryCorrelation, assertGuidedQueryCorrelation, bindGuidedGuestGuard,
  type GuidedQueryClaim, type GuidedQueryCorrelation, type GuidedQueryPreparation } from "./guided-query-preparation.ts";
import { claimGuidedGuestIssuer, type GuidedGuestIssuer, type GuidedGuestTicket } from "./guided-guest-attestation.ts";
import * as published from "./index.ts";
import { readGuidedQueryInstructions } from "./guided-query-reader.ts";
import { encodeFrame, splitFrames } from "./protocol/codec.ts";
import { PROTOCOL_VERSION, type WinterFrame, type ControlRequestFrame, type ControlResponseFrame } from "./protocol/frames.ts";
import type { RuntimeConfig } from "./protocol/config.ts";
import { Queue } from "../../runtime/src/protocol/channel.ts";

const issuer = claimGuidedGuestIssuer();
const GUEST = "confined-guest" as const;
const snapshot = { revision: "r1", facts: "host facts", instructions: "current guidance" };
const raw = '{"snapshot":{"text":"current source bytes"}}\n';
const contextId = "00000000-0000-4000-8000-00000000000a";
const result = { type: "data", message: { type: "result", subtype: "success", is_error: false } } as WinterFrame;
const refusal = (call: () => unknown) => expect(call).toThrow("required_context_unavailable");
const context = (config: RuntimeConfig, change = {}): WinterFrame => ({ type: "control_request", subtype: "runtime_context", requestId: contextId,
  payload: { bindingId: config.requiredRuntimeContext!.bindingId, sessionId: config.sessionId, cwd: "/guest/source", purpose: "generation", attempt: 1, ...change } });
const isRead = (frame: WinterFrame) => frame.type === "control_request" && frame.subtype === "instruction_reader";
const isContextAnswer = (frame: WinterFrame) => frame.type === "control_response" && frame.requestId === contextId;
async function nextFrame(queue: Queue<WinterFrame>, predicate: (frame: WinterFrame) => boolean): Promise<WinterFrame> {
  for (;;) { const next = await queue[Symbol.asyncIterator]().next(); if (next.done) throw new Error("fixture transport ended"); if (predicate(next.value)) return next.value; }
}
const answerRead = (read: ControlRequestFrame): WinterFrame => ({ type: "control_response", requestId: read.requestId, ok: true, payload: { ...(read.payload as object), frame: raw } });

let sequence = 0;
const fresh = async (tag: string) => await import(`./guided-guest-attestation.ts?${tag}`) as typeof import("./guided-guest-attestation.ts");
interface Control { advance(): void; finish(): void; preparation(): GuidedQueryPreparation; }
type Scenario = (config: RuntimeConfig, frames: Queue<WinterFrame>, control: Control) => AsyncIterable<WinterFrame>;
interface GuestOptions {
  callback?: (request: unknown, options: { signal: AbortSignal; trustedQuerySessionId: string }) => Promise<typeof snapshot>;
  scenario?: Scenario; onSpawn?: (options: SpawnRuntimeOptions) => void; onKill?: () => void; workspace?: string;
}
/** A guided preparation with a minted ticket, a recording virtual process and a scripted runtime. */
function guest(setup: GuestOptions = {}) {
  const workspace = setup.workspace ?? `ws-${++sequence}`;
  let epoch = 1;
  if (setup.workspace === undefined) issuer.advance(workspace, "inc-1", 1);
  const writes: WinterFrame[] = [], input = new Queue<WinterFrame>(), kills: (string | undefined)[] = [];
  let ends = 0, spawns = 0, callbacks = 0, finish!: () => void, observed: { claim: GuidedQueryClaim; expected: GuidedQueryCorrelation; args: string[]; config: RuntimeConfig; spawn: SpawnRuntimeOptions } | undefined;
  let preparation!: GuidedQueryPreparation;
  const control: Control = { advance: () => { epoch++; issuer.advance(workspace, `inc-${epoch}`, epoch); }, finish: () => finish(), preparation: () => preparation };
  const pair = {
    onRuntimeContext: async (request: unknown, options: { signal: AbortSignal; trustedQuerySessionId: string }) => {
      callbacks++; return setup.callback ? setup.callback(request, options) : snapshot;
    },
    spawnClaudeCodeProcess(spawn: SpawnRuntimeOptions): SpawnedRuntimeProcess {
      spawns++;
      const config: RuntimeConfig = JSON.parse(spawn.args[2]!);
      consumeGuidedQueryCorrelation(spawn.guidedQueryClaim!, spawn.args);
      observed = { claim: spawn.guidedQueryClaim!, expected: config.requiredRuntimeContext!, args: spawn.args, config, spawn };
      setup.onSpawn?.(spawn);
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => { finish = () => resolve({ code: 0, signal: null }); });
      return { stdin: { write(bytes) { for (const frame of splitFrames(bytes, "").frames) { writes.push(frame); input.write(frame); } }, end() { ends++; } },
        stdout: (async function* () { try {
          yield encodeFrame({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: config.sessionId, cwd: "/guest/source", model: "fixture", permissionMode: "default", tools: [], runtimeContextVersion: 1 });
          for await (const frame of (setup.scenario ?? defaultScenario)(config, input, control)) yield encodeFrame(frame);
        } finally { finish(); } })(),
        exited, kill(signal) { kills.push(signal); setup.onKill?.(); }, pid: null };
    },
  };
  preparation = prepareGuidedQuery(pair);
  const ticket = issuer.mint({ workspaceKey: workspace, incarnationId: "inc-1", leaseEpoch: 1, preparation });
  const options: Options = { ...pair, guidedQueryPreparation: preparation, guidedGuestTicket: ticket, executionPosture: GUEST, requireRuntimeContext: true, sessionId: "backend", cwd: "/host/correlation-only" };
  return { workspace, ticket, preparation, pair, options, writes, kills, control,
    ends: () => ends, spawns: () => spawns, callbacks: () => callbacks, observed: () => observed,
    run: async (override: Partial<Options> = {}) => { for await (const _ of query({ prompt: "fixture", options: { ...options, ...override } })) {} },
    active: () => { expect(observed).toBeDefined(); assertGuidedQueryCorrelation(observed!.claim, observed!.expected); },
    closed: () => { refusal(() => claimGuidedQuery(preparation, pair)); const state = observed;
      if (state) { refusal(() => assertGuidedQueryCorrelation(state.claim, state.expected)); refusal(() => consumeGuidedQueryCorrelation(state.claim, state.args)); } },
  };
}
const defaultScenario: Scenario = async function* (config, frames) {
  yield context(config);
  expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).payload).toEqual(snapshot);
  yield result;
};
/** A ticket that must be dead: presented again with a fresh preparation it is refused with zero spawn or callback. */
function expectSpent(ticket: GuidedGuestTicket) {
  let spawns = 0, callbacks = 0;
  const pair = { onRuntimeContext: async () => { callbacks++; return snapshot; }, spawnClaudeCodeProcess: (): never => { spawns++; throw new Error("hook tripwire"); } };
  const preparation = prepareGuidedQuery(pair);
  refusal(() => query({ prompt: "fixture", options: { ...pair, guidedQueryPreparation: preparation, requireRuntimeContext: true, executionPosture: GUEST, guidedGuestTicket: ticket } }));
  expect(spawns).toBe(0); expect(callbacks).toBe(0); refusal(() => claimGuidedQuery(preparation, pair));
}
/** A bare guided preparation whose hook only counts and throws, so "reached the hook" is observable. */
function bare() {
  let hooks = 0;
  const pair = { onRuntimeContext: async () => snapshot, spawnClaudeCodeProcess: (): never => { hooks++; throw new Error("hook tripwire"); } };
  return { pair, preparation: prepareGuidedQuery(pair), hooks: () => hooks };
}
/** True when query() accepted the ticket and reached the host's spawn hook (the bare hook then throws). */
function reachesHook(base: ReturnType<typeof bare>, ticket: GuidedGuestTicket): boolean {
  try { query({ prompt: "fixture", options: { ...base.pair, guidedQueryPreparation: base.preparation, requireRuntimeContext: true, executionPosture: GUEST, guidedGuestTicket: ticket } }); }
  catch (error) { if ((error as Error).message !== "hook tripwire") expect((error as Error).message).toBe("required_context_unavailable"); }
  return base.hooks() === 1;
}
const workspaceOf = () => { const key = `ws-${++sequence}`; issuer.advance(key, "inc-1", 1); return key; };
const mintFor = (preparation: GuidedQueryPreparation, key = workspaceOf()) => issuer.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1, preparation });

// ---- the issuer: one claim, closed surface ------------------------------------------------------------------------

test("the issuer is claimable exactly once per module instance and is a frozen four-method capability", async () => {
  expect(Object.isFrozen(issuer)).toBe(true); expect(Reflect.ownKeys(issuer).sort()).toEqual(["advance", "forget", "mint", "revoke"]);
  refusal(() => claimGuidedGuestIssuer()); refusal(() => claimGuidedGuestIssuer());
  refusal(() => published.claimGuidedGuestIssuer());
  const instance = await fresh("claim-once");
  expect(Reflect.ownKeys(instance.claimGuidedGuestIssuer()).sort()).toEqual(["advance", "forget", "mint", "revoke"]);
  refusal(() => instance.claimGuidedGuestIssuer()); refusal(() => instance.claimGuidedGuestIssuer());
  const detached = { ...issuer }; const key = workspaceOf();
  expect(() => detached.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1, preparation: bare().preparation })).not.toThrow();
});
test("the package exposes the issuer through exactly one value export and no constructor", () => {
  expect(Object.keys(published).filter(name => /guest|issuer|ticket/i.test(name))).toEqual(["claimGuidedGuestIssuer"]);
  // Type-level pins, compiled by the typecheck gate and never executed.
  const typeLevel = () => {
    // @ts-expect-error a ticket is not constructible by shape
    const forged: GuidedGuestTicket = {}; void forged;
    // @ts-expect-error the issuer type is not a class
    void new (null as unknown as GuidedGuestIssuer)();
  };
  void typeLevel;
});
test("tickets are frozen opaque objects: they cannot serialize, clone, spread or be wrapped", () => {
  const f = guest();
  expect(Object.isFrozen(f.ticket)).toBe(true); expect(Object.getPrototypeOf(f.ticket)).toBe(null); expect(Reflect.ownKeys(f.ticket)).toEqual(["toJSON"]);
  refusal(() => JSON.stringify(f.ticket)); refusal(() => JSON.stringify({ guidedGuestTicket: f.ticket }));
  closeGuidedQuery(f.preparation);
  // Every structural copy is presented with the very preparation the genuine ticket was minted for.
  const copies: Record<string, (ticket: GuidedGuestTicket) => unknown> = {
    empty: () => ({}), nullPrototype: () => Object.create(null), spread: ticket => ({ ...ticket }), assign: ticket => Object.assign({}, ticket),
    structuredClone: ticket => structuredClone(ticket), proxy: ticket => new Proxy(ticket, {}), derived: ticket => Object.create(ticket),
    frozenCopy: ticket => Object.freeze({ ...ticket }), preparation: (_ticket) => f.preparation, text: () => "ticket", number: () => 7, boolean: () => true,
    nil: () => null, array: () => [], fn: ticket => () => ticket, symbol: () => Symbol("ticket"),
  };
  for (const [name, copy] of Object.entries(copies)) {
    const g = guest();
    refusal(() => query({ prompt: "fixture", options: { ...g.options, guidedGuestTicket: copy(g.ticket) as GuidedGuestTicket } }));
    expect(g.spawns()).toBe(0); expect(g.callbacks()).toBe(0); g.closed(); void name;
  }
});

// ---- mint ---------------------------------------------------------------------------------------------------------

test("mint binds a workspace's announced generation to one still-prepared preparation", () => {
  const key = workspaceOf(), base = bare();
  const request = { workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1, preparation: base.preparation };
  refusal(() => issuer.mint({ ...request, workspaceKey: "ws-never-announced" }));
  refusal(() => issuer.mint({ ...request, incarnationId: "inc-2" })); refusal(() => issuer.mint({ ...request, leaseEpoch: 2 }));
  issuer.advance(key, "inc-1", 2);
  refusal(() => issuer.mint(request)); // The stale generation can no longer be minted.
  expect(() => issuer.mint({ ...request, leaseEpoch: 2, incarnationId: "inc-1" })).not.toThrow();
  refusal(() => issuer.mint({ ...request, leaseEpoch: 2 })); // One ticket per preparation, ever.
});
test("mint refuses a forged, wrapped, claimed or closed preparation and a malformed request", () => {
  const key = workspaceOf(), base = bare(), good = { workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1, preparation: base.preparation };
  for (const preparation of [{} as GuidedQueryPreparation, { ...base.preparation }, structuredClone(base.preparation), new Proxy(base.preparation, {}), null as unknown as GuidedQueryPreparation]) {
    refusal(() => issuer.mint({ ...good, preparation }));
  }
  const claimed = bare(); claimGuidedQuery(claimed.preparation, claimed.pair); refusal(() => issuer.mint({ ...good, preparation: claimed.preparation }));
  const closed = bare(); closeGuidedQuery(closed.preparation); refusal(() => issuer.mint({ ...good, preparation: closed.preparation }));
  let reads = 0;
  const accessor = Object.defineProperty({ ...good }, "workspaceKey", { get() { reads++; return key; }, enumerable: true });
  for (const request of [null, undefined, [], "x", 1, { ...good, extra: 1 }, { workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1 }, accessor,
    new Proxy(good, { ownKeys() { throw new Error("private supplied text"); } }), Object.create(good), { ...good, workspaceKey: "" }, { ...good, workspaceKey: "has space" },
    { ...good, workspaceKey: "x".repeat(129) }, { ...good, workspaceKey: 7 }, { ...good, incarnationId: "" }, { ...good, incarnationId: "bad/slash" }]) {
    refusal(() => issuer.mint(request as never));
  }
  for (const leaseEpoch of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) refusal(() => issuer.mint({ ...good, leaseEpoch: leaseEpoch as number }));
  expect(reads).toBe(0);
  expect(() => issuer.mint(good)).not.toThrow(); // None of the refusals above consumed the preparation.
});

// ---- advance: counters only move forward --------------------------------------------------------------------------

test("a regression or a conflicting identity is refused and applies nothing", () => {
  const key = workspaceOf(); issuer.advance(key, "inc-1", 5);
  const base = bare(), ticket = issuer.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 5, preparation: base.preparation });
  refusal(() => issuer.advance(key, "inc-1", 4)); refusal(() => issuer.advance(key, "inc-1", 1)); refusal(() => issuer.advance(key, "inc-0", 4));
  refusal(() => issuer.advance(key, "inc-2", 5)); // The same epoch under another incarnation id is a conflict, not an advance.
  for (const bad of [0, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "6", null]) {
    refusal(() => issuer.advance(key, "inc-1", bad as number));
    refusal(() => issuer.advance(workspaceOf() + "-new", "inc-1", bad as number)); // A first announcement is validated too.
  }
  for (const id of ["", "bad id", "a/b", "x".repeat(129), 3, null]) { refusal(() => issuer.advance(key, id as string, 6)); refusal(() => issuer.advance(id as string, "inc-1", 6)); }
  issuer.advance(key, "inc-1", 5); // The same pair again is an idempotent no-op.
  // Nothing was applied: the generation is still (inc-1, 5), and the ticket minted under it is accepted.
  expect(() => issuer.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 5, preparation: bare().preparation })).not.toThrow();
  expect(reachesHook(base, ticket)).toBe(true);
});
test("a higher epoch moves the generation even with the same incarnation id, and old pairs can never come back", () => {
  const key = workspaceOf(), base = bare(), later = bare();
  mintFor(base.preparation, key);
  issuer.advance(key, "inc-1", 2);
  refusal(() => claimGuidedQuery(base.preparation, base.pair)); // The advance closed the older preparation at once.
  issuer.advance(key, "inc-9", 3);
  refusal(() => issuer.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1, preparation: later.preparation }));
  refusal(() => issuer.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 2, preparation: later.preparation }));
  refusal(() => issuer.advance(key, "inc-1", 2)); refusal(() => issuer.advance(key, "inc-1", 1));
  expect(() => issuer.mint({ workspaceKey: key, incarnationId: "inc-9", leaseEpoch: 3, preparation: later.preparation })).not.toThrow();
});
test("advancing one workspace, or re-announcing the same pair, kills nothing", async () => {
  const f = guest({ scenario: async function* (config, frames, control) {
    yield context(config);
    issuer.advance(workspaceOf(), "inc-1", 1); // Another workspace.
    issuer.advance(f.workspace, "inc-1", 1); // The same pair again.
    expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).payload).toEqual(snapshot);
    f.active(); yield result;
  } });
  await f.run(); expect(f.callbacks()).toBe(1); expect(f.kills).toEqual([]);
});

// ---- the gate: guided + confined-guest ----------------------------------------------------------------------------

test("a valid ticket lets one guided query run as a confined guest, and nothing leaks onto the wire", async () => {
  const f = guest({ onSpawn(spawn) {
    expect(Object.keys(spawn)).toEqual(["guidedQueryClaim", "command", "args", "cwd", "env", "hostPidEnv"]);
    expect(JSON.stringify(spawn.args) + JSON.stringify(spawn.env)).not.toMatch(/guidedGuestTicket|toJSON/);
  } });
  await f.run();
  const config = f.observed()!.config;
  expect(config.executionPosture).toBe(GUEST); expect(Object.keys(config)).not.toContain("guidedGuestTicket"); expect(Object.keys(config)).not.toContain("guidedQueryPreparation");
  expect(f.spawns()).toBe(1); expect(f.callbacks()).toBe(1); expect(f.kills).toEqual([]);
  f.closed(); f.control.finish(); expectSpent(f.ticket);
  refusal(() => query({ prompt: "retry", options: f.options })); expect(f.spawns()).toBe(1);
});
test("guest posture with no ticket is today's refusal: same error, before the hook, callback or any other check", () => {
  const f = guest(), without = { ...f.options }; delete without.guidedGuestTicket;
  // A bad shape that today is also reported as the same single error must still be that error, not a later one.
  for (const extra of [{}, { hostCodeProcessBroker: { generationId: "g", handle: async () => ({}) } }, { guidedGuestTicket: undefined }]) {
    const attempt = bare(), options = { ...without, ...extra, ...attempt.pair, guidedQueryPreparation: attempt.preparation } as Options;
    let error: unknown; try { query({ prompt: "fixture", options }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("required_context_unavailable");
    refusal(() => claimGuidedQuery(attempt.preparation, attempt.pair));
  }
  expect(f.spawns()).toBe(0); expect(f.callbacks()).toBe(0);
  // A minted ticket that is not presented is not an authorization.
  refusal(() => query({ prompt: "fixture", options: without })); expect(f.spawns()).toBe(0); f.closed();
});
test("a ticket with no guest posture is refused and dies", () => {
  for (const posture of ["absent", "local", "undefined"]) {
    const f = guest(), options: Options = { ...f.options };
    if (posture === "absent") delete options.executionPosture; else options.executionPosture = (posture === "local" ? "local" : undefined) as "local";
    refusal(() => query({ prompt: "fixture", options })); expect(f.spawns()).toBe(0); expect(f.callbacks()).toBe(0); f.closed(); expectSpent(f.ticket);
  }
  const prototyped = guest(), options: Options = { ...prototyped.options }; delete options.executionPosture;
  Object.setPrototypeOf(options, { executionPosture: GUEST });
  refusal(() => query({ prompt: "fixture", options })); expect(prototyped.spawns()).toBe(0); expectSpent(prototyped.ticket);
});
test("a ticket accessor is never read; an inherited ticket is not a ticket", () => {
  let reads = 0, inherited = 0;
  const f = guest(), options: Options = { ...f.options }; delete options.guidedGuestTicket;
  Object.defineProperty(options, "guidedGuestTicket", { get() { reads++; return f.ticket; }, enumerable: true });
  refusal(() => query({ prompt: "fixture", options })); expect(reads).toBe(0); expect(f.spawns()).toBe(0);
  const g = guest(), plain: Options = { ...g.options }; delete plain.guidedGuestTicket;
  Object.setPrototypeOf(plain, Object.defineProperty({}, "guidedGuestTicket", { get() { inherited++; return g.ticket; } }));
  refusal(() => query({ prompt: "fixture", options: plain })); expect(inherited).toBe(0); expect(g.spawns()).toBe(0);
  expectSpent(g.ticket); // The refused attempt closed g's preparation, which killed its ticket.
});
test("a ticket never unlocks non-guided requireRuntimeContext, and non-guided queries do not consult it", () => {
  const f = guest(); let spawns = 0;
  const options: Options = { requireRuntimeContext: true, executionPosture: GUEST, guidedGuestTicket: f.ticket, onRuntimeContext: async () => snapshot,
    spawnClaudeCodeProcess: () => { spawns++; throw new Error("hook tripwire"); } };
  refusal(() => query({ prompt: "fixture", options })); expect(spawns).toBe(0);
  refusal(() => query({ prompt: "fixture", options: { ...options, guidedQueryPreparation: {} as GuidedQueryPreparation } }));
  closeGuidedQuery(f.preparation);
});
test("hostCodeProcessBroker with a valid ticket and confined-guest is still refused, and the ticket is spent", () => {
  const f = guest(), registration = { generationId: "host-gen", handle: async () => ({}) } as never;
  let error: unknown; try { query({ prompt: "fixture", options: { ...f.options, hostCodeProcessBroker: registration } }); } catch (e) { error = e; }
  expect((error as Error).message).toBe("invalid or guest-incompatible trusted host Code process registration");
  expect(f.spawns()).toBe(0); expect(f.callbacks()).toBe(0); f.closed(); expectSpent(f.ticket);
});
test("a ticket presented with a foreign preparation and a bad shape is still spent, and its own preparation closes", () => {
  const owner = guest(), mine = guest();
  refusal(() => query({ prompt: "fixture", options: { ...mine.options, requireRuntimeContext: false, guidedGuestTicket: owner.ticket } }));
  expect(owner.spawns()).toBe(0); expect(mine.spawns()).toBe(0); owner.closed(); mine.closed(); expectSpent(owner.ticket);
});
test("setup failures after a ticket is presented spend it and close its preparation", () => {
  const cases: Record<string, (options: Options) => void> = {
    "required false": options => { options.requireRuntimeContext = false; },
    "foreign callback": options => { options.onRuntimeContext = async () => snapshot; },
    "foreign hook": options => { options.spawnClaudeCodeProcess = () => { throw new Error("foreign hook"); }; },
    "missing callback": options => { delete options.onRuntimeContext; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const f = guest(), options: Options = { ...f.options }; change(options);
    refusal(() => query({ prompt: "fixture", options })); expect(f.spawns()).toBe(0); expect(f.callbacks()).toBe(0); f.closed(); expectSpent(f.ticket); void name;
  }
  const f = guest(); Object.defineProperty(f.options, "brand", { get() { throw new Error("setup before hook"); } });
  expect(() => query({ prompt: "fixture", options: f.options })).toThrow("setup before hook"); f.closed(); expectSpent(f.ticket); expect(f.spawns()).toBe(0);
});

// ---- one-shot ------------------------------------------------------------------------------------------------------

test("a ticket works once: replay on the same or another preparation is refused, a running query is not disturbed", async () => {
  const other = guest();
  const f = guest({ scenario: async function* (config, frames) {
    yield context(config);
    // Replay while running, on a fresh preparation and in another guest's options: refused, and the running query is untouched.
    expectSpent(f.ticket);
    refusal(() => query({ prompt: "replay", options: { ...other.options, guidedGuestTicket: f.ticket } }));
    f.active();
    expect((await nextFrame(frames, isContextAnswer) as ControlResponseFrame).payload).toEqual(snapshot); yield result;
  } });
  await f.run(); expect(f.spawns()).toBe(1); expect(f.callbacks()).toBe(1); expect(f.kills).toEqual([]);
  // other's preparation was closed by the refused presentation, so other's own ticket died with it.
  other.closed(); expectSpent(other.ticket); expect(other.spawns()).toBe(0);
  // Replay on the same preparation after the run: refused (the preparation, like any second claim, is closed).
  f.closed(); refusal(() => query({ prompt: "replay", options: f.options })); f.control.finish();
});
test("a ticket for another preparation is refused, and presenting it spends both", () => {
  const owner = guest(), mine = guest();
  refusal(() => query({ prompt: "fixture", options: { ...mine.options, guidedGuestTicket: owner.ticket } }));
  expect(mine.spawns()).toBe(0); expect(owner.spawns()).toBe(0); mine.closed(); owner.closed(); expectSpent(owner.ticket); expectSpent(mine.ticket);
});
test("a ticket from another module instance is not a ticket", async () => {
  const instance = await fresh("cross-instance"), foreignIssuer = instance.claimGuidedGuestIssuer();
  const base = bare(); foreignIssuer.advance("ws-foreign", "inc-1", 1);
  const ticket = foreignIssuer.mint({ workspaceKey: "ws-foreign", incarnationId: "inc-1", leaseEpoch: 1, preparation: base.preparation });
  refusal(() => query({ prompt: "fixture", options: { ...base.pair, guidedQueryPreparation: base.preparation, requireRuntimeContext: true, executionPosture: GUEST, guidedGuestTicket: ticket } }));
  refusal(() => claimGuidedQuery(base.preparation, base.pair));
});

// ---- expiry by generation ------------------------------------------------------------------------------------------

test("advancing the generation before the claim kills the ticket and closes its preparation", () => {
  const f = guest(); f.control.advance();
  f.closed(); refusal(() => query({ prompt: "fixture", options: f.options })); expect(f.spawns()).toBe(0); expect(f.callbacks()).toBe(0); expectSpent(f.ticket);
  const g = guest(); issuer.advance(g.workspace, "inc-1", 9); // A far jump, same incarnation id.
  refusal(() => query({ prompt: "fixture", options: g.options })); expect(g.spawns()).toBe(0); g.closed();
});
test("advance while the query is being set up stops it before the host's spawn hook", () => {
  const f = guest(); let advanced = false;
  Object.defineProperty(f.options, "brand", { get() { if (!advanced) { advanced = true; f.control.advance(); } return undefined; } });
  refusal(() => query({ prompt: "fixture", options: f.options })); expect(advanced).toBe(true); expect(f.spawns()).toBe(0); expect(f.callbacks()).toBe(0); f.closed();
});
test("advance inside the host's spawn hook fails at the first assert and tears the child down once", () => {
  const f = guest({ onSpawn: () => f.control.advance() });
  refusal(() => query({ prompt: "fixture", options: f.options }));
  expect(f.spawns()).toBe(1); expect(f.callbacks()).toBe(0); expect(f.writes).toEqual([]); expect(f.ends()).toBe(1); expect(f.kills).toEqual([undefined]); f.closed(); f.control.finish();
});
test("advance between construction and the first read tears the child down and the read refuses", async () => {
  const f = guest(), gen = query({ prompt: "fixture", options: f.options });
  f.active(); f.control.advance();
  expect(f.kills).toEqual([undefined]); expect(f.ends()).toBe(1); f.closed();
  await expect(gen.next()).rejects.toThrow("required_context_unavailable");
  expect(f.writes).toEqual([]); expect(f.callbacks()).toBe(0); f.control.finish();
});
test("advance before a context request: the request is never dispatched, the callback never runs and the query rejects", async () => {
  const f = guest({ scenario: async function* (config, _frames, control) { control.advance(); yield context(config); yield result; } });
  await expect(f.run()).rejects.toThrow("required_context_unavailable");
  expect(f.callbacks()).toBe(0); expect(f.writes.some(isContextAnswer)).toBe(false); expect(f.kills).toEqual([undefined]); f.closed(); f.control.finish();
});
test("advance while the callback is awaited: the snapshot is never answered", async () => {
  const f = guest({ callback: async () => { f.control.advance(); await Promise.resolve(); return snapshot; }, scenario: async function* (config, frames) {
    yield context(config);
    const response = await nextFrame(frames, isContextAnswer) as ControlResponseFrame;
    expect(response.ok).toBe(false); expect(response.error?.code).toBe("required_context_unavailable"); expect(response.payload).toBeUndefined(); yield result;
  } });
  await expect(f.run()).rejects.toThrow("required_context_unavailable");
  expect(f.callbacks()).toBe(1); expect(f.kills).toEqual([undefined]); f.closed(); f.control.finish();
});
test("advance before a guided read starts, while one is pending, and after its answer arrives", async () => {
  for (const moment of ["before", "pending", "answered"]) {
    let signal!: AbortSignal, pending: Promise<string> | undefined, readStarted = 0;
    const f = guest({
      callback: async (_request, options) => {
        signal = options.signal;
        if (moment === "before") f.control.advance();
        pending = readGuidedQueryInstructions(f.preparation, signal); readStarted++;
        const outcome = await pending.then(() => "read", () => "refused");
        if (moment === "answered") { f.control.advance(); }
        return outcome === "read" || moment === "answered" ? snapshot : (() => { throw new Error("read failed"); })();
      },
      scenario: async function* (config, frames, control) {
        yield context(config);
        if (moment !== "before") {
          const read = await nextFrame(frames, isRead) as ControlRequestFrame;
          if (moment === "pending") { control.advance(); expect(signal.aborted).toBe(false); expect(await pending!.then(() => "read", () => "refused")).toBe("refused"); }
          yield answerRead(read);
        }
        const response = await nextFrame(frames, isContextAnswer) as ControlResponseFrame;
        expect(response.ok).toBe(false); expect(response.payload).toBeUndefined(); yield result;
      },
    });
    await expect(f.run()).rejects.toThrow("required_context_unavailable");
    expect(readStarted).toBe(1); expect(f.writes.filter(isRead)).toHaveLength(moment === "before" ? 0 : 1);
    await expect(readGuidedQueryInstructions(f.preparation, signal)).rejects.toThrow("required_context_unavailable"); f.closed(); f.control.finish();
  }
});
test("the new generation is installed before any teardown runs: a sibling's step already fails during the loop", () => {
  const key = workspaceOf(); let sibling: ReturnType<typeof guest> | undefined, outcome = "not run";
  const first = guest({ workspace: key, onKill: () => {
    const state = sibling!.observed()!;
    try { assertGuidedQueryCorrelation(state.claim, state.expected); outcome = "still valid"; } catch { outcome = "refused"; }
  } });
  sibling = guest({ workspace: key });
  for (const f of [first, sibling]) { const gen = query({ prompt: "fixture", options: f.options }); void gen; f.active(); }
  issuer.advance(key, "inc-2", 2);
  expect(outcome).toBe("refused"); expect(first.kills).toEqual([undefined]); expect(sibling.kills).toEqual([undefined]); first.closed(); sibling.closed();
  first.control.finish(); sibling.control.finish();
});
test("a ticket still unspent when its workspace advances cannot be spent from inside the revocation loop", () => {
  // The epoch alone must decide: once with a new incarnation id, once with the same one at a higher epoch.
  for (const incarnation of ["inc-2", "inc-1"]) {
    const key = workspaceOf(); let late: ReturnType<typeof guest> | undefined, attempted = false;
    const running = guest({ workspace: key, onKill: () => {
      // Host teardown code runs while advance() is still looping: it tries to start the next guest on a not-yet-revoked ticket.
      attempted = true; refusal(() => query({ prompt: "fixture", options: late!.options }));
    } });
    late = guest({ workspace: key });
    const gen = query({ prompt: "fixture", options: running.options }); void gen; running.active();
    issuer.advance(key, incarnation, 2);
    expect(attempted).toBe(true); expect(late.spawns()).toBe(0); expect(late.callbacks()).toBe(0); late.closed(); expectSpent(late.ticket);
    running.control.finish();
  }
});
test("a preparation with a minted ticket still runs as an ordinary local query without it, and dies with its generation", async () => {
  const f = guest();
  await f.run({ guidedGuestTicket: undefined as never, executionPosture: undefined as never });
  expect(f.observed()!.config.executionPosture).toBeUndefined(); expect(f.spawns()).toBe(1); f.closed(); f.control.finish();
  const g = guest(); g.control.advance(); refusal(() => query({ prompt: "fixture", options: { ...g.options, guidedGuestTicket: undefined as never, executionPosture: undefined as never } }));
  expect(g.spawns()).toBe(0);
});
test("advance tears down every running query of that workspace and only that workspace", () => {
  const key = workspaceOf(), a = guest({ workspace: key }), b = guest({ workspace: key }), elsewhere = guest();
  for (const f of [a, b, elsewhere]) { const gen = query({ prompt: "fixture", options: f.options }); void gen; f.active(); }
  issuer.advance(key, "inc-2", 2);
  for (const f of [a, b]) { expect(f.kills).toEqual([undefined]); expect(f.ends()).toBe(1); f.closed(); }
  expect(elsewhere.kills).toEqual([]); elsewhere.active(); elsewhere.control.advance(); elsewhere.closed();
  for (const f of [a, b, elsewhere]) f.control.finish();
});
test("a throwing teardown callback never stops the rest of the revocation", () => {
  const key = workspaceOf(); const a = guest({ workspace: key, onKill: () => { throw new Error("host kill exploded"); } }), b = guest({ workspace: key });
  for (const f of [a, b]) { const gen = query({ prompt: "fixture", options: f.options }); void gen; f.active(); }
  expect(() => issuer.advance(key, "inc-2", 2)).not.toThrow();
  a.closed(); b.closed(); expect(b.kills).toEqual([undefined]); a.control.finish(); b.control.finish();
});
test("normal completion and abort release the ticket records, so later advances have nothing left to revoke", async () => {
  const f = guest(); await f.run(); f.control.finish();
  const aborted = guest(), abortController = new AbortController();
  query({ prompt: "fixture", options: { ...aborted.options, abortController } }); abortController.abort(); aborted.closed();
  expect(() => { f.control.advance(); aborted.control.advance(); }).not.toThrow(); expect(f.kills).toEqual([]); aborted.control.finish();
});
test("an aborted-before-start guest query is refused and spends the ticket", () => {
  const f = guest(), abortController = new AbortController(); abortController.abort();
  refusal(() => query({ prompt: "fixture", options: { ...f.options, abortController } })); expect(f.spawns()).toBe(0); f.closed(); expectSpent(f.ticket);
});

// ---- bounded state, in a fresh process -----------------------------------------------------------------------------

// ---- a revoked guest's traffic is gated, not only its context steps -----------------------------------------------

const assistantFrame = { type: "data", message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "late words" }] } } } as unknown as WinterFrame;
const isAnswer = (id: string) => (frame: WinterFrame) => frame.type === "control_response" && frame.requestId === id;
const permissionFrame = (id: string): WinterFrame => ({ type: "control_request", requestId: id, subtype: "permission", payload: {
  toolName: "Bash", input: { command: "ls" }, toolUseID: "call-1", agentID: "agent-1", requestId: id, policyVersion: 0 } });
const hookFrame = (id: string): WinterFrame => ({ type: "control_request", requestId: id, subtype: "hook", payload: {
  event: "PreToolUse", matchedMatcher: "Bash", sessionId: "s1", agentID: "agent-1", toolUseID: "call-1", toolName: "Bash", input: { command: "ls" },
  policyVersion: "3", requestId: id, hookId: "PreToolUse:sdk:0:0" } });
const mcpFrame = (id: string): WinterFrame => ({ type: "control_request", requestId: id, subtype: "sdk_mcp_call", payload: { server: "fixture", tool: "echo", arguments: { x: 1 } } });
/** Host callbacks that count their runs, plus an optional action when each runs (to revoke from inside a callback). */
function hostCallbacks(during: () => void = () => {}) {
  const runs = { permission: 0, hook: 0, mcp: 0 };
  const options = {
    canUseTool: async () => { runs.permission++; during(); return { behavior: "allow" as const }; },
    hooks: { PreToolUse: [{ hooks: [async () => { runs.hook++; during(); return {}; }] }] },
    mcpServers: { fixture: { type: "sdk" as const, name: "fixture", instance: {
      listTools: () => [{ name: "echo", inputSchema: { type: "object" } }],
      callTool: async () => { runs.mcp++; during(); return { content: [{ type: "text", text: "echo" }] }; },
    } as never } },
  };
  return { runs, options };
}
/** Iterates a query to its end and reports what reached the consumer and how it ended. */
async function observe(options: Options) {
  const seen: string[] = []; let outcome = "completed";
  try { for await (const message of query({ prompt: "fixture", options })) seen.push(message.type); }
  catch (error) { outcome = (error as Error).message; }
  return { seen, outcome };
}
test("after a revocation no frame reaches the consumer and no host callback runs for a permission, hook or MCP request", async () => {
  const callbacks = hostCallbacks();
  const f = guest({ scenario: async function* (config, frames, control) {
    // Positive controls first: each request is valid and its callback runs while the generation is current.
    yield permissionFrame("perm-1"); expect(((await nextFrame(frames, isAnswer("perm-1"))) as ControlResponseFrame).ok).toBe(true);
    yield hookFrame("hook-1"); expect(((await nextFrame(frames, isAnswer("hook-1"))) as ControlResponseFrame).ok).toBe(true);
    yield mcpFrame("mcp-1"); expect(((await nextFrame(frames, isAnswer("mcp-1"))) as ControlResponseFrame).ok).toBe(true);
    control.advance();
    yield permissionFrame("perm-2"); yield hookFrame("hook-2"); yield mcpFrame("mcp-2"); yield context(config); yield assistantFrame; yield result;
  } });
  const { seen, outcome } = await observe({ ...f.options, ...callbacks.options });
  expect(outcome).toBe("required_context_unavailable"); expect(seen).toEqual([]);
  expect(callbacks.runs).toEqual({ permission: 1, hook: 1, mcp: 1 });
  for (const id of ["perm-2", "hook-2", "mcp-2", contextId]) expect(f.writes.some(isAnswer(id))).toBe(false);
  expect(f.callbacks()).toBe(0); expect(f.kills).toEqual([undefined]); f.closed(); f.control.finish();
});
test("a result after a revocation rejects instead of completing", async () => {
  const f = guest({ scenario: async function* (config, frames, control) {
    yield context(config); await nextFrame(frames, isContextAnswer); control.advance(); yield assistantFrame; yield result;
  } });
  const { seen, outcome } = await observe(f.options);
  expect(outcome).toBe("required_context_unavailable"); expect(seen).toEqual([]); f.control.finish();
});
test("an answer a host callback owes when the generation dies mid-request is refused, never delivered", async () => {
  for (const kind of ["permission", "hook", "mcp"] as const) {
    let revoke = () => {};
    const callbacks = hostCallbacks(() => revoke());
    const frame = { permission: permissionFrame, hook: hookFrame, mcp: mcpFrame }[kind];
    const f = guest({ scenario: async function* (_config, frames) {
      yield frame("late-1");
      const response = await nextFrame(frames, isAnswer("late-1")) as ControlResponseFrame;
      expect(response).toEqual({ type: "control_response", requestId: "late-1", ok: false, error: { code: "required_context_unavailable", message: "required_context_unavailable" } });
      yield result;
    } });
    revoke = () => f.control.advance();
    const { seen, outcome } = await observe({ ...f.options, ...callbacks.options });
    expect(callbacks.runs[kind]).toBe(1); expect(outcome).toBe("required_context_unavailable"); expect(seen).toEqual([]); f.control.finish();
  }
});
test("a registered handler that was running when the generation died is refused whether it returns or throws", async () => {
  for (const how of ["returns", "throws"]) {
    const f = guest({ scenario: async function* (_config, frames) {
      yield { type: "control_request", requestId: "probe-1", subtype: "probe", payload: {} } as WinterFrame;
      expect(await nextFrame(frames, isAnswer("probe-1"))).toEqual({ type: "control_response", requestId: "probe-1", ok: false, error: { code: "required_context_unavailable", message: "required_context_unavailable" } });
      yield result;
    } });
    const gen = query({ prompt: "fixture", options: f.options });
    gen.__internal!.registerControlRequestHandler("probe", async () => { f.control.advance(); if (how === "throws") throw new Error("private handler failure"); return { ok: true, payload: "leaked" }; });
    const outcome = await (async () => { try { for await (const _ of gen) {} return "completed"; } catch (error) { return (error as Error).message; } })();
    expect(outcome).toBe("required_context_unavailable"); f.control.finish();
  }
});
test("a result delivered before the revocation does not make a revoked query a clean completion", async () => {
  const f = guest(), seen: string[] = [];
  await expect((async () => {
    for await (const message of query({ prompt: "fixture", options: f.options })) { seen.push(message.type); if (message.type === "result") f.control.advance(); }
  })()).rejects.toThrow("required_context_unavailable");
  expect(seen).toEqual(["result"]); f.control.finish();
});
test("an observed process exit is not a revocation: a finished guest's last frames still arrive", async () => {
  const f = guest({ scenario: async function* (config, frames, control) {
    yield context(config); await nextFrame(frames, isContextAnswer);
    control.finish(); await Promise.resolve(); await Promise.resolve(); // The exit is observed (the preparation closes) before the last frames are read.
    yield assistantFrame; yield result;
  } });
  expect(await observe(f.options)).toEqual({ seen: ["assistant", "result"], outcome: "completed" });
});

// ---- revoke(), forget() and the consumed-binding set --------------------------------------------------------------

test("revoke tears down the workspace now without moving a counter, refuses mints, and only a higher epoch reopens it", async () => {
  const key = workspaceOf(), running = guest({ workspace: key }), unspent = guest({ workspace: key });
  const gen = query({ prompt: "fixture", options: running.options }); void gen; running.active();
  issuer.revoke(key);
  expect(running.kills).toEqual([undefined]); expect(running.ends()).toBe(1); running.closed(); unspent.closed(); expectSpent(running.ticket); expectSpent(unspent.ticket);
  const again = { workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1 };
  refusal(() => issuer.mint({ ...again, preparation: bare().preparation }));
  issuer.revoke(key); // Idempotent.
  issuer.advance(key, "inc-1", 1); // The same pair again does not reopen a revoked workspace.
  refusal(() => issuer.mint({ ...again, preparation: bare().preparation }));
  refusal(() => issuer.advance(key, "inc-1", 0));
  issuer.advance(key, "inc-2", 2);
  expect(() => issuer.mint({ workspaceKey: key, incarnationId: "inc-2", leaseEpoch: 2, preparation: bare().preparation })).not.toThrow();
  issuer.revoke("never-announced"); // Nothing to revoke.
  for (const bad of ["", "bad id", 3, null, undefined]) refusal(() => issuer.revoke(bad as string));
  running.control.finish();
  // A revoked query ends in the consumer with the refusal, even though its last frames are well formed.
  const g = guest({ scenario: async function* (config, frames) { yield context(config); await nextFrame(frames, isContextAnswer); issuer.revoke(g.workspace); yield result; } });
  expect(await observe(g.options)).toEqual({ seen: [], outcome: "required_context_unavailable" }); g.control.finish();
});
test("forget revokes and frees the counter slot; the key can start a new history and no old ticket revives", () => {
  const key = workspaceOf(), a = guest({ workspace: key });
  const gen = query({ prompt: "fixture", options: a.options }); void gen; a.active();
  issuer.forget(key);
  expect(a.kills).toEqual([undefined]); a.closed(); expectSpent(a.ticket);
  refusal(() => issuer.mint({ workspaceKey: key, incarnationId: "inc-1", leaseEpoch: 1, preparation: bare().preparation })); // No generation any more.
  issuer.advance(key, "inc-7", 1); // A new history may start lower: the slot was freed.
  const b = bare(), ticket = issuer.mint({ workspaceKey: key, incarnationId: "inc-7", leaseEpoch: 1, preparation: b.preparation });
  expect(reachesHook(b, ticket)).toBe(true); expectSpent(a.ticket);
  issuer.forget("never-announced"); issuer.forget(key); issuer.forget(key);
  for (const bad of ["", "bad id", 3, null, undefined]) refusal(() => issuer.forget(bad as string));
  a.control.finish();
});
test("correlation ids consumed under a generation leave the process-wide set when it dies; every other id stays", () => {
  const argsFor = (bindingId: string) => ["--run", "--config-json", JSON.stringify({ requiredRuntimeContext: { version: 1, bindingId } })];
  const consume = (base: ReturnType<typeof bare>, bindingId: string) => consumeGuidedQueryCorrelation(claimGuidedQuery(base.preparation, base.pair), argsFor(bindingId));
  const unguardedId = randomUUID(); const unguarded = bare(); consume(unguarded, unguardedId); closeGuidedQuery(unguarded.preparation);
  for (const ending of ["advance", "revoke", "forget"] as const) {
    const key = workspaceOf(), bindingId = randomUUID(), guarded = bare();
    mintFor(guarded.preparation, key); consume(guarded, bindingId); closeGuidedQuery(guarded.preparation);
    refusal(() => consume(bare(), bindingId)); // Still a replay while its generation lives.
    if (ending === "advance") issuer.advance(key, "inc-2", 2); else if (ending === "revoke") issuer.revoke(key); else issuer.forget(key);
    expect(() => consume(bare(), bindingId)).not.toThrow(); // The generation died, so the id left the set.
  }
  refusal(() => consume(bare(), unguardedId)); // An id consumed with no ticket is never evicted.
});
test("a guard that throws, reports stale or fails to register is refused and closes the preparation for good", () => {
  const args = () => ["--run", "--config-json", JSON.stringify({ requiredRuntimeContext: { version: 1, bindingId: randomUUID() } })];
  const guarded = () => {
    const base = bare(), state = { throws: false, current: true, consumedFails: false, released: 0 };
    bindGuidedGuestGuard(base.preparation, {
      current: () => { if (state.throws) throw new Error("guard exploded"); return state.current; },
      consumed: () => { if (state.consumedFails) throw new Error("registry full"); },
      release: () => { state.released++; },
    });
    return { ...base, state };
  };
  // A throwing guard is stale, and a guard that later recovers cannot revive the closed record.
  const thrower = guarded(); thrower.state.throws = true; refusal(() => claimGuidedQuery(thrower.preparation, thrower.pair));
  thrower.state.throws = false; refusal(() => claimGuidedQuery(thrower.preparation, thrower.pair)); expect(thrower.state.released).toBe(1);
  // A guard that goes stale after the claim fails the next step, closes the record, and cannot be flipped back.
  const stale = guarded(), claim = claimGuidedQuery(stale.preparation, stale.pair);
  const input = args(), expected = JSON.parse(input[2]!).requiredRuntimeContext as GuidedQueryCorrelation;
  consumeGuidedQueryCorrelation(claim, input); assertGuidedQueryCorrelation(claim, expected);
  stale.state.current = false; refusal(() => assertGuidedQueryCorrelation(claim, expected));
  stale.state.current = true; refusal(() => assertGuidedQueryCorrelation(claim, expected)); expect(stale.state.released).toBe(1);
  // A guard that cannot register the consumed id fails the consume and closes the record.
  const full = guarded(), fullClaim = claimGuidedQuery(full.preparation, full.pair);
  full.state.consumedFails = true; refusal(() => consumeGuidedQueryCorrelation(fullClaim, args())); refusal(() => claimGuidedQuery(full.preparation, full.pair));
  // Binding a second guard, or one onto a claimed preparation, is refused.
  const twice = guarded(); refusal(() => bindGuidedGuestGuard(twice.preparation, { current: () => true, consumed: () => {}, release: () => {} }));
});
test("an own accessor named guidedGuestTicket is refused even for a local query, and never read", () => {
  let reads = 0;
  const f = guest(), options: Options = { ...f.options, executionPosture: "local" }; delete options.guidedGuestTicket;
  Object.defineProperty(options, "guidedGuestTicket", { get() { reads++; return f.ticket; }, enumerable: true });
  refusal(() => query({ prompt: "fixture", options })); expect(reads).toBe(0); expect(f.spawns()).toBe(0); f.closed();
});

test("ticket records and workspace counters are bounded at the correlation capacity", async () => {
  const home = mkdtempSync(join(tmpdir(), "winter-guest-ticket-capacity-"));
  const config = join(home, "empty-bunfig.toml"); writeFileSync(config, "", { mode: 0o600 });
  const proc = Bun.spawn([process.execPath, "run", "--no-env-file", `--config=${config}`,
    fileURLToPath(new URL("./fixtures/guided-guest-ticket-capacity.ts", import.meta.url))], {
    cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  const bounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader(); let total = 0, text = ""; const decoder = new TextDecoder();
    try { for (;;) { const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > 4096) { proc.kill("SIGKILL"); throw new Error("capacity fixture over bound"); }
      text += decoder.decode(item.value, { stream: true });
    } return text + decoder.decode(); } finally { reader.releaseLock(); }
  };
  try {
    const [stdout, stderr, code] = await Promise.all([bounded(proc.stdout), bounded(proc.stderr), proc.exited]);
    expect(stderr).toBe(""); expect(code).toBe(0); expect(stdout).toBe("guided-guest-ticket-capacity:4096\n");
  } finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; rmSync(home, { recursive: true }); }
});
