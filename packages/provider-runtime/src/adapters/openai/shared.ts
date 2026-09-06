// Phase 6 Lane A — what every adapter in the OpenAI family needs, in one place.
//
// The family is five wire surfaces over two request shapes: OpenAI Responses, OpenAI Chat
// Completions, the codex-oauth port (Responses over the ChatGPT backend), local OpenAI-compatible
// servers, and Azure OpenAI (a connection-profile variant over the other two). What they share is
// everything BUT the body mapping: endpoint resolution, credentials, headers, effort and thinking
// mapping, limit rejection, `/v1/models` discovery, and the retry/observation plumbing.
//
// Four decisions that shape every file in this directory:
//
//   1. THE GENERATED ENDPOINT IS THE ADAPTER'S, THE USER ENDPOINT IS THE PROFILE'S (R6-11 / R6-L).
//      `ProviderContext` carries no descriptor, so an adapter cannot read `defaultEndpoints` to
//      learn whether an endpoint was reviewed. It therefore knows its OWN generated endpoint (a
//      construction option defaulting to the vendor URL) and treats `ConnectionProfile.baseUrl` —
//      untrusted host input — as a USER endpoint, always. That is what makes
//      `applyPrivilegedHeaders` a real gate rather than a formality: point an OpenAI connection at
//      your own proxy and `OpenAI-Organization` stops going out; point codex at one and the
//      `originator` and account id stop going out.
//
//   2. THE DESCRIPTOR REACHES `streamTurn` THROUGH A CONSTRUCTION-TIME LOOKUP. The frozen
//      `ProviderAdapter` interface hands a `WinterModelDescriptor` to `mapEffort` and
//      `capabilities` but NOT to `streamTurn` — yet WS-13 §8.2 requires effort, thinking and limit
//      rejection to happen BEFORE a request is sent. `OpenAiAdapterOptions.descriptors` is that
//      seam. It is OPTIONAL because a gateway model resolved through `allowUnlisted` genuinely has
//      no descriptor, and the two branches behave differently ON PURPOSE — see `resolveReasoning`.
//
//   3. RETRY OBSERVATIONS ARE PUMPED, NOT FLUSHED. `withRetry`'s `onRetry` is synchronous and fires
//      while the adapter's generator is suspended inside `await withRetry(...)`, so an adapter
//      cannot `yield` from it. Flushing afterwards would put every `retry` event AFTER the attempt
//      that succeeded, inverting the pinned ordering (capture (G): the frame precedes its own
//      delay). `pumpEvents` runs the work and the queue concurrently so a `retry` event is yielded
//      BEFORE the request it precedes reaches the wire — which is exactly what the fixture asserts,
//      against the fake's own request log.
//
//   4. EVERY REQUEST GOES THROUGH `boundedFetch`, NEVER `fetch`. Cancellation, header deadlines,
//      body caps, manual redirects and the no-credential-forwarding rule are all one layer down;
//      a bare `fetch` in an adapter silently opts out of all five.

import type { WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { hostHeaders } from "../privileged-headers.ts";
import { applyPrivilegedHeaders, createEndpointPolicy, type EndpointPolicy } from "../../endpoint-policy.ts";
import { ProviderRequestError, boundedFetch } from "../../http.ts";
import { normalizeHttpError, normalizeThrown } from "../../errors.ts";
import { createRetryPolicy, withRetry, type RetryPolicy, type RetryPolicyOptions } from "../../retry.ts";
import type {
  ContentBlockLike,
  CredentialMaterial,
  CredentialRef,
  CredentialStatus,
  DiscoveryContext,
  ModelCatalogResult,
  ProviderContext,
  ProviderEvent,
  ProviderMessageLike,
  TurnRequest,
} from "../../types.ts";

// --- construction options ---------------------------------------------------------------------------

/** How this surface carries a key: OpenAI-style `Authorization: Bearer`, or Azure's own `api-key` header. */
export type AuthStyle = "bearer" | "azure-api-key";

/** Looks a provider-local model id up in the catalog. See decision 2 in this file's header. */
export type DescriptorLookup = (providerLocalModelId: string) => WinterModelDescriptor | undefined;

export interface OpenAiAdapterOptions {
  /**
   * The adapter's OWN reviewed endpoint — the one `applyPrivilegedHeaders` will speak to. Defaults
   * to the family's vendor URL; overridable at CONSTRUCTION only, which is what lets a fixture point
   * a generated endpoint at a loopback fake without turning `ConnectionProfile.baseUrl` (untrusted)
   * into a privileged one.
   */
  generatedBaseUrl?: string;
  /**
   * REQUIRED — omitting it is a compile error, and that is the fail-closed mechanism (ruling on
   * finding I3).
   *
   * Nothing in this file's logic changes when a lookup is absent; what changes is that EVERY WS-13
   * §8.2 refusal quietly stops happening: an unmapped effort passes through, an over-limit request
   * is sent, a thinking config on a model with no reasoning evidence is honoured, and — worst,
   * because it is silent and remote — a DeepSeek profile stops capturing `reasoning_content` and
   * 400s on the second leg of every tool loop. None of that fails to compile, and none of it fails
   * a test that did not think to look. Requiring the field is the only guard that cannot be
   * forgotten.
   *
   * The gateway/unlisted shape is an EXPLICIT `() => undefined`: a caller saying "this model has no
   * catalog evidence" out loud, rather than a caller who forgot.
   */
  descriptors: DescriptorLookup;
  /** Injected in tests so a retry fixture never sleeps a real backoff. */
  retry?: RetryPolicyOptions;
  /** R6-L PRIVILEGED: an organisation identifier only means something at the reviewed endpoint it was minted for. */
  organization?: string;
  /** R6-L PRIVILEGED, same reasoning as `organization`. */
  project?: string;
  /** The cap on a STREAM's total bytes. Generous by design: a long generation is legitimately large. */
  maxBodyBytes?: number;
  /** Milliseconds allowed for response HEADERS. Cleared once they arrive — never a bound on the generation. */
  headerTimeoutMs?: number;
  /** How this surface carries a key. Azure's deployment path wants `api-key`; every other surface is a bearer. */
  authStyle?: AuthStyle;
}

export const DEFAULT_STREAM_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_HEADER_TIMEOUT_MS = 60_000;
/** A `/v1/models` page count that is a loop rather than a catalog. Discovery is additionally item- and time-bounded by `discoverModels`. */
export const MAX_DISCOVERY_PAGES = 20;

// --- typed refusals ---------------------------------------------------------------------------------

/** A refusal raised BEFORE any request is sent (WS-13 §8.2). `capability` is the Winter code for "this selection cannot be represented on this wire". */
export function capabilityRefusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message: reason, retryable: false });
}

