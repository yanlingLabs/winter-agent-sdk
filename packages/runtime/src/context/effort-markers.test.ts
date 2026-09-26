// WS-23 item 1: per-message effort. The markers are DERIVED from each assistant message's
// `effort`/`perTurnEffort` annotations (`withEffortMarkers`), the top-level value stays frozen on a
// row whose catalog evidence documents per-message effort, and `set_effort` moves the live level at
// the quiescent boundary. Ground truth is the LIVE provider request the engine builds.
import { describe, expect, test } from "bun:test";
import type { RuntimeConfig, WinterFrame } from "@yanlinglabs/winter-agent-sdk";
import { createInMemoryChannel } from "../protocol/channel.ts";
import { ProviderTurnError, runEngine, type EngineOptions, type ModelDescription, type ProviderMessage, type ProviderRequest, type ProviderTurn } from "../engine.ts";
import { stubExecutor } from "../provider/mock.ts";
import { fakeCompactionController } from "../compaction/seam.ts";
import { buildRequestMessages, frozenEffortFromHistory, withEffortMarkers, type EffortMarkerPlan } from "./request-layout.ts";
import { attachmentMessage } from "./attachments.ts";

const all = (): boolean => true;
const marker = (effort: string): ProviderMessage => ({ role: "system", content: [], outputConfig: { effort } });
const plan = (initial: string, live: string, accepts: (e: string) => boolean = all): EffortMarkerPlan => ({ initial, live, accepts });

describe("withEffortMarkers (pure, on the PRE-merge list)", () => {
  test("no change -> no marker; the pending turn runs at the live level", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b", effort: "high", perTurnEffort: "high" }, { role: "user", content: "c" }];
    expect(withEffortMarkers(history, plan("high", "high"))).toEqual(history);
    expect(withEffortMarkers(history, plan("high", "low"))).toEqual([...history.slice(0, 2), marker("low"), history[2]!]);
  });

  test("a changed historic turn keeps its marker at the SAME position on every later request (turns 1 -> 3)", () => {
    const t2: ProviderMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "r1", effort: "high", perTurnEffort: "high" },
      { role: "user", content: "two" },
      { role: "assistant", content: "r2", effort: "high", perTurnEffort: "low" },
      { role: "user", content: "three" },
    ];
    expect(withEffortMarkers(t2, plan("high", "high"))).toEqual([t2[0]!, t2[1]!, marker("low"), t2[2]!, t2[3]!, marker("high"), t2[4]!]);
  });

  test("tool rounds are not turn starts; a level the row cannot take gets no marker (deterministic, so still byte-stable)", () => {
    const history: ProviderMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "X", input: {} }], effort: "high", perTurnEffort: "minimal" },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
      { role: "assistant", content: "done", effort: "high", perTurnEffort: "minimal" },
    ];
    expect(withEffortMarkers(history, plan("high", "high", (e) => e !== "minimal"))).toEqual(history);
  });

  test("the index-0 meta context and attachments are never turn starts; an un-annotated history is left alone", () => {
    const history: ProviderMessage[] = [{ role: "user", content: "ctx", isMeta: true }, { role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "q2" }];
    expect(withEffortMarkers(history, plan("high", "high"))).toEqual(history);
  });

  test("frozenEffortFromHistory reads the newest ANNOTATED assistant message, absent top-level included", () => {
    expect(frozenEffortFromHistory([{ role: "assistant", content: "a", effort: "high", perTurnEffort: "high" }, { role: "user", content: "x" }, { role: "assistant", content: "b", effort: "max", perTurnEffort: "low" }])).toEqual({ value: "max" });
    expect(frozenEffortFromHistory([{ role: "assistant", content: "a", perTurnEffort: "low" }])).toEqual({ value: undefined });
    expect(frozenEffortFromHistory([{ role: "user", content: "x" }, { role: "assistant", content: "plain" }])).toBeUndefined();
  });
});

