// WS-23 (reasoning-state, decision 5): the model switch FIT CHECK. A switch replays the conversation as
// it is, so the target must be able to hold it: the target's first request is estimated against its
// window x threshold - max output, and when it does not fit, the SOURCE model compacts the history before
// that request goes out (the user's rule: the source pays). The context accountant's limit follows the
// switch. A resume onto a model whose source is out of reach compacts on the target, its summarizer
// bounded to what the target can read.
import { describe, expect, test } from "bun:test";
import type { WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { createContextAccountant, runEngine, type ContextAccountant, type EngineOptions, type EngineProviderIdentity, type ModelDescription, type Provider, type ProviderMessage, type ProviderRequest, type ResolveModelSwitch } from "../engine.ts";
import { createCompactionController } from "../compaction/controller.ts";
import { isCompactionSummaryRequest } from "../compaction/summarizer.ts";
import { stubExecutor } from "./mock.ts";

const SRC: EngineProviderIdentity = { providerId: "big", modelKey: "big/src", family: "custom" };
const DST: EngineProviderIdentity = { providerId: "small", modelKey: "small/dst", family: "custom" };
const WINDOWS: Record<string, ModelDescription> = {
  "big/src": { contextWindow: 200_000, maxOutputTokens: 8_000 },
  // Room for the engine's own tool specs (~13k tokens) and a short history, not for four long turns.
  "small/dst": { contextWindow: 40_000, maxOutputTokens: 1_000 },
};
const LONG = "x".repeat(20_000);

/** A scripted provider: answers a summary request with SUMMARY, anything else with `reply`. Records every request. */
function scripted(name: string, reply: string): Provider & { requests: ProviderRequest[]; summaries: number } {
  const provider = {
    requests: [] as ProviderRequest[],
    summaries: 0,
    async generate(req: ProviderRequest) {
      provider.requests.push({ ...req, messages: structuredClone(req.messages) });
      const asked = isCompactionSummaryRequest(req);
      if (asked) {
        provider.summaries++;
        return { kind: "text" as const, text: `SUMMARY by ${name}` };
      }
      return { kind: "text" as const, text: reply };
    },
  };
  return provider;
}

type Step = { user: string } | { setModel: string };

async function drive(opts: { source: Provider; target: Provider; steps: Step[]; accountant?: ContextAccountant; initialMessages?: ProviderMessage[]; persisted?: { providerId: string; modelKey: string }; startOn?: EngineProviderIdentity; sourceReachable?: boolean }): Promise<WinterFrame[]> {
  const start = opts.startOn ?? SRC;
  const endpoint = (id: EngineProviderIdentity) => ({ providerId: id.providerId, modelKey: id.modelKey, family: id.family, continuation: "none" as const, readableState: "none" as const });
  const resolveModelSwitch: ResolveModelSwitch = (model) => {
    if (model === DST.modelKey) return { provider: opts.target, identity: DST, to: endpoint(DST), from: endpoint(SRC) };
    if (model === SRC.modelKey && opts.sourceReachable !== false) return { provider: opts.source, identity: SRC, to: endpoint(SRC), from: endpoint(DST) };
    return { refused: true, code: "provider-mismatch", message: "not reachable from this process" };
  };
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: "s-fit", cwd: "/winter-fixture", model: start.modelKey, compactionThreshold: 0.9 },
    input: runtime.input,
    output: runtime.output,
    provider: start === SRC ? opts.source : opts.target,
    tools: stubExecutor,
    providerIdentity: start,
    resolveModelSwitch,
    describeModel: (model: string) => WINDOWS[model],
    compactionController: createCompactionController({ retainedPairs: 1, compactionThreshold: 0.9 }),
    ...(opts.accountant !== undefined ? { contextAccountant: opts.accountant } : {}),
    ...(opts.initialMessages !== undefined ? { initialMessages: opts.initialMessages } : {}),
    ...(opts.persisted !== undefined
      ? {
          store: {
            recordUserEntry() {},
            recordAssistantEntry() {},
            recordProviderState() {},
            async loadProviderState() {
              return [];
            },
            async loadProviderIdentity() {
              return opts.persisted;
            },
          },
        }
      : {}),
  } as EngineOptions);
  const frames: WinterFrame[] = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
  let users = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("setModel" in step) {
      const requestId = `m${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: "set_model", payload: { model: step.setModel } });
      for (let n = 0; n < 2000 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
    } else {
      host.output.write({ type: "user", text: step.user });
      users++;
      for (let n = 0; n < 3000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
    }
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return frames;
}

const longTurns = (n: number): Step[] => Array.from({ length: n }, (_, i) => ({ user: `turn ${i} ${LONG}` }));

describe("the switch fit check (WS-23 decision 5)", () => {
  test("a history too big for the target is compacted by the SOURCE before the target's first request", async () => {
    const source = scripted("source", "source reply");
    const target = scripted("target", "target reply");
    const accountant = createContextAccountant({ limit: 200_000 });
    await drive({ source, target, accountant, steps: [...longTurns(4), { setModel: DST.modelKey }, { user: "after the switch" }] });
    // The source ran the summary; the target never had to.
    expect(source.summaries).toBe(1);
    expect(target.summaries).toBe(0);
    // The target's first (and only) request carries the compacted history, opening with the source's summary.
    expect(target.requests).toHaveLength(1);
    const first = target.requests[0]!.messages;
    expect(JSON.stringify(first[0]!.content)).toContain("SUMMARY by source");
    expect(JSON.stringify(first)).not.toContain("turn 0 ");
    // The accountant's window is the target's now.
    expect(accountant.limit()).toBe(40_000);
  });

  test("a history that fits is replayed as it stands -- no compaction on either model", async () => {
    const source = scripted("source", "source reply");
    const target = scripted("target", "target reply");
    await drive({ source, target, steps: [{ user: "short one" }, { setModel: DST.modelKey }, { user: "short two" }] });
    expect(source.summaries + target.summaries).toBe(0);
    expect(target.requests[0]!.messages.map((m) => m.content)).toEqual(["short one", "source reply", "short two"]);
  });

  test("a resume onto the smaller model whose source is out of reach compacts on the TARGET, its summarizer bounded to what it can read", async () => {
    const source = scripted("source", "source reply");
    const target = scripted("target", "target reply");
    const history: ProviderMessage[] = [];
    for (let i = 0; i < 6; i++) history.push({ role: "user", content: `old ${i} ${LONG}` }, { role: "assistant", content: `answer ${i} ${LONG}` });
    await drive({ source, target, startOn: DST, sourceReachable: false, persisted: { providerId: SRC.providerId, modelKey: SRC.modelKey }, initialMessages: history, steps: [{ user: "resumed" }] });
    expect(source.requests).toHaveLength(0);
    expect(target.summaries).toBe(1);
    const summaryRequest = target.requests.find((r) => isCompactionSummaryRequest(r))!;
    // Bounded: (40000 * 0.9 - 1000) tokens at 3.5 chars/token with 10% margin, plus the instruction itself.
    expect(JSON.stringify(summaryRequest.messages).length).toBeLessThan(Math.floor(((40_000 * 0.9 - 1_000) * 3.5) / 1.1) + 4_000);
    expect(String(summaryRequest.messages.at(-1)!.content)).toContain("earliest");
    const main = target.requests.at(-1)!;
    expect(JSON.stringify(main.messages[0]!.content)).toContain("SUMMARY by target");
  });
});