/** A refusal about the request's own shape, raised before it is sent. */
export function badRequestRefusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "bad_request", message: reason, retryable: false });
}

// --- endpoint resolution ------------------------------------------------------------------------------

export interface ResolvedEndpoint {
  /** The origin+path prefix every request URL is built from. No trailing slash. */
  baseUrl: string;
  policy: EndpointPolicy;
  /** True when the base came from the ADAPTER (reviewed) rather than from `ConnectionProfile.baseUrl`. */
  generated: boolean;
}

function trimSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Chooses between the adapter's generated endpoint and the profile's user endpoint, and builds the
 * policy `boundedFetch` enforces.
 *
 * A user `baseUrl` is evaluated with `generated: false` and the profile's own `local` declaration —
 * which is what lets a loopback Ollama be reached over plain http while an undeclared private
 * address is still refused (`evaluateEndpoint`'s own rule, not a second copy of it here).
 */
export function resolveEndpoint(ctx: ProviderContext, options: OpenAiAdapterOptions, fallbackGeneratedBaseUrl?: string): ResolvedEndpoint {
  const userBase = ctx.connection.baseUrl;
  const generatedBase = options.generatedBaseUrl ?? fallbackGeneratedBaseUrl;
  if (userBase !== undefined && userBase.length > 0) {
    const built = createEndpointPolicy(userBase, { generated: false, ...(ctx.connection.local === true ? { local: true } : {}) });
    if (!built.ok) throw capabilityRefusal(built.reason);
    return { baseUrl: trimSlash(userBase), policy: built.policy, generated: false };
  }
  if (generatedBase === undefined) {
    throw capabilityRefusal(
      `provider "${ctx.connection.providerId}" has no endpoint: this adapter has no generated default, so \`connection.baseUrl\` must name the server (and \`connection.local: true\` for a local installation)`,
    );
  }
  const built = createEndpointPolicy(generatedBase, { generated: true });
  if (!built.ok) throw capabilityRefusal(built.reason);
  return { baseUrl: trimSlash(generatedBase), policy: built.policy, generated: true };
}

// --- credentials --------------------------------------------------------------------------------------

export interface ResolvedAuth {
  headers: Record<string, string>;
  /** PRIVILEGED (R6-L): the ChatGPT account this OAuth material belongs to. Routed through `applyPrivilegedHeaders`, never sent to a user endpoint. */
  accountId?: string;
  material: CredentialMaterial | null;
}

/**
 * Resolves `ctx.authRef` into request headers.
 *
 * A `null` material (a `none` ref, or a keychain slot with nothing in it) is NOT an error here: a
 * local server with `authKind: "local-none"` is a first-class configuration, and the surfaces that
 * genuinely require a credential say so themselves by refusing an empty header set.
 */
export async function resolveAuth(ctx: ProviderContext, style: AuthStyle): Promise<ResolvedAuth> {
  const material = await ctx.credentials.get(ctx.authRef);
  if (material === null) return { headers: {}, material: null };
  switch (material.kind) {
    case "api-key":
      return style === "azure-api-key" ? { headers: { "api-key": material.key }, material } : { headers: { authorization: `Bearer ${material.key}` }, material };
    case "bearer":
      // Azure Entra hands out a bearer token even on the `api-key` surface, so this arm is
      // style-independent by design (R6-A: "Entra bearer via `{ kind: \"bearer\" }`").
      return { headers: { authorization: `Bearer ${material.token}` }, material };
    case "oauth":
      return {
        headers: { authorization: `Bearer ${material.accessToken}` },
        ...(material.accountId !== undefined ? { accountId: material.accountId } : {}),
        material,
      };
    default:
      // Never interpolated: the message names the KIND, which is a locator, and nothing else.
      throw capabilityRefusal(`the OpenAI family cannot use a credential of kind "${material.kind}" — it speaks api-key, bearer and oauth only`);
  }
}

// --- headers --------------------------------------------------------------------------------------------

export interface HeaderPlan {
  policy: EndpointPolicy;
  /** Everything an endpoint needs to be spoken to at all: content-type, accept, `OpenAI-Beta`, and auth. NOT routed through `applyPrivilegedHeaders`. */
  protocol: Record<string, string>;
  /** Identifiers that only mean something at the reviewed endpoint they were minted for (R6-L). */
  privileged?: Record<string, string>;
  /** `ConnectionProfile.headers` — the host's own additions (OpenRouter's attribution pair, a proxy token's sibling header). */
  userSupplied?: Record<string, string> | undefined;
}

/**
 * Assembles a request's headers.
 *
 * ORDER IS THE POINT: user-supplied first, privileged next, protocol last, so an adapter-owned
 * header can never be displaced by a profile. And a user-supplied set is stripped of every
 * credential-bearing NAME first — a `ConnectionProfile` is non-secret connection metadata by
 * contract (WS-13 §6), so a credential appearing there is a misconfiguration to drop, not a second
 * auth channel to honour.
 */
export function buildHeaders(plan: HeaderPlan): Record<string, string> {
  // Review round 1 (B): the host's own headers go through `hostHeaders()`, the SAME filter the
  // Anthropic and Google families use, instead of only the credential-name list.
  //
  // The credential list was never wrong -- it drops `openai-organization` and `openai-project`
  // because both are in `CREDENTIAL_HEADER_NAMES`, so there was no live hole. What it was is a
  // SECOND reading of R6-L's rule, and the two disagreed on any identity name that is not
  // credential-shaped: `x-goog-quota-project` is on the privileged list and not the credential one,
  // so an OpenAI-family adapter reached through a Google-flavoured proxy would forward it on a user
  // endpoint. Routing both families through one filter is what makes R6-L's "one enforcement point
  // a reviewer can grep for" true of this family too.
  //
  // The separate credential pre-strip that used to run here is GONE (fix-wave F-3): `hostHeaders`
  // now drops `CREDENTIAL_HEADER_NAMES` itself, on a generated endpoint as well, so every family
  // gets what this family had and this file no longer keeps a second copy of the rule.
  const out: Record<string, string> = {};
  Object.assign(out, hostHeaders(plan.policy, plan.userSupplied));
  Object.assign(out, applyPrivilegedHeaders(plan.policy, plan.privileged ?? {}));
  Object.assign(out, plan.protocol);
  return out;
}

// --- effort, thinking and limits -------------------------------------------------------------------------

/** The pinned five-tier ladder (`sdk.d.ts:586`), in order. The rank is what a NUMERIC effort is snapped onto. */
export const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
export type LadderEffort = (typeof EFFORT_LADDER)[number];

/**
 * A numeric effort -> the nearest tier the MODEL verifies.
 *
 * The pin states no unit, no range and no mapping for the numeric form (derived-shapes-p6.md item
 * (c): "the answer is a documented absence", OQ-P6-2), so this is gap-filling and is disclosed. The
 * rule chosen, stated so it is auditable: the integer is a POSITION ON THE PINNED FIVE-TIER LADDER,
 * clamped to [1, 5] — so `3` means "high" on every model — and is then snapped to the nearest tier
 * this model's own `reasoning.efforts` actually lists. That keeps the number's meaning stable across
 * models (an index-into-the-model's-list reading would make `2` mean different things on a 3-tier
 * and a 5-tier model) while still never sending a value the model has not verified.
 */
export function snapNumericEffort(value: number, verified: readonly string[]): string | undefined {
  const available = EFFORT_LADDER.map((tier, index) => ({ tier, index })).filter((t) => verified.includes(t.tier));
  if (available.length === 0) return undefined;
  const clamped = Math.min(EFFORT_LADDER.length, Math.max(1, Math.round(value)));
  const wanted = clamped - 1;
  let best = available[0]!;
  for (const candidate of available) {
    // STRICTLY closer, so an EQUIDISTANT candidate never displaces the one already held — and since
    // `available` is in ladder order, a tie resolves to the LOWER tier. Deliberate: spending more
    // reasoning than the caller can be shown to have asked for is the costlier direction to guess
    // in, and the rule is disclosed with the mapping it belongs to.
    const better = Math.abs(candidate.index - wanted) < Math.abs(best.index - wanted);
    if (better) best = candidate;
  }
  return best.tier;
}

/**
 * WS-13 §8.2's rule as a function: map onto the model's VERIFIED vocabulary, or reject BEFORE the
 * request. A silent downgrade to the provider's default is prohibited, which is why every failure
 * arm returns `{ ok: false }` rather than `undefined`.
 *
 * The descriptor-less arm (a gateway model passed through by `allowUnlisted`) is deliberately
 * different rather than lax: a NAMED effort is passed through verbatim (the caller named a tier the
 * pin defines and Winter has no evidence to contradict it), while a NUMERIC one is refused, because
 * snapping a number needs a vocabulary and there is none.
 */
export function mapEffortAgainst(effort: TurnRequest["effort"], descriptor: WinterModelDescriptor | undefined): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (effort === undefined) return { ok: true, value: undefined };
  if (descriptor === undefined) {
    if (typeof effort === "number") {
      return { ok: false, reason: `a numeric effort (${effort}) cannot be mapped for an unlisted model: snapping it to the nearest verified tier needs the model's own effort vocabulary, and this model has no catalog descriptor` };
    }
    return { ok: true, value: effort };
  }
  const verified = descriptor.reasoning?.efforts ?? [];
  if (descriptor.reasoning === undefined || verified.length === 0) {
    return {
      ok: false,
      reason: `model "${descriptor.key}" declares no reasoning effort vocabulary, so effort ${JSON.stringify(effort)} cannot be mapped onto it — Winter rejects the selection rather than silently sending the provider's default (WS-13 §8.2)`,
    };
  }
  if (typeof effort === "number") {
    const snapped = snapNumericEffort(effort, verified);
    if (snapped === undefined) return { ok: false, reason: `model "${descriptor.key}" verifies no tier of the pinned effort ladder, so numeric effort ${effort} has nothing to snap to` };
    return { ok: true, value: snapped };
  }
  if (!verified.includes(effort)) {
    return { ok: false, reason: `effort "${effort}" is not in model "${descriptor.key}"'s verified vocabulary [${verified.join(", ")}] — rejected before the request (WS-13 §8.2)` };
  }
  return { ok: true, value: effort };
}