describe("buildRequestMessages with an effort plan (fix round 1: I1, I2)", () => {
  test("a LEADING marker at the initial level opens every request -- the beta rides every request, not just the one that switches", () => {
    const out = buildRequestMessages([{ role: "user", content: "one" }], "ctx", { effort: plan("high", "high") });
    expect(out[0]).toEqual(marker("high"));
    expect(out.slice(1).map((m) => m.role)).toEqual(["user"]);
  });

  test("I2, the reviewer's case: a prompt after an INTERRUPTED tool round still gets its marker, and is not folded into the tool message", () => {
    const history: ProviderMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }], effort: "high", perTurnEffort: "high" },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: "[interrupted]", interrupted: true }] },
      { role: "user", content: "now do this instead" },
    ];
    const out = buildRequestMessages(history, undefined, { effort: plan("high", "low") });
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "system", "user"]);
    expect(out[4]).toEqual(marker("low"));
    expect(out[5]).toEqual({ role: "user", content: "now do this instead" });
  });

  test("a turn's bubbled-up attachments stay merged with its prompt: the marker goes before them, right after the reply", () => {
    const skills = attachmentMessage({ type: "skill_listing", content: "- alpha: Alpha.", skillCount: 1, isInitial: false, names: ["alpha"] })!;
    const history: ProviderMessage[] = [{ role: "user", content: "one" }, { role: "assistant", content: "r1", effort: "high", perTurnEffort: "high" }, { role: "user", content: "two" }, skills];
    const out = buildRequestMessages(history, undefined, { effort: plan("high", "low") });
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "system", "user"]);
    expect(JSON.stringify(out[4]!.content)).toContain("alpha");
    expect(JSON.stringify(out[4]!.content)).toContain("two");
  });
});

// --- through the real engine ---------------------------------------------------------------------

type Step = { user: string } | { control: string; payload: unknown };

