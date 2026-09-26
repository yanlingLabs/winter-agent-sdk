// WS-23 (midconv) item 1: OpenAI GPT-6's `configuration_update` ON THE WIRE. The real engine drives the
// real catalog-resolved Responses adapter against a loopback endpoint, and every assertion reads the
// request body the endpoint received:
//   - the effort marker is a `configuration_update` input item, never a system message;
//   - the top-level `reasoning.effort` stays at the frozen value while the level changes;
//   - updates sit BEFORE the user message they apply to (the docs), never two next to each other;
//   - every earlier request's `input` is a byte prefix of the next one's;
//   - the transcript stamps the UPDATE's level, not the response's request-level report;
//   - a 400 naming the item falls back once, sticky and logged once;
//   - a compaction restarts the chain: one head update, nothing stale.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import type { WinterCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { stubExecutor } from "./mock.ts";
import { buildSessionProvider } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { fakeCompactionController } from "../compaction/seam.ts";
import { fakeResponsesCatalog, startResponsesFake, type ResponsesFakeAnswer, type ResponsesFakeRequest } from "./responses-fake.test-support.ts";

const ASTRA = "openai/gpt-6-astra";

type Step = { user: string } | { control: string; payload: unknown };

async function drive(opts: { catalog: WinterCatalog; url: string; steps: Step[]; engine?: Partial<EngineOptions>; effort?: "high" | "low" }): Promise<{ frames: WinterFrame[]; recorded: Array<{ content: unknown; opts: unknown }> }> {
  const config = {
    sessionId: `midconv-effort-${Math.random().toString(36).slice(2)}`,
    cwd: "/winter-fixture",
    model: ASTRA,
    effort: opts.effort ?? "high",
    persistSession: false,
    provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: opts.url, local: true } },
  } as RuntimeConfig;
  const wiring = buildSessionProvider({ config, env: {}, catalog: opts.catalog, credentials: createMemoryCredentialStore() });
  const recorded: Array<{ content: unknown; opts: unknown }> = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    tools: stubExecutor,
    providerIdentity: { providerId: wiring.identity!.providerId, modelKey: wiring.identity!.modelKey, family: "openai" },
    describeModel: (model: string, providerId?: string) => describeCatalogModel(opts.catalog, model, providerId),
    store: {
      recordUserEntry() {},
      recordAssistantEntry(content: unknown, o: unknown) {
        recorded.push({ content, opts: o });
      },
    },
    ...(opts.engine ?? {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("user" in step) {
      host.output.write({ type: "user", text: step.user });
      users++;
      for (let n = 0; n < 3000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
    } else {
      const requestId = `c${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: step.control, payload: step.payload });
      for (let n = 0; n < 2000 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
    }
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { frames, recorded };
}

const input = (r: ResponsesFakeRequest): Array<Record<string, unknown>> => r.body["input"] as Array<Record<string, unknown>>;
/** A compact reading of an `input` array: `cfg:<effort>`, `user:<text>`, `assistant:<text>`, or the item type. */
const shape = (r: ResponsesFakeRequest): string[] =>
  input(r).map((item) => {
    if (item["type"] === "configuration_update") return `cfg:${(item["reasoning"] as { effort: string }).effort}`;
    if (item["type"] === "message") {
      const text = (item["content"] as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
      return `${item["role"] as string}:${text.includes("<system-reminder>") ? "<ctx>" : text}`;
    }
    return String(item["type"]);
  });
/** No two `configuration_update` items side by side ("the API rejects adjacent updates"). */
const noAdjacentUpdates = (r: ResponsesFakeRequest): boolean => input(r).every((item, i, all) => !(item["type"] === "configuration_update" && all[i + 1]?.["type"] === "configuration_update"));
/** `input` of `a` is a byte prefix of `b`'s, and everything outside `input` is byte-identical. */
function expectPrefix(a: ResponsesFakeRequest, b: ResponsesFakeRequest): void {
  const ia = JSON.stringify(input(a));
  const ib = JSON.stringify(input(b));
  expect(ib.startsWith(ia.slice(0, -1))).toBe(true);
  const rest = (r: ResponsesFakeRequest): string => JSON.stringify({ ...r.body, input: undefined });
  expect(rest(b)).toBe(rest(a));
}

const reply = (text: string): ResponsesFakeAnswer => ({ items: [{ type: "text", text }] });

describe("OpenAI `configuration_update` through the engine and the Responses adapter (WS-23 midconv item 1)", () => {
  test("the catalog: openai/gpt-6-{astra,sol,luna} record the item; codex-oauth and azure do not (the probe decides)", () => {
    const catalog = fakeResponsesCatalog("openai", "http://127.0.0.1:1", ["openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-luna", "codex-oauth/gpt-6-astra", "openai/gpt-5.6"]);
    const pme = (key: string): unknown => catalog.models.find((m) => m.key === key)?.reasoning?.perMessageEffort?.value;
    expect(pme("openai/gpt-6-astra")).toEqual({ item: "configuration_update" });
    expect(pme("openai/gpt-6-sol")).toEqual({ item: "configuration_update" });
    expect(pme("openai/gpt-6-luna")).toEqual({ item: "configuration_update" });
    expect(pme("codex-oauth/gpt-6-astra")).toBeUndefined();
    expect(pme("openai/gpt-5.6")).toBeUndefined();
  });

  test("an effort switch rides `configuration_update` before the user message, the top-level effort stays frozen, and every request is a byte prefix of the next", async () => {
    const fake = await startResponsesFake((_r, i) => reply(`r${i + 1}`));
    try {
      const catalog = fakeResponsesCatalog("openai", fake.url, [ASTRA]);
      const { recorded } = await drive({
        catalog,
        url: fake.url,
        steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { control: "set_effort", payload: { effort: "max" } }, { user: "three" }],
      });
      const reqs = fake.requests.filter((r) => r.path.endsWith("/responses"));
      expect(reqs).toHaveLength(3);
      expect(reqs.map((r) => (r.body["reasoning"] as { effort?: string } | undefined)?.effort)).toEqual(["high", "high", "high"]);
      // The leading (baseline) update opens every request; turn one runs at it.
      expect(shape(reqs[0]!)[0]).toBe("cfg:high");
      expect(shape(reqs[0]!).at(-1)).toBe("user:one");
      expect(shape(reqs[0]!).filter((x) => x.startsWith("cfg:"))).toEqual(["cfg:high"]);
      expect(shape(reqs[1]!).slice(-3)).toEqual(["assistant:r1", "cfg:low", "user:two"]);
      expect(shape(reqs[2]!).slice(-6)).toEqual(["assistant:r1", "cfg:low", "user:two", "assistant:r2", "cfg:max", "user:three"]);
      // Never a system/developer message for effort.
      expect(reqs.every((r) => input(r).every((item) => item["role"] !== "system"))).toBe(true);
      expect(reqs.every(noAdjacentUpdates)).toBe(true);
      expectPrefix(reqs[0]!, reqs[1]!);
      expectPrefix(reqs[1]!, reqs[2]!);
      // The transcript stamps the level the UPDATE set -- the response reports only the request-level value.
      expect(recorded.map((r) => (r.opts as { perTurnEffort?: string }).perTurnEffort)).toEqual(["high", "low", "max"]);
      expect(recorded.map((r) => (r.opts as { effort?: string }).effort)).toEqual(["high", "high", "high"]);
    } finally {
      await fake.close();
    }
  });

  test("a 400 naming the item falls back ONCE, sticky: the round re-runs with no update, later switches move the top-level value, logged once", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    const fake = await startResponsesFake((r, i) =>
      input(r).some((item) => item["type"] === "configuration_update") ? { status: 400, error: { message: "Invalid value: 'configuration_update'. Supported values are: 'message', 'function_call_output'.", param: "input[0].type", code: "invalid_value" } } : reply(`r${i}`),
    );
    try {
      const catalog = fakeResponsesCatalog("openai", fake.url, [ASTRA]);
      const { frames } = await drive({ catalog, url: fake.url, steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }] });
      const reqs = fake.requests.filter((r) => r.path.endsWith("/responses"));
      expect(reqs.map((r) => [(r.body["reasoning"] as { effort?: string }).effort, input(r).filter((item) => item["type"] === "configuration_update").length])).toEqual([
        ["high", 1],
        ["high", 0],
        ["low", 0],
      ]);
      const results = frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: { is_error: boolean } }).message.is_error);
      expect(results).toEqual([false, false]);
      expect(errors.filter((e) => e.includes("refused per-message effort"))).toHaveLength(1);
    } finally {
      console.error = original;
      await fake.close();
    }
  });

  test("compaction restarts the chain: one head update at the frozen level, no stale update, none adjacent", async () => {
    const fake = await startResponsesFake((_r, i) => reply(`r${i}`));
    try {
      const catalog = fakeResponsesCatalog("openai", fake.url, [ASTRA]);
      await drive({
        catalog,
        url: fake.url,
        steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { user: "/compact" }, { user: "three" }],
        engine: { compactionController: fakeCompactionController({ keep: 0, summary: "SUMMARY" }) },
      });
      const reqs = fake.requests.filter((r) => r.path.endsWith("/responses"));
      const last = reqs.at(-1)!;
      expect((last.body["reasoning"] as { effort?: string }).effort).toBe("high");
      const s = shape(last);
      expect(s[0]).toBe("cfg:high");
      expect(s.filter((x) => x.startsWith("cfg:"))).toEqual(["cfg:high", "cfg:low"]);
      expect(s.slice(-2)).toEqual(["cfg:low", "user:three"]);
      expect(s.some((x) => x.includes("one") || x.includes("two"))).toBe(false);
      expect(noAdjacentUpdates(last)).toBe(true);
    } finally {
      await fake.close();
    }
  });
});