export interface ReasoningPlan {
  /** The `reasoning.effort` value, when one applies. */
  effort?: string;
  /** The `reasoning.summary` value, when the descriptor's `summaryRequest` evidence says how to ask. */
  summary?: string;
  /** True when the request should carry `include: ["reasoning.encrypted_content"]` (Responses only). */
  wantsEncryptedContent: boolean;
  /** False when `thinking: {type:"disabled"}` — no reasoning object at all. */
  enabled: boolean;
}

/**
 * Resolves `effort` + `thinking` into what the wire will carry, or throws a typed refusal.
 *
 * The two refusals worth stating, because each has a tempting silent alternative:
 *
 *   `thinking: {type:"enabled", budgetTokens: N}` is REFUSED on this family. The OpenAI surfaces
 *     have no token-budget knob for reasoning — the verified vocabulary is effort tiers — so
 *     honouring the config would mean dropping the budget and sending an effort the caller never
 *     asked for. That is precisely the silent downgrade WS-13 §8.2 prohibits.
 *
 *   `thinking: {type:"enabled"|"adaptive"}` on a model with NO reasoning evidence is REFUSED rather
 *     than ignored, for the same reason: "we quietly did not think" is not an outcome a caller can
 *     see.
 */
export function resolveReasoning(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): ReasoningPlan {
  const thinking = req.thinking;
  if (thinking?.type === "disabled") {
    if (req.effort !== undefined) {
      throw capabilityRefusal(`thinking is disabled for this turn but an effort (${JSON.stringify(req.effort)}) was also requested — the two contradict, and Winter refuses rather than picking one`);
    }
    return { wantsEncryptedContent: false, enabled: false };
  }
  if (thinking?.type === "enabled" && thinking.budgetTokens !== undefined) {
    throw capabilityRefusal(
      `thinking { type: "enabled", budgetTokens: ${thinking.budgetTokens} } cannot be represented on an OpenAI-family surface: reasoning here is EFFORT-controlled and has no token-budget field, so honouring this would mean silently dropping the budget (WS-13 §8.2)`,
    );
  }
  const reasoningEvidence = descriptor?.reasoning;
  if (thinking !== undefined && descriptor !== undefined && reasoningEvidence === undefined) {
    throw capabilityRefusal(`model "${descriptor.key}" declares no reasoning capability, so a \`thinking\` configuration cannot be honoured — rejected before the request`);
  }

  const mapped = mapEffortAgainst(req.effort, descriptor);
  if (!mapped.ok) throw capabilityRefusal(mapped.reason);

  // With no explicit effort but a thinking config that asks for reasoning, fall back to the model's
  // own declared default — a value the catalog verified, never an invented one.
  const effort = mapped.value ?? (thinking !== undefined ? reasoningEvidence?.defaultEffort : undefined);
  const reasoningRequested = effort !== undefined || thinking?.type === "adaptive" || thinking?.type === "enabled";

  // `reasoning.summary` is asked for ONLY where the descriptor's own evidence says which field and
  // which values the model accepts. Guessing a value is how a request 400s on a model that has the
  // field but not that member.
  const summaryEvidence = reasoningEvidence?.summaryRequest?.value;
  const summary =
    req.requestSummary === true && reasoningRequested && summaryEvidence !== undefined && summaryEvidence.field === "reasoning.summary" && summaryEvidence.values.length > 0
      ? summaryEvidence.values[0]
      : undefined;

  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(summary !== undefined ? { summary } : {}),
    // Codex parity, carried from Norma: encrypted continuation state is requested whenever reasoning
    // is configured, so the completed reasoning item is replayable on later `store: false` requests.
    wantsEncryptedContent: reasoningRequested,
    enabled: true,
  };
}

