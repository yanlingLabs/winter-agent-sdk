// Phase 6 Task 6 (Lane B): the Anthropic Messages adapter -- `anthropic-messages@1`.
//
// ADDED under `adapters/anthropic/` (R6-12). It touches nothing frozen: `boundedFetch`, `parseSse`,
// `withRetry`, `normalizeHttpError`, `createEndpointPolicy` and `applyPrivilegedHeaders` are Task 2's
// core and this adapter's ONLY doors to the network, to retries and to error normalization.
//
// FIVE DECISIONS THAT LOOK OPTIONAL AND ARE NOT:
//
//   1. **The capability checks run BEFORE the request, not after it fails upstream.** WS-13 §8.2 and
//      the lane's own constraint ("unsupported effort/thinking is rejected BEFORE the request with a
//      typed error") mean an unverified effort, an unsupported thinking arm, a tool set a model
//      cannot call natively, an image a model cannot see, or a thinking budget that does not fit
//      inside `max_tokens` all fail with a typed `capability` error and ZERO requests on the wire --
//      or, where the row's OWN evidence says how claude itself resolves the mismatch (`enabled`/
//      `disabled` on a row that rejects that exact arm, 2026-09-25), the request is REWRITTEN instead
//      of refused (`buildThinking`); `adaptive` on a row that rejects it still refuses, since no
//      rewrite for that arm is evidenced anywhere.
//      A fixture asserts `fake.requests` is empty for each refusal -- which is the only assertion that
//      can tell "rejected before" from "rejected after".
//
//   2. **The adapter reads its model's descriptor from the CATALOG, not from `ProviderContext`.**
//      `ProviderAdapter.mapEffort(effort, model)` takes a descriptor, but `streamTurn(req, ctx)` has
//      no way to see one -- and `mapEffort` has no production caller anywhere in the repo (verified
//      by grep). So a pre-request check that depended on someone else calling `mapEffort` would
//      never run. The factory takes an optional `catalog` (defaulting to the compiled one) and looks
//      the descriptor up by `ctx.connection.providerId` + `req.model`; `mapEffort` stays the public,
//      descriptor-taking seam and delegates to the same function, so the two can never disagree.
//
//   3. **In-dialect thinking is captured at `content_block_stop` and NOWHERE else.** A `thinking`
//      block's `signature_delta` arrives last inside its own block, so a block emitted at
//      `content_block_start` (or on its first delta) would carry no signature -- and R6-8's whole
//      point is that the REAL signature rides in-dialect. A stream that drops mid-block therefore
//      yields no `native_thinking_block` at all, which is the completion-event rule stated as
//      behaviour.
//
//   4. **Anthropic thinking is never a `thinking_summary_delta`.** That event is for FOREIGN
//      reasoning a Winter-only frame carries (R6-8). Anthropic's own thinking blocks are in-dialect:
//      they ride `native_thinking_block`, become `ContentBlock`s the engine persists, and are
//      replayed byte-identically. `requestSummary` therefore only sets the descriptor's own
//      `thinking.display` field -- it never re-routes the reasoning to another channel.
//
//   5. **Retry stops at the first byte, and the retry OBSERVATIONS still reach the consumer.**
//      `withRetry` wraps only the fetch; `parseSse` runs outside it, so nothing past the first byte
//      can be replayed (WS-13 §13). `withRetry`'s callback cannot `yield`, so its events are
//      buffered and flushed ahead of the first stream event -- the same order a consumer would have
//      seen, since every retry precedes the stream by construction.
import type { WinterCatalog, WinterModelDescriptor } from "@yanlinglabs/winter-provider-catalog";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { boundedFetch, ProviderRequestError } from "../../http.ts";
import { normalizeHttpError, normalizeThrown } from "../../errors.ts";
import { createRetryPolicy, withRetry, type RetryPolicyOptions } from "../../retry.ts";
import { applyPrivilegedHeaders, connectionEndpointOptions, createEndpointPolicy, type EndpointPolicy } from "../../endpoint-policy.ts";
import { hostHeaders } from "../privileged-headers.ts";
import { identityHeaderLookup, winterIdentityHeaders, winterUserAgent, type IdentityHeaderLookup } from "../../identity.ts";
import { THINKING_ENABLED_NEEDS_BUDGET } from "../refusals.ts";
import { containsImage } from "../content-blocks.ts";
import { parseSse } from "../../sse.ts";
import { ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT, ANTHROPIC_CONSOLE_PROVIDER_ID, CONSOLE_BEARER } from "./console-oauth.ts";
import type {
  ContentBlockLike,
  CredentialMaterial,
  CredentialRef,
  CredentialStatus,
  DiscoveryContext,
  ModelCatalogResult,
  ProviderAdapter,
  ProviderContext,
  ProviderError,
  ProviderEvent,
  ProviderMessageLike,
  TurnRequest,
} from "../../types.ts";

/** The provider id this adapter is registered for, and the catalog's own `adapterId` for it. */
export const ANTHROPIC_ADAPTER_ID = "winter.anthropic-messages";
/** The GENERATED endpoint. Immutable (R6-11); a user override rides `ConnectionProfile.baseUrl`. Pinned to the catalog row by a test. */
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The `anthropic-version` header every request carries. A protocol header, never a privileged one (R6-L). */
export const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * The wire `max_tokens` when neither the request nor the descriptor names one.
 *
 * DISCLOSED GAP-FILL: `max_tokens` is mandatory on this endpoint, `streamTurn` receives no
 * descriptor guarantee, and the seed catalog carries no `maxOutputTokens` evidence for either
 * Anthropic row. Capture (F) observed the pinned runtime sending 64000 for `claude-sonnet-5`, but
 * that is one model's ceiling and inventing it for every model would be a capability claim with no
 * evidence behind it. 4096 is the value the family's own documentation has used as the conservative
 * default for as long as the endpoint has existed; a host that wants more sets
 * `TurnRequest.maxOutputTokens` or the descriptor carries `maxOutputTokens` evidence.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/**
 * The effort -> thinking-budget ladder.
 *
 * WINTER-AUTHORED AND DISCLOSED. The pin states no unit, no range and no mapping for effort
 * (derived-shapes-p6.md item (c): "the answer is a documented absence", OQ-P6-2), and at the time this
 * ladder was written the Messages endpoint declared no `effort` field at all -- the only reasoning
 * dial it exposed was the `thinking` budget, and the pin's own `maxThinkingTokens` deprecation note is
 * explicit that the two are the same knob. So effort mapped onto a budget, and the ladder doubles per
 * tier from a 4k floor. It is a gap-fill rather than a divergence, and `mapEffort` refuses any tier
 * the MODEL'S OWN `reasoning.efforts` does not list, so the ladder can never invent a capability.
 *
 * THIS IS NO LONGER THE ONLY DIAL (2026-09-25): Anthropic's `output_config.effort` is now GA
 * (https://platform.claude.com/docs/en/build-with-claude/effort). A row that documents it
 * (`reasoning.effortRequest`) sends the tier there instead and this ladder is NOT consulted at all --
 * see `mapAnthropicEffort`. The ladder survives as the fallback for a row with no such evidence, and
 * as the COMPOSING partner on a row that documents `output_config.effort` but also rejects adaptive
 * thinking (Opus 4.5's `enabled`-only shape), where the vendor's effort page has the tier and the
 * budget riding together.
 */
const EFFORT_BUDGET_TOKENS: Readonly<Record<string, number>> = {
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 32_768,
  max: 65_536,
};

export interface AnthropicAdapterOptions {
  /** The catalog the descriptor is looked up in. Defaults to the compiled one; injected in tests so a fixture owns its own rows. */
  catalog?: WinterCatalog;
  /** Milliseconds allowed for RESPONSE HEADERS. Not a bound on the generation -- mid-stream silence is `ctx.stallTimeoutMs`'s job. */
  requestTimeoutMs?: number;
  maxBodyBytes?: number;
  /** Injected for deterministic retry fixtures (no real sleeping, no real jitter). */
  retry?: RetryPolicyOptions;
  /** `anthropic-beta` values, joined with commas. A PROTOCOL header (R6-L): every endpoint needs it to be spoken to, and it names no account. */
  betas?: string[];
  defaultMaxOutputTokens?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Discovery reads a JSON page, not a generation: its own byte bound comes from `DiscoveryContext.limits`. */
const MAX_DISCOVERY_PAGES = 10;

// --- wire serialization ---------------------------------------------------------------------------

/** A capability refusal, raised BEFORE any request reaches the network. Never retryable: no amount of backoff makes a model gain a capability. */
function capabilityRefusal(reason: string): ProviderRequestError {
  return new ProviderRequestError({ code: "capability", message: reason, retryable: false });
}

/**
 * One engine content block -> one wire block.
 *
 * `thinking` and `redacted_thinking` pass through VERBATIM -- signature and opaque data intact --
 * because that is what "Anthropic-family blocks ride in-dialect with their real signatures" (R6-8)
 * means at the only place it can be enforced. Nothing here strips, re-signs or normalizes them.
 */
/**
 * WS-23: the names a request may reference with `tool_reference` -- the tools it declares with
 * `defer_loading: true`. A reference to anything else is not expandable ("Every tool referenced must
 * have a corresponding tool definition in the top-level `tools` parameter", and an undeclared name is a
 * 400 `tool_reference_unresolved`), so it is never sent.
 */
type Referable = ReadonlySet<string>;
const NOTHING_REFERABLE: Referable = new Set();

/** The wire `tool_reference` block for each referable name, in order, deduplicated. */
function toolReferences(names: readonly string[], referable: Referable): Record<string, unknown>[] {
  return [...new Set(names)].filter((name) => referable.has(name)).map((name) => ({ type: "tool_reference", tool_name: name }));
}

/** A `tool_reference` block's names, in either spelling: Winter's streaming `tool_names[]` or claude's own `tool_name` (a claude-written transcript on resume). */
function referenceNames(block: Record<string, unknown>): string[] {
  if (Array.isArray(block["tool_names"])) return (block["tool_names"] as unknown[]).filter((n): n is string => typeof n === "string");
  return typeof block["tool_name"] === "string" ? [block["tool_name"]] : [];
}

function toWireBlocks(block: ContentBlockLike, referable: Referable): Record<string, unknown>[] {
  if (block.type !== "tool_reference") return [toWireBlock(block, referable)];
  // WS-23: no longer a refusal. A `tool_reference` whose tool this request declares deferred is
  // Anthropic's own block and goes on the wire as one per name; anything else (a claude-written
  // transcript resumed on a row without the evidence, or a tool no longer deferred) degrades to the
  // same legible note every other serializer in this repo writes for it, never to a silent drop.
  const names = referenceNames(block as unknown as Record<string, unknown>);
  const wire = toolReferences(names, referable);
  const rest = names.filter((name) => !referable.has(name));
  return [...wire, ...(rest.length > 0 ? [{ type: "text", text: `[tools now callable: ${rest.join(", ")}]` }] : [])];
}

function toWireBlock(block: ContentBlockLike, referable: Referable = NOTHING_REFERABLE): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", source: { type: block.source.type, media_type: block.source.media_type, data: block.source.data } };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "thinking":
      // VERBATIM, both fields. A signature-stripped replay is exactly the failure R6-8 forbids.
      return { type: "thinking", thinking: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_result": {
      // WS-23: a ToolSearch result's `loadedTools` becomes Anthropic's `tool_reference` blocks inside
      // this result -- the documented "custom tool search implementation"
      // (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) -- so the API
      // expands the deferred definitions in place and `tools` never changes. Only for names this
      // request declares deferred; with none, the result is byte-identical to before.
      const rawLoaded = block["loadedTools"];
      const loaded = Array.isArray(rawLoaded) ? rawLoaded.filter((n): n is string => typeof n === "string") : [];
      const references = toolReferences(loaded, referable);
      const inner = Array.isArray(block.content) ? block.content.flatMap((b) => toWireBlocks(b, referable)) : block.content;
      const content = references.length === 0 ? inner : [...(typeof inner === "string" ? (inner.length > 0 ? [{ type: "text", text: inner }] : []) : inner), ...references];
      // Winter's provisional markers (`interrupted`/`denied`/`deferred`/`loadFirst`) are BOOKKEEPING,
      // not wire fields: the result's own content already carries what the model needs to read. Only
      // `error` has a wire counterpart, and dropping it would tell the model a failed call succeeded.
      // Spawn-surface parity (R-S4): a REAL executor error arrives as the block's own `is_error`
      // (engine.ts) -- the same wire field, so either spelling maps to it.
      const isError = (block as { error?: unknown }).error === true || (block as { is_error?: unknown }).is_error === true;
      return { type: "tool_result", tool_use_id: block.tool_use_id, content, ...(isError ? { is_error: true } : {}) };
    }
    case "tool_reference":
      // Reached only through `toWireBlocks`, which expands a reference into one block per name.
      return toWireBlocks(block, referable)[0] ?? { type: "text", text: "[tools now callable]" };
  }
}

