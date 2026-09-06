// Phase 6 Task 8 (Lane D): what the OPT-IN live gate actually asks a real provider.
//
// This is the one place in the repository that talks to a vendor endpoint. It runs from
// `scripts/verify-provider-live.ts` behind `WINTER_LIVE_PROVIDER_TESTS=1` plus a per-provider
// selector — `_API_KEY`, `_CREDENTIAL_REF=keychain:<account>` (an OAuth row) or `=1` (a `free`
// keyless row), the three documented third-party paths WS-13b §1 admits; without the opt-in AND one
// of those, the script prints "skipped: not opted in" and exits 0, and CI sets neither.
//
// THE CASES BELOW ARE THE SAME FOR ALL THREE KINDS, by design: what a row is asked does not depend
// on how its credential was named, and the per-target row `live/index.ts` folds them into is what
// records the kind. So a keyless row and a subscription OAuth row are held to the same three
// questions the brief names — one generation, one tool call, and `countTokens` where the adapter
// offers one — plus discovery and the reasoning summary where the descriptor says they apply.
//
// It IS also reached under `bun test`, and the honest statement of why that is safe is worth more
// than the older "no test imports it": `scripts/verify-provider-live.test.ts`'s I1 fixture spawns
// the script against a loopback fake with a scripted adapter injected through
// `WINTER_LIVE_ADAPTERS_MODULE`, precisely so the printing rule below can be proved rather than
// asserted. A fixture that drove these cases WITHOUT pinning both the endpoint and the adapter would
// reach a real provider — see `live/index.ts`'s header for that rule in full.
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
import { describeThrown } from "../corpus/classifier-safety.ts";

/**
 * A case's OWN assertion failure — the one error whose `.message` the runner prints (review round 1,
 * I1).
 *
 * The distinction is not stylistic. Every message constructed with this class is Winter-authored
 * text in this file, built from measurements: a stop reason, a byte count, a normalized error code.
 * Every OTHER error reaching the runner came from an adapter, and an adapter failure is a
 * `ProviderRequestError` whose message embeds a 200-character snippet of the provider's response
 * body (`provider-runtime/src/errors.ts`). That snippet is scrubbed of credential-shaped strings, but
 * it is still response CONTENT, and the constraint on this gate's output is verbatim: identifiers and
 * byte counts only.
 *
 * So the type IS the permission to print. A message that is safe to render is one this file wrote.
 */
export class LiveCaseAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCaseAssertionError";
  }
}

export type LiveCaseId = "discovery" | "text-turn" | "tool-round" | "thinking-summary" | "count-tokens" | "honest-identity-inference";

export interface LiveCaseSpec {
  id: LiveCaseId;
  question: string;
}

/** The legs the gate runs, in order: cheapest and least stateful first. */
export const LIVE_CASES: readonly LiveCaseSpec[] = [
  { id: "discovery", question: "does live model discovery answer within its size/time/item bounds, and say whether the page was partial?" },
  { id: "text-turn", question: "does one plain text turn stream to a stop reason, with usage reported?" },
  { id: "tool-round", question: "does one advertised tool come back as a complete call with parseable arguments?" },
  { id: "thinking-summary", question: "does a summary-requesting turn produce a readable reasoning summary where the descriptor says it can?" },
  { id: "count-tokens", question: "does the adapter's own token count answer for a real request, where it offers one?" },
  { id: "honest-identity-inference", question: "does a subscription entitlement serve a turn to Winter's OWN identity, with no vendor client header sent at all?" },
];

/**
 * The auth-shaped keys a refused inference request's body may be reported by NAME (WS-13b §4).
 *
 * AN ALLOWLIST, and it is the whole safety argument for reporting anything at all. A provider's error
 * body is content and this gate never prints it (`live/index.ts`'s rendering rule) — but when a
 * subscription bearer is refused, the ONE thing an operator needs is which auth dimension the vendor
 * says was missing, and that is a handful of named scalar fields. Anything not named here, including
 * every human-readable message, is dropped.
 *
 * `x_xai_token_auth` and `auth_kind` are the two xAI's own proxy reports (Lane O's capture); `scope`
 * and `token_auth` are the neighbouring spellings the same family uses.
 */
export const AUTH_DIMENSION_FIELDS: readonly string[] = ["auth_kind", "x_xai_token_auth", "token_auth", "scope"];

/**
 * Pulls ONLY the allowlisted auth dimensions out of an error message, as `field=value`.
 *
 * Exported for its own unit test, because "a marker elsewhere in the same body never survives" is the
 * property that makes this safe and it must be falsifiable without a vendor. Values are bounded to a
 * scalar shape (`[\w.:-]+`), so a field whose value is a sentence contributes nothing.
 */