/**
 * WS-13 §8.2's other half: a request over the model's DECLARED limits, or naming a parameter the
 * model rejects, fails here — before a byte goes out — rather than upstream.
 */
export function assertWithinLimits(req: TurnRequest, descriptor: WinterModelDescriptor | undefined, parametersInPlay: readonly string[]): void {
  if (descriptor === undefined) return;
  const maxOutput = descriptor.maxOutputTokens?.value;
  if (req.maxOutputTokens !== undefined && maxOutput !== undefined && req.maxOutputTokens > maxOutput) {
    throw capabilityRefusal(`requested ${req.maxOutputTokens} output tokens but model "${descriptor.key}" declares a maximum of ${maxOutput} — rejected before the request rather than failed upstream`);
  }
  const unsupported = descriptor.unsupportedParameters ?? [];
  for (const parameter of parametersInPlay) {
    if (unsupported.includes(parameter)) {
      throw capabilityRefusal(`model "${descriptor.key}" lists "${parameter}" among its unsupported parameters, and this request would send it — rejected before the request (WS-13 §8.2)`);
    }
  }
}

/** The three-state tool capability plus the reasoning facts the bridge reads off an adapter. */
export function capabilitiesFrom(descriptor: WinterModelDescriptor): { toolCalling: "native" | "emulated" | "none"; continuationDomain?: string; readableState: "none" | "summary" | "full-exposed" } {
  const members = descriptor.reasoning?.continuationDomain?.value;
  const domain = descriptor.reasoning === undefined || descriptor.reasoning.continuation === "none" ? undefined : members !== undefined && members.length > 0 ? [...members].sort()[0] : descriptor.key;
  return {
    toolCalling: descriptor.toolCalling.value,
    ...(domain !== undefined ? { continuationDomain: domain } : {}),
    readableState: descriptor.reasoning?.readableState?.value ?? "none",
  };
}

