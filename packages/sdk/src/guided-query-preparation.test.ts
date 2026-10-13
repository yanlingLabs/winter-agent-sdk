import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareGuidedQuery, claimGuidedQuery, consumeGuidedQueryCorrelation as consumeCorrelation, closeGuidedQuery,
  GUIDED_QUERY_CONFIG_MAX_BYTES, GUIDED_QUERY_CORRELATION_CAPACITY, type GuidedQueryCallbacks, type GuidedQueryClaim, type GuidedQueryPreparation } from "./guided-query-preparation.ts";
import { query } from "./query.ts";

const nonce = "b3d0615d-e1b2-4e69-a92c-ec41e456fd81";
const args = (config: unknown = { requiredRuntimeContext: { version: 1, bindingId: randomUUID() } }) => ["--run", "--config-json", JSON.stringify(config)];
let successes = 0;
function consumeGuidedQueryCorrelation(claim: GuidedQueryClaim, input: readonly string[]) {
  const result = consumeCorrelation(claim, input); successes++; return result;
}
function fixture() {
  let calls = 0;
  const pair: GuidedQueryCallbacks = {
    onRuntimeContext: async () => { calls++; throw new Error("callback tripwire"); },
    spawnClaudeCodeProcess: () => { calls++; throw new Error("spawn tripwire"); },
  };
  const preparation = prepareGuidedQuery(pair);
  return { pair, preparation, claim: () => claimGuidedQuery(preparation, pair), calls: () => calls };
}
const refusal = (body: () => unknown) => expect(body).toThrow("required_context_unavailable");