export function authDimensionsOf(message: string): string[] {
  const found: string[] = [];
  for (const field of AUTH_DIMENSION_FIELDS) {
    // The optional quote before the separator matters: a vendor's body is JSON far more often than it
    // is a query string, and `"auth_kind":"bearer"` must match as readily as `auth_kind=bearer`.
    const match = new RegExp(`\\b${field}"?\\s*[=:]\\s*"?([\\w.:/-]+)`, "i").exec(message);
    if (match?.[1] !== undefined) found.push(`${field}=${match[1]}`);
  }
  return found;
}

/** The Winter-authored half of a refused inference report: what the operator must decide, and what Winter will not do to help them decide it. */
function renderReversion(dimensions: readonly string[]): string {
  return (
    ` -- the entitlement REFUSED a turn carrying Winter's own identity and no vendor client header. ` +
    `Auth dimensions the vendor named: ${dimensions.length === 0 ? "(none in the allowlist)" : dimensions.join(", ")}. ` +
    `If the bearer is valid and unexpired, this is WS-13b §4's reversion condition on the inference path: an honest unregistered agent identity ` +
    `the vendor rejects is a partner allowlist in fact, and the row reverts to impersonation-required. ` +
    `Winter did NOT retry with the product's client header and never will — that would be the impersonation D21 excludes. ` +
    `Turn the row off without a release by setting providers["xai-oauth"].enabled to false in settings.`
  );
}