const OPUS_55: ModelDescription = { displayName: "Claude Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], wire: { perMessageEffort: true } };
const FABLE_5: ModelDescription = { displayName: "Claude Fable 5", efforts: ["low", "medium", "high", "xhigh", "max"] };

async function drive(opts: { steps: Step[]; config?: Partial<RuntimeConfig>; noEffort?: boolean; describe?: ModelDescription; generate?: (req: ProviderRequest, index: number) => ProviderTurn; engine?: Partial<EngineOptions> }) {
  const requests: ProviderRequest[] = [];
  const recorded: Array<{ content: unknown; opts: unknown }> = [];
  const { host, runtime } = createInMemoryChannel();
  const done = runEngine({
    config: { sessionId: `effort-${Math.random().toString(36).slice(2)}`, cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5", ...(opts.noEffort === true ? {} : { effort: "high" as const }), ...(opts.config ?? {}) },
    input: runtime.input,
    output: runtime.output,
    provider: {
      async generate(req) {
        requests.push({ ...req, messages: structuredClone(req.messages) });
        return opts.generate?.(req, requests.length - 1) ?? { kind: "text", text: `reply ${requests.length}` };
      },
    },
    tools: stubExecutor,
    providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
    describeModel: () => opts.describe ?? OPUS_55,
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
  const acks: Array<{ requestId: string; ok: boolean; error?: { code: string; message: string } }> = [];
  let users = 0;
  let controls = 0;
  for (const step of opts.steps) {
    if ("user" in step) {
      host.output.write({ type: "user", text: step.user });
      users++;
      for (let n = 0; n < 2000 && results() < users; n++) await new Promise((r) => setTimeout(r, 2));
    } else {
      const requestId = `c${++controls}`;
      host.output.write({ type: "control_request", requestId, subtype: step.control, payload: step.payload });
      for (let n = 0; n < 2000 && !frames.some((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId); n++) await new Promise((r) => setTimeout(r, 2));
      acks.push(frames.find((f) => f.type === "control_response" && (f as { requestId: string }).requestId === requestId) as (typeof acks)[number]);
    }
  }
  host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
  await done;
  await reader;
  return { requests, acks, recorded, frames };
}

/** The CHANGE markers -- every effort marker but the leading one every per-message request opens with. */
const markers = (req: ProviderRequest): Array<{ at: number; effort: string }> =>
  req.messages.flatMap((m, at) => (at > 0 && m.role === "system" && m.outputConfig !== undefined ? [{ at, effort: m.outputConfig.effort }] : []));
const leading = (req: ProviderRequest): string | undefined => (req.messages[0]?.role === "system" ? req.messages[0].outputConfig?.effort : undefined);

describe("per-message effort through the engine (WS-23 item 1)", () => {
  test("a per-message row: the top-level effort stays frozen at `high`, and each switch rides a marker placed before the user turn it applies to", async () => {
    const { requests, acks } = await drive({
      steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { control: "set_effort", payload: { effort: "high" } }, { user: "three" }],
    });
    expect(acks.every((a) => a.ok)).toBe(true);
    expect(requests.map((r) => r.effort)).toEqual(["high", "high", "high"]);
    expect(markers(requests[0]!)).toEqual([]);
    // Every request opens with the leading marker at the frozen level (fix round 1, I1).
    expect(requests.map(leading)).toEqual(["high", "high", "high"]);
    // [lead][user one][assistant][marker low][user two]
    expect(markers(requests[1]!)).toEqual([{ at: 3, effort: "low" }]);
    // Turn 3 re-derives turn 2's marker at the SAME index, then adds its own before `three`.
    expect(markers(requests[2]!)).toEqual([{ at: 3, effort: "low" }, { at: 6, effort: "high" }]);
    // Append-only: every earlier request's messages are a byte-identical prefix of the next one's.
    expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual(requests[1]!.messages);
    expect(requests[1]!.messages.slice(0, requests[0]!.messages.length)).toEqual(requests[0]!.messages);
  });

  test("the assistant messages carry `effort` (top-level sent) and `perTurnEffort` (level in force), and the transcript write receives them", async () => {
    const { requests, recorded } = await drive({ steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { user: "three" }] });
    const assistants = requests[2]!.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => [m.effort, m.perTurnEffort])).toEqual([
      ["high", "high"],
      ["high", "low"],
    ]);
    expect(recorded).toHaveLength(3);
  });

  test("a row WITHOUT the evidence (Fable 5): a switch is a new top-level value and no marker is ever sent", async () => {
    const { requests } = await drive({ describe: FABLE_5, config: { model: "anthropic/claude-fable-5" }, steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }] });
    expect(requests.map((r) => r.effort)).toEqual(["high", "low"]);
    expect(requests.flatMap(markers)).toEqual([]);
  });

  test("a session with no effort sends none and annotates nothing (byte-identical to before)", async () => {
    const { requests } = await drive({ noEffort: true, steps: [{ user: "one" }, { user: "two" }] });
    expect(requests.map((r) => r.effort)).toEqual([undefined, undefined]);
    expect(requests[1]!.messages.find((m) => m.role === "assistant")).not.toHaveProperty("perTurnEffort");
  });

  test("set_effort validates: a non-tier and a level outside the row's vocabulary are typed `invalid_effort` refusals; `default` resets", async () => {
    const { requests, acks } = await drive({
      describe: { ...OPUS_55, efforts: ["low", "high"] },
      steps: [
        { control: "set_effort", payload: { effort: 7 } },
        { control: "set_effort", payload: { effort: "max" } },
        { control: "set_effort", payload: { effort: "low" } },
        { control: "set_effort", payload: { effort: "default" } },
        { user: "one" },
      ],
    });
    expect(acks.map((a) => [a.ok, a.error?.code])).toEqual([
      [false, "invalid_effort"],
      [false, "invalid_effort"],
      [true, undefined],
      [true, undefined],
    ]);
    // `default` put it back to the session's own `high` before the first turn.
    expect(requests[0]!.effort).toBe("high");
    expect(markers(requests[0]!)).toEqual([]);
    expect(leading(requests[0]!)).toBe("high");
  });

  test("a set_effort arriving MID-TURN is parked: the running turn finishes at its level, the next one runs at the new one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { host, runtime } = createInMemoryChannel();
    const requests: ProviderRequest[] = [];
    const done = runEngine({
      config: { sessionId: "effort-park", cwd: "/winter-fixture", model: "anthropic/claude-opus-5-5", effort: "high" },
      input: runtime.input,
      output: runtime.output,
      provider: {
        async generate(req) {
          requests.push({ ...req, messages: structuredClone(req.messages) });
          if (requests.length === 1) await gate;
          return { kind: "text", text: `r${requests.length}` };
        },
      },
      tools: stubExecutor,
      providerIdentity: { providerId: "anthropic", modelKey: "anthropic/claude-opus-5-5", family: "anthropic" },
      describeModel: () => OPUS_55,
    } as EngineOptions);
    const frames: WinterFrame[] = [];
    const reader = (async () => {
      for await (const f of host.input) frames.push(f);
    })();
    const results = (): number => frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").length;
    host.output.write({ type: "user", text: "one" });
    for (let n = 0; n < 500 && requests.length < 1; n++) await new Promise((r) => setTimeout(r, 2));
    host.output.write({ type: "control_request", requestId: "e", subtype: "set_effort", payload: { effort: "low" } });
    for (let n = 0; n < 500 && !frames.some((f) => f.type === "control_response"); n++) await new Promise((r) => setTimeout(r, 2));
    release();
    for (let n = 0; n < 500 && results() < 1; n++) await new Promise((r) => setTimeout(r, 2));
    host.output.write({ type: "user", text: "two" });
    for (let n = 0; n < 500 && results() < 2; n++) await new Promise((r) => setTimeout(r, 2));
    host.output.write({ type: "control_request", requestId: "end", subtype: "end_input", payload: undefined });
    await done;
    await reader;
    const assistants = requests[1]!.messages.filter((m) => m.role === "assistant");
    expect(assistants[0]!.perTurnEffort).toBe("high");
    expect(markers(requests[1]!)).toEqual([{ at: 3, effort: "low" }]);
  });

  test("the API refusing the beta with a 400 -- on TURN ONE, since the beta rides every request: the round re-runs with NO marker at the live level, and the fallback is sticky", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.join(" "));
    try {
      const { requests, frames } = await drive({
        steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { control: "set_effort", payload: { effort: "max" } }, { user: "three" }],
        generate: (req, index) => {
          if (req.messages.some((m) => m.role === "system")) throw new ProviderTurnError("provider request failed (bad_request): HTTP 400 — output_config.effort requires a model that supports per-turn effort; this model does not", { status: 400, code: "bad_request", retryable: false });
          return { kind: "text", text: `r${index}` };
        },
      });
      // one: refused (the beta rides it), re-run plain at `high`; then plain throughout.
      expect(requests.map((r) => [r.effort, r.messages.filter((m) => m.role === "system").length])).toEqual([
        ["high", 1],
        ["high", 0],
        ["low", 0],
        ["max", 0],
      ]);
      const results = frames.filter((f) => f.type === "data" && (f as { message: { type: string } }).message.type === "result").map((f) => (f as { message: { is_error: boolean } }).message.is_error);
      expect(results).toEqual([false, false, false]);
      expect(errors.filter((e) => e.includes("refused per-message effort"))).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });
});

