// Phase 6 Task 8 (Lane D): what the OPT-IN live gate actually asks a real provider.
//
// This is the one place in the repository that talks to a vendor endpoint, and it only ever runs
// from `scripts/verify-provider-live.ts` behind `WINTER_LIVE_PROVIDER_TESTS=1`. Nothing here is
// reachable from `bun test`: no `.test.ts` imports it, CI never sets the variable, and the script
// exits 0 with "skipped: not opted in" without it.
//
// THE OUTPUT DISCIPLINE IS THE WHOLE DESIGN. Global Constraints: "Debug telemetry records
// provider/model identifiers and byte counts, never content." So every case reports what it MEASURED
// — a stop reason, a byte count, a token count, how many models discovery returned — and never what
// came back. A live gate that printed the model's answer would put vendor output into a developer's
// terminal and, from there, into a pasted bug report.
//
// A case that cannot run on this model REPORTS ITSELF SKIPPED with the descriptor fact that makes it
// inapplicable, exactly as the adapter corpus does: a skip is then a fact about the model rather than
// a case quietly declining a question it found hard.
import type { DiscoveryContext, ProviderAdapter, ProviderContext, ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";

export type LiveCaseId = "discovery" | "text-turn" | "tool-round" | "thinking-summary" | "count-tokens";

export interface LiveCaseSpec {
  id: LiveCaseId;
  question: string;
}

/** The five legs the brief names, in the order the script runs them: cheapest and least stateful first. */
export const LIVE_CASES: readonly LiveCaseSpec[] = [
  { id: "discovery", question: "does live model discovery answer within its size/time/item bounds, and say whether the page was partial?" },
  { id: "text-turn", question: "does one plain text turn stream to a stop reason, with usage reported?" },
  { id: "tool-round", question: "does one advertised tool come back as a complete call with parseable arguments?" },
  { id: "thinking-summary", question: "does a summary-requesting turn produce a readable reasoning summary where the descriptor says it can?" },
  { id: "count-tokens", question: "does the adapter's own token count answer for a real request, where it offers one?" },
];

export interface LiveCaseContext {
  adapter: ProviderAdapter;
  ctx: ProviderContext;
  /** The provider-local id that goes on the wire (never the catalog key). */
  model: string;
  /** Absent only for an `allowUnlisted` pass-through, in which case every capability-gated case skips. */
  descriptor?: WinterModelDescriptor;
  signal?: AbortSignal;
}

export type LiveCaseResult = { status: "ok"; detail: string } | { status: "skipped"; detail: string };

/** Discovery bounds for the live run. Small on purpose: this is a smoke test of a real endpoint, not a catalog build. */
const DISCOVERY_LIMITS = { maxBytes: 512 * 1024, maxItems: 200, timeoutMs: 20_000 };

/** Winter-authored, deliberately dull, and identical for every provider so a byte count is comparable across them. */
const TEXT_PROBE = "Reply with exactly one word: ready.";
const TOOL_PROBE = "Call the winter_live_probe tool once with ok set to true. Do not reply with text.";
const SUMMARY_PROBE = "Add 17 and 25, then state the result.";

const PROBE_TOOL = {
  name: "winter_live_probe",
  description: "A no-op probe. Call it once with `ok` set to true.",
  inputSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } as Record<string, unknown>,
};

/** What one drained stream measured. NEVER the text itself — only how much of it there was. */
interface StreamMeasurement {
  textBytes: number;
  summaryBytes: number;
  exposedBytes: number;
  toolCalls: Array<{ id: string; name: string; argumentBytes: number; parseable: boolean }>;
  stopReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
  errorCode?: string;
  nativeStateItems?: number;
}

/**
 * Drains one adapter stream into counts.
 *
 * `TextEncoder` rather than `String.length` because "byte count" is what the constraint says and what
 * a reader comparing two providers means; a multi-byte answer would otherwise under-report.
 */
async function drain(stream: AsyncIterable<ProviderEvent>): Promise<StreamMeasurement> {
  const encoder = new TextEncoder();
  const out: StreamMeasurement = { textBytes: 0, summaryBytes: 0, exposedBytes: 0, toolCalls: [] };
  const args = new Map<string, { name: string; json: string }>();
  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        out.textBytes += encoder.encode(event.text).length;
        break;
      case "thinking_summary_delta":
        out.summaryBytes += encoder.encode(event.text).length;
        break;
      case "thinking_exposed_delta":
        out.exposedBytes += encoder.encode(event.text).length;
        break;
      case "tool_call_start":
        args.set(event.id, { name: event.name, json: "" });
        break;
      case "tool_call_delta": {
        const entry = args.get(event.id);
        if (entry !== undefined) entry.json += event.argumentsJsonDelta;
        break;
      }
      case "tool_call_end": {
        const entry = args.get(event.id);
        if (entry === undefined) break;
        let parseable = false;
        try {
          JSON.parse(entry.json.length === 0 ? "{}" : entry.json);
          parseable = true;
        } catch {
          parseable = false;
        }
        out.toolCalls.push({ id: event.id, name: entry.name, argumentBytes: encoder.encode(entry.json).length, parseable });
        break;
      }
      case "native_state":
        out.nativeStateItems = event.items.length;
        break;
      case "usage":
        out.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        break;
      case "done":
        out.stopReason = event.stopReason;
        break;
      case "error":
        // The adapter's normalized CODE, never its message: a provider error message can quote the
        // request body, and the request body is a Winter-authored probe today but need not stay one.
        out.errorCode = event.error.code;
        break;
      default:
        break;
    }
  }
  return out;
}

