// WS-23 (midconv) items 2-3: the tool epoch's PURE half -- the diff table (context/tool-epoch.ts) and how
// the request layout replays its entries. The engine half (freezing, persistence, resume, fallback) is
// tool-epoch.engine.test.ts.
import { describe, expect, test } from "bun:test";
import type { ProviderMessage, ProviderToolSpec } from "../engine.ts";
import { attachmentMessage } from "./attachments.ts";
import { buildRequestMessages, referencedToolNames } from "./request-layout.ts";
import {
  activeToolEpoch,
  diffToolState,
  epochChangeMessages,
  epochToolsFor,
  foldToolState,
  type ToolChangeMechanism,
  type ToolChangesAttachment,
  type ToolEpochAttachment,
} from "./tool-epoch.ts";

const spec = (name: string, description = `${name} tool`, extra: Partial<ProviderToolSpec> = {}): ProviderToolSpec => ({ name, description, inputSchema: { type: "object" }, ...extra });
const epoch = (tools: ProviderToolSpec[], mechanism: ToolChangeMechanism = "anthropic-reference", modelKey = "m"): ProviderMessage =>
  attachmentMessage({ type: "tool_epoch", mechanism, modelKey, tools } satisfies ToolEpochAttachment)!;
const changes = (change: Pick<ToolChangesAttachment, "declare" | "remove" | "add">, mechanism: ToolChangeMechanism = "anthropic-reference"): ProviderMessage =>
  attachmentMessage({ type: "tool_changes", mechanism, ...change } satisfies ToolChangesAttachment)!;

function stateOf(history: ProviderMessage[], mechanism: ToolChangeMechanism = "anthropic-reference") {
  const active = activeToolEpoch(history, mechanism, "m")!;
  return foldToolState(active.epoch, epochChangeMessages(history, active.index, mechanism), referencedToolNames(history));
}

describe("the diff table, by reference (`mid-conversation-tool-changes-2026-07-01`)", () => {
  const history = [{ role: "user" as const, content: "go" }, epoch([spec("A"), spec("B"), spec("D", "D tool", { deferLoading: true })])];

  test("no change -> nothing to append", () => {
    expect(diffToolState([spec("A"), spec("B"), spec("D", "D tool", { deferLoading: true })], stateOf(history), "anthropic-reference")).toEqual({ kind: "same" });
  });

  test("a late EAGER tool is declared deferred after the frozen list and added by reference", () => {
    const diff = diffToolState([spec("A"), spec("B"), spec("C"), spec("D", "D tool", { deferLoading: true })], stateOf(history), "anthropic-reference");
    expect(diff).toEqual({ kind: "change", change: { declare: [spec("C", "C tool", { deferLoading: true })], remove: [], add: [{ type: "reference", name: "C" }] } });
  });

  test("a late DEFERRED tool is declared and announced by reference (brief item 2, claude's late-tool-additions shape)", () => {
    const diff = diffToolState([spec("A"), spec("B"), spec("D", "D tool", { deferLoading: true }), spec("E", "E tool", { deferLoading: true })], stateOf(history), "anthropic-reference");
    expect(diff).toEqual({ kind: "change", change: { declare: [spec("E", "E tool", { deferLoading: true })], remove: [], add: [{ type: "reference", name: "E" }] } });
  });

  test("a withdrawn tool is removed by reference; re-offering it later is a reference addition, never a new declaration", () => {
    const removed = diffToolState([spec("A"), spec("D", "D tool", { deferLoading: true })], stateOf(history), "anthropic-reference");
    expect(removed).toEqual({ kind: "change", change: { declare: [], remove: ["B"], add: [] } });
    const after = [...history, changes({ declare: [], remove: ["B"], add: [] })];
    expect(diffToolState([spec("A"), spec("B"), spec("D", "D tool", { deferLoading: true })], stateOf(after), "anthropic-reference")).toEqual({ kind: "change", change: { declare: [], remove: [], add: [{ type: "reference", name: "B" }] } });
  });

  test("a changed definition cannot be said by reference: a new epoch (today's rebuild, once)", () => {
    const diff = diffToolState([spec("A", "A, reworded"), spec("B"), spec("D", "D tool", { deferLoading: true })], stateOf(history), "anthropic-reference");
    expect(diff.kind).toBe("new-epoch");
  });

  test("an epoch frozen with no eager tool cannot declare a late one (the API needs one non-deferred tool)", () => {
    const deferredOnly = [{ role: "user" as const, content: "go" }, epoch([spec("D", "D tool", { deferLoading: true })])];
    expect(diffToolState([spec("C"), spec("D", "D tool", { deferLoading: true })], stateOf(deferredOnly), "anthropic-reference").kind).toBe("new-epoch");
  });

  test("a deferred tool a ToolSearch result referenced counts as available -- its later withdrawal is a removal", () => {
    const withSearch: ProviderMessage[] = [...history, { role: "assistant", content: [{ type: "tool_use", id: "s", name: "ToolSearch", input: {} }] }, { role: "tool", content: [{ type: "tool_result", tool_use_id: "s", content: "{}", loadedTools: ["D"] }] }];
    expect(diffToolState([spec("A"), spec("B")], stateOf(withSearch), "anthropic-reference")).toEqual({ kind: "change", change: { declare: [], remove: ["D"], add: [] } });
  });
});