function normalizeContent(content: string | ContentBlockLike[], referable: Referable = NOTHING_REFERABLE): Record<string, unknown>[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  return content.flatMap((block) => toWireBlocks(block, referable));
}

/**
 * Engine messages -> wire messages.
 *
 * TWO transformations, both dialect facts rather than conveniences:
 *   - `role: "tool"` becomes a `user` message. The engine keeps tool results on their own role for
 *     unambiguous accumulation (engine.ts says so); the wire has no tool role at all.
 *   - ADJACENT same-role messages are MERGED. After the first transformation a turn reads
 *     user / assistant / user / assistant, but a history with two consecutive tool messages (or a
 *     host that supplied two user turns) would otherwise produce consecutive same-role messages,
 *     which this endpoint rejects. Merging preserves block ORDER exactly, which is what the replay
 *     rule cares about.
 */
/**
 * One merged wire entry, kept as BUCKETS until it is assembled.
 *
 * The buckets exist because both ordering rules this dialect imposes are properties of the ASSEMBLED
 * ENTRY, not of any one message -- and adjacent same-role messages merge into one entry. Rendering a
 * decoration into its own message's block list and then concatenating produced
 * `[tool_result_1, text, tool_result_2]` for two consecutive tool messages where the first was
 * decorated: correct per message, wire-invalid once merged.
 */
interface WireEntryBuckets {
  role: "user" | "assistant" | "system";
  /** WS-23: a `system` entry's own `output_config` (the per-message effort change). Never set on another role. */
  outputConfig?: { effort: string };
  /** `tool_result` blocks. This endpoint requires them at the START of the turn they ride. */
  results: Record<string, unknown>[];
  /** The LEADING run of in-dialect thinking blocks. With thinking enabled, no text may precede them. */
  leading: Record<string, unknown>[];
  /** Winter-authored decoration text, in message order -- after both hard constraints, before ordinary content. */
  decorations: Record<string, unknown>[];
  rest: Record<string, unknown>[];
}

function isThinkingBlock(block: Record<string, unknown>): boolean {
  return block["type"] === "thinking" || block["type"] === "redacted_thinking";
}

/** Files one message's rendered blocks into the entry's buckets, preserving order within each. */
function fileBlocks(entry: WireEntryBuckets, blocks: Record<string, unknown>[]): void {
  const nonResults: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block["type"] === "tool_result") entry.results.push(block);
    else nonResults.push(block);
  }
  let at = 0;
  // Only the LEADING run is hoisted: a thinking block that genuinely follows text stays where the
  // model put it, because moving it would rewrite the turn rather than order it.
  while (at < nonResults.length && isThinkingBlock(nonResults[at]!)) entry.leading.push(nonResults[at++]!);
  for (; at < nonResults.length; at++) entry.rest.push(nonResults[at]!);
}

/** One wire message. `output_config` rides only on a `system` entry (WS-23's per-message effort). */
export type WireMessage = { role: "user" | "assistant" | "system"; content: Record<string, unknown>[]; output_config?: { effort: string } };

export function toWireMessages(messages: ProviderMessageLike[], opts: { referableTools?: ReadonlySet<string> } = {}): WireMessage[] {
  const referable = opts.referableTools ?? NOTHING_REFERABLE;
  const entries: WireEntryBuckets[] = [];
  for (const message of messages) {
    const role: WireEntryBuckets["role"] = message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user";
    const own = normalizeContent(message.content, referable);
    // WS-23: a `system` message is its OWN wire entry, never merged into a neighbour and never merged
    // with another `system` message either. An effort-only marker has no content at all and is still
    // sent -- its `output_config` IS the message
    // (https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta).
    // Merging one into the user turn after it (the pre-WS-23 `role !== "assistant"` rule) would have
    // turned an operator instruction into user text and dropped the effort change entirely.
    if (role === "system") {
      if (own.length === 0 && message.outputConfig === undefined) continue;
      entries.push({ role, ...(message.outputConfig !== undefined ? { outputConfig: { effort: message.outputConfig.effort } } : {}), results: [], leading: [], decorations: [], rest: own });
      continue;
    }
    if (own.length === 0 && message.decoration === undefined) continue;

    const last = entries[entries.length - 1];
    const entry = last !== undefined && last.role === role ? last : { role, results: [], leading: [], decorations: [], rest: [] };
    if (entry !== last) entries.push(entry);

    fileBlocks(entry, own);
    // A Winter-authored annotation rides PLAINLY (R6-3 / R6-8), and its text goes on the wire
    // VERBATIM. `decoration.text` is already the FINISHED, DELIMITED string Lane C produced -- the
    // `<recovered_reasoning kind=… provider=… model=…>` tag WS-13 §8.2 names for the tag door, or
    // the `[prior-model reasoning, carried as data — …]` label for the thinking-channel door -- and
    // the §9.6 budget is counted on that finished text.
    //
    // AN EXTRA WRAPPER HERE WAS WRONG THREE WAYS and none of them is cosmetic: it double-labels the
    // thinking-channel door, it puts a delimiter on the wire that WS-13 does not name, and -- the
    // one that matters -- Lane C's `neutralizeDelimiters` neutralises only its OWN tag, so a foreign
    // summary containing this layer's closing delimiter would break straight out of it. A wrapper
    // nobody neutralises is an injection hole; the only safe delimiter is the one whose producer
    // also neutralises it.
    if (message.decoration !== undefined) entry.decorations.push({ type: "text", text: message.decoration.text });
  }

  // ASSEMBLED PER ENTRY, after every message that merges into it has been filed. Both hard
  // constraints first -- `tool_result` blocks at the start of their turn, in-dialect thinking ahead
  // of any text -- then the decorations in message order, then ordinary content.
  return entries
    .map((entry): WireMessage => ({
      role: entry.role,
      content: [...entry.results, ...entry.leading, ...entry.decorations, ...entry.rest],
      ...(entry.outputConfig !== undefined ? { output_config: entry.outputConfig } : {}),
    }))
    .filter((entry) => entry.content.length > 0 || entry.output_config !== undefined);
}

// --- prompt caching (0.0.16 request layout) -------------------------------------------------------
//
// claude 0.3.250 marks prompt-cache breakpoints in two places, and this adapter mirrors both:
//   - SYSTEM: the prompt goes as text blocks, and every block whose cache scope is not `null` carries
//     `cache_control: {type: "ephemeral"}`.
//   - MESSAGES: the LAST message's LAST content block carries the same marker (claude's
//     `addCacheBreakpoints` on the final message), so the byte-stable conversation prefix -- the
//     index-0 context, the persisted attachments, every earlier turn -- is read from cache.
//
// `scope: "global"` is NOT sent. claude adds it only when its own first-party global-cache beta is
// negotiated (its `Tce()` gate); without that beta the pinned binary itself sends a plain
// `{type: "ephemeral"}` on both blocks (captured against a loopback endpoint), which is what this
// adapter sends. Disclosed deviation: Winter does not negotiate that beta.
//
// OPT-IN BY SHAPE: only a request carrying `systemBlocks` (the engine's 0.0.16 layout) is marked,
// AND only for a model whose row DECLARES `promptCaching: true`.
//
// Fix wave (I3, whole-branch review): this used to read `descriptor?.promptCaching?.value !== false`,
// which treats an UNDECLARED row (`descriptor` absent entirely, or present with no `promptCaching`
// evidence at all) the same as an explicit `true` -- opt-OUT by shape, not opt-in. That is wrong for
// every one of the Anthropic-DIALECT sibling providers (a proxy/reseller that never ran the evidence
// capture this catalog field requires) and for `allowUnlisted` passthrough, both of which reach this
// adapter with `descriptor` undefined or promptCaching-silent and got array-shaped, `cache_control`-
// marked `system` blocks they never declared support for. `=== true` requires the row to say so.
export function promptCachingLayout(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): boolean {
  if (req.systemBlocks === undefined) return false;
  return descriptor?.promptCaching?.value === true;
}

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

/** `systemBlocks` -> the wire `system` array, cache-marked per block scope. Empty blocks are dropped (claude's `filter(Boolean)`). */
export function toWireSystemBlocks(blocks: readonly { text: string; cacheScope: "global" | "org" | null }[]): Record<string, unknown>[] {
  return blocks
    .filter((block) => block.text.length > 0)
    .map((block) => ({ type: "text", text: block.text, ...(block.cacheScope !== null ? { cache_control: { ...EPHEMERAL_CACHE_CONTROL } } : {}) }));
}