test("one claim and correlation only; functions are stored without invocation", () => {
  const f = fixture(), claim = f.claim();
  const result = consumeGuidedQueryCorrelation(claim, args({
    requiredRuntimeContext: { version: 1, bindingId: nonce },
    cwd: "/untrusted", profile: "host-query-guided-v1", grants: ["all"], env: { SECRET: "discarded" },
  }));
  expect(result).toEqual({ version: 1, bindingId: nonce });
  expect(Object.keys(result)).toEqual(["version", "bindingId"]);
  expect(Object.isFrozen(result)).toBe(true);
  refusal(() => f.claim()); refusal(() => consumeGuidedQueryCorrelation(claim, args()));
  closeGuidedQuery(f.preparation); closeGuidedQuery(f.preparation);
  refusal(() => f.claim()); expect(f.calls()).toBe(0);
});
test("preparation and claim cannot serialize, clone by shape or wrap in a proxy", () => {
  const f = fixture(), claim = f.claim();
  refusal(() => JSON.stringify(f.preparation)); refusal(() => JSON.stringify(claim));
  refusal(() => claimGuidedQuery({} as GuidedQueryPreparation, f.pair));
  refusal(() => claimGuidedQuery({ ...f.preparation }, f.pair));
  refusal(() => claimGuidedQuery(Object.assign({}, f.preparation), f.pair));
  refusal(() => claimGuidedQuery(structuredClone(f.preparation), f.pair));
  refusal(() => claimGuidedQuery(new Proxy(f.preparation, {}), f.pair));
  refusal(() => consumeGuidedQueryCorrelation({} as GuidedQueryClaim, args()));
  refusal(() => consumeGuidedQueryCorrelation(new Proxy(claim, {}), args()));
  expect(Object.isFrozen(f.preparation)).toBe(true); expect(Object.isFrozen(claim)).toBe(true);
});
test("exact callback/hook identity and descriptor-only closed pair", () => {
  const f = fixture(), other = fixture(); let reads = 0;
  refusal(() => claimGuidedQuery(f.preparation, { ...f.pair, onRuntimeContext: other.pair.onRuntimeContext }));
  refusal(() => claimGuidedQuery(f.preparation, { ...f.pair, spawnClaudeCodeProcess: other.pair.spawnClaudeCodeProcess }));
  refusal(() => prepareGuidedQuery({ ...f.pair, authority: "all" } as GuidedQueryCallbacks));
  refusal(() => prepareGuidedQuery(Object.defineProperty({ spawnClaudeCodeProcess: f.pair.spawnClaudeCodeProcess }, "onRuntimeContext", {
    get() { reads++; return f.pair.onRuntimeContext; },
  }) as GuidedQueryCallbacks));
  const proxy = new Proxy(f.pair, { ownKeys() { throw new Error("private supplied text"); } });
  refusal(() => prepareGuidedQuery(proxy)); refusal(() => claimGuidedQuery(f.preparation, proxy));
  expect(reads).toBe(0); expect(f.calls()).toBe(0); expect(other.calls()).toBe(0);
  expect(consumeGuidedQueryCorrelation(f.claim(), args()).bindingId).toMatch(/^[0-9a-f-]{36}$/);
});
test("close before and after claiming revokes correlation permanently", () => {
  const before = fixture(); closeGuidedQuery(before.preparation); refusal(() => before.claim());
  const after = fixture(), claim = after.claim(); closeGuidedQuery(after.preparation);
  refusal(() => consumeGuidedQueryCorrelation(claim, args()));
  refusal(() => closeGuidedQuery({} as GuidedQueryPreparation));
});
test("malformed consume closes rather than permitting a corrected retry", () => {
  for (const bad of [[], ["--run", "--config-json"], ["--run", "--config-json", "{}", "extra"],
    ["--run", "--config-json", "{}"], ["wrong", "--config-json", args()[2]!],
    ["--run", "wrong", args()[2]!], ["--run", "--config-json", "{"],
    args(null), args([]), args({ requiredRuntimeContext: null }), args({ requiredRuntimeContext: [] }),
    args({ requiredRuntimeContext: { version: 2, bindingId: nonce } }),
    args({ requiredRuntimeContext: { version: true, bindingId: nonce } }),
    args({ requiredRuntimeContext: { version: 1, bindingId: nonce, grants: [] } }),
    args({ requiredRuntimeContext: { version: 1, bindingId: "other" } }),
    args({ requiredRuntimeContext: { version: 1, bindingId: nonce.toUpperCase() } }),
    args({ requiredRuntimeContext: { version: 1, bindingId: nonce.replace("-4e69", "-1e69") } })]) {
    const f = fixture(), claim = f.claim(); refusal(() => consumeGuidedQueryCorrelation(claim, bad));
    refusal(() => consumeGuidedQueryCorrelation(claim, args())); refusal(() => f.claim());
  }
});
test("reject duplicate fields, alternate encodings and whitespace", () => {
  for (const raw of [
    `{"requiredRuntimeContext":{"version":1,"version":1,"bindingId":"${nonce}"}}`,
    `{"requiredRuntimeContext":{"version":1,"bindingId":"${nonce}","bindingId":"${nonce}"}}`,
    `{"requiredRuntimeContext":{"version":1,"bindingId":"${nonce}"},"requiredRuntimeContext":{"version":1,"bindingId":"${nonce}"}}`,
    `{"requiredRuntimeContext":{"version":1e0,"bindingId":"${nonce}"}}`,
    args()[2]! + " ", args()[2]!.replace("requiredRuntimeContext", "requiredRuntimeCont\\u0065xt"),
  ]) refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), ["--run", "--config-json", raw]));
});
test("bounds precede JSON parsing and array enumeration; no accessor reads", () => {
  refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), ["--run", "--config-json", "x".repeat(GUIDED_QUERY_CONFIG_MAX_BYTES + 1)]));
  refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), ["--run", "--config-json", JSON.stringify({ requiredRuntimeContext: { version: 1, bindingId: nonce }, other: "é".repeat(40_000) })]));
  let reads = 0; const getter = args(); Object.defineProperty(getter, "2", { get() { reads++; return args()[2]; } });
  refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), getter));
  const sparse = new Array<string>(3); refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), sparse));
  const huge = new Array<string>(1_000_000); refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), huge));
  const extra = Object.assign(args(), { authority: true }); refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), extra));
  expect(reads).toBe(0);
});
test("actual ordinary SDK spawn config supplies supported correlation without activating confinement", () => {
  let claim!: GuidedQueryClaim, observed = false;
  const pair: GuidedQueryCallbacks = {
    onRuntimeContext: async () => { throw new Error("callback tripwire"); },
    spawnClaudeCodeProcess(options) {
      const result = consumeGuidedQueryCorrelation(claim, options.args);
      expect(result.version).toBe(1); expect(result.bindingId).toMatch(/^[0-9a-f-]{36}$/); observed = true;
      throw new Error("injected before any process");
    },
  };
  const preparation = prepareGuidedQuery(pair); claim = claimGuidedQuery(preparation, pair);
  expect(() => query({ prompt: "inert", options: { requireRuntimeContext: true, ...pair } })).toThrow("injected before any process");
  expect(observed).toBe(true); closeGuidedQuery(preparation);
});
test("prepared-but-unattested confined query still refuses before callback or spawn", () => {
  const f = fixture(); f.claim();
  const options = { executionPosture: "confined-guest" as const, requireRuntimeContext: true,
    ...f.pair, guidedQueryPreparation: f.preparation };
  refusal(() => query({ prompt: "inert", options })); expect(f.calls()).toBe(0);
});
test("fresh query UUIDs are accepted without treating equal text as registration", () => {
  for (let i = 0; i < 5; i++) expect(consumeGuidedQueryCorrelation(fixture().claim(), args({ requiredRuntimeContext: { version: 1, bindingId: randomUUID() } })).version).toBe(1);
  const f = fixture(); refusal(() => consumeGuidedQueryCorrelation({ bindingId: nonce } as unknown as GuidedQueryClaim, args())); expect(f.calls()).toBe(0);
});
test("canonical key order and __proto__ data cannot supply inherited correlation or authority", () => {
  const bindingId = randomUUID();
  const raw = `{"__proto__":{"authority":"all"},"other":true,"requiredRuntimeContext":{"bindingId":"${bindingId}","version":1}}`;
  expect(consumeGuidedQueryCorrelation(fixture().claim(), ["--run", "--config-json", raw])).toEqual({ version: 1, bindingId });
  expect(Object.hasOwn(Object.prototype, "authority")).toBe(false);
  refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), ["--run", "--config-json", `{"__proto__":{"requiredRuntimeContext":{"version":1,"bindingId":"${randomUUID()}"}}}`]));
  refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), args({ requiredRuntimeContext: { version: 1, bindingId: "\ud800" } })));
  refusal(() => consumeGuidedQueryCorrelation(fixture().claim(), ["--run", "--config-json", `{"requiredRuntimeContext":{"version":1,"bindingId":"${randomUUID()}"},"ignored":"\ud800"}`]));
});
test("binding UUID replay across preparations remains refused after close", () => {
  const bindingId = randomUUID(), input = args({ requiredRuntimeContext: { version: 1, bindingId } });
  const first = fixture(); consumeGuidedQueryCorrelation(first.claim(), input); closeGuidedQuery(first.preparation);
  const next = fixture(), claim = next.claim(); refusal(() => consumeGuidedQueryCorrelation(claim, input));
  refusal(() => consumeGuidedQueryCorrelation(claim, args())); refusal(() => next.claim());
});
test("4096 consumed correlations are retained; capacity stays isolated from other query tests", async () => {
  // Separate module realm, no reset/eviction API added to production state.
  const home = mkdtempSync(join(tmpdir(), "winter-preparation-capacity-"));
  const config = join(home, "empty-bunfig.toml"); writeFileSync(config, "", { mode: 0o600 });
  const proc = Bun.spawn([process.execPath, "run", "--no-env-file", `--config=${config}`,
    fileURLToPath(new URL("./fixtures/guided-query-capacity.ts", import.meta.url))], {
    cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C", LC_ALL: "C", TZ: "UTC" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  const bounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader(); let total = 0, text = ""; const decoder = new TextDecoder();
    try { for (;;) { const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > 4096) { proc.kill("SIGKILL"); throw new Error("capacity fixture over bound"); }
      text += decoder.decode(item.value, { stream: true });
    } return text + decoder.decode(); } finally { reader.releaseLock(); }
  };
  try {
    const [stdout, stderr, code] = await Promise.all([bounded(proc.stdout), bounded(proc.stderr), proc.exited]);
    expect(code).toBe(0); expect(stderr).toBe(""); expect(stdout).toBe("guided-query-capacity:4096\n");
  } finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; rmSync(home, { recursive: true }); }
});