describe("the diff table, by value (`inline-tools-2026-09-15`)", () => {
  const history = [{ role: "user" as const, content: "go" }, epoch([spec("A"), spec("B")], "anthropic-inline")];

  test("a late eager tool is DEFINED by value; `tools` gains nothing", () => {
    expect(diffToolState([spec("A"), spec("B"), spec("C")], stateOf(history, "anthropic-inline"), "anthropic-inline")).toEqual({
      kind: "change",
      change: { declare: [], remove: [], add: [{ type: "definition", name: "C", description: "C tool", inputSchema: { type: "object" } }] },
    });
  });

  test("REDEFINITION: a changed description or schema is a new definition under the same name -- no removal first -- and it wins from there on", () => {
    const redefined = spec("A", "A, reworded", { inputSchema: { type: "object", properties: { x: { type: "string" } } } });
    const diff = diffToolState([redefined, spec("B")], stateOf(history, "anthropic-inline"), "anthropic-inline");
    expect(diff).toEqual({ kind: "change", change: { declare: [], remove: [], add: [{ type: "definition", name: "A", description: "A, reworded", inputSchema: redefined.inputSchema }] } });
    if (diff.kind !== "change") throw new Error("unreachable");
    const after = [...history, changes(diff.change, "anthropic-inline")];
    const state = stateOf(after, "anthropic-inline");
    // The new definition is what the model has now; `tools` still declares the frozen bytes.
    expect(state.available.get("A")?.description).toBe("A, reworded");
    expect(state.declared.find((t) => t.name === "A")?.description).toBe("A tool");
    expect(diffToolState([redefined, spec("B")], state, "anthropic-inline")).toEqual({ kind: "same" });
  });

  test("a tool added by value and later withdrawn is removed by reference", () => {
    const after = [...history, changes({ declare: [], remove: [], add: [{ type: "definition", name: "C", description: "C tool", inputSchema: { type: "object" } }] }, "anthropic-inline")];
    expect(diffToolState([spec("A"), spec("B")], stateOf(after, "anthropic-inline"), "anthropic-inline")).toEqual({ kind: "change", change: { declare: [], remove: ["C"], add: [] } });
  });
});