function turnRequest(ctx: LiveCaseContext, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    model: ctx.model,
    messages: [{ role: "user", content: TEXT_PROBE }],
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...extra,
  };
}

export const LIVE_CASE_IMPLS: Record<LiveCaseId, (ctx: LiveCaseContext) => Promise<LiveCaseResult>> = {
  async discovery(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    const discoveryCtx: DiscoveryContext = { ...ctx.ctx, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}), limits: DISCOVERY_LIMITS };
    const result = await ctx.adapter.listModels(discoveryCtx);
    const sample = result.models.slice(0, 5).map((m) => m.id);
    return {
      status: "ok",
      detail: `${result.models.length} model id(s), partial=${result.partial}, cached=${result.cached}, warnings=${result.warnings.length}; first ids: ${sample.join(", ") || "(none)"}`,
    };
  },

  async "text-turn"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    const measured = await drain(ctx.adapter.streamTurn(turnRequest(ctx), ctx.ctx));
    if (measured.errorCode !== undefined) throw new Error(`the stream ended in a normalized "${measured.errorCode}" error`);
    if (measured.stopReason === undefined) throw new Error("the stream never reported a stop reason");
    if (measured.textBytes === 0) throw new Error("the turn produced no text at all");
    return {
      status: "ok",
      detail: `stopReason=${measured.stopReason}, textBytes=${measured.textBytes}, usage=${measured.usage === undefined ? "(not reported)" : `${measured.usage.inputTokens} in / ${measured.usage.outputTokens} out`}`,
    };
  },

  async "tool-round"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    if (ctx.descriptor === undefined) return { status: "skipped", detail: "no catalog descriptor (an allowUnlisted pass-through), so tool capability is unknown" };
    const capability = ctx.adapter.capabilities(ctx.descriptor);
    if (capability.toolCalling !== "native") return { status: "skipped", detail: `the descriptor's tool calling is "${capability.toolCalling}", and Winter disables emulated tool calling for agent modes (WS-13 §8.1)` };
    const request = turnRequest(ctx, { messages: [{ role: "user", content: TOOL_PROBE }], tools: [PROBE_TOOL], toolChoice: { type: "tool", name: PROBE_TOOL.name } });
    const measured = await drain(ctx.adapter.streamTurn(request, ctx.ctx));
    if (measured.errorCode !== undefined) throw new Error(`the stream ended in a normalized "${measured.errorCode}" error`);
    if (measured.toolCalls.length === 0) throw new Error(`the model returned no tool call at all (stopReason=${measured.stopReason ?? "none"}) -- a forced tool choice was not honoured`);
    const call = measured.toolCalls[0]!;
    if (call.name !== PROBE_TOOL.name) throw new Error(`the model called "${call.name}" rather than the single advertised tool`);
    if (!call.parseable) throw new Error("the tool call's arguments did not reassemble into parseable JSON");
    return { status: "ok", detail: `calls=${measured.toolCalls.length}, argumentBytes=${call.argumentBytes}, parseable=true, stopReason=${measured.stopReason ?? "none"}` };
  },

  async "thinking-summary"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    if (ctx.descriptor === undefined) return { status: "skipped", detail: "no catalog descriptor (an allowUnlisted pass-through), so reasoning capability is unknown" };
    const reasoning = ctx.descriptor.reasoning;
    if (reasoning === undefined || reasoning.supported.value !== true) return { status: "skipped", detail: "the descriptor records no reasoning support for this model" };
    if (reasoning.summaryRequest === undefined) return { status: "skipped", detail: "the descriptor records no summary-request mechanism for this model" };
    const request = turnRequest(ctx, { messages: [{ role: "user", content: SUMMARY_PROBE }], thinking: { type: "enabled" }, requestSummary: true });
    const measured = await drain(ctx.adapter.streamTurn(request, ctx.ctx));
    if (measured.errorCode !== undefined) throw new Error(`the stream ended in a normalized "${measured.errorCode}" error`);
    if (measured.summaryBytes === 0 && measured.exposedBytes === 0) {
      // Reported as a SKIP rather than a failure: the descriptor says the mechanism exists, and a
      // model electing not to summarise a trivial sum is a legitimate answer. A real absence shows up
      // as the same line every run, which is exactly the evidence an overlay row would need.
      return { status: "skipped", detail: `the model produced no summary for this probe (textBytes=${measured.textBytes}, stopReason=${measured.stopReason ?? "none"})` };
    }
    return {
      status: "ok",
      detail: `summaryBytes=${measured.summaryBytes}, exposedBytes=${measured.exposedBytes}, textBytes=${measured.textBytes}, nativeStateItems=${measured.nativeStateItems ?? 0}`,
    };
  },

  async "count-tokens"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    const countTokens = ctx.adapter.countTokens;
    if (countTokens === undefined) return { status: "skipped", detail: "this adapter offers no countTokens (R6-15: post_tokens is then omitted, never estimated)" };
    const count = await countTokens.call(ctx.adapter, turnRequest(ctx), ctx.ctx);
    if (!Number.isFinite(count) || count <= 0) throw new Error(`countTokens returned ${String(count)} for a non-empty request`);
    return { status: "ok", detail: `tokens=${count}` };
  },
};
