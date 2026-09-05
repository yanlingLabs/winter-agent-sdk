import { describe, expect, test } from "bun:test";
import type { ContentBlockLike, ProviderMessageLike } from "../types.ts";
import { createSwitchCoordinator, type SwitchCoordinator } from "./coordinator.ts";
import type { ContinuityEndpoint } from "./domains.ts";
import type { ContinuationChainLike, ContinuationLinkLike } from "./renderer.ts";

const CLAUDE: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/claude-a", family: "anthropic", continuationDomain: "anthropic/claude-a", readableState: "summary" };
const OPENAI: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/o-reason", family: "openai", continuationDomain: "openai/o-reason", readableState: "summary" };

const chainOf = (entries: Record<string, ContinuationLinkLike>): ContinuationChainLike => new Map(Object.entries(entries));

/**
 * A SCRIPTED ENGINE, not the real one: a turn, a native tool loop, and the two facts §12.3 asks
 * about -- which model each generation ran on, and which model each tool result was delivered to.
 *
 * It is deliberately dumb. Its only job is to be a thing a switch can be requested DURING, so that
 * "the default waits for the boundary" and "the source receives every native tool result" are
 * assertions about observed behaviour rather than about the coordinator's own return value.
 */
class ScriptedEngine {
  model: string;
  turnActive = false;
  cancels: string[] = [];
  readonly generations: Array<{ model: string }> = [];
  readonly deliveries: Array<{ model: string; toolUseId: string }> = [];
  readonly messages: ProviderMessageLike[] = [];

  constructor(model: string) {
    this.model = model;
  }

  /** The owner the coordinator cancels THROUGH. Only this object can stop its own generation. */
  get owner(): { cancel(reason: string): void } {
    return {
      cancel: (reason: string) => {
        this.cancels.push(reason);
        this.turnActive = false;
      },
    };
  }

  startTurn(prompt: string): void {
    this.turnActive = true;
    this.messages.push({ role: "user", content: prompt });
  }

  generate(uuid: string, blocks: ContentBlockLike[], nativeItems?: unknown[]): void {
    this.generations.push({ model: this.model });
    this.messages.push({
      role: "assistant",
      content: blocks,
      uuid,
      origin: { providerId: this.model.split("/")[0]!, modelKey: this.model, family: "anthropic", continuationDomain: this.model },
      ...(nativeItems !== undefined ? { nativeState: { family: "anthropic", continuationDomain: this.model, items: nativeItems } } : {}),
    });
  }

  deliverToolResult(toolUseId: string, content: string): void {
    this.deliveries.push({ model: this.model, toolUseId });
    this.messages.push({ role: "tool", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] });
  }

  endTurn(): void {
    this.turnActive = false;
  }
}

function midToolLoop(): { engine: ScriptedEngine; coordinator: SwitchCoordinator } {
  const engine = new ScriptedEngine("anthropic/claude-a");
  engine.startTurn("run the migration");
  engine.generate("m1", [{ type: "text", text: "reading first" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } }], ["CLAUDE-OPAQUE"]);
  return { engine, coordinator: createSwitchCoordinator() };
}