describe("the diff table, OpenAI (`additional_tools` + `allowed_tools`)", () => {
  const history = [{ role: "user" as const, content: "go" }, epoch(epochToolsFor([spec("A"), spec("B"), spec("D", "D tool", { deferLoading: true })], "openai"), "openai")];

  test("the frozen list never declares a deferred tool (client tool search delivers it)", () => {
    expect((history[1]!.meta!.attachment as ToolEpochAttachment).tools.map((t) => t.name)).toEqual(["A", "B"]);
  });

  test("a late tool is an `additional_tools` definition; a withdrawn one is RESTRICTED by `allowed_tools`, never removed from `tools`", () => {
    const caps = { additionalTools: true, allowedTools: true };
    expect(diffToolState([spec("A"), spec("B"), spec("C")], stateOf(history, "openai"), "openai", caps)).toEqual({
      kind: "change",
      change: { declare: [], remove: [], add: [{ type: "definition", name: "C", description: "C tool", inputSchema: { type: "object" } }] },
    });
    expect(diffToolState([spec("A"), spec("D", "D tool", { deferLoading: true })], stateOf(history, "openai"), "openai", caps)).toEqual({ kind: "same", allowedTools: ["A"] });
  });

  test("without the matching evidence, either change is a new epoch", () => {
    expect(diffToolState([spec("A"), spec("B"), spec("C")], stateOf(history, "openai"), "openai", { allowedTools: true }).kind).toBe("new-epoch");
    expect(diffToolState([spec("A")], stateOf(history, "openai"), "openai", { additionalTools: true }).kind).toBe("new-epoch");
  });
});

describe("the active epoch", () => {
  test("the LAST epoch entry wins, and only for its own model and mechanism; earlier change entries are not the new epoch's", () => {
    const history: ProviderMessage[] = [
      { role: "user", content: "a" },
      epoch([spec("A")]),
      changes({ declare: [], remove: ["A"], add: [] }),
      { role: "assistant", content: "r" },
      { role: "user", content: "b" },
      epoch([spec("B")]),
    ];
    const active = activeToolEpoch(history, "anthropic-reference", "m")!;
    expect(active.index).toBe(5);
    expect(epochChangeMessages(history, active.index, "anthropic-reference")).toEqual([]);
    expect(activeToolEpoch(history, "anthropic-reference", "other-model")).toBeUndefined();
    expect(activeToolEpoch(history, "anthropic-inline", "m")).toBeUndefined();
  });
});

describe("the request layout replays the entries", () => {
  const history: ProviderMessage[] = [
    { role: "user", content: "one" },
    epoch([spec("A"), spec("B")]),
    { role: "assistant", content: "r1" },
    { role: "user", content: "two" },
    changes({ declare: [spec("C", "C tool", { deferLoading: true })], remove: ["B"], add: [{ type: "reference", name: "C" }] }),
    { role: "assistant", content: "r2" },
  ];

  test("a change entry of the active epoch becomes an empty-content system message right after its user turn; the epoch entry never reaches the wire", () => {
    const render = new Set([history[4]!]);
    const out = buildRequestMessages(history, undefined, { toolChanges: { render } });
    expect(out).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "r1" },
      { role: "user", content: "two" },
      { role: "system", content: [], toolChanges: { remove: ["B"], add: [{ type: "reference", name: "C" }] } },
      { role: "assistant", content: "r2" },
    ]);
  });

  test("with no mechanism (or a change of another epoch) every bookkeeping entry is dropped -- the request is byte-identical to one that never had them", () => {
    const plain = history.filter((m) => m.meta === undefined);
    expect(buildRequestMessages(history)).toEqual(buildRequestMessages(plain));
    expect(buildRequestMessages(history, undefined, { toolChanges: { render: new Set() } })).toEqual(buildRequestMessages(plain));
  });

  test("a system-role reminder after the same user turn still rides as a system message (the tool change does not break its placement)", () => {
    const withReminder: ProviderMessage[] = [...history.slice(0, 4), attachmentMessage({ type: "date_change", newDate: "2026-09-27" })!, history[4]!, history[5]!];
    const out = buildRequestMessages(withReminder, undefined, { systemReminders: true, toolChanges: { render: new Set([history[4]!]) } });
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "system", "system", "assistant"]);
    expect(out[4]!.toolChanges).toBeDefined();
  });

  test("a deferred tool announced by reference in the CURRENT epoch counts as referenced; an earlier epoch's announcement does not", () => {
    expect(referencedToolNames(history).has("C")).toBe(true);
    expect(referencedToolNames([...history, epoch([spec("A")])]).has("C")).toBe(false);
  });
});