/** Anthropic's own ceiling on `cache_control` breakpoints per request (https://platform.claude.com/docs/en/build-with-claude/prompt-caching). */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * WS-23: how many block POSITIONS a request may add after the previous request's write before the
 * rolling breakpoint alone stops finding it. The API "checks at most 20 positions per breakpoint,
 * counting the breakpoint itself", and "a run of consecutive `tool_use` blocks counts as one position,
 * and so does a run of consecutive `tool_result` blocks"
 * (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, "The lookback window is 20
 * blocks"). 15 leaves margin for a count that disagrees with the server's by a block or two.
 */
export const LOOKBACK_MARGIN_POSITIONS = 15;

/** Where a breakpoint can go: message `m`'s block `b`. */
interface BlockAt {
  m: number;
  b: number;
}

/**
 * The last block in `messages[0..end)` a breakpoint may carry: the last block of the last
 * CONTENT-BEARING message. An effort-only `system` marker has no content and is skipped -- it renders
 * nothing at its position (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages#limitations).
 * An in-dialect thinking block cannot carry a marker; claude never ends a request on one either (the
 * final message is the user's), so that only guards a host-supplied history.
 */
function lastMarkable(messages: readonly WireMessage[], end: number): BlockAt | undefined {
  for (let m = end - 1; m >= 0; m--) {
    const content = messages[m]!.content;
    if (content.length === 0) continue;
    const tail = content[content.length - 1]!;
    if (tail["type"] === "thinking" || tail["type"] === "redacted_thinking") return undefined;
    return { m, b: content.length - 1 };
  }
  return undefined;
}

/** The lookback's own count of positions strictly after `from` up to and including `to` (runs of `tool_use` / `tool_result` count once). */
function positionsBetween(messages: readonly WireMessage[], from: BlockAt, to: BlockAt): number {
  let count = 0;
  let previousType: unknown;
  for (let m = from.m; m <= to.m; m++) {
    const content = messages[m]!.content;
    const first = m === from.m ? from.b + 1 : 0;
    const last = m === to.m ? to.b : content.length - 1;
    for (let b = first; b <= last; b++) {
      const type = content[b]!["type"];
      if ((type === "tool_use" || type === "tool_result") && type === previousType) continue;
      previousType = type;
      count++;
    }
  }
  return count;
}

function markAt(messages: WireMessage[], at: BlockAt): void {
  const message = messages[at.m]!;
  const content = message.content.slice();
  content[at.b] = { ...content[at.b]!, cache_control: { ...EPHEMERAL_CACHE_CONTROL } };
  messages[at.m] = { ...message, content };
}

/**
 * The message-level breakpoints, within the `budget` the system blocks left.
 *
 *   - The ROLLING breakpoint on the last block of the last content-bearing message -- whatever the
 *     engine appended last (tool results, a reminder, a hook's `additionalContext`) is the true tail.
 *   - WS-23, the LOOKBACK breakpoint: exactly on the block the PREVIOUS request's rolling breakpoint
 *     wrote -- the last markable block before the newest assistant message, since the previous
 *     request ended right there -- when this request appended more than
 *     `LOOKBACK_MARGIN_POSITIONS` positions after it. Past 20 the rolling breakpoint's lookback cannot
 *     reach the previous write and the whole conversation is re-written; a breakpoint ON the previous
 *     write is a guaranteed read ("a second breakpoint ... starts a second lookback window there",
 *     same page), and it costs nothing extra: a breakpoint over an already-cached prefix is a read.
 */
export function withMessageCacheMarkers(messages: WireMessage[], budget: number): WireMessage[] {
  const out = messages.slice();
  if (budget <= 0) return out;
  const tail = lastMarkable(out, out.length);
  if (tail === undefined) return out;
  markAt(out, tail);
  if (budget < 2) return out;
  let lastAssistant = -1;
  for (let m = tail.m; m >= 0; m--) {
    if (out[m]!.role === "assistant") {
      lastAssistant = m;
      break;
    }
  }
  if (lastAssistant <= 0) return out;
  const previousWrite = lastMarkable(out, lastAssistant);
  if (previousWrite !== undefined && positionsBetween(out, previousWrite, tail) > LOOKBACK_MARGIN_POSITIONS) markAt(out, previousWrite);
  return out;
}

/** The single rolling message breakpoint (the pre-WS-23 behaviour, and the one a tight budget leaves). */
export function withMessageCacheMarker(messages: WireMessage[]): WireMessage[] {
  return withMessageCacheMarkers(messages, 1);
}

// --- capability resolution ------------------------------------------------------------------------

/** Looks a descriptor up by provider + the id/alias/key the request named. `undefined` for an `allowUnlisted` passthrough, which is a FACT the checks below fail closed on. */
export function findDescriptor(catalog: WinterCatalog, providerId: string, model: string): WinterModelDescriptor | undefined {
  return catalog.models.find((m) => m.providerId === providerId && (m.upstreamId === model || m.key === model || m.aliases.includes(model)));
}

/**
 * PLAINLY: `value` ALONE IS NOT A COMPLETE WIRE OBJECT for a row that documents `reasoning.effortRequest`
 * -- this endpoint's top-level `output_config.effort` is a SIBLING of `thinking`, not a field inside
 * it, and it rides in `outputConfigEffort`, not in `value`. Reading only `value` from an `ok:true`
 * result silently drops the `output_config` half of what such a row actually sends.
 *
 * `value` is the THINKING arm this effort resolves to -- `"adaptive"` for a row that takes effort on
 * its own wire field (2026-09-25, `output_config.effort`, GA, no beta header:
 * https://platform.claude.com/docs/en/build-with-claude/effort) and does not also reject adaptive
 * thinking, `"enabled"` with a budget otherwise (the pre-existing ladder). `outputConfigEffort` rides
 * ALONGSIDE it -- present only when the row's own `reasoning.effortRequest` evidence says this model
 * takes `output_config.effort` at all, so a row with none keeps the exact old shape (no such key, and
 * `value` alone WAS the complete wire contribution, same as before this field existed). Together the
 * two fields are what "agrees with what streamTurn sends" means for `mapEffort` below.
 */
export type EffortMapping =
  | { ok: true; value: { type: "enabled"; budget_tokens: number } | { type: "adaptive" }; outputConfigEffort?: string }
  | { ok: false; reason: string };

/**
 * Effort -> the model's VERIFIED vocabulary, or a refusal (WS-13 §8.2).
 *
 * A NUMBER is mapped to the nearest declared tier by treating it as a 0-100 intensity across the
 * model's own `reasoning.efforts` list. The pin admits a numeric effort on exactly one surface
 * (`AgentDefinition.effort`, `sdk.d.ts:87`) and states no unit, range or mapping for it -- so this
 * is gap-filling, disclosed, and it can only ever select a tier the model already declares.
 *
 * WHERE THE TIER LANDS ON THE WIRE is a second, independent question from validating it, and the
 * row's own `reasoning.effortRequest` evidence answers it (2026-09-25 catalog field): Claude 4.7 and
 * later reject a manual `thinking.budget_tokens` outright
 * (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#rejected-configurations),
 * so a row that documents `output_config.effort` sends the tier THERE and `thinking: {type:"adaptive"}`
 * -- no budget lookup, and therefore no risk of refusing a tier this ladder has no budget for. The one
 * exception is a row that ALSO rejects adaptive thinking (Opus 4.5's `enabled`-only shape): effort then
 * COMPOSES with the budget ladder, exactly as the vendor's effort page documents for that model, so the
 * ladder still runs and `outputConfigEffort` rides beside its result.
 */
export function mapAnthropicEffort(effort: TurnRequest["effort"], descriptor: WinterModelDescriptor | undefined): EffortMapping {
  if (effort === undefined) return { ok: false, reason: "no effort was requested" };
  if (descriptor === undefined) {
    return { ok: false, reason: "this model is not in the catalog, so its effort vocabulary is unknown; Winter refuses an unverified effort rather than guessing one" };
  }
  const efforts = descriptor.reasoning?.efforts ?? [];
  if (efforts.length === 0) {
    return { ok: false, reason: `model "${descriptor.key}" declares no effort vocabulary, so no effort level can be verified for it` };
  }
  let tier: string;
  if (typeof effort === "number") {
    if (!Number.isFinite(effort)) return { ok: false, reason: `numeric effort ${String(effort)} is not a finite number` };
    const clamped = Math.min(100, Math.max(0, effort));
    const index = Math.round((clamped / 100) * (efforts.length - 1));
    tier = efforts[index]!;
  } else {
    if (!efforts.includes(effort)) {
      return { ok: false, reason: `effort "${effort}" is not in model "${descriptor.key}"'s verified vocabulary (${efforts.join(", ")}); Winter never silently downgrades to a provider default` };
    }
    tier = effort;
  }

  const effortRequest = descriptor.reasoning?.effortRequest?.value;
  const rejectsAdaptive = descriptor.unsupportedParameters.includes("thinking.type.adaptive");
  if (effortRequest !== undefined && !rejectsAdaptive) {
    // `output_config.effort` takes the tier directly; the model steers its own adaptive thinking, so
    // no budget is looked up (or invented) at all -- this row is NOT a dependent of
    // `EFFORT_BUDGET_TOKENS`, per that constant's own updated doc comment.
    return { ok: true, value: { type: "adaptive" }, outputConfigEffort: tier };
  }

  const budget = EFFORT_BUDGET_TOKENS[tier];
  if (budget === undefined) {
    return { ok: false, reason: `model "${descriptor.key}" declares effort tier "${tier}", which this adapter has no verified thinking budget for` };
  }
  // `effortRequest !== undefined` here means `rejectsAdaptive` is true (Opus 4.5's `enabled`-only
  // shape, per the vendor's effort page): effort COMPOSES with the budget ladder rather than
  // replacing it, so `outputConfigEffort` rides beside the enabled/budget value instead of alone.
  return { ok: true, value: { type: "enabled", budget_tokens: budget }, ...(effortRequest !== undefined ? { outputConfigEffort: tier } : {}) };
}

/**
 * `block_binding` (2026-09-25): the documented escape for a row whose `reasoning.blockBinding`
 * evidence says the vendor binds a replayed thinking block to the conversation prefix it was produced
 * under -- see `buildThinking`'s own comment on the merge site for the full citation.
 */
type WireThinking =
  | { type: "disabled" }
  | { type: "enabled"; budget_tokens?: number; display?: string; block_binding?: { prefix_mismatch_behavior: "drop_block" } }
  | { type: "adaptive"; display?: string; block_binding?: { prefix_mismatch_behavior: "drop_block" } };

/** What `buildThinking` decided, plus the SIBLING `output_config.effort` value (independent of which thinking arm won -- see `mapAnthropicEffort`'s own doc comment). */
type ThinkingBuild = { ok: true; value: WireThinking | undefined; outputConfigEffort?: string } | { ok: false; reason: string };

/**
 * The `thinking` envelope (and, on a row that documents one, the sibling `output_config.effort`
 * value), from `TurnRequest.thinking` and `TurnRequest.effort`.
 *
 * FORWARDED VERBATIM BY ARM, UNLESS THE ROW'S OWN `unsupportedParameters` NAMES THE ARM A DOCUMENTED
 * 400 (2026-09-25). Capture (F) observed the pinned runtime re-resolving `enabled` to `adaptive` for
 * `claude-sonnet-5`, and this used to be a disclosed difference because the catalog carried no
 * evidence for which models needed it -- re-resolving would have been an invented capability claim.
 * The catalog now carries exactly that evidence (`thinking.type.enabled` / `.disabled` / `.adaptive`
 * in `unsupportedParameters`, sourced from
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting's per-model
 * rejected-configuration table), so the three arms below are no longer a guess:
 *
 *   - `enabled` on a row that rejects it -> `{type:"adaptive"}`, budget dropped (claude's own mapping,
 *     now evidenced rather than merely observed once).
 *   - `disabled` on a row that rejects it -> the field is OMITTED, UNLESS the row also documents
 *     `reasoning.blockBinding` (fix round 2), in which case it becomes `{type:"adaptive"}` instead --
 *     see that branch's own comment for why a decided omission is the one case the block-binding
 *     fallback below is allowed to override. A row with no such evidence keeps the plain omission:
 *     these models cannot be turned off, and the vendor page's advice for an always-on model with no
 *     other reason to send the field is to omit `thinking` rather than send a value it will reject.
 *   - `adaptive` on a row that rejects it -> a typed refusal before the request. No row observed so far
 *     rejects `adaptive` while also being an "adaptive only" model (that would be self-contradictory),
 *     so this arm exists for the Sonnet-4.5/Opus-4.5-shaped `enabled`-only rows, which is exactly what
 *     the corpus's typed-refusal fixture proves.
 *
 * A model with NO such evidence (an unlisted row, or a sibling provider that has not been captured)
 * still gets the arm forwarded verbatim -- the disclosed-gap-fill default is unchanged for it.
 *
 * `display` comes from the DESCRIPTOR'S OWN `summaryRequest` evidence (`field: "thinking.display"`),
 * never from a hard-coded string, and only when the caller asked for a summary.
 *
 * THREE CASES SEND AN OTHERWISE-OMITTED FIELD ANYWAY, all on an always-on row (one that rejects
 * `thinking.type.disabled`) and all gated on the SAME always-on check (a 4.6/4.7-shaped row has
 * thinking OFF by default, and sending `{type:"adaptive"}` there would TURN THINKING ON -- a
 * capability change this file must never make unasked):
 *
 *   - nothing else decided the field, and the row's own evidence can actually PRODUCE a display value
 *     for a requested summary (2026-09-25 fix round 1, tightened round 2: `req.requestSummary === true`
 *     alone is not enough -- a row with no `summaryRequest` evidence would get a BARE `{type:"adaptive"}`
 *     with nothing attached, a wire change accomplishing nothing). Omitting `thinking` is equivalent to
 *     `{type:"adaptive"}` on these models (Anthropic's own statement), but equivalence stops at the
 *     WIRE SHAPE: the short progress text the model writes between tool calls arrives INSIDE thinking
 *     blocks on Opus 5.5/Fable 5.1, and without a `display` value that defaults to `"omitted"` -- there
 *     is no field to attach `display` to unless one is actually sent.
 *   - nothing else decided the field, and the row documents `reasoning.blockBinding` (below): the
 *     `block_binding` opt-in can only ride on a real `thinking` object, and these rows carry the
 *     replay-binding risk on EVERY request, not only one that also asks for a summary.
 *   - an explicit `disabled` WAS decided (the branch above), but the row documents `blockBinding` --
 *     the one case where a decided omission is overridden, because the equivalence the omission relies
 *     on ("omitting means adaptive") is exactly what makes overriding it safe: the caller gets what
 *     they asked for either way, plus the opt-in the row needs on every request regardless of what any
 *     one turn's field said.
 */
function buildThinking(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): ThinkingBuild {
  const reasoning = descriptor?.reasoning;
  const supported = reasoning?.supported.value === true;
  const unsupported = new Set(descriptor?.unsupportedParameters ?? []);
  const alwaysOn = unsupported.has("thinking.type.disabled");
  const blockBinding = reasoning?.blockBinding?.value;

  let base: WireThinking | undefined;
  // Tracks whether `req.thinking` decided the FIELD (including deciding to omit it) -- as opposed to
  // `base` simply being `undefined` because no thinking was requested at all. The two must not be
  // conflated: an explicit `disabled` on an always-on row omits the field on purpose, and that
  // decision must survive the effort fallback below rather than being silently overwritten by it.
  let thinkingFieldDecided = false;
  if (req.thinking !== undefined) {
    if (req.thinking.type !== "disabled" && !supported) {
      return {
        ok: false,
        reason:
          descriptor === undefined
            ? `thinking was requested for "${req.model}", which is not in the catalog; Winter refuses an unverified reasoning request rather than sending it and hoping`
            : `model "${descriptor.key}" does not declare reasoning support, so a thinking config cannot be honoured`,
      };
    }
    thinkingFieldDecided = true;
    if (req.thinking.type === "enabled" && unsupported.has("thinking.type.enabled")) {
      base = { type: "adaptive" };
    } else if (req.thinking.type === "disabled" && unsupported.has("thinking.type.disabled")) {
      // CRITICAL FIX (fix round 2): an ALWAYS-ON row cannot honour "disabled" literally, and omitting
      // the field is equivalent to `{type:"adaptive"}` (Anthropic's own statement) -- but ONLY when
      // nothing depends on the field actually EXISTING on the wire. A row that also documents
      // `blockBinding` is always producing and replaying thinking blocks regardless of what any one
      // turn's `thinking` field says (`Options.thinking`/`maxThinkingTokens: 0` forwards `disabled` on
      // EVERY generation, including forks, so this is not a rare caller choice), and the block-binding
      // opt-in can only ride on a real thinking object -- omitting it here left a live session sending
      // unprotected requests forever, then 400ing the moment a later turn's tools/prefix changed,
      // exactly what `blockBinding` exists to prevent. Sending `{type:"adaptive"}` means exactly what
      // the caller got anyway (the equivalence still holds), plus the opt-in this row needs on every
      // request. A row with NO `blockBinding` evidence keeps the plain omission, unchanged.
      base = blockBinding !== undefined ? { type: "adaptive" } : undefined;
    } else if (req.thinking.type === "adaptive" && unsupported.has("thinking.type.adaptive")) {
      return {
        ok: false,
        reason: `model "${descriptor?.key ?? req.model}" lists "thinking.type.adaptive" in its unsupportedParameters, so an explicit adaptive thinking request is refused before the request rather than sent and rejected upstream`,
      };
    } else {
      const requestedBudget = req.thinking.type === "enabled" ? req.thinking.budgetTokens : undefined;
      if (req.thinking.type === "enabled" && requestedBudget === undefined) {
        // The pin types `budgetTokens` OPTIONAL while its own JSDoc renders the arm as requiring one --
        // "a well-typed value with undefined semantics in the pin" (derived-shapes item (c)). This
        // endpoint requires `budget_tokens` on an enabled thinking config, so forwarding the arm
        // budget-less is a request we KNOW will fail upstream. That is exactly what the
        // reject-before-the-request rule exists for, and the `budget >= max_tokens` check below cannot
        // catch it (an absent budget skips it).
        return { ok: false, reason: THINKING_ENABLED_NEEDS_BUDGET };
      }
      base = requestedBudget !== undefined ? { type: "enabled", budget_tokens: requestedBudget } : { type: req.thinking.type };
    }
  }

  let outputConfigEffort: string | undefined;
  if (req.effort !== undefined) {
    const mapped = mapAnthropicEffort(req.effort, descriptor);
    if (!mapped.ok) return { ok: false, reason: mapped.reason };
    // "cannot be honoured", not "mapped onto its thinking budget": on an `effortRequest` row there is
    // no budget at all for this to be about, so the message must not claim there is one.
    if (!supported) return { ok: false, reason: `model "${descriptor?.key ?? req.model}" does not declare reasoning support, so an effort level cannot be honoured` };
    // `output_config.effort` rides whenever the row documents it and an effort was requested,
    // regardless of which arm wins the THINKING field below -- an explicit `thinking` still overrides
    // the field itself (next comment), but that is a different question from whether effort reaches
    // the wire at all.
    outputConfigEffort = mapped.outputConfigEffort;
    // An explicit `thinking` wins: the pin says the same about `thinking` vs `maxThinkingTokens`
    // ("`thinking`, when set, takes precedence"), and effort is the coarser dial of the two. This must
    // be gated on `thinkingFieldDecided`, not merely `base === undefined` -- an explicit `disabled` on
    // an always-on row (above) leaves `base` undefined ON PURPOSE (or, on a `blockBinding` row, already
    // DECIDES it as `{type:"adaptive"}` on purpose), and falling through here would silently replace
    // either decision with the effort's own thinking value.
    if (!thinkingFieldDecided) base = mapped.value;
  }

  // Computed ONCE, shared by the fallback gate below AND the display step further down (fix round 2,
  // Minor 2): whether this row's OWN evidence can actually produce a `display` value for a requested
  // summary. `req.requestSummary === true` alone is not enough to justify sending an otherwise-omitted
  // field -- a row with no `summaryRequest` evidence (Fable 5's shape) would get a BARE
  // `{type:"adaptive"}` with nothing attached to it, a wire change with no purpose: no display (no
  // evidence for one) and no block_binding (checked separately below).
  const summaryRequest = reasoning?.summaryRequest?.value;
  const canAttachDisplay = req.requestSummary === true && summaryRequest !== undefined && summaryRequest.field === "thinking.display" && summaryRequest.values.includes("summarized");

  // TWO of the THREE "send an otherwise-omitted field anyway" cases (doc comment above; the third is
  // the `blockBinding` arm of the explicit-`disabled` branch, above). Both require an
  // ALWAYS-ON row (never on a 4.6/4.7-shaped row, where this would turn thinking on unasked), that
  // nothing above already decided the field -- an explicit arm, or an effort's own mapping, still wins
  // -- AND that sending the field actually accomplishes something (`canAttachDisplay` or
  // `blockBinding`): a bare `{type:"adaptive"}` with neither is exactly the same to the model as
  // omitting it, so it is not sent.
  // `!thinkingFieldDecided`, NOT merely `base === undefined`: an explicit `disabled` on an always-on
  // row also leaves `base` undefined (the omission a few lines up), and that is a DECIDED omission --
  // the caller asked for something this endpoint cannot represent, Winter honoured it by sending
  // nothing, and this fallback exists for the OPPOSITE situation (nobody asked for anything at all),
  // not to second-guess a decision the explicit-thinking branch already made on purpose.
  if (base === undefined && !thinkingFieldDecided && alwaysOn && (canAttachDisplay || blockBinding !== undefined)) {
    base = { type: "adaptive" };
  }

  if (base === undefined) return { ok: true, value: undefined, ...(outputConfigEffort !== undefined ? { outputConfigEffort } : {}) };

  if (canAttachDisplay && base.type !== "disabled") {
    base = { ...base, display: "summarized" };
  }

  // Block binding (2026-09-25 fix round 1):
  // https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting ("A 400 error says
  // a thinking block signature is invalid") -- on a row that documents `reasoning.blockBinding`, a
  // replayed thinking block is bound to the conversation prefix (the `system` prompt, the `tools`
  // array, every earlier message) it was produced under, and is rejected once that prefix changes.
  // Winter's own tool list legitimately grows mid-session (an MCP server connecting after spawn, a
  // ToolSearch-loaded deferred tool), so this is not a hypothetical for a long-lived session. The
  // documented escape is `block_binding.prefix_mismatch_behavior: "drop_block"` on WHATEVER thinking
  // object this request ends up sending -- never invented on its own, only merged onto a `base` some
  // earlier step already decided to send -- plus the matching beta header (`buildHeaders`, same
  // evidence). Applied unconditionally past this point: every arm above that can still be here
  // (explicit, effort-derived, or the always-on fallback just above) gets it, which is what "whenever
  // the request carries a thinking object" means.
  if (blockBinding !== undefined && base.type !== "disabled") {
    base = { ...base, block_binding: { prefix_mismatch_behavior: "drop_block" } };
  }

  return { ok: true, value: base, ...(outputConfigEffort !== undefined ? { outputConfigEffort } : {}) };
}

/**
 * `TurnRequest.toolChoice` -> the wire `tool_choice`, downgrading a FORCED choice to `auto` on a row
 * that documents rejecting it.
 *
 * On Opus 5.5 and Fable 5.1, a forced `tool_choice` (`{type:"any"}` or `{type:"tool",name}`) is a
 * documented 400 -- https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 * lists both tokens as rejected, and the vendor's own advice there is to use `auto` instead. `auto`
 * and `none` are unaffected (never rejected), so only the two forcing shapes are downgraded, and only
 * on a row that actually lists the matching token -- a model with no such evidence still gets the
 * caller's choice forwarded verbatim, same as every other unlisted capability in this file.
 */
function resolveToolChoice(toolChoice: NonNullable<TurnRequest["toolChoice"]>, unsupported: ReadonlySet<string>): Record<string, unknown> {
  if (toolChoice.type === "any" && unsupported.has("tool_choice.any")) return { type: "auto" };
  if (toolChoice.type === "tool" && unsupported.has("tool_choice.tool")) return { type: "auto" };
  return toolChoice.type === "tool" ? { type: "tool", name: toolChoice.name } : { type: toolChoice.type };
}

/**
 * A row's DOTTED upstream id -> Anthropic's own DASHED wire id (e.g. `claude-opus-4.8` ->
 * `claude-opus-4-8`), or the id UNCHANGED when it does not match that shape.
 *
 * PRE-EXISTING BUG (found by the live gate, fix round 3): the registry sends a resolved session's
 * `model` as the row's own `upstreamId` (`bridge.ts`'s `providerModelId`), and seven Claude rows have
 * a DOTTED upstream id -- `claude-opus-4.5`/`4.6`/`4.7`/`4.8`, `claude-sonnet-4.5`/`4.6` and
 * `claude-haiku-4.5`, on BOTH `anthropic` and `console` (same spelling, same bug, independent of
 * provider). Sending that spelling verbatim 404s: "model: claude-opus-4.8 was not found. Did you mean
 * claude-opus-4-8?" -- Winter's own leg has never been able to call any of the seven. Anthropic's own
 * model pages give the dashed form as the API id
 * (https://platform.claude.com/docs/en/models/opus-4-7/overview: "Model ID: claude-opus-4-7").
 *
 * FIXED AT THE WIRE, NOT IN THE CATALOG: the catalog key must equal `<providerId>/<upstreamId>`
 * (WS-13 §8.3), so renaming the seven stored ids would be a stored-tag migration -- a different, much
 * larger change than this file owns. `findDescriptor` keeps looking the row up by the DOTTED id
 * (`req.model`, unchanged) exactly as before; only the `model` field this file WRITES INTO THE REQUEST
 * BODY is rewritten, so capability resolution (descriptor lookup, `unsupportedParameters`,
 * `effortRequest`, everything `buildThinking` reads) is completely unaffected by this function.
 *
 * THE PATTERN IS NARROW ON PURPOSE: `/^(claude-[a-z]+-\d+)\.(\d+)$/` matches only a bare
 * `claude-<family>-<major>.<minor>` shape and nothing else, so a DATED id
 * (`claude-haiku-4-5-20251001`, no dot at all), an ALREADY-DASHED id, and a non-Claude model on a
 * sibling Anthropic-dialect provider (`deepseek-flash`, `glm-5.3`, `MiniMax-M2.7` -- none of which are
 * `claude-*`, and whose own `.` means something this pattern must never touch) all fail to match and
 * pass through byte-identical. This is a Claude-id-SHAPE fix, not a general dot-to-dash transform.
 *
 * SCOPED TO THIS ADAPTER, per the fix-round instruction: bedrock/vertex serve the same models under
 * their OWN id schemes, which this pattern is not written against and would not reliably match -- out
 * of scope here, and this helper has no reason to be shared with either.
 */
export function anthropicWireModelId(id: string): string {
  return id.replace(/^(claude-[a-z]+-\d+)\.(\d+)$/, "$1-$2");
}

/** One tool as the wire declares it; `defer_loading` only for a tool the engine withheld (WS-23). */
function toWireTool(tool: NonNullable<TurnRequest["tools"]>[number]): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema, ...(tool.deferLoading === true ? { defer_loading: true } : {}) };
}

