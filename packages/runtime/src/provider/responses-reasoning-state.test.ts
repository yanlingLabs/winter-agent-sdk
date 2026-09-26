// WS-23 (reasoning-state): the Responses-side sidecar defects, END TO END -- a real engine, the real
// session-provider wiring and the real Responses adapter against a loopback, persisting through the real
// on-disk store (transcript + provider-state sidecar):
//   (a) a turn whose reasoning items sat BETWEEN its message and its call is replayed in that order after
//       a resume (the layout rides the sidecar apart from the vendor items);
//   (b) a "could not decrypt the provided encrypted_content" 400 is retried ONCE without the replayed
//       reasoning, and the turn completes;
//   (d) the summary record joins its parts with a blank line;
//   and an OpenAI-family `context_length_exceeded` reaches the engine's overflow path (decision 5).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createMemoryCredentialStore } from "@yanlinglabs/winter-provider-runtime";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { runEngine, type EngineOptions } from "../engine.ts";
import { resolveEngineSession } from "../store/dialect.ts";
import { buildSessionProvider, loadResumedChain } from "./session-provider.ts";
import { describeCatalogModel } from "../production-wiring.ts";
import { fakeResponsesCatalog, startResponsesFake, type ResponsesFake, type ResponsesFakeAnswer, type ResponsesFakeRequest } from "./responses-fake.test-support.ts";
import "../tools/impl/index.ts";

const MODEL = "openai/gpt-5.6-sol";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Fx {
  fake: ResponsesFake;
  home: string;
  cwd: string;
}

