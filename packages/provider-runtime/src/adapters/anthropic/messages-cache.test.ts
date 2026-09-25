// WS-23 (anthropic-cache lane): the Anthropic adapter's cache-preserving request shapes, asserted on
// the REQUEST BODY and HEADERS `prepare()` builds -- per-message effort markers, and (later items)
// deferred tools, cache breakpoints, TTL and diagnostics. Kept in its own file so the parallel
// anthropic-hardening lane's edits to `messages.test.ts` never collide with these.
import { describe, expect, test } from "bun:test";
import { ANTHROPIC_DEFAULT_BASE_URL } from "./index.ts";
import { buildHeaders, buildRequestBody, perMessageEffortBetaFor, toWireMessages, withMessageCacheMarker } from "./messages.ts";
import { ProviderRequestError } from "../../http.ts";
import { createEndpointPolicy } from "../../endpoint-policy.ts";
import type { CredentialMaterial, CredentialRef, ProviderContext, ProviderMessageLike, TurnRequest } from "../../types.ts";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { stampFamilyFields } from "@yanlinglabs/winter-provider-catalog";

const evidence = <T>(value: T) => ({ value, source: "official-doc" as const, confidence: "declared" as const });

const stampRow = (row: Omit<WinterModelDescriptor, "modelFamily" | "canonicalModelId">): WinterModelDescriptor => stampFamilyFields([row], [])[0]!;

/** Opus 5.5's real shape, plus the WS-23 evidence under test. */
const opus55 = (over: Partial<WinterModelDescriptor> = {}): WinterModelDescriptor =>
  stampRow({
    key: "anthropic/claude-opus-5-5",
    providerId: "anthropic",
    upstreamId: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    aliases: [],
    endpoints: ["chat"],
    inputModalities: evidence(["text", "image"]),
    outputModalities: evidence(["text"]),
    toolCalling: evidence("native" as const),
    nativeTools: evidence(true),
    promptCaching: evidence(true),
    unsupportedParameters: ["thinking.type.enabled", "thinking.type.disabled", "tool_choice.any", "tool_choice.tool"],
    reasoning: {
      supported: evidence(true),
      efforts: ["low", "medium", "high", "xhigh", "max"],
      continuation: "opaque-provider-state",
      effortRequest: evidence({ field: "output_config.effort" as const }),
      perMessageEffort: evidence({ beta: "mid-conversation-output-config-2026-07-01" as const }),
    },
    status: "candidate",
    ...over,
  });

/** Fable 5's real shape: effort via `output_config.effort`, but no per-message effort (a documented 400). */
const fable5 = (): WinterModelDescriptor =>
  opus55({
    key: "anthropic/claude-fable-5",
    upstreamId: "claude-fable-5",
    reasoning: { supported: evidence(true), efforts: ["low", "medium", "high", "xhigh", "max"], continuation: "opaque-provider-state", effortRequest: evidence({ field: "output_config.effort" as const }) },
  });

const noCredentials = {
  async get(_ref: CredentialRef): Promise<CredentialMaterial | null> {
    return null;
  },
  async set(): Promise<void> {},
  async delete(): Promise<void> {},
};

const ctx = (): ProviderContext => ({ connection: { providerId: "anthropic" }, credentials: noCredentials, authRef: { kind: "none" }, stallTimeoutMs: 1_000, log: () => {} });

const marker = (effort: string): ProviderMessageLike => ({ role: "system", content: [], outputConfig: { effort } });

/** Turn 1 at `high`, then an effort switch to `low` before turn 2's user message -- the documented placement. */
const switched: ProviderMessageLike[] = [
  { role: "user", content: "plan it" },
  { role: "assistant", content: "1. export 2. import" },
  marker("low"),
  { role: "user", content: "summarize" },
];