/**
 * WS-23: the tools this request declares deferred -- the only names a `tool_reference` may name.
 *
 * Gated like every other capability here: a `defer_loading` tool on a row whose `deferredToolLoading`
 * evidence does not document it, or a tool list with NO non-deferred tool ("At least one tool must
 * have defer_loading=false", the tool-search page's own 400), is refused before the request. The
 * engine never builds either, so this fires on a wiring bug only.
 */
function deferredToolNames(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): ReadonlySet<string> {
  const deferred = (req.tools ?? []).filter((t) => t.deferLoading === true);
  if (deferred.length === 0) return NOTHING_REFERABLE;
  if (descriptor?.deferredToolLoading?.value !== true) {
    throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" does not document deferred tool loading (no \`deferredToolLoading\` evidence), so ${deferred.length} \`defer_loading\` tool(s) are refused before the request rather than sent and rejected upstream`);
  }
  if (deferred.length === req.tools!.length) {
    throw capabilityRefusal("every tool in this request is deferred; Anthropic requires at least one tool without `defer_loading`");
  }
  return new Set(deferred.map((t) => t.name));
}

/** WS-23: an effort-only `system` marker -- no content, only `output_config`. */
function isEffortOnlyMarker(message: ProviderMessageLike): boolean {
  return message.role === "system" && message.outputConfig !== undefined && (typeof message.content === "string" ? message.content.length === 0 : message.content.length === 0);
}

