// WS-24 (engine lane, item 5): the sticky request-feature fallbacks are PERSISTED, per provider+model.
//
// When an API refuses a feature a model's row documents (here: a mid-conversation tool change), the
// session stops sending it -- and since WS-24 that refusal is a `feature-rejected` sidecar record keyed by
// the refusing model, so a resumed session does not spend its first request finding out again. It is
// read for that provider+model only: another model's row still gets the feature.
import { afterEach, describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { ProviderTurnError, runEngine, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { registerTool, unregisterToolForTest } from "../tools/registry.ts";
import { toProviderStateRecord, type ProviderStateRecord } from "../store/provider-state.ts";

const REFERENCE_ROW: ModelDescription = { wire: { deferredToolLoading: true, toolChanges: "reference" } };
const OPUS = { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" };
const SONNET = { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5-5", family: "anthropic" };

const registered: string[] = [];
afterEach(() => {
  for (const name of registered.splice(0)) unregisterToolForTest(name);
});
function addTool(name: string): void {
  registerTool({
    descriptor: { canonicalName: name, advertisedName: name, source: "sdk", inputSchema: { type: "object", properties: {} }, description: `${name}: a sticky-fallback test tool`, exposure: "eager", permissionClass: "read", availability: {}, capabilityRequirements: [], disposition: "implement-now" },
    executor: {
      async execute() {
        return { output: "ok" };
      },
    },
  });
  registered.push(name);
}

const REFUSAL = () => new ProviderTurnError("provider request failed (bad_request): HTTP 400 — Unexpected value(s) `mid-conversation-tool-changes-2026-07-01` for the `anthropic-beta` header", { status: 400, code: "bad_request", retryable: false });

type Step = { user: string } | { act: () => void };

async function drive(opts: {
  identity: typeof OPUS;
  records: ProviderStateRecord[];
  steps: Step[];
  initialMessages?: ProviderMessage[];
  generate?: (req: ProviderRequest) => ProviderTurn;
}): Promise<ProviderRequest[]> {
  const { host, runtime } = createInMemoryChannel();
  const requests: ProviderRequest[] = [];
  const done = runEngine({
    config: { sessionId: `sticky-${Math.random().toString(36).slice(2)}`, cwd: "/winter-fixture", model: opts.identity.modelKey } as RuntimeConfig,
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        return opts.generate?.(req) ?? { kind: "text", text: `reply ${requests.length}` };
      },
    },
    tools: stubExecutor,
    providerIdentity: opts.identity,
    describeModel: () => REFERENCE_ROW,
    ...(opts.initialMessages !== undefined ? { initialMessages: opts.initialMessages } : {}),
    store: {
      recordUserEntry() {},
      recordAssistantEntry() {},
      recordAttachmentEntry() {},
      recordProviderState(input) {
        opts.records.push(toProviderStateRecord(input));
      },
      async loadProviderState() {
        return [...opts.records];
      },
    },
  } as EngineOptions);
  const frames: Array<{ type: string; message?: { type?: string } }> = [];
  const reader = (async () => {
    for await (const f of host.input) frames.push(f as never);
  })();
  const results = (): number => frames.filter((f) => f.type === "data" && f.message?.type === "result").length;
  let users = 0;
  for (const step of opts.steps) {
    if ("act" in step) {
      step.act();
      continue;
    }
    host.output.write({ type: "user", text: step.user });
    users++;
    for (let n = 0; n < 3000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return requests;
}

/** A resumed history: one exchange, whose reply carries a uuid the sidecar may (or may not) anchor to. */
const history = (): ProviderMessage[] => [
  { role: "user", content: "earlier" },
  { role: "assistant", content: "earlier reply", uuid: "11111111-1111-4111-8111-111111111111" } as ProviderMessage,
];

describe("WS-24: a refused request feature is persisted per provider+model", () => {
  test("the refusal is written as a `feature-rejected` record under the refusing model, with the next assistant entry", async () => {
    const records: ProviderStateRecord[] = [];
    addTool("zz_sticky_a");
    const original = console.error;
    console.error = () => {};
    try {
      await drive({
        identity: OPUS,
        records,
        steps: [{ user: "one" }, { act: () => addTool("aa_sticky_late") }, { user: "two" }],
        generate: (req) => {
          if (req.messages.some((m) => m.toolChanges !== undefined)) throw REFUSAL();
          return { kind: "text", text: "ok" };
        },
      });
    } finally {
      console.error = original;
    }
    const rejected = records.filter((r) => r.kind === "feature-rejected");
    expect(rejected.map((r) => ({ provider: r.provider, model: r.model, payload: r.payload }))).toEqual([{ provider: "anthropic", model: OPUS.modelKey, payload: { feature: "tool-changes" } }]);
    // Anchored to the reply the retried round produced, which carries its own `origin` record too.
    expect(records.some((r) => r.kind === "origin" && r.anchorUuid === rejected[0]!.anchorUuid)).toBe(true);
  });

  test("a RESUMED session on the same model skips the doomed request: its first request never opts in", async () => {
    addTool("zz_sticky_a");
    // Anchored to an entry the resumed history does not hold (a compaction took it): still honoured.
    const records = [toProviderStateRecord({ sessionId: "s", anchorUuid: "gone-by-compaction", provider: OPUS.providerId, model: OPUS.modelKey, family: OPUS.family, itemIndex: 0, kind: "feature-rejected", payload: { feature: "tool-changes" } })];
    const requests = await drive({ identity: OPUS, records, initialMessages: history(), steps: [{ user: "again" }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolChanges ?? false).toBe(false);
  });

  test("a different model ignores the record: its first request still opts in to tool changes", async () => {
    addTool("zz_sticky_a");
    const records = [toProviderStateRecord({ sessionId: "s", anchorUuid: "11111111-1111-4111-8111-111111111111", provider: OPUS.providerId, model: OPUS.modelKey, family: OPUS.family, itemIndex: 0, kind: "feature-rejected", payload: { feature: "tool-changes" } })];
    const requests = await drive({ identity: SONNET, records, initialMessages: history(), steps: [{ user: "again" }] });
    expect(requests[0]!.toolChanges).toBe(true);
  });

  test("without any record the resumed session opts in as before (the control for the two above)", async () => {
    addTool("zz_sticky_a");
    const requests = await drive({ identity: OPUS, records: [], initialMessages: history(), steps: [{ user: "again" }] });
    expect(requests[0]!.toolChanges).toBe(true);
  });
});