describe("the frozen top-level effort lives in engine state (fix round 1, M2)", () => {
  const WITH_DEFAULT: ModelDescription = { ...OPUS_55, defaultEffort: "medium" };

  test("an EFFORTLESS session's first set_effort does not introduce a top-level value: the switch rides a marker from the row's default", async () => {
    const { requests } = await drive({ noEffort: true, describe: WITH_DEFAULT, steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { control: "set_effort", payload: { effort: "default" } }, { user: "three" }] });
    expect(requests.map((r) => r.effort)).toEqual([undefined, undefined, undefined]);
    expect(requests.map(leading)).toEqual(["medium", "medium", "medium"]);
    expect(markers(requests[1]!)).toEqual([{ at: 3, effort: "low" }]);
    // `default` puts the model back on its own level -- expressed as a marker, the top level untouched.
    expect(markers(requests[2]!)).toEqual([{ at: 3, effort: "low" }, { at: 6, effort: "medium" }]);
  });

  test("after a compaction whose kept history carries no annotation, the top-level value does not move", async () => {
    const { requests } = await drive({
      steps: [{ user: "one" }, { control: "set_effort", payload: { effort: "low" } }, { user: "two" }, { user: "/compact" }, { user: "three" }],
      engine: { compactionController: fakeCompactionController({ keep: 0, summary: "SUMMARY" }) },
    });
    const afterCompaction = requests.at(-1)!;
    expect(afterCompaction.messages.some((m) => m.content === "SUMMARY")).toBe(true);
    expect(afterCompaction.effort).toBe("high");
    expect(leading(afterCompaction)).toBe("high");
    // The kept history has no annotated reply, so the live `low` for turn three rides its own marker.
    expect(markers(afterCompaction).map((m) => m.effort)).toEqual(["low"]);
  });

  test("a resumed session restores the frozen value from the transcript, absent included", async () => {
    const history: ProviderMessage[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: "r", perTurnEffort: "low" }];
    const { requests } = await drive({ describe: WITH_DEFAULT, engine: { initialMessages: history }, steps: [{ user: "next" }] });
    // The transcript's session sent no top-level effort; the host's `high` rides a marker instead.
    expect(requests[0]!.effort).toBeUndefined();
    expect(leading(requests[0]!)).toBe("medium");
    expect(markers(requests[0]!).map((m) => m.effort)).toEqual(["low", "high"]);
  });
});