/**
 * WS-23: the per-message effort gate. A `system` message carrying `output_config` is refused BEFORE
 * the request unless the row's own `reasoning.perMessageEffort` evidence documents the shape, and its
 * level must be one of the row's own `reasoning.efforts` -- the vendor's own error for a model
 * without the feature is a 400 ("output_config.effort requires a model that supports per-turn effort",
 * https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta),
 * and this file turns every documented 400 it can foresee into a typed local refusal (decision 1).
 * The engine only ever produces a marker for a row with the evidence, so this fires on a wiring bug,
 * never on an ordinary session.
 */
function assertPerMessageEffort(req: TurnRequest, descriptor: WinterModelDescriptor | undefined): void {
  const efforts = descriptor?.reasoning?.efforts ?? [];
  for (const message of req.messages) {
    if (message.role !== "system" || message.outputConfig === undefined) continue;
    if (descriptor?.reasoning?.perMessageEffort === undefined) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" does not document per-message effort (no \`reasoning.perMessageEffort\` evidence), so a mid-conversation \`output_config.effort\` is refused before the request rather than sent and rejected upstream`);
    }
    if (!efforts.includes(message.outputConfig.effort)) {
      throw capabilityRefusal(`per-message effort "${message.outputConfig.effort}" is not in model "${descriptor.key}"'s verified vocabulary (${efforts.join(", ")})`);
    }
  }
}

/**
 * The per-message effort beta, or `undefined` -- derived from the BODY `buildRequestBody` produced,
 * the same one-decision rule `blockBindingBetaFor` states: the header rides exactly when a message in
 * the body carries `output_config`.
 *
 * The DOCUMENTED value (`mid-conversation-output-config-2026-07-01`), read off the row's evidence.
 * claude 2.1.282 sends the older alias `per-turn-control-2026-07-01` (its binary maps
 * `per_message_effort` to it, and the loopback capture shows it on the wire); the effort page names
 * only the new value, so Winter sends that one and does not depend on an undocumented alias.
 */
export function perMessageEffortBetaFor(body: Record<string, unknown>, descriptor: WinterModelDescriptor | undefined): string | undefined {
  const messages = body["messages"];
  if (!Array.isArray(messages) || !messages.some((m) => typeof m === "object" && m !== null && "output_config" in m)) return undefined;
  return descriptor?.reasoning?.perMessageEffort?.value.beta;
}

/** Every body-derived beta, in a fixed order. One list, so `prepare()` and `countTokens()` cannot disagree about which ride. */
function bodyBetas(body: Record<string, unknown>, descriptor: WinterModelDescriptor | undefined): string[] {
  return [perMessageEffortBetaFor(body, descriptor)].filter((b): b is string => b !== undefined);
}

/**
 * The pre-request capability gate. Returns the request body, or a typed refusal that never reaches the
 * network.
 *
 * `purpose` exists for ONE reason (Minor 4): a token COUNT has no output allowance, so running the
 * "does the thinking budget fit inside `max_tokens`?" check for it refuses a count against a
 * generation limit the count was never going to be subject to. The count path used to build the full
 * body and then delete `max_tokens`/`stream` — which meant the check ran on a field that was about to
 * be thrown away.
 *
 * EXPORTED (relative-import only, same convention as `promptCachingLayout`): the REQUEST BODY is what
 * a fixture-catalog test asserts against for the effort/thinking/tool_choice envelope, without needing
 * a fetch fake -- `messages.test.ts` reads the return value directly rather than a loopback server's
 * `fake.requests`, which is `provider-conformance`'s job for the actual wire proof (this file's own
 * header comment).
 */
