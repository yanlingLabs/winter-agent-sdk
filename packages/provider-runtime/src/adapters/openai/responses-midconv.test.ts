// WS-23 (midconv): the Responses body builder's mid-conversation mechanisms, asserted on the request
// body it produces. Kept in its own file so other lanes' edits to `responses.test.ts` never collide.
//   - item 1: the engine's effort-only `system` marker -> `configuration_update`, gated on the row;
//   - item 4 (+ addendum): client `tool_search`, namespaces, `additional_tools`, `allowed_tools`.
import { describe, expect, test } from "bun:test";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { ProviderRequestError } from "../../http.ts";
import type { ProviderMessageLike, TurnRequest } from "../../types.ts";
import { assertConfigurationUpdates, assertResponsesToolFeatures, buildResponsesBody, CONFIGURATION_UPDATE_PLACEMENT, mapResponsesInput, ResponsesStreamMapper, responsesStreamTools } from "./responses.ts";
import { resolveReasoning } from "./shared.ts";
import { descriptor } from "./testing.ts";

const ev = <T,>(value: T) => ({ value, source: "official-doc" as const, confidence: "declared" as const });
/** A gpt-6-shaped row: the configuration_update item documented. */
const gpt6 = (): WinterModelDescriptor => {
  const row = descriptor({ key: "openai/gpt-6-astra", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
  return { ...row, reasoning: { ...row.reasoning!, perMessageEffort: ev({ item: "configuration_update" as const }) } };
};
const marker = (effort: string): ProviderMessageLike => ({ role: "system", content: [], outputConfig: { effort } });
const cfg = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const asst = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

const switched: ProviderMessageLike[] = [marker("high"), { role: "user", content: "one" }, { role: "assistant", content: "r1" }, marker("low"), { role: "user", content: "two" }];

describe("configuration_update (WS-23 midconv item 1)", () => {
  test("the documented placement is the default: the update sits BEFORE the user message it applies to", () => {
    expect(CONFIGURATION_UPDATE_PLACEMENT).toBe("before-user");
    expect(mapResponsesInput(switched)).toEqual([cfg("high"), user("one"), asst("r1"), cfg("low"), user("two")]);
  });

  test("Codex's placement is one option away (what the probe flips): the update follows the user message", () => {
    expect(mapResponsesInput(switched, { configurationUpdatePlacement: "after-user" })).toEqual([user("one"), cfg("high"), asst("r1"), user("two"), cfg("low")]);
  });

  test("never two updates side by side: the later one wins, and the decision is local (byte-stable on replay)", () => {
    const adjacent: ProviderMessageLike[] = [marker("high"), marker("low"), { role: "user", content: "summary" }, { role: "assistant", content: "r" }, marker("max"), { role: "user", content: "next" }];
    const first = mapResponsesInput(adjacent);
    expect(first).toEqual([cfg("low"), user("summary"), asst("r"), cfg("max"), user("next")]);
    // Appending a turn leaves every earlier item exactly as it was.
    const later = mapResponsesInput([...adjacent, { role: "assistant", content: "r2" }, { role: "user", content: "again" }]);
    expect(later.slice(0, first.length)).toEqual(first);
  });

  test("the top-level `reasoning.effort` is the frozen value the engine sent, whatever the updates say", () => {
    const r: TurnRequest = { model: "gpt-6-astra", messages: switched, effort: "high" };
    const body = buildResponsesBody(r, resolveReasoning(r, gpt6()), gpt6());
    expect(body["reasoning"]).toEqual({ effort: "high" });
    expect((body["input"] as unknown[]).filter((i) => (i as { type?: string }).type === "configuration_update")).toEqual([cfg("high"), cfg("low")]);
    // Never a system/developer message for effort.
    expect((body["input"] as Array<{ role?: string }>).some((i) => i.role === "system")).toBe(false);
  });

  test("the gate: a row without the item, a row recording Anthropic's beta, or a level outside the vocabulary is a typed refusal before the request", () => {
    const refuse = (row: WinterModelDescriptor, messages = switched): ProviderRequestError => {
      try {
        assertConfigurationUpdates({ model: "m", messages }, row);
      } catch (err) {
        return err as ProviderRequestError;
      }
      throw new Error("expected a refusal");
    };
    expect(refuse(descriptor({ key: "openai/gpt-5.6" })).code).toBe("capability");
    const anthropicShaped = { ...gpt6(), reasoning: { ...gpt6().reasoning!, perMessageEffort: ev({ beta: "mid-conversation-output-config-2026-07-01" as const }) } };
    expect(refuse(anthropicShaped).message).toContain("configuration_update");
    expect(refuse(gpt6(), [marker("minimal"), { role: "user", content: "x" }]).message).toContain("verified vocabulary");
    expect(() => assertConfigurationUpdates({ model: "m", messages: switched }, gpt6())).not.toThrow();
    // No marker, no gate: every row without the evidence keeps working.
    expect(() => assertConfigurationUpdates({ model: "m", messages: [{ role: "user", content: "x" }] }, descriptor())).not.toThrow();
  });
});

// --- item 4: client tool search, namespaces, additional_tools, allowed_tools ----------------------------

const searchRow = (over: { additional?: boolean; allowed?: boolean } = {}): WinterModelDescriptor => ({
  ...gpt6(),
  clientToolSearch: ev(true),
  ...(over.additional === true ? { additionalToolsItem: ev(true) } : {}),
  ...(over.allowed === true ? { allowedToolsChoice: ev(true) } : {}),
});
const fnTool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: { q: { type: "string" } } }, ...extra });
const searchTools: TurnRequest["tools"] = [
  fnTool("Bash"),
  fnTool("ToolSearch", { toolSearch: true }),
  fnTool("mcp__crm__list_orders", { deferLoading: true, namespace: "mcp__crm" }),
  fnTool("mcp__crm__get_customer", { deferLoading: true, namespace: "mcp__crm" }),
  fnTool("NotebookEdit", { deferLoading: true }),
];
const searchHistory: ProviderMessageLike[] = [
  { role: "user", content: "find the order tools" },
  { role: "assistant", content: [{ type: "tool_use", id: "ts_1", name: "ToolSearch", input: { query: "orders" } }] },
  { role: "tool", content: [{ type: "tool_result", tool_use_id: "ts_1", content: '{"matches":["mcp__crm__list_orders","NotebookEdit"]}', loadedTools: ["mcp__crm__list_orders", "NotebookEdit"] }] },
  { role: "assistant", content: [{ type: "tool_use", id: "fc_1", name: "mcp__crm__list_orders", input: { q: "open" } }] },
  { role: "tool", content: [{ type: "tool_result", tool_use_id: "fc_1", content: "3 orders" }] },
];
const body = (req: Partial<TurnRequest>, row = searchRow(), opts: { requireToolFields?: boolean } = {}) => {
  const r: TurnRequest = { model: "gpt-6-astra", messages: searchHistory, tools: searchTools, ...req };
  return buildResponsesBody(r, resolveReasoning(r, row), row, opts);
};