export interface LiveCaseContext {
  adapter: ProviderAdapter;
  ctx: ProviderContext;
  /** The provider-local id that goes on the wire (never the catalog key). */
  model: string;
  /** Absent only for an `allowUnlisted` pass-through, in which case every capability-gated case skips. */
  descriptor?: WinterModelDescriptor;
  /**
   * The PROVIDER row's pricing basis (WS-13b §1) — a provider fact, which is why it does not come off
   * the model descriptor. The inference-path reversion case is about an entitlement, and
   * `subscription` is what "an entitlement rather than a key" means in catalog terms.
   */
  pricingBasis?: "token" | "subscription" | "free";
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
  errorStatus?: number;
  /**
   * The normalized error's MESSAGE, held ONLY so `authDimensionsOf` can be run over it.
   *
   * It is response content and no case may render it. Every use of this field in this file goes
   * through the allowlist; nothing formats it, concatenates it, or passes it to a `LiveCaseResult`.
   */
  errorMessage?: string;
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
        // The adapter's normalized CODE is the only part any case RENDERS: a provider error message
        // can quote the request body, and the request body is a Winter-authored probe today but need
        // not stay one. The status and message are carried for the auth-dimension allowlist alone.
        out.errorCode = event.error.code;
        if (event.error.status !== undefined) out.errorStatus = event.error.status;
        out.errorMessage = event.error.message;
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
    if (measured.errorCode !== undefined) throw new LiveCaseAssertionError(`the stream ended in a normalized "${measured.errorCode}" error`);
    if (measured.stopReason === undefined) throw new LiveCaseAssertionError("the stream never reported a stop reason");
    if (measured.textBytes === 0) throw new LiveCaseAssertionError("the turn produced no text at all");
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
    if (measured.errorCode !== undefined) throw new LiveCaseAssertionError(`the stream ended in a normalized "${measured.errorCode}" error`);
    if (measured.toolCalls.length === 0) throw new LiveCaseAssertionError(`the model returned no tool call at all (stopReason=${measured.stopReason ?? "none"}) -- a forced tool choice was not honoured`);
    const call = measured.toolCalls[0]!;
    // The called name is MODEL-AUTHORED, so it is reported by LENGTH rather than reproduced (review
    // round 1, I1): this string reaches an operator's terminal, and the constraint is identifiers and
    // byte counts only. Which tool was advertised is not in question -- exactly one was.
    if (call.name !== PROBE_TOOL.name) throw new LiveCaseAssertionError(`the model called some other tool, whose name is ${call.name.length} characters, rather than the single advertised one`);
    if (!call.parseable) throw new LiveCaseAssertionError("the tool call's arguments did not reassemble into parseable JSON");
    return { status: "ok", detail: `calls=${measured.toolCalls.length}, argumentBytes=${call.argumentBytes}, parseable=true, stopReason=${measured.stopReason ?? "none"}` };
  },

  async "thinking-summary"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    if (ctx.descriptor === undefined) return { status: "skipped", detail: "no catalog descriptor (an allowUnlisted pass-through), so reasoning capability is unknown" };
    const reasoning = ctx.descriptor.reasoning;
    if (reasoning === undefined || reasoning.supported.value !== true) return { status: "skipped", detail: "the descriptor records no reasoning support for this model" };
    if (reasoning.summaryRequest === undefined) return { status: "skipped", detail: "the descriptor records no summary-request mechanism for this model" };
    const request = turnRequest(ctx, { messages: [{ role: "user", content: SUMMARY_PROBE }], thinking: { type: "enabled" }, requestSummary: true });
    const measured = await drain(ctx.adapter.streamTurn(request, ctx.ctx));
    if (measured.errorCode !== undefined) throw new LiveCaseAssertionError(`the stream ended in a normalized "${measured.errorCode}" error`);
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

  /**
   * WS-13b §4's REVERSION CONDITION, on the inference path.
   *
   * The login-side half of the condition already ships (`xai-oauth.ts`: a device flow refused with
   * `access_denied` may be the vendor rejecting Winter's honest `referrer`). This is the other half,
   * and it is the one only a live run can answer: given a VALID subscription bearer, does the
   * vendor's inference endpoint serve a turn to a client sending Winter's own user-agent and NONE of
   * the product's client headers?
   *
   *   200 + a stop reason -> promotable evidence. The honest identity is sufficient.
   *   401/403            -> the reversion condition may have fired: an honest unregistered agent
   *                         identity the vendor rejects is a partner allowlist in fact, and the row
   *                         reverts to impersonation-required.
   *
   * WINTER NEVER SENDS THE VENDOR HEADER, INCLUDING TO PROVE THE POINT (D21). A "retry with
   * `X-XAI-Token-Auth` and see if it clears" branch would be Winter impersonating a product for the
   * length of one request, and a gate that did it once would be a gate someone later runs by habit.
   * What this case does instead is report the AUTH DIMENSIONS the vendor's own refusal names, by
   * allowlisted field, so a human has the evidence to decide — and the decision, per the ruling, is
   * a human's.
   *
   * Gated on `pricingBasis === "subscription"`, which is what "an entitlement rather than a key"
   * means in catalog terms; every other row skips with that fact.
   */
  async "honest-identity-inference"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    if (ctx.descriptor === undefined) return { status: "skipped", detail: "no catalog descriptor (an allowUnlisted pass-through), so the row's pricing basis is unknown" };
    if (ctx.pricingBasis !== "subscription") {
      return { status: "skipped", detail: `the row's pricingBasis is "${ctx.pricingBasis ?? "unknown"}"; the inference-path reversion condition is about a subscription entitlement (WS-13b §4)` };
    }
    let measured: StreamMeasurement;
    try {
      measured = await drain(ctx.adapter.streamTurn(turnRequest(ctx), ctx.ctx));
    } catch (err) {
      // An adapter that THREW rather than emitting an error event. Same treatment: identity from the
      // fields, dimensions from the allowlist, and not one byte of the message itself.
      const message = err instanceof Error ? err.message : "";
      throw new LiveCaseAssertionError(`${describeThrown(err)}${renderReversion(authDimensionsOf(message))}`);
    }
    if (measured.errorCode !== undefined) {
      const dimensions = authDimensionsOf(measured.errorMessage ?? "");
      const identity = `code=${measured.errorCode}${measured.errorStatus === undefined ? "" : ` status=${measured.errorStatus}`}`;
      if (measured.errorCode !== "auth") throw new LiveCaseAssertionError(`the turn failed for a non-auth reason (${identity}), so it is evidence about the endpoint rather than about Winter's identity`);
      throw new LiveCaseAssertionError(`${identity}${renderReversion(dimensions)}`);
    }
    if (measured.stopReason === undefined) throw new LiveCaseAssertionError("the stream never reported a stop reason, so neither reading of the reversion condition is supported");
    return {
      status: "ok",
      detail:
        `PROMOTABLE: the entitlement served a turn to Winter's own identity with NO vendor client header sent ` +
        `(stopReason=${measured.stopReason}, textBytes=${measured.textBytes}). The reversion condition did not fire.`,
    };
  },

  async "count-tokens"(ctx: LiveCaseContext): Promise<LiveCaseResult> {
    const countTokens = ctx.adapter.countTokens;
    if (countTokens === undefined) return { status: "skipped", detail: "this adapter offers no countTokens (R6-15: post_tokens is then omitted, never estimated)" };
    const count = await countTokens.call(ctx.adapter, turnRequest(ctx), ctx.ctx);
    if (!Number.isFinite(count) || count <= 0) throw new LiveCaseAssertionError(`countTokens returned ${String(count)} for a non-empty request`);
    return { status: "ok", detail: `tokens=${count}` };
  },
};