export function buildRequestBody(req: TurnRequest, descriptor: WinterModelDescriptor | undefined, opts: AnthropicAdapterOptions, purpose: "generate" | "count" = "generate"): Record<string, unknown> {
  // Tools: WS-13 §8.1's three states. `emulated` is disabled for agent modes and `none` fails
  // negotiation -- neither is a reason to drop the tools and continue as plain chat.
  if (req.tools !== undefined && req.tools.length > 0 && descriptor !== undefined) {
    const toolCalling = descriptor.toolCalling.value;
    if (toolCalling !== "native") {
      throw capabilityRefusal(
        `model "${descriptor.key}" declares tool calling "${toolCalling}", so the ${req.tools.length} advertised tool(s) cannot be sent natively; Winter fails capability negotiation rather than silently dropping them (WS-13 §8.1)`,
      );
    }
  }

  // Vision: an image block reaches the wire only where the descriptor advertises it.
  if (descriptor !== undefined && !descriptor.inputModalities.value.includes("image")) {
    // RECURSIVE, and that is the whole point: P3-M's multimodal `Read` delivers its page images
    // SOLELY as image blocks inside a model-facing `tool_result` (derived-shapes item (f)), so a
    // top-level-only scan saw none of them and let exactly the interesting case reach a non-vision
    // model -- an upstream 400 in place of the typed refusal this gate exists to produce.
    for (const message of req.messages) {
      if (containsImage(message.content)) {
        throw capabilityRefusal(`model "${descriptor.key}" does not advertise image input, so an image block is refused before the request rather than sent and rejected upstream`);
      }
    }
  }

  // Parameters the row says this model rejects.
  for (const parameter of descriptor?.unsupportedParameters ?? []) {
    if (parameter === "thinking" && (req.thinking !== undefined || req.effort !== undefined)) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" lists "thinking" in its unsupportedParameters`);
    }
    if (parameter === "tools" && req.tools !== undefined && req.tools.length > 0) {
      throw capabilityRefusal(`model "${descriptor?.key ?? req.model}" lists "tools" in its unsupportedParameters`);
    }
    // The granular `thinking.type.*` / `tool_choice.*` tokens (2026-09-25) are read by
    // `buildThinking`/`resolveToolChoice` below via their own `Set`, not this loop -- this loop's
    // vocabulary is exactly `"thinking"`/`"tools"`, so every granular token is INERT here by
    // construction, same as any other token this file does not handle.
  }
  // For `resolveToolChoice` below. `buildThinking` builds its OWN identical `Set` internally rather
  // than taking this one as a parameter -- a deliberate choice to keep its signature `(req,
  // descriptor)` unchanged from before this token vocabulary existed; a row's `unsupportedParameters`
  // is small, so the duplicate construction is not worth widening that signature for.
  const unsupported = new Set(descriptor?.unsupportedParameters ?? []);
  const referableTools = deferredToolNames(req, descriptor);

  const thinking = buildThinking(req, descriptor);
  if (!thinking.ok) throw capabilityRefusal(thinking.reason);
  assertPerMessageEffort(req, descriptor);

  // `max_tokens` has TWO AUTHORITATIVE sources -- what the caller asked for and what the model's row
  // declares -- and a third, this adapter's own fallback, which is authoritative over nothing.
  //
  // The distinction is what the corpus found on its first run: a `high` effort maps to a 16k thinking
  // budget, which cannot fit inside a 4k fallback, so an effort request that named no output budget
  // was rejected as "over the limit" by a number the CALLER never chose. A declared or requested
  // ceiling is a real limit and a budget that overruns it is a real refusal; the fallback is not a
  // limit at all, so it GROWS to hold the reasoning plus a full answer's worth of output -- ON THE
  // BUDGET-CARRYING `enabled` ARM ONLY, since `budget` below is that arm's own number and there is
  // nothing else for the fallback to grow BY.
  //
  // THE `adaptive` ARM CARRIES NO NUMBER AT ALL (2026-09-25): `output_config.effort`-driven rows send
  // `thinking:{type:"adaptive",...}` far more often now, and an adaptive model's own reasoning length
  // is not a quantity this adapter has ever been told -- inventing a bigger fallback for it would be
  // exactly the unevidenced capability claim `ANTHROPIC_DEFAULT_MAX_TOKENS`'s own comment refuses to
  // make. In PRACTICE this rarely bites: every real Claude row in the catalog declares its own
  // `maxOutputTokens` (128K on the 2026-09-25 rows), so `declaredMax` is populated before the fallback
  // is ever reached, and the flat, undeclared-only fallback below is reserved for an `allowUnlisted`
  // passthrough or a descriptor missing that one field -- exactly the situations `maxOutputTokens`
  // evidence exists to be threaded through instead of this adapter guessing at a ceiling.
  const declaredMax = req.maxOutputTokens ?? descriptor?.maxOutputTokens?.value;
  const fallbackMax = opts.defaultMaxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  const budget = thinking.value !== undefined && thinking.value.type === "enabled" ? thinking.value.budget_tokens : undefined;
  if (req.maxOutputTokens !== undefined && descriptor?.maxOutputTokens?.value !== undefined && req.maxOutputTokens > descriptor.maxOutputTokens.value) {
    throw capabilityRefusal(`requested max output ${req.maxOutputTokens} exceeds model "${descriptor.key}"'s declared maximum of ${descriptor.maxOutputTokens.value}`);
  }
  const maxTokens = declaredMax ?? (budget !== undefined ? budget + fallbackMax : fallbackMax);
  if (purpose === "count") {
    // A count carries the PROMPT and nothing else: no `stream`, no `max_tokens`, and therefore no
    // ceiling for a thinking budget to overrun. `output_config.effort` is deliberately left OFF this
    // body too: effort steers generation, not tokenization, and whether `count_tokens` even accepts
    // the field is unverified -- sending it would be an unevidenced capability claim on an endpoint
    // this adapter has no fixture proving it against.
    return {
      model: anthropicWireModelId(req.model),
      // An effort-only marker renders nothing and `output_config` is deliberately off a count body
      // (above), so the markers are dropped here rather than sent to an endpoint with no fixture.
      messages: toWireMessages(req.messages.filter((m) => !isEffortOnlyMarker(m)), { referableTools }),
      ...(req.system !== undefined ? { system: req.system } : {}),
      ...(req.tools !== undefined && req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
      ...(thinking.value !== undefined ? { thinking: thinking.value } : {}),
    };
  }
  if (budget !== undefined && budget >= maxTokens) {
    // A real endpoint constraint, and the honest place to enforce it: a thinking budget that does
    // not fit inside the output allowance is rejected upstream, so catching it here turns a remote
    // 400 into a typed local refusal with the two numbers in it.
    throw capabilityRefusal(`thinking budget ${budget} does not fit inside max_tokens ${maxTokens}; the budget must be strictly smaller`);
  }

  const caching = promptCachingLayout(req, descriptor);
  const wireMessages = toWireMessages(req.messages, { referableTools });
  // The system blocks' own breakpoints (at most two: the static prefix and the dynamic rest) come out
  // of the request's budget of four first; the messages get what is left.
  const wireSystem = caching && req.systemBlocks !== undefined ? toWireSystemBlocks(req.systemBlocks) : undefined;
  const systemBreakpoints = wireSystem?.filter((block) => "cache_control" in block).length ?? 0;
  return {
    model: anthropicWireModelId(req.model),
    max_tokens: maxTokens,
    messages: caching ? withMessageCacheMarkers(wireMessages, MAX_CACHE_BREAKPOINTS - systemBreakpoints) : wireMessages,
    stream: true,
    ...(wireSystem !== undefined ? { system: wireSystem } : req.system !== undefined ? { system: req.system } : {}),
    ...(req.tools !== undefined && req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
    ...(req.toolChoice !== undefined ? { tool_choice: resolveToolChoice(req.toolChoice, unsupported) } : {}),
    ...(thinking.value !== undefined ? { thinking: thinking.value } : {}),
    // `output_config` is Anthropic's own top-level effort field (GA, no beta header:
    // https://platform.claude.com/docs/en/build-with-claude/effort). Nothing else in this file sends
    // `output_config` today (checked: no other site names it), so this is a plain assignment rather
    // than a merge -- a future second producer of `output_config` must merge into this key, not
    // overwrite it, exactly as a later reader of this comment is being told now.
    ...(thinking.outputConfigEffort !== undefined ? { output_config: { effort: thinking.outputConfigEffort } } : {}),
  };
}

/**
 * The `anthropic-beta` value for `reasoning.blockBinding`, or `undefined` -- derived from the BODY
 * `buildRequestBody` actually produced, never independently from the descriptor.
 *
 * FIX ROUND 2's OWN BUG: `buildHeaders` used to read `descriptor?.reasoning?.blockBinding` directly,
 * which let the header claim an opt-in the body never sent -- an explicit
 * `thinking:{type:"disabled"}` used to OMIT the thinking field entirely even on a blockBinding row
 * (the pre-round-2 `buildThinking` never overrode a decided omission), while the header still carried
 * the beta regardless. The header and the body's own `block_binding` key must be ONE decision, made
 * once, from the one place that actually knows what the body contains -- here, called from
 * `prepare()`/`countTokens()` against the body they already built, so the two structurally cannot
 * disagree again.
 */
export function blockBindingBetaFor(body: Record<string, unknown>, descriptor: WinterModelDescriptor | undefined): string | undefined {
  const thinking = body["thinking"];
  if (thinking === null || typeof thinking !== "object" || !("block_binding" in thinking)) return undefined;
  return descriptor?.reasoning?.blockBinding?.value?.beta;
}

// --- endpoint + headers ---------------------------------------------------------------------------

interface Endpoint {
  base: string;
  policy: EndpointPolicy;
}

/**
 * The connection's endpoint policy.
 *
 * A profile `baseUrl` is evaluated by its ORIGIN, not by its mere presence (P7a): a host- or
 * user-supplied one is a USER endpoint, which is what makes `applyPrivilegedHeaders` drop this
 * family's privileged header for it (R6-L), while a reviewed endpoint the runtime COPIED in
 * (`endpointOrigin: "reviewed"`) stays generated and keeps it. This family has FOUR such rows -- the
 * Anthropic-dialect siblings -- and before the marker existed every one of them was silently read as
 * a user endpoint (WS-13b §10's M-1 partial). The compiled default is `generated: true` either way:
 * it is the reviewed, immutable descriptor endpoint.
 */
function resolveEndpoint(ctx: ProviderContext, defaultBaseUrl: string): Endpoint {
  const userBase = ctx.connection.baseUrl;
  const base = (userBase ?? defaultBaseUrl).replace(/\/+$/, "");
  // P7a: a profile `baseUrl` is evaluated by its ORIGIN (`connectionEndpointOptions`), so the four
  // Anthropic-dialect sibling rows -- whose reviewed endpoint the runtime copies into the profile
  // because this adapter serves several providers -- stay on the privileged-header path.
  const built = createEndpointPolicy(base, userBase !== undefined ? connectionEndpointOptions(ctx.connection) : { generated: true });
  if (!built.ok) throw capabilityRefusal(built.reason);
  return { base, policy: built.policy };
}

/**
 * The request headers.
 *
 * PROTOCOL vs PRIVILEGED, per R6-L and `endpoint-policy.ts`'s own split: `x-api-key`,
 * `anthropic-version`, `anthropic-beta`, `content-type` and `accept` are all PROTOCOL headers --
 * every endpoint speaking this dialect needs them and none names the operator's account. This family
 * has no privileged header of its own, so `applyPrivilegedHeaders` is called with an empty set: the
 * call site exists so the rule is enforced by code rather than by this comment, and so a later
 * account-scoped header lands in the right place.
 */
/**
 * Is this connection the Anthropic Console row, as opposed to a sibling third-party row sharing this
 * adapter (R6b-5)? The gate on the beta header (D20).
 */
function isConsoleProvider(ctx: ProviderContext): boolean {
  return ctx.connection.providerId === ANTHROPIC_CONSOLE_PROVIDER_ID;
}

/**
 * Reads the credential.
 *
 * RETIRED (2026-09-13, P10a-1): this used to also RENEW an `oauth` credential about to expire, via
 * `refreshOauthMaterial` against `CONSOLE_OAUTH.tokenUrl`/`clientId` -- the same PKCE client
 * `console-oauth.ts`'s login used. Both are gone: Console OAuth is host-brokered now, and renewal is
 * the host's `console-profile-broker` calling `ant auth print-credentials` ahead of expiry (P10a-4),
 * never this adapter posting a refresh grant to Anthropic's token endpoint under a client id this SDK
 * no longer holds. A stale `oauth` or `bearer` credential now surfaces as an ordinary upstream 401,
 * exactly like any other provider whose host owns its own renewal.
 */
async function resolveFreshMaterial(ctx: ProviderContext): Promise<CredentialMaterial | null> {
  return await ctx.credentials.get(ctx.authRef);
}

/**
 * `blockBindingBeta` is OPTIONAL, and it is a VALUE the caller computed, never a descriptor this
 * function reads for itself (fix round 2: see `blockBindingBetaFor`'s own comment for the bug that
 * made). `validateCredential`/`listModels` hit `/v1/models`, not a model-specific endpoint, and pass
 * `undefined` -- there is no row and no body to have derived a beta from.
 *
 * EXPORTED (relative-import only, same convention as `buildRequestBody`): the `anthropic-beta` header
 * -- including this beta and its dedupe against `opts.betas` -- is otherwise unreachable without a
 * real or faked HTTP round trip, and `messages.test.ts` asserts it directly.
 */
export async function buildHeaders(
  ctx: ProviderContext,
  blockBindingBeta: string | undefined,
  policy: EndpointPolicy,
  opts: AnthropicAdapterOptions,
  json: boolean,
  identity: Record<string, string> = {},
  // WS-23: further BODY-DERIVED betas (per-message effort, ...), each computed by its own `*BetaFor`
  // from the body the caller already built -- the same one-decision rule as `blockBindingBeta`.
  // Trailing and defaulted, so every existing call site is unchanged.
  extraBetas: readonly string[] = [],
): Promise<Record<string, string>> {
  const material = await resolveFreshMaterial(ctx);
  // P10a-4, AMENDED (Lane S round 3, Opus review): a `bearer` credential for the `anthropic` provider
  // row is honoured ONLY under its own fixed account, `ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT`
  // (`anthropic:console`) -- never under `anthropic:default`, the account `winter login
  // --anthropic-key` writes the user's pasted API key to. Checked BEFORE anything else runs (no
  // header is built, no beta is added) and refused with a NAMED, TYPED reason rather than being
  // dispatched: a `bearer` sitting at `anthropic:default` -- however it got there -- must never be
  // sent as `Authorization: Bearer`, and must never be silently treated as the api-key credential
  // either (the two kinds are never interchangeable regardless of account). Scoped to
  // `isConsoleProvider(ctx)` exactly like the beta gate below: a sibling `<id>-anthropic` row's
  // `bearer` material is a different credential space entirely and is untouched by this check.
  if (material?.kind === "bearer" && isConsoleProvider(ctx) && !(ctx.authRef.kind === "keychain" && ctx.authRef.account === ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT)) {
    throw capabilityRefusal(
      `a "bearer" credential for the Anthropic Console provider is only honoured under the "${ANTHROPIC_CONSOLE_CREDENTIAL_ACCOUNT}" account (the console-broker's own record) -- this one is not, so it is refused rather than dispatched: it must never be sent as an Authorization header, and never treated as the "anthropic:default" api-key credential`,
    );
  }
  // D20: an OAuth bearer and the `oauth_auth` beta travel together on this family -- the pinned
  // artifact's own auth builder is a ternary between `{Authorization, anthropic-beta}` and
  // `{x-api-key}`, and all 13 of its sites that set the beta also set a bearer
  // (derived-shapes-p6b.md 2.5). It is a PROTOCOL header (R6-L): the endpoint needs it to be spoken
  // to under this auth kind, and it names no account.
  //
  // KEYED ON `oauth` OR `bearer` MATERIAL **AND ON THE PROVIDER** (P10a, M5), not on the adapter or a
  // flag. The provider gate is load-bearing on its own: this adapter is multi-provider (R6b-5), and a
  // third party speaking this dialect ships as its own `<id>-anthropic` row on this same `adapterId`
  // with its own `bearer`/`oauth` credentials that say nothing about this beta -- so `isConsoleProvider`
  // alone is what keeps the header off `deepseek-anthropic`/`zai-anthropic` regardless of material
  // kind. `bearer` was added to the material check because the host-brokered Console credential
  // (`console-broker.ts`'s `ant auth print-credentials` output) is stored as `kind: "bearer"`, not
  // `oauth` -- the derivation record's "every site that sends this beta also sends a bearer" was
  // measured against `Authorization: Bearer`, not against `CredentialMaterial`'s two bearer-shaped
  // kinds, and the ORIGINAL `oauth`-only gate silently excluded the one credential shape this leg
  // actually produces post-P10a-1. Scoped to `isConsoleProvider(ctx)` exactly as before: a sibling
  // row's `bearer` material still gets no vendor beta.
  //
  // BLOCK BINDING (2026-09-25 fix round 1), a THIRD, independent beta source: `blockBindingBeta`, the
  // caller's OWN precomputed decision (`blockBindingBetaFor`, called from `prepare()`/`countTokens()`
  // against the ACTUAL body those functions built) -- never re-derived from a descriptor here, which
  // is exactly the fix round 2 bug (this function used to read `descriptor?.reasoning?.blockBinding`
  // directly, so the header could claim an opt-in the body never sent: an explicit
  // `thinking:{type:"disabled"}` used to omit the field entirely even on a blockBinding row, while this
  // line still added the beta). Merged into the SAME array the other two sources feed, then deduped by
  // the SAME filter below -- there is only one beta list and one dedupe, never a second header-building
  // path a future beta source could bypass.
  const betas = [
    ...(opts.betas ?? []),
    ...((material?.kind === "oauth" || material?.kind === "bearer") && isConsoleProvider(ctx) ? [CONSOLE_BEARER.betaHeader] : []),
    ...(blockBindingBeta !== undefined ? [blockBindingBeta] : []),
    ...extraBetas,
  ].filter((value, index, all) => all.indexOf(value) === index);
  // HOST HEADERS FIRST, so nothing below can be silently overridden: spread LAST, a host header could
  // replace `anthropic-version` or `content-type`, and a wrong API version is a class of failure that
  // surfaces as an unexplained upstream 400 rather than as anything local.
  //
  // AND FILTERED (R6-L): `applyPrivilegedHeaders` gates the set the ADAPTER builds but cannot remove
  // a name from a map it never saw, so an identity header a host wrote into its own
  // `connection.headers` would otherwise ride a user endpoint past the rule. This family defines no
  // organisation header of its own today, so it adds nothing to the shared list -- the call site
  // exists so that when it does, the enforcement is already here.
  const headers: Record<string, string> = {
    // WS-13b HONEST IDENTITY. FIRST, so a host's own `ConnectionProfile.headers` is spread over it.
    // The override is EXACT-KEY, as it is for every header here: a profile spelling `User-Agent`
    // adds a second key and `Headers` joins the two into one comma-separated value rather than
    // replacing. Header-case normalisation belongs to R6-L's enforcement point, not here.
    "user-agent": winterUserAgent(),
    // The row's OWN second identity field (WS-13b §7/§8.4, R-FW-2), beside the user-agent and BEFORE
    // the host's map -- Winter's name, not the operator's account topology, and therefore not routed
    // through `applyPrivilegedHeaders`. `{}` for every row whose vendor names no such field.
    ...identity,
    ...hostHeaders(policy, ctx.connection.headers),
    "anthropic-version": ANTHROPIC_API_VERSION,
    ...(json ? { "content-type": "application/json" } : {}),
    ...(betas.length > 0 ? { "anthropic-beta": betas.join(",") } : {}),
    // This family has no privileged header of its own; the call site exists so the R6-L rule is
    // enforced by code rather than by a comment, and so a later account-scoped header lands here.
    ...applyPrivilegedHeaders(policy, {}),
  };
  if (material !== null) {
    if (material.kind === "api-key") headers["x-api-key"] = material.key;
    else if (material.kind === "bearer") headers["authorization"] = `Bearer ${material.token}`;
    else if (material.kind === "oauth") headers["authorization"] = `Bearer ${material.accessToken}`;
    else throw capabilityRefusal(`the Anthropic Messages adapter cannot authenticate with credential material of kind "${material.kind}"`);
  }
  return headers;
}

// --- the normalized stream ------------------------------------------------------------------------

interface OpenBlock {
  type: string;
  thinking: string;
  signature: string | undefined;
  data: string | undefined;
  toolId: string | undefined;
}

/** Anthropic's stop reasons -> the seam's five. `stop_sequence` and anything unknown are an ordinary end of turn. */
function toStopReason(raw: unknown): "end_turn" | "tool_use" | "max_tokens" | "refusal" {
  switch (raw) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * At which event this family's COMPLETE in-dialect block is captured, from the descriptor's own
 * `completionEvent` evidence (Minor 7).
 *
 * Matched LENIENTLY by mention, for the same reason as the Google resolver: the field is a prose-ish
 * `CapabilityEvidence<string>`. An unrecognised value falls back to `block-stop`, this family's real
 * per-block terminator -- the conservative answer, since it is the earliest point at which a block is
 * genuinely complete and holding longer can only ever delay a capture, never take a partial one.
 */
export function anthropicCaptureEvent(descriptor: WinterModelDescriptor | undefined): "block-stop" | "message-stop" {
  const declared = descriptor?.reasoning?.completionEvent?.value;
  if (typeof declared === "string" && /message_stop|message-stop/i.test(declared)) return "message-stop";
  return "block-stop";
}

function malformed(detail: string): ProviderError {
  return { code: "bad_request", message: `the provider stream carried a frame this adapter could not decode: ${detail}`, retryable: false };
}

export function createAnthropicMessagesAdapter(opts: AnthropicAdapterOptions = {}): ProviderAdapter {
  // LAZY: `loadCatalog()` validates every row, and an adapter constructed in a fixture that supplies
  // its own catalog must never pay for (or depend on) the compiled one.
  let compiled: WinterCatalog | undefined;
  const catalogOf = (): WinterCatalog => opts.catalog ?? (compiled ??= loadCatalog());
  // DERIVED from the catalog this adapter already resolves, not a separate construction option: this
  // adapter is multi-provider (R6b-5) and takes a catalog anyway, so a wiring that forgot to pass a
  // lookup is unrepresentable here.
  let identityLookup: IdentityHeaderLookup | undefined;
  const identityFor = (ctx: ProviderContext): Record<string, string> => winterIdentityHeaders((identityLookup ??= identityHeaderLookup(catalogOf())), ctx.connection.providerId);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  /**
   * Everything that must be decided BEFORE the network: the descriptor, the endpoint policy, the
   * capability gate, the body and the headers.
   *
   * Separated so a refusal is a THROW here and a yielded `error` event there. The distinction
   * matters to a consumer: a thrown value loses the normalized `code`, and `capability` is exactly
   * the code that says "no request was made and none would have helped".
   */
  async function prepare(req: TurnRequest, ctx: ProviderContext): Promise<{ endpoint: Endpoint; body: Record<string, unknown>; headers: Record<string, string>; captureEvent: "block-stop" | "message-stop" }> {
    // CHECKED HERE, not left to `boundedFetch`: preparing a request can itself reach the network
    // (the Vertex transport exchanges a signed assertion for an access token), and an already-aborted
    // caller must not cause a credential exchange for a turn that will never be sent.
    if (req.signal?.aborted === true) throw new ProviderRequestError({ code: "aborted", message: "provider request aborted by the caller", retryable: false });
    const descriptor = findDescriptor(catalogOf(), ctx.connection.providerId, req.model);
    const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
    const body = buildRequestBody(req, descriptor, opts);
    const headers = await buildHeaders(ctx, blockBindingBetaFor(body, descriptor), endpoint.policy, opts, true, identityFor(ctx), bodyBetas(body, descriptor));
    return { endpoint, body, headers, captureEvent: anthropicCaptureEvent(descriptor) };
  }

  async function* streamTurn(req: TurnRequest, ctx: ProviderContext): AsyncGenerator<ProviderEvent> {
    // BEFORE the network, always: a capability refusal here means `fake.requests` is empty, which is
    // the only observable difference between "rejected before the request" and "rejected after it".
    let endpoint: Endpoint;
    let body: Record<string, unknown>;
    let headers: Record<string, string>;
    let captureEvent: "block-stop" | "message-stop";
    try {
      ({ endpoint, body, headers, captureEvent } = await prepare(req, ctx));
    } catch (err) {
      yield { type: "error", error: normalizeThrown(err) };
      return;
    }

    const policy = createRetryPolicy(opts.retry ?? {});
    const retryEvents: Array<Extract<ProviderEvent, { type: "retry" }>> = [];
    let response: Response;
    try {
      response = await withRetry(
        async () => {
          const res = await boundedFetch(`${endpoint.base}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            timeoutMs,
            maxBodyBytes,
            policy: endpoint.policy,
            ...(req.signal !== undefined ? { signal: req.signal } : {}),
          });
          if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, await res.text()));
          // THE FIRST-BYTE LINE. Past this point `withRetry` refuses to replay, whatever fails.
          policy.commit();
          return res;
        },
        policy,
        (event) => retryEvents.push(event),
        req.signal,
      );
    } catch (err) {
      for (const event of retryEvents) yield event;
      yield { type: "error", error: normalizeThrown(err) };
      return;
    }
    for (const event of retryEvents) yield event;

    if (response.body === null) {
      yield { type: "error", error: malformed("a 200 response with no body at all") };
      return;
    }

    let bytes = 0;
    const blocks = new Map<number, OpenBlock>();
    /** Completed in-dialect blocks, in wire order, when the descriptor defers the capture to `message_stop`. */
    const heldThinking: unknown[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" = "end_turn";
    let sawMessageStop = false;

    try {
      for await (const sse of parseSse(response.body, {
        stallTimeoutMs: ctx.stallTimeoutMs,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        onBytes: (n) => {
          bytes += n;
        },
      })) {
        // `ping` NEVER reaches the consumer -- capture (F) observed the pinned runtime filtering it,
        // and the SSE layer's own stall clock already reset on its bytes.
        if (sse.event === "ping") continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(sse.data) as Record<string, unknown>;
        } catch {
          yield { type: "error", error: malformed(`an unparseable ${sse.event ?? "unnamed"} frame`) };
          return;
        }
        const type = typeof payload["type"] === "string" ? (payload["type"] as string) : sse.event;

        switch (type) {
          case "message_start": {
            const message = payload["message"] as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
            const usage = message?.usage;
            if (typeof usage?.["input_tokens"] === "number") inputTokens = usage["input_tokens"];
            if (typeof usage?.["output_tokens"] === "number") outputTokens = usage["output_tokens"];
            // PROMPT-CACHING COUNTERS. Anthropic reports them as two separate fields on the same
            // usage object, and they are what makes cost accounting honest for a cached prompt.
            if (typeof usage?.["cache_read_input_tokens"] === "number") cacheReadTokens = usage["cache_read_input_tokens"];
            if (typeof usage?.["cache_creation_input_tokens"] === "number") cacheWriteTokens = usage["cache_creation_input_tokens"];
            yield {
              type: "message_start",
              ...(typeof message?.id === "string" ? { id: message.id } : {}),
              ...(typeof message?.model === "string" ? { model: message.model } : {}),
            };
            break;
          }
          case "content_block_start": {
            const index = typeof payload["index"] === "number" ? payload["index"] : -1;
            const block = (payload["content_block"] ?? {}) as Record<string, unknown>;
            const blockType = typeof block["type"] === "string" ? block["type"] : "text";
            const open: OpenBlock = {
              type: blockType,
              thinking: typeof block["thinking"] === "string" ? block["thinking"] : "",
              signature: typeof block["signature"] === "string" ? block["signature"] : undefined,
              data: typeof block["data"] === "string" ? block["data"] : undefined,
              toolId: typeof block["id"] === "string" ? block["id"] : undefined,
            };
            blocks.set(index, open);
            if (blockType === "tool_use" && open.toolId !== undefined) {
              yield { type: "tool_call_start", id: open.toolId, name: typeof block["name"] === "string" ? block["name"] : "" };
            }
            break;
          }
          case "content_block_delta": {
            const index = typeof payload["index"] === "number" ? payload["index"] : -1;
            const open = blocks.get(index);
            const delta = (payload["delta"] ?? {}) as Record<string, unknown>;
            const deltaType = delta["type"];
            if (deltaType === "text_delta" && typeof delta["text"] === "string") {
              yield { type: "text_delta", text: delta["text"] };
            } else if (deltaType === "thinking_delta" && typeof delta["thinking"] === "string" && open !== undefined) {
              // ACCUMULATED, not emitted. Anthropic thinking is IN-DIALECT: it becomes one complete
              // `native_thinking_block` at `content_block_stop`, never a `thinking_summary_delta`
              // (that event is for FOREIGN reasoning, R6-8).
              open.thinking += delta["thinking"];
            } else if (deltaType === "signature_delta" && typeof delta["signature"] === "string" && open !== undefined) {
              open.signature = (open.signature ?? "") + delta["signature"];
            } else if (deltaType === "input_json_delta" && typeof delta["partial_json"] === "string" && open?.toolId !== undefined) {
              yield { type: "tool_call_delta", id: open.toolId, argumentsJsonDelta: delta["partial_json"] };
            }
            break;
          }
          case "content_block_stop": {
            const index = typeof payload["index"] === "number" ? payload["index"] : -1;
            const open = blocks.get(index);
            blocks.delete(index);
            if (open === undefined) break;
            if (open.type === "thinking") {
              // THE COMPLETION EVENT, and only it. The `signature` key is emitted only when the wire
              // carried one: capture (F) shows the pinned runtime materialising `""` for a
              // signatureless block, and the bridge's own coercion reproduces exactly that -- so
              // omitting it here keeps ONE normalizer for the rule instead of two that can drift.
              //
              // WHICH event that is comes from the descriptor (Minor 7): `block-stop` is this
              // family's real per-block terminator and the default, but a row whose evidence names
              // `message_stop` holds the completed block until then.
              const block = { type: "thinking", thinking: open.thinking, ...(open.signature !== undefined ? { signature: open.signature } : {}) };
              if (captureEvent === "message-stop") heldThinking.push(block);
              else yield { type: "native_thinking_block", block };
            } else if (open.type === "redacted_thinking") {
              if (open.data === undefined) {
                // The block IS the opaque continuation state. Dropping it silently breaks the
                // signature chain on the next replay, and the failure would surface as an upstream
                // rejection of a request this adapter had already decided was fine -- so it is the
                // same typed, unrepresentable refusal every other undecodable frame in this file gets.
                yield { type: "error", error: malformed("a redacted_thinking block completed with no `data`, so its opaque continuation state cannot be carried") };
                return;
              }
              const block = { type: "redacted_thinking", data: open.data };
              if (captureEvent === "message-stop") heldThinking.push(block);
              else yield { type: "native_thinking_block", block };
            } else if (open.type === "tool_use" && open.toolId !== undefined) {
              yield { type: "tool_call_end", id: open.toolId };
            }
            break;
          }
          case "message_delta": {
            const delta = (payload["delta"] ?? {}) as Record<string, unknown>;
            stopReason = toStopReason(delta["stop_reason"]);
            const usage = payload["usage"] as Record<string, unknown> | undefined;
            if (typeof usage?.["output_tokens"] === "number") outputTokens = usage["output_tokens"];
            if (typeof usage?.["input_tokens"] === "number") inputTokens = usage["input_tokens"];
            break;
          }
          case "message_stop":
            sawMessageStop = true;
            // Held blocks are released HERE, in wire order, for a row whose evidence names this as its
            // completion event. A stream that never reaches `message_stop` releases none of them --
            // the completion-event rule, stated the same way at whichever event the row names.
            for (const block of heldThinking) yield { type: "native_thinking_block", block };
            heldThinking.length = 0;
            break;
          case "error": {
            const error = (payload["error"] ?? {}) as Record<string, unknown>;
            const providerCode = typeof error["type"] === "string" ? error["type"] : undefined;
            yield {
              type: "error",
              error: {
                // A mid-stream `error` frame is a SERVER-side failure of an already-started
                // generation. It is never retryable here whatever it says: bytes have been consumed
                // and R6-6 forbids replaying an effectful turn.
                code: "server",
                message: `the provider ended the stream with an error frame${providerCode !== undefined ? ` (${providerCode})` : ""}`,
                retryable: false,
                ...(providerCode !== undefined ? { providerCode } : {}),
              },
            };
            return;
          }
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: normalizeThrown(err) };
      return;
    } finally {
      // BYTE COUNTS ONLY -- never content, never a header, never opaque state (Global Constraints).
      ctx.log({ kind: "provider.stream", providerId: ctx.connection.providerId, model: req.model, bytes });
    }

    if (!sawMessageStop) {
      // The stream ended without its terminator: a dropped upstream connection. Reporting the
      // partial accumulation as a completed turn is exactly the "half-decoded turn" the corpus
      // forbids.
      yield { type: "error", error: { code: "network", message: "the provider stream ended before message_stop; the turn is incomplete and is not reported as finished", retryable: false } };
      return;
    }

    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    };
    yield { type: "done", stopReason };
  }

  return {
    id: ANTHROPIC_ADAPTER_ID,
    version: "1",
    family: "anthropic",
    protocol: "anthropic-messages",

    streamTurn,

    /**
     * R6-15: a REAL count from the family's own endpoint, never an estimate. `compact_metadata.post_tokens`
     * is set from this or omitted entirely.
     */
    async countTokens(req: TurnRequest, ctx: ProviderContext): Promise<number> {
      const descriptor = findDescriptor(catalogOf(), ctx.connection.providerId, req.model);
      const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
      const body = buildRequestBody(req, descriptor, opts, "count");
      const headers = await buildHeaders(ctx, blockBindingBetaFor(body, descriptor), endpoint.policy, opts, true, identityFor(ctx), bodyBetas(body, descriptor));
      const res = await boundedFetch(`${endpoint.base}/v1/messages/count_tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs,
        maxBodyBytes,
        policy: endpoint.policy,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
      const text = await res.text();
      if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, text));
      let parsed: { input_tokens?: unknown };
      try {
        parsed = JSON.parse(text) as { input_tokens?: unknown };
      } catch {
        throw new ProviderRequestError(malformed("the count_tokens response was not JSON"));
      }
      if (typeof parsed.input_tokens !== "number") throw new ProviderRequestError(malformed("the count_tokens response carried no numeric input_tokens"));
      return parsed.input_tokens;
    },

    /**
     * A plain read (RETIRED 2026-09-13, P10a-1): `buildHeaders` used to also RENEW a near-expiry
     * Console `oauth` credential and write the fresh material back through the store, so validating
     * one could rotate the record. That self-refresh is gone -- renewal is the host's
     * `console-profile-broker` calling `ant auth print-credentials` ahead of expiry now, never this
     * adapter posting to Anthropic's token endpoint -- so this call has no side effect on the store.
     */
    async validateCredential(ref: CredentialRef, ctx: ProviderContext): Promise<CredentialStatus> {
      if (ref.kind === "none") return { ok: false, code: "missing", message: "no credential is configured for this connection" };
      let material;
      try {
        material = await ctx.credentials.get(ref);
      } catch (err) {
        // The store's own typed refusal ("this store cannot resolve that ref KIND") is `unsupported`,
        // which is a FACT about the wiring rather than a verdict about the credential.
        return { ok: false, code: "unsupported", message: err instanceof Error ? err.message : String(err) };
      }
      if (material === null) return { ok: false, code: "missing", message: "the credential reference resolved to nothing" };
      if (material.kind !== "api-key" && material.kind !== "bearer" && material.kind !== "oauth") {
        return { ok: false, code: "unsupported", message: `the Anthropic Messages adapter cannot validate credential material of kind "${material.kind}"` };
      }
      const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
      const headers = await buildHeaders({ ...ctx, authRef: ref }, undefined, endpoint.policy, opts, false, identityFor(ctx));
      try {
        const res = await boundedFetch(`${endpoint.base}/v1/models?limit=1`, { method: "GET", headers, timeoutMs, maxBodyBytes: 1024 * 1024, policy: endpoint.policy });
        const text = await res.text();
        if (res.ok) return { ok: true };
        const normalized = normalizeHttpError(res.status, res.headers, text);
        if (normalized.code === "auth") return { ok: false, code: "invalid", message: normalized.message };
        return { ok: false, code: "network", message: normalized.message };
      } catch (err) {
        return { ok: false, code: "network", message: normalizeThrown(err).message };
      }
    },

    /**
     * Live discovery over `/v1/models`, paginated by `last_id`/`after_id`.
     *
     * BOUNDED THREE WAYS, as WS-13 §7 requires: bytes by `boundedFetch` (`limits.maxBytes`), items by
     * `limits.maxItems`, and pages by a hard ceiling so a provider that always answers `has_more`
     * cannot make this loop forever. `partial` is set whenever the provider said there was more --
     * absence must never be read as removal.
     */
    async listModels(ctx: DiscoveryContext): Promise<ModelCatalogResult> {
      const endpoint = resolveEndpoint(ctx, ANTHROPIC_DEFAULT_BASE_URL);
      const headers = await buildHeaders(ctx, undefined, endpoint.policy, opts, false, identityFor(ctx));
      const models: ModelCatalogResult["models"] = [];
      const warnings: string[] = [];
      let after: string | undefined;
      let partial = false;

      for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
        const search = new URLSearchParams({ limit: String(Math.min(1000, Math.max(1, ctx.limits.maxItems))) });
        if (after !== undefined) search.set("after_id", after);
        const res = await boundedFetch(`${endpoint.base}/v1/models?${search.toString()}`, {
          method: "GET",
          headers,
          timeoutMs: Math.min(timeoutMs, ctx.limits.timeoutMs),
          maxBodyBytes: ctx.limits.maxBytes,
          policy: endpoint.policy,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        const text = await res.text();
        if (!res.ok) throw new ProviderRequestError(normalizeHttpError(res.status, res.headers, text));
        let parsed: { data?: unknown; has_more?: unknown; last_id?: unknown };
        try {
          parsed = JSON.parse(text) as { data?: unknown; has_more?: unknown; last_id?: unknown };
        } catch {
          throw new ProviderRequestError(malformed("the /v1/models response was not JSON"));
        }
        const rows = Array.isArray(parsed.data) ? parsed.data : [];
        for (const row of rows) {
          if (row === null || typeof row !== "object") continue;
          const item = row as { id?: unknown; display_name?: unknown };
          // Ids and display names are UNTRUSTED input; `discoverModels` re-validates and bounds every
          // field, so this layer only shapes them.
          models.push({
            ...(typeof item.id === "string" ? { id: item.id } : { id: "" }),
            ...(typeof item.display_name === "string" ? { displayName: item.display_name } : {}),
          });
        }
        if (models.length >= ctx.limits.maxItems) {
          partial = partial || parsed.has_more === true || models.length > ctx.limits.maxItems;
          break;
        }
        if (parsed.has_more !== true) break;
        after = typeof parsed.last_id === "string" ? parsed.last_id : undefined;
        if (after === undefined) {
          warnings.push("the provider reported more models but returned no pagination cursor; the catalog is PARTIAL");
          partial = true;
          break;
        }
        if (page === MAX_DISCOVERY_PAGES - 1) {
          warnings.push(`discovery stopped after ${MAX_DISCOVERY_PAGES} pages; the catalog is PARTIAL`);
          partial = true;
        }
      }

      return { models, partial, cached: false, warnings };
    },

    mapEffort(effort: TurnRequest["effort"], model: WinterModelDescriptor) {
      // DELEGATES to the same function `streamTurn` uses (via `buildThinking`), so the two can never
      // disagree (this file's header comment, decision 2). `value`'s SHAPE is widened rather than a
      // sibling key added, because `ProviderAdapter.mapEffort`'s own return type is `{ok:true;
      // value:unknown}` -- a literal here with an extra top-level property the interface does not
      // declare is an excess-property error, while `value` itself is `unknown` and accepts anything.
      // On a row with no `outputConfigEffort` (no `reasoning.effortRequest` evidence) `value` is
      // untouched, so this stays byte-identical to the pre-2026-09-25 seam for every such model.
      const mapped = mapAnthropicEffort(effort, model);
      if (!mapped.ok) return { ok: false, reason: mapped.reason };
      const value = mapped.outputConfigEffort !== undefined ? { ...mapped.value, outputConfigEffort: mapped.outputConfigEffort } : mapped.value;
      return { ok: true, value };
    },

    capabilities(model: WinterModelDescriptor) {
      const domainMembers = model.reasoning?.continuationDomain?.value;
      const domain = domainMembers !== undefined && domainMembers.length > 0 ? [...domainMembers].sort()[0] : undefined;
      return {
        toolCalling: model.toolCalling.value,
        ...(domain !== undefined ? { continuationDomain: domain } : {}),
        // `summary` for this family means "ask for a summarized DISPLAY of in-dialect thinking" --
        // the blocks still ride in-dialect with their real signatures. It never re-routes reasoning
        // onto the foreign-summary channel.
        readableState: model.reasoning?.readableState?.value ?? "none",
      };
    },
  };
}