describe("client tool search (WS-23 midconv item 4)", () => {
  test("`tools`: ToolSearch is the native client tool_search, deferred tools are NOT declared, the rest are functions", () => {
    expect(body({})["tools"]).toEqual([
      { type: "function", name: "Bash", description: "Bash tool", parameters: { type: "object", properties: { q: { type: "string" } } }, strict: false },
      { type: "tool_search", execution: "client", description: "ToolSearch tool", parameters: { type: "object", properties: { q: { type: "string" } } } },
    ]);
  });

  test("the history: a tool_search_call (arguments as an OBJECT), a tool_search_output with the loaded definitions (defer_loading kept, MCP tools in their namespace), the listing after it, and a namespaced call by its short name", () => {
    const input = body({})["input"] as Array<Record<string, unknown>>;
    expect(input.map((i) => i["type"])).toEqual(["message", "tool_search_call", "tool_search_output", "message", "function_call", "function_call_output"]);
    expect(input[1]).toEqual({ type: "tool_search_call", call_id: "ts_1", execution: "client", status: "completed", arguments: { query: "orders" } });
    expect(input[2]).toEqual({
      type: "tool_search_output",
      call_id: "ts_1",
      execution: "client",
      status: "completed",
      tools: [
        { type: "namespace", name: "mcp__crm", description: 'Tools from the MCP server "crm".', tools: [{ type: "function", name: "list_orders", description: "mcp__crm__list_orders tool", parameters: { type: "object", properties: { q: { type: "string" } } }, strict: false, defer_loading: true }] },
        { type: "function", name: "NotebookEdit", description: "NotebookEdit tool", parameters: { type: "object", properties: { q: { type: "string" } } }, strict: false, defer_loading: true },
      ],
    });
    expect(input[3]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: '{"matches":["mcp__crm__list_orders","NotebookEdit"]}' }] });
    expect(input[4]).toEqual({ type: "function_call", call_id: "fc_1", name: "list_orders", namespace: "mcp__crm", arguments: '{"q":"open"}' });
  });

  test("the codex backend keeps its required tool trio", () => {
    const b = body({}, searchRow(), { requireToolFields: true });
    expect(b).toHaveProperty("tool_choice", "auto");
    expect(b).toHaveProperty("parallel_tool_calls", true);
  });

  test("a row WITHOUT the evidence never gets the shape: the gate refuses a deferred or tool-search tool typed", () => {
    expect(() => assertResponsesToolFeatures({ model: "m", messages: [], tools: searchTools }, gpt6())).toThrow(/clientToolSearch/);
    expect(() => assertResponsesToolFeatures({ model: "m", messages: [], tools: searchTools }, searchRow())).not.toThrow();
  });
});