// --- tools ------------------------------------------------------------------------------------------------

/**
 * A tool the adapter cannot represent is an ERROR, never a silently dropped tool (WS-13 §9's own
 * hard negative). "Cannot represent" is narrow and structural: a tool with no name, or a schema that
 * is not a JSON-Schema object, is one the provider would reject or — worse — accept while quietly
 * losing the constraint.
 */
export function assertRepresentableTools(tools: TurnRequest["tools"]): void {
  for (const tool of tools ?? []) {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw badRequestRefusal(`a tool with no name cannot be represented on an OpenAI-family surface — Winter refuses the turn rather than dropping the tool silently (WS-13 §9)`);
    }
    if (tool.inputSchema === null || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw badRequestRefusal(`tool "${tool.name}" has an input schema that is not a JSON-Schema object, so its constraints cannot be represented — Winter refuses the turn rather than dropping the tool silently (WS-13 §9)`);
    }
  }
}

// --- content helpers ----------------------------------------------------------------------------------------

/** Normalizes `string | ContentBlockLike[]` to blocks, so a mapper has one shape to walk. */
export function asBlocks(content: ProviderMessageLike["content"]): ContentBlockLike[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Flattens a `tool_result.content` (which R6-3 widened to `string | ContentBlockLike[]`) into the plain text every OpenAI surface carries. */
export function toolResultText(content: string | ContentBlockLike[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * A Winter-authored annotation -> the text that actually rides the wire (minor 11).
 *
 * BOTH DOORS RENDER AS PLAIN TEXT on this family, and that is a decision rather than a shortcut.
 * `thinking-channel` names an in-dialect reasoning slot; no OpenAI-family surface has one a caller
 * may write into, and the nearest thing (`reasoning_content`) is the MODEL's own output channel —
 * putting Winter's prose there would present an annotation as something the model reasoned, which is
 * the impersonation R6-8 exists to forbid. So the annotation is carried plainly, on both doors.
 *
 * VERBATIM — this layer adds NOTHING, not even a label. The text arrives from Lane C already
 * finished and already delimited (the `<recovered_reasoning_summary>` tag WS-13 §8.2 names for the
 * tag door, the bracketed label for the thinking-channel door), and Lane C's §9.6 budget is counted
 * on exactly these bytes. A wrapper of this layer's own would double-label the second door, would
 * add a delimiter `neutralizeDelimiters` does not neutralise (so a foreign summary containing the
 * added closing delimiter would break straight out of it), and would make this family the only one
 * that alters the string — the whole-branch review's I-3, escalated from Lane B's identical
 * `<winter-note>` wrapper. The other three families render it byte-for-byte; so does this one.
 *
 * Without this door at all, Lane C's decorations were built, persisted and then silently dropped at
 * the wire: a cross-family handoff note that never reaches the model is worse than none, because the
 * switch coordinator has already reported the context as carried.
 *
 * WHERE it goes depends on what the message carries. On an ordinary message it LEADS the content.
 * On a message carrying TOOL RESULTS it PREFIXES the first result's own text (see
 * `prefixToolResult`) — never a message of its own, because a message between an assistant's
 * `tool_calls` and its `tool` reply is rejected outright ("messages with role 'tool' must be a
 * response to a preceeding message with 'tool_calls'"). Round 3's finding: an annotation that
 * breaks the turn is worse than one that is dropped.
 */
export function decorationText(message: ProviderMessageLike): string | undefined {
  const decoration = message.decoration;
  if (decoration === undefined || decoration.text.length === 0) return undefined;
  return decoration.text;
}

/**
 * A decoration prefixed onto a tool result's own text.
 *
 * Adjacency between a tool call and its result is a WIRE INVARIANT on every surface in this family,
 * so the annotation rides INSIDE the result it annotates rather than beside it. Same verbatim text,
 * same position relative to what it describes, and no extra item on the wire at all.
 */
export function prefixToolResult(decoration: string | undefined, output: string): string {
  return decoration === undefined ? output : output.length > 0 ? `${decoration}\n${output}` : decoration;
}

/** An `image` block -> the data URL every OpenAI surface accepts. */
export function imageDataUrl(block: Extract<ContentBlockLike, { type: "image" }>): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

// --- the observation pump ------------------------------------------------------------------------------------

/**
 * A one-slot async queue for events produced by a SYNCHRONOUS callback while the generator that
 * must yield them is suspended. See decision 3 in this file's header.
 */
export class EventQueue {
  private items: ProviderEvent[] = [];
  private waker: (() => void) | undefined;

  push(event: ProviderEvent): void {
    this.items.push(event);
    this.wake();
  }

  wake(): void {
    const waker = this.waker;
    this.waker = undefined;
    waker?.();
  }

  drain(): ProviderEvent[] {
    if (this.items.length === 0) return [];
    const out = this.items;
    this.items = [];
    return out;
  }

  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waker = resolve;
    });
  }
}