describe("per-message effort (WS-23 item 1)", () => {
  test("a system marker is its OWN wire entry between the assistant reply and the next user turn, with `output_config` and empty content", () => {
    expect(toWireMessages(switched)).toEqual([
      { role: "user", content: [{ type: "text", text: "plan it" }] },
      { role: "assistant", content: [{ type: "text", text: "1. export 2. import" }] },
      { role: "system", content: [], output_config: { effort: "low" } },
      { role: "user", content: [{ type: "text", text: "summarize" }] },
    ]);
  });

  test("a system message never merges into a neighbour, and two in a row stay two entries", () => {
    const wire = toWireMessages([
      { role: "user", content: "a" },
      { role: "system", content: "note one" },
      { role: "system", content: "note two" },
      { role: "user", content: "b" },
    ]);
    expect(wire.map((m) => m.role)).toEqual(["user", "system", "system", "user"]);
    expect(wire[1]).toEqual({ role: "system", content: [{ type: "text", text: "note one" }] });
  });

  test("the top-level effort stays what the engine sent; the switch rides ONLY the marker, and the beta header is the DOCUMENTED value", async () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: switched, effort: "high" }, opus55(), {});
    expect(body["output_config"]).toEqual({ effort: "high" });
    expect((body["messages"] as Array<Record<string, unknown>>)[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
    const beta = perMessageEffortBetaFor(body, opus55());
    expect(beta).toBe("mid-conversation-output-config-2026-07-01");
    const policy = createEndpointPolicy(ANTHROPIC_DEFAULT_BASE_URL, { generated: true });
    if (!policy.ok) throw new Error(policy.reason);
    const headers = await buildHeaders(ctx(), undefined, policy.policy, { betas: ["mid-conversation-output-config-2026-07-01"] }, true, {}, [beta!]);
    // Deduped against the host's own list: one header value, never the alias claude 2.1.282 sends.
    expect(headers["anthropic-beta"]).toBe("mid-conversation-output-config-2026-07-01");
  });

  test("no marker in the body -> no per-message beta", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], effort: "high" }, opus55(), {});
    expect(perMessageEffortBetaFor(body, opus55())).toBeUndefined();
  });

  test("a marker for a row WITHOUT `perMessageEffort` evidence (Fable 5) is a typed capability refusal, never a request", () => {
    let thrown: unknown;
    try {
      buildRequestBody({ model: "claude-fable-5", messages: switched, effort: "high" }, fable5(), {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProviderRequestError);
    expect((thrown as ProviderRequestError).code).toBe("capability");
    expect((thrown as Error).message).toContain("per-message effort");
  });

  test("a marker level outside the row's own vocabulary is refused before the request", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [...switched.slice(0, 2), marker("minimal"), switched[3]!], effort: "high" }, opus55(), {})).toThrow(/verified vocabulary/);
  });

  test("the rolling cache marker skips an effort-only message and lands on the block before it", () => {
    const wire = withMessageCacheMarker(toWireMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, marker("low")]));
    expect(wire[1]!.content[0]).toEqual({ type: "text", text: "b", cache_control: { type: "ephemeral" } });
    expect(wire[2]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
  });

  test("a token COUNT drops effort-only markers (they render nothing, and a count body carries no output_config)", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: switched, effort: "high" } as TurnRequest, opus55(), {}, "count");
    expect((body["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

// --- WS-23 item 3: a stable tool list ---------------------------------------------------------------

const tool = (name: string, deferLoading?: true) => ({ name, description: `${name} tool`, inputSchema: { type: "object" }, ...(deferLoading === true ? { deferLoading } : {}) });

describe("deferred tools and tool_reference (WS-23 item 3)", () => {
  const deferredRow = (): WinterModelDescriptor => opus55({ deferredToolLoading: evidence(true) });
  const searchResult = (loadedTools: string[]): ProviderMessageLike[] => [
    { role: "user", content: "find the notebook tool" },
    { role: "assistant", content: [{ type: "tool_use", id: "ts1", name: "ToolSearch", input: { query: "notebook" } }] },
    { role: "tool", content: [{ type: "tool_result", tool_use_id: "ts1", content: '{"matches":["NotebookEdit"]}', loadedTools }] },
  ];

  test("a deferred tool is declared with `defer_loading: true`; an eager one is not", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], tools: [tool("Bash"), tool("NotebookEdit", true)] }, deferredRow(), {});
    expect(body["tools"]).toEqual([
      { name: "Bash", description: "Bash tool", input_schema: { type: "object" } },
      { name: "NotebookEdit", description: "NotebookEdit tool", input_schema: { type: "object" }, defer_loading: true },
    ]);
  });

  test("a ToolSearch result's `loadedTools` becomes Anthropic's tool_reference blocks inside that result -- only for names declared deferred", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: searchResult(["NotebookEdit", "Bash", "Nope"]), tools: [tool("Bash"), tool("NotebookEdit", true)] }, deferredRow(), {});
    const result = (body["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[2]!.content[0]!;
    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "ts1",
      content: [{ type: "text", text: '{"matches":["NotebookEdit"]}' }, { type: "tool_reference", tool_name: "NotebookEdit" }],
    });
  });

  test("with no deferred tool in the request, the same history serialises byte-identically to before (the bookkeeping field never reaches the wire)", () => {
    const body = buildRequestBody({ model: "claude-opus-5-5", messages: searchResult(["NotebookEdit"]), tools: [tool("Bash"), tool("NotebookEdit")] }, opus55(), {});
    expect((body["messages"] as Array<{ content: unknown[] }>)[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "ts1", content: '{"matches":["NotebookEdit"]}' });
  });

  test("a claude-written `tool_reference` inside a resumed tool_result stays a reference when the tool is deferred, and becomes a legible note when it is not", () => {
    const history: ProviderMessageLike[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "ToolSearch", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "tool_reference", tool_name: "NotebookEdit" } as never] }] },
    ];
    const deferred = buildRequestBody({ model: "claude-opus-5-5", messages: history, tools: [tool("Bash"), tool("NotebookEdit", true)] }, deferredRow(), {});
    expect((deferred["messages"] as Array<{ content: Array<{ content: unknown }> }>)[2]!.content[0]!.content).toEqual([{ type: "tool_reference", tool_name: "NotebookEdit" }]);
    const plain = buildRequestBody({ model: "claude-opus-5-5", messages: history, tools: [tool("Bash"), tool("NotebookEdit")] }, opus55(), {});
    expect((plain["messages"] as Array<{ content: Array<{ content: unknown }> }>)[2]!.content[0]!.content).toEqual([{ type: "text", text: "[tools now callable: NotebookEdit]" }]);
  });

  test("a `defer_loading` tool on a row without the evidence, or a request with NO eager tool, is refused before the request", () => {
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], tools: [tool("Bash"), tool("X", true)] }, opus55(), {})).toThrow(/deferred tool loading/);
    expect(() => buildRequestBody({ model: "claude-opus-5-5", messages: [{ role: "user", content: "hi" }], tools: [tool("X", true)] }, deferredRow(), {})).toThrow(/at least one tool without `defer_loading`/);
  });
});