async function fixture(script: (request: ResponsesFakeRequest, index: number) => ResponsesFakeAnswer): Promise<Fx> {
  const fake = await startResponsesFake(script);
  const home = mkdtempSync(join(tmpdir(), "winter-ws23-rs-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "winter-ws23-rs-cwd-"));
  cleanups.push(async () => {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  return { fake, home, cwd };
}

async function runSession(fx: Fx, sessionId: string, turns: string[], resume?: string): Promise<WinterFrame[]> {
  const catalog = fakeResponsesCatalog("openai", fx.fake.url, [MODEL]);
  const base = {
    sessionId,
    cwd: fx.cwd,
    model: MODEL,
    winterHome: fx.home,
    provider: { providerId: "openai", authRef: { kind: "inline", value: "fixture" }, connection: { baseUrl: fx.fake.url, local: true } },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(resume !== undefined ? { resume } : {}),
  } as unknown as RuntimeConfig;
  const resolved = await resolveEngineSession({ config: base, resolveWinterHome: () => fx.home, env: {} });
  const chain = await loadResumedChain(resolved.store, resolved.initialMessages);
  const wiring = buildSessionProvider({ config: resolved.config, env: {}, catalog, credentials: createMemoryCredentialStore(), chain: () => chain });
  const identity = wiring.identity!;
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: resolved.config,
    input: runtime.input,
    output: runtime.output,
    provider: wiring.provider,
    providerIdentity: { providerId: identity.providerId, modelKey: identity.modelKey, family: "openai", ...(identity.continuationDomain !== undefined ? { continuationDomain: identity.continuationDomain } : {}) },
    describeModel: (model: string, providerId?: string) => describeCatalogModel(catalog, model, providerId),
    ...(resolved.store !== undefined ? { store: resolved.store } : {}),
    ...(resolved.initialMessages.length > 0 ? { initialMessages: resolved.initialMessages } : {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  for (let i = 0; i < turns.length; i++) {
    host.output.write({ type: "user", text: turns[i]! });
    for (let n = 0; n < 3000 && results() < i + 1; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return frames;
}

const lastResult = (frames: WinterFrame[]): Record<string, unknown> | undefined =>
  frames.map((f) => (f as { message?: Record<string, unknown> }).message).filter((m) => m?.["type"] === "result").at(-1);

function sidecarRecords(fx: Fx, sessionId: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  const projects = join(fx.home, "projects");
  for (const project of readdirSync(projects)) {
    try {
      return readFileSync(join(projects, project, `${sessionId}.provider-state.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    } catch {
      /* not this project */
    }
  }
  return [];
}

/** Turn one reasons, SAYS something, reasons again and calls Glob; the tool round answers plainly. */
// `tag` keeps each test's encrypted items distinct: the adapter remembers an item an endpoint refused to
// decrypt (review r1, M-2) for the life of the process, by its content.
function interleavedTurn(request: ResponsesFakeRequest, tag = ""): ResponsesFakeAnswer {
  const raw = request.raw;
  if (raw.includes("turn two")) return { items: [{ type: "text", text: "done two" }] };
  if (raw.includes("function_call_output")) return { items: [{ type: "text", text: "done one" }] };
  return {
    items: [
      { type: "reasoning", encrypted: `ENC-0${tag}`, summary: ["First part.", "Second part."] },
      { type: "text", text: "Let me look." },
      { type: "reasoning", encrypted: `ENC-2${tag}` },
      { type: "function_call", callId: "call_glob", name: "Glob", arguments: { pattern: "*.winter-none" } },
    ],
  };
}

describe("Responses reasoning state through the sidecar (WS-23 defects a, d)", () => {
  test("a resumed turn replays its reasoning items BETWEEN its message and its call, where the response put them", async () => {
    const fx = await fixture((request) => interleavedTurn(request, "-a"));
    await runSession(fx, "rs-a", ["turn one"]);
    await runSession(fx, "rs-a-resumed", ["turn two"], "rs-a");
    expect(fx.fake.requests).toHaveLength(3);
    const input = fx.fake.requests[2]!.body["input"] as Array<Record<string, unknown>>;
    const shape = input.map((item) => (item["type"] === "reasoning" ? `r:${String(item["encrypted_content"])}` : item["type"] === "message" ? `m:${String(item["role"])}` : String(item["type"])));
    expect(shape).toEqual(["m:user", "r:ENC-0-a", "m:assistant", "r:ENC-2-a", "function_call", "function_call_output", "m:assistant", "m:user"]);
    expect(fx.fake.requests[2]!.raw).not.toContain("winter.");

    const records = sidecarRecords(fx, "rs-a");
    const native = records.find((r) => r.kind === "native-state")!;
    // The vendor items stay replayable by an older runtime; the layout rides apart from them.
    expect((native.payload["items"] as Array<{ type: string }>).map((i) => i.type)).toEqual(["reasoning", "reasoning"]);
    expect(native.payload["winter"]).toEqual([{ type: "winter.responses_layout", order: [{ r: 0 }, { m: true }, { r: 1 }, { c: "call_glob" }] }]);
    // (d) the summary record's parts are separated.
    expect(records.find((r) => r.kind === "summary")!.payload["text"]).toBe("First part.\n\nSecond part.");
  });
});

describe("a refused replay is retried once without the replayed reasoning (WS-23 defect b)", () => {
  test("the endpoint refuses the encrypted content; the SAME request goes again without it and the turn completes", async () => {
    const fx = await fixture((request) => {
      if (request.raw.includes("turn two") && request.raw.includes('"type":"reasoning"')) return { status: 400, error: { message: "Could not decrypt the provided encrypted_content" } };
      return interleavedTurn(request, "-b1");
    });
    const frames = await runSession(fx, "rs-b", ["turn one", "turn two"]);
    // turn one: 2 requests; turn two: the refused one, then the retry.
    expect(fx.fake.requests).toHaveLength(4);
    const [refused, retried] = [fx.fake.requests[2]!, fx.fake.requests[3]!];
    expect(refused.raw).toContain("ENC-0-b1");
    expect(retried.raw).not.toContain('"type":"reasoning"');
    // Nothing else changed between the two.
    const input = (r: typeof refused): unknown[] => (r.body["input"] as Array<{ type?: string }>).filter((i) => i.type !== "reasoning");
    expect(input(retried)).toEqual(input(refused));
    expect(lastResult(frames)).toMatchObject({ is_error: false, result: "done two" });
  });

  test("never twice: a retry that is refused again ends the turn with the error", async () => {
    const fx = await fixture((request) => (request.raw.includes("turn two") ? { status: 400, error: { message: "Could not decrypt the provided encrypted_content" } } : interleavedTurn(request, "-b2")));
    const frames = await runSession(fx, "rs-b2", ["turn one", "turn two"]);
    expect(fx.fake.requests).toHaveLength(4);
    expect(lastResult(frames)).toMatchObject({ is_error: true });
  });
});

describe("an OpenAI context_length_exceeded reaches the engine's overflow path (WS-23 decision 5)", () => {
  test("typed as the overflow outcome, not a generic API error", async () => {
    const fx = await fixture(() => ({ status: 400, error: { message: "Your input exceeds the context window of this model.", code: "context_length_exceeded", param: "input" } }));
    const frames = await runSession(fx, "rs-overflow", ["hello"]);
    expect(lastResult(frames)).toMatchObject({ is_error: true, terminal_reason: "prompt_too_long" });
  });
});

describe("review r1: in-stream overflow (I-6) and a remembered undecryptable item (M-2)", () => {
  test("a `response.failed` whose code is context_length_exceeded reaches the overflow path", async () => {
    const fx = await fixture(() => ({ streamFailure: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } }));
    const frames = await runSession(fx, "rs-stream-overflow", ["hello"]);
    expect(lastResult(frames)).toMatchObject({ is_error: true, terminal_reason: "prompt_too_long" });
  });

  test("items refused once are not replayed again: turn three sends them no more, and costs no second 400", async () => {
    const refusedItems = new Set<string>();
    const fx = await fixture((request) => {
      const raw = request.raw;
      if (raw.includes('"encrypted_content":"ENC-0-m2"')) {
        refusedItems.add("ENC-0-m2");
        return { status: 400, error: { message: "Could not decrypt the provided encrypted_content" } };
      }
      if (raw.includes("turn three")) return { items: [{ type: "text", text: "done three" }] };
      return interleavedTurn(request, "-m2");
    });
    const frames = await runSession(fx, "rs-m2", ["turn one", "turn two", "turn three"]);
    const refusals = fx.fake.requests.filter((r) => r.raw.includes('"encrypted_content":"ENC-0-m2"'));
    expect(refusals).toHaveLength(1);
    expect(lastResult(frames)).toMatchObject({ is_error: false, result: "done three" });
  });
});