/**
 * Runs `work` while yielding whatever lands on `queue`, and returns `work`'s value.
 *
 * The ordering this buys is the whole point: `withRetry` announces a retry BEFORE it sleeps, so the
 * event is queued, the pump wakes on the next microtask, and the consumer sees it before the retried
 * request reaches the wire. A post-hoc flush would report every retry after the attempt that
 * finally succeeded.
 */
export async function* pumpEvents<T>(queue: EventQueue, work: Promise<T>): AsyncGenerator<ProviderEvent, T> {
  let finished = false;
  const settled = work.then(
    (value) => {
      finished = true;
      queue.wake();
      return { ok: true as const, value };
    },
    (error: unknown) => {
      finished = true;
      queue.wake();
      return { ok: false as const, error };
    },
  );
  for (;;) {
    for (const event of queue.drain()) yield event;
    if (finished) break;
    await Promise.race([queue.wait(), settled]);
  }
  for (const event of queue.drain()) yield event;
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

// --- the request ------------------------------------------------------------------------------------------------

export interface StreamingRequestPlan {
  url: string;
  headers: Record<string, string>;
  body: string;
  policy: EndpointPolicy;
  ctx: ProviderContext;
  options: OpenAiAdapterOptions;
  signal?: AbortSignal | undefined;
  /** Called once per attempt, BEFORE the request goes out. The codex quota manager's hook. */
  beforeAttempt?: (attempt: number) => Promise<void>;
  /** Given a non-2xx response, decides whether the adapter can recover in-band (codex's one-shot token refresh). Returning a new header set retries immediately, outside the retry budget. */
  recover?: (status: number, attempt: number) => Promise<Record<string, string> | undefined>;
  /**
   * Observes the REFUSED response before its body is read, so an adapter can take a fact off the
   * headers that the normalized error does not carry onward.
   *
   * The one caller is codex's quota manager, and the reason it needs this door rather than the
   * `retry` event is finding I1: `retry.retryDelayMs` is `Retry-After` only when the backend sent
   * one, and is Winter's own jittered backoff otherwise — so reading the window off the event
   * fabricated a subscription reset time out of local jitter. This hands over the header itself,
   * present or absent.
   */
  onRefused?: (response: Response) => void;
}

/**
 * Opens a streaming POST under the retry policy, and returns the response whose body the caller will
 * consume.
 *
 * `policy.commit()` is called by the CALLER, the moment it consumes the first byte — not here.
 * Committing at header time would forbid retrying a 503 that arrived with headers and no body, and
 * committing never would allow replaying a turn whose tool call the caller already executed. The
 * first byte is the line WS-13 §13 actually draws.
 */
export async function openStream(plan: StreamingRequestPlan, policy: RetryPolicy, onEvent: (event: ProviderEvent) => void): Promise<Response> {
  const maxBodyBytes = plan.options.maxBodyBytes ?? DEFAULT_STREAM_BODY_BYTES;
  const timeoutMs = plan.options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  // HOISTED OUT OF THE ATTEMPT (minor 8): a header set recovered by `recover` (codex's refreshed
  // bearer) has to survive into the NEXT attempt. Re-reading `plan.headers` per attempt sent the
  // stale credential again, drawing a second 401 and a redundant refresh on every retry.
  let headers = plan.headers;
  return withRetry(
    async (attempt) => {
      await plan.beforeAttempt?.(attempt);
      let response = await boundedFetch(plan.url, {
        method: "POST",
        headers,
        body: plan.body,
        policy: plan.policy,
        maxBodyBytes,
        timeoutMs,
        ...(plan.signal !== undefined ? { signal: plan.signal } : {}),
      });
      if (!response.ok && plan.recover !== undefined) {
        const recovered = await plan.recover(response.status, attempt);
        if (recovered !== undefined) {
          // The refused body is drained rather than abandoned, so the connection can be reused
          // instead of being left half-read behind us.
          void response.body?.cancel().catch(() => {});
          headers = recovered;
          response = await boundedFetch(plan.url, {
            method: "POST",
            headers,
            body: plan.body,
            policy: plan.policy,
            maxBodyBytes,
            timeoutMs,
            ...(plan.signal !== undefined ? { signal: plan.signal } : {}),
          });
        }
      }
      if (!response.ok) {
        // BEFORE the body is read: `httpErrorFrom` consumes the response.
        plan.onRefused?.(response);
        throw await httpErrorFrom(response);
      }
      return response;
    },
    policy,
    onEvent,
    plan.signal,
  );
}

/** Reads an error response's body (bounded by `boundedFetch` already) and normalizes it. Never logs the body. */
export async function httpErrorFrom(response: Response): Promise<ProviderRequestError> {
  const body = await response.text().catch(() => "");
  return new ProviderRequestError(normalizeHttpError(response.status, response.headers, body));
}

/** Turns anything thrown during a turn into the `error` event the fold converts to a `ProviderTurnError`. */
export function errorEvent(err: unknown): Extract<ProviderEvent, { type: "error" }> {
  return { type: "error", error: normalizeThrown(err) };
}

export function makeRetryPolicy(options: OpenAiAdapterOptions): RetryPolicy {
  return createRetryPolicy(options.retry ?? {});
}

// --- discovery ------------------------------------------------------------------------------------------------------

interface ModelsPage {
  data?: unknown;
  has_more?: unknown;
}

/**
 * `GET {base}/models`, paged.
 *
 * BOUNDED THREE WAYS and none of them is advisory: `boundedFetch` caps the bytes of each page at
 * `ctx.limits.maxBytes`, `MAX_DISCOVERY_PAGES` caps the hops, and `ctx.limits.maxItems` caps the
 * rows. `partial: true` whenever a bound stopped the walk — the caller must never read a truncated
 * list as "these are all the models that exist" (which, for an authoritative provider, would read
 * the absent ones as removed).
 *
 * Sanitisation, dedup and malformed-row rejection are `discoverModels`'s, deliberately: this
 * function's job is to fetch honestly, and having two places decide what a valid model id is, is how
 * they drift.
 */
export async function fetchOpenAiModels(
  ctx: DiscoveryContext,
  endpoint: ResolvedEndpoint,
  headers: Record<string, string>,
  options: OpenAiAdapterOptions,
  /** Query parameters every discovery page must carry (Azure's mandatory `api-version`). */
  extraQuery: Record<string, string> = {},
): Promise<ModelCatalogResult> {
  const warnings: string[] = [];
  const models: ModelCatalogResult["models"] = [];
  let partial = false;
  let after: string | undefined;

  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const url = new URL(`${endpoint.baseUrl}/models`);
    for (const [name, value] of Object.entries(extraQuery)) url.searchParams.set(name, value);
    if (after !== undefined) url.searchParams.set("after", after);
    const response = await boundedFetch(url.toString(), {
      method: "GET",
      headers,
      policy: endpoint.policy,
      maxBodyBytes: ctx.limits.maxBytes,
      timeoutMs: options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (!response.ok) throw await httpErrorFrom(response);
    const text = await response.text();
    let payload: ModelsPage;
    try {
      payload = JSON.parse(text) as ModelsPage;
    } catch {
      throw new ProviderRequestError({ code: "bad_request", message: `model discovery for "${ctx.connection.providerId}" returned a body that is not JSON`, retryable: false });
    }
    const rows = Array.isArray(payload.data) ? payload.data : [];
    if (!Array.isArray(payload.data)) warnings.push(`discovery page ${page + 1} had no \`data\` array; it contributed no models`);
    for (const row of rows) {
      if (models.length >= ctx.limits.maxItems) {
        // DISCLOSED IN PROSE AS WELL AS BY THE FLAG. `discoverModels` warns only when the ADAPTER
        // handed it more rows than the limit; truncating here means it never sees them, so without
        // this line an item-bounded walk would carry `partial: true` and no explanation of why a
        // model the caller expected is missing — which is exactly the "absence reads as removal"
        // failure WS-13 §7 is written against.
        partial = true;
        warnings.push(`discovery returned more than the ${ctx.limits.maxItems}-model limit; the list was truncated and is PARTIAL`);
        break;
      }
      models.push(rowToModel(row));
    }
    const last = rows.at(-1);
    const lastId = last !== null && typeof last === "object" ? (last as { id?: unknown }).id : undefined;
    if (partial || payload.has_more !== true || rows.length === 0 || typeof lastId !== "string") {
      // `has_more` without a usable cursor is a page we cannot follow: reported as PARTIAL rather
      // than silently treated as the end of the list.
      if (payload.has_more === true && !partial) {
        partial = true;
        warnings.push(`discovery reported more pages but the last row carried no usable id to page from; the list is PARTIAL`);
      }
      return { models, partial, cached: false, warnings };
    }
    after = lastId;
    if (page === MAX_DISCOVERY_PAGES - 1) {
      partial = true;
      warnings.push(`discovery stopped after ${MAX_DISCOVERY_PAGES} pages; the list is PARTIAL`);
    }
  }
  return { models, partial, cached: false, warnings };
}

/** One `/v1/models` row -> the catalog-result shape. Untrusted: nothing here is interpolated anywhere, and `discoverModels` does the validation. */
export function rowToModel(row: unknown): ModelCatalogResult["models"][number] {
  if (row === null || typeof row !== "object") return { id: "" };
  const record = row as { id?: unknown; display_name?: unknown; name?: unknown; context_window?: unknown; context_length?: unknown };
  const id = typeof record.id === "string" ? record.id : "";
  const displayName = typeof record.display_name === "string" ? record.display_name : typeof record.name === "string" ? record.name : undefined;
  const contextWindow = typeof record.context_window === "number" ? record.context_window : typeof record.context_length === "number" ? record.context_length : undefined;
  return { id, ...(displayName !== undefined ? { displayName } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

/**
 * The family's shared `validateCredential`: a bounded `GET /models` with the credential attached.
 *
 * `unsupported` means the adapter cannot CHECK this ref kind — never that the credential is bad. A
 * `none` ref against a non-local endpoint is `missing`, which is the actionable answer.
 */
export async function validateViaModels(
  ref: CredentialRef,
  ctx: ProviderContext,
  endpoint: ResolvedEndpoint,
  headers: Record<string, string>,
  options: OpenAiAdapterOptions,
  hasCredential: boolean,
  /** Query parameters the probe must carry. Azure rejects EVERY call without `api-version`, so omitting it made a valid key report as unreachable. */
  extraQuery: Record<string, string> = {},
): Promise<CredentialStatus> {
  if (ref.kind === "aws-default-chain" || ref.kind === "file") {
    return { ok: false, code: "unsupported", message: `the OpenAI family cannot validate a credential reference of kind "${ref.kind}"` };
  }
  if (!hasCredential && !endpoint.policy.local) {
    return { ok: false, code: "missing", message: `no credential is configured for provider "${ctx.connection.providerId}"` };
  }
  try {
    const probeUrl = new URL(`${endpoint.baseUrl}/models`);
    for (const [name, value] of Object.entries(extraQuery)) probeUrl.searchParams.set(name, value);
    const response = await boundedFetch(probeUrl.toString(), {
      method: "GET",
      headers,
      policy: endpoint.policy,
      maxBodyBytes: 1024 * 1024,
      timeoutMs: options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS,
    });
    // The body is drained either way: an un-read response leaves a socket half-open for the rest of
    // the process, and this function is called from an interactive settings screen.
    const body = await response.text().catch(() => "");
    if (response.ok) return { ok: true };
    const normalized = normalizeHttpError(response.status, response.headers, body);
    if (normalized.code === "auth") return { ok: false, code: "invalid", message: normalized.message };
    return { ok: false, code: "network", message: normalized.message };
  } catch (err) {
    const normalized = normalizeThrown(err);
    return { ok: false, code: normalized.code === "auth" ? "invalid" : "network", message: normalized.message };
  }
}

// --- SSE payload helpers ---------------------------------------------------------------------------------------------

/** `[DONE]` is an OpenAI-family convention rather than an SSE one, so `parseSse` passes it through and the adapter recognises it here. */
export function isStreamTerminator(data: string): boolean {
  return data.trim() === "[DONE]";
}

/** Parses one SSE `data:` payload. A junk frame is tolerated (returns `undefined`) — forward compatibility, and providers do emit them. */
export function parseSseJson(data: string): Record<string, unknown> | undefined {
  const trimmed = data.trim();
  if (trimmed.length === 0 || isStreamTerminator(trimmed)) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