describe("additional_tools and allowed_tools (WS-23 midconv addendum)", () => {
  test("a tool-change message is an `additional_tools` developer item at its own position", () => {
    const withChange: ProviderMessageLike[] = [...searchHistory.slice(0, 1), { role: "system", content: [], toolChanges: { remove: [], add: [{ type: "definition", name: "Late", description: "Late tool", inputSchema: { type: "object" } }] } }];
    const input = body({ messages: withChange }, searchRow({ additional: true }))["input"] as Array<Record<string, unknown>>;
    expect(input[1]).toEqual({ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "Late", description: "Late tool", parameters: { type: "object" }, strict: false }] });
  });

  test("`allowed_tools` restricts WITHOUT touching `tools`: the allowed functions, the native tool search, and every loaded deferred tool (namespaced ones by namespace)", () => {
    const row = searchRow({ allowed: true });
    // The engine's list names ToolSearch too; on a client-search request it is `{"type": "tool_search"}`,
    // never a function (the probe's dry run caught this).
    const restricted = body({ allowedTools: ["Bash", "ToolSearch"] }, row);
    expect(restricted["tools"]).toEqual(body({}, row)["tools"]);
    expect(restricted["tool_choice"]).toEqual({ type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "Bash" }, { type: "tool_search" }, { type: "function", name: "NotebookEdit" }, { type: "namespace", name: "mcp__crm" }] });
    expect(body({ allowedTools: ["Bash"], toolChoice: { type: "any" } }, row)["tool_choice"]).toMatchObject({ type: "allowed_tools", mode: "required" });
    // A forced choice (the classifier, structured output) outranks the restriction.
    expect(body({ allowedTools: ["Bash"], toolChoice: { type: "tool", name: "Bash" } }, row)["tool_choice"]).toEqual({ type: "function", name: "Bash" });
  });

  test("the gate: `additional_tools` and `allowed_tools` each need their own evidence; a removal item is never sent", () => {
    const change: ProviderMessageLike = { role: "system", content: [], toolChanges: { remove: [], add: [{ type: "definition", name: "Late", description: "Late tool", inputSchema: { type: "object" } }] } };
    expect(() => assertResponsesToolFeatures({ model: "m", messages: [change] }, searchRow())).toThrow(/additionalToolsItem/);
    expect(() => assertResponsesToolFeatures({ model: "m", messages: [], allowedTools: ["Bash"] }, searchRow())).toThrow(/allowedToolsChoice/);
    const removal: ProviderMessageLike = { role: "system", content: [], toolChanges: { remove: ["Bash"], add: [] } };
    expect(() => assertResponsesToolFeatures({ model: "m", messages: [removal] }, searchRow({ additional: true }))).toThrow(/allowed_tools/);
  });
});

describe("the stream: a client tool_search_call is Winter's ToolSearch; a namespaced call maps back by lookup", () => {
  const frames = (items: unknown[]): string[] => [
    JSON.stringify({ type: "response.created", response: { id: "r", model: "gpt-6-astra" } }),
    ...items.flatMap((item, i) => [JSON.stringify({ type: "response.output_item.added", output_index: i, item: { ...(item as object), arguments: typeof (item as { arguments?: unknown }).arguments === "string" ? "" : {} } }), JSON.stringify({ type: "response.output_item.done", output_index: i, item })]),
    JSON.stringify({ type: "response.completed", response: { id: "r", usage: { input_tokens: 1, output_tokens: 1 }, output: [] } }),
  ];
  const tools = responsesStreamTools({ model: "gpt-6-astra", messages: [], tools: searchTools }, searchRow());

  test("tool_search_call (client) -> one ToolSearch call with the object arguments as JSON; a namespaced function_call -> the full Winter name", () => {
    const mapper = new ResponsesStreamMapper("response.completed", "summary", tools);
    const events = frames([
      { id: "i1", type: "tool_search_call", call_id: "ts_9", execution: "client", status: "completed", arguments: { query: "crm" } },
      { id: "i2", type: "function_call", call_id: "fc_9", namespace: "mcp__crm", name: "get_customer", arguments: '{"q":"x"}' },
    ]).flatMap((d) => mapper.map(d));
    expect(events.filter((e) => e.type !== "message_start" && e.type !== "usage")).toEqual([
      { type: "tool_call_start", id: "ts_9", name: "ToolSearch" },
      { type: "tool_call_delta", id: "ts_9", argumentsJsonDelta: '{"query":"crm"}' },
      { type: "tool_call_end", id: "ts_9" },
      { type: "tool_call_start", id: "fc_9", name: "mcp__crm__get_customer" },
      { type: "tool_call_delta", id: "fc_9", argumentsJsonDelta: '{"q":"x"}' },
      { type: "tool_call_end", id: "fc_9" },
      { type: "done", stopReason: "tool_use" },
    ]);
  });

  test("a SERVER-executed tool_search_call (hosted search Winter never asks for) is still an unrepresentable call, typed", () => {
    const mapper = new ResponsesStreamMapper("response.completed", "summary", tools);
    const events = frames([{ id: "i1", type: "tool_search_call", call_id: null, execution: "server", status: "completed", arguments: { paths: ["crm"] } }]).flatMap((d) => mapper.map(d));
    expect(events.find((e) => e.type === "error")).toMatchObject({ error: { code: "capability" } });
  });
});