describe("§8.2: the default is finish this turn, then switch", () => {
  test("a switch requested MID-TOOL-LOOP waits, and the source keeps its own turn", () => {
    const { engine, coordinator } = midToolLoop();
    const decision = coordinator.request({ from: CLAUDE, to: OPENAI, turnActive: engine.turnActive, facts: { summaryAvailable: true, completedToolResults: 0 } });

    expect(decision.action).toBe("defer-to-boundary");
    expect(coordinator.pending()?.to.modelKey).toBe("openai/o-reason");
    // NOTHING about the running turn changed: the coordinator recorded and returned (§8.2's rule 6,
    // "never mutate the already-running provider request in place").
    expect(engine.model).toBe("anthropic/claude-a");
    expect(engine.turnActive).toBe(true);
    expect(engine.cancels).toEqual([]);

    // The loop continues on the SOURCE: every native tool result is delivered to the model that
    // authored the call, and the follow-up generation runs on it too.
    engine.deliverToolResult("t1", "contents");
    engine.generate("m2", [{ type: "text", text: "done" }], ["CLAUDE-OPAQUE-2"]);
    expect(engine.deliveries).toEqual([{ model: "anthropic/claude-a", toolUseId: "t1" }]);
    expect(engine.generations.map((g) => g.model)).toEqual(["anthropic/claude-a", "anthropic/claude-a"]);

    // ... and only at the quiescent boundary does the switch apply.
    engine.endTurn();
    const applied = coordinator.apply("quiescent-boundary", { messages: engine.messages, chain: chainOf({ m1: { summary: "claude's summary" } }) })!;
    expect(applied.reason).toBe("set_model");
    expect(applied.to.modelKey).toBe("openai/o-reason");
    expect(applied.discard).toBeUndefined();
    expect(coordinator.pending()).toBeUndefined();

    // THE TARGET NEVER RECEIVES THE SOURCE'S OPAQUE STATE (§12.3's fourth check), and it does receive
    // the portable task state (its fifth).
    const handoffText = applied.handoff!.text;
    expect(handoffText).not.toContain("CLAUDE-OPAQUE");
    expect(handoffText).toContain("claude's summary");
    expect(handoffText).toContain("run the migration");
    expect(handoffText).toContain("[completed tool] Read");
  });

  test("the loss warning is computed AT REQUEST TIME -- a user confirms with the warning in hand", () => {
    const { engine, coordinator } = midToolLoop();
    const decision = coordinator.request({ from: CLAUDE, to: OPENAI, turnActive: engine.turnActive, facts: { summaryAvailable: true } });
    expect(decision.classification.lossClass).toBe("warned-lossy");
    expect(decision.classification.warnings[0]).toContain("cannot be used by openai");
    expect(decision.classification.portable[0]).toBe("the visible conversation");
  });

  test("IDLE is itself a quiescent boundary: nothing is in flight, so the switch applies now", () => {
    const coordinator = createSwitchCoordinator();
    const decision = coordinator.request({ from: CLAUDE, to: OPENAI, turnActive: false });
    expect(decision.action).toBe("apply-now");
    expect(decision.classification.warnings.some((w) => w.includes("cancelled before it finished"))).toBe(false);
    const applied = coordinator.apply("idle")!;
    expect(applied.reason).toBe("set_model");
    expect(applied.handoff).toBeUndefined(); // no messages supplied -> no handoff, never an empty one
  });

  test("a lossless switch produces no warning at all, at request time and on apply", () => {
    const coordinator = createSwitchCoordinator();
    const decision = coordinator.request({ from: OPENAI, to: OPENAI, turnActive: false });
    expect(decision.classification.lossClass).toBe("lossless-native");
    expect(decision.classification.warnings).toEqual([]);
    expect(coordinator.apply("idle")!.classification.warnings).toEqual([]);
  });

  test("a pending switch can be dropped without applying it", () => {
    const { engine, coordinator } = midToolLoop();
    coordinator.request({ from: CLAUDE, to: OPENAI, turnActive: engine.turnActive });
    expect(coordinator.cancel()?.to.modelKey).toBe("openai/o-reason");
    expect(coordinator.pending()).toBeUndefined();
    expect(coordinator.apply("quiescent-boundary")).toBeUndefined();
  });
});

describe("C1: the handoff is built BEFORE the classification, and its reasoning loss folds in", () => {
  const deepseek: ContinuityEndpoint = { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai", continuationDomain: "deepseek/r-reason", readableState: "full-exposed" };
  const deepseekHistory = (summary: string): { messages: ProviderMessageLike[]; chain: ContinuationChainLike } => ({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "done" }], uuid: "m1", origin: { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai" } },
    ],
    chain: chainOf({ m1: { summary } }),
  });

  test("a handoff that TRIMMED the source's reasoning flips the applied classification to warned-lossy", () => {
    // Review C1's own reproduction: `lossless-portable` with zero warnings was returned beside a
    // handoff whose reasoning had been cut to 400 characters -- §9.6 violated at the one point that
    // composes the two, and unreachable by any T10 wiring because the handoff is built in here.
    const coordinator = createSwitchCoordinator();
    const requested = coordinator.request({ from: deepseek, to: OPENAI, turnActive: false, facts: { exposedComplete: true } });
    expect(requested.classification.lossClass).toBe("lossless-portable");

    const applied = coordinator.apply("idle", deepseekHistory("R".repeat(10_000)))!;
    expect(applied.handoff!.reasoningTruncated).toBe(true);
    expect(applied.classification.lossClass).toBe("warned-lossy");
    expect(applied.classification.warnings.some((w) => w.includes("trimmed to fit"))).toBe(true);
  });

  test("a handoff that trimmed NOTHING leaves the lossless classification standing", () => {
    const coordinator = createSwitchCoordinator();
    coordinator.request({ from: deepseek, to: OPENAI, turnActive: false, facts: { exposedComplete: true } });
    const applied = coordinator.apply("idle", deepseekHistory("a short complete trace"))!;
    expect(applied.handoff!.reasoningTruncated).toBe(false);
    expect(applied.classification.lossClass).toBe("lossless-portable");
    expect(applied.classification.warnings).toEqual([]);
  });

  test("a trimmed TOOL-DETAIL excerpt alone does NOT flip the class", () => {
    const coordinator = createSwitchCoordinator();
    coordinator.request({ from: deepseek, to: OPENAI, turnActive: false, facts: { exposedComplete: true } });
    const messages: ProviderMessageLike[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/big.ts" } }],
        uuid: "m1",
        origin: { providerId: "deepseek", modelKey: "deepseek/r-reason", family: "openai" },
      },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t1", content: "X".repeat(5_000) }] },
    ];
    const applied = coordinator.apply("idle", { messages, chain: chainOf({ m1: { summary: "short" } }) })!;
    expect(applied.handoff!.truncated).toBe(true);
    expect(applied.handoff!.reasoningTruncated).toBe(false);
    expect(applied.classification.lossClass).toBe("lossless-portable");
  });

  test("the immediate path folds it in too", () => {
    const coordinator = createSwitchCoordinator();
    coordinator.request({ from: deepseek, to: OPENAI, mode: "immediate", turnActive: true, facts: { exposedComplete: true } });
    const applied = coordinator.applyImmediately({ owner: { cancel: () => {} }, ...deepseekHistory("R".repeat(10_000)) })!;
    expect(applied.classification.warnings.some((w) => w.includes("trimmed to fit"))).toBe(true);
    expect(applied.handoff!.reasoningTruncated).toBe(true);
  });
});

describe("§8.3: the immediate switch cancels rather than splices", () => {
  test("cancel through the OWNER, mark the loop incomplete, fabricate nothing, keep the completed facts", () => {
    const { engine, coordinator } = midToolLoop();
    const before = engine.messages.length;
    const decision = coordinator.request({ from: CLAUDE, to: OPENAI, mode: "immediate", turnActive: engine.turnActive, facts: { summaryAvailable: true } });
    expect(decision.action).toBe("cancel-then-switch");

    const applied = coordinator.applyImmediately({
      owner: engine.owner,
      messages: engine.messages,
      chain: chainOf({ m1: { summary: "claude's summary" } }),
      completedToolResults: 1,
    })!;

    // 1. cancelled through the owning runtime, exactly once.
    expect(engine.cancels).toHaveLength(1);
    expect(engine.cancels[0]).toContain("openai/o-reason");
    expect(engine.turnActive).toBe(false);
    // 2/3. the loop is marked incomplete and NOTHING was manufactured to close it: the unanswered
    // tool_use is still unanswered, and the conversation grew by zero messages.
    expect(applied.discard).toMatchObject({ incompleteToolLoop: true, discardedInFlightReasoning: true, fabricatedToolResults: 0, completedToolResultsRetained: 1 });
    expect(engine.messages).toHaveLength(before);
    expect(engine.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content)).some((b) => b.type === "tool_result")).toBe(false);
    // 4. completed tool facts cross as portable text.
    expect(applied.handoff!.text).toContain("run the migration");
    // 5/6. the discard is REPORTED, and it does not claim anything was rolled back.
    expect(applied.discard!.detail).toContain("no tool result or final response was manufactured");
    expect(applied.discard!.detail).toContain("side effects already performed are not undone");
    expect(applied.classification.warnings.some((w) => w.includes("cancelled before it finished"))).toBe(true);
    expect(applied.reason).toBe("interrupt");
  });

  test("the discard report carries counts and identity only -- never a payload", () => {
    const { engine, coordinator } = midToolLoop();
    coordinator.request({ from: CLAUDE, to: OPENAI, mode: "immediate", turnActive: engine.turnActive });
    const applied = coordinator.applyImmediately({ owner: engine.owner, completedToolResults: 2 })!;
    const serialized = JSON.stringify(applied.discard);
    for (const forbidden of ["CLAUDE-OPAQUE", "encrypted_content", "signature", "redacted_thinking"]) expect(serialized).not.toContain(forbidden);
  });

  test("`applyImmediately` with nothing pending is a no-op, and never cancels a turn on speculation", () => {
    const engine = new ScriptedEngine("anthropic/claude-a");
    expect(createSwitchCoordinator().applyImmediately({ owner: engine.owner })).toBeUndefined();
    expect(engine.cancels).toEqual([]);
  });
});

describe("R6-I: an interrupt is an early quiescent boundary", () => {
  test("a DEFERRED switch applies on interrupt, and is reclassified as the abort it now is", () => {
    const { engine, coordinator } = midToolLoop();
    const decision = coordinator.request({ from: CLAUDE, to: OPENAI, turnActive: engine.turnActive, facts: { summaryAvailable: true } });
    expect(decision.classification.warnings.some((w) => w.includes("cancelled before it finished"))).toBe(false);

    // The user interrupts for their own reasons; the engine calls the same hook.
    const applied = coordinator.apply("interrupt", { messages: engine.messages, chain: chainOf({}) })!;
    expect(applied.reason).toBe("interrupt");
    expect(applied.classification.warnings.some((w) => w.includes("cancelled before it finished"))).toBe(true);
    // It is NOT the immediate path: the coordinator did not cancel anything -- the interrupt already did.
    expect(engine.cancels).toEqual([]);
    expect(applied.discard).toBeUndefined();
  });

  test("a switch requested while IDLE and applied on a later interrupt is not reclassified as an abort", () => {
    const coordinator = createSwitchCoordinator();
    coordinator.request({ from: CLAUDE, to: OPENAI, turnActive: false, facts: { summaryAvailable: true } });
    const applied = coordinator.apply("interrupt")!;
    expect(applied.classification.warnings.some((w) => w.includes("cancelled before it finished"))).toBe(false);
  });
});
